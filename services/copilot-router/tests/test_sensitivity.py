"""敏感数据识别与拦截测试（任务书重点测试项 ④）。

这是**合规红线**，测试必须覆盖：
1. 未发表实验数据 → 强制 TIER 04 本地，且**绝不发往云端 Provider**
2. 凭据/密钥 → 拦截
3. 学生个人信息 → restricted（优先本地）
4. 正常内容 → 不误伤（假阳性会摧毁可用性）
5. 本地不可用时 → 返回 451 明确报错，**绝不降级上云**
6. 敏感数据永不进缓存（防止跨用户泄漏）
7. 客户端声明只能加严、不能放宽
"""

from __future__ import annotations

import pytest

from copilot_router.cache import SimilarityCache
from copilot_router.gateway import CopilotGateway
from copilot_router.errors import ComplianceEgressError
from copilot_router.providers import MockProvider
from copilot_router.sensitivity import SensitivityScanner

from .conftest import RecordingProvider, chat_request, make_config


# ---------------------------------------------------------------------------
# 判定正确性
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "text,expected_rule",
    [
        ("这是未发表的实验原始数据，请帮我分析", "S-UNPUB-EXPERIMENT"),
        ("课题组内部数据，不要外传", "S-UNPUB-EXPERIMENT"),
        ("raw experimental data from our setup", "S-UNPUB-EXPERIMENT"),
        ("这份稿件还在审稿中，帮我看看", "S-EMBARGO-MANUSCRIPT"),
        ("manuscript under review, please polish", "S-EMBARGO-MANUSCRIPT"),
    ],
)
def test_block_level_detection(base_config, text, expected_rule):
    """block 级规则必须判定为 blocked。"""
    scanner = SensitivityScanner(base_config.sensitivity)
    result = scanner.scan(text)
    assert result.verdict == "blocked", f"未拦截：{text}"
    assert expected_rule in result.matched_rule_ids
    assert result.force_local is True
    assert result.cache_shareable is False


@pytest.mark.parametrize(
    "text",
    [
        "我的学号 2023010101，帮我看看课表",
        "联系手机号 13812345678",
        "身份证 110101199003071234",
    ],
)
def test_pii_is_restricted(base_config, text):
    """学生个人信息 → restricted（优先本地，但不阻断）。"""
    scanner = SensitivityScanner(base_config.sensitivity)
    result = scanner.scan(text)
    assert result.verdict == "restricted"
    assert result.force_local is True
    assert "S-PII-STUDENT" in result.matched_rule_ids


def test_credential_detection(base_config):
    scanner = SensitivityScanner(base_config.sensitivity)
    result = scanner.scan("这是我的 api key: sk-abcdefghijklmnopqrstuvwxyz123456")
    assert result.verdict == "blocked"
    assert "S-SECRET-CREDENTIAL" in result.matched_rule_ids


@pytest.mark.parametrize(
    "text",
    [
        "帮我解析一下这句话的意图",
        "横向对比这几篇顶刊论文的实验参量",
        "把综测表格的字段对齐一下",
        "生成今日早报",
        "这篇论文的 DOI 是 10.1021/jacs.4c0112，帮我总结",
        "帮我把这段 Python 脚本的语法错误修一下",
        "",
        "hello world",
    ],
)
def test_clean_text_is_not_flagged(base_config, text):
    """正常科研内容不得被误判 —— 假阳性会让服务不可用。"""
    scanner = SensitivityScanner(base_config.sensitivity)
    result = scanner.scan(text)
    assert result.verdict == "clean", f"误伤：{text!r} → {result.matched_rule_ids}"
    assert result.force_local is False


def test_findings_never_record_raw_text(base_config):
    """命中记录只含规则元数据，绝不含**用户原文**。

    注意区分两类包含关系：
    - ``reason`` / ``name`` 里出现「未发表」「审稿中」是**规则描述**，必须保留
      （运维要能看懂命中了什么规则）；
    - 但用户原文中的具体内容（实验数值、独有片段）绝不能进入记录。
    早期版本的断言把两者混为一谈，属于测试写法错误而非实现缺陷。
    """
    scanner = SensitivityScanner(base_config.sensitivity)
    unique_payloads = [
        "0.8732",  # 实验数值
        "TRPL-decay-curve-42",  # 用户自造标识
        "样品编号 XJ-2026-0093",  # 样本编号
    ]
    text = (
        "这是未发表的实验原始数据，样品编号 XJ-2026-0093，"
        "TRPL-decay-curve-42 的拟合值是 0.8732"
    )
    result = scanner.scan(text)
    assert result.findings
    assert result.verdict == "blocked"

    for finding in result.findings:
        dumped = repr(finding)
        for payload in unique_payloads:
            assert payload not in dumped, (
                f"命中记录泄漏了用户原文片段 {payload!r}：{dumped}"
            )
        # 记录结构上只允许规则元数据字段
        assert finding.rule_id.startswith("S-")
        assert finding.category
        assert finding.severity in {"block", "warn"}


