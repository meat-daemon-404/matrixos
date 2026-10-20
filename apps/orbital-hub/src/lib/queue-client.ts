/**
 * 桌面端队列接收器 —— 「手机推入 → 桌面 2s 内出现并认领」的桌面半边（S2-19）。
 *
 * 服务端契约由 `services/matrix-core/app/api/routes/pocket.py` 定义（已实现并有测试）：
 *   GET    /v1/pocket/queue          → QueueSnapshot
 *   POST   /v1/pocket/queue/claim    {itemId} → {item, claimedAt}
 *   POST   /v1/pocket/queue/done     {itemId} → {item, doneAt}
 *   DELETE /v1/pocket/queue?id=
 *   WS     /v1/pocket/stream   hello → auth → resync；下行 queue.count / queue.claimed /
 *          queue.done / mentor.* / briefing.ready / resync；鉴权失败 close 4401。
 *
 * 三个刻意的设计决定：
 *
 * 1. **本模块零 React、零 DOM、零全局单例。** 所有外部能力（fetch / WebSocket /
 *    setTimeout / token）都从 `deps` 注入。这是为了让 `queue-client.test.mjs`
 *    能用假 transport 把退避序列、resync 全量拉取、4401 停重连、claim 失败回滚
 *    全部确定性地跑出来——真机联调不该是这些逻辑唯一的验证手段。
 *
 * 2. **降级不静默（ADR-09）。** 拉取失败但缓存里有上次快照时，状态标 `cache`
 *    并保留 `ageMs`；后端从未连上时标 `mock`。UI 层必须把 origin 渲染出来。
 *    （`degradation-policy.ts` 管的是 iframe 渲染预算，不是数据新鲜度——
 *    两者是不同关注点，这里不复用它，避免把「快照降级」与「数据降级」搅在一起。）
 *
 * 3. **resync 是唯一的同步点。** 服务端在 WS 鉴权成功后**必定**下发一条
 *    `{type:'resync', reason:'authenticated'}`（见 matrix-core 与 mock-server 的
 *    同一实现）。客户端收到就全量拉取，因此「连接建立到第一次推送之间的事件空窗」
 *    不会丢数据——这是比"靠事件增量补状态"更稳的模型。
 */

/**
 * 口袋端队列契约类型 —— **就地声明**，不是新造的包。
 *
 * 为什么不 import：
 *   - `@matrixos/pocket-types` 这个包**不存在**（小程序侧类型在其自己的
 *     `miniprogram/api/types.ts` 里，且小程序是 CommonJS + 独立 tsconfig，
 *     没法直接给 Next 用）；
 *   - hub 的 `hub-types.ts` 装的是**虫洞信封**（snake_case、`payload_type`），
 *     与 pocket 的**队列契约**（camelCase、`targetStation`）是两套形状，
 *     强行合一会让两边都失真。
 *   所以桌面端按 matrix-core 的实际响应形状声明这一小份，并在此注明权威来源。
 *   真正防漂移的护栏是 `queue-client.test.mjs` 里对响应形状的断言 +
 *   matrix-core 的 camelCase 契约测试（test_pocket_api.py::test_responses_are_camel_case）。
 */
export type PayloadType =
  | 'paper_doi_bundle'
  | 'comparison_matrix_row'
  | 'curve_fit_parameters'
  | 'mentor_match_card'
  | 'verified_cv_evidence';

export type VerificationLevel =
  | 'Level_A_Verified'
  | 'Level_B_Preprint'
  | 'Retracted_Warning';

export interface EvidenceAnchor {
  source_doi_or_url: string;
  pdf_page?: number;
  bbox?: [number, number, number, number];
  verification_level: VerificationLevel;
}

export interface QueueItem {
  id: string;
  origin: 'morning_card' | 'checkin_goal' | 'manual';
  originRef: string;
  title: string;
  note: string;
  targetStation: string;
  desktopAction: string;
  payloadType: PayloadType;
  evidenceAnchors: EvidenceAnchor[];
  status: 'pending' | 'claimed' | 'done';
  claimedAt?: string;
  /** 契约外字段：仅 done 响应里可能出现，UI 有则显示。 */
  doneAt?: string;
  createdAt: string;
  receiptId?: string;
}

export interface QueueSnapshot {
  items: QueueItem[];
  pendingCount: number;
  desktopOnline: boolean;
  syncedAt: string;
}

