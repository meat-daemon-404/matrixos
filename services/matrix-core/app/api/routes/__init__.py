"""路由聚合：所有 ``/v1/*`` 在这里挂到同一个 ``APIRouter``。

主入口 ``app.main`` 只需 ``app.include_router(api_router)``，新增服务域时
改这一处即可（避免 main.py 变成路由堆叠）。
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes import assets, auth, health, wormhole

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(assets.router)
api_router.include_router(wormhole.router)

__all__ = ["api_router"]
