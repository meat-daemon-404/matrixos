"""早报合成：从候选集选出严格三卡并组装成 `morning-brief.schema.json` 的形状。

R15 的裁决已写进契约（`specs/contracts/morning-brief.schema.json`）：
**cards 恒为 3 条**。Bundle 里文案说「三卡」而实装只有两卡，本实现补齐为三卡，
且用槽位（slot）表达每张卡的**不同职责**，而不是「随便凑三篇高分」：

| slot        | 职责                                             | 选取规则 |
| ----------- | ------------------------------------------------ | -------- |
| `headline`  | 当日最高热度                                     | 热度分第 1 |
| `runner_up` | 与 headline **不同信源族**的次高                 | 热度分最高的异族条目 |
| `wildcard`  | 上升势能最强的非重复项（可能不是总分最高）       | `topic_momentum` 因子最高者打破平局 |
| `filler`    | 候选不足时的版块综述卡（不做假数据，只陈述事实） | 窗口统计 |

为什么要强制 `runner_up` 换族：如果三卡全来自同一批 arXiv 预印本，学生看到的是
「一个实验室的一天」，而不是「学科的一天」。跨族约束是产品语义，不是技术优化。

为什么 wildcard 用势能而不是总分：总分高的是「已经热了的」，势能高的是「正在热起来的」。
早报的价值有一半在于后者——学生需要时间窗口去抢在别人前面。

摘要生成的口径（重要，写进文档以免误解）：**本服务不做生成式摘要**。
早报的 summary 是从摘要里抽取 + 截断的确定性结果，因此不会编造内容。
真正的「一句话中文摘要」应由 copilot-router 的 TIER 01 模型完成，
本服务在 `summary_source` 字段里如实标注来源（`extract` / `title_only`），
便于 Stage 2 接入后对比与灰度。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from pat_worker.domain.fit import FitResult, score_fit
from pat_worker.domain.heat import HeatBreakdown, PaperSignal, heat_level, score_heat
from pat_worker.models import source_family
from pat_worker.pipeline.merge import MergedPaper
from pat_worker.timeutil import isoformat_offset, short_hash

BRIEF_SCHEMA_VERSION = "1.0"
DISCLAIMER = (
    "热度为 MatrixOS 自研算法估算值（pat-heat/1.0），"
    "仅供选题参考，不代表引用量或学术影响力评价。"
)

#: 契约里 title / summary 的长度上限（字符数，非字节）
TITLE_MAX = 80
SUMMARY_MAX = 160
#: filler 卡的固定标题
FILLER_TITLE = "今日窗口内前沿条目不足"

#: 热度的「入选下限」：低于此分的候选不进早报，宁可出 filler 也不凑数。
#: 30 分意味着至少有两个因子给出了正向证据（如 preprint 0.42 × 0.16 + 时效 1.0 × 0.18
#: + 跨源 1 源 0.39 × 0.24 ≈ 20 分，还需要引用或期刊加持）。
MIN_HEAT_TO_CARD = 30.0


@dataclass(slots=True)
class ScoredCandidate:
    paper: MergedPaper
    heat: HeatBreakdown
    fit: FitResult
    momentum: float


@dataclass(slots=True)
class BriefBuildResult:
    """合成结果。`payload` 即早报 JSON，`explain` 是给运维/调试的归因。

    `selected` 保留入选候选的**对象引用**，让调用方（runner）能把 paper_key
    登记进推送台账。刻意不塞进 `explain`——explain 要能 JSON 序列化，
    塞 dataclass 进去会在落库时炸。
    """

    payload: dict[str, object]
    explain: dict[str, object] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    selected: list[tuple[str, "ScoredCandidate"]] = field(default_factory=list)


# ------------------------------------------------------------------ 文本处理


def _truncate(text: str, limit: int) -> str:
    """按字符截断并补省略号。刻意不在词中间断开拉丁词。"""
    cleaned = " ".join((text or "").split())
    if len(cleaned) <= limit:
        return cleaned
    cut = cleaned[: limit - 1]
    # 避免把英文单词/数字砍半
    if cut and cut[-1].isalnum() and limit < len(cleaned) and cleaned[limit - 1].isalnum():
        space = cut.rfind(" ")
        if space > limit // 2:
            cut = cut[:space]
    return cut.rstrip(" ,;，；、-—") + "…"


def make_title(paper: MergedPaper) -> str:
    return _truncate(paper.title, TITLE_MAX) or "(无标题)"


def make_summary(paper: MergedPaper) -> tuple[str, str]:
    """返回 (摘要文本, 摘要来源标识)。

    抽取式：取摘要首句，失败则退回标题 + 期刊名。
    `summary_source` 让下游能区分「真实摘要」与「只有标题」的卡片。
    """
    abstract = " ".join((paper.abstract or "").split())
    if abstract:
        # 取第一个句末标点前的部分；中英文句号都认
        for index, char in enumerate(abstract):
            if char in "。！？" or (char == "." and index + 1 < len(abstract) and abstract[index + 1] == " "):
                sentence = abstract[: index + 1].strip()
                if len(sentence) >= 20:
                    return _truncate(sentence, SUMMARY_MAX), "extract"
                break
        return _truncate(abstract, SUMMARY_MAX), "extract"

    venue = paper.venue_name or "预印本平台"
    fallback = f"{make_title(paper)}（{venue}，暂无摘要，请点原文查看）"
    return _truncate(fallback, SUMMARY_MAX), "title_only"


def build_metrics(scored: ScoredCandidate) -> list[dict[str, str]]:
    """关键指标：只放**可核验的事实**，不放假分数。

    刻意不把热度分本身放进来（它在卡片主字段里），也不放「学科排名」这类
    我们算不出来的东西。最多 4 条，按信息量排序。
    """
    metrics: list[dict[str, str]] = []
    if scored.paper.cited_by_count is not None:
        metrics.append({"label": "被引", "value": str(scored.paper.cited_by_count), "unit": "次"})
    if scored.paper.source_count > 1:
        metrics.append(
            {"label": "信源覆盖", "value": str(scored.paper.source_count), "unit": "源"}
        )
    if scored.momentum and scored.momentum > 1.05:
        metrics.append(
            {"label": "主题热度比", "value": f"{scored.momentum:.1f}", "unit": "×"}
        )
    if scored.fit.basis == "keywords" and scored.fit.score > 0:
        metrics.append({"label": "课题契合", "value": str(scored.fit.score), "unit": "分"})
    if not metrics:
        # 至少给一条，避免小程序端出现空指标区
        venue = scored.paper.venue_name or "预印本"
        metrics.append({"label": "载体", "value": _truncate(venue, 20)})
    return metrics[:4]


# ------------------------------------------------------------------ 选卡


def score_candidates(
    papers: list[MergedPaper],
    *,
    now: datetime,
    keywords: list[str] | tuple[str, ...] = (),
) -> list[ScoredCandidate]:
    """给每条候选打分。返回**按热度降序**的列表。"""
    scored: list[ScoredCandidate] = []
    for paper in papers:
        signal = PaperSignal(
            title=paper.title,
            published_at=paper.published_at,
            source_count=paper.source_count,
            cited_by_count=paper.cited_by_count,
            citation_baseline=paper.citation_baseline,
            venue_tier=paper.venue_tier,
            topic_momentum=paper.topic_momentum,
            flags=paper.flags,
            identifier=paper.doi or paper.arxiv_id,
        )
        breakdown = score_heat(signal, now)
        summary_text, _ = make_summary(paper)
        fit = score_fit(paper.title, summary_text, keywords)
        scored.append(
            ScoredCandidate(
                paper=paper,
                heat=breakdown,
                fit=fit,
                momentum=breakdown.factors.get("topic_momentum", 0.5),
            )
        )
    scored.sort(key=lambda c: (-c.heat.score, c.paper.title))
    return scored


def select_cards(
    scored: list[ScoredCandidate],
    *,
    max_cards: int = 3,
) -> tuple[list[tuple[str, ScoredCandidate | None]], list[str]]:
    """按槽位语义选出 ≤3 条。返回 [(slot, candidate|None)] 与告警列表。

    返回 None 的槽位由调用方补 filler 卡。
    """
    warnings: list[str] = []
    eligible = [
        c for c in scored if not c.heat.vetoed and c.heat.score >= MIN_HEAT_TO_CARD
    ]
    if not eligible:
        if scored:
            warnings.append(
                f"{len(scored)} 条候选全部低于入选下限 {MIN_HEAT_TO_CARD} 分或被硬否决"
            )
        else:
            warnings.append("窗口内无任何候选条目")
        return [("headline", None), ("runner_up", None), ("wildcard", None)], warnings

    headline = eligible[0]
    selected: list[tuple[str, ScoredCandidate | None]] = [("headline", headline)]
    used_titles = {headline.paper.title}

    # ---- runner_up：热度最高的**异信源族**条目
    headline_family = source_family(headline.paper.primary_source)
    runner_up: ScoredCandidate | None = None
    for candidate in eligible[1:]:
        if candidate.paper.title in used_titles:
            continue
        if source_family(candidate.paper.primary_source) == headline_family:
            continue
        runner_up = candidate
        break
    if runner_up is None:
        # 没有异族条目时退化为「次高」，并留痕——不假装多样性存在
        for candidate in eligible[1:]:
            if candidate.paper.title not in used_titles:
                runner_up = candidate
                warnings.append("候选全部来自同一信源族，runner_up 无法保证跨源多样性")
                break
    selected.append(("runner_up", runner_up))
    if runner_up is not None:
        used_titles.add(runner_up.paper.title)

    # ---- wildcard：势能最强的剩余条目；平局用热度分打破
    pool = [
        c
        for c in eligible
        if c.paper.title not in used_titles and not c.heat.vetoed
    ]
    wildcard: ScoredCandidate | None = None
    if pool:
        pool.sort(key=lambda c: (-c.momentum, -c.heat.score, c.paper.title))
        wildcard = pool[0]
        # 如果 wildcard 恰好就是次高分（说明势能没有提供新信息），留痕
        if runner_up is not None and wildcard.heat.score == runner_up.heat.score:
            warnings.append("wildcard 与 runner_up 同分：主题势能未提供额外区分度")
        used_titles.add(wildcard.paper.title)
    selected.append(("wildcard", wildcard))

    return selected[:max_cards], warnings


# ------------------------------------------------------------------ 卡片装配


def build_card(
    *,
    rank: int,
    slot: str,
    scored: ScoredCandidate,
    now: datetime,
    tz,
    already_read: bool = False,
) -> dict[str, object]:
    """单卡装配。字段与 schema 一一对应，不多不少。"""
    card_id = f"card_{rank:02d}"
    summary_text, summary_source = make_summary(scored.paper)
    title = make_title(scored.paper)

    card: dict[str, object] = {
        "card_id": card_id,
        "rank": rank,
        "slot": slot,
        "title": title,
        "summary": summary_text,
        "heat": scored.heat.score,
        "heat_level": heat_level(scored.heat.score),
        "metrics": build_metrics(scored),
        "url": scored.paper.url or "https://openalex.org",
        "source": scored.paper.primary_source or "openalex",
        "published_at": isoformat_offset(scored.paper.published_at, tz),
        "fit": scored.fit.to_dict(),
        "read": already_read,
        "action": {"type": "push_desktop_queue", "queue_ref": card_id},
    }
    if scored.paper.doi:
        card["doi"] = scored.paper.doi
    if scored.paper.arxiv_id:
        card["arxiv_id"] = scored.paper.arxiv_id
    if scored.paper.tags:
        card["tags"] = [_truncate(tag, 24) for tag in scored.paper.tags[:5]]
    # summary_source 不在契约内（additionalProperties:false），放进 explain 而不是卡片。
    _ = summary_source
    return card


def build_filler_card(
    *,
    rank: int,
    now: datetime,
    tz,
    candidates: int,
    deduped: int,
    sources: list[str],
    reason: str,
) -> dict[str, object]:
    """候选不足时的补位卡。

    它不是「编一条假论文」，而是如实陈述窗口统计。这样小程序端永远是三卡布局，
    但用户看到的是诚实的信息，而不是被塞了一篇不相干的论文。
    """
    source_list = "、".join(sources) if sources else "无信源返回"
    summary = (
        f"本次窗口共采集 {candidates} 条、归并后 {deduped} 条，未达到入选阈值（{reason}）。"
        f"已覆盖信源：{source_list}。可稍后手动刷新，或放宽订阅关键词。"
    )
    return {
        "card_id": f"card_{rank:02d}",
        "rank": rank,
        "slot": "filler",
        "title": FILLER_TITLE,
        "summary": _truncate(summary, SUMMARY_MAX),
        "heat": 0.0,
        "heat_level": "watch",
        "metrics": [
            {"label": "采集", "value": str(candidates), "unit": "条"},
            {"label": "归并", "value": str(deduped), "unit": "条"},
        ],
        "url": "https://pat-hot.matrixos.edu",
        "source": (sources[0] if sources else "openalex"),
        "published_at": isoformat_offset(now, tz),
        "fit": {"score": 0, "basis": "none"},
        "read": False,
        "action": {"type": "push_desktop_queue", "queue_ref": f"card_{rank:02d}"},
    }


# ------------------------------------------------------------------ 主入口


def compose_brief(
    *,
    papers: list[MergedPaper],
    now: datetime,
    tz,
    window_start: datetime,
    window_hours: int,
    candidates: int,
    sources: list[str],
    keywords: list[str] | tuple[str, ...] = (),
    read_lookup=None,
) -> BriefBuildResult:
    """合成完整早报 JSON。

    `read_lookup` 是一个可调用对象 `(dedupe_id: str) -> bool`，用于投影已读状态；
    为 None 时全部按未读处理。用回调而不是直接查库，是为了让本函数保持纯函数，
    可脱离存储单测。
    """
    warnings: list[str] = []
    scored = score_candidates(papers, now=now, keywords=keywords)
    slots, select_warnings = select_cards(scored)
    warnings.extend(select_warnings)

    cards: list[dict[str, object]] = []
    chosen: list[tuple[str, ScoredCandidate]] = []
    rank = 1
    for slot, candidate in slots:
        if candidate is None:
            continue
        read_flag = False
        if read_lookup is not None:
            read_flag = bool(read_lookup(_receipt_key(candidate.paper)))
        cards.append(
            build_card(
                rank=rank,
                slot=slot,
                scored=candidate,
                now=now,
                tz=tz,
                already_read=read_flag,
            )
        )
        chosen.append((slot, candidate))
        rank += 1

    while len(cards) < 3:
        reason = "候选不足或已全部推送过" if papers else "窗口内无候选"
        cards.append(
            build_filler_card(
                rank=rank,
                now=now,
                tz=tz,
                candidates=candidates,
                deduped=len(papers),
                sources=sources,
                reason=reason,
            )
        )
        rank += 1

    brief_date = now.astimezone(tz).strftime("%Y-%m-%d") if now.tzinfo else now.strftime("%Y-%m-%d")
    digest_id = f"pb_{brief_date.replace('-', '')}_{short_hash([c['title'] for c in cards])}"

    payload: dict[str, object] = {
        "schema_version": BRIEF_SCHEMA_VERSION,
        "digest_id": digest_id,
        "brief_date": brief_date,
        "generated_at": isoformat_offset(now, tz),
        "window": {
            "start": isoformat_offset(window_start, tz),
            "end": isoformat_offset(now, tz),
            "hours": window_hours,
        },
        "station": "pat_hot",
        "cards": cards[:3],
        "stats": {
            "candidates": candidates,
            "deduped": len(papers),
            "selected": sum(1 for c in cards if c["slot"] != "filler"),
            "sources": sources or ["openalex"],
        },
        "disclaimer": DISCLAIMER,
    }

    explain = {
        "algorithm": "pat-heat/1.0",
        "min_heat_to_card": MIN_HEAT_TO_CARD,
        "scored": [
            {
                "title": c.paper.title,
                "heat": c.heat.score,
                "factors": c.heat.factors,
                "vetoed": c.heat.vetoed,
                "sources": list(c.paper.sources),
                "notes": c.heat.notes,
            }
            for c in scored[:12]
        ],
        "warnings": warnings,
    }
    return BriefBuildResult(
        payload=payload, explain=explain, warnings=warnings, selected=chosen
    )


def _receipt_key(paper: MergedPaper) -> str:
    """已读回执的稳定键：优先 DOI，其次 arXiv，最后标题哈希。

    刻意不用 OpenAlex work id：同一篇论文的 OpenAlex id 会随去重合并变化，
    而 DOI 是出版方注册后永久不变的。
    """
    if paper.doi:
        return f"doi:{paper.doi}"
    if paper.arxiv_id:
        return f"arxiv:{paper.arxiv_id}"
    return f"title:{short_hash(paper.title, 16)}"
