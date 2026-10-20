"""熔断器与 failover 测试。

熔断（provider 级）与成本熔断（budget 级）是两件不同的事：
- budget 熔断管「钱」，超限抛 402，是硬闸；
- 本模块管「上游可用性」，连续失败后短路一段时间，避免把用户请求
  全部拖进超时。

三条必须守住的不变量：
1. **合规错误绝不 failover**：命中敏感红线的请求换一家云端一样违规，
   必须直接抛出，而不是「再试一个 provider」。
2. **冷却后半开**：熔断不是永久拉黑，冷却期结束应允许重试。
3. **失败信息要能解释**：全挂时抛出的错误必须带上「哪个 provider 因何失败」，
   运维才能判断是没配 Key、被熔断、还是上游挂了。
"""

from __future__ import annotations

import pytest

from copilot_router.errors import ComplianceEgressError, NoProviderAvailableError
from copilot_router.providers import CircuitBreaker, ProviderPool
from copilot_router.types import ChatMessage


class FlakyProvider:
    """可编程成功/失败的 Provider。"""

    def __init__(self, name: str, *, egress: str = "cloud", fail: bool = False) -> None:
        self.name = name
        self.egress = egress
        self.fail = fail
        self.attempts = 0

    @property
    def usable(self) -> bool:
        return True

    def complete(self, messages, *, model, max_tokens, temperature, blocked_sensitivity=False):  # type: ignore[no-untyped-def]
        self.attempts += 1
        if self.fail:
            raise RuntimeError(f"{self.name} upstream failed")
        from copilot_router.providers import CompletionResult
        from copilot_router.types import TokenUsage

        return CompletionResult(
            content=f"[{self.name}] ok",
            usage=TokenUsage(prompt_tokens=10, completion_tokens=5),
            provider=self.name,
            model=model,
            usage_from_upstream=True,
            latency_ms=0.1,
            raw_finish_reason="stop",
        )


class ComplianceFailProvider(FlakyProvider):
    """总是触发合规拒绝的 Provider（模拟云端拒收敏感 payload）。"""

    def complete(self, messages, **kwargs):  # type: ignore[no-untyped-def]
        self.attempts += 1
        raise ComplianceEgressError(
            "命中敏感红线，拒绝发往云端", details={"provider": self.name}
        )


class UnusableProvider(FlakyProvider):
    @property
    def usable(self) -> bool:
        return False


MESSAGES = [ChatMessage(role="user", content="帮我解析这句话的意图")]


def pool_with(base_config, **providers) -> ProviderPool:
    return ProviderPool(providers, base_config.failover)


# ---------------------------------------------------------------------------
# 熔断器状态机
# ---------------------------------------------------------------------------
def test_breaker_starts_closed(base_config):
    breaker = CircuitBreaker(base_config.failover)
    assert breaker.is_open("p") is False


def test_breaker_opens_after_threshold_failures(base_config):
    now = {"t": 0.0}
    breaker = CircuitBreaker(base_config.failover, clock=lambda: now["t"])
    threshold = base_config.failover.breaker_failure_threshold

    for i in range(threshold - 1):
        breaker.record_failure("p")
        assert breaker.is_open("p") is False, f"第 {i + 1} 次失败不该立即熔断"

    breaker.record_failure("p")
    assert breaker.is_open("p") is True, f"{threshold} 次失败后应熔断"


def test_breaker_half_opens_after_cooldown(base_config):
    """冷却期结束后应允许重试（半开），而不是永久拉黑。"""
    now = {"t": 0.0}
    breaker = CircuitBreaker(base_config.failover, clock=lambda: now["t"])
    for _ in range(base_config.failover.breaker_failure_threshold):
        breaker.record_failure("p")
    assert breaker.is_open("p") is True

    now["t"] += base_config.failover.breaker_reset_seconds - 0.1
    assert breaker.is_open("p") is True, "冷却期内仍应短路"

    now["t"] += 0.2
    assert breaker.is_open("p") is False, "冷却期结束后应半开允许重试"


def test_breaker_success_resets_failures(base_config):
    now = {"t": 0.0}
    breaker = CircuitBreaker(base_config.failover, clock=lambda: now["t"])
    threshold = base_config.failover.breaker_failure_threshold
    for _ in range(threshold - 1):
        breaker.record_failure("p")
    breaker.record_success("p")
    # 失败计数已清零，再失败 threshold-1 次仍不该熔断
    for _ in range(threshold - 1):
        breaker.record_failure("p")
    assert breaker.is_open("p") is False, "成功应清零失败计数"


def test_breaker_window_expires_old_failures(base_config):
    """滑动窗口外的旧失败不计入本次判定。"""
    now = {"t": 0.0}
    breaker = CircuitBreaker(base_config.failover, clock=lambda: now["t"])
    threshold = base_config.failover.breaker_failure_threshold

    for _ in range(threshold - 1):
        breaker.record_failure("p")
    # 时间推进到窗口之外，旧失败应被清出
    now["t"] += base_config.failover.breaker_window_seconds + 1
    breaker.record_failure("p")
    assert breaker.is_open("p") is False, "窗口外失败不该累积成熔断"


def test_breaker_states_are_per_provider(base_config):
    now = {"t": 0.0}
    breaker = CircuitBreaker(base_config.failover, clock=lambda: now["t"])
    for _ in range(base_config.failover.breaker_failure_threshold):
        breaker.record_failure("bad")
    assert breaker.is_open("bad") is True
    assert breaker.is_open("good") is False, "熔断状态必须按 provider 隔离"


