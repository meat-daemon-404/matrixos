/**
 * MatrixID 令牌管理（小程序侧）。
 *
 * 与 Web 端的差异（见 ADR-03）：小程序没有 Cookie，也不在 iframe 里，
 * 因此走**独立的窄通道**：
 *   1. `wx.login()` 拿一次性 `code`
 *   2. `POST /v1/auth/wechat/exchange { code, device_id }` → `{ mx_at, mx_rt, expires_in, matrix_uid, scope[] }`
 *   3. `mx_at` 是 RS256 JWT，15 min；`mx_rt` 30 d 滑动、一次性 + 重放检测
 *   4. 刷新：`POST /v1/auth/refresh { mx_rt }`（服务端轮转，返回新的 `mx_rt`）
 *
 * 关键约束：
 *   - `mx_rt` 一次性 —— 并发刷新必须**合并**（单个 in-flight promise），
 *     否则两个请求同时刷新会让其中一个拿着已作废的 rt 触发重放检测，直接踢下线。
 *   - token 存 storage 而不是仅内存 —— 小程序冷启动频繁，每次冷启动都走一次
 *     `wx.login` + exchange 会把冷启动预算吃光。
 *   - 不在日志里打印 token 明文。
 */

import { REQUEST_TIMEOUT_MS, TOKEN_REFRESH_SKEW_MS, getEndpoints, getEnv } from './config';
import { STORAGE_KEYS, readJSON, remove, writeJSON } from './storage';
import { ApiError, kindFromStatus, toApiError } from './errors';
import { log, mark } from './logger';

export interface TokenBundle {
  mxAt: string;
  mxRt: string;
  /** mx_at 的到期时刻（epoch ms，本地时钟）。 */
  expiresAt: number;
  matrixUid: string;
  scope: string[];
}

export interface MatrixProfile {
  matrixUid: string;
  displayName: string;
  /** 例：「光电大三 · GPA 3.86」 */
  subtitle: string;
  school: string;
  major: string;
  grade: string;
  gpa: number;
  avatarUrl?: string;
  /** 名片页需要，随 profile 一起返回可省一次请求。 */
  verificationLevel?: 'Level_A_Verified' | 'Level_B_Preprint' | 'Retracted_Warning';
}

interface ExchangeResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  matrix_uid?: string;
  scope?: string[];
  /** 服务端也可能用下划线以外的命名，做兼容。 */
  mx_at?: string;
  mx_rt?: string;
}

/** 当前在途的刷新 promise —— 并发合并，避免 mx_rt 一次性语义被并发击穿。 */
let refreshing: Promise<TokenBundle> | null = null;
let cachedTokens: TokenBundle | null | undefined;

function nowMs(): number {
  return Date.now();
}

function normalizeExchange(raw: ExchangeResponse): TokenBundle {
  const mxAt = raw.access_token || raw.mx_at || '';
  const mxRt = raw.refresh_token || raw.mx_rt || '';
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 900;
  if (!mxAt || !raw.matrix_uid) {
    throw new ApiError({
      kind: 'bad_response',
      message: 'auth exchange 响应缺少 access_token / matrix_uid',
    });
  }
  return {
    mxAt,
    mxRt,
    expiresAt: nowMs() + Math.max(30, expiresIn) * 1000,
    matrixUid: raw.matrix_uid,
    scope: Array.isArray(raw.scope) ? raw.scope : [],
  };
}

export function getTokens(): TokenBundle | null {
  if (cachedTokens !== undefined) return cachedTokens;
  const stored = readJSON<TokenBundle>(STORAGE_KEYS.tokens);
  if (!stored || !stored.mxAt || !stored.mxRt) {
    cachedTokens = null;
    return null;
  }
  cachedTokens = stored;
  return cachedTokens;
}

export function saveTokens(tokens: TokenBundle): void {
  cachedTokens = tokens;
  // 存到 mx_rt 的自然到期时间，让过期后能自然失效而不是永远返回坏 token
  writeJSON(STORAGE_KEYS.tokens, tokens, 30 * 24 * 60 * 60 * 1000);
  log.info('auth', `token 已更新，matrix_uid=${tokens.matrixUid}，scope=${tokens.scope.join(',') || '(空)'}`);
}

export function clearTokens(): void {
  cachedTokens = null;
  refreshing = null;
  remove(STORAGE_KEYS.tokens);
  remove(STORAGE_KEYS.profile);
}

export function getProfile(): MatrixProfile | null {
  return readJSON<MatrixProfile>(STORAGE_KEYS.profile) ?? null;
}

export function saveProfile(p: MatrixProfile): void {
  writeJSON(STORAGE_KEYS.profile, p, 7 * 24 * 60 * 60 * 1000);
}

/** access token 是否在 skew 窗口内即将过期。 */
export function isAccessTokenStale(t: TokenBundle, skewMs = TOKEN_REFRESH_SKEW_MS): boolean {
  return t.expiresAt - nowMs() <= skewMs;
}

export function hasScope(tokens: TokenBundle, scope: string): boolean {
  return tokens.scope.indexOf(scope) >= 0 || tokens.scope.indexOf('admin:*') >= 0;
}

/* ------------------------------------------------------------------ */
/* 原始 HTTP（不经过 request 层，避免循环依赖）                          */
/* ------------------------------------------------------------------ */

interface RawResult {
  status: number;
  body: unknown;
}

