/**
 * 跨端同步通道 —— 口袋端 ↔ 桌面端（orbital-hub）。
 *
 * 这条通道是「⚡ 推入电脑端对比矩阵待办队列」之所以能"真的写入"的原因。
 * 需求文档 §5.2 明确指出原型的 WebSocket 是**纯 Toast 文案、无通信层**；
 * 本实现把通信层补齐为三层：
 *
 *   1. **WSS 长连接**（首选）：`/v1/pocket/stream`
 *      - 连接后立即发 `auth`（mx_at + deviceId）
 *      - 每 20s 发 `ping`，服务端回 `pong`；2 个周期无 pong 判定假死，主动重连
 *      - 断线指数退避重连（800ms → 20s 封顶），并保留订阅主题
 *   2. **轮询兜底**（降级）：长连接连续失败后，切换为 30s 轮询 `/v1/pocket/queue`
 *      —— 保证弱网/被运营商劫持 WSS 的机型依然能同步
 *   3. **写路径不依赖长连接**：推入队列走 REST `POST /v1/pocket/queue/push`，
 *      长连接只负责**下行增量通知**。这样即使 WSS 全断，"推入"依然成功，
 *      桌面端下次连上时由 `resync` 拉全量。这是关键的可用性设计——
 *      不能让用户点了"推入"却因为 socket 没连上而失败。
 *
 * 事件模型：`on(event, handler)`，事件名见 `SyncEvent`。
 */

import {
  POLL_FALLBACK_MS,
  WS_BACKOFF_MS,
  WS_HEARTBEAT_MS,
  getEndpoints,
} from './config';
import { ensureFreshToken, ensureDeviceId } from './auth';
import { log } from './logger';
import type { WsClientMessage, WsServerMessage } from '../api/types';

export type SyncStatus = 'idle' | 'connecting' | 'online' | 'polling' | 'offline';

export interface SyncState {
  status: SyncStatus;
  /** 最近一次收到服务端消息的时刻（epoch ms）。 */
  lastMessageAt: number;
  /** 连接失败次数（成功后清零）。 */
  failures: number;
  /** 当前传输方式。 */
  transport: 'websocket' | 'polling' | 'none';
}

export type SyncEvent =
  | { type: 'status'; state: SyncState }
  | { type: 'queue.claimed'; itemId: string; claimedAt: string; station: string }
  | { type: 'queue.done'; itemId: string; doneAt: string }
  | { type: 'queue.count'; pendingCount: number }
  | { type: 'mentor.read'; reminderId: string; readAt: string }
  | { type: 'briefing.ready'; briefingDate: string }
  | { type: 'resync'; reason: string };

type Handler = (event: SyncEvent) => void;

class SyncChannel {
  private task: WechatMiniprogram.SocketTask | null = null;
  private status: SyncStatus = 'idle';
  private failures = 0;
  private lastMessageAt = 0;
  private transport: SyncState['transport'] = 'none';

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 已发出 ping 但未收到 pong 的累计次数。 */
  private missedPongs = 0;

  private handlers: Handler[] = [];
  private topics: string[] = ['queue', 'mentor', 'briefing'];
  /** 主动关闭（页面全部 unload / 应用切后台超过阈值）时置 true，阻止自动重连。 */
  private manualClose = false;
  /** 页面引用计数：多个页面各自 subscribe，全部 unload 后才断开。 */
  private refCount = 0;

  /* ---------------- 事件 ---------------- */

  on(handler: Handler): () => void {
    this.handlers.push(handler);
    // 立即回放当前状态，让新订阅者不必等下一次状态变化
    handler({ type: 'status', state: this.snapshot() });
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  private emit(event: SyncEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (e) {
        log.error('sync', 'handler 抛错', e);
      }
    }
  }

  snapshot(): SyncState {
    return {
      status: this.status,
      lastMessageAt: this.lastMessageAt,
      failures: this.failures,
      transport: this.transport,
    };
  }

  private setStatus(next: SyncStatus, transport: SyncState['transport']): void {
    if (this.status === next && this.transport === transport) return;
    this.status = next;
    this.transport = transport;
    log.info('sync', `状态 → ${next}（transport=${transport}, failures=${this.failures}）`);
    this.emit({ type: 'status', state: this.snapshot() });
  }

  /* ---------------- 生命周期 ---------------- */

