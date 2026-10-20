"""``config/tiers.yaml`` 的加载与结构校验。

铁律：模型名、单价、阈值、配额全部来自 YAML，代码里不出现任何价格字面量。
本模块把 YAML 变成强类型的 dataclass，并在加载时做自洽性校验，
让配置错误在启动时暴露，而不是在用户请求时静默算错钱。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import ConfigError

try:  # PyYAML 是唯一的外部依赖（不含 FastAPI 也可用）
    import yaml
except ModuleNotFoundError as exc:  # pragma: no cover - 环境缺失时的明确提示
    raise ImportError(
        "copilot-router 需要 PyYAML：pip install pyyaml"
    ) from exc


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "tiers.yaml"
CONFIG_PATH_ENV = "COPILOT_ROUTER_CONFIG"

VALID_CONTRACT_TIERS = {"flash", "pro", "local"}


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class TierSpec:
    tier_id: str
    name: str
    contract_tier: str
    model: str
    providers: tuple[str, ...]
    duties: tuple[str, ...]
    price_input_per_million: float
    price_output_per_million: float
    context_limit: int
    default_max_tokens: int
    local_only: bool

    def cost(self, prompt_tokens: int, completion_tokens: int) -> tuple[float, float]:
        """返回 (input_cost, output_cost)，单位人民币元。"""
        input_cost = prompt_tokens / 1_000_000 * self.price_input_per_million
        output_cost = completion_tokens / 1_000_000 * self.price_output_per_million
        return input_cost, output_cost


@dataclass(frozen=True, slots=True)
class BillingSpec:
    timezone: str
    annual_cost_target_per_user: float


@dataclass(frozen=True, slots=True)
class TaskTypeSpec:
    task_type: str
    tier_id: str
    description: str
    keywords: tuple[str, ...]
    regex: tuple[str, ...]
    structural: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class LongContextSpec:
    short_max_tokens: int
    medium_max_tokens: int
    long_max_tokens: int
    pro_min_tokens: int
    length_sensitive_task_types: frozenset[str]
    capability_escalation: bool
    capability_escalation_order: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DetectionRule:
    rule_id: str
    name: str
    category: str
    severity: str
    weight: float
    reason: str
    keywords: tuple[str, ...]
    regex: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SensitivitySpec:
    enabled: bool
    honor_client_declaration: bool
    expose_matched_rules: bool
    detectors: tuple[DetectionRule, ...]
    block_threshold: float = 3.0
    warn_threshold: float = 1.0


@dataclass(frozen=True, slots=True)
class BudgetSpec:
    user_daily_cost_limit: float
    user_monthly_cost_limit: float
    global_daily_cost_limit: float
    global_monthly_cost_limit: float
    precheck_mode: str
    expected_output_tokens: int
    precheck_safety_factor: float


@dataclass(frozen=True, slots=True)
class CacheSpec:
    enabled: bool
    max_entries: int
    max_temperature_for_cache: float
    exact_ttl_seconds: int
    similarity_threshold: float
    similarity_min_prompt_tokens: int
    public_identifier_similarity: float
    similarity_candidate_limit: int
    cross_user_shareable_task_types: frozenset[str]
    min_entry_age_seconds: int


@dataclass(frozen=True, slots=True)
class Level1Spec:
    cache_ttl_multiplier: float
    similarity_threshold_relax: float
    extra_shareable_task_types: frozenset[str]


@dataclass(frozen=True, slots=True)
class Level2Spec:
    pro_daily_calls: int
    pro_global_cost_ratio: float
    downgrade_to: str


@dataclass(frozen=True, slots=True)
class Level3Spec:
    long_text_auto_disabled: bool
    manual_trigger_min_tokens: int
    manual_trigger_task_types: frozenset[str]


@dataclass(frozen=True, slots=True)
class DegradationSpec:
    enabled: bool
    trigger_ratios: tuple[float, float, float]
    level_1: Level1Spec
    level_2: Level2Spec
    level_3: Level3Spec


@dataclass(frozen=True, slots=True)
class ProviderSpec:
    name: str
    kind: str
    display_name: str
    base_url: str
    api_key: str | None
    api_key_optional: bool
    egress: str
    timeout_seconds: float
    max_retries: int

    @property
    def is_local(self) -> bool:
        return self.egress == "local"

    @property
    def usable(self) -> bool:
        """有 base_url（本地端点可无 key）即可用；云端必须有 key。"""
        if not self.base_url:
            return False
        if self.egress == "local" or self.api_key_optional:
            return True
        return bool(self.api_key)


@dataclass(frozen=True, slots=True)
class FailoverSpec:
    enabled: bool
    allow_cross_tier: bool
    breaker_failure_threshold: int
    breaker_reset_seconds: float
    breaker_window_seconds: float


@dataclass(frozen=True, slots=True)
class RoutingSpec:
    default_task_type: str
    min_score: float
    allow_client_task_hint: bool
    allow_client_tier_hint: bool
    long_context: LongContextSpec
    task_types: dict[str, TaskTypeSpec]


@dataclass(frozen=True, slots=True)
class RouterConfig:
    version: int
    currency: str
    billing: BillingSpec
    tiers: dict[str, TierSpec]
    routing: RoutingSpec
    sensitivity: SensitivitySpec
    budget: BudgetSpec
    cache: CacheSpec
    degradation: DegradationSpec
    providers: dict[str, ProviderSpec]
    failover: FailoverSpec
    source_path: Path

    # -- 便捷查询 ---------------------------------------------------------
    def tier(self, tier_id: str) -> TierSpec:
        try:
            return self.tiers[tier_id]
        except KeyError as exc:
            raise ConfigError(
                f"未知档位 {tier_id!r}，已配置档位：{sorted(self.tiers)}"
            ) from exc

    def tier_by_model(self, model: str) -> TierSpec | None:
        for spec in self.tiers.values():
            if spec.model == model:
                return spec
        return None

    def tier_by_alias(self, alias: str) -> TierSpec | None:
        """接受 ``tier-03`` / ``pro`` / ``flash`` / ``local`` / 模型名 等多种写法。"""
        key = alias.strip().lower()
        if key in self.tiers:
            return self.tiers[key]
        for spec in self.tiers.values():
            if key == spec.model.lower():
                return spec
        # 契约档位 → 内部档位（flash 取最便宜的 tier-01；pro→tier-03；local→tier-04）
        contract_map = {"flash": "tier-01", "pro": "tier-03", "local": "tier-04"}
        if key in contract_map:
            return self.tiers[contract_map[key]]
        return None

    def task_spec(self, task_type: str) -> TaskTypeSpec | None:
        return self.routing.task_types.get(task_type)

    def upstream_tiers(self) -> list[TierSpec]:
        """会产生 API 费用的档位（用于成本统计）。"""
        return [t for t in self.tiers.values() if not t.local_only]


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------
def _require(mapping: dict[str, Any], key: str, where: str) -> Any:
    if key not in mapping or mapping[key] is None:
        raise ConfigError(f"配置缺少必填项 {where}.{key}")
    return mapping[key]


def _as_float(value: Any, where: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{where} 必须是数字，实际为 {value!r}") from exc


def _as_int(value: Any, where: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{where} 必须是整数，实际为 {value!r}") from exc


def _as_str_tuple(value: Any, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)):
        raise ConfigError(f"{where} 必须是字符串列表，实际为 {type(value).__name__}")
    return tuple(str(item) for item in value)


def _parse_tiers(raw: dict[str, Any]) -> dict[str, TierSpec]:
    if not raw:
        raise ConfigError("配置缺少 tiers 段")
    parsed: dict[str, TierSpec] = {}
    for tier_id, body in raw.items():
        where = f"tiers.{tier_id}"
        if not isinstance(body, dict):
            raise ConfigError(f"{where} 必须是对象")
        contract_tier = str(_require(body, "contract_tier", where))
        if contract_tier not in VALID_CONTRACT_TIERS:
            raise ConfigError(
                f"{where}.contract_tier={contract_tier!r} 不在契约枚举 "
                f"{sorted(VALID_CONTRACT_TIERS)} 中"
            )
        spec = TierSpec(
            tier_id=str(tier_id),
            name=str(_require(body, "name", where)),
            contract_tier=contract_tier,
            model=str(_require(body, "model", where)),
            providers=_as_str_tuple(_require(body, "providers", where), f"{where}.providers"),
            duties=_as_str_tuple(body.get("duties"), f"{where}.duties"),
            price_input_per_million=_as_float(
                _require(body, "price_input_per_million", where),
                f"{where}.price_input_per_million",
            ),
            price_output_per_million=_as_float(
                _require(body, "price_output_per_million", where),
                f"{where}.price_output_per_million",
            ),
            context_limit=_as_int(_require(body, "context_limit", where), f"{where}.context_limit"),
            default_max_tokens=_as_int(
                _require(body, "default_max_tokens", where), f"{where}.default_max_tokens"
            ),
            local_only=bool(body.get("local_only", False)),
        )
        if not spec.providers:
            raise ConfigError(f"{where}.providers 不能为空")
        if spec.price_input_per_million < 0 or spec.price_output_per_million < 0:
            raise ConfigError(f"{where} 单价不能为负")
        if spec.local_only and (spec.price_input_per_million or spec.price_output_per_million):
            raise ConfigError(
                f"{where} 声明 local_only=true 但单价非零：本地算力不应产生 token 计费"
            )
        parsed[spec.tier_id] = spec
    return parsed


def _parse_task_types(raw: dict[str, Any], tier_ids: set[str]) -> dict[str, TaskTypeSpec]:
    if not raw:
        raise ConfigError("配置缺少 routing.task_types 段")
    parsed: dict[str, TaskTypeSpec] = {}
    for task_type, body in raw.items():
        where = f"routing.task_types.{task_type}"
        if not isinstance(body, dict):
            raise ConfigError(f"{where} 必须是对象")
        tier_id = str(_require(body, "tier", where))
        if tier_id not in tier_ids:
            raise ConfigError(f"{where}.tier={tier_id!r} 未在 tiers 中定义")
        parsed[str(task_type)] = TaskTypeSpec(
            task_type=str(task_type),
            tier_id=tier_id,
            description=str(body.get("description", "")),
            keywords=_as_str_tuple(body.get("keywords"), f"{where}.keywords"),
            regex=_as_str_tuple(body.get("regex"), f"{where}.regex"),
            structural=_as_str_tuple(body.get("structural"), f"{where}.structural"),
        )
    return parsed


def _parse_detectors(raw: Any) -> tuple[DetectionRule, ...]:
    if not raw:
        raise ConfigError("配置缺少 sensitivity.detectors 段（合规红线检测器不可为空）")
    if not isinstance(raw, list):
        raise ConfigError("sensitivity.detectors 必须是列表")
    parsed: list[DetectionRule] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ConfigError("sensitivity.detectors 的每一项必须是对象")
        rule_id = str(_require(item, "id", "sensitivity.detectors[]"))
        if rule_id in seen:
            raise ConfigError(f"sensitivity.detectors 存在重复 id {rule_id!r}")
        seen.add(rule_id)
        severity = str(_require(item, "severity", f"sensitivity.detectors.{rule_id}"))
        if severity not in {"block", "warn"}:
            raise ConfigError(
                f"sensitivity.detectors.{rule_id}.severity={severity!r}，只允许 block/warn"
            )
        parsed.append(
            DetectionRule(
                rule_id=rule_id,
                name=str(item.get("name", rule_id)),
                category=str(item.get("category", "unknown")),
                severity=severity,
                weight=_as_float(item.get("weight", 1.0), f"detectors.{rule_id}.weight"),
                reason=str(item.get("reason", "")),
                keywords=_as_str_tuple(item.get("keywords"), f"detectors.{rule_id}.keywords"),
                regex=_as_str_tuple(item.get("regex"), f"detectors.{rule_id}.regex"),
            )
        )
    return tuple(parsed)


def _parse_providers(raw: dict[str, Any]) -> dict[str, ProviderSpec]:
    if not raw:
        raise ConfigError("配置缺少 providers 段")
    parsed: dict[str, ProviderSpec] = {}
    for name, body in raw.items():
        where = f"providers.{name}"
        if not isinstance(body, dict):
            raise ConfigError(f"{where} 必须是对象")
        base_url_env = body.get("base_url_env")
        base_url = ""
        if base_url_env:
            base_url = os.environ.get(str(base_url_env), "") or str(
                body.get("base_url_default", "")
            )
        api_key_env = body.get("api_key_env")
        api_key = os.environ.get(str(api_key_env), "") if api_key_env else None
        if api_key == "":
            api_key = None
        parsed[str(name)] = ProviderSpec(
            name=str(name),
            kind=str(body.get("kind", "openai_compat")),
            display_name=str(body.get("display_name", name)),
            base_url=base_url,
            api_key=api_key,
            api_key_optional=bool(body.get("api_key_optional", False)),
            egress=str(body.get("egress", "cloud")),
            timeout_seconds=_as_float(body.get("timeout_seconds", 60), f"{where}.timeout_seconds"),
            max_retries=_as_int(body.get("max_retries", 0), f"{where}.max_retries"),
        )
    return parsed


def parse_config(data: dict[str, Any], source_path: Path) -> RouterConfig:
    """把已解析的 dict 变成 RouterConfig，并做跨段自洽性校验。"""
    if not isinstance(data, dict):
        raise ConfigError("配置文件顶层必须是对象")

    tiers = _parse_tiers(data.get("tiers") or {})
    tier_ids = set(tiers)

    billing_raw = data.get("billing") or {}
    billing = BillingSpec(
        timezone=str(billing_raw.get("timezone", "Asia/Shanghai")),
        annual_cost_target_per_user=_as_float(
            billing_raw.get("annual_cost_target_per_user", 1.5),
            "billing.annual_cost_target_per_user",
        ),
    )

    routing_raw = data.get("routing") or {}
    lc_raw = routing_raw.get("long_context") or {}
    long_context = LongContextSpec(
        short_max_tokens=_as_int(lc_raw.get("short_max_tokens", 2000), "long_context.short_max_tokens"),
        medium_max_tokens=_as_int(lc_raw.get("medium_max_tokens", 16000), "long_context.medium_max_tokens"),
        long_max_tokens=_as_int(lc_raw.get("long_max_tokens", 64000), "long_context.long_max_tokens"),
        pro_min_tokens=_as_int(lc_raw.get("pro_min_tokens", 16000), "long_context.pro_min_tokens"),
        length_sensitive_task_types=frozenset(
            _as_str_tuple(
                lc_raw.get("length_sensitive_task_types"),
                "long_context.length_sensitive_task_types",
            )
        ),
        capability_escalation=bool(lc_raw.get("capability_escalation", True)),
        capability_escalation_order=_as_str_tuple(
            lc_raw.get("capability_escalation_order"),
            "long_context.capability_escalation_order",
        ),
    )
    if not (
        long_context.short_max_tokens
        <= long_context.medium_max_tokens
        <= long_context.long_max_tokens
    ):
        raise ConfigError(
            "routing.long_context 的 short/medium/long 阈值必须单调递增，"
            f"实际为 {long_context.short_max_tokens}/{long_context.medium_max_tokens}/"
            f"{long_context.long_max_tokens}"
        )

    task_types = _parse_task_types(routing_raw.get("task_types") or {}, tier_ids)
    default_task_type = str(routing_raw.get("default_task_type", "intent_parse"))
    if default_task_type not in task_types:
        raise ConfigError(
            f"routing.default_task_type={default_task_type!r} 未在 routing.task_types 中定义"
        )

    for tier_id in long_context.capability_escalation_order:
        if tier_id not in tiers:
            raise ConfigError(
                f"routing.long_context.capability_escalation_order 含未定义档位 {tier_id!r}"
            )

    routing = RoutingSpec(
        default_task_type=default_task_type,
        min_score=_as_float(routing_raw.get("min_score", 1.0), "routing.min_score"),
        allow_client_task_hint=bool(routing_raw.get("allow_client_task_hint", True)),
        allow_client_tier_hint=bool(routing_raw.get("allow_client_tier_hint", True)),
        long_context=long_context,
        task_types=task_types,
    )

    sens_raw = data.get("sensitivity") or {}
    sensitivity = SensitivitySpec(
        enabled=bool(sens_raw.get("enabled", True)),
        honor_client_declaration=bool(sens_raw.get("honor_client_declaration", True)),
        expose_matched_rules=bool(sens_raw.get("expose_matched_rules", True)),
        detectors=_parse_detectors(sens_raw.get("detectors")),
        block_threshold=_as_float(sens_raw.get("block_threshold", 3.0), "sensitivity.block_threshold"),
        warn_threshold=_as_float(sens_raw.get("warn_threshold", 1.0), "sensitivity.warn_threshold"),
    )

    budget_raw = data.get("budget") or {}
    budget = BudgetSpec(
        user_daily_cost_limit=_as_float(
            _require(budget_raw, "user_daily_cost_limit", "budget"),
            "budget.user_daily_cost_limit",
        ),
        user_monthly_cost_limit=_as_float(
            _require(budget_raw, "user_monthly_cost_limit", "budget"),
            "budget.user_monthly_cost_limit",
        ),
        global_daily_cost_limit=_as_float(
            _require(budget_raw, "global_daily_cost_limit", "budget"),
            "budget.global_daily_cost_limit",
        ),
        global_monthly_cost_limit=_as_float(
            _require(budget_raw, "global_monthly_cost_limit", "budget"),
            "budget.global_monthly_cost_limit",
        ),
        precheck_mode=str(budget_raw.get("precheck_mode", "worst_case")),
        expected_output_tokens=_as_int(
            budget_raw.get("expected_output_tokens", 512), "budget.expected_output_tokens"
        ),
        precheck_safety_factor=_as_float(
            budget_raw.get("precheck_safety_factor", 1.0), "budget.precheck_safety_factor"
        ),
    )
    if budget.precheck_mode not in {"worst_case", "expected"}:
        raise ConfigError(
            f"budget.precheck_mode={budget.precheck_mode!r}，只允许 worst_case/expected"
        )
    if budget.user_daily_cost_limit <= 0 or budget.global_daily_cost_limit <= 0:
        raise ConfigError("budget 的日上限必须为正数（0 等于禁用服务）")
    if budget.user_monthly_cost_limit < budget.user_daily_cost_limit:
        raise ConfigError("budget.user_monthly_cost_limit 不应小于 user_daily_cost_limit")
    if budget.global_monthly_cost_limit < budget.global_daily_cost_limit:
        raise ConfigError("budget.global_monthly_cost_limit 不应小于 global_daily_cost_limit")

    cache_raw = data.get("cache") or {}
    cache = CacheSpec(
        enabled=bool(cache_raw.get("enabled", True)),
        max_entries=_as_int(cache_raw.get("max_entries", 2048), "cache.max_entries"),
        max_temperature_for_cache=_as_float(
            cache_raw.get("max_temperature_for_cache", 0.3), "cache.max_temperature_for_cache"
        ),
        exact_ttl_seconds=_as_int(cache_raw.get("exact_ttl_seconds", 3600), "cache.exact_ttl_seconds"),
        similarity_threshold=_as_float(
            cache_raw.get("similarity_threshold", 0.92), "cache.similarity_threshold"
        ),
        similarity_min_prompt_tokens=_as_int(
            cache_raw.get("similarity_min_prompt_tokens", 8), "cache.similarity_min_prompt_tokens"
        ),
        public_identifier_similarity=_as_float(
            cache_raw.get("public_identifier_similarity", 0.97),
            "cache.public_identifier_similarity",
        ),
        similarity_candidate_limit=_as_int(
            cache_raw.get("similarity_candidate_limit", 64), "cache.similarity_candidate_limit"
        ),
        cross_user_shareable_task_types=frozenset(
            _as_str_tuple(
                cache_raw.get("cross_user_shareable_task_types"),
                "cache.cross_user_shareable_task_types",
            )
        ),
        min_entry_age_seconds=_as_int(
            cache_raw.get("min_entry_age_seconds", 0), "cache.min_entry_age_seconds"
        ),
    )
    if not 0 <= cache.similarity_threshold <= 1:
        raise ConfigError("cache.similarity_threshold 必须在 [0, 1] 区间")
    if cache.max_entries <= 0:
        raise ConfigError("cache.max_entries 必须为正整数")

    deg_raw = data.get("degradation") or {}
    lvl1_raw = deg_raw.get("level_1") or {}
    lvl2_raw = deg_raw.get("level_2") or {}
    lvl3_raw = deg_raw.get("level_3") or {}
    ratios_raw = deg_raw.get("trigger_ratios") or {}
    r1 = _as_float(ratios_raw.get("level_1", 0.60), "degradation.trigger_ratios.level_1")
    r2 = _as_float(ratios_raw.get("level_2", 0.85), "degradation.trigger_ratios.level_2")
    r3 = _as_float(ratios_raw.get("level_3", 0.95), "degradation.trigger_ratios.level_3")
    if not (0 < r1 <= r2 <= r3 <= 1.0):
        raise ConfigError(
            "degradation.trigger_ratios 必须满足 0 < level_1 <= level_2 <= level_3 <= 1，"
            f"实际为 {r1}/{r2}/{r3}"
        )
    downgrade_to = str(lvl2_raw.get("downgrade_to", "tier-01"))
    if downgrade_to not in tiers:
        raise ConfigError(f"degradation.level_2.downgrade_to={downgrade_to!r} 未在 tiers 中定义")
    for tt in _as_str_tuple(lvl3_raw.get("manual_trigger_task_types"), "level_3.manual_trigger_task_types"):
        if tt not in task_types:
            raise ConfigError(
                f"degradation.level_3.manual_trigger_task_types 含未定义任务类型 {tt!r}"
            )
    degradation = DegradationSpec(
        enabled=bool(deg_raw.get("enabled", True)),
        trigger_ratios=(r1, r2, r3),
        level_1=Level1Spec(
            cache_ttl_multiplier=_as_float(
                lvl1_raw.get("cache_ttl_multiplier", 3.0), "level_1.cache_ttl_multiplier"
            ),
            similarity_threshold_relax=_as_float(
                lvl1_raw.get("similarity_threshold_relax", 0.06),
                "level_1.similarity_threshold_relax",
            ),
            extra_shareable_task_types=frozenset(
                _as_str_tuple(lvl1_raw.get("extra_shareable_task_types"), "level_1.extra_shareable")
            ),
        ),
        level_2=Level2Spec(
            pro_daily_calls=_as_int(lvl2_raw.get("pro_daily_calls", 2), "level_2.pro_daily_calls"),
            pro_global_cost_ratio=_as_float(
                lvl2_raw.get("pro_global_cost_ratio", 0.35), "level_2.pro_global_cost_ratio"
            ),
            downgrade_to=downgrade_to,
        ),
        level_3=Level3Spec(
            long_text_auto_disabled=bool(lvl3_raw.get("long_text_auto_disabled", True)),
            manual_trigger_min_tokens=_as_int(
                lvl3_raw.get("manual_trigger_min_tokens", 16000),
                "level_3.manual_trigger_min_tokens",
            ),
            manual_trigger_task_types=frozenset(
                _as_str_tuple(lvl3_raw.get("manual_trigger_task_types"), "level_3.manual_trigger_task_types")
            ),
        ),
    )

    providers = _parse_providers(data.get("providers") or {})
    fo_raw = data.get("failover") or {}
    failover = FailoverSpec(
        enabled=bool(fo_raw.get("enabled", True)),
        allow_cross_tier=bool(fo_raw.get("allow_cross_tier", False)),
        breaker_failure_threshold=_as_int(
            fo_raw.get("breaker_failure_threshold", 3), "failover.breaker_failure_threshold"
        ),
        breaker_reset_seconds=_as_float(
            fo_raw.get("breaker_reset_seconds", 30), "failover.breaker_reset_seconds"
        ),
        breaker_window_seconds=_as_float(
            fo_raw.get("breaker_window_seconds", 60), "failover.breaker_window_seconds"
        ),
    )
    if failover.breaker_failure_threshold <= 0:
        raise ConfigError("failover.breaker_failure_threshold 必须为正整数")

    # 档位引用的 provider 必须存在
    for spec in tiers.values():
        for provider_name in spec.providers:
            if provider_name not in providers:
                raise ConfigError(
                    f"tier {spec.tier_id} 引用了未定义的 provider {provider_name!r}"
                )
    # 敏感数据强制本地：必须存在至少一个本地 Provider，否则合规拦截会导致服务不可用
    local_providers = [p for p in providers.values() if p.is_local and p.usable]
    if not local_providers:
        has_local_tier = any(t.local_only for t in tiers.values())
        if has_local_tier:
            # 只告警不失败：允许部署时用 mock 或后续接入本地端点（R-R02 兜底策略）
            pass

    return RouterConfig(
        version=_as_int(data.get("version", 1), "version"),
        currency=str(data.get("currency", "CNY")),
        billing=billing,
        tiers=tiers,
        routing=routing,
        sensitivity=sensitivity,
        budget=budget,
        cache=cache,
        degradation=degradation,
        providers=providers,
        failover=failover,
        source_path=source_path,
    )


def load_config(path: str | Path | None = None) -> RouterConfig:
    """加载配置。

    优先级：显式参数 > 环境变量 ``COPILOT_ROUTER_CONFIG`` > 包内 ``config/tiers.yaml``。
    """
    resolved: Path
    if path is not None:
        resolved = Path(path)
    elif os.environ.get(CONFIG_PATH_ENV):
        resolved = Path(os.environ[CONFIG_PATH_ENV])
    else:
        resolved = DEFAULT_CONFIG_PATH

    if not resolved.is_file():
        raise ConfigError(f"配置文件不存在：{resolved}")

    try:
        raw_text = resolved.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"无法读取配置文件 {resolved}：{exc}") from exc

    try:
        data = yaml.safe_load(raw_text)
    except yaml.YAMLError as exc:
        raise ConfigError(f"配置文件 {resolved} YAML 语法错误：{exc}") from exc

    if data is None:
        raise ConfigError(f"配置文件 {resolved} 为空")
    return parse_config(data, resolved)
