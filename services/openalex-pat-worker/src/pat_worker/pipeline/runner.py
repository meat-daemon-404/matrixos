"""编排层：把采集器、归并、热度、选卡、存储串成一条可重放的流程。

这个模块是「有副作用」的地方（网络 + 落库），因此所有纯计算逻辑都在
`domain/` 与 `pipeline/brief.py` 里，本模块只做编排与错误兜底。

关键设计：**部分失败是常态，不是异常**。arXiv 很容易 429，Crossref 偶尔 503，
Nature RSS 偶尔超时。早报必须照常出，只是标注哪些源没回来。因此这里用
`asyncio.gather(return_exceptions=True)` 并发打多个源，单源失败记 warning 继续。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime

from pat_worker.collectors.arxiv import collect_arxiv
from pat_worker.collectors.crossref import collect_crossref
from pat_worker.collectors.nature import collect_nature
from pat_worker.collectors.openalex import collect_openalex_works
from pat_worker.http.client import PoliteHttpClient
from pat_worker.models import CollectedBatch, PaperItem
from pat_worker.pipeline.brief import BriefBuildResult, compose_brief, _receipt_key
from pat_worker.pipeline.merge import MergedPaper, merge_items
from pat_worker.settings import Settings
from pat_worker.store.sqlite_store import Store
from pat_worker.timeutil import resolve_tz, window_for

logger = logging.getLogger(__name__)

#: 推送去重窗口（天）。同一篇论文在 3 天内不重复出现在早报里。
#: 为什么是 3 天而不是 7 天：04 站是 24h 流，一周不推一遍已经足够新鲜；
#: 3 天既能防止「同一批 arXiv 连续霸榜」，又不会让好论文彻底消失。
DEDUPE_WINDOW_DAYS = 3


@dataclass(slots=True)
class CollectOutcome:
    batches: list[CollectedBatch] = field(default_factory=list)

    @property
    def items(self) -> list[PaperItem]:
        return [item for batch in self.batches for item in batch.items]

    @property
    def total_fetched(self) -> int:
        return sum(batch.fetched for batch in self.batches)

    @property
    def sources(self) -> list[str]:
        """返回**至少产出一条**的信源，顺序稳定。"""
        seen: list[str] = []
        for batch in self.batches:
            if batch.items:
                for item in batch.items:
                    if item.source not in seen:
                        seen.append(item.source)
        return seen

    @property
    def failures(self) -> list[str]:
        return [f"{b.source}: {b.error}" for b in self.batches if not b.ok and b.error]


async def collect_all(client: PoliteHttpClient, settings: Settings, *, since: datetime) -> CollectOutcome:
    """并发采集全部信源。单源异常被吞掉并记为失败，不阻断其余源。"""
    tasks = [
        collect_arxiv(
            client,
            base_url=settings.arxiv_base_url,
            categories=settings.arxiv_categories,
        ),
        collect_openalex_works(
            client,
            base_url=settings.openalex_base_url,
            field_ids=settings.openalex_field_ids,
            since=since,
        ),
        collect_crossref(
            client, base_url=settings.crossref_base_url, since=since
        ),
        collect_nature(client, feed_urls=settings.nature_rss_urls),
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    batches: list[CollectedBatch] = []
    for result in results:
        if isinstance(result, CollectedBatch):
            batches.append(result)
        elif isinstance(result, BaseException):
            # gather 的异常不会带 source 名，只能笼统记一条
            logger.warning("采集任务异常: %r", result)
            batches.append(
                CollectedBatch(source="unknown", ok=False, error=repr(result)[:200])
            )
    return CollectOutcome(batches=batches)


def filter_window(papers: list[MergedPaper], *, start: datetime, end: datetime) -> list[MergedPaper]:
    """按发布时间过滤。跨源归并后的 published_at 是「最早公开时间」，
    这正是「24h 内新出现」该用的口径。"""
    return [p for p in papers if start <= p.published_at <= end]


def apply_dedupe(
    papers: list[MergedPaper], *, store: Store, now: datetime, window_days: int = DEDUPE_WINDOW_DAYS
) -> tuple[list[MergedPaper], list[str]]:
    """剔除近期已推送过的条目。返回 (保留列表, 被剔除的 key 列表)。"""
    pushed = store.recently_pushed(now=now, within_days=window_days)
    if not pushed:
        return papers, []
    kept: list[MergedPaper] = []
    dropped: list[str] = []
    for paper in papers:
        key = _receipt_key(paper)
        if key in pushed:
            dropped.append(key)
            continue
        kept.append(paper)
    return kept, dropped


@dataclass(slots=True)
class BuildOutcome:
    brief: BriefBuildResult
    pushed_keys: list[str]
    dropped_keys: list[str]
    failures: list[str]

    @property
    def payload(self) -> dict[str, object]:
        return self.brief.payload


async def build_daily_brief(
    *,
    settings: Settings,
    store: Store,
    now: datetime,
    keywords: list[str] | tuple[str, ...] = (),
    client: PoliteHttpClient | None = None,
    use_dedupe: bool = True,
) -> BuildOutcome:
    """生成一份早报并落库。

    `now` 由调用方传入（定时任务传计划触发时刻，手动端点传当前时刻，
    测试传固定值），保证可复现。

    `client` 可注入：测试用 `httpx.MockTransport` 构造的客户端，
    生产留空则按配置自建并自动关闭。
    """
    tz = resolve_tz(settings.timezone)
    hours = settings.normalized_window_hours()
    window_start, window_end = window_for(now, hours, tz)

    owns_client = client is None
    if client is None:
        client = PoliteHttpClient(
            contact_email=settings.contact_email,
            timeout_seconds=settings.http_timeout_seconds,
            max_retries=settings.http_max_retries,
            backoff_base_seconds=settings.http_backoff_base_seconds,
            cache_ttl_seconds=settings.http_cache_ttl_seconds,
            cache_path=settings.http_cache_path,
        )
        await client.start()

    try:
        outcome = await collect_all(client, settings, since=window_start)
    finally:
        if owns_client:
            await client.aclose()

    merged = merge_items(outcome.items)
    in_window = filter_window(merged, start=window_start, end=window_end)

    dropped: list[str] = []
    if use_dedupe:
        in_window, dropped = apply_dedupe(
            in_window, store=store, now=window_end, window_days=DEDUPE_WINDOW_DAYS
        )

    read_keys = store.read_keys()
    brief = compose_brief(
        papers=in_window,
        now=window_end,
        tz=tz,
        window_start=window_start,
        window_hours=hours,
        candidates=outcome.total_fetched,
        sources=outcome.sources,
        keywords=keywords,
        read_lookup=lambda key: key in read_keys,
    )

    if outcome.failures:
        brief.warnings.extend(f"信源失败：{failure}" for failure in outcome.failures)

    digest_id = str(brief.payload["digest_id"])
    brief_date = str(brief.payload["brief_date"])

    store.save_brief(brief.payload)

    pushed_keys: list[str] = []
    if use_dedupe:
        pushed_keys = [_receipt_key(candidate.paper) for _, candidate in brief.selected]
        store.mark_pushed(
            pushed_keys, digest_id=digest_id, brief_date=brief_date, now=window_end
        )

    return BuildOutcome(
        brief=brief,
        pushed_keys=pushed_keys,
        dropped_keys=dropped,
        failures=outcome.failures,
    )


async def regenerate_brief_for_date(
    *, settings: Settings, store: Store, brief_date: str, now: datetime
) -> dict[str, object] | None:
    """回补：按指定日期重算（不走去重，避免与当时的推送台账冲突）。

    `brief_date` 仅用于幂等命名——真正的日期由 `now` 决定，因此调用方
    需要把 `now` 设成目标日期的 08:00。这一点刻意保持简单：回补是运维动作，
    不做「按日期重放历史信源」这种做不到的承诺（API 不提供历史快照）。
    """
    _ = brief_date
    outcome = await build_daily_brief(
        settings=settings, store=store, now=now, use_dedupe=False
    )
    return outcome.payload


def summarize_outcome(outcome: BuildOutcome) -> dict[str, object]:
    """给日志/健康检查用的紧凑摘要。不含 payload 正文，避免日志膨胀。"""
    payload = outcome.payload
    stats = payload.get("stats") or {}
    window = payload.get("window") or {}
    return {
        "digest_id": payload.get("digest_id"),
        "brief_date": payload.get("brief_date"),
        "generated_at": payload.get("generated_at"),
        "window_hours": window.get("hours"),
        "cards": len(payload.get("cards") or []),
        "candidates": stats.get("candidates"),
        "deduped": stats.get("deduped"),
        "selected": stats.get("selected"),
        "sources": stats.get("sources"),
        "pushed": len(outcome.pushed_keys),
        "dropped_by_dedupe": len(outcome.dropped_keys),
        "failures": outcome.failures,
        "warnings": outcome.brief.warnings,
    }
