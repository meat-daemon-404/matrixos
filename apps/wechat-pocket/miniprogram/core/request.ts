/**
 * 统一请求层。
 *
 * 职责（页面层不该再做这些）：
 *   1. **拼 URL + 注入 MatrixID 鉴权头**（`Authorization: Bearer <mx_at>`）
 *   2. **401 自动刷新重试一次**（刷新逻辑在 `core/auth.ts`，并发合并）
 *   3. **错误归一**成 `ApiError`
 *   4. **mock 回落**：服务端 `/v1/*` 尚未实现时（404 / 网络不可达），
 *      自动切到 `api/mock/` 的本地实现，并在响应上打 `mock: true`
 *   5. **GET 缓存 + stale-while-revalidate**：冷启动先读缓存渲染，再后台刷新
 *
 * 为什么不用 Promise 封装的库存（如自己撸的 axios 替代）：口袋端追求包体与冷启动，
 * 不引入任何运行时依赖，`wx.request` 的 Promise 化成本极低。
 */

import {
  FALLBACK_TO_MOCK,
  REQUEST_TIMEOUT_MS,
  getEndpoints,
  getEnv,
} from './config';
import { ApiError, kindFromStatus, toApiError } from './errors';
import { ensureFreshToken, getTokens } from './auth';
import { log } from './logger';
import { readJSONWithAge, writeJSON } from './storage';
import { resolveMock } from '../api/mock';

export interface RequestOptions<TBody = unknown> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** query 参数；undefined / null / '' 的键会被剔除。 */
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: TBody;
  /** 命中 mock 时是否仍要有真实网络往返的延迟模拟（默认 true，接近真机手感）。 */
  mockLatency?: boolean;
  /** 缓存 key；设置后 GET 会走本地缓存（TTL 见 `cacheTtlMs`）。 */
  cacheKey?: string;
  cacheTtlMs?: number;
  /** 跳过 mock 回落（用于"必须确认服务端真实状态"的写操作）。 */
  noMock?: boolean;
  /** 自定义超时。 */
  timeout?: number;
  /** 额外请求头。 */
  header?: Record<string, string>;
}

export interface ApiResponse<T> {
  data: T;
  /** 数据来自 mock 层（页面应显式标注「演示数据」）。 */
  mock: boolean;
  /** 命中本地缓存时的缓存年龄（ms）；非缓存命中为 0。 */
  cacheAgeMs: number;
  /** 服务端返回的 trace_id，便于与虫洞收据对账。 */
  traceId?: string;
}

/* ------------------------------------------------------------------ */
/* 底层：单次 wx.request                                              */
/* ------------------------------------------------------------------ */

interface RawResponse {
  status: number;
  body: unknown;
  header: Record<string, string>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const { apiBase } = getEndpoints();
  const base = apiBase.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  if (!query) return base + p;

  const parts: string[] = [];
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `${base}${p}?${parts.join('&')}` : base + p;
}

function rawRequest(
  method: string,
  url: string,
  body: unknown,
  header: Record<string, string>,
  timeout: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new ApiError({
            kind: 'timeout',
            message: `请求超时 ${method} ${url}`,
            retryable: true,
          }),
        ),
      );
    }, timeout + 200);

    wx.request({
      url,
      method: method as 'GET',
      data: method === 'GET' || method === 'DELETE' ? undefined : body,
      header,
      timeout,
      success: (res) => {
        clearTimeout(timer);
        settle(() =>
          resolve({
            status: res.statusCode,
            body: res.data,
            header: (res.header || {}) as Record<string, string>,
          }),
        );
      },
      fail: (err) => {
        clearTimeout(timer);
        settle(() => reject(toApiError(err)));
      },
    });
  });
}

