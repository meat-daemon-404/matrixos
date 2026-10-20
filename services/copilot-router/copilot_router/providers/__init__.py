"""Provider 适配层 —— DeepSeek / Qwen / 本地 LoRA 的统一抽象。

设计要点：

1. **统一抽象**（任务书第 7 条）：三家上游都是 OpenAI 兼容协议，
   因此只有一个 ``OpenAICompatProvider`` 适配器，差异只在 base_url / api_key。
   新增供应商只需在 ``config/tiers.yaml`` 加一条，不必改代码。

2. **合规 egress 硬约束**（这是本模块最重要的职责）：
   ``egress: cloud`` 的 Provider **永远不允许**接收被判为 blocked 的请求。
   这条校验放在 Provider 层而不是只放在路由层 —— 纵深防御：
   即使路由层有 bug 把敏感请求派给了云端 Provider，这里也会拦住并发 451。
   依据 ADR-05 与 R-R02 的兜底策略「若本地模型完全不可用，则不上传、不用模型」。

3. **failover**：同档位内按 ``tiers[*].providers`` 顺序尝试。
   跨档位 failover 默认**关闭**：让 Pro 任务跑在 Flash 上属于静默降级，
   与「绝不静默降级」的承诺冲突（配置里可显式开启，但需自行承担语义）。

4. **熔断器**：连续失败超过阈值后短路一段时间，避免每次请求都等超时。
   ADR-09 要求「SDK 内置熔断器，微站不自己实现」——服务端侧同理，
   不能把上游抖动放大成整体延迟。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

from ..config import FailoverSpec, ProviderSpec
from ..errors import ComplianceEgressError, NoProviderAvailableError, UpstreamError
from ..types import ChatMessage, TokenUsage

MessageList = list[ChatMessage]


# ---------------------------------------------------------------------------
# 结果与协议
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class CompletionResult:
    content: str
    usage: TokenUsage
    provider: str
    model: str
    #: 上游是否返回了 usage（缺失时用估算值，并在响应里标注 tokens_estimated=true）
    usage_from_upstream: bool = True
    latency_ms: float = 0.0
    raw_finish_reason: str | None = None


class Provider(Protocol):
    """Provider 协议。"""

    name: str
    egress: str

    @property
    def usable(self) -> bool: ...

    def complete(
        self,
        messages: MessageList,
        *,
        model: str,
        max_tokens: int,
        temperature: float,
        blocked_sensitivity: bool = False,
    ) -> CompletionResult: ...


# ---------------------------------------------------------------------------
# OpenAI 兼容适配器
# ---------------------------------------------------------------------------
class OpenAICompatProvider:
    """OpenAI ``/chat/completions`` 兼容协议适配器。

    只用 ``httpx``（FastAPI 的既有依赖链里就有），不引入各家 SDK：
    三个 SDK 各自升级会带来版本地狱，而协议本身是稳定的。
    """

    def __init__(self, spec: ProviderSpec) -> None:
        self._spec = spec
        self.name = spec.name
        self.egress = spec.egress

    @property
    def usable(self) -> bool:
        return self._spec.usable

    def complete(
        self,
        messages: MessageList,
        *,
        model: str,
        max_tokens: int,
        temperature: float,
        blocked_sensitivity: bool = False,
    ) -> CompletionResult:
        # ---- 合规硬闸（纵深防御）----------------------------------------
        if blocked_sensitivity and self.egress != "local":
            raise ComplianceEgressError(
                f"合规红线：命中敏感数据红线的请求不得发往云端 Provider {self.name}",
                details={"provider": self.name, "egress": self.egress},
            )

        import httpx  # 延迟导入：未装 httpx 时域逻辑仍可用

        url = self._spec.base_url.rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self._spec.api_key:
            headers["Authorization"] = f"Bearer {self._spec.api_key}"
        payload = {
            "model": model,
            "messages": [m.to_dict() for m in messages],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False,
        }

        started = time.perf_counter()
        try:
            with httpx.Client(timeout=self._spec.timeout_seconds) as client:
                response = client.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise UpstreamError(
                f"上游 {self.name} 网络错误：{exc}",
                details={"provider": self.name},
            ) from exc

        latency_ms = (time.perf_counter() - started) * 1000

        if response.status_code >= 400:
            raise UpstreamError(
                f"上游 {self.name} 返回 HTTP {response.status_code}",
                details={
                    "provider": self.name,
                    "status": response.status_code,
                    # 截断上游错误体，避免把用户 prompt 回显到日志
                    "body": response.text[:300],
                },
            )

        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise UpstreamError(
                f"上游 {self.name} 返回非 JSON", details={"provider": self.name}
            ) from exc

        choices = data.get("choices") or []
        if not choices:
            raise UpstreamError(
                f"上游 {self.name} 未返回 choices", details={"provider": self.name}
            )
        message = choices[0].get("message") or {}
        content = message.get("content") or ""
        finish_reason = choices[0].get("finish_reason")

        usage_raw = data.get("usage") or {}
        if "prompt_tokens" in usage_raw and "completion_tokens" in usage_raw:
            usage = TokenUsage(
                prompt_tokens=int(usage_raw["prompt_tokens"]),
                completion_tokens=int(usage_raw["completion_tokens"]),
            )
            from_upstream = True
        else:
            # 上游未返回 usage（部分兼容实现会省略）：交给调用方用估算兜底
            usage = TokenUsage(prompt_tokens=0, completion_tokens=0)
            from_upstream = False

        return CompletionResult(
            content=content,
            usage=usage,
            provider=self.name,
            model=str(data.get("model") or model),
            usage_from_upstream=from_upstream,
            latency_ms=round(latency_ms, 2),
            raw_finish_reason=finish_reason,
        )


# ---------------------------------------------------------------------------
# Mock 适配器（仅开发/测试）
# ---------------------------------------------------------------------------
class MockProvider:
    """无网络依赖的确定性 Provider。

    存在的理由：测试与本地开发不应该需要真实 API Key
    （任务书要求「不硬编码 API Key」，同时要求 pytest 可跑）。
    **默认不出现在任何档位的 providers 列表里**，只在测试或显式配置时启用。
    """

    def __init__(self, name: str = "mock", egress: str = "local") -> None:
        self.name = name
        self.egress = egress
        self.calls: list[dict[str, object]] = []

    @property
    def usable(self) -> bool:
        return True

    def complete(
        self,
        messages: MessageList,
        *,
        model: str,
        max_tokens: int,
        temperature: float,
        blocked_sensitivity: bool = False,
    ) -> CompletionResult:
        if blocked_sensitivity and self.egress != "local":
            raise ComplianceEgressError(
                f"合规红线：命中敏感数据红线的请求不得发往云端 Provider {self.name}",
                details={"provider": self.name, "egress": self.egress},
            )
        self.calls.append(
            {"model": model, "messages": len(messages), "max_tokens": max_tokens}
        )
        prompt_tokens = sum(len(m.content) for m in messages) // 2 + 8
        completion_tokens = min(max_tokens, 32)
        return CompletionResult(
            content=f"[mock:{model}] 已处理 {len(messages)} 条消息",
            usage=TokenUsage(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens),
            provider=self.name,
            model=model,
            usage_from_upstream=True,
            latency_ms=0.1,
            raw_finish_reason="stop",
        )


# ---------------------------------------------------------------------------
# 熔断器
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class _BreakerState:
    failures: list[float] = field(default_factory=list)
    opened_at: float | None = None


class CircuitBreaker:
    """连续失败阈值 + 冷却期。

    刻意用「滑动窗口内的失败次数」而不是「失败率」：请求量小时失败率没意义
    （1 次失败 / 1 次调用 = 100%）。
    """

    def __init__(
        self,
        spec: FailoverSpec,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._spec = spec
        self._clock = clock
        self._states: dict[str, _BreakerState] = {}

    def _state(self, name: str) -> _BreakerState:
        state = self._states.get(name)
        if state is None:
            state = _BreakerState()
            self._states[name] = state
        return state

    def is_open(self, name: str) -> bool:
        """是否处于短路状态。"""
        state = self._state(name)
        if state.opened_at is None:
            return False
        now = self._clock()
        if now - state.opened_at >= self._spec.breaker_reset_seconds:
            # 冷却结束，半开：清空失败记录允许重试
            state.opened_at = None
            state.failures.clear()
            return False
        return True

    def record_success(self, name: str) -> None:
        state = self._state(name)
        state.failures.clear()
        state.opened_at = None

    def record_failure(self, name: str) -> None:
        state = self._state(name)
        now = self._clock()
        window = self._spec.breaker_window_seconds
        state.failures = [t for t in state.failures if now - t <= window]
        state.failures.append(now)
        if len(state.failures) >= self._spec.breaker_failure_threshold:
            state.opened_at = now

    def reset(self) -> None:
        self._states.clear()


# ---------------------------------------------------------------------------
# Failover 调度
# ---------------------------------------------------------------------------
class ProviderPool:
    """按档位选择 Provider 并执行 failover。"""

    def __init__(
        self,
        providers: dict[str, Provider],
        failover: FailoverSpec,
        breaker: CircuitBreaker | None = None,
    ) -> None:
        self._providers = providers
        self._failover = failover
        self._breaker = breaker or CircuitBreaker(failover)
        #: 最近一次成功使用的 provider 名（供 gateway 回填）
        self.last_provider: str | None = None

    def provider(self, name: str) -> Provider | None:
        return self._providers.get(name)

    def available(self, names: list[str] | tuple[str, ...]) -> list[str]:
        """过滤出可用（已配置且熔断未开）的 Provider 名。"""
        out: list[str] = []
        for name in names:
            provider = self._providers.get(name)
            if provider is None or not provider.usable:
                continue
            if self._breaker.is_open(name):
                continue
            out.append(name)
        return out

    def complete_with_failover(
        self,
        provider_names: list[str] | tuple[str, ...],
        messages: MessageList,
        *,
        model: str,
        max_tokens: int,
        temperature: float,
        blocked_sensitivity: bool = False,
    ) -> CompletionResult:
        """按顺序尝试，返回第一个成功的结果。

        全部失败时抛 ``NoProviderAvailableError``，并把各 provider 的失败原因
        汇总进 details —— 运维需要知道「到底是没配置、还是被熔断、还是上游挂了」。
        """
        names = self.available(provider_names)
        if not names:
            raise NoProviderAvailableError(
                "该档位下没有可用的模型 Provider",
                details={
                    "requested": list(provider_names),
                    "configured": [
                        n for n in provider_names if self._providers.get(n) is not None
                    ],
                    "hint": "请检查 Provider 的 base_url / API Key 环境变量是否配置",
                },
            )

        if not self._failover.enabled:
            names = names[:1]

        failures: list[dict[str, object]] = []
        for name in names:
            provider = self._providers[name]
            try:
                result = provider.complete(
                    messages,
                    model=model,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    blocked_sensitivity=blocked_sensitivity,
                )
            except ComplianceEgressError:
                # 合规错误绝不 failover（换一家云端也一样违规）
                raise
            except Exception as exc:  # noqa: BLE001 - 需要兜住任何上游异常
                self._breaker.record_failure(name)
                failures.append({"provider": name, "error": str(exc)})
                continue
            self._breaker.record_success(name)
            self.last_provider = name
            return result

        raise NoProviderAvailableError(
            "该档位下所有模型 Provider 均调用失败",
            details={"requested": list(provider_names), "failures": failures},
        )

    @property
    def breaker(self) -> CircuitBreaker:
        return self._breaker


def build_providers(
    specs: dict[str, ProviderSpec],
    *,
    include_mock: bool = False,
) -> dict[str, Provider]:
    """按配置构造 Provider 实例。"""
    built: dict[str, Provider] = {}
    for name, spec in specs.items():
        if spec.kind == "mock":
            if include_mock:
                built[name] = MockProvider(name=name, egress=spec.egress)
            continue
        built[name] = OpenAICompatProvider(spec)
    return built
