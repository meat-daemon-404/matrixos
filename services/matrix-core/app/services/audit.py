"""审计流水服务：所有敏感动作留痕（只记元数据，不记令牌明文与 payload 正文）。"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redaction import redact_for_audit
from app.core.tracing import get_trace_id
from app.models.auth import AuditEvent


async def record(
    session: AsyncSession,
    *,
    action: str,
    matrix_uid: str | None = None,
    client_id: str | None = None,
    station_id: str | None = None,
    detail: dict[str, Any] | None = None,
    trace_id: str | None = None,
) -> AuditEvent:
    """写一条审计事件（调用方负责 commit）。"""
    event = AuditEvent(
        matrix_uid=matrix_uid,
        client_id=client_id,
        station_id=station_id,
        action=action,
        trace_id=trace_id or get_trace_id(),
        detail=redact_for_audit(detail or {}),
    )
    session.add(event)
    await session.flush()
    return event


async def record_no_commit(
    session: AsyncSession,
    *,
    action: str,
    **kwargs: Any,
) -> AuditEvent:
    return await record(session, action=action, **kwargs)
