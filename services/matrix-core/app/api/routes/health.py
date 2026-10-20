"""健康检查与运行时探测（L2 降级的输入，ADR-09）。

- ``GET /v1/health``        基础存活（不查库，给 K8s liveness 用）
- ``GET /v1/health/ready``  就绪（查库，给 readiness 用）
- ``GET /v1/health/detail`` 依赖明细（供 hub 星轨三态：正常/降级/维护）

为什么不放在根路径：所有对外契约统一在 ``/v1`` 下，避免网关按前缀路由时遗漏。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Request
from sqlalchemy import text

from app.api.deps import DatabaseDep, SettingsDep

router = APIRouter(prefix="/health", tags=["health"])


@router.get("", summary="存活探针（不查库）")
async def liveness(settings: SettingsDep) -> dict:
    from app import __version__

    return {
        "status": "ok",
        "service": settings.app_name,
        "version": __version__,
        "env": settings.app_env,
    }


@router.get("/ready", summary="就绪探针（查库）")
async def readiness(database: DatabaseDep) -> dict:
    """数据库不可用时返回 ``status: degraded``（HTTP 仍 200，由调用方判断）。

    刻意不返 503：hub 需要区分「matrix-core 挂了」与「matrix-core 活着但库挂了」，
    后者应触发 L1 鉴权降级而非 L2 只读离线。
    """
    try:
        async with database.session() as session:
            await session.execute(text("SELECT 1"))
        return {"status": "ready", "database": "ok"}
    except Exception as exc:  # noqa: BLE001 - 探针必须吞掉所有异常
        return {"status": "degraded", "database": "unavailable", "reason": type(exc).__name__}


@router.get("/detail", summary="依赖明细（hub 星轨三态的数据源）")
async def detail(
    database: DatabaseDep, settings: SettingsDep, request: Request
) -> dict:
    components: dict[str, str] = {}
    try:
        async with database.session() as session:
            await session.execute(text("SELECT 1"))
        components["database"] = "ok"
    except Exception as exc:  # noqa: BLE001
        components["database"] = f"error:{type(exc).__name__}"

    # 启动前校验的告警数（WARNING 不阻断启动，但运维需要看得到"带病"的程度）。
    # ERROR 若能出现，说明进程根本没起来——所以这里只暴露告警计数与明细。
    preflight = getattr(request.app.state, "preflight", None)
    warnings = [
        {"setting": item.setting, "detail": item.detail}
        for item in getattr(preflight, "warnings", [])
    ]

    overall = "ok" if all(value == "ok" for value in components.values()) else "degraded"
    return {
        "status": overall,
        "components": components,
        "config_warnings": warnings,
        "embedding_provider": settings.embedding_provider,
        "embedding_dim": settings.embedding_dim,
        "access_token_ttl": settings.access_token_ttl_seconds,
        "refresh_token_ttl": settings.refresh_token_ttl_seconds,
        "idt_ttl": settings.idt_ttl_seconds,
    }
