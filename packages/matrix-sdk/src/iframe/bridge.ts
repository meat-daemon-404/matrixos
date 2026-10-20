/**
 * MatrixOS SDK · iframe 宿主/租户桥
 *
 * 实现 `useHostBridge()` 与虫洞投送共用的 `postMessage` 协议（S2-07）。
 *
 * ## 角色
 *
 * - **host**（`orbital-hub`）：`window` 里挂着别的站。它把 `mx_idt` 通过桥发给子站。
 * - **tenant**（`11-curvelab` 等）：自己是被内嵌的那个。它从桥里收 `mx_idt`。
 * - 顶层浏览器里两个角色都不成立，此时桥是**惰性空实现**——
 *   `useHostBridge()` 依然返回一个对象，`connected === false`，
 *   `post()` 静默入队不发。这样微站代码不需要写 `if (isInIframe)` 分支。
 *
 * ## 协议设计要点
 *
 * 1. **版本协商**：每条消息带 `v`，握手时交换 `capabilities`。老宿主的消息里没有
 *    新能力，子站据此降级，而不是当成错误（ADR-10 的向后兼容要求）。
 * 2. **origin 校验**：收侧一律过白名单（见 `security/origin.ts`），
 *    **不通过就静默丢弃且不回复**——回复等于告诉攻击者这里有个活的微站。
 * 3. **targetOrigin 永不写 `'*'`**：发侧必须指名道姓。这是 `mx_idt` 不泄露给
 *    任意嵌入者的硬前提。
 * 4. **握手前入队**：子站在 iframe 里 onload 时父窗口可能还没挂好 listener，
 *    直接发会丢消息。所以先入队，握手成功后按序补发。
 */

import { OriginRejectedError } from '../errors.ts';
import type {
  BridgeMessage,
  BridgeMeta,
  HostBridge,
  MessageEventLike,
  MessageListener,
  RuntimeEnv,
  WindowLike,
} from '../types.ts';
import type { OriginAllowList } from '../security/origin.ts';

export const BRIDGE_CHANNEL = 'matrixos/bridge';
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

/**
 * 桥的能力清单。宿主的 `capabilities` 里没有某项时，子站必须能降级。
 *
 * `layout.compact` 与 `layout.resize` 是**两件不同的事**，别混：
 *   - `layout.compact` —— 宿主告诉子站「我在一个小框里，你把非核心区块收起来」
 *     （向下压缩，子站单方面决定怎么压）；
 *   - `layout.resize` —— 子站告诉宿主「我的内容需要多高」，宿主在自己的可用空间内
 *     决定给多高（向上撑开，最终高度由宿主裁决）。
 * 前者省空间，后者消裁切。ADR-08 的本意是两者配合：先在框内压到最紧凑，
 * 仍装不下时再把框撑到内容高。
 */
export const BRIDGE_CAPABILITIES = [
  'sso.idt-issue',
  'sso.cookie-shared',
  'wormhole.drop',
  'wormhole.ack',
  'manifest.registry',
  'layout.compact',
  'layout.resize',
  'theme.accent',
] as const;

export type BridgeCapability = (typeof BRIDGE_CAPABILITIES)[number];

/** 协议内置消息类型。业务可在此基础上扩展自己的 `type`。 */
export const BRIDGE_MSG = {
  HELLO: 'bridge.hello',
  HELLO_ACK: 'bridge.hello.ack',
  PING: 'bridge.ping',
  PONG: 'bridge.pong',
  IDT_ISSUE: 'sso.idt.issue',
  IDT_ACK: 'sso.idt.ack',
  HOST_INFO: 'bridge.host-info',
  RESIZE: 'layout.resize',
} as const;

interface QueueItem {
  readonly type: string;
  readonly payload: unknown;
  /** 请求-响应配对键。入队时也要保留，否则 flush 后 ack 会丢 rid。 */
  readonly rid?: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: unknown;
}