# ---------------------------------------------------------------------------
# 路由后果：强制本地
# ---------------------------------------------------------------------------
def test_blocked_request_routes_to_local_tier(gateway: CopilotGateway):
    result = gateway.chat(
        chat_request("这是未发表的实验原始数据，帮我分析 TRPL 衰减曲线")
    )
    assert result.decision.tier_id == "tier-04"
    assert result.decision.contract_tier == "local"
    assert result.decision.model == "qwen3.8-7b-lora"
    assert result.decision.forced_local_by_sensitivity is True
    assert result.sensitivity is not None
    assert result.sensitivity.verdict == "blocked"


def test_blocked_request_never_reaches_cloud_provider(base_config):
    """核心断言：敏感数据必须只发给本地 Provider，云端 Provider 一次都不能被调用。

    这是「合规红线」的可执行验证 —— 不是靠配置声明，而是靠记录实际调用。
    """
    cloud = RecordingProvider("deepseek", "cloud")
    qwen = RecordingProvider("qwen", "cloud")
    local = RecordingProvider("local-lora", "local")
    gw = CopilotGateway(
        base_config,
        providers={"deepseek": cloud, "qwen": qwen, "local-lora": local},
    )

    gw.chat(chat_request("这是未发表的实验原始数据，帮我分析"))

    assert len(local.requests) == 1, "敏感请求必须由本地模型处理"
    assert len(cloud.requests) == 0, "敏感请求绝不能发往云端 DeepSeek"
    assert len(qwen.requests) == 0, "敏感请求绝不能发往云端 Qwen"


def test_local_tier_cost_is_zero(gateway: CopilotGateway):
    """TIER 04 是 ¥0：既满足零外泄，又不产生 API 费用。"""
    result = gateway.chat(chat_request("这是未发表的实验原始数据，帮我分析"))
    assert result.cost.total_cost == 0.0
    assert result.cost.price_input_per_million == 0.0
    assert result.decision.tier_id == "tier-04"


def test_restricted_request_routes_to_local(gateway: CopilotGateway):
    result = gateway.chat(chat_request("我的学号 2023010101，帮我看看选课"))
    assert result.decision.tier_id == "tier-04"
    assert result.sensitivity.verdict == "restricted"


# ---------------------------------------------------------------------------
# 红线的兜底：本地不可用时必须失败，绝不降级上云
# ---------------------------------------------------------------------------
def test_blocked_request_fails_closed_when_local_unavailable(base_config):
    """本地模型不可用 + 敏感数据 → 451 明确报错。

    这是 ADR-05 / R-R02 的兜底策略：「若本地模型完全不可用，
    则不上传、不用模型 —— 遵守零外泄承诺优先于功能完整」。

    注意这里刻意**只给云端 Provider**，模拟校内 GPU 未获批的最坏情况。
    """
    cloud = RecordingProvider("deepseek", "cloud")
    qwen = RecordingProvider("qwen", "cloud")
    # local-lora 完全不注册
    gw = CopilotGateway(base_config, providers={"deepseek": cloud, "qwen": qwen})

    with pytest.raises(ComplianceEgressError) as excinfo:
        gw.chat(chat_request("这是未发表的实验原始数据，帮我分析"))

    assert excinfo.value.status_code == 451
    assert excinfo.value.code == "compliance_egress_blocked"
    assert "不会降级到云端模型" in excinfo.value.message
    # 关键：一个云端调用都没有发出
    assert len(cloud.requests) == 0
    assert len(qwen.requests) == 0


def test_non_sensitive_request_still_works_when_local_missing(base_config):
    """本地不可用不应影响普通请求 —— 只有敏感请求才 451。"""
    cloud = RecordingProvider("deepseek", "cloud")
    gw = CopilotGateway(base_config, providers={"deepseek": cloud})
    result = gw.chat(chat_request("帮我解析一下这句话的意图"))
    assert result.decision.tier_id == "tier-01"
    assert len(cloud.requests) == 1