/** 服务端 WS 下行消息（与小程序侧 WsServerMessage 同构）。 */
export type WsServerMessage =
  | { type: 'hello'; serverTime: string; heartbeatSec: number }
  | { type: 'pong'; t: number }
  | { type: 'queue.claimed'; itemId: string; claimedAt: string; station: string }
  | { type: 'queue.done'; itemId: string; doneAt: string }
  | { type: 'queue.count'; pendingCount: number }
  | { type: 'mentor.read'; reminderId: string; readAt: string }
  | { type: 'mentor.stage'; reminderId: string; stage: string; stageLabel: string }
  | { type: 'briefing.ready'; briefingDate: string }
  | { type: 'resync'; reason: string };

export type WsClientMessage =
  | { type: 'auth'; token: string; deviceId: string }
  | { type: 'ping'; t: number }
  | { type: 'subscribe'; topics: string[] };

/** 数据来源：与 `api/types.ts` 的 DataOrigin 同词表（前端角标共用）。 */
export type QueueOrigin = 'live' | 'cache' | 'mock' | 'local';

export type ConnState =
  | 'idle'
  | 'connecting'
  | 'online'
  | /** 已断开且还会重连 */ 'retrying'
  | /** 凭证问题（4401），必须重新登录，不再重连 */ 'unauthorized'
  | 'offline';

export interface QueueView {
  items: QueueItem[];
  pendingCount: number;
  origin: QueueOrigin;
  /** 缓存年龄（ms）；origin==='cache' 时用于「N 分钟前」。 */
  ageMs: number;
  conn: ConnState;
  /** 最近一次成功同步的时刻（epoch ms），0 = 从未成功。 */
  lastSyncAt: number;
  /** 连接层最近一次错误说明（供 UI 显示，不吞掉）。 */
  lastError: string;
}

export interface QueueDeps {
  apiBase: string;
  /** 注入以便单测；浏览器里传 globalThis.fetch。 */
  fetch: typeof fetch;
  /**
   * 注入以便单测。**工厂函数而不是构造器签名**：调用方一律 `WebSocket(url)` 取实例，
   * 传真机就是 `url => new WebSocket(url)`，传假的就是 `url => new FakeSocket(url)`——
   * 构造器签名（`new (...)`）会让箭头实现方无法满足类型，工厂没这个麻烦。
   */
  WebSocket: (url: string) => WsLike;
  /** 注入以便单测：虚拟时钟（setTimeout/clearTimeout）。 */
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  /** 取当前 mx_at；null 表示未登录。 */
  getToken: () => Promise<string | null> | string | null;
  /** 下行事件回调（UI 用它触发动画/提示）。 */
  onEvent?: (event: WsServerMessage) => void;
  onState?: (view: QueueView) => void;
  /** 快照持久化（localStorage 之类）；不传就没有离线缓存。 */
  readCache?: () => QueueSnapshot | null;
  writeCache?: (snapshot: QueueSnapshot) => void;
  /** 重连退避参数（默认 1s 起、×2、30s 封顶，见 BACKOFF_*）。 */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** HTTP 超时，默认 8s。 */
  requestTimeoutMs?: number;
  /** 心跳间隔，默认取服务端 hello 下发的 heartbeatSec。 */
  heartbeatMs?: number;
  /** 随机源注入：单测要能断言确定的 jitter。 */
  random?: () => number;
  /** WS 路径，默认 /v1/pocket/stream。 */
  streamPath?: string;
  deviceId?: string;
}

export interface WsLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/* ------------------------------------------------------------------ */
/* 纯函数（单独导出，供测试与 UI 复用）                                 */
/* ------------------------------------------------------------------ */

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30000;

/**
 * 指数退避 + jitter：第 n 次失败（n 从 1 开始）的等待毫秒数。
 *
 * `1s → 2s → 4s → 8s → 16s → 30s(封顶)`，jitter 取 `[0, 0.3·d]` 的**加性**偏移。
 * 用加性而不是乘性（±30%），是为了让 jitter 只打散同时掉线的客户端，
 * 而不会把某台设备推回"比上一次更快重试"的反常区间。
 */
