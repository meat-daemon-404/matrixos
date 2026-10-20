/**
 * MatrixOS SDK · `mx_idt` 一次性交换
 *
 * ## 这是整个 SDK 最需要小心的一段代码
 *
 * `mx_idt` 是 iframe 场景下唯一的鉴权入口（ADR-03）：hub 通过 `postMessage`
 * 把 120s 有效的一次性凭证交给子站，子站拿它换 `mx_at`。
 *
 * 一次性（one-time-use）的**语义边界**必须分清：
 *
 * | 层次 | 谁负责 | 作用 |
 * | :--- | :--- | :--- |
 * | 本地原子占位 | **SDK（本文件）** | 防住 UI 层的重复触发（双击、StrictMode 双调用、并发 initSSO） |
 * | 服务端裁决 | `matrix-core`（S1-09） | 真正的安全边界，第二个人来换必须 401 |
 *
 * 本地这道防线**不能替代**服务端，但它挡掉的是最常见的脏流量：
 * React 18 StrictMode 在开发模式下会把 effect 跑两遍，如果不做本地占位，
 * 每次 iframe 挂载都会向服务端发两个交换请求，第二个必然失败并触发
 * 「token family 重放检测」——把用户踢下线。这类 bug 极难排查，
 * 因为生产模式不出现（StrictMode 只在 dev 双跑）。
 *
 * ## 并发保护的三道锁
 *
 * 1. **in-flight 去重**：同一个 `mx_idt` 的并发调用共享同一个 Promise，
 *    而不是各发一个请求。
 * 2. **已消费黑名单**：换成功后把 `mx_idt` 记入已消费集合（带 TTL），
 *    二次调用直接抛 `IDT_ALREADY_CONSUMED`，**不发请求**。
 * 3. **失败不放行**：网络错误不计入黑名单（可以重试）；但拿到 401/409 就计入
 *    （服务端说它用过了，再试无意义）。
 */

import { IdtExchangeError, MatrixError } from '../errors.ts';
import type { MatrixHttpClient } from '../http/client.ts';
import type { SSOTokenSet } from '../types.ts';

export interface IdtExchangeOptions {
  readonly http: MatrixHttpClient;
  /** 服务端 `/v1/auth/exchange` 的路径，默认 `/v1/auth/exchange`。 */
  readonly exchangePath?: string;
  /** 本地已消费记录的保留时长，需 ≥ `mx_idt` 的 120s 服务端 TTL。默认 300s。 */
  readonly consumedTtlMs?: number;
  readonly now?: () => number;
  readonly debug?: boolean;
}

/** 服务端 `/v1/auth/exchange` 的响应体形状（与 S1-09 对齐）。 */
interface ExchangeResponse {
  readonly mx_at?: unknown;
  readonly expires_in?: unknown;
  readonly expires_at?: unknown;
  readonly matrix_uid?: unknown;
  readonly scope?: unknown;
  readonly station_id?: unknown;
}

/**
 * `mx_idt` 交换器。
 *
 * 一个 SDK 实例一个实例（挂在 `MatrixSDK` 上），不跨实例共享状态——
 * 因为不同微站的 iframe 是不同 JS 上下文，本来就不共享内存。
 */
export class IdtExchanger {
  readonly #http: MatrixHttpClient;
  readonly #exchangePath: string;
  readonly #consumedTtlMs: number;
  readonly #now: () => number;
  readonly #debug: boolean;

  /** 正在交换中的 `mx_idt` → Promise。并发调用共享同一个 Promise。 */
  readonly #inFlight = new Map<string, Promise<SSOTokenSet>>();
  /** 已成功消费的 `mx_idt` → 消费时刻。 */
  readonly #consumed = new Map<string, number>();

  constructor(options: IdtExchangeOptions) {
    this.#http = options.http;
    this.#exchangePath = options.exchangePath ?? '/v1/auth/exchange';
    this.#consumedTtlMs = options.consumedTtlMs ?? 300_000;
    this.#now = options.now ?? (() => Date.now());
    this.#debug = options.debug ?? false;
  }

  /** 某个 `mx_idt` 是否已被本实例消费过（排查用）。 */
  isConsumed(idt: string): boolean {
    this.#pruneConsumed();
    return this.#consumed.has(idt);
  }

  /** 是否有交换正在进行（供 UI 展示 loading，避免用户狂点）。 */
  get pendingCount(): number {
    return this.#inFlight.size;
  }

