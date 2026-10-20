"""配置加载与自洽性校验测试。

重点：配置错误必须在启动时暴露，而不是在用户请求时静默算错钱。
"""

from __future__ import annotations

import pytest

from copilot_router.config import load_config, parse_config
from copilot_router.errors import ConfigError

from .conftest import CONFIG_PATH, make_config, raw_config


# ---------------------------------------------------------------------------
# 正向
# ---------------------------------------------------------------------------
def test_real_config_loads(base_config):
    assert set(base_config.tiers) == {"tier-01", "tier-02", "tier-03", "tier-04"}
    assert base_config.currency == "CNY"
    assert base_config.billing.annual_cost_target_per_user == 1.5


def test_prices_match_requirements_doc(base_config):
    """单价必须与 docs/00-analysis/02-requirements.md §6 的矩阵逐项一致。

    这是硬性回归保护：单价写错会直接导致成本核算错误与熔断失效。
    """
    expected = {
        "tier-01": 0.30,  # DeepSeek V4.1 Flash
        "tier-02": 0.40,  # Qwen 3.8 Flash
        "tier-03": 2.00,  # DeepSeek V4 Pro
        "tier-04": 0.00,  # Qwen 3.8-7B LoRA（本地/校内算力）
    }
    for tier_id, price in expected.items():
        spec = base_config.tier(tier_id)
        assert spec.price_input_per_million == pytest.approx(price)
        assert spec.price_output_per_million == pytest.approx(price)


def test_tier_models_match_requirements_doc(base_config):
    assert base_config.tier("tier-01").model == "deepseek-v4.1-flash"
    assert base_config.tier("tier-02").model == "qwen3.8-flash"
    assert base_config.tier("tier-03").model == "deepseek-v4-pro"
    assert base_config.tier("tier-04").model == "qwen3.8-7b-lora"


def test_four_to_three_tier_mapping_is_explicit(base_config):
    """需求文档 R2 / TD-09 的规格缺口：TIER 4 档 → 契约 3 档。

    本服务必须显式定义这个映射，不能留给下游猜。
    """
    assert base_config.tier("tier-01").contract_tier == "flash"
    assert base_config.tier("tier-02").contract_tier == "flash"
    assert base_config.tier("tier-03").contract_tier == "pro"
    assert base_config.tier("tier-04").contract_tier == "local"

    # 契约枚举必须与 specs/contracts/dispatch-contract.schema.json 一致
    contract_tiers = {t.contract_tier for t in base_config.tiers.values()}
    assert contract_tiers <= {"flash", "pro", "local"}


def test_local_tier_is_free_and_local_only(base_config):
    tier4 = base_config.tier("tier-04")
    assert tier4.local_only is True
    assert tier4.price_input_per_million == 0.0
    assert tier4.price_output_per_million == 0.0
    assert tier4.providers == ("local-lora",)


def test_only_tier04_is_local(base_config):
    local_tiers = [t.tier_id for t in base_config.tiers.values() if t.local_only]
    assert local_tiers == ["tier-04"]


def test_tier_alias_resolution(base_config):
    """客户端可用 tier-03 / pro / 模型名 等多种写法指定档位。"""
    assert base_config.tier_by_alias("tier-03").tier_id == "tier-03"
    assert base_config.tier_by_alias("PRO").tier_id == "tier-03"
    assert base_config.tier_by_alias("deepseek-v4-pro").tier_id == "tier-03"
    assert base_config.tier_by_alias("flash").tier_id == "tier-01"
    assert base_config.tier_by_alias("local").tier_id == "tier-04"
    assert base_config.tier_by_alias("gpt-4") is None


def test_provider_env_not_hardcoded(base_config):
    """API Key 只能来自环境变量，配置里不得出现真实密钥字面量。

    注意：配置文件里**允许**出现 ``sk-[A-Za-z0-9]{16,}`` 这样的**正则模式**
    （它是敏感检测规则本身），因此不能简单断言 ``"sk-" not in text``，
    必须检查「密钥形态的字面量」——即真正像 key 的长随机串。
    """
    import re

    raw_text = CONFIG_PATH.read_text(encoding="utf-8")

    # 真实密钥形态：sk- 后跟 20+ 位随机字符（regex 模式里是 {16,} 量词，不会命中）
    secret_like = re.findall(r"sk-[A-Za-z0-9]{20,}", raw_text)
    assert not secret_like, f"配置文件中疑似存在真实 API Key：{secret_like}"
    assert "Bearer " not in raw_text or "sk-" not in raw_text.split("Bearer ")[1][:8]

    # 每个云端 provider 都必须声明 api_key_env，而不是内联 key
    for spec in base_config.providers.values():
        if spec.name == "mock":
            continue
        assert spec.api_key is None, (
            f"provider {spec.name} 的 api_key 不应从配置文件读到明文"
            "（只能来自环境变量，且测试环境不应设置真实 key）"
        )


