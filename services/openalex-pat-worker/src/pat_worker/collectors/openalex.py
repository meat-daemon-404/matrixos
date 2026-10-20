"""OpenAlex 采集器：论文流 + 导师图谱。

OpenAlex 是 04 站与 06 站共用的主数据源。三条来自官方文档的硬要求：

1. **必须带 `mailto`**（礼貌池），否则被降级到低配额池并可能被临时封。本服务的
   `PoliteHttpClient` 默认把 `mailto` 注入每个查询串。
2. **`per-page` 上限 200**，超过直接 400。这里默认取 50。
3. **abstract 是倒排索引**（`abstract_inverted_index`），不是字符串，必须本地重建。
   这是最容易踩的坑：直接读 `abstract` 会拿到 `None`。

导师侧的关键约束：**funding 元数据覆盖不全**。OpenAlex 的 `funders`/`awards`
来自 Crossref 的 funder 注册表，国内单位与中文期刊覆盖率很低。因此采集器只做
「如实搬运」，绝不在缺失时补默认值——降级判断在 `domain/mentor.py` 里显式处理。
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Final

from dateutil import parser as date_parser

from pat_worker.domain.mentor import AuthorRecord, WorkRecord
from pat_worker.http.client import PoliteHttpClient, UpstreamError
from pat_worker.models import CollectedBatch, PaperItem

#: 顶刊名单（小写子串匹配）。只列 04 站会实际遇到的物理/光电/材料方向载体。
TOP_JOURNALS: Final[tuple[str, ...]] = (
    "nature photonics",
    "nature physics",
    "nature materials",
    "nature energy",
    "nature communications",
    "nature",
    "science",
    "physical review letters",
    "prl",
    "science advances",
    "light: science & applications",
    "optica",
    "advanced materials",
    "advanced photonics",
    "laser & photonics reviews",
    "acs photonics",
    "npj computational materials",
    "national science review",
    "physical review x",
    "reports on progress in physics",
)

#: 学科内强刊
FIELD_LEADER_JOURNALS: Final[tuple[str, ...]] = (
    "physical review b",
    "physical review applied",
    "physical review research",
    "applied physics letters",
    "optics express",
    "optics letters",
    "journal of the optical society of america",
    "ieee journal of selected topics in quantum electronics",
    "journal of applied physics",
    "nanophotonics",
    "photonics research",
    "acs nano",
    "nano letters",
    "journal of physical chemistry",
    "chemistry of materials",
    "materials today",
    "astronomy & astrophysics",
    "astrophysical journal",
    "monthly notices of the royal astronomical society",
    "quantum science and technology",
)

#: 预印本平台（OpenAlex 里 type=preprint 或 source 名命中）
PREPRINT_MARKERS: Final[tuple[str, ...]] = ("arxiv", "biorxiv", "medrxiv", "research square", "ssrn")


def decode_abstract(inverted_index: dict[str, list[int]] | None) -> str:
    """把 OpenAlex 的倒排索引还原成正常语序的摘要。

    `{"We": [0], "show": [1], "that": [2]}` → "We show that"。
    索引可能不连续（OpenAlex 偶有空洞），因此按位置排序后按顺序拼接，
    不假设索引是 0..n-1 的紧密排列。
    """
    if not inverted_index:
        return ""
    positioned: list[tuple[int, str]] = []
    for word, positions in inverted_index.items():
        for pos in positions or []:
            positioned.append((int(pos), word))
    if not positioned:
        return ""
    positioned.sort(key=lambda pair: pair[0])
    return " ".join(word for _, word in positioned)


def classify_venue(source_name: str | None, work_type: str | None = None) -> str:
    """把期刊名映射到热度算法认识的档位。

    顺序敏感：先判预印本，再判顶刊，最后判强刊。原因是 arXiv 的
    `primary_location.source.display_name` 就是 "arXiv (Cornell University)"，
    若先判顶刊，名字里带 "nature" 的 arXiv 镜像站会被误判成顶刊。
    """
    name = (source_name or "").strip().casefold()
    wtype = (work_type or "").strip().casefold()

    if wtype in {"preprint"} or any(marker in name for marker in PREPRINT_MARKERS):
        return "preprint"
    if not name:
        return "unknown"
    # `nature` 单独一项用等值/前缀判定，否则 "nature photonics" 之外的名字（如
    # "nature-inspired computing"）也会被误伤成顶刊。
    for journal in TOP_JOURNALS:
        if journal == "nature":
            if name == "nature" or name.startswith("nature "):
                return "top_journal"
            continue
        if journal in name:
            return "top_journal"
    if any(journal in name for journal in FIELD_LEADER_JOURNALS):
        return "field_leader"
    return "reputable"


def _parse_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return date_parser.isoparse(raw)
    except (ValueError, TypeError):
        return None


def _openalex_id_tail(value: str | None) -> str:
    """`https://openalex.org/W123` → `W123`。"""
    if not value:
        return ""
    return value.rstrip("/").rsplit("/", 1)[-1]


def _strip_doi(value: str | None) -> str:
    if not value:
        return ""
    doi = value.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if doi.lower().startswith(prefix):
            doi = doi[len(prefix) :]
            break
    return doi.strip().lower()


def work_to_item(work: dict[str, Any]) -> PaperItem | None:
    """把一条 OpenAlex work 转成 PaperItem。缺标题/日期则丢弃。"""
    title = (work.get("title") or work.get("display_name") or "").strip()
    published = _parse_date(work.get("publication_date")) or _parse_date(
        work.get("created_date")
    )
    if not title or published is None:
        return None

    doi = _strip_doi(work.get("doi"))
    location = work.get("primary_location") or {}
    source_name = ((location.get("source") or {}) or {}).get("display_name") or ""
    work_type = work.get("type") or ""

    flags: set[str] = set()
    if work.get("is_retracted"):
        flags.add("retracted")

    topics = work.get("topics") or []
    topic_names = tuple(
        (topic.get("display_name") or "").strip()
        for topic in topics[:3]
        if isinstance(topic, dict) and topic.get("display_name")
    )

    return PaperItem(
        source="openalex",
        title=" ".join(title.split()),
        published_at=published,
        url=(work.get("doi") or work.get("id") or "").strip(),
        doi=doi,
        abstract=decode_abstract(work.get("abstract_inverted_index")),
        venue_tier=classify_venue(source_name, work_type),
        venue_name=source_name,
        cited_by_count=int(work.get("cited_by_count") or 0),
        tags=tuple(dict.fromkeys(topic_names))[:5],
        dedupe_keys=(f"openalex:{_openalex_id_tail(work.get('id'))}",),
        flags=frozenset(flags),
        raw_id=_openalex_id_tail(work.get("id")),
    )


def build_works_query(
    *,
    field_ids: tuple[str, ...],
    since: datetime,
    page_size: int = 50,
    mailto: str = "",
) -> dict[str, object]:
    """构造 04 站的 works 查询。

    用 `from_created_date` 而不是 `from_publication_date`：OpenAlex 的入库延迟
    通常 1–3 天，按发布日期过滤会漏掉刚上线的最新成果，而 04 站卖的就是「24h」。
    代价是会捞到少量「旧文新入库」，由热度算法的时效因子自然压低，不进早报。
    """
    filters = [
        f"from_created_date:{since.strftime('%Y-%m-%d')}",
        "is_paratext:false",
    ]
    if field_ids:
        field_clause = "|".join(field_ids)
        filters.append(f"primary_topic.field.id:{field_clause}")
    params: dict[str, object] = {
        "filter": ",".join(filters),
        "per-page": min(200, max(1, page_size)),
        "sort": "publication_date:desc",
        "select": ",".join(
            [
                "id",
                "doi",
                "title",
                "display_name",
                "publication_date",
                "created_date",
                "type",
                "cited_by_count",
                "primary_location",
                "topics",
                "abstract_inverted_index",
                "is_retracted",
            ]
        ),
    }
    if mailto:
        params["mailto"] = mailto
    return params


async def collect_openalex_works(
    client: PoliteHttpClient,
    *,
    base_url: str,
    field_ids: tuple[str, ...],
    since: datetime,
    page_size: int = 50,
) -> CollectedBatch:
    """采一批 OpenAlex 新入库论文。单页即可覆盖 24h（物理+材料约 200–600 篇/天），
    因此不做游标翻页——翻页会让 08:00 的耗时不可控。
    """
    params = build_works_query(field_ids=field_ids, since=since, page_size=page_size)
    try:
        result = await client.get(f"{base_url}/works", params=params)
    except UpstreamError as exc:
        return CollectedBatch(
            source="openalex", ok=False, error=f"{exc.status or 'network'}: {exc.detail[:200]}"
        )

    try:
        payload = json.loads(result.text)
    except json.JSONDecodeError as exc:
        return CollectedBatch(source="openalex", ok=False, error=f"JSON 解析失败: {exc}")

    items: list[PaperItem] = []
    for work in payload.get("results") or []:
        item = work_to_item(work)
        if item is not None:
            items.append(item)

    return CollectedBatch(source="openalex", items=items, ok=True, fetched=len(items))


# =========================================================== 06 站：导师图谱


def author_from_payload(payload: dict[str, Any]) -> AuthorRecord:
    """`/authors/{id}` → AuthorRecord。"""
    stats = payload.get("summary_stats") or {}
    counts: dict[int, dict[str, int]] = {}
    for row in payload.get("counts_by_year") or []:
        year = row.get("year")
        if year is None:
            continue
        counts[int(year)] = {
            "works_count": int(row.get("works_count") or 0),
            "cited_by_count": int(row.get("cited_by_count") or 0),
        }

    topics: dict[str, int] = {}
    for topic in payload.get("topics") or []:
        name = (topic.get("display_name") or "").strip()
        if name:
            topics[name] = int(topic.get("count") or 0)

    institutions = tuple(
        (inst.get("display_name") or "").strip()
        for inst in (payload.get("last_known_institutions") or [])
        if isinstance(inst, dict) and inst.get("display_name")
    )

    years = list(counts) or []
    return AuthorRecord(
        author_id=_openalex_id_tail(payload.get("id")),
        display_name=(payload.get("display_name") or payload.get("full_name") or "").strip(),
        orcid=(payload.get("orcid") or "").strip(),
        works_count=int(payload.get("works_count") or 0),
        cited_by_count=int(payload.get("cited_by_count") or 0),
        h_index=int(stats.get("h_index") or 0),
        i10_index=int(stats.get("i10_index") or 0),
        two_yr_mean_citedness=float(stats.get("2yr_mean_citedness") or 0.0),
        counts_by_year=counts,
        topics=topics,
        institution_names=institutions,
        last_active_year=max(years) if years else None,
    )


def work_from_payload(payload: dict[str, Any]) -> WorkRecord:
    """`/works` 单条 → WorkRecord（导师画像用）。"""
    counts: dict[int, int] = {}
    for row in payload.get("counts_by_year") or []:
        year = row.get("year")
        if year is None:
            continue
        counts[int(year)] = int(row.get("cited_by_count") or 0)

    authorships = payload.get("authorships") or []
    position = "middle"
    is_corresponding = False
    if authorships:
        first = authorships[0]
        position = (first.get("author_position") or "middle").lower()
        is_corresponding = any(bool(a.get("is_corresponding")) for a in authorships)

    funder_names: list[str] = []
    award_count = 0
    for funder in payload.get("funders") or []:
        name = (funder.get("display_name") or "").strip()
        if name:
            funder_names.append(name)
    for award in payload.get("awards") or []:
        award_count += 1
        name = (award.get("funder_display_name") or "").strip()
        if name and name not in funder_names:
            funder_names.append(name)

    location = payload.get("primary_location") or {}
    source = location.get("source") or {}
    topics = payload.get("topics") or []

    return WorkRecord(
        id=_openalex_id_tail(payload.get("id")),
        title=(payload.get("title") or payload.get("display_name") or "").strip(),
        publication_year=payload.get("publication_year"),
        cited_by_count=int(payload.get("cited_by_count") or 0),
        counts_by_year=counts,
        author_position=position,
        is_corresponding=is_corresponding,
        work_type=(payload.get("type") or "article").lower(),
        venue_display_name=(source.get("display_name") or "").strip(),
        is_oa=bool((payload.get("open_access") or {}).get("is_oa")),
        topic_names=tuple(
            (t.get("display_name") or "").strip()
            for t in topics[:5]
            if isinstance(t, dict) and t.get("display_name")
        ),
        funder_names=tuple(funder_names),
        award_count=award_count,
        is_retracted=bool(payload.get("is_retracted")),
    )


async def search_authors(
    client: PoliteHttpClient,
    *,
    base_url: str,
    query: str,
    per_page: int = 10,
) -> list[dict[str, Any]]:
    """按姓名检索导师候选。返回原始 payload 列表，由路由层决定投影。

    用 `/authors?search=` 而不是 `/autocomplete`：autocomplete 不返回
    summary_stats，而 H-index 是五维之一的输入，必须一次拿全。
    """
    params = {"search": query, "per-page": min(50, max(1, per_page))}
    result = await client.get(f"{base_url}/authors", params=params)
    payload = json.loads(result.text)
    return list(payload.get("results") or [])


async def fetch_author_works(
    client: PoliteHttpClient,
    *,
    base_url: str,
    author_id: str,
    page_size: int = 200,
) -> list[WorkRecord]:
    """抓取一位导师的全部 works（单页 200 篇，覆盖绝大多数 PI）。

    只取画像需要的字段，`select` 让响应体缩小一个数量级——这对 06 站的
    「同时对比 5 位导师」场景很关键。
    """
    params = {
        "filter": f"author.id:{author_id},is_paratext:false",
        "per-page": min(200, max(1, page_size)),
        "sort": "publication_year:desc",
        "select": ",".join(
            [
                "id",
                "title",
                "display_name",
                "publication_year",
                "cited_by_count",
                "counts_by_year",
                "authorships",
                "type",
                "primary_location",
                "open_access",
                "topics",
                "funders",
                "awards",
                "is_retracted",
            ]
        ),
    }
    result = await client.get(f"{base_url}/works", params=params)
    payload = json.loads(result.text)
    return [work_from_payload(row) for row in payload.get("results") or []]


async def fetch_author(
    client: PoliteHttpClient, *, base_url: str, author_id: str
) -> AuthorRecord:
    """抓取单条作者元数据。"""
    result = await client.get(f"{base_url}/authors/{author_id}")
    return author_from_payload(json.loads(result.text))
