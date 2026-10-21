/**
 * MatrixOS SDK · HTTP 客户端
 *
 * 这是 18 个微站访问 `matrix-core` 的**唯一通道**（架构 §3.2 读图要点 2：
 * 审计面收敛在 SDK 内部）。微站不得自行 `fetch` API。
 *
 * 内置四件事，微站一个都不用自己实现：
 *   1. **CSRF 双提交令牌注入**（架构 §4.4.1）——所有写操作自动带 `X-Matrix-CSRF`；
 *   2. **重试**——指数退避 + 抖动，且**只重试值得重试的**（幂等方法、或带幂等键的 POST）；
 *   3. **超时**——`AbortController`，与调用方的 signal 合并；
 *   4. **熔断器**（ADR-09 强制项）——连续失败后短路，避免 18 个站一起把挂掉的核心服务打得更死。
 *
 * ## 两处容易被做错的细节
 *
 * - **CSRF 只对写方法注入**。GET 带 CSRF 头会破坏 CDN 缓存键，且没有意义。
 * - **401 的处理顺序**：先尝试刷新（一次），刷新成功则重放原请求；
 *   刷新失败则抛 `AuthExpiredError`，让业务去走登录流程。**不能**把 401 当普通错误重试——
 *   那会在令牌过期时打出一串无意义的请求。
 */

import {
  MatrixError,
  AuthExpiredError,
  CircuitOpenError,
  codeFromStatus,
  isRetryableStatus,
  redactSecrets,
} from '../errors.ts';
import type {
  CircuitBreakerConfig,
  FetchLike,
  HttpClientOptions,
  MatrixErrorBody,
  MatrixRequestOptions,
  RetryPolicy,
} from '../types.ts';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 默认 API 主机。
 *
 * 为什么要有这个常量 + 构建期覆盖：
 * 之前是裸字面量 `'https://api.matrixos.edu'` 写在构造函数里，导致
 * **后端地址被硬编码进产物**——一旦后端不在这个域名（当前它 NXDOMAIN，
 * 后端实际部署在别处/tunnel），前端就完全无法指向它，只能改 SDK 源码重发版。
 *
 * 现在允许构建期用 `MATRIXOS_API_BASE_URL` 注入。取值顺序：
 *   1. 显式传参 `init.baseUrl`（最高优先，测试与定制场景）
 *   2. 构建期环境变量 `NEXT_PUBLIC_MATRIXOS_API_BASE_URL`（Next 会在构建期静态替换）
 *   3. 默认 `https://api.matrixos.edu`（生产正式域名，保持不变）
 *
 * ⚠️ Next 的 DefinePlugin 只对**完整成员表达式**做静态替换，
 * 所以这里必须写 `process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL` 字面量，
 * 不能写 `process.env[name]` 这类动态取值（会拿到 undefined）。
 */
function resolveDefaultApiBase(): string {
  try {
    const injected = process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL;
    if (typeof injected === 'string' && injected.length > 0) return injected;
  } catch {
    /* 非 Next 打包环境（单测直接 import）里可能没有 process，忽略 */
  }
  return 'https://api.matrixos.edu';
}

const DEFAULT_API_BASE_URL = resolveDefaultApiBase();

/**
 * 供 SDK 其它模块（如 `auth/sso.ts` 的 `buildAuthorizeUrl`）复用的默认 API 主机。
 * 导出的目的是让「后端地址」**只有一处事实源**，避免各处硬编码字面量漂移。
 */
export { DEFAULT_API_BASE_URL };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NON_IDEMPOTENT_METHODS = new Set(['POST']);

const DEFAULT_RETRY: RetryPolicy = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  jitter: true,
  retryOn: [408, 425, 429, 500, 502, 503, 504],
  retryNonIdempotent: false,
};

const DEFAULT_BREAKER: CircuitBreakerConfig = {
  failureThreshold: 3,
  openMs: 30_000,
  halfOpenProbes: 1,
};