function rawRequest(opts: {
  url: string;
  method: 'GET' | 'POST';
  data?: unknown;
  header?: Record<string, string>;
}): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(new ApiError({ kind: 'timeout', message: `auth 请求超时 ${opts.url}`, retryable: true })),
      );
    }, REQUEST_TIMEOUT_MS);

    wx.request({
      url: opts.url,
      method: opts.method,
      data: opts.data,
      header: {
        'content-type': 'application/json',
        ...(opts.header || {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
      success: (res) => {
        clearTimeout(timer);
        settle(() => resolve({ status: res.statusCode, body: res.data }));
      },
      fail: (err) => {
        clearTimeout(timer);
        settle(() => reject(toApiError(err)));
      },
    });
  });
}

function parseAuthError(status: number, body: unknown): ApiError {
  let code = '';
  let message = '';
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const err = b.error;
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      code = typeof e.code === 'string' ? e.code : '';
      message = typeof e.message === 'string' ? e.message : '';
    }
    if (!message && typeof b.message === 'string') message = b.message;
  }
  return new ApiError({
    kind: kindFromStatus(status),
    status,
    code: code || `http_${status}`,
    message: message || `auth HTTP ${status}`,
    detail: body,
  });
}

/* ------------------------------------------------------------------ */
/* 登录 / 刷新                                                        */
/* ------------------------------------------------------------------ */

function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: REQUEST_TIMEOUT_MS,
      success: (res) => {
        if (res && res.code) resolve(res.code);
        else
          reject(
            new ApiError({
              kind: 'unknown',
              message: 'wx.login 未返回 code',
              code: 'wx_login_empty',
            }),
          );
      },
      fail: (err) => reject(toApiError(err)),
    });
  });
}

/**
 * 用 `wx.login()` 的 code 换取 MatrixID 令牌。
 * 这条路径只在首次登录 / refresh token 彻底失效时走。
 */
export async function loginWithWechat(deviceId: string): Promise<TokenBundle> {
  const code = await wxLoginCode();
  const { apiBase } = getEndpoints();
  mark('auth:wx.login.done');

  const res = await rawRequest({
    url: `${apiBase}/v1/auth/wechat/exchange`,
    method: 'POST',
    data: {
      code,
      device_id: deviceId,
      client: 'wechat-pocket',
      // 明确声明本端只申请最小 scope（ADR-03 §4.5）
      requested_scope: ['station:pocket:read', 'station:pocket:write'],
    },
  });

  if (res.status < 200 || res.status >= 300) {
    throw parseAuthError(res.status, res.body);
  }
  const tokens = normalizeExchange(res.body as ExchangeResponse);
  saveTokens(tokens);
  return tokens;
}

async function doRefresh(rt: string): Promise<TokenBundle> {
  const { apiBase } = getEndpoints();
  const res = await rawRequest({
    url: `${apiBase}/v1/auth/refresh`,
    method: 'POST',
    data: { refresh_token: rt, client: 'wechat-pocket' },
  });

  if (res.status === 401) {
    // mx_rt 已被使用/过期/触发重放检测 —— 必须重新走微信登录
    throw new ApiError({
      kind: 'unauthorized',
      status: 401,
      code: 'refresh_rejected',
      message: 'refresh token 被拒绝，需要重新登录',
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw parseAuthError(res.status, res.body);
  }

  const body = res.body as ExchangeResponse;
  // 服务端轮转 mx_rt；若未返回则表示沿用旧值（服务端未实现轮转）
  const normalized = normalizeExchange({
    ...body,
    matrix_uid: body.matrix_uid || (getTokens()?.matrixUid ?? ''),
    refresh_token: body.refresh_token || body.mx_rt || rt,
  });
  saveTokens(normalized);
  return normalized;
}

/**
 * 获取一个可用的 access token。
 * 并发调用会被合并成一个刷新请求（mx_rt 一次性语义的硬要求）。
 */
export async function ensureFreshToken(force = false): Promise<TokenBundle> {
  const current = getTokens();

  if (!current) {
    if (refreshing) return refreshing;
    refreshing = loginWithWechat(ensureDeviceId()).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  if (!force && !isAccessTokenStale(current)) return current;

  if (refreshing) return refreshing;

  refreshing = doRefresh(current.mxRt)
    .catch(async (e: unknown) => {
      const err = toApiError(e);
      // 401 → mx_rt 已废，重走微信登录；其它错误（网络/5xx）向上抛，让调用方走缓存
      if (err.kind === 'unauthorized') {
        log.warn('auth', 'refresh 被拒，回退 wx.login 全量登录');
        clearTokens();
        return loginWithWechat(ensureDeviceId());
      }
      throw err;
    })
    .finally(() => {
      refreshing = null;
    });

  return refreshing;
}

/** 设备标识：用于 `mx_rt` 的设备绑定与多端登录管理。生成后永久保留。 */
export function ensureDeviceId(): string {
  const existing = readJSON<string>(STORAGE_KEYS.deviceId);
  if (existing && typeof existing === 'string' && existing.length >= 8) return existing;

  // 不使用 crypto.randomUUID（小程序基础库低版本不存在），用时间 + 随机拼装
  const rand = () => Math.random().toString(36).slice(2, 10);
  const id = `wxp_${Date.now().toString(36)}${rand()}${rand()}`;
  writeJSON(STORAGE_KEYS.deviceId, id, 0);
  return id;
}

/** 环境相关：mock 模式下不真的调微信登录接口。 */
export function isMockEnv(): boolean {
  return getEnv() === 'local';
}
