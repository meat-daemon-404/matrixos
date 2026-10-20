#!/usr/bin/env python
"""开发环境初始化：建表 + 播种 demo 数据。

用法（在 services/matrix-core 目录下）：
    python update_dev_db.py

为什么需要这个脚本：
- `alembic upgrade head` 在 SQLite 下会遇到 PG 专有类型的坑（vector/HNSW），
  开发期直接用 `Base.metadata.create_all` 更快且方言自适应（db/base.py 的
  VectorType 已做了 SQLite 降级）。
- 登录流程依赖 `oauth_client` 表里预置的 19 个站点客户端；
  没有 seed 数据时 `/v1/auth/login` 会 500（no such table / client not found）。
- 演示需要一个可登录的账号。

生产环境仍应走 Alembic 迁移，不要用这个脚本。
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# 允许直接 `python dev_init.py` 运行（不必先 pip install -e .）
sys.path.insert(0, str(Path(__file__).resolve().parent))

os.environ.setdefault("MATRIX_CORE_ENV", "development")
os.environ.setdefault("MATRIX_CORE_DATABASE_URL", "sqlite+aiosqlite:///./matrixos_dev.db")
os.environ.setdefault("MATRIX_CORE_KEYDIR", "./.tmp_keys")


async def main() -> int:
    from sqlalchemy import select

    from app.core.config import get_settings
    from app.db.base import Base
    from app.db.session import Database
    from app.models import assets as _assets  # noqa: F401  确保模型被注册
    from app.models import auth as auth_models  # noqa: F401
    from app.models import wormhole as _wormhole  # noqa: F401

    settings = get_settings()
    print(f"数据库: {settings.database_url}")

    # Database 在构造时就建好引擎，没有单独的 init()
    db = Database(settings)

    # ── 1. 建表 ────────────────────────────────────────────────
    async with db.engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    tables = sorted(Base.metadata.tables.keys())
    print(f"✓ 建表完成，共 {len(tables)} 张：{', '.join(tables)}")

    # ── 2. 播种 OAuth 客户端（19 个站点）──────────────────────
    from app.core.sites import known_site_keys

    site_keys = sorted(known_site_keys())  # frozenset → 排序后便于稳定分配端口
    print(f"  站点 keys（{len(site_keys)} 个）: {', '.join(site_keys)}")

    async with db.session() as session:
        existing = (await session.execute(select(auth_models.OAuthClient))).scalars().all()
        have = {c.client_id for c in existing}
        added = 0
        for index, key in enumerate(site_keys):
            if key in have:
                continue
            # orbital 是 hub 本身（端口 3000），其余微站按 3010 + idx 分配
            dev_port = 3000 if key == "orbital" else 3010 + max(0, index - 1)
            session.add(
                auth_models.OAuthClient(
                    client_id=key,
                    client_name=f"MatrixOS 微站 {key}",
                    is_public=True,
                    client_secret_hash=None,
                    redirect_uris=[
                        f"https://{key}.matrixos.edu/auth/callback",
                        f"http://localhost:{dev_port}/auth/callback",
                    ],
                    allowed_scopes=[
                        "openid", "profile", "assets:read", "assets:write",
                        "wormhole:send", "wormhole:receive",
                    ],
                    is_active=True,
                )
            )
            added += 1
        await session.commit()
        print(f"✓ OAuth 客户端：新增 {added} 个，共 {len(have) + added} 个")

    # ── 3. 播种 demo 用户 ─────────────────────────────────────
    from app.core.security.passwords import hash_password

    async with db.session() as session:
        seeded = 0
        for uid, email, password, name in [
            ("mx_demo0000000000000000000000001", "demo@matrixos.edu", "DevPass123!", "演示用户"),
            ("mx_student000000000000000000001", "student@matrixos.edu", "StudentPass123!", "孙同学"),
        ]:
            found = (
                await session.execute(
                    select(auth_models.MatrixUser).where(auth_models.MatrixUser.email == email)
                )
            ).scalar_one_or_none()
            if found is not None:
                continue
            session.add(
                auth_models.MatrixUser(
                    matrix_uid=uid,
                    display_name=name,
                    email=email,
                    password_hash=hash_password(password),
                    entitlements=["openid", "profile", "assets:read", "assets:write",
                                  "wormhole:send", "wormhole:receive"],
                    is_active=True,
                    auth_epoch=1,
                )
            )
            seeded += 1
        await session.commit()
        print(f"✓ demo 用户：新增 {seeded} 个")

    await db.dispose()

    print()
    print("─" * 56)
    print("初始化完成。可用账号：")
    print("  demo@matrixos.edu    / DevPass123!")
    print("  student@matrixos.edu / StudentPass123!")
    print()
    print("启动服务：")
    print("  MATRIX_CORE_DATABASE_URL='sqlite+aiosqlite:///./matrixos_dev.db' \\")
    print("  python -m uvicorn app.main:app --port 8000")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
