"""四级路由决策。

输入：任务类型 + 输入长度 + 数据敏感度（任务书第 1 条的三维）
输出：``RouteDecision``（含 complete 可解释快照，供测试断言与审计）

决策优先级（**从高到低，前一条永远压过后一条**）::

    1. 敏感数据强制本地   ← 合规红线，不可被任何客户端提示覆盖
    2. 客户端显式指定档位 ← 仅当未被红线覆盖，且 allow_client_tier_hint
    3. 客户端显式任务类型 ← 仅当 allow_client_task_hint
    4. 启发式任务类型识别（关键词 + 正则打分）
    5. 长度敏感任务的升档（长度 ≥ pro_min_tokens 才考虑 Pro）
    6. 能力升级（原档位 context_limit 装不下 → 找能装下且最便宜的档位）
    7. 兜底：default_task_type 对应的档位

ADR-06 的负面代价里明确写了「路由判断本身要花 token」，
所以这里**完全不用 LLM 分类**，只用规则/关键词/正则初筛。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .config import RouterConfig, TaskTypeSpec
from .tokens import estimate_messages_tokens, length_bucket
from .types import ChatRequest, RouteDecision, SensitivityResult

_KEYWORD_SCORE = 1.0
_REGEX_SCORE = 1.5
_STRUCTURAL_SCORE = 2.0

_REGEX_CACHE: dict[str, re.Pattern[str]] = {}


def _compiled(pattern: str) -> re.Pattern[str]:
    cached = _REGEX_CACHE.get(pattern)
    if cached is None:
        cached = re.compile(pattern)
        _REGEX_CACHE[pattern] = cached
    return cached


@dataclass(frozen=True, slots=True)
class TaskTypeMatch:
    task_type: str
    score: float


class Router:
    """无状态路由决策器（线程安全，可被多通道共享）。"""

    def __init__(self, config: RouterConfig) -> None:
        self._config = config
        self._task_rules: list[tuple[TaskTypeSpec, list[re.Pattern[str]]]] = [
            (spec, [_compiled(p) for p in spec.regex])
            for spec in config.routing.task_types.values()
        ]

    # -- 第 4 步：启发式任务识别 -------------------------------------------
    def classify_task_type(self, text: str) -> TaskTypeMatch | None:
        """按关键词/正则/结构化标记打分，取最高分且达阈值者。"""
        lowered = text.lower()
        best: TaskTypeMatch | None = None
        for spec, patterns in self._task_rules:
            score = 0.0
            for keyword in spec.keywords:
                if keyword.lower() in lowered:
                    score += _KEYWORD_SCORE
            for pattern in patterns:
                if pattern.search(text):
                    score += _REGEX_SCORE
            for marker in spec.structural:
                if marker.lower() in lowered:
                    score += _STRUCTURAL_SCORE
            if score <= 0:
                continue
            if score < self._config.routing.min_score:
                continue
            if best is None or score > best.score:
                best = TaskTypeMatch(task_type=spec.task_type, score=score)
        return best

    # -- 第 6 步：能力升级 -------------------------------------------------
    def _escalate_for_capacity(
        self,
        prompt_tokens: int,
        current_tier: str,
    ) -> str | None:
        """原档位 context_limit 装不下时，按配置顺序找「能装下且最便宜」的档位。"""
        lc = self._config.routing.long_context
        if not lc.capability_escalation:
            return None
        current = self._config.tiers[current_tier]
        if prompt_tokens <= current.context_limit:
            return None
        candidates: list[tuple[float, int, str]] = []
        for tier_id in lc.capability_escalation_order:
            spec = self._config.tiers.get(tier_id)
            if spec is None or spec.context_limit < prompt_tokens:
                continue
            # 单价和作为排序键：便宜者优先（本地档 ¥0 天然排最前）
            price = spec.price_input_per_million + spec.price_output_per_million
            candidates.append((price, -spec.context_limit, tier_id))
        if not candidates:
            return None
        candidates.sort()
        return candidates[0][2]

    # -- 主入口 -----------------------------------------------------------
    def decide(
        self,
        request: ChatRequest,
        *,
        prompt_tokens: int | None = None,
        sensitivity: SensitivityResult | None = None,
    ) -> RouteDecision:
        cfg = self._config
        lc = cfg.routing.long_context

        if prompt_tokens is None:
            prompt_tokens = estimate_messages_tokens(
                [(m.role, m.content) for m in request.messages]
            )
        bucket = length_bucket(
            prompt_tokens,
            short_max=lc.short_max_tokens,
            medium_max=lc.medium_max_tokens,
            long_max=lc.long_max_tokens,
        )
        prompt_text = request.prompt_text()

        # ---- 1. 敏感数据强制本地（红线，最高优先级）-----------------------
        if sensitivity is not None and sensitivity.blocked:
            local_tier = self._local_tier()
            return RouteDecision(
                tier_id=local_tier.tier_id,  # type: ignore[arg-type]
                contract_tier=local_tier.contract_tier,  # type: ignore[arg-type]
                model=local_tier.model,
                task_type="unpublished_data_analysis",
                decided_by="sensitivity_forced",
                prompt_tokens=prompt_tokens,
                length_bucket=bucket,
                reason=sensitivity.findings[0].reason
                if sensitivity.findings
                else "命中敏感数据红线，强制本地处理",
                forced_local_by_sensitivity=True,
            )

        # ---- 2. 客户端显式档位 --------------------------------------------
        explicit_tier_id: str | None = None
        if cfg.routing.allow_client_tier_hint and request.model not in {"", "auto"}:
            hit = cfg.tier_by_alias(request.model)
            if hit is not None:
                explicit_tier_id = hit.tier_id

        # ---- 3/4. 任务类型 -----------------------------------------------
        task_type: str
        task_source: str
        declared_task = request.matrix.task_type
        if (
            cfg.routing.allow_client_task_hint
            and declared_task
            and declared_task in cfg.routing.task_types
        ):
            task_type = declared_task
            task_source = "explicit_task"
        else:
            match = self.classify_task_type(prompt_text)
            if match is not None:
                task_type = match.task_type
                task_source = "heuristic"
            else:
                task_type = cfg.routing.default_task_type
                task_source = "default"

        task_spec = cfg.task_spec(task_type) or cfg.task_spec(cfg.routing.default_task_type)
        assert task_spec is not None  # 配置加载时已校验
        tier_id = task_spec.tier_id
        decided_by = task_source
        reason = f"任务类型 {task_type} 归属 {tier_id}"

        # ---- restricated 敏感数据：优先本地 ---------------------------------
        # 注意：restricted 不是红线，本地不可用时允许上云但需告警（见 gateway）。
        if sensitivity is not None and sensitivity.force_local:
            local_tier = self._local_tier()
            return RouteDecision(
                tier_id=local_tier.tier_id,  # type: ignore[arg-type]
                contract_tier=local_tier.contract_tier,  # type: ignore[arg-type]
                model=local_tier.model,
                task_type=task_type,
                decided_by="sensitivity_forced",
                prompt_tokens=prompt_tokens,
                length_bucket=bucket,
                reason="命中敏感数据特征，优先本地处理以避免外泄",
                forced_local_by_sensitivity=True,
            )

        # ---- 2（续）. 显式档位覆盖启发式结果 ------------------------------
        if explicit_tier_id is not None:
            tier_id = explicit_tier_id
            decided_by = "explicit_tier"
            reason = f"客户端显式指定档位 {tier_id}"

        # ---- 5. 长度敏感任务升档 ------------------------------------------
        elif (
            task_type in lc.length_sensitive_task_types
            and prompt_tokens >= lc.pro_min_tokens
        ):
            pro = cfg.tiers.get("tier-03")
            if pro is not None and pro.tier_id != tier_id:
                tier_id = pro.tier_id
                decided_by = "heuristic_length"
                reason = (
                    f"长度敏感任务 {task_type} 输入 {prompt_tokens} tokens "
                    f"≥ {lc.pro_min_tokens}，升档到 {tier_id}（长上下文攻坚）"
                )
            elif pro is not None:
                # 已经是 Pro 档：长度规则确认了选择，但决策来源仍是任务类型。
                # 刻意不写成 heuristic_length，否则日志会误导「是长度把它升上去的」。
                reason += f"；输入 {prompt_tokens} tokens 符合 Pro 长上下文场景"

        # ---- 6. 能力升级 --------------------------------------------------
        escalated = self._escalate_for_capacity(prompt_tokens, tier_id)
        if escalated is not None:
            reason += f"；输入 {prompt_tokens} tokens 超出 {tier_id} 上下文，升级到 {escalated}"
            tier_id = escalated
            if decided_by in {"heuristic", "default", "explicit_task"}:
                decided_by = "capability_escalation"

        spec = cfg.tier(tier_id)
        return RouteDecision(
            tier_id=spec.tier_id,  # type: ignore[arg-type]
            contract_tier=spec.contract_tier,  # type: ignore[arg-type]
            model=spec.model,
            task_type=task_type,
            decided_by=decided_by,
            prompt_tokens=prompt_tokens,
            length_bucket=bucket,
            reason=reason,
            forced_local_by_sensitivity=False,
        )

    # -- 辅助 -------------------------------------------------------------
    def _local_tier(self):  # type: ignore[no-untyped-def]
        """找到本地档位（local_only=true）。配置校验保证 tier-04 存在。"""
        for spec in self._config.tiers.values():
            if spec.local_only:
                return spec
        # 兜底：按契约档位 local 找
        for spec in self._config.tiers.values():
            if spec.contract_tier == "local":
                return spec
        return self._config.tier("tier-04")
