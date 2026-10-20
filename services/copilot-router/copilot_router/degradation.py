"""降级策略 —— 严格按 ``05-risks.md`` R-T05 的优先级①②③依次启用。

R-T05 原文（docs/01-plan/05-risks.md L123）：:

    若实测超标，按优先级依次启用：
    ① 提高缓存命中（相似请求合并）；
    ② 给 Pro 设每日配额；
    ③ 长文本任务改为「用户主动触发」而非自动。

本模块只做**决策**，不做执行 —— 执行分散在 cache（阈值放宽）、
gateway（档位改判）、api（拒绝并说明如何主动触发）。

与「熔断」的区别（这个区别是本服务最重要的设计约束之一）：

===========  ==========================  ================================
            熔断（budget.py）            降级（本模块）
===========  ==========================  ================================
性质         硬闸：超限即失败             软闸：换更省的路径但成功返回
行为         抛 402                       返回结果 + 显式标注
可见性       错误信息                   ``x_matrix.degraded`` / ``notice``
文档依据     ADR-06 成本熔断              R-T05 缓解措施
===========  ==========================  ================================

ADR-06 的负面代价里明确写了「降级会伤害体验……必须让用户可见
（『已切换至经济模式』），而非静默降级」。因此 ``DegradeDecision.notices``
必须原样透传到响应体与响应头，不允许被吞掉。

触发条件用「额度压力」（4 个比率的最大值），同时看用户与全局：
- 只看用户：全局预算耗尽时仍会继续烧钱；
- 只看全局：重度用户会把平台预算吃光，但自己不被限制。
两者取最大值，谁先紧就按谁降级。
"""

from __future__ import annotations

from dataclasses import dataclass

from .budget import BudgetSnapshot
from .config import RouterConfig
from .types import ChatRequest, DegradeDecision, RouteDecision


@dataclass(frozen=True, slots=True)
class DegradationContext:
    """一次请求的降级执行参数（由 gateway 消费）。"""

    level: int
    cache_ttl_multiplier: float
    similarity_threshold: float | None
    shareable_task_types: frozenset[str]
    require_manual_trigger: bool
    notice_list: tuple[str, ...]


class DegradationPolicy:
    """R-T05 三级降级策略。

    累进语义（重要）：压力达到 level_2 时，level_1 的措施**依然生效**。
    R-T05 的措辞是「依次启用」，不是「逐级替换」。因此 level 是「已启用到第几级」。
    """

    def __init__(self, config: RouterConfig) -> None:
        self._config = config
        self._spec = config.degradation

    # -- 档位判定 ---------------------------------------------------------
    def level_for(self, snapshot: BudgetSnapshot) -> int:
        if not self._spec.enabled:
            return 0
        pressure = snapshot.pressure
        r1, r2, r3 = self._spec.trigger_ratios
        if pressure >= r3:
            return 3
        if pressure >= r2:
            return 2
        if pressure >= r1:
            return 1
        return 0

    # -- 执行参数 ---------------------------------------------------------
    def context(
        self,
        snapshot: BudgetSnapshot,
        task_type: str,
    ) -> DegradationContext:
        level = self.level_for(snapshot)
        notices: list[str] = []
        threshold: float | None = None
        ttl_mult = 1.0
        shareable = set(self._config.cache.cross_user_shareable_task_types)

        if level >= 1:
            l1 = self._spec.level_1
            ttl_mult = l1.cache_ttl_multiplier
            threshold = max(
                0.80, self._config.cache.similarity_threshold - l1.similarity_threshold_relax
            )
            shareable |= l1.extra_shareable_task_types
            notices.append(
                "经济模式①：已提高结果缓存命中率（相似请求复用），响应可能来自缓存"
            )

        if level >= 2:
            notices.append(
                f"经济模式②：Pro 档每日配额已用罄（每日 {self._spec.level_2.pro_daily_calls} 次），"
                f"本次请求已改判到 {self._spec.level_2.downgrade_to}"
            )

        if level >= 3:
            notices.append(
                "经济模式③：长文本任务已改为用户主动触发，自动触发已停用"
            )

        return DegradationContext(
            level=level,
            cache_ttl_multiplier=ttl_mult,
            similarity_threshold=threshold,
            shareable_task_types=frozenset(shareable),
            require_manual_trigger=level >= 3 and self._spec.level_3.long_text_auto_disabled,
            notice_list=tuple(notices),
        )

    # -- 主入口：产出可透传给用户的决策 ------------------------------------
    def decide(
        self,
        request: ChatRequest,
        route: RouteDecision,
        snapshot: BudgetSnapshot,
    ) -> DegradeDecision:
        ctx = self.context(snapshot, route.task_type)
        decision = DegradeDecision(
            level=ctx.level,
            notices=list(ctx.notice_list),
            reroute_to=None,
            require_manual_trigger=False,
        )

        # ---- 降级 ②：Pro 每日配额 ----------------------------------------
        # 注意：被敏感数据强制本地的请求不参与 Pro 配额判定（它本来就不是 Pro）。
        if ctx.level >= 2 and route.tier_id == "tier-03" and not route.forced_local_by_sensitivity:
            decision.reroute_to = self._spec.level_2.downgrade_to
            decision.notices.append(
                f"档位已从 {route.tier_id}（Pro）降级到 {self._spec.level_2.downgrade_to}，"
                "长文本对比精度会有所下降"
            )

        # ---- 降级 ③：长文本改为用户主动触发 -------------------------------
        l3 = self._spec.level_3
        if (
            ctx.level >= 3
            and l3.long_text_auto_disabled
            and route.task_type in l3.manual_trigger_task_types
            and route.prompt_tokens >= l3.manual_trigger_min_tokens
            and not request.matrix.user_triggered
        ):
            decision.require_manual_trigger = True

        return decision