def test_breaker_reset_clears_all(base_config):
    breaker = CircuitBreaker(base_config.failover)
    for _ in range(base_config.failover.breaker_failure_threshold):
        breaker.record_failure("p")
    assert breaker.is_open("p") is True
    breaker.reset()
    assert breaker.is_open("p") is False


# ---------------------------------------------------------------------------
# ProviderPool 可用性
# ---------------------------------------------------------------------------
def test_available_filters_missing_and_unusable(base_config):
    pool = pool_with(
        base_config,
        ok=FlakyProvider("ok"),
        bad=UnusableProvider("bad"),
    )
    assert pool.available(["ok", "bad", "not-configured"]) == ["ok"]


def test_available_excludes_open_breaker(base_config):
    now = {"t": 0.0}
    pool = ProviderPool(
        {"p": FlakyProvider("p")},
        base_config.failover,
        CircuitBreaker(base_config.failover, clock=lambda: now["t"]),
    )
    for _ in range(base_config.failover.breaker_failure_threshold):
        pool.breaker.record_failure("p")
    assert pool.available(["p"]) == []


# ---------------------------------------------------------------------------
# failover 调度
# ---------------------------------------------------------------------------
def test_failover_moves_to_next_provider(base_config):
    first = FlakyProvider("first", fail=True)
    second = FlakyProvider("second")
    pool = pool_with(base_config, first=first, second=second)

    result = pool.complete_with_failover(
        ["first", "second"],
        messages=MESSAGES,
        model="m",
        max_tokens=32,
        temperature=0.2,
    )
    assert result.provider == "second"
    assert first.attempts == 1
    assert pool.last_provider == "second"


def test_failover_stops_at_first_success(base_config):
    first = FlakyProvider("first")
    second = FlakyProvider("second")
    pool = pool_with(base_config, first=first, second=second)
    pool.complete_with_failover(
        ["first", "second"], messages=MESSAGES, model="m", max_tokens=32, temperature=0.2
    )
    assert second.attempts == 0, "第一个成功后不该再打下游"


def test_all_failing_raises_with_details(base_config):
    pool = pool_with(base_config, a=FlakyProvider("a", fail=True), b=FlakyProvider("b", fail=True))
    with pytest.raises(NoProviderAvailableError) as excinfo:
        pool.complete_with_failover(
            ["a", "b"], messages=MESSAGES, model="m", max_tokens=32, temperature=0.2
        )
    details = excinfo.value.details
    assert "failures" in details
    failures = details["failures"]
    assert {f["provider"] for f in failures} == {"a", "b"}, "应汇总每个 provider 的失败原因"


def test_no_configured_provider_raises_helpful_error(base_config):
    pool = pool_with(base_config)
    with pytest.raises(NoProviderAvailableError) as excinfo:
        pool.complete_with_failover(
            ["ghost"], messages=MESSAGES, model="m", max_tokens=32, temperature=0.2
        )
    assert "requested" in excinfo.value.details


def test_compliance_error_is_never_failed_over(base_config):
    """合规红线：云端拒收敏感 payload 时不得「换个 provider 再试」。"""
    bad = ComplianceFailProvider("cloud-a")
    backup = FlakyProvider("cloud-b")
    pool = pool_with(base_config, **{"cloud-a": bad, "cloud-b": backup})

    with pytest.raises(ComplianceEgressError):
        pool.complete_with_failover(
            ["cloud-a", "cloud-b"],
            messages=MESSAGES,
            model="m",
            max_tokens=32,
            temperature=0.2,
            blocked_sensitivity=True,
        )

    assert backup.attempts == 0, "合规错误后不得把 payload 转给另一家云端"


def test_compliance_error_does_not_open_breaker(base_config):
    """合规拒绝不是上游故障，不该把 provider 熔断。"""
    bad = ComplianceFailProvider("cloud-a")
    pool = pool_with(base_config, **{"cloud-a": bad})
    with pytest.raises(ComplianceEgressError):
        pool.complete_with_failover(
            ["cloud-a"],
            messages=MESSAGES,
            model="m",
            max_tokens=32,
            temperature=0.2,
            blocked_sensitivity=True,
        )
    assert pool.breaker.is_open("cloud-a") is False, "合规拒绝不应触发熔断"


def test_failover_disabled_does_not_try_second(base_config):
    from .conftest import make_config

    disabled = make_config(lambda d: d["failover"].__setitem__("enabled", False))
    first = FlakyProvider("first", fail=True)
    second = FlakyProvider("second")
    pool = ProviderPool({"first": first, "second": second}, disabled.failover)

    with pytest.raises(NoProviderAvailableError):
        pool.complete_with_failover(
            ["first", "second"], messages=MESSAGES, model="m", max_tokens=32, temperature=0.2
        )
    assert second.attempts == 0, "failover 关闭时只试第一个"


def test_repeated_failure_opens_breaker_and_skips(base_config):
    """连续失败达到阈值后，后续请求应跳过该 provider（不再产生调用）。"""
    bad = FlakyProvider("bad", fail=True)
    good = FlakyProvider("good")
    pool = pool_with(base_config, bad=bad, good=good)
    threshold = base_config.failover.breaker_failure_threshold

    for _ in range(threshold):
        pool.complete_with_failover(
            ["bad", "good"], messages=MESSAGES, model="m", max_tokens=32, temperature=0.2
        )
    attempts_after_breach = bad.attempts
    assert attempts_after_breach == threshold

    # 熔断已开：再请求一次，bad 不应再被调用
    pool.complete_with_failover(
        ["bad", "good"], messages=MESSAGES, model="m", max_tokens=32, temperature=0.2
    )
    assert bad.attempts == attempts_after_breach, "熔断打开后仍调用了故障 provider"
