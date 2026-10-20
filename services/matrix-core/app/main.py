"""FastAPI 应用装配（S1-06）。

分层约定（依赖方向只允许自上而下）：
```
api/routes/*   →  schemas/*  →  services/*  →  models/*  →  db/*
                     ↑                          ↑
                 core/errors.py            core/config.py
```

本模块只做**装配**，不含业务逻辑：
- 生命周期：构建 ``Database`` 与 ``KeyStore``（挂到 ``app.state`` 供依赖注入取用）；
- 中间件：trace_id 贯穿 + 脱敏日志 + 限流 + CORS；
- 异常处理：统一错误体 ``{code, message, trace_id}``；
- OpenAPI：``/openapi.json`` 可导出，供 CI 与 TS 类型生成做契约漂移检测。
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.routes import api_router
from app.core.config import Settings, get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging, get_logger
from app.core.preflight import assert_startable
from app.core.ratelimit import SlidingWindowLimiter
from app.core.security.keys import KeyStore
from app.core.tracing import TRACE_HEADER, extract_trace_id, reset_trace_id, set_trace_id
from app.db.session import Database

logger = get_logger("matrix-core.app")

DESCRIPTION = """
MatrixOS v3.0 的**身份与资产平面**（architecture §3.3）。

### 职责边界
- ✅ MatrixID OAuth2 授权码流、JWT RS256 签发与轮转、`jti` 黑名单
- ✅ `DigitalTwinAssetGraph` 资产 CRUD 与 pgvector 向量检索
- ✅ Wormhole 收据落库（**只存哈希与元数据，不存 payload 正文**）
- ❌ 不做模型调用、不做学术数据抓取、不渲染任何页面

### 错误响应
所有非 2xx 响应体恒为 `{code, message, trace_id}`（S1-06 验收）。
`code` 是稳定契约（只增不改），`message` 仅供人读。
"""


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """启动/关闭：初始化数据库与密钥仓库，并暴露到 ``app.state``。"""
    settings: Settings = app.state.settings

    configure_logging()

    # 启动前校验：配置有问题就别带病启动。
    # 放在 KeyStore/Database 构造之前——否则会先连库、再报配置错，日志顺序会误导排查。
    report = assert_startable(settings)
    for warning in report.warnings:
        logger.warning("preflight_warning", setting=warning.setting, detail=warning.detail)

    database = Database(settings)
    key_store = KeyStore(settings)
    # 生产环境缺密钥必须显式失败（不能悄悄生成，否则多副本间 kid 不一致）
    key_store.load(create_if_missing=settings.auto_generate_keys)

    app.state.database = database
    app.state.key_store = key_store
    app.state.preflight = report
    app.state.write_limiter = SlidingWindowLimiter(
        limit=settings.write_rate_limit_per_minute
    )

    logger.info(
        "matrix_core_started",
        version=__version__,
        env=settings.app_env,
        kid=key_store.current.kid,
        embedding_provider=settings.embedding_provider,
        cors_origins=len(settings.cors_allowed_origins),
        cors_regex=bool(settings.cors_origin_regex),
    )
    try:
        yield
    finally:
        await database.dispose()
        logger.info("matrix_core_stopped")


def create_app(settings: Settings | None = None) -> FastAPI:
    """应用工厂（测试里用 ``create_app(Settings(...))`` 精确控制配置）。"""
    cfg = settings or get_settings()

    app = FastAPI(
        title="matrix-core",
        version=__version__,
        description=DESCRIPTION,
        openapi_url="/openapi.json",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )
    app.state.settings = cfg

    register_exception_handlers(app)
    _install_middleware(app, cfg)

    app.include_router(api_router, prefix=cfg.api_prefix)
    return app


def _install_middleware(app: FastAPI, settings: Settings) -> None:
    @app.middleware("http")
    async def trace_and_log(request: Request, call_next: Any) -> Response:
        """trace_id 贯穿 + 访问日志（脱敏由 logging processor 保证）。"""
        set_trace_id(extract_trace_id(request.headers))
        started = time.perf_counter()
        status_code = 500
        try:
            response: Response = await call_next(request)
            status_code = response.status_code
            # 回写 trace_id，让前端/虫洞 envelope 与本条日志可关联
            from app.core.tracing import get_trace_id

            response.headers[TRACE_HEADER] = get_trace_id()
            return response
        finally:
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            logger.info(
                "http_request",
                method=request.method,
                path=request.url.path,
                status=status_code,
                elapsed_ms=elapsed_ms,
            )
            reset_trace_id()

    # CORS：``allow_origins`` 是精确串匹配，通配必须走 ``allow_origin_regex``。
    # 之前只配了 ``allow_origins``，写 ``https://mx-*.pages.dev`` 永远匹配不上——
    # 表现为「前端跨域一直失败但不报错」。现在两条通道都接上。
    origin_regex = settings.cors_origin_regex
    if settings.cors_enabled:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_allowed_origins,
            allow_origin_regex=origin_regex,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", TRACE_HEADER, "X-Matrix-CSRF"],
            expose_headers=[TRACE_HEADER],
            max_age=600,  # 预检结果缓存 10 分钟，减少 18 个微站的 OPTIONS 往返
        )


app = create_app()


def run() -> None:  # pragma: no cover - CLI 入口
    """``matrix-core`` 控制台入口（容器里也可直接用 uvicorn 启动）。

    生产镜像不依赖这个函数（Dockerfile 的 CMD 直接调 uvicorn，便于配 worker 数），
    但它保留并补上 ``PORT`` 支持，方便在 PaaS（Fly/Railway/Render）上直接
    ``matrix-core`` 一条命令跑起来——这些平台通过 ``PORT`` 环境变量注入端口。
    """
    import os

    import uvicorn

    settings = get_settings()
    port = int(os.environ.get("PORT", "8000"))
    reload = settings.app_env == "development"
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=port,
        reload=reload,
        # 容器里 stdout 直接给采集器，不需要 uvicorn 自己的彩色格式
        log_config=None if settings.log_json else uvicorn.config.LOGGING_CONFIG,
        access_log=False,  # 访问日志由 trace_and_log 中间件统一输出（带 trace_id）
    )


__all__ = ["app", "create_app", "run"]
