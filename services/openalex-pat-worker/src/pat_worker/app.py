"""FastAPI 应用装配与依赖注入。

路由分两组，边界是**鉴权**：

- `/v1/*`   —— 供 04 站 / 06 站前端经 @matrixos/sdk 调用，走 MatrixID 鉴权，
  本服务**不自己校验 JWT**（架构 §3.3：本服务不做面向用户的鉴权），
  由 matrix-core 在网关侧完成。这里只做输入校验与限流预留。
- `/internal/*` —— 供 matrix-core / copilot-router 内部调用，用共享令牌鉴权
  （`PAT_INTERNAL_TOKEN`）。架构 §3.3 明确列出 `/internal/pat/refresh` 与
  `/internal/mentor/graph` 两个端点，本实现按此落地。

为什么把内部端点独立成一组而不是混在 /v1 下：内部端点的调用方是服务而非用户，
它们需要「同步触发一次真实采集」这种高权限能力；混在用户 API 里迟早会被误开放。

应用状态（Store / Scheduler / HttpClient 工厂）挂在 `app.state` 上，
用依赖函数取，而不是模块级全局——这样测试可以直接替换，也不需要 monkeypatch。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse

from pat_worker import __version__
from pat_worker.http.client import PoliteHttpClient, UpstreamError
from pat_worker.pipeline.runner import build_daily_brief, summarize_outcome
from pat_worker.scheduler import JOB_STATE, build_scheduler, next_run_time, run_daily_brief_job
from pat_worker.services.mentor_service import build_profile, search_mentors
from pat_worker.settings import Settings, get_settings, load_settings
from pat_worker.store.sqlite_store import Store
from pat_worker.timeutil import (
    brief_date_for,
    isoformat_offset,
    resolve_tz,
    tz_fallback_warnings,
)

logger = logging.getLogger(__name__)

API_PREFIX = "/v1"
INTERNAL_PREFIX = "/internal"


# ------------------------------------------------------------------ 生命周期


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """启动/关闭。Store 与 Scheduler 挂到 app.state。"""
    settings: Settings = getattr(app.state, "settings", None) or load_settings()
    app.state.settings = settings

    store: Store = getattr(app.state, "store", None) or Store(settings.store_path)
    app.state.store = store

    scheduler = None
    if settings.scheduler_enabled:
        scheduler = build_scheduler(settings, store)
        scheduler.start()
    app.state.scheduler = scheduler

    for issue in settings.warnings():
        logger.warning("配置告警：%s", issue)
    for issue in tz_fallback_warnings():
        logger.warning("时区降级：%s", issue)

    logger.info(
        "openalex-pat-worker %s 启动完毕 (port=%s, scheduler=%s)",
        __version__,
        settings.port,
        "on" if scheduler else "off",
    )
    try:
        yield
    finally:
        if scheduler is not None:
            scheduler.shutdown(wait=False)
        store.close()
        logger.info("openalex-pat-worker 已停止")


# ------------------------------------------------------------------ 依赖


def get_store(request: Request) -> Store:
    store: Store | None = getattr(request.app.state, "store", None)
    if store is None:  # pragma: no cover - 仅在绕过 lifespan 时发生
        raise HTTPException(status_code=500, detail="Store 未初始化")
    return store


def get_app_settings(request: Request) -> Settings:
    settings: Settings | None = getattr(request.app.state, "settings", None)
    return settings or load_settings()


async def http_client_dep(request: Request) -> AsyncIterator[PoliteHttpClient]:
    """按请求构造出站客户端。复用 app.state 上注入的 transport（测试用）。"""
    settings = get_app_settings(request)
    transport = getattr(request.app.state, "http_transport", None)
    client = PoliteHttpClient(
        contact_email=settings.contact_email,
        timeout_seconds=settings.http_timeout_seconds,
        max_retries=settings.http_max_retries,
        backoff_base_seconds=settings.http_backoff_base_seconds,
        cache_ttl_seconds=settings.http_cache_ttl_seconds,
        cache_path=settings.http_cache_path,
        transport=transport,
    )
    await client.start()
    try:
        yield client
    finally:
        await client.aclose()


def require_internal_token(
    request: Request,
    authorization: str | None = Header(default=None),
) -> None:
    """内部端点鉴权。未配置 token 时放行但记 warning（开发模式）。"""
    settings = get_app_settings(request)
    if not settings.internal_token:
        logger.warning("PAT_INTERNAL_TOKEN 未设置，内部端点处于无鉴权开发模式")
        return
    expected = f"Bearer {settings.internal_token}"
    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="内部端点需要 Authorization: Bearer <PAT_INTERNAL_TOKEN>",
        )


# ------------------------------------------------------------------ 应用工厂


def create_app(
    *,
    settings: Settings | None = None,
    store: Store | None = None,
    http_transport=None,
) -> FastAPI:
    """构造应用。三个可选参数全部为测试而设，生产走默认值。"""
    app = FastAPI(
        title="MatrixOS openalex-pat-worker",
        version=__version__,
        description=(
            "04 站 PAT-HOT 信源监听 / 热度评估 / 早报合成，"
            "06 站星门导师五维画像。内部服务，不面向最终用户直接暴露。"
        ),
        lifespan=lifespan,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )
    if settings is not None:
        app.state.settings = settings
    if store is not None:
        app.state.store = store
    if http_transport is not None:
        app.state.http_transport = http_transport

    _register_meta_routes(app)
    _register_brief_routes(app)
    _register_mentor_routes(app)
    _register_internal_routes(app)

    @app.exception_handler(UpstreamError)
    async def _upstream_handler(_: Request, exc: UpstreamError) -> JSONResponse:
        """上游错误统一转 502，并保留可诊断信息但不泄漏内部 URL 结构。"""
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={
                "code": "upstream_error",
                "message": "上游学术 API 不可用",
                "detail": {"status": exc.status},
            },
        )

    return app


# ------------------------------------------------------------------ 路由：元信息


def _register_meta_routes(app: FastAPI) -> None:
    @app.get("/healthz", tags=["meta"])
    async def healthz(request: Request) -> dict[str, object]:
        """健康检查。配置告警与时区降级都会体现在 `degraded` 上。"""
        settings = get_app_settings(request)
        store = get_store(request)
        issues = settings.warnings() + tz_fallback_warnings()
        scheduler = getattr(request.app.state, "scheduler", None)
        return {
            "status": "degraded" if issues else "ok",
            "degraded": bool(issues),
            "issues": issues,
            "version": __version__,
            "timezone": settings.timezone,
            "brief_time": f"{settings.brief_cron_hour_minute()[0]:02d}:"
            f"{settings.brief_cron_hour_minute()[1]:02d}",
            "scheduler_enabled": scheduler is not None,
            "next_brief_at": next_run_time(scheduler) if scheduler else None,
            "briefs_archived": store.count_briefs(),
            "last_job": JOB_STATE.to_dict(),
        }

    @app.get("/", tags=["meta"])
    async def root() -> dict[str, str]:
        return {
            "service": "openalex-pat-worker",
            "version": __version__,
            "docs": "/docs",
            "health": "/healthz",
        }


# ------------------------------------------------------------------ 路由：早报


def _register_brief_routes(app: FastAPI) -> None:
    @app.get(f"{API_PREFIX}/pat/brief/latest", tags=["pat-hot"])
    async def latest_brief(request: Request) -> dict[str, object]:
        """取今日早报。未生成时回 404，**不触发采集**——读接口不该有副作用。"""
        settings = get_app_settings(request)
        store = get_store(request)
        tz = resolve_tz(settings.timezone)
        today = brief_date_for(datetime.now(tz), tz)
        payload = store.get_brief_by_date(today)
        if payload is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"{today} 的早报尚未生成，请调用 POST /internal/pat/refresh 触发生成",
            )
        return payload

    @app.get(f"{API_PREFIX}/pat/brief/history", tags=["pat-hot"])
    async def brief_history(
        request: Request, limit: int = Query(default=30, ge=1, le=200)
    ) -> dict[str, object]:
        store = get_store(request)
        return {"items": store.list_briefs(limit=limit)}

    @app.get(f"{API_PREFIX}/pat/brief/{{digest_id}}", tags=["pat-hot"])
    async def brief_by_id(request: Request, digest_id: str) -> dict[str, object]:
        store = get_store(request)
        payload = store.get_brief(digest_id)
        if payload is None:
            raise HTTPException(status_code=404, detail=f"未找到早报 {digest_id}")
        return payload

    @app.post(f"{API_PREFIX}/pat/cards/{{card_id}}/read", tags=["pat-hot"])
    async def mark_card_read(
        request: Request,
        card_id: str,
        digest_id: str = Query(..., description="卡片所属早报的 digest_id"),
    ) -> dict[str, object]:
        """标记已读。

        已读状态按 **paper_key（DOI > arXiv > 标题哈希）** 存，不是按 card_id。
        理由：同一篇论文明天可能又以新 card_id 出现，按 card_id 存会让「已读」
        在第二天失效；按论文标识存才是用户真正想要的语义。
        """
        settings = get_app_settings(request)
        store = get_store(request)
        payload = store.get_brief(digest_id)
        if payload is None:
            raise HTTPException(status_code=404, detail=f"未找到早报 {digest_id}")

        card = next(
            (c for c in payload.get("cards", []) if c.get("card_id") == card_id), None
        )
        if card is None:
            raise HTTPException(status_code=404, detail=f"早报 {digest_id} 中无卡片 {card_id}")

        key = _paper_key_from_card(card)
        now = datetime.now(resolve_tz(settings.timezone))
        store.mark_read(key, now=now, digest_id=digest_id)
        return {"ok": True, "card_id": card_id, "paper_key": key}

    @app.delete(f"{API_PREFIX}/pat/cards/{{card_id}}/read", tags=["pat-hot"])
    async def mark_card_unread(
        request: Request,
        card_id: str,
        digest_id: str = Query(..., description="卡片所属早报的 digest_id"),
    ) -> dict[str, object]:
        store = get_store(request)
        payload = store.get_brief(digest_id)
        if payload is None:
            raise HTTPException(status_code=404, detail=f"未找到早报 {digest_id}")
        card = next(
            (c for c in payload.get("cards", []) if c.get("card_id") == card_id), None
        )
        if card is None:
            raise HTTPException(status_code=404, detail=f"早报 {digest_id} 中无卡片 {card_id}")
        key = _paper_key_from_card(card)
        store.mark_unread(key)
        return {"ok": True, "card_id": card_id, "paper_key": key}


def _paper_key_from_card(card: dict[str, object]) -> str:
    """卡片 → 稳定论文键。与 pipeline.brief._receipt_key 保持同一规则。

    刻意重复实现而不是互相 import：契约（DOI > arXiv > 标题哈希）是**外部可见的
    语义**，两边各自实现并在测试里断言一致，比隐式耦合更能防止单边漂移。
    """
    doi = str(card.get("doi") or "").strip().lower()
    if doi:
        return f"doi:{doi}"
    arxiv_id = str(card.get("arxiv_id") or "").strip()
    if arxiv_id:
        return f"arxiv:{arxiv_id}"
    title = str(card.get("title") or "")
    import hashlib

    return f"title:{hashlib.sha256(title.encode('utf-8')).hexdigest()[:16]}"


# ------------------------------------------------------------------ 路由：导师


def _register_mentor_routes(app: FastAPI) -> None:
    @app.get(f"{API_PREFIX}/mentor/search", tags=["xingmen"])
    async def mentor_search(
        request: Request,
        q: str = Query(..., min_length=1, max_length=120, description="姓名或机构关键词"),
        per_page: int = Query(default=10, ge=1, le=50),
        client: PoliteHttpClient = Depends(http_client_dep),
    ) -> dict[str, object]:
        settings = get_app_settings(request)
        hits = await search_mentors(client, settings=settings, query=q, per_page=per_page)
        return {"query": q, "count": len(hits), "items": [h.to_dict() for h in hits]}

    @app.get(f"{API_PREFIX}/mentor/{{author_id}}/profile", tags=["xingmen"])
    async def mentor_profile(
        request: Request,
        author_id: str,
        keywords: str = Query(
            default="", description="逗号分隔的目标关键词，用于计算方向契合度"
        ),
        topics: str = Query(default="", description="逗号分隔的目标 topic 名"),
        refresh: bool = Query(default=False, description="忽略缓存强制重算"),
        client: PoliteHttpClient = Depends(http_client_dep),
    ) -> dict[str, object]:
        """导师五维画像。`author_id` 形如 `A5023888391`（OpenAlex 作者 id）。"""
        settings = get_app_settings(request)
        store = get_store(request)
        now = datetime.now(resolve_tz(settings.timezone))
        keyword_tuple = tuple(k.strip() for k in keywords.split(",") if k.strip())
        topic_tuple = tuple(t.strip() for t in topics.split(",") if t.strip())

        profile = await build_profile(
            client,
            settings=settings,
            author_id=author_id,
            now=now,
            target_keywords=keyword_tuple,
            target_topics=topic_tuple,
            store=store,
            use_cache=not refresh,
        )
        if profile is None:
            raise HTTPException(status_code=404, detail=f"未找到 OpenAlex 作者 {author_id}")
        return profile.to_dict()


# ------------------------------------------------------------------ 路由：内部


def _register_internal_routes(app: FastAPI) -> None:
    @app.post(
        f"{INTERNAL_PREFIX}/pat/refresh",
        tags=["internal"],
        dependencies=[Depends(require_internal_token)],
    )
    async def refresh_brief(
        request: Request,
        use_dedupe: bool = Query(
            default=True, description="是否启用推送去重（回补历史时应设为 false）"
        ),
    ) -> dict[str, object]:
        """手动触发一次早报生成。架构 §3.3 指定的端点。

        与定时任务共用 `build_daily_brief`，差别只在 `now` 取当前时刻。
        同步执行（不排队）：早报生成耗时在秒级（有 HTTP 缓存时），
        异步化会让调用方难以判断成败。真正耗时的多用户并发场景由
        matrix-core 侧限流，不在本服务职责内。
        """
        settings = get_app_settings(request)
        store = get_store(request)
        now = datetime.now(resolve_tz(settings.timezone))
        outcome = await build_daily_brief(
            settings=settings, store=store, now=now, use_dedupe=use_dedupe
        )
        return {"ok": True, **summarize_outcome(outcome)}

    @app.get(
        f"{INTERNAL_PREFIX}/pat/status",
        tags=["internal"],
        dependencies=[Depends(require_internal_token)],
    )
    async def pat_status(request: Request) -> dict[str, object]:
        """调度与推送台账状态。给 matrix-core 的运维面板用。"""
        settings = get_app_settings(request)
        store = get_store(request)
        scheduler = getattr(request.app.state, "scheduler", None)
        now = datetime.now(resolve_tz(settings.timezone))
        return {
            "scheduler_enabled": scheduler is not None,
            "brief_time": f"{settings.brief_cron_hour_minute()[0]:02d}:"
            f"{settings.brief_cron_hour_minute()[1]:02d}",
            "timezone": settings.timezone,
            "next_brief_at": next_run_time(scheduler) if scheduler else None,
            "now": isoformat_offset(now, resolve_tz(settings.timezone)),
            "briefs_archived": store.count_briefs(),
            "read_receipts": len(store.read_keys()),
            "last_job": JOB_STATE.to_dict(),
        }

    @app.get(
        f"{INTERNAL_PREFIX}/mentor/graph",
        tags=["internal"],
        dependencies=[Depends(require_internal_token)],
    )
    async def mentor_graph(
        request: Request,
        author_ids: str = Query(
            ..., min_length=1, description="逗号分隔的 OpenAlex 作者 id，最多 10 个"
        ),
        keywords: str = Query(default=""),
        client: PoliteHttpClient = Depends(http_client_dep),
    ) -> dict[str, object]:
        """批量导师画像。架构 §3.3 指定的端点。

        不做并发：10 位导师 × 2 次请求 = 20 次 OpenAlex 调用，串行在
        限速器下约 2–3 秒，而并发会触发限速反而更慢。上限 10 是刻意的——
        06 站的雷达图最多同屏对比 5 位，10 已留足余量。
        """
        settings = get_app_settings(request)
        store = get_store(request)
        ids = [x.strip() for x in author_ids.split(",") if x.strip()]
        if len(ids) > 10:
            raise HTTPException(status_code=422, detail="一次最多查询 10 位导师")
        keyword_tuple = tuple(k.strip() for k in keywords.split(",") if k.strip())
        now = datetime.now(resolve_tz(settings.timezone))

        profiles: list[dict[str, object]] = []
        missing: list[str] = []
        for author_id in ids:
            profile = await build_profile(
                client,
                settings=settings,
                author_id=author_id,
                now=now,
                target_keywords=keyword_tuple,
                store=store,
            )
            if profile is None:
                missing.append(author_id)
                continue
            profiles.append(profile.to_dict())

        return {"count": len(profiles), "missing": missing, "profiles": profiles}


#: uvicorn 入口。`uvicorn pat_worker.app:app` 可直接跑。
app = create_app()