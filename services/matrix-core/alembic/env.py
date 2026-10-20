"""Alembic 运行环境。

要点：
1. **DSN 不写死**：从 ``app.core.config.Settings`` 读（环境变量
   ``MATRIX_CORE_DATABASE_URL``），与运行时同源，避免「迁移连 A 库、服务连 B 库」；
2. **异步引擎**：生产用 asyncpg，同步场景（如 CI 里跑 offline SQL）走
   ``alembic upgrade --sql`` 时用 offline 分支；
3. **metadata 来自 models**：``target_metadata = Base.metadata``，
   autogenerate 才能看到全部表（见 app/models/__init__.py）。
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.config import get_settings
from app.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _database_url() -> str:
    """优先用 alembic -x db_url=... 覆盖，其次读应用配置。"""
    override = context.get_x_argument(as_dictionary=True).get("db_url")
    if override:
        return override
    return get_settings().database_url


def run_migrations_offline() -> None:
    """离线模式：只生成 SQL（``alembic upgrade head --sql``）。

    注意：``vector(1024)`` 与 HNSW 索引在离线 SQL 里按 PostgreSQL 方言渲染，
    因此离线产物只适用于 PostgreSQL（这正是它的用途）。
    """
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
        # 让 DDL 里的枚举/约束名可复现
        render_as_batch=False,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
        # SQLite 等不支持 ALTER 的方言需要 batch 模式（仅测试建库时用到）
        render_as_batch=connection.dialect.name == "sqlite",
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    configuration = config.get_section(config.config_ini_section, {}) or {}
    configuration["sqlalchemy.url"] = _database_url()

    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,  # 迁移是短生命周期进程，不需要池
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
