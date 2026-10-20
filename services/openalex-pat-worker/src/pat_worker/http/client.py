"""统一出站 HTTP 客户端：礼貌池身份、限速、重试、磁盘缓存。

三条铁律，都是各 API 文档明写的要求：

1. **礼貌池身份**：OpenAlex 要求 `mailto`，Crossref 要求 `User-Agent` 带联系方式，
   arXiv 要求 `User-Agent` 可识别。三者统一由一个 User-Agent 与 `mailto` 查询参数承载。
2. **限速**：arXiv 明确要求两次请求间隔 ≥ 3s，且禁止并发。这里用 asyncio 的
   per-host 信号量 + 单调时钟最小间隔，而不是固定 sleep——固定 sleep 在并发下会失效。
3. **重试**：只对可恢复错误重试（429 / 5xx / 网络异常），4xx（除 429）直接失败。
   指数退避 + 抖动，且尊重 `Retry-After`。

缓存策略：GET 结果按 URL 落 SQLite，默认 15 分钟。作用是「同一天手动触发 3 次早报
不会把 arXiv 打三遍」——这对 arXiv 尤其重要，它的 429 很记仇。

设计取舍：这个类不做响应解析，只返回 `bytes`；解析交给各采集器，
这样采集器的解析逻辑可以脱离网络单测。
"""

from __future__ import annotations

import asyncio
import random
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import httpx

USER_AGENT_TEMPLATE: Final = "MatrixOS-pat-worker/{version} (+https://matrixos.edu; mailto:{email})"
FALLBACK_CONTACT: Final = "anonymous@matrixos.edu"

#: 每主机最小请求间隔（秒）。未列出的主机用 DEFAULT_MIN_INTERVAL。
#: 数值依据：arXiv 官方 API 用户手册要求 ≥ 3s；Crossref 建议礼貌池并发 ≤ 1；
#: OpenAlex 免费池 10 req/s，留足余量用 0.12s。
HOST_MIN_INTERVALS: Final[dict[str, float]] = {
    "export.arxiv.org": 3.0,
    "api.openalex.org": 0.12,
    "api.crossref.org": 1.0,
    "www.nature.com": 1.0,
}
DEFAULT_MIN_INTERVAL: Final = 0.2

RETRYABLE_STATUS: Final = frozenset({408, 425, 429, 500, 502, 503, 504})


class UpstreamError(RuntimeError):
    """上游返回不可恢复错误，或重试耗尽。"""

    def __init__(self, url: str, status: int | None, detail: str) -> None:
        self.url = url
        self.status = status
        self.detail = detail
        super().__init__(f"{url} -> {status}: {detail}")


@dataclass(slots=True)
class FetchResult:
    url: str
    status: int
    content: bytes
    from_cache: bool = False

    @property
    def text(self) -> str:
        # arXiv 与 RSS 都是 UTF-8；显式声明避免 Windows 默认 cp936 误判。
        return self.content.decode("utf-8", errors="replace")


class _HostRateLimiter:
    """按主机名做「最小间隔 + 并发 1」的串行化。

    用事件循环内的 asyncio.Lock 而不是 threading.Lock：本服务的采集全在同一个事件
    循环里跑，跨循环加锁反而会死锁。锁的持有时间包含实际请求耗时，这正是 arXiv 想
    要的语义（不要并发打它）。
    """

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._last_at: dict[str, float] = {}
        self._guard = threading.Lock()

    def _lock_for(self, host: str) -> asyncio.Lock:
        with self._guard:
            lock = self._locks.get(host)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[host] = lock
            return lock

    async def acquire(self, host: str, min_interval: float) -> None:
        lock = self._lock_for(host)
        await lock.acquire()
        last = self._last_at.get(host)
        if last is not None:
            wait = min_interval - (time.monotonic() - last)
            if wait > 0:
                await asyncio.sleep(wait)
        self._last_at[host] = time.monotonic()

    def release(self, host: str) -> None:
        lock = self._lock_for(host)
        if lock.locked():
            lock.release()
        self._last_at[host] = time.monotonic()


class HttpCache:
    """SQLite 版 GET 缓存。进程重启后仍有效，避免反复冷启动打爆上游。"""

    def __init__(self, path: str | Path, ttl_seconds: int) -> None:
        self._path = str(path)
        self._ttl = ttl_seconds
        self._local = threading.local()
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        conn = self._conn()
        conn.execute(
            "CREATE TABLE IF NOT EXISTS http_cache ("
            " url TEXT PRIMARY KEY, status INTEGER NOT NULL, content BLOB NOT NULL,"
            " fetched_at REAL NOT NULL)"
        )
        conn.commit()

    def get(self, url: str) -> FetchResult | None:
        if self._ttl <= 0:
            return None
        row = self._conn().execute(
            "SELECT status, content, fetched_at FROM http_cache WHERE url = ?", (url,)
        ).fetchone()
        if row is None:
            return None
        status, content, fetched_at = row
        if time.time() - fetched_at > self._ttl:
            return None
        return FetchResult(url=url, status=status, content=content, from_cache=True)

    def put(self, url: str, status: int, content: bytes) -> None:
        if self._ttl <= 0:
            return
        conn = self._conn()
        conn.execute(
            "INSERT OR REPLACE INTO http_cache (url, status, content, fetched_at)"
            " VALUES (?, ?, ?, ?)",
            (url, status, content, time.time()),
        )
        conn.commit()

    def clear(self) -> None:
        conn = self._conn()
        conn.execute("DELETE FROM http_cache")
        conn.commit()

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None


