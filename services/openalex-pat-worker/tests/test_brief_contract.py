"""早报输出必须通过 ``specs/contracts/morning-brief.schema.json`` 校验。

这是本服务**唯一真正的跨端契约**：微信小程序（apps/wechat-pocket）按它渲染，
matrix-core 按它调度。字段多一个（``additionalProperties: false``）或类型错一点，
线上就是一个白屏。因此这里校验的是**仓库根的真 schema**，不是测试里另抄的副本。

覆盖四类情况，因为它们走的是不同的装配代码：

1. **正常三卡**（headline / runner_up / wildcard 全部选满）
2. **候选不足**（filler 卡补位到严格三卡）
3. **完全空窗口**（一个候选都没有，仍然必须交三卡）
4. **边界值**：超长标题/摘要、无摘要、无 DOI、未来时间戳

另外把两个**已确认的契约缺陷**用 ``xfail(strict=True)`` 钉住（见文件末尾）：
它们不是本服务的 bug，但会让合规校验在真实数据上偶发失败，必须被记录而不是绕过。
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

import pytest

from pat_worker.pipeline.brief import (
    BRIEF_SCHEMA_VERSION,
    FILLER_TITLE,
    SUMMARY_MAX,
    TITLE_MAX,
    compose_brief,
)
from pat_worker.pipeline.merge import MergedPaper
from pat_worker.timeutil import resolve_tz

from .conftest import MORNING_BRIEF_SCHEMA, NOW

TZ = resolve_tz("Asia/Shanghai")


# ---------------------------------------------------------------------------
# 构造器
# ---------------------------------------------------------------------------
def paper(
    *,
    title: str = "Self-assembled monolayer pushes perovskite EQE to 28.4%",
    doi: str = "10.1038/s41566-026-01542-1",
    arxiv_id: str = "",
    abstract: str = (
        "A dual-phosphonic acid monolayer inserted at the hole-transport interface "
        "raises external quantum efficiency to 28.4% at 850 nm."
    ),
    hours_ago: float = 2,
    venue_tier: str = "top_journal",
    source: str = "nature_photonics",
    tags: tuple[str, ...] = ("perovskite", "eqe"),
    **kwargs,
) -> MergedPaper:
    url = f"https://doi.org/{doi}" if doi else "https://arxiv.org/abs/2610.04921"
    params = dict(
        title=title,
        published_at=NOW - timedelta(hours=hours_ago),
        url=url,
        doi=doi,
        arxiv_id=arxiv_id,
        abstract=abstract,
        venue_tier=venue_tier,
        venue_name="Nature Photonics",
        cited_by_count=14,
        sources=(source,),
        tags=tags,
    )
    params.update(kwargs)
    return MergedPaper(**params)


def compose(papers, *, keywords=("perovskite",), candidates=None, sources=None, now=NOW):
    return compose_brief(
        papers=papers,
        now=now,
        tz=TZ,
        window_start=now - timedelta(hours=24),
        window_hours=24,
        candidates=len(papers) if candidates is None else candidates,
        sources=sources or ["nature_photonics"],
        keywords=keywords,
    )


def assert_valid(validator, payload, *, label: str) -> None:
    problems = sorted(validator.iter_errors(payload), key=lambda e: list(e.path))
    if problems:
        detail = "\n".join(f"  {list(e.path)}: {e.message}" for e in problems)
        pytest.fail(f"{label} 未通过 morning-brief 契约校验：\n{detail}")


# ---------------------------------------------------------------------------
# 正常路径
# ---------------------------------------------------------------------------
def test_full_three_card_brief_matches_contract(brief_validator):
    papers = [
        paper(source="nature_photonics", venue_tier="top_journal"),
        paper(
            title="Ultrafast pump-probe reveals exciton decoherence in 2D perovskite",
            doi="",
            arxiv_id="2610.04921",
            source="arxiv",
            venue_tier="preprint",
            hours_ago=6,
        ),
        paper(
            title="Room-temperature polariton condensation with a sharp threshold drop",
            doi="10.1103/physrevlett.137.143901",
            source="crossref",
            venue_tier="field_leader",
            hours_ago=12,
        ),
    ]
    result = compose(papers)
    assert_valid(brief_validator, result.payload, label="正常三卡早报")
    assert len(result.payload["cards"]) == 3
    assert {c["slot"] for c in result.payload["cards"]} == {"headline", "runner_up", "wildcard"}


def test_runner_up_comes_from_a_different_source_family():
    """跨族约束是产品语义：三卡全来自同一批 arXiv 就是「一个实验室的一天」。"""
    same_family = [
        paper(title=f"Paper {i} about perovskite passivation", doi=f"10.1/x{i}", source="arxiv")
        for i in range(3)
    ]
    result = compose(same_family)
    warnings = result.explain["warnings"]
    assert any("同一信源族" in w for w in warnings), "退化为同族时必须留痕"


def test_cards_are_strictly_three_even_with_one_candidate(brief_validator):
    """R15 裁决：cards 恒为 3 条，候选不足用 filler 补位，绝不交 2 卡或 4 卡。"""
    result = compose([paper()])
    assert_valid(brief_validator, result.payload, label="单候选早报")
    assert len(result.payload["cards"]) == 3
    assert any(c["slot"] == "filler" for c in result.payload["cards"])


def test_empty_window_still_yields_valid_three_cards(brief_validator):
    """窗口内一条候选都没有时，仍必须产出合规的三卡早报（不能 500）。"""
    result = compose([])
    assert_valid(brief_validator, result.payload, label="空窗口早报")
    cards = result.payload["cards"]
    assert len(cards) == 3
    assert all(c["slot"] == "filler" for c in cards)
    assert all(c["heat"] == 0.0 for c in cards)


def test_vetoed_paper_never_appears_as_a_card(brief_validator):
    """撤稿论文必须被挡在早报之外——不管它的其他因子多强。"""
    retracted = paper(flags=frozenset({"retracted"}))
    result = compose([retracted])
    titles = [c["title"] for c in result.payload["cards"]]
    assert retracted.title not in titles, "撤稿论文进了早报"
    assert_valid(brief_validator, result.payload, label="含撤稿论文的早报")


def test_low_heat_candidates_do_not_become_cards():
    """低于入选下限的候选宁可出 filler，也不凑数。

    用 ``topic_momentum=0.0`` 构造真正低于下限的条目：仅仅「旧 + 预警期刊」
    并不够——非否决条目的最低分是 31.3（见 test_heat_floor_and_threshold_are_consistent），
    高于 30 分的下限，这正是判定逻辑里有 ``vetoed`` 兜底却没有热度兜底的原因。
    """
    stale = paper(
        hours_ago=160,
        venue_tier="predatory_risk",
        cited_by_count=0,
        topic_momentum=0.0,
    )
    result = compose([stale])
    assert all(c["slot"] == "filler" for c in result.payload["cards"])
    assert any("下限" in w for w in result.explain["warnings"])


def test_heat_floor_and_threshold_are_consistent():
    """把「下限 30 分」与「最低可达分 31.3」的关系钉住，防止两者悄悄交叉。

    如果将来有人调低 ``NEW_PAPER_NEUTRAL`` 或调高 ``MIN_HEAT_TO_CARD``，
    这里会立刻变红——否则表现为「明明有候选却全是 filler」这种难查的线上现象。
    """
    from pat_worker.domain.heat import PaperSignal, score_heat
    from pat_worker.pipeline.brief import MIN_HEAT_TO_CARD

    worst = score_heat(
        PaperSignal(
            title="worst possible non-vetoed",
            published_at=NOW - timedelta(hours=1000),  # 远超出窗口，时效归零
            source_count=1,
            cited_by_count=0,
            venue_tier="predatory_risk",
            topic_momentum=None,  # 缺失时给中性 0.5
        ),
        NOW,
    ).score
    assert worst >= MIN_HEAT_TO_CARD, (
        f"非否决条目的理论最低分 {worst} 已低于入选下限 {MIN_HEAT_TO_CARD}；"
        "说明存在「永远不可能入选」的候选区间，需要重新审视两者关系"
    )


def test_brief_is_reproducible():
    """同输入必须生成同一 digest_id（早报幂等键，用于缓存与去重推送）。"""
    papers = [paper()]
    first = compose(papers).payload
    second = compose(papers).payload
    assert first["digest_id"] == second["digest_id"]
    assert first == second


# ---------------------------------------------------------------------------
# 边界值：这些最容易突破 maxLength / pattern
# ---------------------------------------------------------------------------
def test_extremely_long_title_is_truncated_to_contract_limit(brief_validator):
    long_title = "Perovskite " * 60  # 远超 80 字
    result = compose([paper(title=long_title)])
    assert_valid(brief_validator, result.payload, label="超长标题早报")
    for card in result.payload["cards"]:
        assert len(card["title"]) <= TITLE_MAX, f"标题超长: {len(card['title'])}"


def test_extremely_long_abstract_is_truncated(brief_validator):
    long_abstract = "We show that " * 200
    result = compose([paper(abstract=long_abstract)])
    assert_valid(brief_validator, result.payload, label="超长摘要早报")
    for card in result.payload["cards"]:
        assert len(card["summary"]) <= SUMMARY_MAX, f"摘要超长: {len(card['summary'])}"


def test_empty_abstract_falls_back_to_title_only(brief_validator):
    result = compose([paper(abstract="")])
    assert_valid(brief_validator, result.payload, label="无摘要早报")


def test_paper_without_doi_or_arxiv_is_valid(brief_validator):
    result = compose([paper(doi="", abstract="")])
    assert_valid(brief_validator, result.payload, label="无标识早报")


def test_future_published_at_does_not_break_contract(brief_validator):
    """未来时间戳（时区错乱的常见后果）不能让 schema 崩。"""
    result = compose([paper(hours_ago=-5)])
    assert_valid(brief_validator, result.payload, label="未来时间戳早报")


def test_unconfigured_keywords_use_basis_none(brief_validator):
    """未配置订阅词时 fit.basis 必须是 none 且 score=0（客户端显示「—」）。"""
    result = compose([paper()], keywords=())
    assert_valid(brief_validator, result.payload, label="未配置关键词早报")
    for card in result.payload["cards"]:
        assert card["fit"]["basis"] == "none"
        assert card["fit"]["score"] == 0


# ---------------------------------------------------------------------------
# 契约元信息与自洽性
# ---------------------------------------------------------------------------
def test_payload_schema_version_matches_contract_constant(brief_validator):
    payload = compose([paper()]).payload
    assert payload["schema_version"] == BRIEF_SCHEMA_VERSION
    assert brief_validator.schema["properties"]["schema_version"]["const"] == BRIEF_SCHEMA_VERSION


def test_digest_id_matches_contract_pattern(brief_validator):
    payload = compose([paper()]).payload
    pattern = brief_validator.schema["properties"]["digest_id"]["pattern"]
    assert re.match(pattern, payload["digest_id"]), payload["digest_id"]


def test_brief_date_uses_business_timezone():
    """brief_date 必须按 PAT_TIMEZONE 取日期，不是 UTC 日期。

    UTC 2026-10-20 20:00 == 上海 2026-10-21 04:00，日期必须跨过去。
    """
    late_utc = datetime(2026, 10, 20, 20, 0, tzinfo=UTC)
    result = compose([paper()], now=late_utc)
    assert result.payload["brief_date"] == "2026-10-21", "跨日时用了 UTC 日期而非业务时区"
    assert "+08:00" in result.payload["generated_at"]


def test_filler_states_facts_not_fake_papers(brief_validator):
    """filler 卡必须陈述窗口统计，不能编造一篇假论文。"""
    cards = compose([]).payload["cards"]
    assert all(c["title"] == FILLER_TITLE for c in cards)
    assert all(c["url"].startswith("https://") for c in cards)
    assert all(c["fit"]["basis"] == "none" for c in cards)


def test_stats_match_actual_cards(brief_validator):
    """stats.selected 必须等于真实入选卡数（不含 filler），否则前端统计会撒谎。"""
    result = compose([paper(), paper(title="Second paper on perovskite films", doi="10.1/y")])
    payload = result.payload
    real = sum(1 for c in payload["cards"] if c["slot"] != "filler")
    assert payload["stats"]["selected"] == real


def test_read_lookup_projects_read_flag(brief_validator):
    """已读状态由 worker 投影，客户端只读不写。"""
    papers = [paper()]
    result = compose_brief(
        papers=papers,
        now=NOW,
        tz=TZ,
        window_start=NOW - timedelta(hours=24),
        window_hours=24,
        candidates=1,
        sources=["nature_photonics"],
        keywords=["perovskite"],
        read_lookup=lambda key: True,
    )
    assert result.payload["cards"][0]["read"] is True
    assert_valid(brief_validator, result.payload, label="已读投影早报")


def test_contract_file_is_the_one_used_by_consumers():
    """确认校验的是仓库根的真契约（防止有人把 schema 复制进服务目录后各测各的）。"""
    assert MORNING_BRIEF_SCHEMA.exists(), f"契约缺失：{MORNING_BRIEF_SCHEMA}"
    text = MORNING_BRIEF_SCHEMA.read_text(encoding="utf-8")
    assert '"MatrixOS_Morning_Brief"' in text


# ---------------------------------------------------------------------------
# 已确认的契约缺陷（不是本服务的 bug，但会打挂真实校验）
# ---------------------------------------------------------------------------
# 用 xfail(strict=True) 钉住：
#   - 现在它们失败，所以不阻断 CI，但缺陷有据可查；
#   - 将来修复后变 xpass，strict 会把它变成失败，提醒「缺陷已修复，请删掉本用例」。
@pytest.mark.xfail(
    strict=True,
    reason=(
        "契约缺陷：morning-brief.schema.json 的 card.heat 声明 multipleOf: 0.1，"
        "但 JSON Schema 校验器用浮点除法判定，约 34.8% 的合法一位小数值"
        "（如 74.1、73.8、78.1）会被判为『不是 0.1 的倍数』；"
        "而 score_heat 产出的正是一位小数值。修复建议见交付说明。"
    ),
)
def test_heat_values_pass_multiple_of_constraint():
    """真实打分路径产出的分数必须能通过 card.heat 的 multipleOf 约束。"""
    jsonschema = pytest.importorskip("jsonschema")
    from pat_worker.domain.heat import PaperSignal, score_heat

    validator = jsonschema.Draft7Validator(
        {"type": "number", "minimum": 0, "maximum": 100, "multipleOf": 0.1}
    )

    offenders = []
    for venue in ("top_journal", "field_leader", "reputable", "preprint", "unknown"):
        for cited in (0, 1, 7, 14, 25, 60):
            for source_count in (1, 2, 3, 4):
                for hours in (1, 6, 18, 40, 90):
                    score = score_heat(
                        PaperSignal(
                            title="t",
                            published_at=NOW - timedelta(hours=hours),
                            source_count=source_count,
                            cited_by_count=cited,
                            citation_baseline=3.0,
                            venue_tier=venue,
                            topic_momentum=1.5,
                        ),
                        NOW,
                    ).score
                    if not validator.is_valid(score):
                        offenders.append(score)
    assert not offenders, (
        f"{len(offenders)} 个真实热度值无法通过契约的 multipleOf: 0.1 约束，"
        f"例如 {sorted(set(offenders))[:8]}"
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "契约自身矛盾：morning-brief.schema.json 内嵌的 examples[0] 无法通过"
        "它自己的 schema 校验（cards[1].heat = 74.1 违反 multipleOf: 0.1）。"
        "契约示例即文档，示例不合规会让所有消费方照着写错。"
    ),
)
def test_contract_examples_satisfy_their_own_schema(morning_brief_schema, strict_brief_validator):
    """契约自带的 examples 必须能通过契约自己的校验（示例即文档）。"""
    examples = morning_brief_schema.get("examples") or []
    assert examples, "契约没有 examples，无法自检"
    problems = []
    for index, example in enumerate(examples):
        for error in strict_brief_validator.iter_errors(example):
            problems.append(f"examples[{index}] {list(error.path)}: {error.message}")
    assert not problems, "\n".join(problems)