/** 熔断器状态机。三态 + 半开探针，参数可在 `HttpClientOptions` 里覆盖。 */
export class CircuitBreaker {
  #state: 'closed' | 'open' | 'half-open' = 'closed';
  #failures = 0;
  #openedAt = 0;
  #halfOpenInFlight = 0;
  readonly #config: CircuitBreakerConfig;
  readonly #now: () => number;

  constructor(config: Partial<CircuitBreakerConfig> = {}, now: () => number = () => Date.now()) {
    this.#config = { ...DEFAULT_BREAKER, ...config };
    this.#now = now;
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.#state === 'open' && this.#now() - this.#openedAt >= this.#config.openMs) {
      this.#state = 'half-open';
      this.#halfOpenInFlight = 0;
    }
    return this.#state;
  }

  get retryAfterMs(): number {
    if (this.#state !== 'open') return 0;
    return Math.max(0, this.#config.openMs - (this.#now() - this.#openedAt));
  }

  /** 请求放行判定。熔断期直接抛 `CircuitOpenError`，让上层走 L2 只读离线态。 */
  acquire(): void {
    const state = this.state;
    if (state === 'open') {
      throw new CircuitOpenError(this.retryAfterMs);
    }
    if (state === 'half-open') {
      if (this.#halfOpenInFlight >= this.#config.halfOpenProbes) {
        throw new CircuitOpenError(1_000);
      }
      this.#halfOpenInFlight += 1;
    }
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#state = 'closed';
    this.#halfOpenInFlight = 0;
  }

  /** 只有「服务端不可用」才计数。4xx 是业务错误，不该把熔断器打开。 */
  recordFailure(): void {
    if (this.#state === 'half-open') {
      this.#open();
      return;
    }
    this.#failures += 1;
    if (this.#failures >= this.#config.failureThreshold) this.#open();
  }

  #open(): void {
    this.#state = 'open';
    this.#openedAt = this.#now();
    this.#halfOpenInFlight = 0;
  }

  reset(): void {
    this.#state = 'closed';
    this.#failures = 0;
    this.#openedAt = 0;
    this.#halfOpenInFlight = 0;
  }
}

export interface MatrixHttpClientInit extends HttpClientOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 请求级元数据，用于日志与调试（不含 body/token）。 */
export interface RequestTrace {
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly attempt: number;
  readonly durationMs: number;
  readonly traceId?: string;
  readonly errorCode?: string;
}

export class MatrixHttpClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retry: RetryPolicy;
  readonly #breaker: CircuitBreaker;
  readonly #getAccessToken: (() => string | null) | undefined;
  readonly #getCsrfToken: (() => string | null) | undefined;
  readonly #onUnauthorized: (() => Promise<boolean>) | undefined;
  readonly #fetch: FetchLike | null;
  readonly #debug: boolean;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #listeners = new Set<(trace: RequestTrace) => void>();

  constructor(init: MatrixHttpClientInit = {}) {
    this.#baseUrl = trimTrailingSlash(init.baseUrl ?? DEFAULT_API_BASE_URL);
    this.#timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retry = { ...DEFAULT_RETRY, ...init.retry };
    this.#breaker = new CircuitBreaker(
      { ...DEFAULT_BREAKER, ...init.circuitBreaker },
      init.now ?? (() => Date.now()),
    );
    this.#getAccessToken = init.getAccessToken;
    this.#getCsrfToken = init.getCsrfToken;
    this.#onUnauthorized = init.onUnauthorized;
    this.#fetch = init.fetchImpl ?? null;
    this.#debug = init.debug ?? false;
    this.#now = init.now ?? (() => Date.now());
    this.#sleep = init.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  get breaker(): CircuitBreaker {
    return this.#breaker;
  }

  /** 订阅请求级 trace，供微站上报或开发期打点。**不含 body 与令牌**（S1-21）。 */
  onRequest(listener: (trace: RequestTrace) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request<T = unknown>(options: MatrixRequestOptions): Promise<T> {
    const method = options.method ?? 'GET';
    const url = this.#buildUrl(options.path, options.query);
    const maxAttempts = options.noRetry === true ? 1 : this.#maxAttempts(method, options.idempotencyKey);
    let refreshed = false;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.#breaker.acquire();
      const startedAt = this.#now();
      let status: number | null = null;

      try {
        const response = await this.#send(method, url, options);
        status = response.status;

        if (response.ok) {
          this.#breaker.recordSuccess();
          this.#emit({ method, path: options.path, status, attempt, durationMs: this.#now() - startedAt, traceId: options.traceId });
          return (await this.#parseBody(response)) as T;
        }

        // ── 401：先尝试刷新一次，再重放。刷新失败即判死。 ─────────────────────
        if (response.status === 401 && !refreshed && this.#onUnauthorized !== undefined) {
          refreshed = true;
          this.#emit({ method, path: options.path, status, attempt, durationMs: this.#now() - startedAt, traceId: options.traceId, errorCode: 'AUTH_EXPIRED' });
          const recovered = await this.#onUnauthorized();
          if (recovered) {
            attempt -= 1; // 重放不计入重试配额
            continue;
          }
          throw new AuthExpiredError({
            message: '访问令牌已过期且刷新失败，请重新登录 MatrixOS',
            status: 401,
            hint: '若当前在 iframe 内，请点击「在新标签页打开」后重新登录（第三方 Cookie 阻断场景）',
          });
        }

        const body = await this.#tryParseErrorBody(response);
        const error = new MatrixError({
          code: response.status === 401 ? 'AUTH_REQUIRED' : codeFromStatus(response.status),
          message: body?.message ?? `请求失败：HTTP ${response.status} ${response.statusText}`,
          status: response.status,
          traceId: body?.trace_id ?? options.traceId,
          body: body ?? undefined,
          retryable: isRetryableStatus(response.status),
        });

        // 5xx / 429 才计入熔断；4xx 是业务错误，不该把核心服务判死。
        if (isRetryableStatus(response.status)) {
          this.#breaker.recordFailure();
          lastError = error;
          this.#emit({ method, path: options.path, status, attempt, durationMs: this.#now() - startedAt, traceId: options.traceId, errorCode: error.code });
          if (attempt < maxAttempts) {
            await this.#sleep(this.#backoffMs(attempt, response.headers.get('retry-after')));
            continue;
          }
          throw error;
        }

        this.#emit({ method, path: options.path, status, attempt, durationMs: this.#now() - startedAt, traceId: options.traceId, errorCode: error.code });
        throw error;
      } catch (raw) {
        const normalized = this.#normalizeThrown(raw, method, url, options);
        const isServerSide = normalized.code === 'NETWORK' || normalized.code === 'TIMEOUT' || normalized.code === 'SERVER';
        if (isServerSide) this.#breaker.recordFailure();

        this.#emit({
          method,
          path: options.path,
          status,
          attempt,
          durationMs: this.#now() - startedAt,
          traceId: options.traceId,
          errorCode: normalized.code,
        });

        if (normalized.retryable && attempt < maxAttempts && isServerSide) {
          lastError = normalized;
          await this.#sleep(this.#backoffMs(attempt, null));
          continue;
        }
        throw normalized;
      }
    }

    if (lastError instanceof MatrixError) throw lastError;
    throw new MatrixError({ code: 'HTTP', message: '请求在重试后仍然失败', retryable: false, cause: lastError });
  }

  async #send(method: string, url: string, options: MatrixRequestOptions): Promise<Response> {
    const fetchImpl = this.#fetch ?? (typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as FetchLike) : null);
    if (fetchImpl === null) {
      throw new MatrixError({
        code: 'ENVIRONMENT',
        message: '当前环境没有 fetch 实现，无法访问 matrix-core。Node 18+ 或浏览器环境应自带 fetch。',
        retryable: false,
      });
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };

    // ── CSRF 双提交令牌：只对写方法注入（GET 带头会破坏缓存键）────────────────
    if (WRITE_METHODS.has(method) && options.skipCsrf !== true) {
      const csrf = this.#getCsrfToken?.() ?? null;
      if (csrf !== null && csrf.length > 0) {
        headers['X-Matrix-CSRF'] = csrf;
      }
    }

    const token = this.#getAccessToken?.() ?? null;
    if (token !== null && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    if (options.traceId !== undefined) {
      headers['X-Trace-ID'] = options.traceId;
    }

    let body: string | undefined;
    if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    // ── 超时与外部 signal 合并：任一方 abort 都要能中断请求 ────────────────────
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        // 域级 Cookie 是 SSO 的非 iframe 通道，必须带凭据。
        credentials: 'include',
      };
      if (body !== undefined) init.body = body;
      return await fetchImpl(url, init);
    } finally {
      clearTimeout(timer);
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  #normalizeThrown(raw: unknown, method: string, url: string, options: MatrixRequestOptions): MatrixError {
    if (raw instanceof MatrixError) return raw;

    if (raw instanceof Error) {
      const isAbort = raw.name === 'AbortError';
      const isTimeout = isAbort && options.signal?.aborted !== true;
      if (isAbort) {
        return new MatrixError({
          code: isTimeout ? 'TIMEOUT' : 'ABORTED',
          message: isTimeout
            ? `请求超时（${options.timeoutMs ?? this.#timeoutMs}ms）：${method} ${redactSecrets(url)}`
            : `请求被取消：${method} ${redactSecrets(url)}`,
          retryable: isTimeout,
          cause: raw,
        });
      }
      return new MatrixError({
        code: 'NETWORK',
        message: `网络请求失败：${method} ${redactSecrets(url)} — ${redactSecrets(raw.message)}`,
        retryable: true,
        cause: raw,
      });
    }

    return new MatrixError({
      code: 'NETWORK',
      message: `未知网络错误：${method} ${redactSecrets(url)}`,
      retryable: true,
      cause: raw,
    });
  }

  #maxAttempts(method: string, idempotencyKey: string | undefined): number {
    const retries = Math.max(0, this.#retry.retries);
    if (NON_IDEMPOTENT_METHODS.has(method)) {
      // POST 只有带幂等键才安全重试——否则可能重复写入资产。
      const safe = this.#retry.retryNonIdempotent === true || idempotencyKey !== undefined;
      return safe ? retries + 1 : 1;
    }
    return retries + 1;
  }

  #backoffMs(attempt: number, retryAfterHeader: string | null): number {
    // 服务端给了 Retry-After 就听它的（429 经常给）。
    if (retryAfterHeader !== null) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, this.#retry.maxDelayMs);
      }
    }
    const exponential = this.#retry.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, this.#retry.maxDelayMs);
    if (!this.#retry.jitter) return capped;
    // full jitter：避免 18 个站在同一时刻重试形成重试风暴。
    return Math.random() * capped;
  }

  #buildUrl(path: string, query: MatrixRequestOptions['query']): string {
    const base = path.startsWith('http://') || path.startsWith('https://') ? path : `${this.#baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    if (query === undefined) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs.length === 0) return base;
    return `${base}${base.includes('?') ? '&' : '?'}${qs}`;
  }

  async #parseBody(response: Response): Promise<unknown> {
    if (response.status === 204 || response.status === 205) return undefined;
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MatrixError({
        code: 'HTTP',
        message: `响应不是合法 JSON（HTTP ${response.status}）`,
        status: response.status,
        retryable: false,
      });
    }
  }

  async #tryParseErrorBody(response: Response): Promise<MatrixErrorBody | null> {
    try {
      const text = await response.text();
      if (text.length === 0) return null;
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object') return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.code !== 'string' || typeof record.message !== 'string') return null;
      return {
        code: record.code,
        message: redactSecrets(record.message),
        trace_id: typeof record.trace_id === 'string' ? record.trace_id : undefined,
        details: record.details,
      };
    } catch {
      return null;
    }
  }

  #emit(trace: RequestTrace): void {
    if (this.#debug) {
      // 只打方法与路径，绝不打 body 与 Authorization。
      console.debug(`[matrixos/sdk] ${trace.method} ${trace.path} → ${trace.status ?? '—'} (${trace.durationMs}ms)${trace.errorCode !== undefined ? ` ${trace.errorCode}` : ''}`);
    }
    for (const listener of this.#listeners) {
      try {
        listener(trace);
      } catch {
        // 埋点监听器自己抛错不应该影响业务请求。
      }
    }
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