class PoliteHttpClient:
    """带礼貌池身份的异步 GET 客户端。

    用法：
        async with PoliteHttpClient(settings) as client:
            res = await client.get("https://api.openalex.org/works", params={...})
    """

    def __init__(
        self,
        *,
        contact_email: str,
        timeout_seconds: float = 20.0,
        max_retries: int = 3,
        backoff_base_seconds: float = 0.5,
        cache_ttl_seconds: int = 900,
        cache_path: str | Path = ":memory:",
        transport: httpx.AsyncBaseTransport | None = None,
        version: str = "0.1.0",
        sleep=asyncio.sleep,
    ) -> None:
        self._email = contact_email or FALLBACK_CONTACT
        self._timeout = timeout_seconds
        self._max_retries = max(0, max_retries)
        self._backoff = max(0.0, backoff_base_seconds)
        self._cache = HttpCache(cache_path, cache_ttl_seconds)
        self._limiter = _HostRateLimiter()
        self._sleep = sleep
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._version = version
        self.request_log: list[str] = []

    # ------------------------------------------------------------------ 生命周期

    async def __aenter__(self) -> PoliteHttpClient:
        await self.start()
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout),
                headers=self.default_headers(),
                follow_redirects=True,
                transport=self._transport,
            )

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self._cache.close()

    # -------------------------------------------------------------------- 请求头

    @property
    def user_agent(self) -> str:
        return USER_AGENT_TEMPLATE.format(version=self._version, email=self._email)

    def default_headers(self) -> dict[str, str]:
        return {
            "User-Agent": self.user_agent,
            "Accept": "application/json, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
            "Accept-Encoding": "gzip, deflate",
        }

    def polite_params(self, extra: dict[str, object] | None = None) -> dict[str, object]:
        """把礼貌池参数 merge 进查询串。OpenAlex / Crossref 都认 `mailto`。"""
        params: dict[str, object] = {"mailto": self._email}
        if extra:
            params.update({k: v for k, v in extra.items() if v is not None})
        return params

    # -------------------------------------------------------------------- 主入口

    async def get(
        self,
        url: str,
        *,
        params: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
        use_cache: bool = True,
        polite: bool = True,
    ) -> FetchResult:
        request = self._client or httpx.AsyncClient(
            timeout=httpx.Timeout(self._timeout),
            headers=self.default_headers(),
            follow_redirects=True,
            transport=self._transport,
        )
        owns_client = self._client is None
        query = self.polite_params(params) if polite else dict(params or {})
        cache_key = self._cache_key(url, query)

        if use_cache:
            hit = self._cache.get(cache_key)
            if hit is not None:
                self.request_log.append(f"CACHE {url}")
                return hit

        host = httpx.URL(url).host or ""
        min_interval = HOST_MIN_INTERVALS.get(host, DEFAULT_MIN_INTERVAL)

        try:
            result = await self._get_with_retry(request, url, query, headers or {}, host, min_interval)
        finally:
            if owns_client:
                await request.aclose()

        if use_cache:
            self._cache.put(cache_key, result.status, result.content)
        return result

    async def _get_with_retry(
        self,
        client: httpx.AsyncClient,
        url: str,
        query: dict[str, object],
        headers: dict[str, str],
        host: str,
        min_interval: float,
    ) -> FetchResult:
        last_error: Exception | None = None
        for attempt in range(self._max_retries + 1):
            await self._limiter.acquire(host, min_interval)
            try:
                response = await client.get(url, params=query, headers=headers or None)
                status = response.status_code
                if status < 400:
                    self.request_log.append(f"GET {status} {url}")
                    return FetchResult(url=str(response.url), status=status, content=response.content)
                if status not in RETRYABLE_STATUS or attempt >= self._max_retries:
                    raise UpstreamError(url, status, response.text[:300])
                last_error = UpstreamError(url, status, response.text[:300])
                retry_after = self._parse_retry_after(response.headers.get("retry-after"))
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                if attempt >= self._max_retries:
                    raise UpstreamError(url, None, f"transport: {exc!r}") from exc
                last_error = exc
                retry_after = None
            finally:
                self._limiter.release(host)

            await self._sleep(self._delay_for(attempt, retry_after))

        raise UpstreamError(url, None, f"retries exhausted: {last_error!r}")

    # -------------------------------------------------------------------- 工具

    def _delay_for(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return min(retry_after, 30.0)
        # 指数退避 + ±25% 抖动，避免多实例同时重试形成共振
        base = self._backoff * (2**attempt)
        jitter = random.uniform(-0.25, 0.25) * base
        return max(0.0, base + jitter)

    @staticmethod
    def _parse_retry_after(raw: str | None) -> float | None:
        if not raw:
            return None
        try:
            return float(raw)
        except ValueError:
            return None

    @staticmethod
    def _cache_key(url: str, query: dict[str, object]) -> str:
        if not query:
            return url
        parts = sorted(f"{k}={v}" for k, v in query.items())
        return f"{url}?{'&'.join(parts)}"
