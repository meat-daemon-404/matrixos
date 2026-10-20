"""星门 06 站：导师五维画像。

五维来自 `specs/microsites.json` 第 06 行与 `docs/00-analysis/02-requirements.md`：
**近 3 年活跃度 / H-index 斜率 / 经费充足度 / 本科生友好度 / 方向契合度**。
Bundle 只给了维度名，没给任何可计算定义（缺口 R14 的一部分），本模块负责补齐。

三条工程原则，贯穿全部五个维度：

1. **每一维都必须能溯源**：`Dimension` 里同时给出 score / raw / formula_id / sources /
   confidence / notes。前端画雷达图之外，还要能回答「为什么这一维只有 32 分」。
2. **缺失数据不猜，降级并降置信度**：OpenAlex 的 funding 字段对国内单位覆盖很差，
   硬当成「没钱」会系统性误伤中国导师。因此缺失时给中性分 + `confidence="low"` +
   显式 note，让 UI 能标注「数据不足」而不是显示一个假的低分。
3. **纯函数**：不联网、不读时钟。`now` 由调用方传入，保证历史回放可复现。

数据来源全部是 OpenAlex（`/authors/{id}` + `/works?filter=author.id`），
Crossref 只用于补 DOI 元数据，不参与打分。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime

PROFILE_VERSION = "mentor-profile/1.0"

DIMENSIONS: tuple[str, ...] = (
    "recent_activity",
    "hindex_slope",
    "funding_capacity",
    "undergrad_friendliness",
    "direction_fit",
)

DIMENSION_LABELS: dict[str, str] = {
    "recent_activity": "近 3 年活跃度",
    "hindex_slope": "H-index 斜率",
    "funding_capacity": "经费充足度",
    "undergrad_friendliness": "本科生友好度",
    "direction_fit": "方向契合度",
}

#: 每个维度的「依据强度」。confidence 会随数据完备度下调，不会上调。
BASE_CONFIDENCE: dict[str, str] = {
    "recent_activity": "high",
    "hindex_slope": "high",
    "funding_capacity": "medium",
    "undergrad_friendliness": "low",
    "direction_fit": "medium",
}

#: 学科年度产出基线（篇/年）。物理/材料/光电类活跃 PI 的常见量级。
#: 用「相对基线」而不是绝对篇数，因为 CS 与物理的产出密度差 3 倍以上。
DEFAULT_ANNUAL_OUTPUT_BASELINE = 4.0

#: 主要资助机构识别词（大小写不敏感子串匹配）。
#: 只用于「是否有国家级经费」的二值加分，不做金额推断——OpenAlex 不提供金额。
MAJOR_FUNDER_MARKERS: tuple[str, ...] = (
    "national natural science foundation",
    "国家自然科学基金",
    "national key research",
    "国家重点研发",
    "ministry of science and technology",
    "科学技术部",
    "chinese academy of sciences",
    "中国科学院",
    "national science foundation",
    "european research council",
    "department of energy",
    "nih",
    "jsps",
    "deutsche forschungsgemeinschaft",
    "dfg",
    "uk research and innovation",
    "engineering and physical sciences research council",
)

#: 高校类机构识别词。用于本科生友好度里的「是否能带本科生的单位类型」代理。
UNIVERSITY_MARKERS: tuple[str, ...] = ("university", "大学", "college", "学院", "school of")

#: 「可读性/教学性」论文类型。综述与教程对本科生门槛显著更低。
PEDAGOGICAL_TYPES: frozenset[str] = frozenset({"review", "book-chapter", "editorial", "letter"})


# ============================================================== 输入数据结构


@dataclass(slots=True)
class WorkRecord:
    """一篇论文的最小投影。字段全部来自 OpenAlex `/works`。"""

    id: str = ""
    title: str = ""
    publication_year: int | None = None
    cited_by_count: int = 0
    #: OpenAlex `counts_by_year`：[{year, cited_by_count}]，用于重建历史 h-index
    counts_by_year: dict[int, int] = field(default_factory=dict)
    #: first / middle / last
    author_position: str = "middle"
    is_corresponding: bool = False
    #: article / review / preprint / book-chapter ...
    work_type: str = "article"
    venue_display_name: str = ""
    is_oa: bool = False
    topic_names: tuple[str, ...] = ()
    funder_names: tuple[str, ...] = ()
    award_count: int = 0
    is_retracted: bool = False


@dataclass(slots=True)
class AuthorRecord:
    """OpenAlex `/authors/{id}` 的投影。"""

    author_id: str
    display_name: str = ""
    orcid: str = ""
    works_count: int = 0
    cited_by_count: int = 0
    h_index: int = 0
    i10_index: int = 0
    two_yr_mean_citedness: float = 0.0
    #: 作者级年度产出/被引：[{year, works_count, cited_by_count}]
    counts_by_year: dict[int, dict[str, int]] = field(default_factory=dict)
    #: topic 名 → 论文数
    topics: dict[str, int] = field(default_factory=dict)
    institution_names: tuple[str, ...] = ()
    last_active_year: int | None = None


# ============================================================== 输出数据结构


@dataclass(slots=True)
class Dimension:
    """单维结果。score 为 0–100 的整数，raw 保留原始观测量以便溯源。"""

    key: str
    label: str
    score: int
    raw: dict[str, float | int | str | None] = field(default_factory=dict)
    formula_id: str = ""
    sources: tuple[str, ...] = ("openalex",)
    confidence: str = "medium"
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "label": self.label,
            "score": self.score,
            "confidence": self.confidence,
            "formula_id": self.formula_id,
            "sources": list(self.sources),
            "raw": dict(self.raw),
            "notes": list(self.notes),
        }


@dataclass(slots=True)
class MentorProfile:
    """06 站的持久化单元：一份导师五维画像。"""

    author_id: str
    display_name: str
    generated_at: str
    dimensions: dict[str, Dimension]
    overall_score: int
    data_completeness: float
    orcid: str = ""
    institutions: tuple[str, ...] = ()
    top_topics: tuple[str, ...] = ()
    work_count: int = 0
    citation_count: int = 0
    version: str = PROFILE_VERSION
    notes: list[str] = field(default_factory=list)

    @property
    def radar(self) -> dict[str, int]:
        """雷达图直接可用的五元组（顺序固定，键为维度 key）。"""
        return {key: self.dimensions[key].score for key in DIMENSIONS}

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": "1.0",
            "profile_version": self.version,
            "author_id": self.author_id,
            "display_name": self.display_name,
            "orcid": self.orcid,
            "generated_at": self.generated_at,
            "institutions": list(self.institutions),
            "top_topics": list(self.top_topics),
            "work_count": self.work_count,
            "citation_count": self.citation_count,
            "overall_score": self.overall_score,
            "data_completeness": round(self.data_completeness, 3),
            "radar": self.radar,
            "dimensions": [self.dimensions[key].to_dict() for key in DIMENSIONS],
            "notes": list(self.notes),
        }


# ============================================================== 通用工具


def _clamp01(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def _pct(value: float) -> int:
    return int(round(_clamp01(value) * 100))


def _to_int(value: object, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


# ============================================================== h-index 计算


def h_index_from_citations(citations: list[int]) -> int:
    """标准 h-index：至少 h 篇被引 ≥ h。

    单独抽出来是为了能对「截至某一年的引用」重复调用，从而重建历史 h-index。
    """
    if not citations:
        return 0
    ordered = sorted((c for c in citations if c > 0), reverse=True)
    h = 0
    for index, cites in enumerate(ordered, start=1):
        if cites >= index:
            h = index
        else:
            break
    return h


def _citations_upto(work: WorkRecord, year: int) -> int:
    """一篇论文截至 `year` 年末的累计被引。

    优先用 counts_by_year 逐年累加；缺失时退化：若 year >= 当前可知的最大年份，
    用 cited_by_count 总量，否则返 0（宁可少算，不可把未来引用提前计入）。
    """
    if work.counts_by_year:
        return sum(v for y, v in work.counts_by_year.items() if y <= year)
    if work.publication_year is not None and work.publication_year > year:
        return 0
    return max(0, work.cited_by_count)


def h_index_series(works: list[WorkRecord], years: list[int]) -> dict[int, int]:
    """对每个年份重建「截至该年末」的 h-index。"""
    series: dict[int, int] = {}
    for year in years:
        citations = [_citations_upto(w, year) for w in works]
        series[year] = h_index_from_citations(citations)
    return series


# ============================================================== 维度 1：活跃度


def _recent_activity(
    author: AuthorRecord,
    works: list[WorkRecord],
    now: datetime,
    baseline: float,
) -> Dimension:
    """近 3 年活跃度。

    形式化定义（formula_id = `activity/v1`）：

        output   = 近 3 年署名论文数 / 3            （篇/年）
        f_output = 1 - exp(-0.9 * output / baseline) （0→0, baseline→0.57, 2×→0.83）
        lead     = 近 3 年一作或末作（通讯）占比
        f_lead   = min(1, lead / 0.6)               （0.6 及以上视为满额主导）
        f_fresh  = 距最近一篇发表月数 m 的分段衰减：
                   0–6 月 → 1.0；6–12 月 → 线性 1.0→0.75；
                   12–24 月 → 线性 0.75→0.40；24–36 月 → 0.40→0.15；>36 月 → 0.05
        score    = 100 × (0.55·f_output + 0.25·f_lead + 0.20·f_fresh)

    为什么把「最近发表间隔」单独列一项：产出量相同的两位导师，一个去年还在发、
    一个三年没动静，对学生决策的含义完全不同。快照式的「近 3 年总数」区分不了。
    """
    cutoff_year = now.year - 3
    recent = [w for w in works if (w.publication_year or 0) >= cutoff_year]
    notes: list[str] = []

    years_span = max(1, 3)
    output = len(recent) / years_span
    f_output = 1.0 - math.exp(-0.9 * output / baseline)

    if recent:
        lead_count = sum(
            1 for w in recent if w.author_position in {"first", "last"} or w.is_corresponding
        )
        lead_share = lead_count / len(recent)
        f_lead = min(1.0, lead_share / 0.6)
    else:
        lead_share = 0.0
        f_lead = 0.0
        notes.append("近 3 年无 OpenAlex 可查论文：可能尚未收录，也可能确已停更")

    f_fresh, months_since = _freshness(works, now)
    score = _pct(0.55 * f_output + 0.25 * f_lead + 0.20 * f_fresh)

    confidence = BASE_CONFIDENCE["recent_activity"]
    if len(works) < 5:
        confidence = "medium"
        notes.append(f"可查论文仅 {len(works)} 篇，产出估计不稳定")
    if months_since is None:
        confidence = "low"
        notes.append("无任何带年份的论文，无法计算发表新鲜度")

    return Dimension(
        key="recent_activity",
        label=DIMENSION_LABELS["recent_activity"],
        score=score,
        formula_id="activity/v1",
        confidence=confidence,
        raw={
            "recent_work_count": len(recent),
            "annual_output": round(output, 2),
            "annual_output_baseline": baseline,
            "lead_author_share": round(lead_share, 3),
            "months_since_last_work": months_since,
            "f_output": round(f_output, 3),
            "f_lead": round(f_lead, 3),
            "f_fresh": round(f_fresh, 3),
        },
        notes=notes,
    )


def _freshness(works: list[WorkRecord], now: datetime) -> tuple[float, int | None]:
    years = [w.publication_year for w in works if w.publication_year]
    if not years:
        return 0.05, None
    last_year = max(years)
    # 年份只有精度，按年中估算，避免 1 月发表被判成「已过 12 个月」
    months_since = max(0, int((now.year - last_year) * 12 + now.month - 6))
    if months_since <= 6:
        return 1.0, months_since
    if months_since <= 12:
        return 1.0 - 0.25 * (months_since - 6) / 6, months_since
    if months_since <= 24:
        return 0.75 - 0.35 * (months_since - 12) / 12, months_since
    if months_since <= 36:
        return 0.40 - 0.25 * (months_since - 24) / 12, months_since
    return 0.05, months_since


# ============================================================== 维度 2：H 斜率


def _hindex_slope(
    author: AuthorRecord,
    works: list[WorkRecord],
    now: datetime,
) -> Dimension:
    """H-index 斜率 = 学术影响力的**增速**，不是存量。

    形式化定义（formula_id = `h-slope/v1`）：

        H(t)      = 截至 t 年末的 h-index（逐篇按 counts_by_year 累加后重算）
        slope     = (H(now) - H(now-3)) / 3          （h/年）
        expected  = max(0.5, 0.06 × H(now))          （h 越高越难增长）
        ratio     = slope / expected
        score     = 100 × clamp(0.15 + 0.85 × (1 - exp(-0.8 × ratio)), 0, 1)

    `expected` 随 H 次线性增长是关键：H=5 的年轻老师一年涨 1 是常态，
    H=60 的院士一年涨 1 已是强势。用固定基线会让高 H 学者恒被低估。

    ratio ≈ 0 → 17 分；ratio = 1（与同量级同行同步）→ 62 分；ratio = 2 → 80 分。

    降级路径：若论文缺 counts_by_year 无法重建历史 H，退化为
    「summary_stats.h_index 与 h-index/i10 比值的粗估」，并降 confidence。
    """
    notes: list[str] = []
    current_year = now.year
    start_year = current_year - 3

    reconstructable = sum(1 for w in works if w.counts_by_year) >= max(2, len(works) // 2)
    if reconstructable and works:
        series = h_index_series(works, [start_year, current_year])
        h_now = series[current_year]
        h_then = series[start_year]
        method = "counts_by_year"
    else:
        h_now = author.h_index
        # 无法重建时的保守估计：假设过去 3 年增长与 i10/h 比例相关
        implied = author.i10_index / max(1, author.h_index) if author.h_index else 0.0
        growth = max(0.0, 2.0 * _clamp01(implied / 4.0))
        h_then = max(0, h_now - int(round(growth * 3)))
        method = "estimated"
        notes.append("论文缺 counts_by_year，H 斜率由 i10/h 比例粗估，置信度下调")

    slope = (h_now - h_then) / 3.0
    expected = max(0.5, 0.06 * max(1, h_now))
    ratio = slope / expected if expected else 0.0
    if slope <= 0:
        score = _pct(0.15 * max(0.0, 1 + ratio))
        notes.append("H-index 三年未增长或下降：影响力扩张停滞")
    else:
        score = _pct(0.15 + 0.85 * (1.0 - math.exp(-0.8 * ratio)))

    confidence = BASE_CONFIDENCE["hindex_slope"] if method == "counts_by_year" else "low"
    if h_now < 3:
        confidence = "low"
        notes.append(f"H-index 仅 {h_now}，斜率在个位数上噪声很大")

    return Dimension(
        key="hindex_slope",
        label=DIMENSION_LABELS["hindex_slope"],
        score=score,
        formula_id="h-slope/v1",
        confidence=confidence,
        raw={
            "h_index_now": h_now,
            "h_index_3y_ago": h_then,
            "slope_per_year": round(slope, 2),
            "expected_slope": round(expected, 2),
            "ratio": round(ratio, 3),
            "method": method,
        },
        notes=notes,
    )


# ============================================================== 维度 3：经费


def _funding_capacity(author: AuthorRecord, works: list[WorkRecord], now: datetime) -> Dimension:
    """经费充足度。

    形式化定义（formula_id = `funding/v1`）：

        window      = 近 5 年论文
        funded      = 论文中带 awards 或 funders 记录的比例
        f_funded    = funded / 0.55            （55% 论文有基金标注即满额）
        n_funders   = 近 5 年出现的不同资助机构数
        f_diverse   = log2(1 + n) / log2(1 + 6)
        f_major     = 是否命中国家级/主要资助机构（0 或 1）
        f_recent    = 近 3 年有基金标注论文的比例 / 0.4（0.4 即满额）
        score       = 100 × (0.40·f_funded + 0.25·f_diverse + 0.20·f_major + 0.15·f_recent)

    **为什么不能把「无基金记录」当「无经费」**：OpenAlex 的 funder 元数据主要来自
    Crossref 的 funder 注册表，国内单位与中文期刊的覆盖率很低。缺失时统一给
    中性 40 分 + confidence=low + 明确 note，而不是 0 分。这是本维度最重要的设计约束：
    宁可显示「数据不足」，也不要给一个会误导学生的假低分。
    """
    notes: list[str] = []
    cutoff = now.year - 5
    recent_cutoff = now.year - 3
    window = [w for w in works if (w.publication_year or 0) >= cutoff]

    funded = [w for w in window if w.funder_names or w.award_count > 0]
    funders: set[str] = set()
    for w in funded:
        funders.update(name.strip().casefold() for name in w.funder_names if name and name.strip())
    major = any(
        marker in funder for funder in funders for marker in MAJOR_FUNDER_MARKERS
    )
    recent_funded = [w for w in funded if (w.publication_year or 0) >= recent_cutoff]

    if not window:
        notes.append("近 5 年无可查论文，经费维度无法评估，取中性值")
        return Dimension(
            key="funding_capacity",
            label=DIMENSION_LABELS["funding_capacity"],
            score=40,
            formula_id="funding/v1",
            confidence="low",
            raw={"window_work_count": 0, "funded_work_share": None, "distinct_funders": 0},
            notes=notes,
        )

    funded_share = len(funded) / len(window)
    recent_share = len(recent_funded) / len(window)

    if not funded:
        notes.append(
            "近 5 年论文均无 funder/award 记录。OpenAlex 对国内单位覆盖差，"
            "此结果不能等同于「无经费」，请以院系主页或基金委公示为准"
        )
        return Dimension(
            key="funding_capacity",
            label=DIMENSION_LABELS["funding_capacity"],
            score=40,
            formula_id="funding/v1",
            confidence="low",
            raw={
                "window_work_count": len(window),
                "funded_work_share": 0.0,
                "distinct_funders": 0,
                "data_gap": "no_funder_metadata",
            },
            notes=notes,
        )

    f_funded = min(1.0, funded_share / 0.55)
    f_diverse = min(1.0, math.log2(1 + len(funders)) / math.log2(1 + 6))
    f_major = 1.0 if major else 0.0
    f_recent = min(1.0, recent_share / 0.40)
    score = _pct(0.40 * f_funded + 0.25 * f_diverse + 0.20 * f_major + 0.15 * f_recent)

    confidence = BASE_CONFIDENCE["funding_capacity"]
    if len(window) < 5:
        confidence = "low"
        notes.append(f"近 5 年仅 {len(window)} 篇论文，基金覆盖率样本过小")
    if not major and funders:
        notes.append("未识别到国家级资助机构标记（可能是标注缺失，也可能是横向课题为主）")

    return Dimension(
        key="funding_capacity",
        label=DIMENSION_LABELS["funding_capacity"],
        score=score,
        formula_id="funding/v1",
        confidence=confidence,
        raw={
            "window_work_count": len(window),
            "funded_work_count": len(funded),
            "funded_work_share": round(funded_share, 3),
            "distinct_funders": len(funders),
            "major_funder": major,
            "recent_funded_share": round(recent_share, 3),
            "f_funded": round(f_funded, 3),
            "f_diverse": round(f_diverse, 3),
            "f_recent": round(f_recent, 3),
        },
        notes=notes,
    )


# ============================================================== 维度 4：本科友好


def _undergrad_friendliness(
    author: AuthorRecord,
    works: list[WorkRecord],
    now: datetime,
) -> Dimension:
    """本科生友好度 —— 全部是代理指标，置信度恒为 low。

    这是五维里唯一一个**没有直接数据源**的维度：OpenAlex 不记录「是否带本科生」、
    「组里本科生几人」、「是否愿意回邮件」。因此本实现只做可计算的代理，
    并在输出里强制标注 confidence 与 `proxy_warning`。

    形式化定义（formula_id = `undergrad/v1`）：

        f_review = 近 5 年综述/教程/书籍章节占比 / 0.20      （20% 即满额）
        f_oa     = 近 5 年开放获取论文占比 / 0.60            （60% 即满额）
        f_univ   = 单位名称命中高校词表（0 或 1）
        f_small  = 近 5 年平均作者数 ≤ 6 记 1，> 12 记 0，中间线性
        score    = 100 × (0.30·f_review + 0.30·f_oa + 0.25·f_univ + 0.15·f_small)

    代理的直觉依据（必须在文档里写明，否则读者会误以为是事实）：
    - 写综述/教程的老师，更习惯把领域讲给外行听 → 带本科生沟通成本更低；
    - 开放获取比例高 → 学生不需要校园网也能读到，进组门槛低；
    - 高校单位比纯研究所更可能有本科生课程与助研岗位；
    - 小团队论文（作者数少）→ 本科生更可能拿到实质署名位而非挂名。

    Stage 2 的升级路径：08 站 lab-kanban 的「已进组」记录是真实标签，
    届时可用它反标定这组代理权重（有监督回归），并替换本维度。
    """
    notes: list[str] = [
        "proxy_warning: 本维度全部为代理指标，OpenAlex 无「是否带本科生」的直接数据；"
        "判断前请以导师主页、课程表与学长学姐反馈为准"
    ]
    cutoff = now.year - 5
    window = [w for w in works if (w.publication_year or 0) >= cutoff]
    if not window:
        notes.append("近 5 年无可查论文，本科友好度无法评估，取中性值")
        return Dimension(
            key="undergrad_friendliness",
            label=DIMENSION_LABELS["undergrad_friendliness"],
            score=50,
            formula_id="undergrad/v1",
            confidence="low",
            raw={"window_work_count": 0},
            notes=notes,
        )

    review_share = sum(1 for w in window if w.work_type in PEDAGOGICAL_TYPES) / len(window)
    oa_share = sum(1 for w in window if w.is_oa) / len(window)
    institution_blob = " ".join(author.institution_names).casefold()
    is_university = any(marker in institution_blob for marker in UNIVERSITY_MARKERS)

    f_review = min(1.0, review_share / 0.20)
    f_oa = min(1.0, oa_share / 0.60)
    f_univ = 1.0 if is_university else 0.0
    # 作者数信息不在 WorkRecord 里（采集时可以补），缺失即按中性 0.5
    f_small = 0.5
    notes.append("作者规模代理缺数据（采集层未提供作者数），按中性 0.5 计")

    score = _pct(0.30 * f_review + 0.30 * f_oa + 0.25 * f_univ + 0.15 * f_small)

    return Dimension(
        key="undergrad_friendliness",
        label=DIMENSION_LABELS["undergrad_friendliness"],
        score=score,
        formula_id="undergrad/v1",
        confidence="low",
        raw={
            "window_work_count": len(window),
            "review_share": round(review_share, 3),
            "oa_share": round(oa_share, 3),
            "is_university": is_university,
            "f_review": round(f_review, 3),
            "f_oa": round(f_oa, 3),
            "coauthor_size_proxy": f_small,
        },
        notes=notes,
    )


# ============================================================== 维度 5：方向契合


def _direction_fit(
    author: AuthorRecord,
    works: list[WorkRecord],
    target_keywords: tuple[str, ...],
    target_topics: tuple[str, ...],
) -> Dimension:
    """方向契合度：导师研究方向与学生目标的匹配程度。

    形式化定义（formula_id = `direction-fit/v1`）：

        author_topics = OpenAlex topic 名 + 论文标题分词（近 5 年，按论文数加权）
        key_overlap   = Σ (命中 target_keywords 的 topic 权重) / Σ 全部 topic 权重
        topic_overlap = |target_topics ∩ author_topics| / |target_topics|
        recency_boost = 近 3 年命中占比 / 全部命中占比   （近期转向也算契合）
        score = 100 × clamp(0.55·key_overlap + 0.35·topic_overlap + 0.10·recency_boost, 0, 1)

    为什么关键词权重占大头：学生输入的往往是具体技术词（"钙钛矿钝化"），
    而 OpenAlex topic 是较粗的聚类（"perovskite solar cells"）。只靠 topic 交集
    会让细分方向的学生匹配不到人。

    `target_keywords` 与 `target_topics` 都为空 → 无法评估，给 0 分且 basis 说明，
    与早报 `fit.basis="none"` 保持同一语义：**0 分 = 未配置，不是不匹配**。
    """
    notes: list[str] = []
    if not target_keywords and not target_topics:
        return Dimension(
            key="direction_fit",
            label=DIMENSION_LABELS["direction_fit"],
            score=0,
            formula_id="direction-fit/v1",
            confidence="low",
            raw={"configured": False},
            notes=["未配置目标关键词/主题，契合度不可计算（0 分表示未配置，不是不匹配）"],
        )

    # topic 权重：作者级 topics 计数 + 论文标题分词，合并成一个词频表
    weights: dict[str, float] = {}
    for topic, count in author.topics.items():
        weights[topic.casefold()] = weights.get(topic.casefold(), 0.0) + float(count)
    for work in works:
        for topic in work.topic_names:
            weights[topic.casefold()] = weights.get(topic.casefold(), 0.0) + 1.0

    total_weight = sum(weights.values())
    if total_weight <= 0:
        return Dimension(
            key="direction_fit",
            label=DIMENSION_LABELS["direction_fit"],
            score=0,
            formula_id="direction-fit/v1",
            confidence="low",
            raw={"configured": True, "topic_weight": 0},
            notes=["该导师无 topic 数据，方向契合度无法评估"],
        )

    matched_weight = 0.0
    hit_terms: list[str] = []
    for term in target_keywords:
        needle = term.strip().casefold()
        if not needle:
            continue
        for topic, weight in weights.items():
            if needle in topic:
                matched_weight += weight
                hit_terms.append(term)
    key_overlap = _clamp01(matched_weight / total_weight)

    if target_topics:
        wanted = {t.strip().casefold() for t in target_topics if t.strip()}
        have = set(weights)
        topic_hits = len(wanted & have)
        topic_overlap = topic_hits / max(1, len(wanted))
    else:
        topic_overlap = 0.0
        notes.append("未提供目标 topic 列表，仅按关键词计算")

    recency_boost = 0.5
    if hit_terms and works:
        recent_year = max((w.publication_year or 0) for w in works) - 2
        recent_hits = sum(
            1
            for w in works
            if (w.publication_year or 0) >= recent_year
            and any(term.casefold() in w.title.casefold() for term in hit_terms)
        )
        total_hits = sum(
            1 for w in works if any(term.casefold() in w.title.casefold() for term in hit_terms)
        )
        if total_hits:
            recency_boost = _clamp01(recent_hits / total_hits)

    score = _pct(0.55 * key_overlap + 0.35 * topic_overlap + 0.10 * recency_boost)
    confidence = BASE_CONFIDENCE["direction_fit"]
    if score == 0:
        confidence = "medium"
        notes.append("关键词与 topic 均无交集：可能确实不匹配，也可能该校导师的 topic 标注过粗")

    return Dimension(
        key="direction_fit",
        label=DIMENSION_LABELS["direction_fit"],
        score=score,
        formula_id="direction-fit/v1",
        confidence=confidence,
        raw={
            "configured": True,
            "key_overlap": round(key_overlap, 3),
            "topic_overlap": round(topic_overlap, 3),
            "recency_boost": round(recency_boost, 3),
            "matched_terms": ", ".join(sorted(set(hit_terms))[:6]) or None,
            "topic_weight_total": round(total_weight, 1),
        },
        notes=notes,
    )


# ============================================================== 主入口


def build_mentor_profile(
    author: AuthorRecord,
    works: list[WorkRecord],
    *,
    now: datetime,
    generated_at: str,
    target_keywords: tuple[str, ...] = (),
    target_topics: tuple[str, ...] = (),
    annual_output_baseline: float = DEFAULT_ANNUAL_OUTPUT_BASELINE,
) -> MentorProfile:
    """装配五维画像。纯函数：同样的输入必然得到同样的输出。

    `overall_score` 是五维的**置信度加权**几何均值，仅供参考：
    雷达图才是主展示形态，单一总分容易掩盖「某一维残缺」。
    低置信度维度在聚合时权重减半，避免用缺失数据主导总分。
    """
    dimensions = {
        "recent_activity": _recent_activity(author, works, now, annual_output_baseline),
        "hindex_slope": _hindex_slope(author, works, now),
        "funding_capacity": _funding_capacity(author, works, now),
        "undergrad_friendliness": _undergrad_friendliness(author, works, now),
        "direction_fit": _direction_fit(author, works, target_keywords, target_topics),
    }

    confidence_weight = {"high": 1.0, "medium": 0.75, "low": 0.5}
    weights = {k: confidence_weight.get(d.confidence, 0.5) for k, d in dimensions.items()}
    total_weight = sum(weights.values())
    weighted = sum(dimensions[k].score * weights[k] for k in DIMENSIONS) / total_weight

    high_conf = sum(1 for d in dimensions.values() if d.confidence == "high")
    data_completeness = min(1.0, (high_conf + 0.6 * sum(
        1 for d in dimensions.values() if d.confidence == "medium"
    )) / len(DIMENSIONS))

    notes: list[str] = []
    if not works:
        notes.append("该作者在 OpenAlex 无 works 记录：画像置信度整体偏低，建议人工复核")
    if len(works) < 10:
        notes.append(f"仅 {len(works)} 篇可查论文，H 斜率与基金覆盖率均不稳定")

    top_topics = tuple(
        name for name, _ in sorted(author.topics.items(), key=lambda kv: kv[1], reverse=True)[:5]
    )

    return MentorProfile(
        author_id=author.author_id,
        display_name=author.display_name,
        orcid=author.orcid,
        generated_at=generated_at,
        dimensions=dimensions,
        overall_score=int(round(_clamp01(weighted / 100.0) * 100)),
        data_completeness=data_completeness,
        institutions=author.institution_names,
        top_topics=top_topics,
        work_count=author.works_count or len(works),
        citation_count=author.cited_by_count,
        notes=notes,
    )
