"""Nature 系列 RSS 采集器。

04 站的产品文案点名了 **Nature Photonics**，`specs/microsites.json` 第 04 行的
desc 写的是「监听 arXiv / Nature Photonics 24h 前沿动态」。因此 Nature 是**必需**
信源，不是可选加分项。

为什么用 RSS 而不是 Nature 的 OA API：
- Nature 的 OA API 只返回开放获取文章，Nature Photonics 大部分内容不在其中；
- RSS 覆盖当期全部目录（标题 + 摘要 + 发布日期），足够做早报；
- RSS 无需 API Key，不引入新密钥管理负担。

RSS 的两个坑：
1. `pubDate` 是 RFC 822 格式（`Mon, 19 Oct 2026 09:00:00 GMT`），
   `dateutil.parser.parse` 能处理，但要用 `parse` 不是 `isoparse`。
2. 摘要里带 HTML 实体与标签，必须清洗，否则小程序端会显示 `&lt;p&gt;`。
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from typing import Final

from dateutil import parser as date_parser

from pat_worker.http.client import PoliteHttpClient, UpstreamError
from pat_worker.models import CollectedBatch, PaperItem

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_ENTITY_MAP: Final[dict[str, str]] = {
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&#8211;": "–",
    "&#8212;": "—",
    "&#8217;": "’",
    "&#8220;": "“",
    "&#8221;": "”",
}

#: RSS URL → 信源 id。与 morning-brief.schema.json 的 source_id 枚举对齐。
#: 不在表内的 URL 按域名兜底为 "nature"，不抛异常——运维加一个新 RSS 不该让服务崩。
RSS_SOURCE_MAP: Final[dict[str, str]] = {
    "nphoton.rss": "nature_photonics",
    "nphys.rss": "nature_physics",
    "nmat.rss": "nature_materials",
}

#: Nature 系列整体按顶刊档位计（子刊同样经过严格同行评审）。
NATURE_VENUE_TIER = "top_journal"


def clean_html(raw: str) -> str:
    """去标签、解实体、压空白。RSS 描述字段必须经过这一步。"""
    if not raw:
        return ""
    text = raw
    for entity, char in _ENTITY_MAP.items():
        text = text.replace(entity, char)
    text = _TAG_RE.sub(" ", text)
    # 处理数字实体（&#123; 之类）
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    return _WS_RE.sub(" ", text).strip()


def source_id_for_url(url: str) -> str:
    base = url.rsplit("/", 1)[-1].lower()
    if base in RSS_SOURCE_MAP:
        return RSS_SOURCE_MAP[base]
    for suffix, source in RSS_SOURCE_MAP.items():
        if suffix in url.lower():
            return source
    return "nature"


def _parse_rfc822(raw: str) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = date_parser.parse(raw)
    except (ValueError, TypeError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def _find_text(node: ET.Element, *tags: str) -> str:
    for tag in tags:
        child = node.find(tag)
        if child is not None and child.text:
            return child.text.strip()
        # dc:creator 之类的命名空间标签用通配匹配
        if ":" in tag:
            local = tag.split(":", 1)[1]
            for sub in node:
                if sub.tag.endswith(f"}}{local}"):
                    return (sub.text or "").strip()
    return ""


def _extract_link(node: ET.Element) -> str:
    link = node.find("link")
    if link is not None:
        href = link.get("href")
        if href:
            return href.strip()
        if link.text:
            return link.text.strip()
    for child in node:
        if child.tag.endswith("}link") and child.get("href"):
            return (child.get("href") or "").strip()
    guid = _find_text(node, "guid")
    if guid.startswith("http"):
        return guid
    return ""


def parse_nature_feed(xml_text: str, *, feed_url: str = "") -> list[PaperItem]:
    """解析 Nature RSS（RSS 2.0 / RDF 1.1 均兼容）。空 feed 返回空列表。"""
    if not xml_text or not xml_text.strip():
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise UpstreamError(feed_url or "nature-feed", None, f"RSS 解析失败: {exc}") from exc

    source = source_id_for_url(feed_url)
    # RSS 2.0: rss/channel/item；RDF: rdf:RDF/item
    items = list(root.iter("item"))
    result: list[PaperItem] = []
    channel_title = ""
    channel = root.find("channel")
    if channel is not None:
        channel_title = _find_text(channel, "title")
    for node in items:
        title = clean_html(_find_text(node, "title"))
        if not title:
            continue
        published = _parse_rfc822(
            _find_text(node, "pubDate", "dc:date", "date", "published")
        )
        if published is None:
            continue
        description = clean_html(
            _find_text(node, "description", "dc:description", "summary", "encoded")
        )
        link = _extract_link(node)
        doi = ""
        candidates = [link, _find_text(node, "guid"), description]
        for candidate in candidates:
            match = re.search(r"10\.\d{4,9}/[^\s\"<>]+", candidate or "")
            if match:
                doi = match.group(0).rstrip(".,;").lower()
                break

        venue_name = channel_title or "Nature"
        result.append(
            PaperItem(
                source=source,
                title=title,
                published_at=published,
                url=link or (f"https://doi.org/{doi}" if doi else ""),
                doi=doi,
                abstract=description,
                venue_tier=NATURE_VENUE_TIER,
                venue_name=venue_name,
                # RSS 不提供引用数：留 None，由归并阶段用 OpenAlex 补
                cited_by_count=None,
                tags=(),
                dedupe_keys=tuple(
                    key
                    for key in (
                        f"doi:{doi}" if doi else "",
                        f"nature:{_find_text(node, 'guid')}" if _find_text(node, "guid") else "",
                    )
                    if key
                ),
                raw_id=_find_text(node, "guid"),
            )
        )
    return result


async def collect_nature(
    client: PoliteHttpClient,
    *,
    feed_urls: tuple[str, ...],
) -> CollectedBatch:
    """采集全部 Nature RSS。单个 feed 失败不阻断其余 feed。"""
    items: list[PaperItem] = []
    errors: list[str] = []
    fetched = 0
    seen_sources: list[str] = []

    for url in feed_urls:
        try:
            result = await client.get(url, polite=False)
        except UpstreamError as exc:
            errors.append(f"{url}: {exc.status or 'network'} {exc.detail[:100]}")
            continue
        try:
            parsed = parse_nature_feed(result.text, feed_url=url)
        except UpstreamError as exc:
            errors.append(f"{url}: {exc.detail[:100]}")
            continue
        fetched += len(parsed)
        items.extend(parsed)
        source = source_id_for_url(url)
        if source not in seen_sources:
            seen_sources.append(source)

    return CollectedBatch(
        source=seen_sources[0] if len(seen_sources) == 1 else "nature",
        items=items,
        ok=not errors,
        error="; ".join(errors),
        fetched=fetched,
    )
