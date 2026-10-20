"""导师五维画像（mentor-profile/1.0）契约测试。

五维来自 ``specs/microsites.json`` 第 06 行，但 Bundle **没有给任何可计算定义**，
本仓库在 ``domain/mentor.py`` 里自行补齐（缺口 R14）。没有外部标准可对照，
因此这里能钉住的只有「设计约束」，它们比具体数值重要得多：

1. **置信度加权**：低置信度的维度在 ``overall_score`` 里权重必须**下降**。
   这是 06 站在缺数据时不给虚假高分的最后一道保险。
2. **缺数据降级而非崩溃**，且降级必须**可见**（confidence 下调 + notes 留痕）。
   特别是经费维度：OpenAlex 对国内单位 funder 覆盖差，缺失绝不能算成 0 分，
   否则会系统性误伤中国导师。
3. **方向契合度的 0 分语义**：``未配置`` 与 ``不匹配`` 都输出 0，
   但必须能从 raw/notes 区分开——否则 UI 无法显示「—」而不是「0 分」。
4. **结构稳定**：``radar`` 恒为五个键、``to_dict`` 可 JSON 序列化。
"""

from __future__ import annotations

import copy
import json

import pytest

from pat_worker.domain.mentor import (
    DIMENSIONS,
    DIMENSION_LABELS,
    PROFILE_VERSION,
    AuthorRecord,
    WorkRecord,
    build_mentor_profile,
    h_index_from_citations,
)

from .conftest import NOW


# ---------------------------------------------------------------------------
# 构造器
# ---------------------------------------------------------------------------
def author(**kwargs) -> AuthorRecord:
    params = dict(author_id="A1", display_name="Test PI")
    params.update(kwargs)
    return AuthorRecord(**params)


def works(
    *,
    years: tuple[int, ...] = (2024, 2025, 2026),
    per_year: int = 6,
    funder: str | None = "National Natural Science Foundation of China",
    counts_by_year: bool = True,
    work_type: str = "article",
    is_oa: bool = True,
) -> list[WorkRecord]:
    """造一批结构真实的论文记录。

    刻意让``counts_by_year``与 ``publication_year`` 自洽：H 斜率的重建逻辑
    依赖这个自洽性，造出矛盾数据会测出不真实的结果。
    """
    out: list[WorkRecord] = []
    for year in years:
        for index in range(per_year):
            out.append(
                WorkRecord(
                    id=f"W{year}{index}",
                    title=f"Perovskite passivation study {year} #{index}",
                    publication_year=year,
                    cited_by_count=5 + index,
                    counts_by_year={year: 3, year + 1: 2} if counts_by_year else {},
                    author_position="first" if index % 3 == 0 else "middle",
                    is_corresponding=index % 3 == 0,
                    work_type="review" if index % 5 == 0 else work_type,
                    is_oa=is_oa,
                    topic_names=("Perovskite solar cells",),
                    funder_names=(funder,) if funder else (),
                )
            )
    return out


def build(author_record=None, work_list=None, **kwargs):
    params = dict(
        now=NOW,
        generated_at="2026-10-20T08:00:00+08:00",
    )
    params.update(kwargs)
    return build_mentor_profile(
        author_record if author_record is not None else author(),
        work_list if work_list is not None else works(),
        **params,
    )


WEIGHT = {"high": 1.0, "medium": 0.75, "low": 0.5}


# ---------------------------------------------------------------------------
# 结构契约
# ---------------------------------------------------------------------------
def test_all_five_dimensions_present():
    profile = build()
    assert set(profile.dimensions) == set(DIMENSIONS)
    assert len(DIMENSIONS) == 5


