"""「与大创课题的契合度」打分。

早报卡片的 `fit.score` 就是这个函数的输出。它是 04 站里唯一**个性化**的因子：
同一篇论文，订阅了「钙钛矿钝化」的学生该看到高分，订阅「引力波」的该看到低分。

为什么不做语义向量匹配：Stage 1 没有 embedding 服务，引入它会把一个纯本地服务
变成依赖 copilot-router 的在线服务（违反架构 §3.1 只向下依赖，也会拖垮 08:00 的
准时率）。因此用「关键词加权命中」这一可解释基线，向量匹配作为 Stage 2 的升级项，
且升级时**接口不变**（仍返回 FitResult）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

#: 标题命中的权重是摘要的 2 倍：标题是作者对「这篇讲了什么」的最高密度陈述。
TITLE_WEIGHT = 2.0
SUMMARY_WEIGHT = 1.0
#: 关键词命中的基础上限。归一化用 min(1, raw/上限) 而非最高分归一化，
#: 这样绝对契合度有意义（「都不太相关」时不该硬凑一个 100 分）。
RAW_SCORE_CAP = 6.0

_CJK = re.compile(r"[\u4e00-\u9fff]")
_TOKEN_SPLIT = re.compile(r"[\s,;，；、/|\-–—_()（）\[\]【】]+")


@dataclass(slots=True)
class FitResult:
    score: int
    basis: str
    terms: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {"score": self.score, "basis": self.basis}
        if self.terms:
            payload["terms"] = self.terms
        return payload


def _normalize(text: str) -> str:
    return text.casefold()


def _keyword_hit(keyword: str, haystack: str, haystack_tokens: set[str]) -> bool:
    """CJK 关键词用子串匹配，拉丁词用词边界匹配。

    为什么要分：`perovskite` 用子串会命中 `perovskites`（想要）但也可能命中
    无关构造；而 CJK 没有词边界概念，`钙钛矿` 必须在 `钙钛矿太阳能电池` 里命中。
    """
    kw = _normalize(keyword).strip()
    if not kw:
        return False
    if _CJK.search(kw):
        return kw in haystack
    if " " in kw:
        # 多词短语整体按子串匹配（如 "charge transport"）
        return kw in haystack
    return kw in haystack_tokens


def tokenize(text: str) -> set[str]:
    return {tok for tok in _TOKEN_SPLIT.split(_normalize(text)) if tok}


def score_fit(
    title: str,
    summary: str = "",
    keywords: list[str] | tuple[str, ...] | None = None,
) -> FitResult:
    """计算契合度。

    `keywords` 为空 → basis="none"，score=0。**这代表「未配置」而不是「不相关」**，
    客户端据此显示「—」。把「未配置」和「0 分」区分开是刻意的：否则新用户会以为
    所有论文都跟他无关。
    """
    if not keywords:
        return FitResult(score=0, basis="none")

    normalized_keywords = [kw.strip() for kw in keywords if kw and kw.strip()]
    if not normalized_keywords:
        return FitResult(score=0, basis="none")

    title_norm = _normalize(title or "")
    summary_norm = _normalize(summary or "")
    title_tokens = tokenize(title or "")
    summary_tokens = tokenize(summary or "")

    raw = 0.0
    matched: list[str] = []
    for kw in normalized_keywords:
        hit_weight = 0.0
        if _keyword_hit(kw, title_norm, title_tokens):
            hit_weight += TITLE_WEIGHT
        if _keyword_hit(kw, summary_norm, summary_tokens):
            hit_weight += SUMMARY_WEIGHT
        if hit_weight > 0:
            raw += hit_weight
            matched.append(kw)

    if raw <= 0:
        return FitResult(score=0, basis="keywords", terms=[])

    score = int(round(min(1.0, raw / RAW_SCORE_CAP) * 100))
    # terms 最多 6 个，且优先展示标题命中的（对用户解释力更强）
    matched.sort(key=lambda kw: (not _keyword_hit(kw, title_norm, title_tokens), kw))
    return FitResult(score=score, basis="keywords", terms=matched[:6])


#: 04 站默认订阅词：光电/物理/材料方向的通用课题词。
#: 真实部署时由用户在 04 站台账里配置，这里只作为「未配置时的合理缺省」，
#: 刻意留空 —— 见 score_fit 的 basis="none" 语义。此常量仅在 demo/CLI 里用。
DEMO_KEYWORDS: tuple[str, ...] = (
    "perovskite",
    "钙钛矿",
    "photodetector",
    "光电探测",
    "ultrafast",
    "超快",
    "quantum dot",
    "量子点",
    "metasurface",
    "超表面",
)
