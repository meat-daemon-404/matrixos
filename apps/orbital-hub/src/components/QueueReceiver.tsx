'use client';

/**
 * 桌面待办接收器 —— S2-19「手机右滑 → 桌面 2s 内出现待办」的桌面半边。
 *
 * 与 queue-client 的分工：客户端只管状态机与重连，这里只管渲染与交互。
 *
 * 三个实现决定（都踩过坑）：
 *
 * 1. **只自动认领「上线之后新出现」的条目，首次快照不自动认领。**
 *    否则每次刷新 hub 都会把历史 pending 全部标记成 claimed，
 *    「谁认领了什么」瞬间失真。首帧用 firstSnapshotRef 记账，之后的增量才 auto-claim。
 *
 * 2. **不直接改 OrbitalHub 的挂载态。** 唤醒微站通过可选的 `onWakeStation` 回调外抛；
 *    没接的时候退化为「新窗口打开该微站」。这样本组件与正在被另一路改动的
 *    OrbitalHub.tsx 解耦，不会互相覆盖。
 *
 * 3. **origin 必须渲染出来。** live / cache / mock 三档直接决定用户能不能相信
 *    屏幕上这份队列（ADR-09）。断连时显示重连按钮，不假装在线。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createQueueClient,
  type QueueClient,
  type QueueItem,
  type QueueOrigin,
  type QueueSnapshot,
  type QueueView,
  type WsLike,
} from '../lib/queue-client';

import './queue-receiver.css';

export interface QueueReceiverProps {
  /** 覆盖 API 基址；默认按 NEXT_PUBLIC_MATRIX_API_BASE 或 https://api.matrixos.edu。 */
  apiBase?: string;
  /** 取 access token。默认读 mx_at Cookie，其次 localStorage.mx_at。 */
  getToken?: () => string | null;
  /**
   * 点击条目的「打开」时唤醒目标微站。未提供时退化为 window.open(stationUrl)。
   * 传入即可与仪器架的挂载逻辑对接（由 hub 上层决定"挂载"语义）。
   */
  onWakeStation?: (station: string, item: QueueItem) => void;
  className?: string;
}

const ORIGIN_LABEL: Record<QueueOrigin, string> = {
  live: '实时',
  cache: '缓存',
  mock: '演示/无后端',
  local: '仅本机',
};

/** 断线兜底用的本地快照键（仅体验优化，不是第二事实源）。 */
const CACHE_KEY = 'matrixos.queue.snapshot';

/**
 * localStorage 是**不可信输入**：手改、旧版本残留、配额写坏都可能让它不是快照形状。
 * 这里做最小结构校验（items 是数组 + pendingCount 是数），不合格就当没有缓存，
 * 而不是把脏数据渲染出去或让后续 `.filter` 崩在运行时。
 */
function isSnapshot(value: unknown): value is QueueSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.items) && typeof v.pendingCount === 'number';
}

function defaultApiBase(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_MATRIX_API_BASE ?? '').trim();
  return fromEnv || 'https://api.matrixos.edu';
}

/** 默认 token 来源：matrix-core 在 15-iframe 场景会种 mx_at Cookie。 */
function defaultGetToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)mx_at=([^;]+)/.exec(document.cookie);
  if (m?.[1]) return decodeURIComponent(m[1]);
  try {
    return window.localStorage.getItem('mx_at');
  } catch {
    return null;
  }
}

function stationLabel(targetStation: string): string {
  return targetStation.split('.')[0] || targetStation;
}

function stationUrl(targetStation: string, apiBase: string): string {
  // matrix-cross.matrixos.edu → https://matrix-cross.matrixos.edu
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(targetStation)) return `https://${targetStation}`;
  const key = stationLabel(targetStation);
  const base = apiBase.replace(/\/+$/, '');
  return `${base}/station/${encodeURIComponent(key)}`;
}

function fmtAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '未知时间';
  if (ageMs > 86_400_000 * 30) return '很久以前';
  const min = Math.round(ageMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.round(hr / 24)} 天前`;
}

export function QueueReceiver({
  apiBase,
  getToken,
  onWakeStation,
  className = '',
}: QueueReceiverProps) {
  const base = useMemo(() => apiBase || defaultApiBase(), [apiBase]);
  const takeToken = useMemo(() => getToken ?? defaultGetToken, [getToken]);

  const [view, setView] = useState<QueueView | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  /** 客户端句柄：effect 内赋值、回调里读取，故声明在使用之前。 */
  const queueRef = useRef<QueueClient | null>(null);
  /** 已经自动认领过的条目，防重复发 claim。 */
  const claimedRef = useRef<Set<string>>(new Set());
  /** 首次快照里的 pending 不参与自动认领（见文件头决定 1）。 */
  const baselineRef = useRef<Set<string> | null>(null);
  const [autoClaimBusy, setAutoClaimBusy] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
    const client: QueueClient = createQueueClient({
      apiBase: base,
      fetch: (...args) => window.fetch(...args),
      WebSocket: (url: string): WsLike => new WebSocket(url) as unknown as WsLike,
      setTimeout: (cb, ms) => window.setTimeout(cb, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
      now: () => Date.now(),
      getToken: () => takeToken(),
      deviceId: 'orbital-hub',
      readCache: (): QueueSnapshot | null => {
        try {
          const raw = window.localStorage.getItem(CACHE_KEY);
          if (!raw) return null;
          const parsed = JSON.parse(raw) as unknown;
          // 缓存是不可信输入：形状不对就当作没有，绝不让它污染视图。
          return isSnapshot(parsed) ? parsed : null;
        } catch {
          return null;
        }
      },
      writeCache: (snap: QueueSnapshot) => {
        try {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify(snap));
        } catch {
          /* 配额/隐私模式：缓存只是体验优化，失败不影响主链路 */
        }
      },
    });
    // 只走 client.on 这一条订阅路径：同时传 onState 又 on() 会让每次更新渲染两遍。
    const off = client.on(setView);
    client.start();
    queueRef.current = client;
    return () => {
      off();
      client.stop();
      queueRef.current = null;
    };
  }, [base, takeToken]);

  /* ---------- 自动认领：只处理基线之后新出现的 pending ---------- */
  useEffect(() => {
    const items = view?.items ?? [];
    if (!baselineRef.current) {
      baselineRef.current = new Set(items.map((i) => i.id));
      return;
    }
    const client = queueRef.current;
    if (!client) return;
    const fresh = items.filter(
      (i) => i.status === 'pending' && !baselineRef.current?.has(i.id) && !claimedRef.current.has(i.id),
    );
    if (fresh.length === 0) return;
    setAutoClaimBusy(true);
    void (async () => {
      for (const item of fresh) {
        claimedRef.current.add(item.id);
        try {
          await client.claim(item.id);
          // 唤醒对应微站：这是「手机推 → 桌面亮」闭环的最后一跳。
          onWakeStation?.(item.targetStation, item);
        } catch (e) {
          claimedRef.current.delete(item.id); // 允许下次事件重试
          setError(e instanceof Error ? e.message : '认领失败');
        }
      }
      setAutoClaimBusy(false);
    })();
  }, [view, onWakeStation]);

  const act = useCallback(async (fn: (c: QueueClient) => Promise<void>, label: string) => {
    const client = queueRef.current;
    if (!client) return;
    setError('');
    try {
      await fn(client);
    } catch (e) {
      setError(`${label}失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const conn = view?.conn ?? 'connecting';
  const origin = view?.origin ?? 'live';
  const items = view?.items ?? [];
  const groups = useMemo(
    () => ({
      pending: items.filter((i) => i.status === 'pending'),
      claimed: items.filter((i) => i.status === 'claimed'),
      done: items.filter((i) => i.status === 'done'),
    }),
    [items],
  );
  const badge = view?.pendingCount ?? 0;

  return (
    <aside
      className={`qr-root ${open ? 'is-open' : ''} ${className}`}
      aria-label="桌面待办队列"
    >
      <button
        type="button"
        className="qr-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="qr-toggle-label">待办</span>
        <span className={`qr-dot dot-${conn}`} aria-hidden />
        {badge > 0 && <span className="qr-badge">{badge > 99 ? '99+' : badge}</span>}
      </button>

      {open && (
        <div className="qr-panel" role="region" aria-label="待办队列面板">
          <header className="qr-head">
            <div>
              <h2 className="qr-title">手机推来的待办</h2>
              <p className="qr-meta">
                <span className={`qr-origin o-${origin}`}>{ORIGIN_LABEL[origin]}</span>
                {origin === 'cache' && <span className="qr-age"> · {fmtAge(view?.ageMs ?? 0)}</span>}
                <span className="qr-conn"> · {connLabel(conn)}</span>
              </p>
            </div>
            <button type="button" className="qr-icon-btn" onClick={() => setOpen(false)} aria-label="收起">
              ✕
            </button>
          </header>

          {origin !== 'live' && (
            <p className="qr-banner" role="status">
              {origin === 'cache'
                ? '后端暂不可达，下方是上次同步的内容'
                : '未连接后端，队列为空——推入操作会照常写入，连上后自动同步'}
            </p>
          )}

          {conn === 'unauthorized' && (
            <p className="qr-banner qr-banner-warn" role="alert">
              登录态已失效，请重新登录后再查看队列
            </p>
          )}
          {(conn === 'offline' || conn === 'retrying') && (
            <button
              type="button"
              className="qr-reconnect"
              onClick={() => void queueRef.current?.refresh()}
            >
              连接中断，点击重连
            </button>
          )}
          {error && <p className="qr-error" role="alert">{error}</p>}
          {autoClaimBusy && <p className="qr-busy">正在认领…</p>}

          <div className="qr-body">
            {items.length === 0 && <p className="qr-empty">暂无待办</p>}

            {(['pending', 'claimed', 'done'] as const).map((key) =>
              groups[key].length === 0 ? null : (
                <section key={key} className="qr-group">
                  <h3 className="qr-group-title">
                    {key === 'pending' ? '待处理' : key === 'claimed' ? '已认领' : '已完成'}
                    <span className="qr-group-count">{groups[key].length}</span>
                  </h3>
                  <ul className="qr-list">
                    {groups[key].map((item) => (
                      <li key={item.id} className={`qr-item st-${item.status}`}>
                        <div className="qr-item-main">
                          <span className="qr-item-title">{item.title}</span>
                          {item.note && <span className="qr-item-note">{item.note}</span>}
                          <span className="qr-item-tags">
                            <span className="qr-tag qr-tag-station">{stationLabel(item.targetStation)}</span>
                            <span className="qr-tag">{item.payloadType}</span>
                            {item.evidenceAnchors.length > 0 && (
                              <span
                                className={`qr-tag qr-tag-evi evi-${worstLevel(item.evidenceAnchors)}`}
                                title={item.evidenceAnchors.map((a) => a.source_doi_or_url).join('\n')}
                              >
                                证据 {item.evidenceAnchors.length}
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="qr-item-actions">
                          <button
                            type="button"
                            className="qr-btn"
                            onClick={() =>
                              onWakeStation
                                ? onWakeStation(item.targetStation, item)
                                : window.open(stationUrl(item.targetStation, base), '_blank', 'noopener')
                            }
                          >
                            打开
                          </button>
                          {item.status === 'claimed' && (
                            <button
                              type="button"
                              className="qr-btn qr-btn-primary"
                              onClick={() => void act((c) => c.done(item.id), '完成')}
                            >
                              完成
                            </button>
                          )}
                          <button
                            type="button"
                            className="qr-btn qr-btn-danger"
                            onClick={() => void act((c) => c.remove(item.id), '移除')}
                          >
                            移除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function connLabel(conn: QueueView['conn']): string {
  switch (conn) {
    case 'online':
      return '已连接';
    case 'connecting':
      return '连接中';
    case 'retrying':
      return '重连中';
    case 'unauthorized':
      return '需重新登录';
    case 'offline':
      return '已离线';
    default:
      return '未启动';
  }
}

/** 证据徽章颜色取最弱一环——与名片页同一口径，不让一条撤稿警示被 Level_A 掩盖。 */
function worstLevel(anchors: { verification_level: string }[]): string {
  const rank: Record<string, number> = {
    Level_A_Verified: 3,
    Level_B_Preprint: 2,
    Retracted_Warning: 1,
  };
  return anchors.reduce(
    (worst, a) => ((rank[a.verification_level] ?? 0) < (rank[worst] ?? 99) ? a.verification_level : worst),
    'Level_A_Verified',
  );
}

export default QueueReceiver;
