"""成本熔断 —— 硬闸。

铁律（任务书第 3 条 + ADR-06 负面代价）：**超限返回明确错误，而非静默降级**。
因此本模块的所有判定要么放行，要么抛 ``BudgetExceededError``（HTTP 402），
不存在「偷偷换成便宜模型」的路径。

四道闸（按检查顺序，先便宜的检查后贵的）::

    1. 用户日上限     user_daily_cost_limit
    2. 用户月上限     user_monthly_cost_limit
    3. 全局日上限     global_daily_cost_limit
    4. 全局月上限     global_monthly_cost_limit
    5. 单请求预估     （所选档位按 max_tokens 全额估算后是否把额度撑破）

第 5 道闸是最容易被忽略但最重要的一道：如果只做事后记账，一次 Pro + 128k 输入的
调用就能把单用户日额度打穿，事后才发现已经晚了。因此**预检必须在调用前完成**，
且默认用 ``worst_case`` 口径（按 max_tokens 全额估算）。

为什么用户额度可以配得比「年均目标 / 365」高：
    ¥1.5/年 ≈ ¥0.0041/天 是**平均值目标**，靠路由准确率 + 缓存 + Pro 配额达成。
    若把日闸设成 ¥0.0041，任何一次 Pro 长文本调用（128k 输入 ≈ ¥0.26）都会被拦，
    服务等于不可用。因此日闸的作用是「防滥用」，不是「压平均」。
    这两个数字在配置注释里已显式说明，避免被误解为口径矛盾（对应 TD-15）。
"""

from __future__ import annotations

from dataclasses import dataclass

from .billing import CostLedger, day_key, month_key, utcnow
from .config import BudgetSpec, RouterConfig, TierSpec
from .errors import BudgetExceededError


@dataclass(frozen=True, slots=True)
class BudgetSnapshot:
    """某一时刻的额度使用快照（供 /v1/usage 与降级判定复用）。"""

    user_daily_used: float
    user_monthly_used: float
    global_daily_used: float
    global_monthly_used: float
    user_daily_limit: float
    user_monthly_limit: float
    global_daily_limit: float
    global_monthly_limit: float

    @property
    def user_daily_ratio(self) -> float:
        return self.user_daily_used / self.user_daily_limit if self.user_daily_limit else 0.0

    @property
    def user_monthly_ratio(self) -> float:
        return self.user_monthly_used / self.user_monthly_limit if self.user_monthly_limit else 0.0

    @property
    def global_daily_ratio(self) -> float:
        return self.global_daily_used / self.global_daily_limit if self.global_daily_limit else 0.0

    @property
    def global_monthly_ratio(self) -> float:
        return (
            self.global_monthly_used / self.global_monthly_limit
            if self.global_monthly_limit
            else 0.0
        )

    @property
    def pressure(self) -> float:
        """额度压力（0–1+），取四个比率的最大值。降级档位按它判定。"""
        return max(
            self.user_daily_ratio,
            self.user_monthly_ratio,
            self.global_daily_ratio,
            self.global_monthly_ratio,
        )