def test_sensitivity_detectors_loaded(base_config):
    ids = {d.rule_id for d in base_config.sensitivity.detectors}
    assert "S-UNPUB-EXPERIMENT" in ids
    assert "S-SECRET-CREDENTIAL" in ids
    block_rules = [d for d in base_config.sensitivity.detectors if d.severity == "block"]
    assert block_rules, "必须有 block 级规则，否则合规红线无从谈起"


# ---------------------------------------------------------------------------
# 负向：配置错误必须在加载时失败
# ---------------------------------------------------------------------------
def test_reject_unknown_contract_tier():
    def mutate(data):
        data["tiers"]["tier-03"]["contract_tier"] = "ultra"

    with pytest.raises(ConfigError, match="contract_tier"):
        make_config(mutate)


def test_reject_local_tier_with_price():
    """本地档位必须 ¥0：如果配了价格，说明配置写错了档位。"""

    def mutate(data):
        data["tiers"]["tier-04"]["price_input_per_million"] = 1.0

    with pytest.raises(ConfigError, match="local_only"):
        make_config(mutate)


def test_reject_missing_budget_limit():
    def mutate(data):
        del data["budget"]["user_daily_cost_limit"]

    with pytest.raises(ConfigError, match="user_daily_cost_limit"):
        make_config(mutate)


def test_reject_bad_degradation_ratio_order():
    """降级触发比例必须单调：level_1 <= level_2 <= level_3。"""

    def mutate(data):
        data["degradation"]["trigger_ratios"]["level_1"] = 0.99

    with pytest.raises(ConfigError, match="trigger_ratios"):
        make_config(mutate)


def test_reject_task_type_with_undefined_tier():
    def mutate(data):
        data["routing"]["task_types"]["intent_parse"]["tier"] = "tier-99"

    with pytest.raises(ConfigError, match="tier-99"):
        make_config(mutate)


def test_reject_undefined_provider_reference():
    def mutate(data):
        data["tiers"]["tier-03"]["providers"] = ["nonexistent-provider"]

    with pytest.raises(ConfigError, match="nonexistent-provider"):
        make_config(mutate)


def test_reject_empty_detectors():
    """检测器为空等于关掉合规红线，必须拒绝。"""

    def mutate(data):
        data["sensitivity"]["detectors"] = []

    with pytest.raises(ConfigError, match="detectors"):
        make_config(mutate)


def test_reject_duplicate_detector_id():
    def mutate(data):
        data["sensitivity"]["detectors"].append(
            dict(data["sensitivity"]["detectors"][0])
        )

    with pytest.raises(ConfigError, match="重复"):
        make_config(mutate)


def test_reject_missing_config_file(tmp_path):
    with pytest.raises(ConfigError, match="不存在"):
        load_config(tmp_path / "nope.yaml")


def test_reject_malformed_yaml(tmp_path):
    bad = tmp_path / "bad.yaml"
    bad.write_text("tiers: [unclosed", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_config(bad)


def test_reject_invalid_precheck_mode():
    def mutate(data):
        data["budget"]["precheck_mode"] = "guess"

    with pytest.raises(ConfigError, match="precheck_mode"):
        make_config(mutate)


def test_reject_monthly_less_than_daily():
    def mutate(data):
        data["budget"]["user_monthly_cost_limit"] = 0.001

    with pytest.raises(ConfigError, match="user_monthly_cost_limit"):
        make_config(mutate)


def test_config_path_env_override(monkeypatch, tmp_path):
    """COPILOT_ROUTER_CONFIG 可覆盖默认路径（部署时按环境换配置）。"""
    target = tmp_path / "custom.yaml"
    target.write_text(CONFIG_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setenv("COPILOT_ROUTER_CONFIG", str(target))
    cfg = load_config()
    assert cfg.source_path == target


def test_config_is_immutable(base_config):
    """配置对象应不可变，防止运行期被意外改价。"""
    with pytest.raises(Exception):
        base_config.billing.annual_cost_target_per_user = 999  # type: ignore[misc]
