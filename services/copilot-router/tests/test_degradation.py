"""降级策略（R-T05）测试。

R-T05 明确规定三级降级按优先级**依次启用**：

    ① 提高缓存命中（相似请求合并）
    ② 给 Pro 设每日配额
    ③ 长文本任务改为「用户主动触发」

这三条是**软闸**：换更省的路径但要成功返回，且必须让用户可见
（ADR-06 负面代价原文：「必须让用户可见，而非静默降级」）。
与熔断（硬闸、抛 402）的区别是本服务最重要的设计约束之一，
因此这里重点验证：分级阈值、累进语义、notice 不可被吞、以及
「敏感数据强制本地的请求不参与 Pro 配额判定」这条交叉规则。
"""

from __future__ import annotations

import pytest

from copilot_router.budget import BudgetSnapshot
from copilot_router.config import RouterConfig
from copilot_router.degradation import DegradationPolicy
from copilot_router.types import ChatRequest, DegradeDecision, RouteDecision


def snapshot_at(pressure: float, config: RouterConfig) -> BudgetSnapshot:
    """构造一个「额度压力恰为 pressure」的快照。

    压力是四个比率的**最大值**，所以把用户日额度顶到目标比例即可。
    """
    limit = config.budget.user_daily_cost_limit
    return BudgetSnapshot(
        user_daily_used=limit * pressure,
        user_monthly_used=0.0,
        global_daily_used=0.0,
        global_monthly_used=0.0,
        user_daily_limit=limit,
        user_monthly_limit=config.budget.user_monthly_cost_limit,
        global_daily_limit=config.budget.global_daily_cost_limit,
        global_monthly_limit=config.budget.global_monthly_cost_limit,
    )


def route(
    *,
    tier_id: str = "tier-03",
    task_type: str = "multi_paper_compare",
    prompt_tokens: int = 100,
    forced_local: bool = False,
) -> RouteDecision:
    return RouteDecision(
        tier_id=tier_id,  # type: ignore[arg-type]
        contract_tier="pro" if tier_id == "tier-03" else "flash",  # type: ignore[arg-type]
        model="deepseek-v4-pro",
        task_type=task_type,
        decided_by="heuristic",
        prompt_tokens=prompt_tokens,
        length_bucket="short",
        reason="test",
        forced_local_by_sensitivity=forced_local,
    )


def request_at(*, user_triggered: bool = False) -> ChatRequest:
    from .conftest import chat_request

    return chat_request(
        "帮我比较这两篇论文的方法差异", user_triggered=user_triggered
    )


# ---------------------------------------------------------------------------
# 分级阈值
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("pressure", "expected_level"),
    [
        (0.0, 0),    # 无压力
        (0.59, 0),   # 刚好低于 level_1(0.60)
        (0.60, 1),   # 到达 ①
        (0.84, 1),   # 仍为 ①
        (0.85, 2),   # 到达 ②
        (0.94, 2),   # 仍为 ②
        (0.95, 3),   # 到达 ③
        (1.20, 3),   # 超额也封顶在 3
    ],
)
def test_level_thresholds(base_config, pressure, expected_level):
    policy = DegradationPolicy(base_config)
    assert policy.level_for(snapshot_at(pressure, base_config)) == expected_level


def test_disabled_degradation_never_triggers(base_config):
    """degradation.enabled=false 时任何压力都不降级。"""
    from .conftest import make_config

    disabled = make_config(lambda d: d["degradation"].__setitem__("enabled", False))
    policy = DegradationPolicy(disabled)
    assert policy.level_for(snapshot_at(1.5, disabled)) == 0


# ---------------------------------------------------------------------------
# 累进语义：level 2 时 level 1 的措施依然生效
# ---------------------------------------------------------------------------
def test_levels_are_cumulative(base_config):
    policy = DegradationPolicy(base_config)
    snap3 = snapshot_at(0.99, base_config)
    ctx = policy.context(snap3, "multi_paper_compare")
    assert ctx.level == 3
    # ① 的措施仍在
    assert ctx.cache_ttl_multiplier > 1.0, "level 3 时 level 1 的 TTL 放宽应依然生效"
    assert ctx.similarity_threshold is not None, "level 3 时相似阈值放宽应依然生效"
    # ② ③ 的 notice 都在
    assert len(ctx.notice_list) == 3, f"三级 notice 应全部保留: {ctx.notice_list}"


def test_level1_only_relaxes_cache(base_config):
    policy = DegradationPolicy(base_config)
    ctx = policy.context(snapshot_at(0.70, base_config), "intent_parse")
    assert ctx.level == 1
    assert ctx.cache_ttl_multiplier == base_config.degradation.level_1.cache_ttl_multiplier
    assert ctx.similarity_threshold is not None
    assert ctx.require_manual_trigger is False
    assert len(ctx.notice_list) == 1


def test_level1_relax_respects_floor(base_config):
    """相似阈值放宽有下限，不能为了命中率无限放宽到会错命中的程度。"""
    policy = DegradationPolicy(base_config)
    ctx = policy.context(snapshot_at(0.70, base_config), "intent_parse")
    assert ctx.similarity_threshold >= 0.80, "阈值放宽后不应低于 0.80 的安全下限"


def test_no_degradation_returns_neutral_context(base_config):
    policy = DegradationPolicy(base_config)
    ctx = policy.context(snapshot_at(0.0, base_config), "intent_parse")
    assert ctx.level == 0
    assert ctx.cache_ttl_multiplier == 1.0
    assert ctx.similarity_threshold is None
    assert ctx.notice_list == ()
    assert ctx.require_manual_trigger is False


