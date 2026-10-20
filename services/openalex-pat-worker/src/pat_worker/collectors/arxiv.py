"""arXiv Atom API 采集器。

接口：`GET https://export.arxiv.org/api/query?search_query=cat:physics.optics&sortBy=submittedDate`

三条来自 arXiv 官方 API 用户手册的硬要求，本采集器全部遵守：
1. 请求间隔 ≥ 3 秒且**不得并发**（由 `PoliteHttpClient` 的 per-host 限速器保证）；
2. 每个分类单独查，而不是用 `OR` 拼一个巨型查询——巨型查询的返回往往被截断且难归因；
3. 必须能处理**零结果**：arXiv 对无结果的查询返回合法 Atom 但无 entry，不是错误。

解析用 `xml.etree.ElementTree` 而非第三方 XML 库：Atom 结构稳定，标准库够用，
少一个依赖对 08:00 的准时率是实打实的收益。
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from typing import Final

from dateutil import parser as date_parser

from pat_worker.http.client import PoliteHttpClient, UpstreamError
from pat_worker.models import CollectedBatch, PaperItem

ATOM: Final = "{http://www.w3.org/2005/Atom}"
ARXIV_NS: Final = "{http://arxiv.org/schemas/atom}"

#: 版本后缀：2610.04921v2 → 2610.04921。同一篇的多版不该占两张卡。
_VERSION_SUFFIX = re.compile(r"v\d+$")
_ARXIV_ID_FROM_URL = re.compile(r"abs/([^/]+?)(?:v\d+)?$")


def normalize_arxiv_id(raw: str) -> str:
    """把各种形态的 arXiv id 归一为无版本号形式。

    兼容 `2610.04921v3`、`https://arxiv.org/abs/2610.04921v3`、`cond-mat/0601001v1`。
    """
    value = (raw or "").strip()
    if not value:
        return ""
    match = _ARXIV_ID_FROM_URL.search(value)
    if match:
        value = match.group(1)
    value = value.rsplit("/", 1)[-1] if value.startswith("http") else value
    return _VERSION_SUFFIX.sub("", value)


def parse_arxiv_feed(xml_text: str, *, category: str = "") -> list[PaperItem]:
    """解析 arXiv Atom feed。空 feed 返回空列表（不是错误）。"""
    if not xml_text or not xml_text.strip():
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise UpstreamError("arxiv-feed", None, f"Atom 解析失败: {exc}") from exc

    items: list[PaperItem] = []
    for entry in root.findall(f"{ATOM}entry"):
        title = _text(entry.find(f"{ATOM}title"))
        # arXiv 的 id 形如 http://arxiv.org/abs/2610.04921v1
        raw_id = _text(entry.find(f"{ATOM}id"))
        arxiv_id = normalize_arxiv_id(raw_id)
        published = _parse_dt(_text(entry.find(f"{ATOM}published"))) or _parse_dt(
            _text(entry.find(f"{ATOM}updated"))
        )
        if not title or published is None:
            continue

        authors = [
            _text(node.find(f"{ATOM}name"))
            for node in entry.findall(f"{ATOM}author")
        ]
        primary = entry.find(f"{ARXIV_NS}primary_category")
        primary_term = primary.get("term", "") if primary is not None else category
        categories = tuple(
            cat.get("term", "")
            for cat in entry.findall(f"{ATOM}category")
            if cat.get("term")
        )
        summary = " ".join(_text(entry.find(f"{ATOM}summary")).split())
        # journal_ref 常含「已接收于 XXX」的线索；目前只作为源显示名，不参与打分。
        journal_ref = _text(entry.find(f"{ARXIV_NS}journal_ref"))
        _ = authors  # 作者列表暂不入库，仅在需要时扩展 PaperItem

        items.append(
            PaperItem(
                source="arxiv",
                title=" ".join(title.split()),
                published_at=published,
                url=f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else raw_id,
                arxiv_id=arxiv_id,
                abstract=summary,
                # 预印本：未评审，档位固定 preprint。若已有 journal_ref，说明已见刊，
                # 但仍按预印本源处理（避免同一篇被 arXiv 与期刊各占一卡）。
                venue_tier="preprint",
                venue_name=journal_ref or "arXiv",
                tags=tuple(dict.fromkeys([primary_term, *categories]))[:5],
                dedupe_keys=(f"arxiv:{arxiv_id}",) if arxiv_id else (),
                raw_id=raw_id,
                flags=frozenset(),
                # arXiv 不提供引用数；留给 OpenAlex/Crossref 侧的归并结果补齐
                cited_by_count=None,
                topic_momentum=None,
            )
        )
    return items


def _text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return (node.text or "").strip()


def _parse_dt(raw: str) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = date_parser.isoparse(raw)
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def build_query(category: str, *, page_size: int = 40) -> dict[str, object]:
    """单个分类的查询参数。sortBy=submittedDate 保证拿的是最新提交。"""
    return {
        "search_query": f"cat:{category}",
        "start": 0,
        "max_results": page_size,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }


async def collect_arxiv(
    client: PoliteHttpClient,
    *,
    base_url: str,
    categories: tuple[str, ...],
    page_size: int = 40,
) -> CollectedBatch:
    """逐分类采集。任一分类失败不阻断其余分类，失败原因聚合到 error 字段。

    为什么串行而不是 asyncio.gather：arXiv 明确要求不得并发，且
    `PoliteHttpClient` 的 per-host 锁已经保证了串行；这里显式串行只是让意图更清楚。
    """
    items: list[PaperItem] = []
    errors: list[str] = []
    fetched = 0
    for category in categories:
        try:
            result = await client.get(base_url, params=build_query(category, page_size=page_size))
        except UpstreamError as exc:
            errors.append(f"{category}: {exc.status or 'network'} {exc.detail[:120]}")
            continue
        parsed = parse_arxiv_feed(result.text, category=category)
        fetched += len(parsed)
        items.extend(parsed)

    return CollectedBatch(
        source="arxiv",
        items=items,
        ok=not errors,
        error="; ".join(errors),
        fetched=fetched,
    )
