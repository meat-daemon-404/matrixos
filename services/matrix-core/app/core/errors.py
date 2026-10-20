"""统一错误模型。

S1-06 验收：错误响应统一为 ``{code, message, trace_id}``——**只有这三个键**，
不再向响应体添加任何字段（字段级校验信息拼进 ``message``，供人读；
机器判读请依赖稳定的 ``code``）。
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.tracing import get_trace_id


class ErrorCode:
    """稳定错误码表（对外契约：只增不改）。"""

    # 通用
    VALIDATION_FAILED = "validation.failed"
    UNAUTHORIZED = "auth.unauthorized"
    FORBIDDEN = "auth.forbidden"
    NOT_FOUND = "resource.not_found"
    CONFLICT = "resource.conflict"
    RATE_LIMITED = "request.rate_limited"
    INTERNAL = "internal.error"

    # 鉴权
    INVALID_CREDENTIALS = "auth.invalid_credentials"
    LOGIN_REQUIRED = "auth.login_required"
    INVALID_GRANT = "auth.invalid_grant"
    INVALID_CLIENT = "auth.invalid_client"
    INVALID_REDIRECT_URI = "auth.invalid_redirect_uri"
    INVALID_SCOPE = "auth.invalid_scope"
    TOKEN_INVALID = "auth.token_invalid"
    TOKEN_EXPIRED = "auth.token_expired"
    TOKEN_REVOKED = "auth.token_revoked"
    TOKEN_TYPE_MISMATCH = "auth.token_type_mismatch"
    REFRESH_REUSE_DETECTED = "auth.refresh_reuse_detected"
    IDT_INVALID = "auth.idt_invalid"
    IDT_EXPIRED = "auth.idt_expired"
    IDT_ALREADY_USED = "auth.idt_already_used"
    IDT_STATION_MISMATCH = "auth.idt_station_mismatch"
    INSUFFICIENT_SCOPE = "auth.insufficient_scope"

    # 资产
    ASSET_NOT_FOUND = "asset.not_found"
    ASSET_FORBIDDEN = "asset.forbidden"
    ASSET_STATION_MISMATCH = "asset.station_mismatch"
    ASSET_PAYLOAD_INVALID = "asset.payload_invalid"
    ASSET_VERSION_CONFLICT = "asset.version_conflict"

    # 虫洞
    WORMHOLE_PAYLOAD_FORBIDDEN = "wormhole.payload_forbidden"
    WORMHOLE_EVIDENCE_REQUIRED = "wormhole.evidence_required"
    WORMHOLE_INVALID_ENVELOPE = "wormhole.invalid_envelope"
    WORMHOLE_RECEIPT_NOT_FOUND = "wormhole.receipt_not_found"
    WORMHOLE_RECEIPT_EMIT_DENIED = "wormhole.emit_scope_required"

    # 注册表（manifest 校验，Stage 2 扩展）
    REGISTRY_MANIFEST_INVALID = "registry.manifest_invalid"


# 错误码默认的 HTTP 状态码；未列出的按 400 处理
DEFAULT_STATUS: dict[str, int] = {
    ErrorCode.VALIDATION_FAILED: 422,
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.CONFLICT: 409,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.INTERNAL: 500,
    ErrorCode.INVALID_CREDENTIALS: 401,
    ErrorCode.LOGIN_REQUIRED: 401,
    ErrorCode.INVALID_GRANT: 400,
    ErrorCode.INVALID_CLIENT: 401,
    ErrorCode.INVALID_REDIRECT_URI: 400,
    ErrorCode.INVALID_SCOPE: 400,
    ErrorCode.TOKEN_INVALID: 401,
    ErrorCode.TOKEN_EXPIRED: 401,
    ErrorCode.TOKEN_REVOKED: 401,
    ErrorCode.TOKEN_TYPE_MISMATCH: 401,
    ErrorCode.REFRESH_REUSE_DETECTED: 401,
    ErrorCode.IDT_INVALID: 401,
    ErrorCode.IDT_EXPIRED: 401,
    ErrorCode.IDT_ALREADY_USED: 401,
    ErrorCode.IDT_STATION_MISMATCH: 403,
    ErrorCode.INSUFFICIENT_SCOPE: 403,
    ErrorCode.ASSET_NOT_FOUND: 404,
    ErrorCode.ASSET_FORBIDDEN: 403,
    ErrorCode.ASSET_STATION_MISMATCH: 403,
    ErrorCode.ASSET_PAYLOAD_INVALID: 422,
    ErrorCode.ASSET_VERSION_CONFLICT: 409,
    ErrorCode.WORMHOLE_PAYLOAD_FORBIDDEN: 422,
    ErrorCode.WORMHOLE_EVIDENCE_REQUIRED: 422,
    ErrorCode.WORMHOLE_INVALID_ENVELOPE: 422,
    ErrorCode.WORMHOLE_RECEIPT_NOT_FOUND: 404,
    ErrorCode.WORMHOLE_RECEIPT_EMIT_DENIED: 403,
    ErrorCode.REGISTRY_MANIFEST_INVALID: 422,
}


class MatrixError(Exception):
    """业务异常基类。抛它即可得到统一错误响应。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int | None = None,
        headers: dict[str, str] | None = None,
        log_extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code or DEFAULT_STATUS.get(code, 400)
        self.headers = headers or {}
        self.log_extra = log_extra or {}

    def to_body(self, trace_id: str) -> dict[str, str]:
        return {"code": self.code, "message": self.message, "trace_id": trace_id}


def _short_reason(exc: BaseException) -> str:
    """只取异常类型名——避免把内部细节/数据回显给调用方。"""
    return type(exc).__name__


def _validation_message(exc: RequestValidationError) -> str:
    parts: list[str] = []
    for err in exc.errors()[:8]:
        loc = ".".join(str(item) for item in err.get("loc", ()) if item != "body")
        parts.append(f"{loc or 'body'}: {err.get('msg', 'invalid')}")
    return "; ".join(parts) or "请求参数校验失败"


def register_exception_handlers(app: FastAPI) -> None:
    """注册全部异常处理器（保证任何路径都不会漏掉统一错误体）。"""

    @app.exception_handler(MatrixError)
    async def _matrix_error_handler(_: Request, exc: MatrixError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.to_body(get_trace_id()),
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        body = {
            "code": ErrorCode.VALIDATION_FAILED,
            "message": _validation_message(exc),
            "trace_id": get_trace_id(),
        }
        return JSONResponse(status_code=422, content=body)

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {
            401: ErrorCode.UNAUTHORIZED,
            403: ErrorCode.FORBIDDEN,
            404: ErrorCode.NOT_FOUND,
            405: ErrorCode.VALIDATION_FAILED,
            429: ErrorCode.RATE_LIMITED,
        }.get(exc.status_code, ErrorCode.INTERNAL if exc.status_code >= 500 else ErrorCode.VALIDATION_FAILED)
        detail = exc.detail if isinstance(exc.detail, str) else HTTPStatus(exc.status_code).phrase
        body = {"code": code, "message": detail, "trace_id": get_trace_id()}
        return JSONResponse(status_code=exc.status_code, content=body, headers=exc.headers)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        # 不把堆栈或异常消息回给调用方；由日志（带 trace_id）承担排查
        body = {
            "code": ErrorCode.INTERNAL,
            "message": f"服务内部错误（{_short_reason(exc)}），请携带 trace_id 反馈",
            "trace_id": get_trace_id(),
        }
        return JSONResponse(status_code=500, content=body)
