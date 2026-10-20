"""路由选择正确性测试（任务书重点测试项 ①）。

覆盖三个路由维度：
1. 任务类型 → 档位（四级各自的职责边界）
2. 输入长度 → 档位（长度敏感任务升档 + 能力升级）
3. 数据敏感度 → 档位（强制本地，红线优先）

外加决策优先级验证：敏感度 > 显式档位 > 显式任务 > 启发式 > 默认。
"""

from __future__ import annotations

import pytest

from copilot_router.config import RouterConfig
from copilot_router.gateway import CopilotGateway
from copilot_router.routing import Router
from copilot_router.sensitivity import SensitivityScanner
from copilot_router.types import ChatRequest

from .conftest import chat_request, make_config


# ---------------------------------------------------------------------------
# 第 1 维：任务类型
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "content,expected_tier,expected_task",
    [
        # TIER 01 —— 意图分词 / 虫洞类型识别 / 早报合成
        ("帮我解析一下这句话的意图，拆解成可执行的步骤", "tier-01", "intent_parse"),
        ("这个虫洞的 payload_type 应该是什么", "tier-01", "wormhole_type_detect"),
        ("生成今日早报，汇总 24h 前沿动态", "tier-01", "pat_hot_brief"),
        # TIER 02 —— schema 校验 / 语法自愈 / 表格字段对齐
        ("校验这个 JSON Schema 是否符合必填字段要求", "tier-02", "schema_validate"),
        ("这个脚本报 SyntaxError，帮我修复语法错误", "tier-02", "code_syntax_repair"),
        ("把综测表格的列名映射对齐一下", "tier-02", "table_field_align"),
        # TIER 03 —— 多篇对比 / 综述大纲 / 套磁信
        ("横向对比这几篇顶刊论文的实验参量", "tier-03", "multi_paper_compare"),
        ("帮我推演一个文献综述的大纲结构", "tier-03", "review_outline"),
        ("定制一封套磁信，突出我的复现实验数据", "tier-03", "cold_email"),
        # TIER 04 —— 未发表数据 / 术语校准（且必须强制本地）
        ("帮我校准这批物理光电专业术语的译名", "tier-04", "terminology_calibration"),
    ],
)
def test_task_type_routing(base_config, content, expected_tier, expected_task):
    """任务类型识别 + 档位归属必须与需求文档 §6 的职责矩阵一致。"""
    router = Router(base_config)
    request = chat_request(content)
    decision = router.decide(request)
    assert decision.task_type == expected_task, f"任务分类错误：{decision.task_type}"
    assert decision.tier_id == expected_tier, (
        f"档位错误：期望 {expected_tier}，实际 {decision.tier_id}（{decision.reason}）"
    )


def test_unpublished_data_forces_tier04(base_config):
    """未发表实验数据必须强制 TIER 04（合规红线，非可选优化）。"""
    scanner = SensitivityScanner(base_config.sensitivity)
    router = Router(base_config)
    request = chat_request("这是未发表的实验原始数据，帮我分析 TRPL 衰减")
    sens = scanner.scan(request.prompt_text())
    decision = router.decide(request, sensitivity=sens)
    assert decision.tier_id == "tier-04"
    assert decision.forced_local_by_sensitivity is True
    assert decision.decided_by == "sensitivity_forced"
    assert decision.contract_tier == "local"


def test_default_task_type_when_no_signal(base_config):
    """无任何特征时回落到配置的默认任务类型。"""
    router = Router(base_config)
    decision = router.decide(chat_request("你好"))
    assert decision.task_type == base_config.routing.default_task_type
    assert decision.decided_by == "default"


def test_client_task_hint_wins_over_heuristic(base_config):
    """客户端显式任务类型优先于启发式（微站更清楚自己在做什么）。"""
    router = Router(base_config)
    # 内容像意图解析，但客户端声明这是 schema 校验
    request = chat_request("帮我解析这个内容", task_type="schema_validate")
    decision = router.decide(request)
    assert decision.task_type == "schema_validate"
    assert decision.tier_id == "tier-02"
    assert decision.decided_by == "explicit_task"


def test_client_task_hint_ignored_when_unknown(base_config):
    router = Router(base_config)
    request = chat_request("帮我解析一下这句话的意图", task_type="not_a_real_task")
    decision = router.decide(request)
    assert decision.task_type != "not_a_real_task"


def test_task_hint_can_be_disabled():
    """allow_client_task_hint=false 时忽略客户端声明（防止被滥用指定便宜档）。"""

    def mutate(data):
        data["routing"]["allow_client_task_hint"] = False

    config = make_config(mutate)
    router = Router(config)
    request = chat_request("帮我解析一下这句话的意图", task_type="schema_validate")
    decision = router.decide(request)
    assert decision.task_type == "intent_parse"
    assert decision.decided_by != "explicit_task"


# ---------------------------------------------------------------------------
# 第 2 维：输入长度
# ---------------------------------------------------------------------------
def test_short_input_stays_cheap(base_config):
    """短文不能升档到 Pro —— 这是控制成本的第一道阀门。"""
    router = Router(base_config)
    decision = router.decide(chat_request("对比这两篇论文", ), prompt_tokens=100)
    assert decision.length_bucket == "short"
    assert decision.tier_id != "tier-03", "短输入不应该用 Pro"


