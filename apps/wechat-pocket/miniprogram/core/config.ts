/**
 * 口袋端运行时配置。
 *
 * 接口一律走 `docs/01-plan/01-architecture.md` §3.3 的 `/v1/*` 约定：
 *   - `matrix-core`      → `/v1/auth/*`、`/v1/assets/*`、`/v1/wormhole/receipt`、`/v1/registry/manifests`
 *   - `openalex-pat-worker`（内部）→ 对外经 matrix-core 暴露 `/v1/pat/*`
 *   - 小程序专属的伴侣端能力（早报/打卡/提醒/名片/队列）由 matrix-core 的 `/v1/pocket/*` 承载
 *
 * 环境切换：`wx.getAccountInfoSync` 不在本项目使用，改由启动 query `?env=local|staging|prod`
 * 或 storage 里的 `pocket:env` 覆盖，见 `resolveEnv()`。
 */

export type PocketEnv = 'local' | 'staging' | 'prod';

export interface EndpointConfig {
  /** REST 基址，不含末尾斜杠。 */
  apiBase: string;
  /** WebSocket 基址，不含末尾斜杠。 */
  wsBase: string;
}

const ENDPOINTS: Record<PocketEnv, EndpointConfig> = {
  local: {
    apiBase: 'http://127.0.0.1:8787',
    wsBase: 'ws://127.0.0.1:8787',
  },
  staging: {
    apiBase: 'https://api.staging.matrixos.edu',
    wsBase: 'wss://api.staging.matrixos.edu',
  },
  prod: {
    apiBase: 'https://api.matrixos.edu',
    wsBase: 'wss://api.matrixos.edu',
  },
};

const ENV_STORAGE_KEY = 'pocket:env';

let cachedEnv: PocketEnv | null = null;

function isPocketEnv(v: unknown): v is PocketEnv {
  return v === 'local' || v === 'staging' || v === 'prod';
}

/** 从启动参数 / storage 解析当前环境。默认 `local`，便于开发者工具里直接联通 mock 后端。 */
export function resolveEnv(launchQuery?: Record<string, string>): PocketEnv {
  if (cachedEnv) return cachedEnv;

  const fromQuery = launchQuery && launchQuery.env;
  if (isPocketEnv(fromQuery)) {
    cachedEnv = fromQuery;
    try {
      wx.setStorageSync(ENV_STORAGE_KEY, fromQuery);
    } catch (_e) {
      /* storage 不可用时忽略 */
    }
    return cachedEnv;
  }

  try {
    const stored = wx.getStorageSync(ENV_STORAGE_KEY);
    if (isPocketEnv(stored)) {
      cachedEnv = stored;
      return cachedEnv;
    }
  } catch (_e) {
    /* ignore */
  }

  cachedEnv = 'local';
  return cachedEnv;
}

export function getEnv(): PocketEnv {
  return cachedEnv ?? resolveEnv();
}

export function getEndpoints(): EndpointConfig {
  return ENDPOINTS[getEnv()];
}

/** 服务端未实现该接口时，是否回落到本地 mock 层（见 `api/mock/`）。 */
export const FALLBACK_TO_MOCK = true;

/** 请求超时阈值：口袋端是碎片化场景，等待不超过 6s。 */
export const REQUEST_TIMEOUT_MS = 6000;

/** WebSocket 重连退避（毫秒），第 n 次失败取 `WS_BACKOFF_MS[min(n, len-1)]`。 */
export const WS_BACKOFF_MS = [800, 1600, 3200, 6400, 12000, 20000];
/** 长连接心跳间隔；服务端 2 个周期无 pong 即判定掉线并走轮询兜底。 */
export const WS_HEARTBEAT_MS = 20000;
/** 轮询兜底间隔（长连接不可用时）。 */
export const POLL_FALLBACK_MS = 30000;

/** access token 提前刷新阈值。 */
export const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

/** 冷启动预算：超过该值在控制台打 warn，方便量化 S2-21 的验收。 */
export const COLD_START_BUDGET_MS = 800;

/** 首屏骨架屏的最短展示时长，避免闪烁（数据极快返回时仍保证视觉稳定）。 */
export const SKELETON_MIN_MS = 180;
