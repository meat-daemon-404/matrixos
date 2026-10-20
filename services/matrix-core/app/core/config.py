"""应用配置：统一从环境变量 / .env 读取。

约定：
- 所有环境变量以 ``MATRIX_CORE_`` 为前缀（见 ``.env.example``）；
- 不在代码里硬编码任何密钥；RSA 密钥只从 ``keys/`` 目录读取；
- 配置对象通过 ``get_settings()`` 获取（带缓存），测试里可显式传入 ``Settings(...)`` 覆盖。
"""

from __future__ import annotations

import functools
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# services/matrix-core（本文件位于 app/core/config.py）
SERVICE_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """matrix-core 运行时配置。"""

    model_config = SettingsConfigDict(
        env_prefix="MATRIX_CORE_",
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- 应用 ----
    app_name: str = "matrix-core"
    app_env: str = "development"  # development | test | staging | production
    debug: bool = False
    api_prefix: str = "/v1"

    # ---- 数据库 ----
    # 生产使用 PostgreSQL 16 + pgvector；测试可用 sqlite+aiosqlite。
    database_url: str = "postgresql+asyncpg://matrixos:matrixos@127.0.0.1:5432/matrixos"
    db_pool_size: int = 10
    db_max_overflow: int = 20
    db_echo: bool = False

    # ---- JWT / MatrixID ----
    jwt_issuer: str = "https://api.matrixos.edu"
    jwt_algorithm: str = "RS256"
    jwt_audience: str = "matrixos"
    access_token_ttl_seconds: int = 15 * 60  # mx_at：15 min（S1-08 硬要求）
    refresh_token_ttl_seconds: int = 30 * 24 * 3600  # mx_rt：30 d 滑动（S1-08 硬要求）
    idt_ttl_seconds: int = 120  # mx_idt：120 s（S1-09 硬要求）
    auth_code_ttl_seconds: int = 300  # 授权码 5 min
    login_session_ttl_seconds: int = 900  # 统一登录页会话 15 min
    # 密钥轮转后旧公钥的验签保留窗口（天）；超窗的旧公钥由运维清理
    key_retention_days: int = 30
    keys_dir: Path = Field(default=SERVICE_ROOT / "keys")
    # 开发环境缺密钥时自动生成（生产环境必须显式执行 scripts/generate_keys.py）
    auto_generate_keys: bool = True

    # ---- Cookie ----
    cookie_domain: str = ".matrixos.edu"
    cookie_secure: bool = False
    cookie_samesite: str = "lax"
    access_cookie_name: str = "mx_at"
    refresh_cookie_name: str = "mx_rt"
    session_cookie_name: str = "mx_sess"

    # ---- 向量检索 ----
    embedding_provider: str = "hashing"  # hashing（默认，离线可跑）| 预留外部 provider
    embedding_dim: int = 1024  # ADR-04：vector(1024) 锁死
    chunk_size: int = 800
    chunk_overlap: int = 120
    max_chunks_per_asset: int = 64
    search_default_top_k: int = 10
    search_max_top_k: int = 50
    hnsw_m: int = 16
    hnsw_ef_construction: int = 64

    # ---- 可观测性 / 安全 ----
    log_level: str = "INFO"
    log_json: bool = True
    # 单用户每分钟写入限额（防止脚本刷库），0 = 关闭
    write_rate_limit_per_minute: int = 120
    # introspect 是否强制调用方自带 mx_at（关闭时仅按令牌本身验签，便于 iframe SDK）
    introspect_require_auth: bool = False
    cors_allowed_origins: list[str] = Field(default_factory=list)

    @field_validator("keys_dir", mode="before")
    @classmethod
    def _expand_keys_dir(cls, value: str | Path) -> Path:
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = (SERVICE_ROOT / path).resolve()
        return path

    @field_validator("log_level")
    @classmethod
    def _upper_level(cls, value: str) -> str:
        return value.upper()

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in {"prod", "production"}

    @property
    def is_test(self) -> bool:
        return self.app_env.lower() == "test"


@functools.lru_cache(maxsize=1)
def get_settings() -> Settings:
    """进程级单例配置。"""
    return Settings()


def clear_settings_cache() -> None:
    """供测试在改环境变量后重置配置缓存。"""
    get_settings.cache_clear()
