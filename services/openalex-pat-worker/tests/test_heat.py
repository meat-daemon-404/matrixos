"""热度算法测试（pat-heat/1.0）。

`domain/heat.py` 是纯函数，这是它最大的价值：所有边界都能在不碰网络、
不碰时钟的前提下钉死。

测试重点不是「算出一个数」，而是**算法的不变量**——这些一旦被无意改掉，
早报排序会静默失真，且很难被发现：

1. 权重归一化（配置错误应在 import 期就炸，而不是产出偏移的分数）
2. 硬否决优先于一切（撤稿论文绝不能因为引用高而进早报）
3. 各因子的单调性与边界（越新越热、引用越多越高、源越多越高，但都封顶）
4. 冷启动先验（0 引用拿中性分，新论文不被系统性埋没）
5. 缺失数据降级而非崩溃（冷启动期没有历史库是常态）
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from pat_worker.domain.heat import (
    CROSS_SOURCE_SATURATION,
    DEFAULT_CITATION_BASELINE,
    HARD_VETO_FLAGS,
    HEAT_ALGORITHM_VERSION,
    NEW_PAPER_NEUTRAL,
    RECENCY_CUTOFF_HOURS,
    RECENCY_HALF_LIFE_HOURS,
    VENUE_TIERS,
    WEIGHTS,
    HeatBreakdown,
    PaperSignal,
    citation_velocity_factor,
    cross_source_factor,
    heat_level,
    recency_factor,
    score_heat,
    topic_momentum_factor,
    venue_impact_factor,
)

from .conftest import NOW


# ---------------------------------------------------------------------------
# 不变量：权重与常数
# ---------------------------------------------------------------------------
def test_weights_sum_to_one():
    """权重必须归一化；否则总分会被系统性放大或压缩。"""
    assert sum(WEIGHTS.values()) == pytest.approx(1.0)


def test_all_factors_have_weights():
    expected = {
        "citation_velocity",
        "recency",
        "venue_impact",
        "cross_source",
        "topic_momentum",
    }
    assert set(WEIGHTS) == expected


# ---------------------------------------------------------------------------
# 时效因子
# ---------------------------------------------------------------------------
def test_recency_half_life():
    notes: list[str] = []
    assert recency_factor(NOW, NOW, notes=notes) == pytest.approx(1.0)
    assert recency_factor(NOW - timedelta(hours=RECENCY_HALF_LIFE_HOURS), NOW, notes=notes) == pytest.approx(0.5)
    assert recency_factor(NOW - timedelta(hours=RECENCY_HALF_LIFE_HOURS * 2), NOW, notes=notes) == pytest.approx(0.25)


def test_recency_is_monotonically_decreasing():
    notes: list[str] = []
    values = [
        recency_factor(NOW - timedelta(hours=h), NOW, notes=notes) for h in range(0, 100, 10)
    ]
    assert values == sorted(values, reverse=True), "越老时效分必须越低"


def test_recency_zero_past_cutoff():
    notes: list[str] = []
    value = recency_factor(NOW - timedelta(hours=RECENCY_CUTOFF_HOURS + 1), NOW, notes=notes)
    assert value == 0.0
    assert any("窗口" in n for n in notes), "超窗应留痕"


def test_recency_future_timestamp_is_clamped():
    """未来时间戳通常意味着时区/解析错误：按 0 时效处理并留痕，不能给出 >1 的分数。"""
    notes: list[str] = []
    value = recency_factor(NOW + timedelta(hours=5), NOW, notes=notes)
    assert value == pytest.approx(1.0)
    assert any("时区" in n for n in notes)


# ---------------------------------------------------------------------------
# 引用增速因子
# ---------------------------------------------------------------------------
def test_zero_citation_gets_neutral_not_zero():
    """冷启动先验：新论文 0 引用拿中性分，不被系统性埋没。"""
    notes: list[str] = []
    assert citation_velocity_factor(0, 3.0, notes=notes) == pytest.approx(NEW_PAPER_NEUTRAL)


def test_missing_citation_gets_neutral():
    notes: list[str] = []
    assert citation_velocity_factor(None, 3.0, notes=notes) == pytest.approx(NEW_PAPER_NEUTRAL)
    assert notes, "缺失数据应留痕"


def test_citation_factor_is_monotonic():
    notes: list[str] = []
    values = [citation_velocity_factor(c, 3.0, notes=notes) for c in (0, 1, 5, 20, 100)]
    assert values == sorted(values), "引用越多因子必须越高"


def test_citation_factor_bounded():
    notes: list[str] = []
    for cited in (0, 1, 100, 100000):
        value = citation_velocity_factor(cited, 3.0, notes=notes)
        assert 0.0 <= value <= 1.0


def test_citation_never_below_neutral():
    """任何引用数都不该低于中性值——否则「有引用」反而不如「无数据」。"""
    notes: list[str] = []
    for cited in range(0, 50):
        assert citation_velocity_factor(cited, 3.0, notes=notes) >= NEW_PAPER_NEUTRAL - 1e-9


def test_citation_uses_default_baseline_when_missing():
    notes: list[str] = []
    with_default = citation_velocity_factor(10, None, notes=notes)
    explicit = citation_velocity_factor(10, DEFAULT_CITATION_BASELINE, notes=notes)
    assert with_default == pytest.approx(explicit)


def test_ratio_makes_disciplines_comparable():
    """用比值而非绝对数：物理的小爆款要能与 CS 的大爆款同台竞争。"""
    notes: list[str] = []
    # 物理：20 引 / 基线 4 = 5x
    physics = citation_velocity_factor(20, 4.0, notes=notes)
    # CS：100 引 / 基线 100 = 1x
    cs = citation_velocity_factor(100, 100.0, notes=notes)
    assert physics > cs, "相对增速高的论文应得更高因子，即使绝对引用更低"


# ---------------------------------------------------------------------------
# 期刊影响因子
# ---------------------------------------------------------------------------
def test_venue_tiers_ordered():
    order = ["top_journal", "field_leader", "reputable", "preprint", "unknown", "predatory_risk"]
    values = [VENUE_TIERS[k] for k in order]
    assert values == sorted(values, reverse=True), "期刊档位必须单调递减"
    assert VENUE_TIERS["predatory_risk"] == 0.0


def test_unknown_venue_tier_degrades_gracefully():
    notes: list[str] = []
    assert venue_impact_factor("不存在的档位", notes=notes) == VENUE_TIERS["unknown"]
    assert notes, "未知档位应留痕"


def test_venue_tier_is_case_insensitive():
    notes: list[str] = []
    assert venue_impact_factor("TOP_JOURNAL", notes=notes) == VENUE_TIERS["top_journal"]
    assert venue_impact_factor("  Top_Journal  ", notes=notes) == VENUE_TIERS["top_journal"]


def test_empty_venue_tier_falls_back_unknown():
    notes: list[str] = []
    assert venue_impact_factor("", notes=notes) == VENUE_TIERS["unknown"]


# ---------------------------------------------------------------------------
# 跨源因子
# ---------------------------------------------------------------------------
def test_cross_source_saturates():
    notes: list[str] = []
    assert cross_source_factor(CROSS_SOURCE_SATURATION, notes=notes) == pytest.approx(1.0)
    assert cross_source_factor(CROSS_SOURCE_SATURATION + 10, notes=notes) == pytest.approx(1.0)


def test_single_source_is_not_zero():
    """单一信源仍是合法信号，只是证据弱。给 0 会让单源条目永远无法入选。"""
    notes: list[str] = []
    value = cross_source_factor(1, notes=notes)
    assert 0.0 < value < 0.5
    assert notes, "单源应留痕"


def test_cross_source_is_monotonic():
    notes: list[str] = []
    values = [cross_source_factor(n, notes=notes) for n in (1, 2, 3, 4)]
    assert values == sorted(values)


def test_cross_source_handles_zero_gracefully():
    notes: list[str] = []
    assert cross_source_factor(0, notes=notes) == cross_source_factor(1, notes=notes)


# ---------------------------------------------------------------------------
# 主题势能因子
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("momentum", "expected"),
    [
        (0.5, 0.25),
        (1.0, 0.5),
        (2.0, 0.75),
    ],
)
def test_topic_momentum_mapping(momentum, expected):
    notes: list[str] = []
    assert topic_momentum_factor(momentum, notes=notes) == pytest.approx(expected)


def test_topic_momentum_missing_is_neutral():
    """冷启动期没有历史库是常态，缺失不该让所有条目失分。"""
    notes: list[str] = []
    assert topic_momentum_factor(None, notes=notes) == pytest.approx(0.5)
    assert notes


def test_topic_momentum_zero_and_negative():
    notes: list[str] = []
    assert topic_momentum_factor(0.0, notes=notes) == 0.0
    assert topic_momentum_factor(-1.0, notes=notes) == 0.0


def test_topic_momentum_is_monotonic_and_bounded():
    notes: list[str] = []
    values = [topic_momentum_factor(m, notes=notes) for m in (0.1, 0.5, 1.0, 2.0, 4.0, 10.0)]
    assert values == sorted(values)
    assert all(0.0 <= v <= 1.0 for v in values)


# ---------------------------------------------------------------------------
# 主入口：硬否决与归因
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("flag", sorted(HARD_VETO_FLAGS))
def test_hard_veto_zeroes_score(flag):
    """撤稿/撤稿观察必须归零且不进早报——不管引用多高。"""
    signal = PaperSignal(
        title="Retracted paper",
        published_at=NOW,
        source_count=4,
        cited_by_count=10000,
        citation_baseline=1.0,
        venue_tier="top_journal",
        topic_momentum=5.0,
        flags=frozenset({flag}),
    )
    result = score_heat(signal, NOW)
    assert result.vetoed is True
    assert result.score == 0.0
    assert all(v == 0.0 for v in result.contributions.values())
    assert any("硬否决" in n for n in result.notes)


def test_unknown_flag_does_not_veto():
    signal = PaperSignal(
        title="Normal paper",
        published_at=NOW,
        source_count=3,
        cited_by_count=5,
        venue_tier="top_journal",
        flags=frozenset({"some_other_flag"}),
    )
    result = score_heat(signal, NOW)
    assert result.vetoed is False
    assert result.score > 0


def test_score_is_bounded_0_100():
    signal = PaperSignal(
        title="Best possible paper",
        published_at=NOW,
        source_count=10,
        cited_by_count=100000,
        citation_baseline=1.0,
        venue_tier="top_journal",
        topic_momentum=100.0,
    )
    assert 0.0 <= score_heat(signal, NOW).score <= 100.0


def test_breakdown_is_explainable():
    """前端「为什么它热」面板直接渲染这个结构，字段不能缺。"""
    signal = PaperSignal(
        title="Explainable",
        published_at=NOW,
        source_count=2,
        cited_by_count=10,
        citation_baseline=3.0,
        venue_tier="field_leader",
        topic_momentum=1.5,
    )
    result = score_heat(signal, NOW)
    assert isinstance(result, HeatBreakdown)
    assert set(result.factors) == set(WEIGHTS)
    assert set(result.contributions) == set(WEIGHTS)
    assert all(0.0 <= v <= 1.0 for v in result.factors.values())
    assert result.version == HEAT_ALGORITHM_VERSION


def test_score_equals_weighted_sum_of_contributions():
    """总分必须等于各因子加权贡献之和——归因面板与总分不能对不上。"""
    signal = PaperSignal(
        title="Sum check",
        published_at=NOW - timedelta(hours=6),
        source_count=3,
        cited_by_count=12,
        citation_baseline=3.0,
        venue_tier="field_leader",
        topic_momentum=2.0,
    )
    result = score_heat(signal, NOW)
    recomputed = sum(result.factors[k] * WEIGHTS[k] * 100.0 for k in WEIGHTS)
    assert result.score == pytest.approx(round(recomputed, 1), abs=0.05)


def test_to_dict_is_json_serializable():
    import json

    result = score_heat(
        PaperSignal(title="t", published_at=NOW, source_count=2), NOW
    )
    payload = result.to_dict()
    json.dumps(payload)  # 不抛即合格
    assert payload["version"] == HEAT_ALGORITHM_VERSION


def test_stronger_paper_scores_higher():
    """综合排序方向：顶刊 + 新 + 多源 > preprint + 老 + 单源。"""
    strong = PaperSignal(
        title="strong",
        published_at=NOW,
        source_count=4,
        cited_by_count=50,
        citation_baseline=3.0,
        venue_tier="top_journal",
        topic_momentum=3.0,
    )
    weak = PaperSignal(
        title="weak",
        published_at=NOW - timedelta(hours=100),
        source_count=1,
        cited_by_count=0,
        venue_tier="preprint",
        topic_momentum=0.5,
    )
    assert score_heat(strong, NOW).score > score_heat(weak, NOW).score


def test_minimal_signal_does_not_crash():
    """只有必填字段时也必须给出结果（冷启动期字段普遍缺失）。"""
    result = score_heat(PaperSignal(title="bare", published_at=NOW), NOW)
    assert result.vetoed is False
    assert 0.0 <= result.score <= 100.0


# ---------------------------------------------------------------------------
# 分档
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("score", "level"),
    [(100, "hot"), (75, "hot"), (74.9, "warm"), (55, "warm"), (54.9, "watch"), (0, "watch")],
)
def test_heat_level_boundaries(score, level):
    assert heat_level(score) == level