export interface HostBridgeOptions {
  readonly env: RuntimeEnv;
  readonly allowedOrigins: OriginAllowList;
  /**
   * 强制指定角色。省略时自动判定：
   * `env.inIframe ? 'tenant' : 'host'`。
   * hub 里可用它在一棵树内为不同 iframe 显式建 host 桥。
   */
  readonly role?: 'host' | 'tenant';
  /** 宿主 origin。tenant 角色下用于 `targetOrigin`；省略时从 `document.referrer` 推断。 */
  readonly hostOrigin?: string;
  /** 子站 origin。host 角色下用于 `targetOrigin`；省略时必须显式提供或由消息学习。 */
  readonly tenantOrigin?: string;
  /**
   * host 角色下，消息要投给哪个窗口 —— 即某个 `<iframe>` 的 `contentWindow`。
   *
   * **为什么必须显式给**：`window.postMessage` 是「投给某个窗口」，而宿主窗口里
   * 通常挂着多个 iframe。旧实现里 host 角色 `post()` 的目标退化成宿主自身的 `win`
   * （即自己发给自己），于是 `bridge.hello.ack` 永远到不了子站：子站一直
   * `connected === false`、也永远学不到宿主能力 —— 这是 `layout.resize` 这类
   * 「宿主先声明能力、子站再决定发不发」的协议在宿主侧完全不通的根因。
   *
   * 省略时仍退回 `win`（保持对「单 iframe 且同窗内应答」这类既有用法的行为不变），
   * 但真正为 iframe 建桥的宿主应当显式传入。
   */
  readonly tenantWindow?: WindowLike | null;
  /** 自身能力声明。 */
  readonly capabilities?: readonly string[];
  readonly handshakeTimeoutMs?: number;
  readonly debug?: boolean;
}

/**
 * 创建宿主/租户桥。
 *
 * 一个窗口内通常只需要一个（singleton 由 `MatrixSDK` 持有），
 * 但 hub 若要为每个 iframe 单独建桥，可直接调用本函数。
 */