def test_cloud_provider_rejects_blocked_payload():
    """Provider 层的纵深防御：即使路由层有 bug，云端 Provider 也会拒绝。"""
    from copilot_router.providers import OpenAICompatProvider
    from copilot_router.config import ProviderSpec

    spec = ProviderSpec(
        name="fake-cloud",
        kind="openai_compat",
        display_name="Fake",
        base_url="http://127.0.0.1:9/v1",  # 不会真的被调用
        api_key="dummy",
        api_key_optional=False,
        egress="cloud",
        timeout_seconds=1,
        max_retries=0,
    )
    provider = OpenAICompatProvider(spec)
    from copilot_router.types import ChatMessage

    with pytest.raises(ComplianceEgressError):
        provider.complete(
            [ChatMessage(role="user", content="敏感内容")],
            model="m",
            max_tokens=10,
            temperature=0.0,
            blocked_sensitivity=True,
        )


def test_local_provider_accepts_blocked_payload():
    """本地 Provider 允许处理敏感数据（这正是它存在的理由）。"""
    local = MockProvider("local-lora", "local")
    from copilot_router.types import ChatMessage

    result = local.complete(
        [ChatMessage(role="user", content="敏感内容")],
        model="qwen3.8-7b-lora",
        max_tokens=10,
        temperature=0.0,
        blocked_sensitivity=True,
    )
    assert result.content


# ---------------------------------------------------------------------------
# 客户端声明只能加严
# ---------------------------------------------------------------------------
def test_client_can_escalate_sensitivity(base_config):
    """客户端可主动声明 blocked（它可能知道正文没体现的业务上下文）。"""
    gw = CopilotGateway(
        base_config,
        providers={
            "deepseek": MockProvider("deepseek", "cloud"),
            "local-lora": MockProvider("local-lora", "local"),
        },
    )
    result = gw.chat(
        chat_request("帮我总结这段内容", sensitivity="blocked")
    )
    assert result.decision.tier_id == "tier-04"
    assert result.sensitivity.verdict == "blocked"


def test_client_cannot_downgrade_sensitivity(base_config):
    """客户端声明 clean 不能把真实敏感内容变干净 —— 否则绕过红线太容易。"""
    gw = CopilotGateway(
        base_config,
        providers={
            "deepseek": MockProvider("deepseek", "cloud"),
            "local-lora": MockProvider("local-lora", "local"),
        },
    )
    result = gw.chat(
        chat_request("这是未发表的实验原始数据", sensitivity="clean")
    )
    assert result.sensitivity.verdict == "blocked"
    assert result.decision.tier_id == "tier-04"


# ---------------------------------------------------------------------------
# 与缓存的交互：敏感数据永不进缓存
# ---------------------------------------------------------------------------
def test_sensitive_request_is_never_cached(base_config):
    local = RecordingProvider("local-lora", "local")
    cloud = RecordingProvider("deepseek", "cloud")
    gw = CopilotGateway(
        base_config, providers={"deepseek": cloud, "local-lora": local}
    )

    # 完全相同的敏感请求连发两次
    gw.chat(chat_request("这是未发表的实验原始数据，帮我分析", uid="u1"))
    gw.chat(chat_request("这是未发表的实验原始数据，帮我分析", uid="u1"))

    # 两次都必须真实调用本地模型：不能因为「上次算过」就回放
    assert len(local.requests) == 2, "敏感请求的结果不得缓存复用"
    assert gw.cache is not None
    assert gw.cache.size == 0


def test_sensitive_request_never_shared_across_users(base_config):
    """A 用户的敏感内容不能因为相似度而被 B 用户命中。"""
    local = RecordingProvider("local-lora", "local")
    gw = CopilotGateway(base_config, providers={"local-lora": local})

    gw.chat(chat_request("未发表的实验原始数据，TRPL 衰减", uid="user_a"))
    gw.chat(chat_request("未发表的实验原始数据，TRPL 衰减", uid="user_b"))
    assert len(local.requests) == 2


# ---------------------------------------------------------------------------
# 开关
# ---------------------------------------------------------------------------
def test_scanner_can_be_disabled_but_config_still_valid():
    """enabled=false 时全部判 clean（仅供特殊调试；配置校验仍要求检测器非空）。"""

    def mutate(data):
        data["sensitivity"]["enabled"] = False

    cfg = make_config(mutate)
    scanner = SensitivityScanner(cfg.sensitivity)
    result = scanner.scan("这是未发表的实验原始数据")
    assert result.verdict == "clean"
    assert result.force_local is False


def test_multiple_rules_combine(base_config):
    """同时命中多条规则时，block 级优先。"""
    scanner = SensitivityScanner(base_config.sensitivity)
    text = "未发表的实验原始数据，我的学号 2023010101，api key 是 sk-abcdefghijklmnopqrstuvwx"
    result = scanner.scan(text)
    assert result.verdict == "blocked"
    assert len(result.findings) >= 2
    assert set(result.matched_rule_ids) >= {"S-UNPUB-EXPERIMENT", "S-PII-STUDENT"}