  /**
   * 用 `mx_idt` 换 `mx_at`。
   *
   * 同一 `mx_idt`：
   *   - 首次调用 → 发请求；
   *   - 并发调用 → 共享第一个 Promise（**不重复发请求**）；
   *   - 已成功后调用 → 抛 `IDT_ALREADY_CONSUMED`，不发请求。
   */
  async exchange(idt: string): Promise<SSOTokenSet> {
    if (typeof idt !== 'string' || idt.trim().length === 0) {
      throw new IdtExchangeError('AUTH_EXPIRED', 'mx_idt 为空，无法交换访问令牌');
    }

    const key = idt.trim();

    // ── 锁 2：已消费 → 直接拒绝，不发请求 ──────────────────────────────────
    this.#pruneConsumed();
    if (this.#consumed.has(key)) {
      throw new IdtExchangeError(
        'IDT_ALREADY_CONSUMED',
        '该 mx_idt 已被本页消费过。同一 mx_idt 只能交换一次——这通常意味着页面重复调用了 initSSO()。',
      );
    }

    // ── 锁 1：in-flight 去重 ──────────────────────────────────────────────
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      if (this.#debug) console.debug('[matrixos/sdk] mx_idt 交换已在途，复用同一 Promise（防并发重复交换）');
      return existing;
    }

    const promise = this.#performExchange(key).finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, promise);
    return promise;
  }

  /** 清空本地状态。仅用于测试与 `dispose()`。 */
  reset(): void {
    this.#consumed.clear();
    this.#inFlight.clear();
  }

  async #performExchange(idt: string): Promise<SSOTokenSet> {
    try {
      const raw = await this.#http.request<ExchangeResponse>({
        method: 'POST',
        path: this.#exchangePath,
        body: { mx_idt: idt },
        // 一次性操作，绝不重试——重试等于主动触发重放检测。
        noRetry: true,
        // `/v1/auth/exchange` 无副作用且此时还没有会话，不需要 CSRF。
        skipCsrf: true,
      });

      const tokenSet = parseExchangeResponse(raw, this.#now());
      // ── 锁 2（写侧）：成功后立刻拉黑，后续调用不发请求 ──────────────────
      this.#consumed.set(idt, this.#now());
      return tokenSet;
    } catch (raw) {
      const error = raw instanceof MatrixError ? raw : null;
      const status = error?.status;

      // 服务端说「用过了 / 过期了」→ 计入黑名单，避免无意义重试。
      if (status === 409 || status === 401) {
        this.#consumed.set(idt, this.#now());
        const code = status === 409 ? 'IDT_ALREADY_CONSUMED' : 'IDT_EXPIRED';
        throw new IdtExchangeError(
          code,
          status === 409
            ? 'mx_idt 已被使用（服务端拒绝重放）。请回到 MatrixOS 主控台重新进入本微站。'
            : 'mx_idt 已过期或无效（有效期 120s）。请回到 MatrixOS 主控台重新进入本微站。',
          raw,
        );
      }

      // 网络类失败不计入黑名单——可以安全重试。
      throw raw;
    }
  }

  #pruneConsumed(): void {
    if (this.#consumed.size === 0) return;
    const cutoff = this.#now() - this.#consumedTtlMs;
    for (const [key, consumedAt] of this.#consumed) {
      if (consumedAt < cutoff) this.#consumed.delete(key);
    }
  }
}

/** 把服务端响应归一化成 `SSOTokenSet`。字段缺失一律当错误，不做「猜一个默认值」。 */
export function parseExchangeResponse(raw: unknown, now: number): SSOTokenSet {
  if (raw === null || typeof raw !== 'object') {
    throw new IdtExchangeError('AUTH_EXPIRED', '/v1/auth/exchange 返回体不是对象');
  }
  const record = raw as Record<string, unknown>;

  const mxAt = record.mx_at;
  if (typeof mxAt !== 'string' || mxAt.length === 0) {
    throw new IdtExchangeError('AUTH_EXPIRED', '/v1/auth/exchange 响应缺少 mx_at');
  }

  const matrixUid = record.matrix_uid;
  if (typeof matrixUid !== 'string' || matrixUid.length === 0) {
    throw new IdtExchangeError('AUTH_EXPIRED', '/v1/auth/exchange 响应缺少 matrix_uid');
  }

  // expires_at 优先（绝对时间），否则用 expires_in 相对值（默认 15min，与 ADR-03 一致）。
  let expiresAt: number;
  if (typeof record.expires_at === 'number' && Number.isFinite(record.expires_at)) {
    expiresAt = record.expires_at;
  } else if (typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)) {
    expiresAt = now + record.expires_in * 1000;
  } else {
    expiresAt = now + 15 * 60 * 1000;
  }

  const scope = Array.isArray(record.scope)
    ? record.scope.filter((s): s is string => typeof s === 'string')
    : [];

  const stationId = typeof record.station_id === 'string' ? record.station_id : '';

  return { mx_at: mxAt, expires_at: expiresAt, matrix_uid: matrixUid, scope, station_id: stationId };
}
