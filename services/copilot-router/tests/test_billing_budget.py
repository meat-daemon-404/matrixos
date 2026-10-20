"""成本核算与熔断测试（任务书重点测试项 ②③）。

成本核算要验证的是「钱算得对」：
- 单价 × token 的折算必须精确
- 按 matrix_uid 分别累计，不能串账
- 本地档位恒为 0
- 缓存命中不计费，但节省额可核算

熔断要验证的是「超限必须失败，不能静默降级」：
- 单用户日上限
- 全局日预算
- 单请求预估（调用前拦截，而非事后发现）
- 月上限
- 错误码 402 + 结构化 details（微站要能向用户解释）
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

import pytest

from copilot_router.billing import (
    CostLedger,
    UsageRecord,
    compute_cost,
    day_key,
    month_key,
)
from copilot_router.budget import BudgetGuard
from copilot_router.errors import BudgetExceededError
from copilot_router.config import RouterConfig
from copilot_router.types import TokenUsage

from .conftest import chat_request, make_config


# ---------------------------------------------------------------------------
# 成本折算精度
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "tier_id,prompt,completion,expected",
    [
        # TIER 01 ¥0.30/M：1M 输入 + 1M 输出 = ¥0.60
        ("tier-01", 1_000_000, 1_000_000, 0.60),
        # TIER 02 ¥0.40/M = ¥0.80
        ("tier-02", 1_000_000, 1_000_000, 0.80),
        # TIER 03 ¥2.00/M = ¥4.00
        ("tier-03", 1_000_000, 1_000_000, 4.00),
        # TIER 04 本地 = ¥0
        ("tier-04", 1_000_000, 1_000_000, 0.0),
        # 小额：1000 输入 + 500 输出 @ tier-03
        ("tier-03", 1_000, 500, 0.003),
        # 零 token
        ("tier-01", 0, 0, 0.0),
    ],
)
def test_cost_computation(base_config: RouterConfig, tier_id, prompt, completion, expected):
    spec = base_config.tier(tier_id)
    cost = compute_cost(spec, TokenUsage(prompt_tokens=prompt, completion_tokens=completion))
    assert cost.total_cost == pytest.approx(expected, abs=1e-9)


def test_cost_breakdown_exposes_pricing(base_config: RouterConfig):
    """成本明细必须带单价，账单才能被人工核对（架构 §8 要求可下钻）。"""
    spec = base_config.tier("tier-03")
    cost = compute_cost(spec, TokenUsage(prompt_tokens=2000, completion_tokens=1000))
    assert cost.price_input_per_million == 2.00
    assert cost.price_output_per_million == 2.00
    assert cost.input_cost == pytest.approx(0.004)
    assert cost.output_cost == pytest.approx(0.002)
    assert cost.total_cost == pytest.approx(0.006)


def test_local_tier_always_free(base_config: RouterConfig):
    spec = base_config.tier("tier-04")
    for prompt, completion in [(1, 1), (100_000, 100_000), (10**9, 10**9)]:
        cost = compute_cost(spec, TokenUsage(prompt_tokens=prompt, completion_tokens=completion))
        assert cost.total_cost == 0.0


# ---------------------------------------------------------------------------
# 台账：按 matrix_uid 累计
# ---------------------------------------------------------------------------
def _make_record(uid: str, cost: float, tier: str = "tier-01", station: str = "workshop"):
    return UsageRecord(
        trace_id="t",
        matrix_uid=uid,
        station_id=station,
        tier_id=tier,
        contract_tier="flash",
        model="m",
        provider="p",
        task_type="intent_parse",
        prompt_tokens=100,
        completion_tokens=50,
        cost=cost,
        cache_hit=False,
        cache_kind=None,
        degraded=False,
        degrade_level=0,
    )


def test_ledger_accumulates_per_user():
    ledger = CostLedger()
    ledger.record(_make_record("u_a", 0.01))
    ledger.record(_make_record("u_a", 0.02))
    ledger.record(_make_record("u_b", 0.05))

    now = datetime.now(timezone.utc)
    day = day_key(now, "Asia/Shanghai")
    assert ledger.user_daily_cost("u_a", day) == pytest.approx(0.03)
    assert ledger.user_daily_cost("u_b", day) == pytest.approx(0.05)
    assert ledger.user_daily_cost("u_c", day) == 0.0
    assert ledger.global_daily_cost(day) == pytest.approx(0.08)


def test_ledger_separates_stations_in_records():
    """架构 §8 要求按 matrix_uid × station_id × model_tier 记账。

    累计口径按用户，但每条记录保留 station_id 与 tier 供下钻。
    """
    ledger = CostLedger()
    ledger.record(_make_record("u_a", 0.01, station="curvelab"))
    ledger.record(_make_record("u_a", 0.02, station="mentor"))
    records = ledger.user_records("u_a")
    stations = {r.station_id for r in records}
    assert stations == {"curvelab", "mentor"}


def test_ledger_day_boundary_uses_configured_timezone():
    """日切必须按配置时区，否则早报高峰会被错算到两天。"""
    ledger = CostLedger(tz_name="Asia/Shanghai")
    # UTC 2026-10-20 23:30 = 北京 2026-10-21 07:30（早报时段）
    momen = datetime(2026, 10, 20, 23, 30, tzinfo=timezone.utc)
    record = _make_record("u_a", 0.02)
    record.created_at = momen
    ledger.record(record)

    assert ledger.user_daily_cost("u_a", "2026-10-21") == pytest.approx(0.02)
    assert ledger.user_daily_cost("u_a", "2026-10-20") == 0.0
    assert ledger.user_monthly_cost("u_a", "2026-10") == pytest.approx(0.02)


def test_ledger_stats_and_cache_hit_rate():
    ledger = CostLedger()
    ledger.record(_make_record("u_a", 0.01))
    hit = _make_record("u_a", 0.0)
    hit.cache_hit = True
    ledger.record(hit)
    stats = ledger.stats()
    assert stats["calls"] == 2
    assert stats["billed_calls"] == 1
    assert stats["cache_hits"] == 1
    assert stats["cache_hit_rate"] == 0.5


def test_ledger_is_thread_safe():
    """并发记账不能丢记录 —— 早报 08:00 会有大量并发。"""
    ledger = CostLedger()
    per_thread = 200

    def worker(uid: str) -> None:
        for _ in range(per_thread):
            ledger.record(_make_record(uid, 0.0001))

    threads = [threading.Thread(target=worker, args=(f"u{i}",)) for i in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    now = datetime.now(timezone.utc)
    day = day_key(now, "Asia/Shanghai")
    assert ledger.global_daily_cost(day) == pytest.approx(5 * per_thread * 0.0001)
    assert len(ledger.all_records()) == 5 * per_thread


# ---------------------------------------------------------------------------
# 熔断：单用户日上限
# ---------------------------------------------------------------------------
def test_user_daily_limit_triggers(base_config):
    ledger = CostLedger()
    guard = BudgetGuard(base_config, ledger)
    uid = "mxu_capped"
    tier = base_config.tier("tier-01")

    now = datetime.now(timezone.utc)
    # 直接把当日额度顶满（避免为造临界值发几万次真实调用）
    ledger.seed_cost(matrix_uid=uid, cost=base_config.budget.user_daily_cost_limit)

    with pytest.raises(BudgetExceededError) as excinfo:
        guard.check(uid, tier, prompt_tokens=100, max_tokens=100)

    err = excinfo.value
    assert err.status_code == 402
    assert err.code == "budget_exceeded"
    assert err.details["scope"] == "user_daily"
    assert err.details["limit"] == base_config.budget.user_daily_cost_limit


def test_user_monthly_limit_triggers(base_config):
    ledger = CostLedger()
    guard = BudgetGuard(base_config, ledger)
    uid = "mxu_month"
    # 只堆月额度，不堆日额度：否则会先被日额度闸拦住，测不到月额度分支
    ledger.seed_cost(
        matrix_uid=uid,
        cost=base_config.budget.user_monthly_cost_limit,
        daily=False,
    )

    with pytest.raises(BudgetExceededError) as excinfo:
        guard.check(uid, base_config.tier("tier-01"), 100, 100)
    assert excinfo.value.details["scope"] == "user_monthly"


def test_global_daily_limit_triggers(base_config):
    ledger = CostLedger()
    guard = BudgetGuard(base_config, ledger)
    ledger.seed_cost(
        matrix_uid="someone", cost=base_config.budget.global_daily_cost_limit
    )

    with pytest.raises(BudgetExceededError) as excinfo:
        guard.check("u", base_config.tier("tier-01"), 100, 100)
    assert excinfo.value.details["scope"] == "global_daily"


def test_global_monthly_limit_triggers(base_config):
    ledger = CostLedger()
    guard = BudgetGuard(base_config, ledger)
    ledger.seed_cost(
        matrix_uid="someone",
        cost=base_config.budget.global_monthly_cost_limit,
        daily=False,
    )

    with pytest.raises(BudgetExceededError) as excinfo:
        guard.check("u", base_config.tier("tier-01"), 100, 100)
    assert excinfo.value.details["scope"] == "global_monthly"


# ---------------------------------------------------------------------------
# 熔断：单请求预估（调用前拦截）
# ---------------------------------------------------------------------------
def test_projection_blocks_expensive_request_before_calling(base_config):
    """一次昂贵的 Pro 调用如果会撑破日额度，必须在调用前就拦住。

    如果只做事后记账，这次调用已经花出去了 —— 熔断就失去意义。
    """
    ledger = CostLedger()
    guard = BudgetGuard(base_config, ledger)
    uid = "mxu_pro"
    tier = base_config.tier("tier-03")  # ¥2.00/M

    # 128k 输入 + 8k 输出 ≈ 0.272 元，远超 user_daily 0.05
    with pytest.raises(BudgetExceededError) as excinfo:
        guard.check(uid, tier, prompt_tokens=128_000, max_tokens=8_000)

    err = excinfo.value
    assert err.details["scope"] == "user_daily_projection"
    assert err.details["projected_cost"] > base_config.budget.user_daily_cost_limit
    assert err.details["tier"] == "tier-03"


def test_projection_is_based_on_max_tokens_worst_case(base_config):
    """默认 worst_case 口径：按 max_tokens 全额估算，宁可拦早不拦晚。"""
    guard = BudgetGuard(base_config, CostLedger())
    tier = base_config.tier("tier-03")
    assert base_config.budget.precheck_mode == "worst_case"

    cost_small = guard.project_cost(tier, prompt_tokens=1000, max_tokens=100)
    cost_large = guard.project_cost(tier, prompt_tokens=1000, max_tokens=10_000)
    assert cost_large > cost_small


def test_cheap_request_passes_under_limit(base_config):
    guard = BudgetGuard(base_config, CostLedger())
    snapshot = guard.check(
        "mxu_ok", base_config.tier("tier-01"), prompt_tokens=200, max_tokens=200
    )
    assert snapshot.user_daily_used == 0.0


# ---------------------------------------------------------------------------
# 端到端：经 gateway 的熔断
# ---------------------------------------------------------------------------
def test_gateway_raises_on_budget_exceeded(base_config):
    """熔断必须抛明确错误，不是静默降级到便宜模型。"""
    from copilot_router.gateway import CopilotGateway
    from copilot_router.providers import MockProvider

    ledger = CostLedger()
    provider = MockProvider("deepseek", "cloud")
    gw = CopilotGateway(
        base_config, ledger=ledger, providers={"deepseek": provider}
    )

    # 把用户额度直接顶满
    ledger.seed_cost(
        matrix_uid="mxu_broke", cost=base_config.budget.user_daily_cost_limit
    )

    with pytest.raises(BudgetExceededError):
        gw.chat(chat_request("帮我解析一下这句话的意图", uid="mxu_broke"))

    # 关键：被熔断的请求一次上游调用都没发生
    assert len(provider.calls) == 0


def test_gateway_does_not_charge_when_budget_blocks(base_config):
    from copilot_router.gateway import CopilotGateway
    from copilot_router.providers import MockProvider

    ledger = CostLedger()
    gw = CopilotGateway(
        base_config, ledger=ledger, providers={"deepseek": MockProvider("deepseek", "cloud")}
    )
    ledger.seed_cost(matrix_uid="u", cost=base_config.budget.user_daily_cost_limit)

    with pytest.raises(BudgetExceededError):
        gw.chat(chat_request("帮我解析一下这句话的意图", uid="u"))

    day = day_key(datetime.now(timezone.utc), base_config.billing.timezone)
    assert ledger.user_daily_cost("u", day) == pytest.approx(
        base_config.budget.user_daily_cost_limit
    ), "被拦截的请求不应再计费"


def test_upstream_cost_is_recorded_with_correct_tier(base_config):
    from copilot_router.gateway import CopilotGateway
    from copilot_router.providers import MockProvider

    ledger = CostLedger()
    gw = CopilotGateway(
        base_config, ledger=ledger, providers={"deepseek": MockProvider("deepseek", "cloud")}
    )
    result = gw.chat(chat_request("帮我解析一下这句话的意图", uid="mxu_bill"))
    spec = base_config.tier(result.decision.tier_id)
    expected = compute_cost(spec, result.usage).total_cost
    assert result.cost.total_cost == pytest.approx(expected)

    records = ledger.user_records("mxu_bill")
    assert len(records) == 1
    assert records[0].cost == pytest.approx(expected)
    assert records[0].tier_id == result.decision.tier_id
    assert records[0].contract_tier == result.decision.contract_tier


def test_budget_guard_snapshot_ratios(base_config):
    ledger = CostLedger()
    guard = BudgetGuard(base_config, ledger)
    now = datetime.now(timezone.utc)
    half = base_config.budget.user_daily_cost_limit / 2
    ledger.seed_cost(matrix_uid="u", cost=half)

    snap = guard.snapshot("u", now=now)
    assert snap.user_daily_ratio == pytest.approx(0.5)
    assert snap.pressure >= 0.5