  /** 页面 onShow 时调用，返回 unsubscribe 计数释放函数。 */
  acquire(): () => void {
    this.refCount += 1;
    this.manualClose = false;
    if (this.refCount === 1) this.connect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount === 0) this.disconnect('全部页面已离开');
    };
  }

  /** 强制重连（下拉刷新 / 用户点「重连」时用）。 */
  reconnectNow(): void {
    this.manualClose = false;
    this.failures = 0;
    this.teardownTimers();
    this.closeSocket();
    this.connect();
  }

  /* ---------------- WebSocket ---------------- */

  private connect(): void {
    if (this.task) return;
    this.setStatus('connecting', 'websocket');

    const { wsBase } = getEndpoints();
    const url = `${wsBase.replace(/\/+$/, '')}/v1/pocket/stream`;

    let task: WechatMiniprogram.SocketTask;
    try {
      task = wx.connectSocket({
        url,
        timeout: 8000,
        tcpNoDelay: true,
        fail: (err) => {
          log.warn('sync', `connectSocket fail: ${String(err.errMsg || err)}`);
        },
      });
    } catch (e) {
      log.warn('sync', 'connectSocket 抛异常，直接进轮询兜底', e);
      this.enterPolling('socket 创建失败');
      return;
    }
    this.task = task;

    task.onOpen(() => {
      log.info('sync', `WSS 已连接 ${url}`);
      this.failures = 0;
      this.missedPongs = 0;
      this.setStatus('online', 'websocket');
      this.exitPolling();
      this.sendAuth();
      this.send({ type: 'subscribe', topics: this.topics });
      this.startHeartbeat();
    });

    task.onMessage((res) => {
      this.lastMessageAt = Date.now();
      const raw = typeof res.data === 'string' ? res.data : '';
      if (!raw) return;
      let msg: WsServerMessage | null = null;
      try {
        msg = JSON.parse(raw) as WsServerMessage;
      } catch (_e) {
        log.warn('sync', '收到非 JSON 消息，已忽略', raw.slice(0, 120));
        return;
      }
      this.dispatch(msg);
    });

    task.onError((err) => {
      log.warn('sync', `WSS error: ${String(err.errMsg || err)}`);
    });

    task.onClose((res) => {
      log.warn('sync', `WSS 关闭 code=${res.code} reason=${res.reason}`);
      this.task = null;
      this.stopHeartbeat();
      if (this.manualClose) {
        this.setStatus('idle', 'none');
        return;
      }
      this.scheduleReconnect();
    });
  }

  private closeSocket(): void {
    if (!this.task) return;
    const t = this.task;
    this.task = null;
    try {
      t.close({ code: 1000, reason: 'client close' });
    } catch (_e) {
      /* ignore */
    }
  }

  private sendAuth(): void {
    ensureFreshToken(false)
      .then((tokens) => {
        this.send({ type: 'auth', token: tokens.mxAt, deviceId: ensureDeviceId() });
      })
      .catch((e) => {
        log.warn('sync', '取 token 失败，auth 帧延后再发', e);
      });
  }

  private send(msg: WsClientMessage): boolean {
    if (!this.task) return false;
    try {
      this.task.send({
        data: JSON.stringify(msg),
        fail: (err) => log.warn('sync', `send fail: ${String(err.errMsg || err)}`),
      });
      return true;
    } catch (e) {
      log.warn('sync', 'send 抛异常', e);
      return false;
    }
  }

  /* ---------------- 心跳 ---------------- */

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.missedPongs >= 2) {
        log.warn('sync', `连续 ${this.missedPongs} 次心跳无响应，判定假死，主动重连`);
        this.closeSocket(); // 触发 onClose → scheduleReconnect
        if (!this.task) this.scheduleReconnect();
        return;
      }
      this.missedPongs += 1;
      this.send({ type: 'ping', t: Date.now() });
    }, WS_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /* ---------------- 重连 / 轮询兜底 ---------------- */

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.failures += 1;

    // 连续失败 3 次即启动轮询兜底（与 WSS 并行，不互斥）
    if (this.failures >= 3) {
      this.enterPolling(`WSS 连续失败 ${this.failures} 次`);
    }

    const delay = WS_BACKOFF_MS[Math.min(this.failures - 1, WS_BACKOFF_MS.length - 1)] ?? 20000;
    log.info('sync', `${delay}ms 后第 ${this.failures} 次重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      this.connect();
    }, delay);
  }

  private enterPolling(reason: string): void {
    if (this.pollTimer) return;
    log.warn('sync', `进入轮询兜底（原因：${reason}，间隔 ${POLL_FALLBACK_MS}ms）`);
    this.setStatus('polling', 'polling');
    this.pollTimer = setInterval(() => {
      // 轮询只做"有新东西"的信号，具体数据由页面自己拉
      this.emit({ type: 'resync', reason: 'polling' });
    }, POLL_FALLBACK_MS);
  }

  private exitPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    log.info('sync', '长连接恢复，退出轮询兜底');
  }

  private teardownTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.exitPolling();
  }

  private disconnect(reason: string): void {
    log.info('sync', `断开（${reason}）`);
    this.manualClose = true;
    this.teardownTimers();
    this.closeSocket();
    this.setStatus('offline', 'none');
  }

  /* ---------------- 消息分发 ---------------- */

  private dispatch(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'pong':
        this.missedPongs = 0;
        return;
      case 'hello':
        log.info('sync', `服务端问候，心跳 ${msg.heartbeatSec}s`);
        this.missedPongs = 0;
        return;
      case 'queue.claimed':
        this.emit({ type: 'queue.claimed', itemId: msg.itemId, claimedAt: msg.claimedAt, station: msg.station });
        return;
      case 'queue.done':
        this.emit({ type: 'queue.done', itemId: msg.itemId, doneAt: msg.doneAt });
        return;
      case 'queue.count':
        this.emit({ type: 'queue.count', pendingCount: msg.pendingCount });
        return;
      case 'mentor.read':
        this.emit({ type: 'mentor.read', reminderId: msg.reminderId, readAt: msg.readAt });
        return;
      case 'briefing.ready':
        this.emit({ type: 'briefing.ready', briefingDate: msg.briefingDate });
        return;
      case 'resync':
        this.emit({ type: 'resync', reason: msg.reason });
        return;
      default: {
        // 前向兼容：服务端加了新消息类型时，旧客户端忽略而非崩溃
        log.debug('sync', '未知消息类型，已忽略', msg);
      }
    }
  }
}

/** 全局单例：整个小程序只有一条长连接。 */
export const sync = new SyncChannel();

/** 应用级钩子：切后台超过 30s 断开省电，回前台立刻重连。 */
let hiddenAt = 0;
export function bindAppLifecycle(): void {
  wx.onAppHide(() => {
    hiddenAt = Date.now();
  });
  wx.onAppShow(() => {
    if (!hiddenAt) return;
    const away = Date.now() - hiddenAt;
    hiddenAt = 0;
    if (away > 30 * 1000) {
      log.info('sync', `后台 ${Math.round(away / 1000)}s 后回前台，重建长连接`);
      sync.reconnectNow();
    }
  });
}