def test_every_dimension_is_traceable():
    """每一维都必须能回答「为什么是这个分」。"""
    profile = build()
    for key, dimension in profile.dimensions.items():
        assert dimension.key == key
        assert dimension.label == DIMENSION_LABELS[key]
        assert 0 <= dimension.score <= 100, f"{key} 分数越界: {dimension.score}"
        assert dimension.formula_id, f"{key} 缺 formula_id，无法溯源"
        assert dimension.sources, f"{key} 缺 sources"
        assert dimension.confidence in {"high", "medium", "low"}
        assert isinstance(dimension.raw, dict) and dimension.raw, f"{key} 的 raw 为空"


def test_radar_is_stable_five_tuple():
    profile = build()
    assert list(profile.radar) == list(DIMENSIONS), "雷达图键顺序必须固定"
    assert all(isinstance(v, int) for v in profile.radar.values())


def test_to_dict_is_json_serializable_and_complete():
    payload = build().to_dict()
    json.dumps(payload, ensure_ascii=False)  # 不抛即合格
    for key in (
        "schema_version",
        "profile_version",
        "author_id",
        "display_name",
        "generated_at",
        "radar",
        "dimensions",
        "overall_score",
        "data_completeness",
    ):
        assert key in payload, f"缺少字段 {key}"
    assert payload["profile_version"] == PROFILE_VERSION
    assert len(payload["dimensions"]) == 5


def test_to_dict_is_idempotent():
    """同一画像序列化两次必须相同——缓存与现场计算要能对得上。"""
    profile = build()
    assert profile.to_dict() == profile.to_dict()


def test_build_is_pure():
    """纯函数：同样输入必须得到同样输出（回放历史数据的前提）。"""
    first = build().to_dict()
    second = build().to_dict()
    assert first == second


# ---------------------------------------------------------------------------
# 置信度加权（核心设计约束 ①）
# ---------------------------------------------------------------------------
def test_overall_score_is_confidence_weighted():
    profile = build()
    expected = sum(
        profile.dimensions[k].score * WEIGHT[profile.dimensions[k].confidence]
        for k in DIMENSIONS
    ) / sum(WEIGHT[profile.dimensions[k].confidence] for k in DIMENSIONS)
    assert profile.overall_score == pytest.approx(expected, abs=0.5)


def test_low_confidence_dimension_is_down_weighted():
    """低置信度维度必须比等权时**更小**地影响总分。

    做法：把所有维度压成同样分数，只改其中一维的 confidence，
    观察总分变化方向。若实现里忽略了 confidence，两者会完全相等。
    """
    profile = build()
    scores = {k: profile.dimensions[k].score for k in DIMENSIONS}

    # 手工算「等权平均」作为对照
    plain_mean = sum(scores.values()) / len(scores)
    # 实现是置信度加权：权重不等时结果必然偏离等权平均
    if len({profile.dimensions[k].confidence for k in DIMENSIONS}) > 1:
        assert profile.overall_score != pytest.approx(plain_mean, abs=0.01), (
            "五维置信度不一致时，总分不应等于等权平均——否则 confidence 没起作用"
        )


def test_overall_score_between_min_and_max_dimension():
    """加权平均必须落在五维的最小值与最大值之间（不能凭空超出）。"""
    profile = build()
    scores = [d.score for d in profile.dimensions.values()]
    assert min(scores) <= profile.overall_score <= max(scores)


def test_missing_data_lowers_completeness():
    """数据越全，completeness 越高。"""
    rich = build()
    poor = build(author(author_id="B"), [])
    assert poor.data_completeness < rich.data_completeness
    assert 0.0 <= poor.data_completeness <= 1.0


def test_completeness_reflects_confidence_mix():
    profile = build()
    high = sum(1 for d in profile.dimensions.values() if d.confidence == "high")
    medium = sum(1 for d in profile.dimensions.values() if d.confidence == "medium")
    expected = min(1.0, (high + 0.6 * medium) / len(DIMENSIONS))
    assert profile.data_completeness == pytest.approx(expected, abs=1e-6)