export function createHostBridge(options: HostBridgeOptions): HostBridge {
  const { env, allowedOrigins } = options;
  const debug = options.debug ?? false;
  const role: 'host' | 'tenant' = options.role ?? (env.inIframe ? 'tenant' : 'host');

  const win = env.win;
  const listeners = new Map<string, Set<(payload: unknown, meta: BridgeMeta) => void>>();
  const queue: QueueItem[] = [];
  const pending = new Map<string, PendingRequest>();
  const peerCapabilities = new Set<string>();
  let connected = false;
  let peerOrigin: string | null = options.role === 'host' ? (options.tenantOrigin ?? null) : (options.hostOrigin ?? null);
  let closed = false;
  let seq = 0;

  const selfCapabilities = options.capabilities ?? BRIDGE_CAPABILITIES;

  /** 发侧目标 origin。拿不到就**不发**（绝不退化为 `'*'`）。 */
  function resolveTargetOrigin(): string | null {
    if (peerOrigin !== null && peerOrigin.length > 0) return peerOrigin;
    const explicit = role === 'host' ? options.tenantOrigin : options.hostOrigin;
    if (explicit !== undefined && explicit.length > 0) return explicit;
    // tenant 的兜底：`document.referrer` 指向宿主。仅在无显式配置时使用。
    const referrer = readReferrer(env);
    if (referrer !== null && allowedOrigins.allows(referrer)) return referrer;
    return null;
  }

  function envelope(type: string, payload?: unknown, rid?: string): BridgeMessage {
    const message: BridgeMessage = {
      ch: BRIDGE_CHANNEL,
      v: BRIDGE_PROTOCOL_VERSION,
      type,
      ts: env.now(),
    };
    if (payload !== undefined) (message as { payload?: unknown }).payload = payload;
    if (rid !== undefined) (message as { rid?: string }).rid = rid;
    return message;
  }

  /**
   * 发送一条协议消息。
   *
   * `rid` 是**请求-响应配对键**：对端用 `settlePending(rid)` 把这条消息
   * 与一个挂起的 `request()` Promise 配对（见 `onMessage` 里的 `isReply` 分支）。
   *
   * ⚠️ 2026-10-21 修（Bug C）：此前 `post()` 只有 `(type, payload)` 两个参数，
   * 于是 `issueIdtForTenant` 回复的 `sso.idt.ack` **永远不带 rid** →
   * tenant 的 `await bridge.request('sso.idt.request', …)` 永远配不上 →
   * Promise 不 resolve、5s 后 catch 成超时 → 内嵌态永远显示
   * `IFRAME_HANDSHAKE_TIMEOUT` / offline。
   *
   * 这个 bug 极隐蔽：ack **确实送达了**、`bridge.on('sso.idt.ack')` 也能收到，
   * 但 `request()` 那条 Promise 就是不收敛。只有把"发出去"与"配对成功"
   * 分开看才能发现。
   */
  function post(type: string, payload?: unknown, rid?: string): void {
    if (closed) return;
    const targetOrigin = resolveTargetOrigin();
    if (targetOrigin === null) {
      if (debug) console.debug(`[matrixos/sdk] 桥未就绪，消息 ${type} 入队（共 ${queue.length + 1} 条）`);
      queue.push({ type, payload, rid });
      return;
    }
    const parent = role === 'tenant' ? win?.parent ?? null : null;
    // host 角色优先投给显式指定的 tenantWindow（某个 iframe 的 contentWindow），
    // 否则退化为 win（自己）——见 `HostBridgeOptions.tenantWindow` 的说明。
    const target =
      role === 'tenant' ? (parent ?? win) : (options.tenantWindow ?? win);
    if (target === null || target === undefined) return;
    try {
      target.postMessage(envelope(type, payload, rid), targetOrigin);
    } catch (error) {
      if (debug) console.debug(`[matrixos/sdk] 桥发送失败：${String(error)}`);
    }
  }

  function flushQueue(): void {
    if (queue.length === 0) return;
    const drained = queue.splice(0, queue.length);
    for (const item of drained) post(item.type, item.payload, item.rid);
  }

  function emitLocal(type: string, payload: unknown, meta: BridgeMeta): void {
    const handlers = listeners.get(type);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload, meta);
      } catch (error) {
        // 业务 handler 抛错不能把桥打挂。
        if (debug) console.debug(`[matrixos/sdk] 桥 handler 抛错（${type}）：${String(error)}`);
      }
    }
  }

  function settlePending(rid: string, ok: boolean, value: unknown): void {
    const entry = pending.get(rid);
    if (entry === undefined) return;
    pending.delete(rid);
    win?.clearTimeout(entry.timer);
    if (ok) entry.resolve(value);
    else entry.reject(value instanceof Error ? value : new Error(String(value)));
  }

  const onMessage: MessageListener = (event: MessageEventLike) => {
    if (closed) return;

    // ── 硬约束 1：origin 白名单。不通过就丢弃且不回复 ──────────────────────
    if (!allowedOrigins.allows(event.origin)) {
      if (debug) console.debug(`[matrixos/sdk] 丢弃跨源消息：origin ${event.origin} 不在白名单`);
      return;
    }

    const data = event.data;
    if (!isBridgeMessage(data)) return;

    // ── 硬约束 2：协议主版本不匹配就忽略（不做猜测性兼容）──────────────────
    if (data.v !== BRIDGE_PROTOCOL_VERSION) {
      if (debug) console.debug(`[matrixos/sdk] 丢弃消息：协议版本 ${String(data.v)} ≠ ${BRIDGE_PROTOCOL_VERSION}`);
      return;
    }

    // 学习对端 origin：只在首次握手时锁定，之后不再改（防 origin 漂移攻击）。
    if (peerOrigin === null) peerOrigin = event.origin;

    const source: BridgeMeta['source'] = role === 'tenant' ? 'host' : 'tenant';
    const meta: BridgeMeta = { origin: event.origin, source, message: data };

    if (debug) console.debug(`[matrixos/sdk] 桥收到 ${data.type} from ${event.origin}`);

    switch (data.type) {
      case BRIDGE_MSG.HELLO:
        handleHello(data, meta);
        return;
      case BRIDGE_MSG.HELLO_ACK:
        handleHelloAck(data);
        return;
      case BRIDGE_MSG.PING:
        post(BRIDGE_MSG.PONG, { ts: env.now() });
        emitLocal(data.type, data.payload, meta);
        return;
      default:
        break;
    }

    // 请求-响应配对
    if (data.rid !== undefined) {
      const isReply = data.type.endsWith('.ack') || data.type.endsWith('.reply');
      if (isReply) {
        settlePending(data.rid, true, data.payload);
      }
    }

    emitLocal(data.type, data.payload, meta);
  };

  // payload 形状由 readCapabilities 在运行时校验，此处不做编译期收窄：
  // 调用方拿到的是 BridgeMessage<unknown>，收窄会导致不安全的泛型断言。
  function handleHello(message: BridgeMessage, _meta: BridgeMeta): void {
    const caps = readCapabilities(message.payload);
    for (const cap of caps) peerCapabilities.add(cap);

    if (role === 'host') {
      // 宿主回 ACK，带上自己的能力，完成双向协商。
      post(BRIDGE_MSG.HELLO_ACK, { capabilities: selfCapabilities, role: 'host', protocolVersion: BRIDGE_PROTOCOL_VERSION });
      markConnected();
    } else {
      post(BRIDGE_MSG.HELLO_ACK, { capabilities: selfCapabilities, role: 'tenant', protocolVersion: BRIDGE_PROTOCOL_VERSION });
      markConnected();
    }
    emitLocal(BRIDGE_MSG.HELLO, message.payload, _meta);
  }

  function handleHelloAck(message: BridgeMessage): void {
    const caps = readCapabilities(message.payload);
    for (const cap of caps) peerCapabilities.add(cap);
    markConnected();
  }

  function markConnected(): void {
    if (connected) return;
    connected = true;
    if (debug) console.debug(`[matrixos/sdk] 桥已连接（role=${role}, peer caps=${[...peerCapabilities].join(',') || '无'}）`);
    flushQueue();
    emitLocal('bridge.connected', { role, peerCapabilities: [...peerCapabilities] }, {
      origin: peerOrigin ?? '',
      source: role === 'tenant' ? 'host' : 'tenant',
      message: envelope('bridge.connected'),
    });
  }

  win?.addEventListener('message', onMessage);

  const bridge: HostBridge = {
    role,
    get connected() {
      return connected;
    },
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    get peerCapabilities() {
      return [...peerCapabilities];
    },
    get embedded() {
      return role === 'tenant';
    },

    on(event: string, handler: (payload: unknown, meta: BridgeMeta) => void): () => void {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },

    post,

    async request<T = unknown>(type: string, payload?: unknown, timeoutMs = 5_000): Promise<T> {
      if (closed) throw new Error('桥已关闭');
      const rid = `r${++seq}-${env.randomUUID().slice(0, 8)}`;
      return new Promise<T>((resolve, reject) => {
        const timer = win?.setTimeout(() => {
          pending.delete(rid);
          reject(new Error(`桥请求超时（${type}, ${timeoutMs}ms）`));
        }, timeoutMs);
        pending.set(rid, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        const message = envelope(type, payload, rid);
        const targetOrigin = resolveTargetOrigin();
        if (targetOrigin === null) {
          pending.delete(rid);
          win?.clearTimeout(timer);
          reject(new Error(`桥未就绪，无法发送请求（${type}）：尚未确定对端 origin`));
          return;
        }
        const target =
          role === 'tenant' ? ((win?.parent ?? null) ?? win) : (options.tenantWindow ?? win);
        try {
          target?.postMessage(message, targetOrigin);
        } catch (error) {
          pending.delete(rid);
          win?.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    async handshake(): Promise<void> {
      if (closed) return;
      if (connected) return;
      post(BRIDGE_MSG.HELLO, { capabilities: selfCapabilities, role, protocolVersion: BRIDGE_PROTOCOL_VERSION });
      // tenant 侧：父窗口如果已经在监听，会立刻回 ACK；否则等超时。
      const timeout = options.handshakeTimeoutMs ?? 3_000;
      await new Promise<void>((resolve) => {
        if (connected) {
          resolve();
          return;
        }
        const timer = win?.setTimeout(() => resolve(), timeout);
        const unsubscribe = bridge.on('bridge.connected', () => {
          unsubscribe();
          win?.clearTimeout(timer);
          resolve();
        });
        // 宿主侧握手是「等子站先打招呼」，不等超时，立即返回。
        if (role === 'host') {
          unsubscribe();
          win?.clearTimeout(timer);
          resolve();
        }
      });
    },

    close(): void {
      if (closed) return;
      closed = true;
      win?.removeEventListener('message', onMessage);
      for (const [, entry] of pending) {
        win?.clearTimeout(entry.timer);
        entry.reject(new Error('桥已关闭'));
      }
      pending.clear();
      listeners.clear();
      queue.length = 0;
    },
  };

  return bridge;
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.ch === BRIDGE_CHANNEL && typeof record.type === 'string';
}

function readCapabilities(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const caps = (payload as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(caps)) return [];
  return caps.filter((c): c is string => typeof c === 'string');
}

/** 从 `document.referrer` 读宿主 origin。SSR 环境返回 null。 */
function readReferrer(env: RuntimeEnv): string | null {
  const doc = env.doc as { referrer?: unknown } | null;
  if (doc === null || typeof doc !== 'object') return null;
  const referrer = (doc as { referrer?: unknown }).referrer;
  if (typeof referrer !== 'string' || referrer.length === 0) return null;
  try {
    const origin = new URL(referrer).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** 供宿主侧把 origin 校验错误转成可展示文案。 */
export function describeOriginRejection(error: unknown): string | null {
  if (error instanceof OriginRejectedError) {
    return `来源 ${error.rejectedOrigin} 未被信任，消息已丢弃`;
  }
  return null;
}
