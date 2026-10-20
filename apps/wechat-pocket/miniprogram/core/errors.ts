/**
 * 统一错误模型。
 *
 * 服务端返回 `{ error: { code, message, retryable? } }`；
 * 客户端把网络失败、HTTP 非 2xx、业务错误、mock 回落都归一成 `ApiError`，
 * 页面层只处理一种错误类型，避免每个页面各写一套判断。
 */

export type ApiErrorKind =
  | 'network' // 断网 / DNS / 连接被拒
  | 'timeout' // 超时
  | 'unauthorized' // 401，token 刷新失败
  | 'forbidden' // 403，scope 不足
  | 'not_found' // 404，接口未实现（触发 mock 回落）
  | 'conflict' // 409，幂等冲突（如重复打卡）
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'bad_response' // 2xx 但 body 不符合契约
  | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  /** 是否真的由 mock 层返回（页面需要显式标注「演示数据」）。 */
  readonly fromMock: boolean;
  readonly detail?: unknown;

  constructor(init: {
    kind: ApiErrorKind;
    message: string;
    status?: number;
    code?: string;
    retryable?: boolean;
    fromMock?: boolean;
    detail?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status ?? 0;
    this.code = init.code ?? init.kind;
    this.retryable = init.retryable ?? defaultRetryable(init.kind);
    this.fromMock = init.fromMock === true;
    this.detail = init.detail;
    // 修正 prototype 链：小程序 TS 编译到 ES2020 时 Error 子类会被打断
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /** 页面文案：一律中文、一律可执行。 */
  get userMessage(): string {
    switch (this.kind) {
      case 'network':
        return '网络不可用，正在使用本地缓存';
      case 'timeout':
        return '请求超时，请下拉重试';
      case 'unauthorized':
        return '登录已过期，请重新进入小程序';
      case 'forbidden':
        return '当前账号无此权限';
      case 'not_found':
        return '该能力尚未开通';
      case 'conflict':
        return this.message || '操作重复，已是最新状态';
      case 'rate_limited':
        return '操作过于频繁，请稍后再试';
      case 'server':
        return '服务暂时不可用，已切换本地缓存';
      case 'bad_response':
        return '数据格式异常，已回退演示数据';
      default:
        return '出错了，请稍后重试';
    }
  }
}

function defaultRetryable(kind: ApiErrorKind): boolean {
  return kind === 'network' || kind === 'timeout' || kind === 'server' || kind === 'rate_limited';
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 把任意 throw 出来的东西转成 ApiError。 */
export function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    const errMsg = typeof obj.errMsg === 'string' ? obj.errMsg : '';
    if (errMsg.indexOf('timeout') >= 0) {
      return new ApiError({ kind: 'timeout', message: errMsg, retryable: true });
    }
    if (errMsg.indexOf('fail') >= 0) {
      return new ApiError({ kind: 'network', message: errMsg, retryable: true });
    }
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new ApiError({ kind: 'unknown', message: msg });
}

/** HTTP 状态码 → 错误种类。 */
export function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'unknown';
  return 'bad_response';
}
