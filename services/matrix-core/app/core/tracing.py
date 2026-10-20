"""trace_id 贯穿：入站请求 → 业务处理 → 出站日志。

规则（对应 architecture §8 可观测性 / S1-20 的 trace_id 同源要求）：
- 入站若带 ``X-Trace-Id``（或 ``traceparent``）且形如 UUID，则沿用，否则新生成；
- trace_id 存于 ``ContextVar``，可跨 async 边界读取（``get_trace_id``）；
- 每个响应都回写 ``X-Trace-Id``，让前端与虫洞 envelope 的 ``trace_id`` 可关联。
"""

from __future__ import annotations

import re
import uuid
from contextvars import ContextVar

TRACE_HEADER = "X-Trace-Id"
TRACEPARENT_HEADER = "traceparent"

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

_trace_id_var: ContextVar[str | None] = ContextVar("matrix_trace_id", default=None)


def new_trace_id() -> str:
    return str(uuid.uuid4())


def is_uuid(value: str | None) -> bool:
    """严格 UUID 形状校验（不接受任意字符串，避免日志注入）。"""
    return bool(value and _UUID_RE.match(value))


def get_trace_id() -> str:
    """读取当前 trace_id；没有就生成一个（保证永不返回 None）。"""
    current = _trace_id_var.get()
    if current is None:
        current = new_trace_id()
        _trace_id_var.set(current)
    return current


def set_trace_id(trace_id: str | None = None) -> str:
    value = trace_id if is_uuid(trace_id) else new_trace_id()
    _trace_id_var.set(value)
    return value


def reset_trace_id() -> None:
    _trace_id_var.set(None)


def extract_trace_id(headers: dict[str, str] | object) -> str | None:
    """从请求头提取 trace_id：优先 X-Trace-Id，其次 W3C traceparent。"""

    def _get(key: str) -> str | None:
        try:
            return headers.get(key)  # type: ignore[union-attr]
        except AttributeError:
            return None

    direct = _get(TRACE_HEADER) or _get(TRACE_HEADER.lower())
    if is_uuid(direct):
        return direct

    traceparent = _get(TRACEPARENT_HEADER) or _get(TRACEPARENT_HEADER.lower())
    if traceparent:
        # 格式：00-<32 hex trace-id>-<16 hex span-id>-<2 hex flags>
        parts = traceparent.split("-")
        if len(parts) == 4 and len(parts[1]) == 32:
            hex_id = parts[1]
            if re.fullmatch(r"[0-9a-fA-F]{32}", hex_id):
                return str(uuid.UUID(hex_id))
    return None