class BudgetGuard:
    """成本熔断器。"""

    def __init__(self, config: RouterConfig, ledger: CostLedger) -> None:
        self._config = config
        self._budget: BudgetSpec = config.budget
        self._ledger = ledger
        self._tz = config.billing.timezone

    # -- 快照 -------------------------------------------------------------
    def snapshot(self, matrix_uid: str, *, now=None) -> BudgetSnapshot:  # type: ignore[no-untyped-def]
        moment = now or utcnow()
        day = day_key(moment, self._tz)
        month = month_key(moment, self._tz)
        b = self._budget
        return BudgetSnapshot(
            user_daily_used=self._ledger.user_daily_cost(matrix_uid, day),
            user_monthly_used=self._ledger.user_monthly_cost(matrix_uid, month),
            global_daily_used=self._ledger.global_daily_cost(day),
            global_monthly_used=self._ledger.global_monthly_cost(month),
            user_daily_limit=b.user_daily_cost_limit,
            user_monthly_limit=b.user_monthly_cost_limit,
            global_daily_limit=b.global_daily_cost_limit,
            global_monthly_limit=b.global_monthly_cost_limit,
        )

    # -- 预检 -------------------------------------------------------------
    def check(
        self,
        matrix_uid: str,
        tier: TierSpec,
        prompt_tokens: int,
        max_tokens: int,
        *,
        now=None,  # type: ignore[no-untyped-def]
    ) -> BudgetSnapshot:
        """调用前预检。超限抛 ``BudgetExceededError``（402）。

        返回快照，便于调用方（gateway）在同一请求内复用而不必二次查台账。
        """
        snap = self.snapshot(matrix_uid, now=now)

        # ---- 闸 1/2：用户额度 --------------------------------------------
        if snap.user_daily_used >= snap.user_daily_limit:
            raise BudgetExceededError(
                "已超出当前用户今日模型调用成本上限，请明天再试或联系管理员提额",
                details={
                    "scope": "user_daily",
                    "matrix_uid": matrix_uid,
                    "used": round(snap.user_daily_used, 6),
                    "limit": snap.user_daily_limit,
                    "currency": self._config.currency,
                },
            )
        if snap.user_monthly_used >= snap.user_monthly_limit:
            raise BudgetExceededError(
                "已超出当前用户本月模型调用成本上限",
                details={
                    "scope": "user_monthly",
                    "matrix_uid": matrix_uid,
                    "used": round(snap.user_monthly_used, 6),
                    "limit": snap.user_monthly_limit,
                    "currency": self._config.currency,
                },
            )

        # ---- 闸 3/4：全局预算 --------------------------------------------
        if snap.global_daily_used >= snap.global_daily_limit:
            raise BudgetExceededError(
                "平台今日模型调用预算已用尽，AI 功能暂时不可用，恢复时间以北京时间次日 00:00 为准",
                details={
                    "scope": "global_daily",
                    "used": round(snap.global_daily_used, 6),
                    "limit": snap.global_daily_limit,
                    "currency": self._config.currency,
                },
            )
        if snap.global_monthly_used >= snap.global_monthly_limit:
            raise BudgetExceededError(
                "平台本月模型调用预算已用尽",
                details={
                    "scope": "global_monthly",
                    "used": round(snap.global_monthly_used, 6),
                    "limit": snap.global_monthly_limit,
                    "currency": self._config.currency,
                },
            )

        # ---- 闸 5：单请求预估 --------------------------------------------
        projected = self.project_cost(tier, prompt_tokens, max_tokens)
        if snap.user_daily_used + projected > snap.user_daily_limit:
            raise BudgetExceededError(
                "本次请求预估成本将超出今日剩余额度，请缩短输入或改用更低档位",
                details={
                    "scope": "user_daily_projection",
                    "matrix_uid": matrix_uid,
                    "used": round(snap.user_daily_used, 6),
                    "projected_cost": round(projected, 6),
                    "limit": snap.user_daily_limit,
                    "tier": tier.tier_id,
                    "prompt_tokens": prompt_tokens,
                    "max_tokens": max_tokens,
                    "currency": self._config.currency,
                },
            )
        if snap.global_daily_used + projected > snap.global_daily_limit:
            raise BudgetExceededError(
                "本次请求预估成本将超出平台今日剩余预算",
                details={
                    "scope": "global_daily_projection",
                    "used": round(snap.global_daily_used, 6),
                    "projected_cost": round(projected, 6),
                    "limit": snap.global_daily_limit,
                    "tier": tier.tier_id,
                    "currency": self._config.currency,
                },
            )
        return snap

    # -- 预估 -------------------------------------------------------------
    def project_cost(self, tier: TierSpec, prompt_tokens: int, max_tokens: int) -> float:
        """调用前成本预估（口径由 ``budget.precheck_mode`` 决定）。"""
        b = self._budget
        if b.precheck_mode == "worst_case":
            completion = max_tokens
        else:
            completion = min(max_tokens, b.expected_output_tokens)
        raw = (
            prompt_tokens / 1_000_000 * tier.price_input_per_million
            + completion / 1_000_000 * tier.price_output_per_million
        )
        return raw * b.precheck_safety_factor

    # -- 剩余额度 ---------------------------------------------------------
    def remaining(
        self, matrix_uid: str, *, now=None  # type: ignore[no-untyped-def]
    ) -> dict[str, float]:
        snap = self.snapshot(matrix_uid, now=now)
        return {
            "user_daily_remaining": round(snap.user_daily_limit - snap.user_daily_used, 6),
            "user_monthly_remaining": round(snap.user_monthly_limit - snap.user_monthly_used, 6),
            "global_daily_remaining": round(snap.global_daily_limit - snap.global_daily_used, 6),
            "global_monthly_remaining": round(
                snap.global_monthly_limit - snap.global_monthly_used, 6
            ),
        }
