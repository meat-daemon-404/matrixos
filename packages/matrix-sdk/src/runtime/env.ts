/**
 * MatrixOS SDK · 运行环境探测与窗口访问
 *
 * ## 为什么需要这个模块
 *
 * SDK 要在三种宿主里正确工作，而三者的窗口能力差异巨大：
 *
 * | 宿主 | `window.parent === window` | 域级 Cookie | `mx_idt` 交换 |
 * | :--- | :--- | :--- | :--- |
 * | 顶层浏览器 / 同源 iframe | 独立 | 可用 | 可用 |
 * | 跨源 iframe（hub 内嵌） | 被内嵌 | **被第三方 Cookie 策略阻断** | **唯一可用路径** |
 * | Node / SSR | 无 DOM | 不适用 | 不适用 |
 *
 * 把判定写在一个地方，18 个微站就不必各自实现 `window.self !== window.top`。
 *
 * ## 一个刻意的实现细节
 *
 * 判定「是否在 iframe 里」用的是 **`win.parent !== win`**（引用比较），
 * 而不是 `window.self !== window.top` 加 try/catch。跨源时访问 `top` 的某些属性
 * 会抛 SecurityError，但 `window.parent` / `window.top` 的**引用本身**永远可读。
 * 引用比较没有 try/catch 开销，也不会因为某些浏览器的 CSP 包装而误判。
 */

import type { ClockSource, DocumentLike, FetchLike, RuntimeContext, RuntimeEnv, StorageLike, WindowLike } from '../types.ts';

/** SSR / 测试环境的空存储。写入静默丢弃，读取永远 null——与浏览器隐私模式的观感一致。 */
const NOOP_STORAGE: StorageLike = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

function isWindowLike(value: unknown): value is WindowLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as WindowLike).postMessage === 'function' &&
    (value as WindowLike).location !== undefined
  );
}

/** 判断某个对象是否是全局 `window`。用于区分「宿主的 window」与「测试伪造的 window」。 */
function getGlobalWindow(): WindowLike | null {
  const candidate = (globalThis as { window?: unknown }).window;
  return isWindowLike(candidate) ? candidate : null;
}

function getGlobalDocument(): DocumentLike | null {
  const candidate = (globalThis as { document?: unknown }).document;
  if (candidate === null || typeof candidate !== 'object') return null;
  const doc = candidate as { cookie?: unknown };
  return typeof doc.cookie === 'string' ? { cookie: doc.cookie } : null;
}

/**
 * 探测运行上下文。
 *
 * 返回值直接决定走哪条鉴权通道——这是「双通道」的分叉点，也是排障时第一个要看的东西，
 * 所以 `MatrixSDK.runtime` 把它暴露出来。
 */
export function detectRuntimeContext(win?: WindowLike | null): RuntimeContext {
  const target = win === undefined ? getGlobalWindow() : win;
  if (target === null) return 'headless';
  // 引用比较：跨源 iframe 里 `parent !== self` 依然成立且不抛错。
  if (target.parent !== null && target.parent !== target) return 'embedded';
  return 'standalone';
}

/** 构造运行时环境。`overrides` 供测试注入假窗口 / 假时钟。 */
export function createRuntimeEnv(overrides: {
  readonly win?: WindowLike | null;
  readonly doc?: DocumentLike | null;
  readonly fetchImpl?: FetchLike | null;
  readonly clock?: ClockSource;
  readonly randomUUID?: () => string;
} = {}): RuntimeEnv {
  const win = overrides.win === undefined ? getGlobalWindow() : overrides.win;
  const doc = overrides.doc === undefined ? getGlobalDocument() : overrides.doc;
  const clock = overrides.clock;

  const now = clock !== null && clock !== undefined ? () => clock.now() : () => Date.now();
  const randomUUID =
    overrides.randomUUID ??
    (clock !== null && clock !== undefined
      ? () => clock.randomUUID()
      : () => defaultRandomUUID());

  const fetchImpl =
    overrides.fetchImpl === undefined
      ? typeof globalThis.fetch === 'function'
        ? (globalThis.fetch.bind(globalThis) as FetchLike)
        : null
      : overrides.fetchImpl;

  return {
    hasDOM: win !== null,
    win,
    doc,
    inIframe: win !== null && win.parent !== null && win.parent !== win,
    origin: win?.location.origin ?? '',
    href: win?.location.href ?? '',
    fetchImpl,
    now,
    randomUUID,
  };
}

/**
 * `crypto.randomUUID()` 的兜底实现。
 *
 * 为什么需要兜底：`crypto.randomUUID` 只在**安全上下文**（HTTPS / localhost）暴露。
 * 校内很多实验室站会在 `http://10.x.x.x:3000` 上开发或部署，那里拿不到它，
 * 而 `trace_id` 是虫洞投送的必填字段——不能因为跑在 HTTP 上就无法投送。
 */
function defaultRandomUUID(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoObj?.randomUUID !== undefined) {
    return cryptoObj.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (cryptoObj?.getRandomValues !== undefined) {
    cryptoObj.getRandomValues(bytes);
  } else {
    // 最后的兜底：Math.random 不具密码学强度，但 trace_id 只需唯一性，不需不可预测性。
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }

  // RFC 4122 v4
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
  }
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** 会话级存储：优先 `sessionStorage`，隐私模式抛错时退化为内存 Map。 */
export function resolveSessionStorage(win: WindowLike | null): StorageLike {
  if (win === null) return NOOP_STORAGE;
  try {
    const storage = win.sessionStorage;
    if (storage === null) return new MemoryStorage();
    // Safari 无痕模式下 sessionStorage 存在但 setItem 抛 QuotaExceededError，先探一次。
    const probeKey = '__matrixos_probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return new MemoryStorage();
  }
}

/** 内存存储：存活于当前模块实例，不做任何持久化。 */
export class MemoryStorage implements StorageLike {
  readonly #map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }
}

/**
 * 从 `document.cookie` 字符串里读一个非 HttpOnly cookie。
 *
 * `mx_at` 与 `mx_rt` 都是 HttpOnly，JS **读不到**——这是设计如此（架构 ADR-03）。
 * 这里只用于读 CSRF 双提交令牌（`mx_csrf`），它必须能被 JS 读到才能注入请求头。
 */
export function readCookie(doc: DocumentLike | null, name: string): string | null {
  if (doc === null) return null;
  const parts = doc.cookie.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