def test_long_input_escalates_for_length_sensitive_task(base_config):
    """长度敏感任务 + 长输入 → 升档到 Pro。"""
    router = Router(base_config)
    long_tokens = base_config.routing.long_context.pro_min_tokens + 1000
    request = chat_request("横向对比这几篇顶刊论文的实验参量")
    decision = router.decide(request, prompt_tokens=long_tokens)
    assert decision.task_type == "multi_paper_compare"
    assert decision.tier_id == "tier-03"
    assert decision.decided_by == "heuristic_length"
    assert "升档" in decision.reason


def test_long_input_does_not_escalate_non_length_sensitive_task(base_config):
    """非长度敏感任务：长输入也不升 Pro。

    这是 R-T05 成本控制的关键 —— 一份 50k token 的 PDF 摘要请求
    如果只是要「提取字段」，Tier 02 就能做，没必要用 ¥2.00/M 的 Pro。
    """
    router = Router(base_config)
    long_tokens = base_config.routing.long_context.pro_min_tokens + 1000
    request = chat_request("把这段表格的字段对齐")
    decision = router.decide(request, prompt_tokens=long_tokens)
    assert decision.task_type == "table_field_align"
    assert decision.tier_id == "tier-02"
    assert decision.tier_id != "tier-03"


def test_capability_escalation_when_context_overflows(base_config):
    """输入超出档位 context_limit 时，升到能装下且最便宜的档位。"""
    router = Router(base_config)
    tier01_limit = base_config.tier("tier-01").context_limit
    request = chat_request("帮我解析这句话的意图")
    decision = router.decide(request, prompt_tokens=tier01_limit + 1000)
    # tier-01 (32k) 装不下 → 应升级到 tier-02 (128k, ¥0.40) 而不是直接上 Pro
    assert decision.tier_id == "tier-02"
    assert decision.tier_id != "tier-03", "能力升级应优先选便宜且够用的档位"


def test_length_bucket_classification(base_config):
    router = Router(base_config)
    lc = base_config.routing.long_context
    request = chat_request("你好")
    assert router.decide(request, prompt_tokens=lc.short_max_tokens).length_bucket == "short"
    assert (
        router.decide(request, prompt_tokens=lc.short_max_tokens + 1).length_bucket == "medium"
    )
    assert (
        router.decide(request, prompt_tokens=lc.medium_max_tokens + 1).length_bucket == "long"
    )


# ---------------------------------------------------------------------------
# 第 3 维：显式档位覆盖
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "model_alias,expected_tier",
    [
        ("tier-01", "tier-01"),
        ("tier-02", "tier-02"),
        ("tier-03", "tier-03"),
        ("pro", "tier-03"),
        ("flash", "tier-01"),
        ("deepseek-v4-pro", "tier-03"),
    ],
)
def test_explicit_tier_hint(base_config, model_alias, expected_tier):
    router = Router(base_config)
    decision = router.decide(chat_request("随便什么内容", model=model_alias))
    assert decision.tier_id == expected_tier
    assert decision.decided_by == "explicit_tier"


def test_auto_model_uses_heuristic(base_config):
    router = Router(base_config)
    decision = router.decide(chat_request("帮我解析一下这句话的意图", model="auto"))
    assert decision.decided_by != "explicit_tier"
    assert decision.tier_id == "tier-01"


# ---------------------------------------------------------------------------
# 优先级：敏感度压过一切
# ---------------------------------------------------------------------------
def test_sensitivity_overrides_explicit_tier(base_config):
    """红线最高优先级：客户端指定 tier-01 也不能把未发表数据发上云。"""
    scanner = SensitivityScanner(base_config.sensitivity)
    router = Router(base_config)
    request = chat_request(
        "这是未发表的实验原始数据，帮我分析", model="tier-01"
    )
    sens = scanner.scan(request.prompt_text())
    decision = router.decide(request, sensitivity=sens)
    assert decision.tier_id == "tier-04"
    assert decision.forced_local_by_sensitivity is True


def test_sensitivity_overrides_explicit_task(base_config):
    scanner = SensitivityScanner(base_config.sensitivity)
    router = Router(base_config)
    request = chat_request(
        "审稿中的稿件正文，帮我看看", model="tier-03", task_type="intent_parse"
    )
    sens = scanner.scan(request.prompt_text())
    decision = router.decide(request, sensitivity=sens)
    assert decision.tier_id == "tier-04"


def test_warn_level_sensitivity_prefers_local(base_config):
    """warn 级（如学生个人信息）优先本地，但语义上是 restricted 而非 blocked。"""
    scanner = SensitivityScanner(base_config.sensitivity)
    router = Router(base_config)
    request = chat_request("我的学号 2023010101，帮我看看课表")
    sens = scanner.scan(request.prompt_text())
    assert sens.verdict == "restricted"
    decision = router.decide(request, sensitivity=sens)
    assert decision.tier_id == "tier-04"
    assert decision.forced_local_by_sensitivity is True


# ---------------------------------------------------------------------------
# 端到端（经 gateway）
# ---------------------------------------------------------------------------
def test_gateway_records_route_decision(gateway: CopilotGateway):
    result = gateway.chat(chat_request("帮我解析一下这个需求的意图", uid="mxu_route"))
    assert result.decision.tier_id == "tier-01"
    assert result.decision.contract_tier == "flash"
    assert result.decision.model == "deepseek-v4.1-flash"
    assert result.usage.total_tokens > 0


def test_route_decision_is_fully_explainable(base_config):
    """每个决策都必须能说清「为什么是这个档」—— 审计与调准确率都需要。"""
    router = Router(base_config)
    decision = router.decide(chat_request("横向对比这几篇顶刊论文"))
    assert decision.reason
    assert decision.decided_by
    assert decision.task_type
    assert decision.length_bucket
    assert decision.prompt_tokens > 0
