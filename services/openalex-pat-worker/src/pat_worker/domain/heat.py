"""PAT-HOT 热度评估算法（Bundle 缺口 R12 的落地实现）。

本模块是**纯函数**：输入一个 `PaperSignal`，输出一个可解释的 0–100 分。
没有网络、没有数据库、没有时钟——`now` 必须由调用方传入。这保证算法可单测、
可在回放历史数据时复现、不被环境差异影响。

设计说明见 docs/01-heat-algorithm.md。这里只放可执行定义与不变量。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

HEAT_ALGORITHM_VERSION = "pat-heat/1.0"

# ---------------------------------------------------------------- 权重与常数
#
# 权重取值方法（详见 docs/01-heat-algorithm.md §4）：
# 以「四因子等权 25 分」为起点，再按 04 站的产品语义调整——
# 学生用户每天真正会因此改变行动的因子加权，纯学术声望类因子降权。

WEIGHTS: dict[str, float] = {
    # 引用增速：相对该学科同年基线，衡量「同行当下正在讨论」
    "citation_velocity": 0.22,
    # 时效衰减：24h 窗口内越新越热
    "recency": 0.18,
    # 期刊/信源影响：载体的过滤强度（不是炫耀因子）
    "venue_impact": 0.16,
    # 跨源提及：几个信源同时说到它，是「被看见」的独立证据
    "cross_source": 0.24,
    # 主题势能：所属细分方向本周相对 7 日均值的抬升
    "topic_momentum": 0.20,
}

assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, "权重必须归一化到 1.0"

#: 单因子上限分（归一化后乘 100）
FACTOR_MAX = 100.0

#: 冷启动先验：新论文 0 引用时不是「0 分热度」，而是拿到中性分。
#: 取 0.5 意味着「信息不足 = 中性」，避免新论文被系统性埋没。
NEW_PAPER_NEUTRAL = 0.5

#: 引用增速的基线：学科 × 年份的每篇平均被引（由 OpenAlex 侧提供）。
#: 无法取到时回落到这个全局中位数，宁可粗也不要 NaN。
DEFAULT_CITATION_BASELINE = 3.0

#: 时效半衰期（小时）。24h 窗口内：t=0 → 1.0，t=24 → 0.5。
RECENCY_HALF_LIFE_HOURS = 24.0
#: 超过该小时数的条目时效分强制归零（窗口外内容不该进早报）
RECENCY_CUTOFF_HOURS = 168.0

#: 跨源计数饱和点：≥ 4 个源视为「全网都在说」，封顶满分。
CROSS_SOURCE_SATURATION = 4

#: 期刊影响分档（0–1）。这是「过滤强度」不是 JIF：
#: 顶刊 = 编辑已经替学生做过一轮筛选，所以值得占一个卡位。
VENUE_TIERS: dict[str, float] = {
    "top_journal": 1.0,      # Nature / Science 正刊及子刊、PRL、Nature Photonics
    "field_leader": 0.78,    # 学科内公认强刊（PRB、Optica、ACS Photonics、APL…）
    "reputable": 0.55,       # 稳定 SCI 期刊，有正经同行评审
    "preprint": 0.42,        # arXiv/bioRxiv：时效强但未评审
    "unknown": 0.30,         # 无法判定（缺 ISSN / 新刊）
    "predatory_risk": 0.0,   # 命中预警名单 / 已撤稿：直接判 0
}

#: 撤稿、勘误等硬否决：命中即热度归零并不进早报（与 15 站 retract-radar 对齐）
HARD_VETO_FLAGS = frozenset({"retracted", "withdrawn", "expression_of_concern"})


@dataclass(slots=True)
class PaperSignal:
    """打分所需的全部输入。字段缺失时用 None，由算法决定降级方式。"""

    title: str
    published_at: datetime
    source_count: int = 1
    cited_by_count: int | None = None
    citation_baseline: float | None = None
    venue_tier: str = "unknown"
    topic_momentum: float | None = None
    flags: frozenset[str] = frozenset()
    #: 可选：原始 DOI/arXiv id，仅用于日志与可解释性，不参与计算
    identifier: str = ""


@dataclass(slots=True)
class HeatBreakdown:
    """可解释性载体：每个因子的原始值、归一化值、加权贡献。

    前端「为什么它热」的展开面板直接渲染这个结构，不需要另算。
    """

    score: float
    factors: dict[str, float]
    contributions: dict[str, float]
    vetoed: bool
    notes: list[str] = field(default_factory=list)
    version: str = HEAT_ALGORITHM_VERSION

    def to_dict(self) -> dict[str, object]:
        return {
            "score": self.score,
            "factors": dict(self.factors),
            "contributions": {k: round(v, 3) for k, v in self.contributions.items()},
            "vetoed": self.vetoed,
            "notes": list(self.notes),
            "version": self.version,
        }


def _clamp01(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def citation_velocity_factor(
    cited_by_count: int | None,
    citation_baseline: float | None,
    *,
    notes: list[str],
) -> float:
    """引用增速因子，归一化到 0–1。

    定义：`ratio = cited_by_count / baseline`，其中 baseline 是同学科同年份的
    每篇平均被引（OpenAlex 的 `counts_by_year` 聚合可得）。

    为什么用比值而不是绝对引用数：物理/材料学科的绝对引用数比 CS 低一个量级，
    绝对阈值会让 04 站整体偏向热门学科。比值让「物理里的小爆款」能与「CS 里的大
    爆款」同台竞争。

    映射：ratio=0 → 中性 0.5（新论文不该被埋没），ratio=1 → 0.68，ratio=3 → 0.87，
    ratio→∞ 渐近 1.0。用 `1 - exp(-k·x)` 形态而非线性，因为引用增速的长尾很重：
    线性会让一篇 100 引的论文直接吃满该因子，而它未必真的更热。
    """
    if cited_by_count is None:
        notes.append("引用数缺失，引用增速因子取中性值")
        return NEW_PAPER_NEUTRAL
    baseline = citation_baseline if citation_baseline and citation_baseline > 0 else DEFAULT_CITATION_BASELINE
    if cited_by_count <= 0:
        return NEW_PAPER_NEUTRAL
    ratio = cited_by_count / baseline
    # k=0.45 标定：ratio=1 时 raw≈0.36，叠加中性底后为 0.68，与 venue_impact 的
    # field_leader(0.78) 形成合理梯度——单看引用不该压过期刊过滤。
    raw = 1.0 - math.exp(-0.45 * ratio)
    # 把 [0,1) 的 raw 压到 [NEUTRAL, 1]，保证 0 引用永远不低于中性
    return NEW_PAPER_NEUTRAL + (1.0 - NEW_PAPER_NEUTRAL) * raw


def recency_factor(published_at: datetime, now: datetime, *, notes: list[str]) -> float:
    """时效衰减因子：指数半衰，半衰期 24h。

    `f = 0.5 ** (age_hours / 24)`，即 24h 前发布 → 0.5，48h → 0.25。
    为什么半衰期取 24h：04 站的产品承诺就是「24h 前沿动态」，窗口与之同构；
    窗口外的老论文不该因为刚被 Crossref 索引到就占据早报卡位。
    超过 168h（7 天，回补窗口上限）直接归零。
    """
    age_hours = (now - published_at).total_seconds() / 3600.0
    if age_hours < 0:
        # 未来时间戳通常意味着时区/日期解析错误，按「刚刚发布」处理并留痕
        notes.append("发布时间晚于当前时刻，按 0 时效处理（疑似时区错误）")
        age_hours = 0.0
    if age_hours > RECENCY_CUTOFF_HOURS:
        notes.append(f"条目超过 {RECENCY_CUTOFF_HOURS}h 窗口，时效分归零")
        return 0.0
    return _clamp01(0.5 ** (age_hours / RECENCY_HALF_LIFE_HOURS))


def venue_impact_factor(venue_tier: str, *, notes: list[str]) -> float:
    """期刊影响因子（归一化）。未知档位按 unknown 处理，不猜。"""
    tier = (venue_tier or "unknown").strip().lower()
    if tier not in VENUE_TIERS:
        notes.append(f"未知期刊档位 {venue_tier!r}，按 unknown 计")
        tier = "unknown"
    return VENUE_TIERS[tier]


def cross_source_factor(source_count: int, *, notes: list[str]) -> float:
    """跨源提及因子：对数饱和。

    定义：`f = log2(1 + n) / log2(1 + 4)`，n 为独立信源数，4 个源封顶满分。
    为什么用 log 而不是线性：第 2 个源带来的信息量远大于第 4 个源。
    为什么 n=1 不是 0 分：单一信源仍是合法信号，只是证据强度弱；
    给 1 源 0.39 分，给 4 源满分，保证「多源共振」有显著优势但不独占。
    """
    n = max(1, int(source_count))
    value = math.log2(1 + n) / math.log2(1 + CROSS_SOURCE_SATURATION)
    if n == 1:
        notes.append("仅单一信源，跨源因子按最小证据强度计")
    return _clamp01(value)


def topic_momentum_factor(momentum: float | None, *, notes: list[str]) -> float:
    """主题势能因子。

    `momentum` 定义：该主题本周发文量 / 该主题近 8 周周均发文量（由 OpenAlex
    的 topic 聚合或本地历史库算出）。1.0 = 与平时持平。

    映射：0.5× → 0.25，1× → 0.5，2× → 0.75，3× 及以上 → 1.0。
    缺失时不惩罚（给中性 0.5）——冷启动期没有历史库是常态，不该让所有条目失分。
    """
    if momentum is None:
        notes.append("主题势能缺失（历史库未暖机），取中性值")
        return 0.5
    if momentum <= 0:
        return 0.0
    # 以 1.0 为锚点的分段线性，避免 log 在 0 附近爆炸
    if momentum <= 1.0:
        return _clamp01(0.5 * momentum)
    return _clamp01(0.5 + 0.25 * math.log2(momentum))


def score_heat(signal: PaperSignal, now: datetime) -> HeatBreakdown:
    """主入口。返回 0–100 分与完整归因。"""
    notes: list[str] = []

    if signal.flags & HARD_VETO_FLAGS:
        hit = sorted(signal.flags & HARD_VETO_FLAGS)
        notes.append(f"硬否决：命中 {', '.join(hit)}，热度归零且不进早报")
        return HeatBreakdown(
            score=0.0,
            factors={name: 0.0 for name in WEIGHTS},
            contributions={name: 0.0 for name in WEIGHTS},
            vetoed=True,
            notes=notes,
        )

    factors = {
        "citation_velocity": citation_velocity_factor(
            signal.cited_by_count, signal.citation_baseline, notes=notes
        ),
        "recency": recency_factor(signal.published_at, now, notes=notes),
        "venue_impact": venue_impact_factor(signal.venue_tier, notes=notes),
        "cross_source": cross_source_factor(signal.source_count, notes=notes),
        "topic_momentum": topic_momentum_factor(signal.topic_momentum, notes=notes),
    }
    contributions = {name: factors[name] * WEIGHTS[name] * FACTOR_MAX for name in WEIGHTS}
    total = sum(contributions.values())
    return HeatBreakdown(
        score=round(_clamp01(total / FACTOR_MAX) * FACTOR_MAX, 1),
        factors={k: round(v, 4) for k, v in factors.items()},
        contributions=contributions,
        vetoed=False,
        notes=notes,
    )


def heat_level(score: float) -> str:
    """热度分档，供 UI 上色。阈值与合同 schema 的 heat_level 枚举一致。"""
    if score >= 75:
        return "hot"
    if score >= 55:
        return "warm"
    return "watch"