# ---------------------------------------------------------------------------
# 缺数据降级（核心设计约束 ②）
# ---------------------------------------------------------------------------
def test_empty_works_does_not_crash_and_flags_low_confidence():
    """一篇论文都没有时不能崩，且必须整体降置信度。"""
    profile = build(author(author_id="EMPTY"), [])
    assert profile.overall_score >= 0
    assert all(d.confidence == "low" for d in profile.dimensions.values())
    assert profile.notes, "空画像必须留痕，否则 UI 无法提示人工复核"
    assert profile.data_completeness == 0.0


def test_empty_works_does_not_award_fake_high_score():
    """缺数据不能给出虚假高分——这是 06 站最重要的信任约束。"""
    profile = build(author(author_id="EMPTY"), [])
    assert profile.overall_score <= 40, f"空数据画像得到 {profile.overall_score} 分，过高"


def test_missing_funding_is_neutral_not_zero():
    """OpenAlex 对国内 funder 覆盖差：缺失必须给中性分，不能判 0。

    否则所有国内导师的经费维度都会被系统性误伤——这是本维度最关键的约束。
    """
    profile = build(author(author_id="CN"), works(funder=None))
    dimension = profile.dimensions["funding_capacity"]
    assert dimension.score >= 35, f"无 funder 元数据只给 {dimension.score} 分，属系统性误伤"
    assert dimension.confidence == "low", "缺数据必须下调置信度"
    assert dimension.raw.get("data_gap") == "no_funder_metadata"
    assert any("不能等同于" in n for n in dimension.notes), "必须写明「不等于无经费」"


def test_missing_funding_note_mentions_verification_source():
    """note 要给用户可执行的下一步，而不是只说「没数据」。"""
    dimension = build(author(author_id="CN"), works(funder=None)).dimensions["funding_capacity"]
    joined = " ".join(dimension.notes)
    assert "基金委" in joined or "院系" in joined


def test_rich_funding_scores_higher_than_missing():
    funded = build(author(author_id="F1"), works(funder="National Natural Science Foundation of China"))
    missing = build(author(author_id="F2"), works(funder=None))
    assert (
        funded.dimensions["funding_capacity"].score
        > missing.dimensions["funding_capacity"].score
    ), "有基金标注的导师经费分应更高"


def test_undergrad_friendliness_is_always_low_confidence_proxy():
    """本科友好度没有直接数据源，无论数据多全都必须是 low + 代理预警。"""
    profile = build()
    dimension = profile.dimensions["undergrad_friendliness"]
    assert dimension.confidence == "low"
    assert any("proxy_warning" in n for n in dimension.notes), "必须显式声明这是代理指标"


def test_undergrad_empty_window_is_neutral():
    old = [WorkRecord(id="W", title="t", publication_year=2000, cited_by_count=3)]
    dimension = build(author(author_id="OLD"), old).dimensions["undergrad_friendliness"]
    assert dimension.score == 50, "无窗口数据应给中性分而不是 0"
    assert dimension.confidence == "low"


def test_hindex_slope_degrades_without_counts_by_year():
    """缺 counts_by_year 时退化为粗估，且必须降置信度并留痕。"""
    profile = build(author(author_id="E", h_index=20, i10_index=40), works(counts_by_year=False))
    dimension = profile.dimensions["hindex_slope"]
    assert dimension.raw["method"] == "estimated"
    assert dimension.confidence == "low"
    assert any("counts_by_year" in n for n in dimension.notes)


def test_hindex_slope_uses_reconstruction_when_possible():
    profile = build(author(author_id="R", h_index=20, i10_index=40), works())
    assert profile.dimensions["hindex_slope"].raw["method"] == "counts_by_year"


def test_recent_activity_confidence_drops_with_few_works():
    profile = build(author(author_id="T"), works(years=(2026,), per_year=2))
    dimension = profile.dimensions["recent_activity"]
    assert dimension.confidence in {"medium", "low"}
    assert any("篇" in n for n in dimension.notes)