# ---------------------------------------------------------------------------
# 降级②：Pro 配额改判
# ---------------------------------------------------------------------------
def test_level2_reroutes_pro_to_cheaper_tier(base_config):
    policy = DegradationPolicy(base_config)
    decision = policy.decide(
        request_at(), route(tier_id="tier-03"), snapshot_at(0.90, base_config)
    )
    assert decision.level == 2
    assert decision.reroute_to == base_config.degradation.level_2.downgrade_to
    assert decision.degraded is True
    assert any("降级" in n for n in decision.notices), "改判必须有可见 notice"


def test_level2_does_not_reroute_non_pro_tier(base_config):
    """已经是便宜档就不需要再改判。"""
    policy = DegradationPolicy(base_config)
    decision = policy.decide(
        request_at(), route(tier_id="tier-01"), snapshot_at(0.90, base_config)
    )
    assert decision.reroute_to is None


def test_level2_does_not_reroute_sensitivity_forced_local(base_config):
    """合规红线：敏感数据强制本地的请求不参与 Pro 配额判定。

    它本来就不是 Pro——若被「降级」改写档位，可能把敏感数据推回云端。
    """
    policy = DegradationPolicy(base_config)
    decision = policy.decide(
        request_at(),
        route(tier_id="tier-03", forced_local=True),
        snapshot_at(0.90, base_config),
    )
    assert decision.reroute_to is None, "敏感强制本地的请求不得被降级改判"


def test_level1_does_not_reroute(base_config):
    policy = DegradationPolicy(base_config)
    decision = policy.decide(
        request_at(), route(tier_id="tier-03"), snapshot_at(0.70, base_config)
    )
    assert decision.reroute_to is None, "level 1 只放宽缓存，不改判档位"


# ---------------------------------------------------------------------------
# 降级③：长文本改为用户主动触发
# ---------------------------------------------------------------------------
def test_level3_requires_manual_trigger_for_long_text(base_config):
    policy = DegradationPolicy(base_config)
    l3 = base_config.degradation.level_3
    decision = policy.decide(
        request_at(user_triggered=False),
        route(task_type="multi_paper_compare", prompt_tokens=l3.manual_trigger_min_tokens + 1),
        snapshot_at(0.99, base_config),
    )
    assert decision.level == 3
    assert decision.require_manual_trigger is True
    assert decision.notices, "要求人工触发必须对用户可见"


def test_level3_user_triggered_bypasses_manual_gate(base_config):
    """用户已经主动触发过，就不该再拦。"""
    policy = DegradationPolicy(base_config)
    l3 = base_config.degradation.level_3
    decision = policy.decide(
        request_at(user_triggered=True),
        route(task_type="multi_paper_compare", prompt_tokens=l3.manual_trigger_min_tokens + 1),
        snapshot_at(0.99, base_config),
    )
    assert decision.require_manual_trigger is False


def test_level3_short_text_not_gated(base_config):
    """短文本不消耗长文本预算，不该被降级③拦住。"""
    policy = DegradationPolicy(base_config)
    decision = policy.decide(
        request_at(),
        route(task_type="multi_paper_compare", prompt_tokens=100),
        snapshot_at(0.99, base_config),
    )
    assert decision.require_manual_trigger is False


def test_level3_non_listed_task_not_gated(base_config):
    """只有 R-T05 点名的长文本任务类型才改人工触发。"""
    policy = DegradationPolicy(base_config)
    decision = policy.decide(
        request_at(),
        route(task_type="intent_parse", prompt_tokens=99999),
        snapshot_at(0.99, base_config),
    )
    assert decision.require_manual_trigger is False


def test_level2_does_not_gate_manual_trigger(base_config):
    policy = DegradationPolicy(base_config)
    l3 = base_config.degradation.level_3
    decision = policy.decide(
        request_at(),
        route(task_type="multi_paper_compare", prompt_tokens=l3.manual_trigger_min_tokens + 1),
        snapshot_at(0.90, base_config),
    )
    assert decision.level == 2
    assert decision.require_manual_trigger is False, "③ 只在 level 3 生效"


# ---------------------------------------------------------------------------
# 端到端：降级不改变「成功返回」这一契约
# ---------------------------------------------------------------------------
def test_degraded_request_still_succeeds(base_config):
    """软闸的核心契约：降级后请求依然成功，且 degrade 信息透传到结果。"""
    from copilot_router.billing import CostLedger
    from copilot_router.gateway import CopilotGateway
    from copilot_router.providers import MockProvider

    ledger = CostLedger()
    gw = CopilotGateway(
        base_config,
        ledger=ledger,
        providers={
            "deepseek": MockProvider("deepseek", "cloud"),
            "local-lora": MockProvider("local-lora", "local"),
        },
    )
    # 顶到 level 2 压力（不超过 100%，否则会被熔断抢先拦截）
    ledger.seed_cost(matrix_uid="u", cost=base_config.budget.user_daily_cost_limit * 0.90)

    from .conftest import chat_request

    result = gw.chat(chat_request("帮我解析一下这句话的意图", uid="u"))

    assert result.content, "降级后仍必须返回内容"
    assert result.degrade.degraded is True
    assert result.degrade.level >= 2
    assert result.degrade.notices, "降级 notice 必须透传到 ChatResult（不可静默）"
