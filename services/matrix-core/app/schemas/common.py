"""统一错误响应体（S1-06 强制契约）：``{code, message, trace_id}``。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ErrorResponse(BaseModel):
    """所有非 2xx 响应的唯一形态。"""

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "code": "auth.token_expired",
                    "message": "令牌已过期",
                    "trace_id": "0b8f0c1e-6a1d-4b2e-9c33-7f1a2d4e5f60",
                }
            ]
        }
    )

    code: str = Field(description="稳定错误码，见 app/core/errors.py 的 ErrorCode")
    message: str = Field(description="人类可读的错误说明（不含内部细节）")
    trace_id: str = Field(description="本次请求的 trace_id，与响应的 X-Trace-Id 头一致")
