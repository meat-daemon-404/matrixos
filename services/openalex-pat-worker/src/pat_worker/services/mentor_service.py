"""06 站导师画像的服务层：检索 → 抓取 → 装配 → 缓存。

与 `domain/mentor.py` 的分工：那边只做纯计算，这边负责网络与缓存。
缓存 TTL 默认 7 天——导师画像的变化周期是「月」，不是「小时」，没必要每次重算；
但 7 天后强制重算，否则 H-index 斜率的「近 3 年」窗口会随时间失真。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

from pat_worker.collectors.openalex import (
    author_from_payload,
    fetch_author,
    fetch_author_works,
    search_authors,
)
from pat_worker.domain.mentor import (
    AuthorRecord,
    MentorProfile,
    WorkRecord,
    build_mentor_profile,
)
from pat_worker.http.client import PoliteHttpClient, UpstreamError
from pat_worker.settings import Settings
from pat_worker.store.sqlite_store import Store
from pat_worker.timeutil import isoformat_offset, resolve_tz

logger = logging.getLogger(__name__)

#: 画像缓存有效期。7 天。
PROFILE_CACHE_HOURS = 168
#: 装配画像时抓取的论文数上限。200 篇覆盖绝大多数 PI 的整个生涯；
#: 再多也只会拖慢响应而不改变五维结果（权重集中在近 3–5 年）。
MAX_WORKS_FOR_PROFILE = 200


@dataclass(slots=True)
class MentorSearchHit:
    """检索结果条目。字段刻意精简：06 站在列表页只需要这几个来判断点哪个。"""

    author_id: str
    display_name: str
    works_count: int
    cited_by_count: int
    h_index: int
    institutions: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    orcid: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "author_id": self.author_id,
            "display_name": self.display_name,
            "works_count": self.works_count,
            "cited_by_count": self.cited_by_count,
            "h_index": self.h_index,
            "institutions": list(self.institutions),
            "topics": list(self.topics),
            "orcid": self.orcid,
        }


def _hit_from_payload(payload: dict[str, object]) -> MentorSearchHit:
    author = author_from_payload(payload)  # type: ignore[arg-type]
    return MentorSearchHit(
        author_id=author.author_id,
        display_name=author.display_name,
        works_count=author.works_count,
        cited_by_count=author.cited_by_count,
        h_index=author.h_index,
        institutions=list(author.institution_names[:3]),
        topics=list(author.topics)[:5],
        orcid=author.orcid,
    )


async def search_mentors(
    client: PoliteHttpClient, *, settings: Settings, query: str, per_page: int = 10
) -> list[MentorSearchHit]:
    """按姓名/机构检索导师。空查询返回空列表（不浪费一次 API 调用）。"""
    text = (query or "").strip()
    if not text:
        return []
    payloads = await search_authors(
        client, base_url=settings.openalex_base_url, query=text, per_page=per_page
    )
    return [_hit_from_payload(payload) for payload in payloads]


async def build_profile(
    client: PoliteHttpClient,
    *,
    settings: Settings,
    author_id: str,
    now: datetime,
    target_keywords: tuple[str, ...] = (),
    target_topics: tuple[str, ...] = (),
    store: Store | None = None,
    use_cache: bool = True,
) -> MentorProfile | None:
    """构建单导师画像。作者不存在时返回 None（而不是抛 404 异常）。

    缓存命中时**不重新过滤 target_keywords**：方向契合度依赖订阅词，
    订阅词变了就必须重算。因此缓存键在 author_id 之外还带关键词指纹。
    """
    keywords_fingerprint = "|".join(sorted(target_keywords))
    cache_key = f"{author_id}::{keywords_fingerprint}" if target_keywords else author_id

    if store is not None and use_cache:
        cached = store.get_mentor_profile(cache_key, max_age_hours=PROFILE_CACHE_HOURS)
        if cached is not None:
            # 缓存里存的是 dict；直接返回 dict 形态避免重建 dataclass 的样板代码。
            return _profile_from_cache(cached)

    try:
        author: AuthorRecord = await fetch_author(
            client, base_url=settings.openalex_base_url, author_id=author_id
        )
    except UpstreamError as exc:
        logger.warning("抓取作者 %s 失败: %s", author_id, exc)
        return None
    if not author.author_id:
        return None

    works: list[WorkRecord] = await fetch_author_works(
        client,
        base_url=settings.openalex_base_url,
        author_id=author_id,
        page_size=MAX_WORKS_FOR_PROFILE,
    )

    tz = resolve_tz(settings.timezone)
    profile = build_mentor_profile(
        author,
        works,
        now=now.astimezone(tz) if now.tzinfo else now.replace(tzinfo=tz),
        generated_at=isoformat_offset(now, tz),
        target_keywords=target_keywords,
        target_topics=target_topics,
    )

    if store is not None:
        store.save_mentor_profile(
            {**profile.to_dict(), "cache_key": cache_key}, now=now
        )
    return profile


class _CachedProfilePlaceholder:  # pragma: no cover - 记录被否掉的设计方案
    """从缓存重建时曾考虑单独建类型，最终否掉了。

    原因：缓存里存的已经是 `MentorProfile.to_dict()` 的输出，再定义一套
    平行 dataclass 会形成两份事实源。改用 `_profile_from_cache` 直接还原
    MentorProfile，保证「缓存命中」与「现场计算」返回同一个类型。
    """

    def __init__(self) -> None:  # pragma: no cover - 仅防误实例化
        raise NotImplementedError("占位类，不应被实例化；请用 _profile_from_cache")


def _profile_from_cache(payload: dict[str, object]) -> MentorProfile:
    """把缓存 dict 还原成 MentorProfile，保证「缓存命中」与「现场计算」
    返回同一个类型、`to_dict()` 幂等。

    刻意不做「另建一套缓存专用 dataclass」——那会形成两份事实源，
    迟早出现「缓存版字段与计算版不一致」的漂移。
    """
    from pat_worker.domain.mentor import Dimension

    dimensions: dict[str, Dimension] = {}
    for entry in payload.get("dimensions") or []:  # type: ignore[union-attr]
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key") or "")
        if not key:
            continue
        dimensions[key] = Dimension(
            key=key,
            label=str(entry.get("label") or key),
            score=int(entry.get("score") or 0),
            raw=dict(entry.get("raw") or {}),  # type: ignore[arg-type]
            formula_id=str(entry.get("formula_id") or ""),
            sources=tuple(entry.get("sources") or ("openalex",)),  # type: ignore[arg-type]
            confidence=str(entry.get("confidence") or "medium"),
            notes=list(entry.get("notes") or []),  # type: ignore[arg-type]
        )

    return MentorProfile(
        author_id=str(payload.get("author_id") or ""),
        display_name=str(payload.get("display_name") or ""),
        orcid=str(payload.get("orcid") or ""),
        generated_at=str(payload.get("generated_at") or ""),
        dimensions=dimensions,
        overall_score=int(payload.get("overall_score") or 0),
        data_completeness=float(payload.get("data_completeness") or 0.0),
        institutions=tuple(payload.get("institutions") or ()),  # type: ignore[arg-type]
        top_topics=tuple(payload.get("top_topics") or ()),  # type: ignore[arg-type]
        work_count=int(payload.get("work_count") or 0),
        citation_count=int(payload.get("citation_count") or 0),
        notes=list(payload.get("notes") or []),  # type: ignore[arg-type]
    )