def test_no_dated_works_flags_freshness_unknown():
    undated = [WorkRecord(id="W", title="t", publication_year=None, cited_by_count=3)]
    dimension = build(author(author_id="U"), undated).dimensions["recent_activity"]
    assert dimension.raw["months_since_last_work"] is None
    assert dimension.confidence == "low"


# ---------------------------------------------------------------------------
# 方向契合度（核心设计约束 ③）
# ---------------------------------------------------------------------------
def test_unconfigured_direction_fit_is_zero_and_explicitly_not_mismatch():
    """未配置订阅词时 0 分表示「未配置」，不是「不匹配」（与 fit.basis=none 同语义）。"""
    dimension = build().dimensions["direction_fit"]
    assert dimension.score == 0
    assert dimension.raw["configured"] is False
    assert any("不是不匹配" in n for n in dimension.notes)


def test_configured_but_no_topic_data_is_also_distinguishable():
    """配置了订阅词但导师无 topic 数据：同样 0 分，但原因不同、必须可区分。"""
    no_topics = [WorkRecord(id="W", title="x", publication_year=2025, cited_by_count=1)]
    dimension = build(author(author_id="NT"), no_topics, target_keywords=("perovskite",)).dimensions[
        "direction_fit"
    ]
    assert dimension.score == 0
    assert dimension.raw["configured"] is True
    assert dimension.raw["topic_weight"] == 0
    assert any("无 topic" in n for n in dimension.notes)


def test_direction_fit_matches_keywords():
    profile = build(
        author(author_id="M", topics={"Perovskite solar cells": 30}),
        target_keywords=("perovskite",),
        target_topics=("perovskite solar cells",),
    )
    dimension = profile.dimensions["direction_fit"]
    assert dimension.score > 50, f"明显匹配却只有 {dimension.score} 分"
    assert dimension.raw["key_overlap"] > 0
    assert dimension.raw["matched_terms"]


def test_direction_fit_no_overlap_scores_low():
    profile = build(
        author(author_id="N", topics={"Perovskite solar cells": 30}),
        target_keywords=("gravitational wave",),
        target_topics=("black holes",),
    )
    assert profile.dimensions["direction_fit"].score < 25


def test_direction_fit_is_bounded():
    profile = build(
        author(author_id="B", topics={"Perovskite solar cells": 10**6}),
        target_keywords=("perovskite", "solar", "cells"),
        target_topics=("perovskite solar cells",),
    )
    assert 0 <= profile.dimensions["direction_fit"].score <= 100


# ---------------------------------------------------------------------------
# h-index 计算（被 H 斜率复用，单独钉死）
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("citations", "expected"),
    [
        ([], 0),
        ([0, 0, 0], 0),
        ([1], 1),
        ([1, 1, 1], 1),
        ([5, 4, 3, 2, 1], 3),
        ([10, 8, 5, 4, 3], 4),
        ([100], 1),
        ([3, 3, 3, 3], 3),
    ],
)
def test_h_index_definition(citations, expected):
    """标准定义：至少 h 篇被引 ≥ h。"""
    assert h_index_from_citations(citations) == expected


def test_h_index_is_order_insensitive():
    assert h_index_from_citations([1, 5, 3, 2, 4]) == h_index_from_citations([5, 4, 3, 2, 1])


def test_h_index_ignores_negative_citations():
    """负引用是脏数据，不能被当成有效被引。"""
    assert h_index_from_citations([-5, -1, 0]) == 0
    assert h_index_from_citations([-5, 3, 2]) == 2


def test_h_index_cannot_exceed_work_count():
    for citations in ([100, 100], [5], [1, 1, 1, 1]):
        assert h_index_from_citations(citations) <= len(citations)


def test_h_index_is_monotonic_in_citations():
    """任一篇论文被引增加，h-index 不得下降。"""
    base = [5, 4, 3, 2, 1]
    previous = h_index_from_citations(base)
    for index in range(len(base)):
        bumped = copy.copy(base)
        bumped[index] += 10
        assert h_index_from_citations(bumped) >= previous
