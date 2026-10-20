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

# 合法运行环境。``staging`` 与 ``production`` 共用同一套严格校验（见 core/preflight.py），
# 避免出现「预发能跑、生产炸」这类只在发布当天才暴露的差异。
APP_ENVS: tuple[str, ...] = ("development", "test", "staging", "production")
STRICT_ENVS: frozenset[str] = frozenset({"staging", "production"})

# ``jwt_issuer`` 的出厂占位值。生产环境沿用它会让签发出去的 token 指向一个不存在的
# issuer，且各微站本地验签的 ``iss`` 断言会全部失败——因此 preflight 会拒绝它。
DEFAULT_JWT_ISSUER = "https://api.matrixos.edu"

# 18 个微站的 Pages 项目名恒为 ``mx-<site_key>``（见 docs/02-engineering/06-cloudflare-deploy.md）。
# Starlette 的 ``allow_origins`` 是**精确串匹配**，不认 ``*`` 通配，所以
# `https://mx-*.pages.dev` 必须走 ``allow_origin_regex``——这一点是本项目最容易踩的坑。
MATRIXOS_PAGES_ORIGIN_REGEX = r"^https://mx-[a-z0-9-]+\.pages\.dev$"


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
    jwt_issuer: str = DEFAULT_JWT_ISSUER
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

    # ---- CORS ----
    # 精确来源白名单（逐条串匹配，支持 ``https://a.example.com`` 这种完整 origin）。
    cors_allowed_origins: list[str] = Field(default_factory=list)
    # 高级用法：完整正则。留空则按下面的 ``cors_allow_pages_dev`` 决定是否放行 Pages。
    cors_allowed_origin_regex: str | None = None
    # 是否放行 ``https://mx-*.pages.dev``（18 个微站的默认域名）。
    #
    # ⚠️ 安全说明：``pages.dev`` 是 Cloudflare 的**共享租户域**，任何 Cloudflare 用户都能
    # 注册一个叫 ``mx-anything`` 的 Pages 项目并拿到同形状的 origin。打开它等于「相信所有
    # 注册了 mx- 前缀项目的陌生人」。因此：
    #   - 开发/演示（前端还没有自有域名）时打开，换取「前端改完就能联调」；
    #   - 一旦把微站绑到自有域名（如 ``*.matrixos.edu``），**必须关掉**并改用精确白名单。
    # 默认关闭是安全默认；打开时 preflight 会在生产环境给出显式告警。
    cors_allow_pages_dev: bool = False

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

    @field_validator("app_env", mode="before")
    @classmethod
    def _normalize_env(cls, value: str) -> str:
        """``prod`` / ``PROD`` 统一成 ``production``，避免 ``is_production`` 判断不一致。"""
        normalized = str(value).strip().lower()
        if normalized in {"prod", "production"}:
            return "production"
        if normalized not in APP_ENVS:
            raise ValueError(f"app_env 必须是 {', '.join(APP_ENVS)} 之一，收到 {value!r}")
        return normalized

    @field_validator("database_url")
    @classmethod
    def _check_database_url(cls, value: str) -> str:
        """只挡「明显写错」的 DSN；方言可用性由 preflight 结合环境判断。"""
        if not value or "://" not in value:
            raise ValueError(
                "database_url 必须是 SQLAlchemy 异步 DSN，"
                "例如 postgresql+asyncpg://user:pass@host:5432/db"
            )
        if value.startswith("postgresql://"):
            raise ValueError(
                "database_url 必须使用异步驱动：把 postgresql:// 换成 postgresql+asyncpg://"
            )
        return value

    @field_validator("cors_allowed_origins")
    @classmethod
    def _check_origins(cls, value: list[str]) -> list[str]:
        """提前挡掉两类会静默失效的写法。

        Starlette 的 ``allow_origins`` 是精确串匹配，写 ``https://mx-*.pages.dev``
        永远不会命中；而结尾多余的 ``/`` 会让 ``https://x.com/`` 无法匹配浏览器发来的
        ``https://x.com``——两者都不会报错，只会表现为「CORS 莫名不生效」。
        """
        cleaned: list[str] = []
        for origin in value:
            item = origin.strip()
            if not item:
                continue
            if "*" in item:
                raise ValueError(
                    f"cors_allowed_origins 不支持通配符：{item!r}。"
                    "Starlette 的 allow_origins 是精确匹配，"
                    "通配请改用 cors_allowed_origin_regex 或 cors_allow_pages_dev"
                )
            if item.endswith("/"):
                raise ValueError(
                    f"来源不能带结尾斜杠：{item!r} → 去掉末尾 '/'（浏览器发来的 Origin 不含路径）"
                )
            cleaned.append(item)
        return cleaned

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def is_strict(self) -> bool:
        """staging / production：启用完整启动前校验。"""
        return self.app_env in STRICT_ENVS

    @property
    def is_test(self) -> bool:
        return self.app_env == "test"

    @property
    def cors_origin_regex(self) -> str | None:
        """实际生效的来源正则：显式配置优先，其次按 Pages 开关生成。"""
        if self.cors_allowed_origin_regex:
            return self.cors_allowed_origin_regex
        if self.cors_allow_pages_dev:
            return MATRIXOS_PAGES_ORIGIN_REGEX
        return None

    @property
    def cors_enabled(self) -> bool:
        return bool(self.cors_allowed_origins) or self.cors_origin_regex is not None


@functools.lru_cache(maxsize=1)
def get_settings() -> Settings:
    """进程级单例配置。"""
    return Settings()


def clear_settings_cache() -> None:
    """供测试在改环境变量后重置配置缓存。"""
    get_settings.cache_clear()
