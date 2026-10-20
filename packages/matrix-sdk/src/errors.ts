/**
 * MatrixOS SDK · 统一错误
 *
 * 服务端错误体是 `{code, message, trace_id}`（S1-06）。SDK 把它包装成 `MatrixError`，
 * 并额外挂上 `fieldErrors`、`retryable`、`hint`——这样微站不需要为「该重试还是该提示用户」
 * 再写一遍判断逻辑。
 *
 * **令牌永不进错误消息**：`toJSON()` 与 `message` 都做过脱敏（S1-21 的日志红线）。
 */

import type { MatrixErrorBody, MatrixErrorCode } from './types.ts';

export interface MatrixErrorInit {
  readonly code: MatrixErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly traceId?: string;
  readonly fieldErrors?: readonly string[];
  readonly retryable?: boolean;
  readonly cause?: unknown;
  readonly body?: MatrixErrorBody;
  /** 面向用户的下一步动作（如「在新标签页打开 MatrixOS 重新登录」）。 */
  readonly hint?: string;
}

/** HTTP 状态码 → SDK 错误码的映射。集中在这里，避免各调用点各写一遍。 */
export function codeFromStatus(status: number): MatrixErrorCode {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 412 || status === 422) return 'VALIDATION';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'HTTP';
  return 'HTTP';
}

/** 哪些错误值得自动重试。401 走刷新而不是重试，403/404/422 重试无意义。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** 脱敏：把任何形似令牌的片段替换掉，防止令牌进日志/错误上报。 */
export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '<jwt:redacted>')
    .replace(/\b(mx_at|mx_rt|mx_idt|mx_devkey|mx_csrf)=([^&\s"']+)/gi, '$1=<redacted>')
    .replace(/\b(bearer)\s+[A-Za-z0-9._-]{8,}/gi, '$1 <redacted>');
}

export class MatrixError extends Error {
  readonly code: MatrixErrorCode;
  readonly status: number | undefined;
  readonly traceId: string | undefined;
  readonly fieldErrors: readonly string[];
  readonly retryable: boolean;
  readonly hint: string | undefined;
  readonly body: MatrixErrorBody | undefined;

  constructor(init: MatrixErrorInit) {
    super(redactSecrets(init.message), init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'MatrixError';
    this.code = init.code;
    this.status = init.status;
    this.traceId = init.traceId;
    this.fieldErrors = init.fieldErrors ?? [];
    this.retryable = init.retryable ?? (init.status !== undefined && isRetryableStatus(init.status));
    this.hint = init.hint;
    this.body = init.body;
  }

  /** 微站可直接把它塞进日志或错误上报——已脱敏，且带 trace_id 便于对齐后端链路。 */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      traceId: this.traceId,
      fieldErrors: this.fieldErrors,
      retryable: this.retryable,
      hint: this.hint,
    };
  }

  static is(value: unknown): value is MatrixError {
    return value instanceof MatrixError;
  }

  /** 契约校验失败：`fieldErrors` 已是人可读的 `字段: 原因` 形式。 */
  static validation(message: string, fieldErrors: readonly string[], code: MatrixErrorCode = 'VALIDATION'): MatrixError {
    return new MatrixError({ code, message, fieldErrors, retryable: false });
  }

  static notImplemented(what: string, why: string): MatrixError {
    return new MatrixError({
      code: 'NOT_IMPLEMENTED',
      message: `${what} 尚未实现：${why}`,
      retryable: false,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 各接口的窄化错误类型，便于 `catch (e) { if (e instanceof AuthExpiredError) ... }`
// ─────────────────────────────────────────────────────────────────────────────

export class AuthExpiredError extends MatrixError {
  constructor(init: Omit<MatrixErrorInit, 'code'> & { code?: MatrixErrorCode }) {
    super({ ...init, code: init.code ?? 'AUTH_EXPIRED', retryable: init.retryable ?? false });
    this.name = 'AuthExpiredError';
  }
}

export class OriginRejectedError extends MatrixError {
  readonly rejectedOrigin: string;

  constructor(rejectedOrigin: string, allowed: readonly string[]) {
    super({
      code: 'ORIGIN_REJECTED',
      message: `拒绝来自 ${rejectedOrigin} 的跨源消息：不在白名单 [${allowed.join(', ')}] 内`,
      retryable: false,
    });
    this.name = 'OriginRejectedError';
    this.rejectedOrigin = rejectedOrigin;
  }
}

/**
 * `mx_idt` 已被消费/已过期。
 *
 * 这正是「同一 mx_idt 二次交换必须失败」的直接体现（S1-09 验收项）：
 * SDK 侧做本地原子占位（并发保护），服务端做最终裁决。本地这道防线让
 * 「双击触发两次 initSSO」这类常见 UI bug 不会真的打到服务端并污染审计日志。
 */
export class IdtExchangeError extends MatrixError {
  constructor(code: 'IDT_ALREADY_CONSUMED' | 'IDT_EXPIRED' | 'AUTH_EXPIRED', message: string, cause?: unknown) {
    super({ code, message, retryable: false, cause });
    this.name = 'IdtExchangeError';
  }
}

export class CircuitOpenError extends MatrixError {
  constructor(retryAfterMs: number) {
    super({
      code: 'CIRCUIT_OPEN',
      message: `matrix-core 连续失败，熔断器已打开，${Math.ceil(retryAfterMs / 1000)}s 后重试（ADR-09）`,
      retryable: true,
      hint: '当前处于只读离线态：可读 IndexedDB 缓存，写入已暂停',
    });
    this.name = 'CircuitOpenError';
  }
}

export class UnsupportedPayloadError extends MatrixError {
  readonly targetApp: string;
  readonly payloadType: string;

  constructor(targetApp: string, payloadType: string, accepted: readonly string[]) {
    super({
      code: 'UNSUPPORTED_PAYLOAD',
      message:
        accepted.length === 0
          ? `目标站 ${targetApp} 未声明接收任何虫洞投送（accepts 为空）`
          : `目标站 ${targetApp} 不接受 payload_type「${payloadType}」，它只接受 [${accepted.join(', ')}]`,
      retryable: false,
      hint: '这是 manifest 的 accepts 声明与投送类型不匹配，不是网络问题',
    });
    this.name = 'UnsupportedPayloadError';
    this.targetApp = targetApp;
    this.payloadType = payloadType;
  }
}
