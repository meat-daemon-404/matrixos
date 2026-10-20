"""数据库引擎与会话管理。

生产：asyncpg + 连接池；测试：aiosqlite（无服务器）或真实 PostgreSQL（DSN 由
``MATRIX_CORE_TEST_DATABASE_URL`` 提供时）。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings, get_settings

# 当前请求绑定的会话（供 service 层读取，避免到处透传 session）
_session_var: ContextVar[AsyncSession | None] = ContextVar("matrix_session", default=None)


def build_engine(settings: Settings | None = None) -> AsyncEngine:
    """按 DSN 构建异步引擎；SQLite 自动关闭连接池参数。"""
    cfg = settings or get_settings()
    url = cfg.database_url
    kwargs: dict[str, Any] = {"echo": cfg.db_echo, "future": True}

    if url.startswith("sqlite"):
        # aiosqlite：单连接 + 允许跨线程，测试用
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        kwargs.update(
            pool_size=cfg.db_pool_size,
            max_overflow=cfg.db_max_overflow,
            pool_pre_ping=True,
            pool_recycle=1800,
        )
    return create_async_engine(url, **kwargs)


def build_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(
        bind=engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
    )


class Database:
    """引擎 + 会话工厂的持有者（应用生命周期内唯一）。"""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.engine = build_engine(self.settings)
        self.session_factory = build_session_factory(self.engine)

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        session = self.session_factory()
        try:
            yield session
        finally:
            await session.close()

    async def dispose(self) -> None:
        await self.engine.dispose()


def set_session(session: AsyncSession | None) -> None:
    _session_var.set(session)


def get_session_ctx() -> AsyncSession | None:
    return _session_var.get()
