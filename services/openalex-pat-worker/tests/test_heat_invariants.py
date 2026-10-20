"""热度算法（pat-heat/1.0）的**补强不变量**。

``test_heat.py`` 已经钉死了单因子的边界与映射。本文件只补它没覆盖的那几类，
它们都属于「改了不会报错，但早报排序会静默失真」的风险：

1. **综合单调性**（不是单因子）：用户真正看到的排序是 ``score_heat`` 的组合结果。
   单因子单调不代表组合单调——权重配错、或某个因子反向，只有综合层面才暴露。
2. **归一化边界**：极端输入（深负值、巨大值、饱和）都必须落在 [0,100]，
   且分档函数 ``heat_level`` 与之自洽。
3. **确定性**：同样输入必须得到同样输出（回放历史数据的前提）。
4. **硬否决的传染范围**：归并阶段可能把撤稿标记并到别的条目上，
   必须保证「只要命中就归零」，且**不因其他因子很强而漏判**。
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

import pytest

from pat_worker.domain.heat import (
    FACTOR_MAX,
    HARD_VETO_FLAGS,
    HEAT_ALGORITHM_VERSION,
    NEW_PAPER_NEUTRAL,
    VENUE_TIERS,
    WEIGHTS,
    PaperSignal,
    heat_level,
    score_heat,
)

from .conftest import NOW


def heat(**kwargs) -> float:
    """构造一条信号并返回分数。默认值是一个「中庸但有效」的条目。"""
    params = dict(
        title="t",
        published_at=NOW - timedelta(hours=2),
        source_count=1,
        cited_by_count=0,
        citation_baseline=3.0,
        venue_tier="reputable",
        topic_momentum=1.0,
    )
    params.update(kwargs)
    return score_heat(PaperSignal(**params), NOW).score


# ---------------------------------------------------------------------------
# 综合单调性：用户看到的是组合分，不是单因子
# ---------------------------------------------------------------------------
def test_more_citations_never_lower_total_score():
    """引用更多 → 总分不低于原来（其余条件固定）。"""
    scores = [heat(cited_by_count=c) for c in (0, 1, 2, 5, 10, 25, 50, 100)]
    assert scores == sorted(scores), f"引用增加导致总分下降: {scores}"


def test_newer_never_lowers_total_score():
    """越新 → 总分不低于原来。"""
    scores = [heat(published_at=NOW - timedelta(hours=h)) for h in (0, 2, 6, 12, 24, 48, 96)]
    assert scores == sorted(scores, reverse=True), f"越老分数反而越高: {scores}"


def test_more_sources_never_lower_total_score():
    scores = [heat(source_count=n) for n in (1, 2, 3, 4, 8)]
    assert scores == sorted(scores), f"信源增加导致总分下降: {scores}"


def test_higher_venue_tier_never_lowers_total_score():
    order = ["predatory_risk", "unknown", "preprint", "reputable", "field_leader", "top_journal"]
    scores = [heat(venue_tier=t) for t in order]
    assert scores == sorted(scores), f"期刊档位越高分数反而越低: {list(zip(order, scores))}"


def test_higher_momentum_never_lowers_total_score():
    scores = [heat(topic_momentum=m) for m in (0.0, 0.5, 1.0, 2.0, 4.0)]
    assert scores == sorted(scores), f"主题势能增加导致总分下降: {scores}"


def test_cross_source_beats_single_source_all_else_equal():
    """跨源共振必须带来**可观测**的优势，而不是被权重抹平。

    这不是单调性的推论：如果 ``cross_source`` 权重被改到接近 0，
    单调性仍然成立，但「多源共振」这个产品语义就没了。
    """
    assert heat(source_count=4) - heat(source_count=1) >= 5.0


# ---------------------------------------------------------------------------
# 归一化边界
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "kwargs",
    [
        {"cited_by_count": 0, "source_count": 1, "venue_tier": "predatory_risk", "topic_momentum": 0.0},
        {"cited_by_count": 10**9, "source_count": 10**6, "venue_tier": "top_journal", "topic_momentum": 10**6},
        {"cited_by_count": None, "topic_momentum": None},
        {"citation_baseline": 0.0, "cited_by_count": 5},
        {"citation_baseline": -1.0, "cited_by_count": 5},
        {"published_at": NOW - timedelta(days=3650)},
        {"published_at": NOW + timedelta(days=1)},
    ],
    ids=[
        "all-minimum",
        "all-huge",
        "all-missing",
        "zero-baseline",
        "negative-baseline",
        "ancient",
        "future",
    ],
)
def test_score_always_within_0_100(kwargs):
    score = heat(**kwargs)
    assert 0.0 <= score <= 100.0, f"{kwargs} → {score} 越界"


def test_output_has_single_decimal_precision():
    """契约声明 heat 为一位小数。多给位数会让「重跑得到同一 digest」更难成立。"""
    for cited in (0, 7, 33, 250):
        score = heat(cited_by_count=cited, source_count=3, topic_momentum=1.7)
        assert round(score, 1) == score, f"{score} 超过一位小数"


def test_empty_input_never_crashes():
    """只有必填字段时也必须出结果——冷启动期字段普遍缺失。"""
    result = score_heat(PaperSignal(title="", published_at=NOW), NOW)
    assert result.vetoed is False
    assert 0.0 <= result.score <= 100.0
    assert set(result.factors) == set(WEIGHTS)


def test_heat_level_partitions_the_full_range():
    """分档必须覆盖 0–100 且不重叠：UI 上色不能出现「无档可归」。"""
    seen = set()
    for step in range(0, 1001):
        seen.add(heat_level(step / 10))
    assert seen == {"hot", "warm", "watch"}, f"分档未覆盖全区间: {seen}"


def test_heat_level_monotonic():
    """分数越高档位不得下降。"""
    rank = {"watch": 0, "warm": 1, "hot": 2}
    levels = [rank[heat_level(s)] for s in range(0, 101)]
    assert levels == sorted(levels)


# ---------------------------------------------------------------------------
# 确定性与可解释性
# ---------------------------------------------------------------------------
def test_scoring_is_deterministic():
    """同样输入必须得到同样输出——否则早报回放与 digest_id 都无法成立。"""
    kwargs = dict(source_count=3, cited_by_count=12, topic_momentum=2.5)
    assert heat(**kwargs) == heat(**kwargs)


def test_veto_is_deterministic_and_complete():
    """硬否决的归因结构必须完整（前端展开面板直接渲染）。"""
    signal = PaperSignal(
        title="retracted",
        published_at=NOW,
        source_count=99,
        cited_by_count=10**6,
        venue_tier="top_journal",
        topic_momentum=1000.0,
        flags=frozenset(HARD_VETO_FLAGS),
    )
    result = score_heat(signal, NOW)
    assert result.score == 0.0 and result.vetoed is True
    assert result.version == HEAT_ALGORITHM_VERSION
    assert set(result.factors) == set(WEIGHTS)
    assert set(result.contributions) == set(WEIGHTS)


def test_veto_wins_over_every_positive_signal():
    """逐项证明「否决优先」不是碰巧——把每个正向因子顶满仍然 0 分。"""
    best = PaperSignal(
        title="best possible",
        published_at=NOW,
        source_count=10,
        cited_by_count=10**6,
        citation_baseline=1.0,
        venue_tier="top_journal",
        topic_momentum=1000.0,
    )
    assert score_heat(best, NOW).score > 90.0, "前提：该信号本身应接近满分"
    for flag in sorted(HARD_VETO_FLAGS):
        vetoed = replace(best, flags=frozenset({flag}))
        assert score_heat(vetoed, NOW).score == 0.0


def test_contributions_sum_matches_score_for_extremes():
    """归因面板的加权和必须始终等于总分（含浮点极值）。"""
    for cited in (0, 3, 10**6):
        signal = PaperSignal(
            title="t",
            published_at=NOW,
            source_count=4,
            cited_by_count=cited,
            citation_baseline=3.0,
            venue_tier="field_leader",
            topic_momentum=3.0,
        )
        result = score_heat(signal, NOW)
        recomputed = sum(result.factors[k] * WEIGHTS[k] * FACTOR_MAX for k in WEIGHTS)
        assert result.score == pytest.approx(round(recomputed, 1), abs=0.05)


def test_zero_citation_paper_is_not_buried():
    """冷启动先验的产品含义：全新论文不该因为 0 引用就永远排不上去。

    用「顶刊 + 今天 + 多源」的 0 引论文验证它仍能进入 hot/warm 区间。
    """
    score = heat(
        source_count=4,
        cited_by_count=0,
        venue_tier="top_journal",
        topic_momentum=1.0,
        published_at=NOW,
    )
    assert score >= 55.0, f"0 引用的顶刊新论文只有 {score} 分，会被系统性埋没"


def test_predatory_venue_cannot_reach_hot_alone():
    """预警名单期刊不该单靠时效/多源冲到 hot——那是「过滤强度」的语义。"""
    score = heat(
        venue_tier="predatory_risk",
        source_count=4,
        cited_by_count=0,
        topic_momentum=3.0,
        published_at=NOW,
    )
    assert score < 75.0, f"predatory_risk 期刊得到 {score} 分，档位语义被架空"


def test_weights_are_positive_and_sum_to_one():
    """权重是归一化的：总和不为 1 会让总分被系统性放大/压缩。"""
    assert all(w > 0 for w in WEIGHTS.values()), "不允许 0 或负权重（等于关掉该因子）"
    assert sum(WEIGHTS.values()) == pytest.approx(1.0)


def test_neutral_prior_is_actually_neutral():
    """``NEW_PAPER_NEUTRAL`` 必须在 [0,1] 且不是 0（0 就等于惩罚新论文）。"""
    assert 0.0 < NEW_PAPER_NEUTRAL < 1.0


def test_venue_tiers_are_normalized():
    """档位值必须在 [0,1]，只有 predatory_risk 允许为 0。"""
    for name, value in VENUE_TIERS.items():
        assert 0.0 <= value <= 1.0, f"{name}={value} 越界"
    zero = {k for k, v in VENUE_TIERS.items() if v == 0.0}
    assert zero == {"predatory_risk"}
