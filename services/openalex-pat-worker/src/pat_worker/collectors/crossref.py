"""Crossref 采集器：DOI 元数据补全与「新注册 DOI」流。

在 04 站的定位是**第三源**，两个用途：

1. **独立信源**：`/works?filter=from-created-date:...` 能捞到 OpenAlex 尚未入库的
   新 DOI（OpenAlex 有 1–3 天延迟）。这正是 24h 监听需要的补位。
2. **元数据仲裁**：同一篇论文在 arXiv 与 OpenAlex 的期刊名可能不一致，Crossref 的
   `container-title` 是出版方直接注册的，权威性最高。

礼貌池要求（Crossref 官方）：
- User-Agent 必须是 `App/Version (mailto:...)` 形态，且**不允许**只写库名；
- 建议在查询串也带 `mailto`；
- 不要并发超过 1 个连接去打 `/works`（本服务的 per-host 限速器已覆盖）。

坑：Crossref 的 `published`（最早公开日）与 `created`（DOI 注册日）含义不同。
04 站要「24h 内新出现的东西」，用 `created`；`published` 用于卡片上的发布时间。
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any, Final

from dateutil import parser as date_parser

from pat_worker.collectors.openalex import classify_venue
from pat_worker.http.client import PoliteHttpClient, UpstreamError
from pat_worker.models import CollectedBatch, PaperItem

#: Crossref 的 type → 我们关心的粗分类。其余类型（component、dataset…）直接丢弃。
KEEP_TYPES: Final[frozenset[str]] = frozenset(
    {"journal-article", "proceedings-article", "posted-content", "book-chapter"}
)


def _first(value: Any) -> str:
    """Crossref 大量字段是数组，取第一个非空值。"""
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item.strip():
                return item.strip()
        return ""
    if isinstance(value, str):
        return value.strip()
    return ""


def _date_from_parts(node: dict[str, Any] | None) -> datetime | None:
    """解析 Crossref 的 `date-parts` 结构：[2026, 10, 19] 或 [2026, 10]。"""
    if not isinstance(node, dict):
        return None
    parts = node.get("date-parts")
    if not parts or not isinstance(parts, list) or not parts[0]:
        return None
    values = parts[0]
    try:
        year = int(values[0])
        month = int(values[1]) if len(values) > 1 else 1
        day = int(values[2]) if len(values) > 2 else 1
        return datetime(year, month, day, tzinfo=UTC)
    except (ValueError, TypeError, IndexError):
        return None


def _clean_abstract(raw: str) -> str:
    """Crossref 的 abstract 是 JATS XML 片段，去掉标签与多余空白。"""
    if not raw:
        return ""
    text = re.sub(r"<[^>]+>", " ", raw)
    text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    return " ".join(text.split())[:2000]


def crossref_item_to_paper(payload: dict[str, Any]) -> PaperItem | None:
    """单条 Crossref `message` → PaperItem。"""
    work_type = (payload.get("type") or "").strip().lower()
    if work_type not in KEEP_TYPES:
        return None

    title = _first(payload.get("title"))
    if not title:
        return None

    # 发布时间优先 published，回落到 issued / created
    published = (
        _date_from_parts(payload.get("published"))
        or _date_from_parts(payload.get("issued"))
        or _date_from_parts(payload.get("created"))
    )
    if published is None:
        return None

    doi = (payload.get("DOI") or "").strip().lower()
    container = _first(payload.get("container-title"))
    is_preprint = work_type == "posted-content"

    url = (payload.get("URL") or "").strip()
    if not url and doi:
        url = f"https://doi.org/{doi}"

    relations: list[str] = []
    for key in ("relation", "update-to"):
        value = payload.get(key)
        if isinstance(value, dict):
            relations.extend(value.keys())
        elif isinstance(value, list):
            relations.extend(str(v) for v in value)

    flags: set[str] = set()
    subtype = (payload.get("subtype") or "").casefold()
    if "retraction" in subtype or "retraction" in " ".join(relations).casefold():
        flags.add("retracted")
    if "withdrawal" in subtype:
        flags.add("withdrawn")

    return PaperItem(
        source="crossref",
        title=" ".join(title.split()),
        published_at=published,
        url=url or f"https://doi.org/{doi}",
        doi=doi,
        abstract=_clean_abstract(payload.get("abstract") or ""),
        venue_tier="preprint" if is_preprint else classify_venue(container, work_type),
        venue_name=container,
        cited_by_count=int(payload.get("is-referenced-by-count") or 0),
        tags=(),
        dedupe_keys=(f"crossref:{doi}",) if doi else (),
        flags=frozenset(flags),
        raw_id=doi,
    )


def build_query(*, since: datetime, rows: int = 100, mailto: str = "") -> dict[str, object]:
    """按 DOI 注册日抓近 N 天新注册条目。

    注意 `filter=from-created-date` 用的是 **UTC 日期**，且 Crossref 的
    `created` 时间戳精度到秒（`created-timestamp` 另字段），这里只用日期粒度，
    多捞一天由热度算法的时效因子过滤，比漏捞安全。
    """
    params: dict[str, object] = {
        "filter": f"from-created-date:{since.astimezone(UTC).strftime('%Y-%m-%d')},type:journal-article",
        "rows": min(1000, max(1, rows)),
        "sort": "created",
        "order": "desc",
        "select": ",".join(
            [
                "DOI",
                "title",
                "container-title",
                "type",
                "subtype",
                "published",
                "issued",
                "created",
                "URL",
                "abstract",
                "is-referenced-by-count",
                "relation",
                "update-to",
            ]
        ),
    }
    if mailto:
        params["mailto"] = mailto
    return params


async def collect_crossref(
    client: PoliteHttpClient,
    *,
    base_url: str,
    since: datetime,
    rows: int = 100,
) -> CollectedBatch:
    """采集 Crossref 新注册条目。"""
    params = build_query(since=since, rows=rows)
    try:
        result = await client.get(f"{base_url}/works", params=params)
    except UpstreamError as exc:
        return CollectedBatch(
            source="crossref", ok=False, error=f"{exc.status or 'network'}: {exc.detail[:200]}"
        )

    try:
        payload = json.loads(result.text)
    except json.JSONDecodeError as exc:
        return CollectedBatch(source="crossref", ok=False, error=f"JSON 解析失败: {exc}")

    items: list[PaperItem] = []
    for row in (payload.get("message") or {}).get("items") or []:
        item = crossref_item_to_paper(row)
        if item is not None:
            items.append(item)

    return CollectedBatch(source="crossref", items=items, ok=True, fetched=len(items))


async def fetch_doi_metadata(
    client: PoliteHttpClient, *, base_url: str, doi: str
) -> dict[str, Any] | None:
    """单 DOI 元数据。用于归并后补齐期刊名/摘要，失败返回 None（不抛）。"""
    try:
        result = await client.get(f"{base_url}/works/{doi}")
    except UpstreamError:
        return None
    try:
        return (json.loads(result.text) or {}).get("message")
    except json.JSONDecodeError:
        return None