function parseServerError(status: number, body: unknown): ApiError {
  let code = `http_${status}`;
  let message = '';
  let retryable: boolean | undefined;
  let detail: unknown = body;

  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const errRaw = b.error;
    if (errRaw && typeof errRaw === 'object') {
      const e = errRaw as Record<string, unknown>;
      if (typeof e.code === 'string') code = e.code;
      if (typeof e.message === 'string') message = e.message;
      if (typeof e.retryable === 'boolean') retryable = e.retryable;
      detail = e.detail ?? detail;
    } else if (typeof errRaw === 'string') {
      message = errRaw;
    }
    if (!message && typeof b.message === 'string') message = b.message;
  }

  return new ApiError({
    kind: kindFromStatus(status),
    status,
    code,
    message: message || `HTTP ${status}`,
    retryable,
    detail,
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

async function doRequest<T>(
  path: string,
  opts: RequestOptions,
  isRetry: boolean,
): Promise<ApiResponse<T>> {
  const method = opts.method || 'GET';
  const timeout = opts.timeout ?? REQUEST_TIMEOUT_MS;
  const url = buildUrl(path, opts.query);

  let authHeader: Record<string, string> = {};
  try {
    const tokens = await ensureFreshToken(false);
    authHeader = { Authorization: `Bearer ${tokens.mxAt}` };
  } catch (e) {
    // 登录失败不阻断：mock 环境下依然要能渲染出占位数据
    log.warn('request', `取 token 失败，本次请求不带鉴权头：${String((e as Error).message || e)}`);
  }

  const header: Record<string, string> = {
    'content-type': 'application/json',
    'x-pocket-client': 'wechat-pocket',
    'x-pocket-env': getEnv(),
    ...authHeader,
    ...(opts.header || {}),
  };

  const traceId = makeTraceId();
  header['x-trace-id'] = traceId;

  const res = await rawRequest(method, url, opts.body, header, timeout);

  if (res.status >= 200 && res.status < 300) {
    return {
      data: res.body as T,
      mock: false,
      cacheAgeMs: 0,
      traceId: res.header['x-trace-id'] || traceId,
    };
  }

  // 401：刷新一次后重试（只重试一次，避免死循环）
  if (res.status === 401 && !isRetry) {
    log.warn('request', `${method} ${path} 401，尝试强制刷新 token 后重试`);
    try {
      await ensureFreshToken(true);
      return await doRequest<T>(path, opts, true);
    } catch (e) {
      throw new ApiError({
        kind: 'unauthorized',
        status: 401,
        message: '登录已失效，需要重新进入小程序',
        detail: e,
      });
    }
  }

  throw parseServerError(res.status, res.body);
}

/** 生成 trace id（UUID v4 形状，不依赖 crypto）。 */
export function makeTraceId(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += hex[Math.floor(Math.random() * 16)];
  }
  // version 4 / variant 10
  const v4 = `${out.slice(0, 12)}4${out.slice(13, 16)}8${out.slice(17)}`;
  return [
    v4.slice(0, 8),
    v4.slice(8, 12),
    v4.slice(12, 16),
    v4.slice(16, 20),
    v4.slice(20, 32),
  ].join('-');
}

/* ------------------------------------------------------------------ */
/* 缓存 + mock 回落的组合入口                                          */
/* ------------------------------------------------------------------ */

/**
 * 带缓存读取（stale-while-revalidate 的「读」这一半）。
 * 页面先用它渲染首屏，再发真请求换新数据。
 */
export function readCache<T>(cacheKey: string): { value: T; ageMs: number } | undefined {
  return readJSONWithAge<T>(cacheKey);
}

function cacheIsFresh(ageMs: number, ttlMs: number): boolean {
  return ttlMs > 0 && ageMs < ttlMs;
}

/**
 * 正式请求入口。
 *
 * 失败顺序：真实请求 → (404/网络/5xx 且允许) → mock 层 → 本地缓存 → 抛错
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const method = opts.method || 'GET';
  const cacheKey = opts.cacheKey;

  // 1) 先打真实请求
  try {
    const res = await doRequest<T>(path, opts, false);
    if (cacheKey && method === 'GET') {
      writeJSON(cacheKey, res.data, opts.cacheTtlMs ?? 0);
    }
    return res;
  } catch (e) {
    const err = toApiError(e);
    const allowMock = FALLBACK_TO_MOCK && !opts.noMock;

    // 2) 服务端未实现 → mock 回落
    if (allowMock && (err.kind === 'not_found' || err.kind === 'network' || err.kind === 'server')) {
      const mockRes = await resolveMock<T>(path, {
        method,
        query: opts.query,
        body: opts.body,
        latency: opts.mockLatency !== false,
        reason: err.kind,
      });
      if (mockRes) {
        if (cacheKey && method === 'GET') {
          writeJSON(cacheKey, mockRes, opts.cacheTtlMs ?? 0);
        }
        log.info('request', `${method} ${path} → mock 回落（原因 ${err.kind}）`);
        return { data: mockRes, mock: true, cacheAgeMs: 0, traceId: makeTraceId() };
      }
    }

    // 3) 回落到本地缓存（ADR-09 的 L2「只读离线」）
    if (cacheKey && method === 'GET') {
      const cached = readCache<T>(cacheKey);
      if (cached && !cacheIsFresh(cached.ageMs, 0)) {
        log.warn('request', `${method} ${path} 失败，使用 ${Math.round(cached.ageMs / 1000)}s 前的缓存`);
        return {
          data: cached.value,
          mock: false,
          cacheAgeMs: cached.ageMs,
          traceId: makeTraceId(),
        };
      }
    }

    throw err;
  }
}

/** 便捷方法。 */
export const http = {
  get: <T>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'GET' }),
  post: <T, B = unknown>(path: string, body?: B, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  put: <T, B = unknown>(path: string, body?: B, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'PUT', body }),
  del: <T>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
};

/** 当前是否已登录（有 token）。供页面判断是否走 mock 演示流程。 */
export function isAuthenticated(): boolean {
  return getTokens() !== null;
}
