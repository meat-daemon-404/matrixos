"""配置装载。

刻意不用 pydantic-settings：本服务只有十几项配置，且需要在**依赖未装齐**时也能
被测试 import（CI 里先跑纯计算单测、后跑集成测试）。因此用标准库 dataclass +
环境变量解析，零额外依赖。

约定：
- 所有字段都有安全默认值，缺 env 不抛异常；
- 但「礼貌池联络邮箱」缺失会被 `Settings.warnings()` 记一条，`/healthz` 报 degraded。
  OpenAlex / Crossref 的礼貌池靠它识别调用方，缺失不算崩溃，但活该被限速。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

DEFAULT_ARXIV_CATEGORIES: tuple[str, ...] = (
    "cond-mat.mes-hall",
    "cond-mat.mtrl-sci",
    "physics.optics",
    "physics.app-ph",
    "astro-ph.IM",
    "quant-ph",
)

DEFAULT_OPENALEX_FIELD_IDS: tuple[str, ...] = ("31", "25")

DEFAULT_NATURE_RSS: tuple[str, ...] = (
    "https://www.nature.com/nphoton.rss",
    "https://www.nature.com/nphys.rss",
)


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or "").strip() or default


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = _env(name)
    if not raw:
        return default
    items = tuple(part.strip() for part in raw.split(",") if part.strip())
    return items or default


@dataclass(frozen=True, slots=True)
class Settings:
    """运行期配置。frozen 是为了让并发请求拿到一致的快照。"""

    contact_email: str = ""
    openalex_base_url: str = "https://api.openalex.org"
    openalex_api_key: str = ""
    arxiv_base_url: str = "https://export.arxiv.org/api/query"
    arxiv_min_interval_seconds: float = 3.0
    crossref_base_url: str = "https://api.crossref.org"
    nature_rss_urls: tuple[str, ...] = DEFAULT_NATURE_RSS

    arxiv_categories: tuple[str, ...] = DEFAULT_ARXIV_CATEGORIES
    openalex_field_ids: tuple[str, ...] = DEFAULT_OPENALEX_FIELD_IDS
    window_hours: int = 24
    timezone: str = "Asia/Shanghai"
    brief_cron_time: str = "08:00"

    host: str = "127.0.0.1"
    port: int = 8001
    log_level: str = "INFO"
    internal_token: str = ""
    scheduler_enabled: bool = True

    http_timeout_seconds: float = 20.0
    http_max_retries: int = 3
    http_backoff_base_seconds: float = 0.5
    http_cache_ttl_seconds: int = 900

    store_path: str = "./.data/pat-worker.sqlite3"

    extra: dict[str, str] = field(default_factory=dict)

    # ---------------------------------------------------------------- 派生属性

    @property
    def mailto(self) -> str:
        """OpenAlex 礼貌池参数值。空字符串表示未配置。"""
        return self.contact_email

    @property
    def http_cache_path(self) -> str:
        return str(Path(self.store_path).with_suffix(".httpcache.sqlite3"))

    def brief_cron_hour_minute(self) -> tuple[int, int]:
        """把 '08:00' 解析成 (8, 0)。非法值回落到 08:00 并记 warning。"""
        raw = self.brief_cron_time.strip()
        try:
            hour_s, minute_s = raw.split(":", 1)
            hour, minute = int(hour_s), int(minute_s)
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                return hour, minute
        except (ValueError, AttributeError):
            pass
        return 8, 0

    def warnings(self) -> list[str]:
        """启动自检。返回空列表代表配置健全。"""
        issues: list[str] = []
        if not self.contact_email:
            issues.append(
                "PAT_CONTACT_EMAIL 未设置：OpenAlex/Crossref 礼貌池退化为匿名调用，"
                "限速配额更低，属降级运行"
            )
        elif "@" not in self.contact_email:
            issues.append(f"PAT_CONTACT_EMAIL 不是合法邮箱：{self.contact_email!r}")
        if not self.internal_token:
            issues.append("/internal/* 端点未启用鉴权（PAT_INTERNAL_TOKEN 为空）")
        if self.window_hours < 1 or self.window_hours > 168:
            issues.append(f"PAT_WINDOW_HOURS={self.window_hours} 超出 1..168，将回落到 24")
        return issues

    def normalized_window_hours(self) -> int:
        return self.window_hours if 1 <= self.window_hours <= 168 else 24


def load_settings() -> Settings:
    """从环境变量构造 Settings。每次调用都读最新 env，便于测试 monkeypatch。"""
    return Settings(
        contact_email=_env("PAT_CONTACT_EMAIL") or _env("OPENALEX_MAILTO"),
        openalex_base_url=_env("OPENALEX_BASE_URL", "https://api.openalex.org").rstrip("/"),
        openalex_api_key=_env("OPENALEX_API_KEY"),
        arxiv_base_url=_env("ARXIV_BASE_URL", "https://export.arxiv.org/api/query"),
        arxiv_min_interval_seconds=_env_float("ARXIV_MIN_INTERVAL_SECONDS", 3.0),
        crossref_base_url=_env("CROSSREF_BASE_URL", "https://api.crossref.org").rstrip("/"),
        nature_rss_urls=_env_list("NATURE_RSS_URLS", DEFAULT_NATURE_RSS),
        arxiv_categories=_env_list("PAT_ARXIV_CATEGORIES", DEFAULT_ARXIV_CATEGORIES),
        openalex_field_ids=_env_list("PAT_OPENALEX_FIELD_IDS", DEFAULT_OPENALEX_FIELD_IDS),
        window_hours=_env_int("PAT_WINDOW_HOURS", 24),
        timezone=_env("PAT_TIMEZONE", "Asia/Shanghai"),
        brief_cron_time=_env("PAT_BRIEF_CRON_TIME", "08:00"),
        host=_env("PAT_HOST", "127.0.0.1"),
        port=_env_int("PAT_PORT", 8001),
        log_level=_env("PAT_LOG_LEVEL", "INFO").upper(),
        internal_token=_env("PAT_INTERNAL_TOKEN"),
        scheduler_enabled=_env_bool("PAT_SCHEDULER_ENABLED", True),
        http_timeout_seconds=_env_float("PAT_HTTP_TIMEOUT_SECONDS", 20.0),
        http_max_retries=_env_int("PAT_HTTP_MAX_RETRIES", 3),
        http_backoff_base_seconds=_env_float("PAT_HTTP_BACKOFF_BASE_SECONDS", 0.5),
        http_cache_ttl_seconds=_env_int("PAT_HTTP_CACHE_TTL_SECONDS", 900),
        store_path=_env("PAT_STORE_PATH", "./.data/pat-worker.sqlite3"),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """进程级单例。测试里用 `get_settings.cache_clear()` 重置。"""
    return load_settings()
