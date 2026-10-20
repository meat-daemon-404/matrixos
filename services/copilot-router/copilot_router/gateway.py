"""网关编排 —— 一次请求走完所有环节。

执行顺序（这个顺序本身就是成本与合规的设计）::

    1. 敏感识别          ← 必须先于一切，红线要最早拦
    2. 路由决策          ← 三维：任务类型 / 输入长度 / 敏感度
    3. 预算快照 + 降级判定
    4. 降级 ③ 检查       ← 长文本需主动触发则直接拒绝（省下的是最大一笔钱）
    5. 降级 ② 改判档位
    6. 缓存查找          ← 命中即免上游调用，成本趋近 0
    7. 预算预检（硬闸）  ← 缓存未命中才真正要花钱，此时才校验预算
    8. single-flight 合并 + 上游调用
    9. 记账 + 缓存写入
   10. 组装响应（含 x_matrix 扩展）

为什么「预算预检」放在「缓存查找」之后：
    缓存命中不产生上游成本，没必要因为额度紧张而拒绝一个免费请求 ——
    这在额度临界点上是重要的体验差异（也符合「提高缓存命中」作为降级 ① 的方向）。

为什么敏感识别放在最前面：
    如果先走预算逻辑，一个超额的敏感请求会拿到 402，用户会以为是额度问题，
    实际上真正的问题是「这段数据不能上云」。先判合规，错误语义才准确。

计费口径（重要）：
    只有**真实打到上游**的调用计费（``cost > 0``）。
    缓存命中与 single-flight 跟随者记 ``cost = 0``，但仍留一条记录 ——
    因为「省了多少钱」必须可核算，否则无法判断缓存是否真的有效（R-T05 要求可验证）。
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from .billing import CostLedger, UsageRecord, compute_cost, utcnow
from .budget import BudgetGuard
from .cache import SimilarityCache, exact_key, extract_public_identifiers, normalize_text
from .config import RouterConfig, TierSpec
from .degradation import DegradationPolicy
from .errors import (
    ComplianceEgressError,
    InvalidRequestError,
    LongTextManualTriggerRequiredError,
    NoProviderAvailableError,
)
from .providers import CircuitBreaker, Provider, ProviderPool, build_providers
from .routing import Router
from .sensitivity import SensitivityScanner
from .tokens import estimate_messages_tokens, estimate_text_tokens
from .types import (
    ChatRequest,
    ChatResult,
    CostBreakdown,
    DegradeDecision,
    RouteDecision,
    SensitivityResult,
    TokenUsage,
)


# ---------------------------------------------------------------------------
# 缓存单元
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class CachedCompletion:
    """缓存里存的响应单元。

    只存「内容 + 计量 + 出处」，不存完整请求上下文 ——
    避免把 A 请求的 metadata 泄漏给命中它的 B 请求。
    """

    content: str
    prompt_tokens: int
    completion_tokens: int
    provider: str
    model: str
    tier_id: str
    usage_from_upstream: bool = True


@dataclass(slots=True)
class _CacheContext:
    key: str
    normalized: str
    public_ids: frozenset[str]
    scope: str
    owner: str | None
    cacheable: bool
    ttl_seconds: float
    similarity_threshold: float | None
    tier_id: str
    model: str
    task_type: str


# ---------------------------------------------------------------------------
# 网关
# ---------------------------------------------------------------------------
class CopilotGateway:
    """四级路由网关（纯领域逻辑，不依赖 FastAPI，可独立单测）。"""

    def __init__(
        self,
        config: RouterConfig,
        *,
        ledger: CostLedger | None = None,
        providers: dict[str, Provider] | None = None,
        cache: SimilarityCache[CachedCompletion] | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.config = config
        self.ledger = ledger or CostLedger(tz_name=config.billing.timezone)
        self.router = Router(config)
        self.scanner = SensitivityScanner(config.sensitivity)
        self.budget = BudgetGuard(config, self.ledger)
        self.degradation = DegradationPolicy(config)
        self._clock = clock or time.monotonic

        if providers is None:
            provider_map = build_providers(
                config.providers, include_mock=_mock_allowed()
            )
        else:
            provider_map = providers
        self.pool = ProviderPool(
            provider_map,
            config.failover,
            CircuitBreaker(config.failover, clock=self._clock),
        )

        if cache is not None:
            self.cache: SimilarityCache[CachedCompletion] | None = cache
        elif config.cache.enabled:
            self.cache = SimilarityCache(config.cache, clock=self._clock)
        else:
            self.cache = None

    # ==================================================================
    # 主入口
    # ==================================================================
    def chat(self, request: ChatRequest) -> ChatResult:
        started = time.perf_counter()
        trace_id = request.trace_id or uuid.uuid4().hex
        uid = request.matrix.matrix_uid or "anonymous"
        now = utcnow()

        if not request.messages:
            raise InvalidRequestError("messages 不能为空")

        # ---- 1. 敏感识别（最早，红线优先）-------------------------------
        sensitivity = self.scanner.scan(request.prompt_text())
        sensitivity = self.scanner.merge_client_declaration(
            sensitivity, request.matrix.sensitivity
        )

        # ---- 2. 路由决策 -----------------------------------------------
        prompt_tokens = estimate_messages_tokens(
            [(m.role, m.content) for m in request.messages]
        )
        decision = self.router.decide(
            request, prompt_tokens=prompt_tokens, sensitivity=sensitivity
        )

        # ---- 3. 预算快照 + 降级判定 ------------------------------------
        snapshot = self.budget.snapshot(uid, now=now)
        degrade = self.degradation.decide(request, decision, snapshot)

        # ---- 4. 降级 ③：长文本需用户主动触发 ---------------------------
        if degrade.require_manual_trigger:
            raise LongTextManualTriggerRequiredError(
                "平台预算紧张，长文本任务已改为用户主动触发。"
                "请确认后以 matrix.user_triggered=true 重新提交。",
                details={
                    "degrade_level": degrade.level,
                    "task_type": decision.task_type,
                    "prompt_tokens": decision.prompt_tokens,
                    "hint": '在请求体 matrix 对象中设置 {"user_triggered": true}',
                },
            )

        # ---- 5. 降级 ②：改判档位 ---------------------------------------
        if degrade.reroute_to is not None:
            decision = self._reroute(decision, degrade.reroute_to)

        tier_spec = self.config.tier(decision.tier_id)
        max_tokens = self._resolve_max_tokens(request, tier_spec)

        # 本地可用性预检：合规红线下本地不可用 → 451，绝不降级上云
        self._assert_tier_servable(tier_spec, decision, sensitivity)

        # ---- 6. 缓存查找 -----------------------------------------------
        ctx = self._cache_context(uid, request, decision, tier_spec, sensitivity, degrade)
        cached = self._lookup_cache(ctx)
        if cached is not None:
            return self._from_cache(
                cached, decision, trace_id, uid, request, sensitivity, degrade, started, now
            )

        # ---- 7. 预算预检（硬闸，只在真要花钱时校验）----------------------
        self.budget.check(uid, tier_spec, prompt_tokens, max_tokens, now=now)

        # ---- 8/9. 上游调用（含 single-flight 合并）+ 记账 ---------------
        return self._invoke(
            request=request,
            decision=decision,
            tier_spec=tier_spec,
            max_tokens=max_tokens,
            prompt_tokens=prompt_tokens,
            uid=uid,
            trace_id=trace_id,
            sensitivity=sensitivity,
            degrade=degrade,
            ctx=ctx,
            started=started,
        )

    # ==================================================================
    # 档位可用性
    # ==================================================================
    def _assert_tier_servable(
        self,
        tier_spec: TierSpec,
        decision: RouteDecision,
        sensitivity: SensitivityResult,
    ) -> None:
        if self.pool.available(tier_spec.providers):
            return
        if decision.forced_local_by_sensitivity:
            # 红线：宁可失败也不上云（ADR-05 / R-R02 兜底策略）
            raise ComplianceEgressError(
                "该请求含敏感数据，必须由 TIER 04 本地模型处理，但本地模型当前不可用。"
                "为避免数据外泄，请求已拒绝（不会降级到云端模型）。",
                details={
                    "tier": tier_spec.tier_id,
                    "providers": list(tier_spec.providers),
                    "matched_rules": sensitivity.matched_rule_ids,
                    "hint": "请检查 QWEN_LOCAL_ENDPOINT 是否配置、本地 LoRA 服务是否存活",
                },
            )
        raise NoProviderAvailableError(
            "该档位下没有可用的模型 Provider",
            details={
                "tier": tier_spec.tier_id,
                "providers": list(tier_spec.providers),
                "hint": "请检查 Provider 的 base_url / API Key 环境变量是否配置",
            },
        )

    # ==================================================================
    # 缓存上下文
    # ==================================================================
    def _cache_context(
        self,
        uid: str,
        request: ChatRequest,
        decision: RouteDecision,
        tier_spec: TierSpec,
        sensitivity: SensitivityResult,
        degrade: DegradeDecision,
    ) -> _CacheContext:
        cfg = self.config.cache

        # 降级 ① 的放宽参数（只放宽边界，不放宽合规边界）
        relax_threshold: float | None = None
        ttl_mult = 1.0
        shareable_types = set(cfg.cross_user_shareable_task_types)
        if degrade.level >= 1 and self.config.degradation.enabled:
            l1 = self.config.degradation.level_1
            relax_threshold = max(
                0.80, cfg.similarity_threshold - l1.similarity_threshold_relax
            )
            ttl_mult = l1.cache_ttl_multiplier
            shareable_types |= set(l1.extra_shareable_task_types)

        normalized = self._normalized_prompt(request)
        public_ids = extract_public_identifiers(request.prompt_text())

        # 缓存可行性：多个条件必须同时成立
        cacheable = bool(
            self.cache is not None
            and cfg.enabled
            # 高温采样结果不可复现，缓存等于伪造确定性
            and request.temperature <= cfg.max_temperature_for_cache
            # 敏感数据永不进缓存（同一用户也不回放）
            and sensitivity.cache_shareable
            and sensitivity.verdict == "clean"
        )

        # 跨用户共享域：白名单任务 + 含公共标识 + 用户未禁止
        cross_user = bool(
            cacheable
            and decision.task_type in shareable_types
            and public_ids
            and request.matrix.allow_cross_user_cache
        )
        scope = "shared" if cross_user else "user"
        owner = None if cross_user else uid

        key = exact_key(
            matrix_uid=owner,
            tier_id=decision.tier_id,
            model=tier_spec.model,
            normalized=normalized,
            scope=scope,
        )

        return _CacheContext(
            key=key,
            normalized=normalized,
            public_ids=public_ids,
            scope=scope,
            owner=owner,
            cacheable=cacheable,
            ttl_seconds=cfg.exact_ttl_seconds * ttl_mult,
            similarity_threshold=relax_threshold,
            tier_id=decision.tier_id,
            model=tier_spec.model,
            task_type=decision.task_type,
        )

    def _lookup_cache(self, ctx: _CacheContext) -> CachedCompletion | None:
        if self.cache is None or not ctx.cacheable:
            return None
        found = self.cache.lookup(
            key=ctx.key,
            normalized=ctx.normalized,
            public_ids=ctx.public_ids,
            tier_id=ctx.tier_id,
            model=ctx.model,
            task_type=ctx.task_type,
            owner=ctx.owner,
            scope=ctx.scope,
            similarity_threshold=ctx.similarity_threshold,
        )
        return found.value if found.hit else None

    # ==================================================================
    # 上游调用
    # ==================================================================
    def _invoke(
        self,
        *,
        request: ChatRequest,
        decision: RouteDecision,
        tier_spec: TierSpec,
        max_tokens: int,
        prompt_tokens: int,
        uid: str,
        trace_id: str,
        sensitivity: SensitivityResult,
        degrade: DegradeDecision,
        ctx: _CacheContext,
        started: float,
    ) -> ChatResult:
        blocked = sensitivity.verdict == "blocked"

        def compute() -> CachedCompletion:
            completion = self.pool.complete_with_failover(
                tier_spec.providers,
                request.messages,
                model=tier_spec.model,
                max_tokens=max_tokens,
                temperature=request.temperature,
                blocked_sensitivity=blocked,
            )
            usage = completion.usage
            from_upstream = completion.usage_from_upstream
            if not from_upstream or usage.prompt_tokens <= 0:
                # 上游未返回 usage：用估算兜底（响应里会标 tokens_estimated=true）
                usage = TokenUsage(
                    prompt_tokens=prompt_tokens,
                    completion_tokens=usage.completion_tokens
                    or max(1, estimate_text_tokens(completion.content)),
                )
                from_upstream = False
            return CachedCompletion(
                content=completion.content,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                provider=completion.provider,
                model=completion.model,
                tier_id=tier_spec.tier_id,
                usage_from_upstream=from_upstream,
            )

        coalesced = False
        if self.cache is not None and ctx.cacheable:
            value, coalesced = self.cache.get_or_compute(key=ctx.key, compute=compute)
        else:
            value = compute()

        usage = TokenUsage(
            prompt_tokens=value.prompt_tokens, completion_tokens=value.completion_tokens
        )
        cost = compute_cost(tier_spec, usage)

        if not coalesced:
            # 真实上游调用：计费
            self._record(
                trace_id=trace_id,
                uid=uid,
                request=request,
                decision=decision,
                provider=value.provider,
                usage=usage,
                cost=cost.total_cost,
                cache_hit=False,
                cache_kind=None,
                degrade=degrade,
            )
            if self.cache is not None and ctx.cacheable:
                self.cache.store(
                    key=ctx.key,
                    normalized=ctx.normalized,
                    public_ids=ctx.public_ids,
                    tier_id=ctx.tier_id,
                    model=ctx.model,
                    task_type=ctx.task_type,
                    owner=ctx.owner,
                    scope=ctx.scope,
                    value=value,
                    ttl_seconds=ctx.ttl_seconds,
                )

        return ChatResult(
            content=value.content,
            decision=decision,
            usage=usage,
            cost=cost,
            provider=value.provider,
            cache_hit=coalesced,
            cache_kind="coalesced" if coalesced else None,
            coalesced=coalesced,
            degrade=degrade,
            sensitivity=sensitivity,
            trace_id=trace_id,
            latency_ms=round((time.perf_counter() - started) * 1000, 2),
            tokens_estimated=not value.usage_from_upstream,
        )

    # ==================================================================
    # 缓存命中路径
    # ==================================================================
    def _from_cache(
        self,
        cached: CachedCompletion,
        decision: RouteDecision,
        trace_id: str,
        uid: str,
        request: ChatRequest,
        sensitivity: SensitivityResult,
        degrade: DegradeDecision,
        started: float,
        now: Any,
    ) -> ChatResult:
        tier_spec = self.config.tier(decision.tier_id)
        usage = TokenUsage(
            prompt_tokens=cached.prompt_tokens, completion_tokens=cached.completion_tokens
        )
        # 缓存命中不产生上游成本：cost 记 0，但保留 token 与虚拟单价，
        # 使 /v1/usage 能算出「缓存节省额」（R-T05 要求可验证降本效果）
        pricing = compute_cost(tier_spec, usage)
        cost = CostBreakdown(
            tier_id=pricing.tier_id,
            model=pricing.model,
            price_input_per_million=pricing.price_input_per_million,
            price_output_per_million=pricing.price_output_per_million,
            prompt_tokens=pricing.prompt_tokens,
            completion_tokens=pricing.completion_tokens,
            input_cost=0.0,
            output_cost=0.0,
        )
        self._record(
            trace_id=trace_id,
            uid=uid,
            request=request,
            decision=decision,
            provider=cached.provider,
            usage=usage,
            cost=0.0,
            cache_hit=True,
            cache_kind="hit",
            degrade=degrade,
        )
        return ChatResult(
            content=cached.content,
            decision=decision,
            usage=usage,
            cost=cost,
            provider=cached.provider,
            cache_hit=True,
            cache_kind="hit",
            coalesced=False,
            degrade=degrade,
            sensitivity=sensitivity,
            trace_id=trace_id,
            latency_ms=round((time.perf_counter() - started) * 1000, 2),
            tokens_estimated=not cached.usage_from_upstream,
        )

    # ==================================================================
    # 工具方法
    # ==================================================================
    def _normalized_prompt(self, request: ChatRequest) -> str:
        """归一化输入：以最后一条 user 消息为主，附 system 前缀。

        只取最后一条 user 消息是刻意的：多轮对话的历史会持续变化，
        若把全部历史纳入归一化键，缓存永远命不中。
        """
        system_parts = [m.content for m in request.messages if m.role == "system"]
        user_parts = [m.content for m in request.messages if m.role == "user"]
        core = (user_parts[-1] if user_parts else "") + "\n" + "\n".join(system_parts)
        return normalize_text(core)

    def _resolve_max_tokens(self, request: ChatRequest, tier_spec: TierSpec) -> int:
        requested = request.max_tokens or tier_spec.default_max_tokens
        if requested <= 0:
            raise InvalidRequestError(
                "max_tokens 必须为正整数", details={"max_tokens": request.max_tokens}
            )
        if requested > tier_spec.context_limit:
            raise InvalidRequestError(
                f"max_tokens={requested} 超出 {tier_spec.tier_id} 的 "
                f"context_limit={tier_spec.context_limit}",
                details={
                    "tier": tier_spec.tier_id,
                    "context_limit": tier_spec.context_limit,
                    "max_tokens": requested,
                },
            )
        return requested

    def _reroute(self, decision: RouteDecision, tier_id: str) -> RouteDecision:
        spec = self.config.tier(tier_id)
        return RouteDecision(
            tier_id=spec.tier_id,  # type: ignore[arg-type]
            contract_tier=spec.contract_tier,  # type: ignore[arg-type]
            model=spec.model,
            task_type=decision.task_type,
            decided_by="degradation",
            prompt_tokens=decision.prompt_tokens,
            length_bucket=decision.length_bucket,
            reason=f"降级改判：{decision.tier_id} → {tier_id}（R-T05 策略②）",
            forced_local_by_sensitivity=False,
        )

    def _record(
        self,
        *,
        trace_id: str,
        uid: str,
        request: ChatRequest,
        decision: RouteDecision,
        provider: str,
        usage: TokenUsage,
        cost: float,
        cache_hit: bool,
        cache_kind: str | None,
        degrade: DegradeDecision,
    ) -> None:
        record = UsageRecord(
            trace_id=trace_id,
            matrix_uid=uid,
            station_id=request.matrix.station_id,
            tier_id=decision.tier_id,
            contract_tier=decision.contract_tier,
            model=decision.model,
            provider=provider,
            task_type=decision.task_type,
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
            cost=cost,
            cache_hit=cache_hit,
            cache_kind=cache_kind,
            degraded=degrade.degraded,
            degrade_level=degrade.level,
        )
        self.ledger.record(
            record, count_as_pro=(decision.tier_id == "tier-03" and cost > 0)
        )


def _mock_allowed() -> bool:
    """Mock Provider 只在显式开启时可用。

    默认关闭：生产环境若静默返回假数据，比直接报错危险得多。
    """
    return os.environ.get("COPILOT_ENABLE_MOCK_PROVIDER", "0") == "1"
