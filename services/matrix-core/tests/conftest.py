"""pytest 公共夹具。

设计取舍（读之前先知道为什么这么写）：

1. **用环境变量装配，而不是硬塞 ``Settings(...)``**：``get_settings()`` 在
   ``db/base.py``（VectorType 维度）、``core/logging.py``、``api/deps.py`` 里都被
   直接调用。只给 ``create_app()`` 传一个 Settings 实例，会让这些地方读到另一份
   配置——测试就变成"测了个假的"。所以先改环境变量再 ``clear_settings_cache()``，
   让整个进程只有一份配置。
2. **每个用例一个 SQLite 文件**：``sqlite+aiosqlite:///:memory:`` 在连接池下不保证
   跨连接共享同一内存库，用临时文件最稳；也方便「直接读库断言」和「扫原始字节」。
3. **口令哈希用低迭代**：真实 600k 迭代单次约 0.31s，几十个用例会拖成分钟级。
   生产参数由 ``test_security_primitives.py`` 单独断言（那里直接验 600k）。
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, clear_settings_cache, get_settings
from app.core.security.keys import KeyStore
from app.core.security.passwords import hash_password
from app.core.security.tokens import TokenSigner
from app.db.base import Base
from app.main import create_app
from app.models import MatrixUser, OAuthClient

# ---------------------------------------------------------------- 常量

TEST_PASSWORD = "correct-horse-battery-staple"
TEST_ITERATIONS = 1_000  # 仅测试用；生产 600_000

ALICE = "mxu_alice"
BOB = "mxu_bob"
CAROL = "mxu_carol"  # 无任何 scope 的身份，用于「登录了但没权限」用例

CURVELAB = "curvelab"
CHART = "chart-foundry"


def scopes(*verbs: str, station: str = CURVELAB) -> list[str]:
    """``scopes("read", "write")`` → ``["station:curvelab:read", ...]``。"""
    return [f"station:{station}:{verb}" for verb in verbs]


def full_scope(station: str = CURVELAB) -> list[str]:
    return scopes("read", "write", "emit", station=station)


# ---------------------------------------------------------------- 数据库准备


def _seed_rows() -> list[Any]:
    """两个正常用户 + 一个无 scope 用户 + 两个站点客户端。"""
    password_hash = hash_password(TEST_PASSWORD, iterations=TEST_ITERATIONS)
    return [
        MatrixUser(
            matrix_uid=ALICE,
            display_name="Alice",
            email="alice@matrixos.edu",
            password_hash=password_hash,
            entitlements=["student"],
            auth_epoch=1,
        ),
        MatrixUser(
            matrix_uid=BOB,
            display_name="Bob",
            email="bob@matrixos.edu",
            password_hash=password_hash,
            entitlements=["student"],
            auth_epoch=1,
        ),
        MatrixUser(
            matrix_uid=CAROL,
            display_name="Carol",
            email="carol@matrixos.edu",
            password_hash=password_hash,
            entitlements=[],
            auth_epoch=1,
        ),
        OAuthClient(
            client_id=f"site:{CURVELAB}",
            client_name="CurveLab",
            is_public=True,
            redirect_uris=[f"https://{CURVELAB}.matrixos.edu/cb"],
            allowed_scopes=full_scope(CURVELAB),
        ),
        OAuthClient(
            client_id=f"site:{CHART}",
            client_name="ChartFoundry",
            is_public=True,
            redirect_uris=[f"https://{CHART}.matrixos.edu/cb"],
            allowed_scopes=full_scope(CHART),
        ),
    ]


def _prepare_database(url: str) -> None:
    """建表 + 灌初始数据（用独立引擎，避免与应用的连接池纠缠）。"""

    async def run() -> None:
        engine = create_async_engine(url)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with maker() as session:
                session.add_all(_seed_rows())
                await session.commit()
        finally:
            await engine.dispose()

    asyncio.run(run())


# ---------------------------------------------------------------- 夹具


@pytest.fixture(scope="session")
def keys_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """整个测试会话共用一组 RSA 密钥（生成一次约 0.1s，没必要每例重来）。"""
    return tmp_path_factory.mktemp("matrix-core-keys")


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "matrix-core-test.db"


@pytest.fixture()
def settings(
    db_path: Path, keys_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> Settings:
    """把进程配置指向本次用例的临时库与共享密钥目录。"""
    monkeypatch.setenv("MATRIX_CORE_APP_ENV", "test")
    monkeypatch.setenv("MATRIX_CORE_DATABASE_URL", f"sqlite+aiosqlite:///{db_path.as_posix()}")
    monkeypatch.setenv("MATRIX_CORE_KEYS_DIR", str(keys_dir))
    monkeypatch.setenv("MATRIX_CORE_AUTO_GENERATE_KEYS", "true")
    # 限流会干扰「连发多个请求」的用例；限流本身另有用例单独打开
    monkeypatch.setenv("MATRIX_CORE_WRITE_RATE_LIMIT_PER_MINUTE", "0")
    monkeypatch.setenv("MATRIX_CORE_LOG_JSON", "false")
    clear_settings_cache()

    cfg = get_settings()
    _prepare_database(cfg.database_url)
    yield cfg
    clear_settings_cache()


@pytest.fixture()
def app(settings: Settings):
    application = create_app(settings)
    return application


@pytest.fixture()
def client(app) -> TestClient:
    """带 lifespan 的测试客户端（启动时才会建 Database / KeyStore）。"""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def signer(settings: Settings) -> TokenSigner:
    """与运行中的应用共用同一 ``keys/`` 目录，因此 kid 与公钥一致。"""
    return TokenSigner(settings, KeyStore(settings).load(create_if_missing=True))


@pytest.fixture()
def make_token(signer: TokenSigner) -> Callable[..., str]:
    """直接签一枚 access token（不走 HTTP，省掉口令校验开销）。"""

    def _make(
        *,
        matrix_uid: str = ALICE,
        scope: list[str] | None = None,
        station_id: str | None = CURVELAB,
        epoch: int = 1,
        jti: str | None = None,
        ttl: int | None = None,
    ) -> str:
        return signer.sign_access_token(
            matrix_uid=matrix_uid,
            jti=jti or str(uuid.uuid4()),
            scope=full_scope() if scope is None else scope,
            station_id=station_id,
            client_id=f"site:{CURVELAB}",
            epoch=epoch,
            ttl=ttl,
        )

    return _make


@pytest.fixture()
def auth(
    make_token: Callable[..., str],
) -> Callable[..., dict[str, str]]:
    """``auth(matrix_uid=BOB, scope=scopes("read"))`` → Authorization 头。"""

    def _headers(**kwargs: Any) -> dict[str, str]:
        return {"Authorization": f"Bearer {make_token(**kwargs)}"}

    return _headers


@pytest.fixture()
def db_run(settings: Settings) -> Callable[[Callable[[AsyncSession], Awaitable[Any]]], Any]:
    """在独立连接上执行一段库操作，用于直接断言落库结果。"""

    def _run(fn: Callable[[AsyncSession], Awaitable[Any]]) -> Any:
        async def _inner() -> Any:
            engine = create_async_engine(settings.database_url)
            try:
                maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
                async with maker() as session:
                    return await fn(session)
            finally:
                await engine.dispose()

        return asyncio.run(_inner())

    return _run


# ---------------------------------------------------------------- HTTP 帮助


@pytest.fixture()
def login(client: TestClient) -> Callable[..., dict[str, str]]:
    """走真实登录端点拿 Authorization 头（覆盖完整链路）。"""

    def _login(
        *,
        email: str = "alice@matrixos.edu",
        password: str = TEST_PASSWORD,
        client_id: str = f"site:{CURVELAB}",
        scope: str = f"station:{CURVELAB}:read station:{CURVELAB}:write station:{CURVELAB}:emit",
    ) -> dict[str, str]:
        response = client.post(
            "/v1/auth/login",
            params={"issue_tokens": "true"},
            json={
                "client_id": client_id,
                "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
                "scope": scope,
                "email": email,
                "password": password,
            },
        )
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {response.json()['tokens']['access_token']}"}

    return _login


@pytest.fixture()
def make_asset(client: TestClient):
    """建一条当前身份可写的资产，返回响应体。"""

    def _make(headers: dict[str, str], **overrides: Any) -> dict[str, Any]:
        body: dict[str, Any] = {
            "station_id": CURVELAB,
            "asset_type": "fit_result",
            "title": "双指数拟合 R²=0.98",
            "payload": {"r2": 0.98, "model": "double_exp"},
            "evidence_anchors": [
                {
                    "source_doi_or_url": "https://doi.org/10.1103/PhysRevB.99.014301",
                    "verification_level": "Level_A_Verified",
                }
            ],
            "verification_level": "Level_A_Verified",
        }
        body.update(overrides)
        response = client.post("/v1/assets", json=body, headers=headers)
        assert response.status_code == 201, response.text
        return response.json()

    return _make