export function backoffDelayMs(
  attempt: number,
  opts: { base?: number; cap?: number; random?: () => number } = {},
): number {
  const base = opts.base ?? BACKOFF_BASE_MS;
  const cap = opts.cap ?? BACKOFF_CAP_MS;
  const n = Math.max(1, Math.floor(attempt));
  const raw = Math.min(cap, base * 2 ** (n - 1));
  const rand = opts.random ?? Math.random;
  const jitter = raw * 0.3 * clamp01(rand());
  return Math.round(raw + jitter);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * 状态机跃迁表。**只承认 pending→claimed→done 的前向流动**，
 * 与 matrix-core 的 409 校验同构——客户端先挡一道，省一次往返，
 * 但服务端仍是唯一权威（UI 不能假设本地跃迁一定成功）。
 */
export function canTransition(from: QueueItem['status'], to: QueueItem['status']): boolean {
  if (from === to) return true; // 幂等重放（重连后重发 claim）
  if (from === 'pending' && to === 'claimed') return true;
  if (from === 'claimed' && to === 'done') return true;
  return false;
}

/** 把快照规约成视图（纯函数，便于单测直接对拍）。 */
export function toView(snapshot: QueueSnapshot | null, extra: Partial<QueueView> = {}): QueueView {
  const items = snapshot ? snapshot.items : [];
  return {
    items,
    pendingCount: items.filter((i) => i.status === 'pending').length,
    origin: extra.origin ?? 'live',
    ageMs: extra.ageMs ?? 0,
    conn: extra.conn ?? 'idle',
    lastSyncAt: extra.lastSyncAt ?? 0,
    lastError: extra.lastError ?? '',
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

export interface QueueClient {
  /** 建立 WS 并做一次全量拉取。重复调用无副作用。 */
  start(): void;
  stop(): void;
  /** 手动全量刷新（下拉刷新 / 点「重连」）。 */
  refresh(): Promise<void>;
  claim(itemId: string): Promise<void>;
  done(itemId: string): Promise<void>;
  remove(itemId: string): Promise<void>;
  view(): QueueView;
  /**
   * 订阅视图变化，返回取消函数。
   *
   * 监听器集合是实现细节，所以只暴露 `on` 这一个动作——不给调用方一个
   * 能改内部状态的句柄（WeakMap 方案会让外部注册的回调永远收不到 emit，
   * 那是静默失效，比编译错误更难查）。
   */
  on(handler: (view: QueueView) => void): () => void;
}

/**
 * 关键实现约束（踩过才知道的）：
 *
 * - **先 commit 再广播**：服务端 push/claim/done 都是先提交事务再广播。
 *   所以客户端收到 `queue.count` 时**不能**假设服务端已反映自己刚发的写，
 *   它只反映"当前有多少待处理"。认领后的本地状态靠 `queue.claimed` 事件更新，
 *   而不是靠 count 差值猜。
 * - **4401 不重连**：凭证问题无限重连只会把后端打成 DDOS 自己也拿不到数据。
 *   进入 unauthorized，让 UI 出「请重新登录」。
 * - **stale 响应丢弃**：并发 refresh 时，慢的那次返回不能覆盖快的。
 *   用递增 seq 做单调性保护。
 */
export function createQueueClient(deps: QueueDeps): QueueClient {
  const random = deps.random ?? Math.random;
  const base = deps.backoffBaseMs ?? BACKOFF_BASE_MS;
  const cap = deps.backoffCapMs ?? BACKOFF_CAP_MS;
  const timeoutMs = deps.requestTimeoutMs ?? 8000;
  const streamPath = deps.streamPath ?? '/v1/pocket/stream';

  let snapshot: QueueSnapshot | null = null;
  let origin: QueueOrigin = 'live';
  let ageMs = 0;
  let conn: ConnState = 'idle';
  let lastSyncAt = 0;
  let lastError = '';
  let attempt = 0;
  let seq = 0;
  let started = false;
  let ws: WsLike | null = null;
  let reconnectTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let heartbeatMs = deps.heartbeatMs ?? 20000;
  /** 本地已发出、等待服务端确认的跃迁（失败时回滚用）。 */
  const optimistic = new Map<string, QueueItem['status']>();

  const listeners = new Set<(view: QueueView) => void>();

  function emit(): void {
    const v = view();
    for (const l of listeners) l(v);
  }

  function view(): QueueView {
    return toView(snapshot, { origin, ageMs, conn, lastSyncAt, lastError });
  }

  function setState(next: Partial<QueueView> & { conn?: ConnState }): void {
    if (next.origin) origin = next.origin;
    if (typeof next.ageMs === 'number') ageMs = next.ageMs;
    if (next.conn) conn = next.conn;
    if (typeof next.lastSyncAt === 'number') lastSyncAt = next.lastSyncAt;
    if (typeof next.lastError === 'string') lastError = next.lastError;
    deps.onState?.(view());
    emit();
  }

  /* ---------------------------- HTTP ---------------------------- */

  async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await deps.getToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    // AbortController 是浏览器/Node 18+ 的内置能力；缺失时退化为不超时而不是崩。
    const ctrl =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? deps.setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await deps.fetch(deps.apiBase.replace(/\/+$/, '') + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${path} ${text.slice(0, 160)}`);
      }
      return (await res.json()) as T;
    } finally {
      if (ctrl && timer !== undefined) deps.clearTimeout(timer);
    }
  }

  /**
   * 从缓存读快照并算出年龄；无缓存返回 null。
   *
   * 年龄基准用快照自带的 `syncedAt`（服务端写入时刻），而不是本地 lastSyncAt，
   * 也不是给 readCache 另加时间戳：`syncedAt` 是契约里本来就有的字段，
   * 语义正是「这份数据是什么时候的」——重启进程后依然正确，且跨设备一致。
   * 解析失败按「年龄未知」给一个大正数（UI 显示"很久以前"），绝不给 NaN——
   * NaN 会一路漏进 `formatAge` 的模板串变成 "NaN 分钟前"。
   */
  function cachedSnapshot(): { snapshot: QueueSnapshot; ageMs: number } | null {
    const cached = deps.readCache?.() ?? null;
    if (!cached) return null;
    const at = Date.parse(cached.syncedAt || '');
    const ageMs = Number.isFinite(at) ? Math.max(0, deps.now() - at) : Number.MAX_SAFE_INTEGER;
    return { snapshot: cached, ageMs };
  }

  async function pull(): Promise<void> {
    const mySeq = ++seq;
    try {
      const snap = await http<QueueSnapshot>('GET', '/v1/pocket/queue');
      // 慢响应不得覆盖新响应：丢弃过期结果。
      if (mySeq !== seq) return;
      snapshot = snap;
      deps.writeCache?.(snap);
      setState({ origin: 'live', ageMs: 0, lastSyncAt: deps.now(), lastError: '' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cached = cachedSnapshot();
      if (snapshot) {
        // 已有数据：保留内容，只把新鲜度降级为 cache（ADR-09 不可静默）。
        setState({ origin: 'cache', ageMs: cached?.ageMs ?? ageMs, lastError: msg });
      } else if (cached) {
        snapshot = cached.snapshot;
        setState({ origin: 'cache', ageMs: cached.ageMs, lastError: msg });
      } else {
        // 既没拉到也没缓存：标 mock（UI 显示"演示数据/无数据"），不假装在线。
        setState({ origin: 'mock', ageMs: 0, lastError: msg });
      }
    }
  }

  /* ---------------------------- 本地跃迁 ---------------------------- */

  function patchItem(id: string, patch: Partial<QueueItem>): void {
    if (!snapshot) return;
    snapshot = {
      ...snapshot,
      items: snapshot.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    };
    snapshot.pendingCount = snapshot.items.filter((i) => i.status === 'pending').length;
  }

  function localStatusOf(id: string): QueueItem['status'] | undefined {
    return snapshot?.items.find((i) => i.id === id)?.status;
  }

  async function transition(
    id: string,
    to: 'claimed' | 'done',
    path: string,
  ): Promise<void> {
    const from = localStatusOf(id);
    if (!from) return;
    if (!canTransition(from, to)) {
      // 本地就拦住非法跃迁（服务端会 409），并如实报错，不做静默乐观更新。
      setState({ lastError: `非法状态跃迁：${from} → ${to}` });
      return;
    }
    optimistic.set(id, from);
    patchItem(id, to === 'claimed' ? { status: 'claimed', claimedAt: new Date(deps.now()).toISOString() } : { status: 'done' });
    emit();
    try {
      const out = await http<{ item: QueueItem; claimedAt?: string; doneAt?: string }>(
        'POST',
        path,
        { itemId: id },
      );
      patchItem(id, {
        status: out.item.status,
        claimedAt: out.item.claimedAt,
        doneAt: (out.item as QueueItem & { doneAt?: string }).doneAt,
      });
      setState({ origin: 'live' });
    } catch (e) {
      const prev = optimistic.get(id);
      if (prev) patchItem(id, { status: prev }); // 回滚，不假装成功
      optimistic.delete(id);
      setState({ lastError: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      optimistic.delete(id);
    }
  }

  /* ---------------------------- WebSocket ---------------------------- */

  function clearReconnect(): void {
    if (reconnectTimer !== undefined && reconnectTimer !== null) {
      deps.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer !== undefined && heartbeatTimer !== null) {
      deps.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect(reason: string): void {
    if (!started || reconnectTimer !== null) return;
    if (conn === 'unauthorized') return; // 凭证问题不重连
    attempt += 1;
    const delay = backoffDelayMs(attempt, { base, cap, random });
    conn = 'retrying';
    lastError = reason;
    deps.onState?.(view());
    emit();
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  function sendWs(msg: WsClientMessage): void {
    try {
      ws?.send(JSON.stringify(msg));
    } catch {
      /* 发送失败由 onclose 路径统一处理重连 */
    }
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = deps.setTimeout(() => {
      heartbeatTimer = null;
      if (!ws || ws.readyState !== 1) return;
      sendWs({ type: 'ping', t: deps.now() });
      startHeartbeat();
    }, heartbeatMs);
  }

  function handleServerMessage(raw: string): void {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(raw) as WsServerMessage;
    } catch {
      return; // 非 JSON：忽略，不炸连接
    }
    deps.onEvent?.(msg);
    switch (msg.type) {
      case 'hello':
        if (Number.isFinite(msg.heartbeatSec) && msg.heartbeatSec > 0) {
          heartbeatMs = msg.heartbeatSec * 1000;
        }
        startHeartbeat();
        // 鉴权用当前 token；服务端会在成功后回 resync 触发全量拉取。
        void (async () => {
          const token = await deps.getToken();
          sendWs({ type: 'auth', token: token ?? '', deviceId: deps.deviceId ?? 'desktop' });
          sendWs({ type: 'subscribe', topics: ['queue'] });
        })();
        return;
      case 'resync':
        // 唯一的同步点：连接建立/重连/鉴权后都走这里。
        void pull();
        return;
      case 'queue.count':
        // count 只是"有新数据"的信号，**条目本体不在事件里**——必须拉一次，
        // 否则手机推入的新待办要等到下次 resync 才显示，直接违背 S2-19 的
        // 「2s 内出现」。先就地更新计数给即时反馈，再拉全量拿真相。
        if (snapshot) {
          snapshot = { ...snapshot, pendingCount: msg.pendingCount };
          emit();
        }
        void pull();
        return;
      case 'queue.claimed':
        patchItem(msg.itemId, { status: 'claimed', claimedAt: msg.claimedAt });
        emit();
        return;
      case 'queue.done':
        patchItem(msg.itemId, { status: 'done' });
        emit();
        return;
      case 'pong':
        return;
      default:
        return; // 前向兼容：未知类型忽略
    }
  }

  function openSocket(): void {
    if (!started) return;
    clearReconnect();
    conn = 'connecting';
    deps.onState?.(view());
    emit();

    const wsBase = deps.apiBase
      .replace(/^http/, 'ws')
      .replace(/\/+$/, '');
    let socket: WsLike;
    try {
      socket = deps.WebSocket(wsBase + streamPath);
    } catch (e) {
      scheduleReconnect(e instanceof Error ? e.message : 'socket 创建失败');
      return;
    }
    ws = socket;

    socket.onopen = () => {
      attempt = 0;
      conn = 'online';
      setState({ conn: 'online' });
    };
    socket.onmessage = (ev) => handleServerMessage(String(ev.data));
    socket.onerror = () => {
      // 规范上 error 之后必跟 close；这里只记录，重连交给 onclose。
      lastError = 'socket error';
    };
    socket.onclose = (ev) => {
      ws = null;
      clearHeartbeat();
      if (!started) return;
      if (ev.code === 4401) {
        conn = 'unauthorized';
        lastError = '登录态失效，需重新登录';
        deps.onState?.(view());
        emit();
        return;
      }
      scheduleReconnect(`socket closed${ev.code ? ` (${ev.code})` : ''}`);
    };
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  return {
    start() {
      if (started) return;
      started = true;
      const cached = cachedSnapshot();
      if (cached && !snapshot) {
        snapshot = cached.snapshot;
        origin = 'cache';
        ageMs = cached.ageMs;
        emit();
      }
      void pull();
      openSocket();
    },

    stop() {
      started = false;
      clearReconnect();
      clearHeartbeat();
      const socket = ws;
      ws = null;
      try {
        socket?.close(1000, 'client stop');
      } catch {
        /* ignore */
      }
      conn = 'idle';
      emit();
    },

    async refresh() {
      await pull();
    },

    async claim(itemId) {
      await transition(itemId, 'claimed', '/v1/pocket/queue/claim');
    },

    async done(itemId) {
      await transition(itemId, 'done', '/v1/pocket/queue/done');
    },

    async remove(itemId) {
      const prev = snapshot;
      if (!prev) return;
      snapshot = {
        ...prev,
        items: prev.items.filter((i) => i.id !== itemId),
      };
      snapshot.pendingCount = snapshot.items.filter((i) => i.status === 'pending').length;
      emit();
      try {
        await http('DELETE', `/v1/pocket/queue?id=${encodeURIComponent(itemId)}`);
      } catch (e) {
        snapshot = prev; // 回滚
        setState({ lastError: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },

    view,

    on(handler) {
      listeners.add(handler);
      handler(view());
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
