"""敏感数据识别 —— 合规红线。

依据：
- docs/01-plan/01-architecture.md §6.4 端侧隐私仓边界（未发表实验原始数据 → 端侧 IDB）
- docs/01-plan/04-tech-decisions.md ADR-05（零外泄承诺）
- docs/01-plan/05-risks.md R-C01（学生个人信息与学术数据合规）
- 任务书第 5 条：检测到未发表实验数据特征时**强制路由到 TIER 04 本地**并拒绝发往云端

三档判定（``SensitivityVerdict``）：

===========  ==========================================  ===========================
verdict      含义                                        路由后果
===========  ==========================================  ===========================
clean        无特征                                      正常路由
restricted   命中 warn 级规则（如学生个人信息、草稿）    优先 TIER 04；本地不可用可上云
                                                         但响应显式告警；永不跨用户共享缓存
blocked      命中 block 级规则（未发表实验数据、凭据）   **强制 TIER 04 且拒绝上云**；
                                                         本地不可用 → 451 明确报错
===========  ==========================================  ===========================

设计取舍（必须诚实说明）：

1. 判定是**规则驱动**（关键词 + 正则 + 权重），不是语义模型判定。
   理由：判定本身若调云端模型，就等于「先把敏感数据发出去再判断能不能发出去」，
   自相矛盾；而调本地模型会占用 TIER 04 的稀缺算力，且增加延迟。
   规则的代价是**可能漏判改写过的表述**，所以：
   - 客户端可以用 ``matrix.sensitivity`` 主动声明（只取更严格者，不能用来降级）；
   - 规则表放在 ``config/tiers.yaml``，可随真实语料迭代，不必改代码。

2. 命中后**绝不记录命中原文**（``SensitivityFinding`` 只有规则 ID 与类别），
   因为命中片段本身就是敏感数据，留痕会变成新的泄漏面（架构 §8 审计要求
   「不含 payload 正文」的思路一致）。

3. ``severity=block`` 一旦命中就 blocked，不做「权重累加够阈值才算」的模糊判断 ——
   合规红线不允许有置信度折扣。
"""

from __future__ import annotations

import re

from .config import DetectionRule, SensitivitySpec
from .types import SensitivityFinding, SensitivityResult, SensitivityVerdict

_REGEX_CACHE: dict[str, re.Pattern[str]] = {}


def _compiled(pattern: str) -> re.Pattern[str]:
    cached = _REGEX_CACHE.get(pattern)
    if cached is None:
        cached = re.compile(pattern)
        _REGEX_CACHE[pattern] = cached
    return cached


class SensitivityScanner:
    """按配置规则扫描文本，输出三档 verdict。"""

    def __init__(self, spec: SensitivitySpec) -> None:
        self._spec = spec
        # 预编译，避免每次请求重复编译（正则是热点路径）
        self._rules: list[tuple[DetectionRule, list[re.Pattern[str]]]] = [
            (rule, [_compiled(p) for p in rule.regex]) for rule in spec.detectors
        ]

    # -- 单规则匹配 -------------------------------------------------------
    def _match_rule(self, rule: DetectionRule, patterns: list[re.Pattern[str]], text: str) -> bool:
        lowered = text.lower()
        for keyword in rule.keywords:
            if keyword.lower() in lowered:
                return True
        return any(pattern.search(text) for pattern in patterns)

    # -- 主入口 -----------------------------------------------------------
    def scan(self, text: str) -> SensitivityResult:
        if not self._spec.enabled:
            return SensitivityResult(
                verdict="clean", findings=[], force_local=False, cache_shareable=True
            )

        findings: list[SensitivityFinding] = []
        score = 0.0
        for rule, patterns in self._rules:
            if not self._match_rule(rule, patterns, text):
                continue
            findings.append(
                SensitivityFinding(
                    rule_id=rule.rule_id,
                    name=rule.name,
                    category=rule.category,
                    severity=rule.severity,  # type: ignore[arg-type]
                    reason=rule.reason,
                    score=rule.weight,
                )
            )
            score += rule.weight

        if not findings:
            return SensitivityResult(
                verdict="clean", findings=[], force_local=False, cache_shareable=True
            )

        # block 级规则一命中即红线，不做阈值折扣
        has_block = any(f.severity == "block" for f in findings)
        if has_block or score >= self._spec.block_threshold:
            verdict: SensitivityVerdict = "blocked"
        elif score >= self._spec.warn_threshold:
            verdict = "restricted"
        else:
            # 权重过低的命中不足以改变路由，但仍然留痕（便于后续调参）
            verdict = "clean"

        return SensitivityResult(
            verdict=verdict,
            findings=findings,
            force_local=verdict in {"blocked", "restricted"},
            # 任何命中都不允许跨用户共享缓存（即便只是 warn 级）
            cache_shareable=False,
        )

    # -- 客户端声明合并 ---------------------------------------------------
    def merge_client_declaration(
        self,
        local: SensitivityResult,
        declared: SensitivityVerdict | None,
    ) -> SensitivityResult:
        """客户端自报敏感度只会让判定**更严格**，绝不更宽松。

        理由：客户端可能知道服务端规则没覆盖的业务上下文（例如「这是审稿中稿件」
        但正文里没有出现关键词）。允许放宽是危险的 —— 任何一个微站被攻破，
        攻击者就能声明 ``clean`` 把未发表数据发上云。
        """
        if not self._spec.honor_client_declaration or declared is None:
            return local
        order = {"clean": 0, "restricted": 1, "blocked": 2}
        if order[declared] <= order[local.verdict]:
            return local
        merged = SensitivityResult(
            verdict=declared,
            findings=list(local.findings),
            force_local=True,
            cache_shareable=False if declared != "clean" else local.cache_shareable,
        )
        return merged
