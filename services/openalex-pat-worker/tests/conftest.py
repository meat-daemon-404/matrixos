"""pytest 公共夹具与路径引导。

设计原则：**测试不依赖真实 API Key、不联网、不依赖外部服务。**
- 所有采集器测试都用假的 ``PoliteHttpClient`` 返回值，绝不真打 arXiv/OpenAlex；
- SQLite 一律 ``:memory:``；
- ``domain/`` 是纯函数，直接构造 dataclass 即可。

关于 ``src/`` 布局：本包的 import 路径是 ``src/pat_worker``。这里在
``conftest`` 里把 ``src`` 塞进 ``sys.path``，这样**不装包也能直接 pytest**，
同时不影响用 ``pip install -e .`` 安装后的正常导入。
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


# ---------------------------------------------------------------------------
# 时间
# ---------------------------------------------------------------------------
#: 固定「现在」。所有测试都必须显式传 now，不允许依赖真实时钟。
NOW = datetime(2026, 10, 20, 8, 0, tzinfo=UTC)


@pytest.fixture()
def now() -> datetime:
    return NOW


@pytest.fixture()
def tz():
    from pat_worker.timeutil import resolve_tz

    return resolve_tz("Asia/Shanghai")


@pytest.fixture()
def settings():
    from pat_worker.settings import Settings

    return Settings(
        contact_email="test@matrixos.edu",
        internal_token="test-token",
        store_path=":memory:",
    )


# ---------------------------------------------------------------------------
# 构造 PaperItem / MergedPaper 的便捷函数
# ---------------------------------------------------------------------------
def make_item(
    *,
    source: str = "arxiv",
    title: str = "A perovskite solar cell with improved stability",
    published_at: datetime | None = None,
    **overrides,
):
    from pat_worker.models import PaperItem

    params = dict(
        source=source,
        title=title,
        published_at=published_at or (NOW - timedelta(hours=1)),
        url="https://example.org/paper",
        doi="",
        arxiv_id="",
        abstract="",
        venue_tier="preprint",
        venue_name="arXiv",
    )
    params.update(overrides)
    return PaperItem(**params)


def make_merged(
    *,
    title: str = "A perovskite solar cell with improved stability",
    published_at: datetime | None = None,
    source: str = "arxiv",
    **overrides,
):
    from pat_worker.pipeline.merge import MergedPaper

    params = dict(
        title=title,
        published_at=published_at or (NOW - timedelta(hours=1)),
        url="https://example.org/paper",
        venue_tier="preprint",
        venue_name="arXiv",
        sources=(source,),
    )
    params.update(overrides)
    return MergedPaper(**params)


@pytest.fixture()
def make_paper():
    return make_merged


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------
@pytest.fixture()
def store():
    from pat_worker.store.sqlite_store import Store

    s = Store(":memory:")
    yield s
    s.close()


# ---------------------------------------------------------------------------
# 假 HTTP 客户端（离线）
# ---------------------------------------------------------------------------
class FakeResponse:
    def __init__(self, *, text: str = "", status_code: int = 200, json_data=None) -> None:
        self.text = text
        self.status_code = status_code
        self._json = json_data

    def json(self):  # type: ignore[no-untyped-def]
        return self._json

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeHttpClient:
    """记录调用并返回预置响应，完全离线。

    只实现采集器实际用到的方法（``get_text`` / ``get_json``），
    因此它同时起到「采集器依赖面有多窄」的活文档作用。
    """

    def __init__(self, *, text: str = "", json_data=None) -> None:
        self.text = text
        self.json_data = json_data if json_data is not None else {}
        self.calls: list[dict[str, object]] = []

    async def get_text(self, url: str, *, params=None, use_cache: bool = True) -> str:  # type: ignore[no-untyped-def]
        self.calls.append({"url": url, "params": params, "kind": "text"})
        return self.text

    async def get_json(self, url: str, *, params=None, use_cache: bool = True):  # type: ignore[no-untyped-def]
        self.calls.append({"url": url, "params": params, "kind": "json"})
        return self.json_data


@pytest.fixture()
def fake_http():
    return FakeHttpClient
