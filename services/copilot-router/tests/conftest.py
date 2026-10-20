"""pytest 公共夹具。

设计原则：**测试不依赖真实 API Key、不联网、不依赖外部服务。**
所有上游调用都走 ``MockProvider``，因此 CI 可稳定运行
（任务书要求不硬编码 Key；ADR-11 要求 copilot-router 单测 ≥ 70%）。

对 FastAPI 的处理：``api.py`` 相关测试用 ``pytest.importorskip``，
在未安装 FastAPI 的环境里自动跳过 —— 但领域逻辑测试（路由/成本/熔断/合规）
全部无条件运行，这是本服务的核心，不允许因为没有 Web 依赖就漏测。
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Iterator

import pytest
import yaml

from copilot_router.billing import CostLedger
from copilot_router.cache import SimilarityCache
from copilot_router.config import RouterConfig, load_config, parse_config
from copilot_router.gateway import CopilotGateway
from copilot_router.providers import MockProvider
from copilot_router.types import ChatMessage, ChatRequest, MatrixHints


CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "tiers.yaml"


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
def raw_config() -> dict[str, Any]:
    """读取原始 YAML，供测试按需改配置后再 parse。"""
    return yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))


def make_config(mutate=None) -> RouterConfig:  # type: ignore[no-untyped-def]
    """基于真实配置构造变体。

    刻意从真实的 ``config/tiers.yaml`` 出发而不是造一份测试专用配置：
    这样测试同时验证了**配置文件本身是合法的**（回归保护）。
    """
    data = copy.deepcopy(raw_config())
    if mutate is not None:
        mutate(data)
    return parse_config(data, CONFIG_PATH)


@pytest.fixture(scope="session")
def base_config() -> RouterConfig:
    return load_config(CONFIG_PATH)


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------
class RecordingProvider(MockProvider):
    """记录每次调用的 Provider，用于断言「敏感请求到底发给了谁」。"""

    def __init__(self, name: str, egress: str = "cloud") -> None:
        super().__init__(name=name, egress=egress)
        self.requests: list[list[ChatMessage]] = []

    def complete(self, messages, **kwargs):  # type: ignore[no-untyped-def]
        self.requests.append(list(messages))
        return super().complete(messages, **kwargs)


class FailingProvider(MockProvider):
    """总是失败的 Provider，用于测试 failover 与熔断。"""

    def __init__(self, name: str, egress: str = "cloud") -> None:
        super().__init__(name=name, egress=egress)
        self.attempts = 0

    def complete(self, messages, **kwargs):  # type: ignore[no-untyped-def]
        self.attempts += 1
        raise RuntimeError(f"{self.name} simulated upstream failure")


@pytest.fixture()
def mock_providers() -> dict[str, MockProvider]:
    return {
        "deepseek": MockProvider("deepseek", "cloud"),
        "qwen": MockProvider("qwen", "cloud"),
        "local-lora": MockProvider("local-lora", "local"),
    }


@pytest.fixture()
def gateway(base_config: RouterConfig, mock_providers) -> CopilotGateway:
    return CopilotGateway(base_config, providers=dict(mock_providers))


# ---------------------------------------------------------------------------
# 请求构造
# ---------------------------------------------------------------------------
def chat_request(
    content: str,
    *,
    uid: str = "mxu_test",
    station_id: str | None = "workshop",
    model: str = "auto",
    task_type: str | None = None,
    temperature: float = 0.2,
    max_tokens: int | None = None,
    sensitivity: str | None = None,
    user_triggered: bool = False,
    allow_cross_user_cache: bool = True,
    system: str | None = None,
) -> ChatRequest:
    messages: list[ChatMessage] = []
    if system:
        messages.append(ChatMessage(role="system", content=system))
    messages.append(ChatMessage(role="user", content=content))
    return ChatRequest(
        messages=messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        matrix=MatrixHints(
            matrix_uid=uid,
            station_id=station_id,
            task_type=task_type,
            sensitivity=sensitivity,  # type: ignore[arg-type]
            user_triggered=user_triggered,
            allow_cross_user_cache=allow_cross_user_cache,
        ),
    )


@pytest.fixture()
def make_request():
    return chat_request


# ---------------------------------------------------------------------------
# 其他
# ---------------------------------------------------------------------------
@pytest.fixture()
def ledger(base_config: RouterConfig) -> CostLedger:
    return CostLedger(tz_name=base_config.billing.timezone)


@pytest.fixture()
def cache(base_config: RouterConfig) -> Iterator[SimilarityCache]:
    yield SimilarityCache(base_config.cache)
