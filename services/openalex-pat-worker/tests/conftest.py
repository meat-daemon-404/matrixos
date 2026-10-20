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

#: 仓库根的跨端契约目录。早报 schema 属于跨端契约（小程序端也消费），
#: 因此放在根 ``specs/`` 而不是本服务目录里 —— 测试必须校验**真契约**，
#: 不能在测试里再造一份 schema，否则契约漂移就没人发现了。
REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = REPO_ROOT / "specs" / "contracts"
MORNING_BRIEF_SCHEMA = CONTRACTS / "morning-brief.schema.json"


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


# ---------------------------------------------------------------------------
# 真契约：morning-brief.schema.json
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def morning_brief_schema() -> dict:
    """读取仓库根的**真**早报契约（不是测试专用副本）。"""
    import json

    if not MORNING_BRIEF_SCHEMA.exists():  # pragma: no cover - 仓库结构被破坏时才触发
        pytest.fail(f"找不到早报契约：{MORNING_BRIEF_SCHEMA}")
    return json.loads(MORNING_BRIEF_SCHEMA.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def strict_brief_validator(morning_brief_schema):
    """**原样**契约的 Draft-07 校验器（含已知缺陷的 ``multipleOf``）。

    用于验证「契约本身是否自洽」（例如它自带的 examples 能否通过自己）。
    """
    jsonschema = pytest.importorskip("jsonschema")
    return jsonschema.Draft7Validator(morning_brief_schema)


@pytest.fixture(scope="session")
def brief_validator(morning_brief_schema):
    """去掉**已确认契约缺陷**后的校验器，用于校验本服务的输出。

    背景（详见 test_brief_contract.py 末尾两条 xfail）：契约给 ``card.heat``
    声明了 ``multipleOf: 0.1``，而 JSON Schema 的该关键字按浮点除法判定，
    导致约 34.8% 的合法一位小数值（74.1 / 62.8 / 73.8 …）被判为不合规。
    这是 **schema 侧的缺陷**，不是本服务的输出错误，且在真实数据上必然触发
    （非否决条目的理论最低分是 31.3，早已越过 30 分的入选下限）。

    因此结构校验必须先剔除这一条，否则整套契约测试会因为一个假阴性而常红。
    刻意**只删 multipleOf 这一个关键字**、其余全部保留 —— 不能顺手放宽别的东西，
    否则「契约测试」就失去意义了。
    """
    import copy

    jsonschema = pytest.importorskip("jsonschema")
    schema = copy.deepcopy(morning_brief_schema)
    heat_schema = schema["definitions"]["card"]["properties"]["heat"]
    assert "multipleOf" in heat_schema, "契约里已没有 multipleOf，请删除本夹具与相关 xfail"
    heat_schema.pop("multipleOf")
    return jsonschema.Draft7Validator(schema)


# ---------------------------------------------------------------------------
# 采集器测试用的 HTTP 双层 mock
# ---------------------------------------------------------------------------
def mock_transport(routes):
    """按「URL 子串 → 预置响应」构造 httpx.MockTransport。

    为什么不用更省事的 FakeHttpClient：采集器的**真实调用链**是
    ``collect_* → PoliteHttpClient.get → httpx``，HTTP 层的参数拼装
    （params / mailto / 限速 / 重试）正是要验证的东西。
    换成高层的假客户端会把这层整体跳过，测出来的就不是线上跑的那条路径。

    ``routes`` 的值可以是：
    - ``str``  → 200 + text
    - ``bytes`` → 200 + bytes
    - ``(status, body)`` → 指定状态码
    - ``callable(request) -> httpx.Response`` → 完全自定义

    未命中的 URL 返回 404，避免「忘记配路由」被静默当成成功。
    """
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        for needle, response in routes.items():
            if needle in url:
                if callable(response):
                    return response(request)
                if isinstance(response, tuple):
                    status, body = response
                    return httpx.Response(status, text=body)
                if isinstance(response, bytes):
                    return httpx.Response(200, content=response)
                return httpx.Response(200, text=response)
        return httpx.Response(404, text=f"no mock route for {url}")

    return httpx.MockTransport(handler)


def make_client(**overrides):
    """构造注入了 MockTransport 的 PoliteHttpClient（不触网）。

    默认把限速等待改成 no-op：真的按 arXiv 的 3s 间隔睡，会让这套测试
    从 0.2 秒变成几十秒，而限速**语义**另有专门用例用注入时钟验证。
    """
    from pat_worker.http.client import PoliteHttpClient

    async def _no_sleep(_seconds: float) -> None:
        return None

    params = dict(
        contact_email="test@matrixos.edu",
        timeout_seconds=5.0,
        max_retries=2,
        backoff_base_seconds=0.0,
        cache_ttl_seconds=0,
        cache_path=":memory:",
        sleep=_no_sleep,
    )
    params.update(overrides)
    return PoliteHttpClient(**params)


@pytest.fixture()
def transport_factory():
    return mock_transport


@pytest.fixture()
def client_factory():
    return make_client
