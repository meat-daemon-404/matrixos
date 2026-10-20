"""FastAPI 传输层 —— OpenAI 兼容接口 + MatrixOS 扩展端点。

端点清单::

    POST /v1/chat/completions       OpenAI 兼容主入口（核心）
    GET  /v1/usage/{matrix_uid}     按用户查询用量与成本（任务书第 2 条）
    GET  /v1/models                 列出四档模型（OpenAI 兼容习惯）
    POST /v1/scan                   敏感数据预检（微站可在提交前自查）
    GET  /health                    健康检查
    GET  /ready                     就绪检查（Provider 是否配好）
    GET  /v1/admin/stats            全局统计（内部运维用）

响应扩展：所有成功响应带 ``x_matrix`` 对象，说明本次路由的完整决策。
这是「不允许静默降级」的兑现 —— 用户能看到用了哪档、花了多少、是否降级、
是否命中缓存、命中了哪些敏感规则（只给规则 ID，不给原文）。

为什么把 ``x_matrix`` 放在响应体而不是只用 HTTP 头：
    HTTP 头只能放少量 ASCII，而路由决策需要结构化嵌套（sensitivity / degrade /
    cost 三块）。放进 body 才能被前端直接渲染成「本回答由 XX 模型生成」这类
    用户可见的标注（ADR-06 要求用户可见降级）。
"""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from .api_models import ChatCompletionRequest
from .billing import day_key, month_key, utcnow
from .config import RouterConfig, load_config
from .errors import CopilotError, InvalidRequestError
from .gateway import CopilotGateway
from .types import ChatResult

logger = logging.getLogger("copilot_router")

SERVICE_NAME = "matrixos-copilot-router"
SERVICE_VERSION = "0.1.0"


# ---------------------------------------------------------------------------
# 响应组装
# ---------------------------------------------------------------------------
def _usage_payload(result: ChatResult) -> dict[str, Any]:
    return {
        "prompt_tokens": result.usage.prompt_tokens,
        "completion_tokens": result.usage.completion_tokens,
        "total_tokens": result.usage.total_tokens,
        "cost": round(result.cost.total_cost, 8),
        "currency": "CNY",
        "price_input_per_million": result.cost.price_input_per_million,
        "price_output_per_million": result.cost.price_output_per_million,
    }


def _x_matrix_payload(result: ChatResult, config: RouterConfig) -> dict[str, Any]:
    decision = result.decision
    payload: dict[str, Any] = {
        "tier": decision.tier_id,
        # 契约档位（3 档）：与 dispatch-contract.schema.json 的 model_tier 枚举对齐
        "tier_contract": decision.contract_tier,
        "model": decision.model,
        "task_type": decision.task_type,
        # 决策来源，便于调路由准确率（S2-10 要求 ≥95%）
        "decided_by": decision.decided_by,
        "reason": decision.reason,
        "prompt_tokens_estimated": decision.prompt_tokens,
        "length_bucket": decision.length_bucket,
        "tokens_estimated": result.tokens_estimated,
        "cache": {
            "hit": result.cache_hit,
            "kind": result.cache_kind,
            "coalesced": result.coalesced,
        },
        "cost": {
            "amount": round(result.cost.total_cost, 8),
            "currency": config.currency,
            "billed": result.cost.total_cost > 0,
        },
        "degraded": result.degrade.degraded,
        "degrade_level": result.degrade.level,
        "notices": list(result.degrade.notices),
        "latency_ms": result.latency_ms,
        "trace_id": result.trace_id,
        "provider": result.provider,
    }

    if result.sensitivity is not None:
        sens = result.sensitivity
        payload["sensitivity"] = {
            "verdict": sens.verdict,
            # 只回传规则 ID 与类别，绝不回传命中原文（命中片段本身是敏感数据）
            "matched_rules": sens.matched_rule_ids
            if config.sensitivity.expose_matched_rules
            else [],
            "categories": sorted({f.category for f in sens.findings}),
            "forced_local": decision.forced_local_by_sensitivity,
            "reasons": [f.reason for f in sens.findings],
        }
    return payload


def _completion_response(result: ChatResult, config: RouterConfig) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{result.trace_id or uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(utcnow().timestamp()),
        "model": result.decision.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": result.content},
                "finish_reason": "stop",
            }
        ],
        "usage": _usage_payload(result),
        # MatrixOS 扩展：完整路由决策（OpenAI 客户端会忽略未知字段）
        "x_matrix": _x_matrix_payload(result, config),
    }


def _error_response(exc: CopilotError) -> JSONResponse:
    headers: dict[str, str] = {}
    body = exc.to_dict()
    if exc.status_code == 429:
        headers["Retry-After"] = "60"
    return JSONResponse(status_code=exc.status_code, content=body, headers=headers)


# ---------------------------------------------------------------------------
# 应用工厂
# ---------------------------------------------------------------------------
def create_app(
    config: RouterConfig | None = None,
    gateway: CopilotGateway | None = None,
) -> FastAPI:
    """构建 FastAPI 应用。

    允许注入 config / gateway，便于测试用固定配置与 Mock Provider，
    不必依赖真实 API Key（任务书要求不硬编码 Key，也不要求测试联网）。
    """
    cfg = config or load_config()
    gw = gateway or CopilotGateway(cfg)

    app = FastAPI(
        title=f"{SERVICE_NAME} · 四级模型混部路由与成本控制网关",
        version=SERVICE_VERSION,
        description=(
            "MatrixOS 全局 AI 副驾驶的唯一出口。按任务类型/输入长度/数据敏感度"
            "自动选择 TIER 01–04，按 matrix_uid 计量成本，超限返回明确错误。"
        ),
    )
    app.state.config = cfg
    app.state.gateway = gw

    # ------------------------------------------------------------------
    # 异常处理：把所有 CopilotError 转成结构化错误
    # ------------------------------------------------------------------
    @app.exception_handler(CopilotError)
    async def _copilot_error_handler(_request: Request, exc: CopilotError) -> JSONResponse:
        logger.warning(
            "copilot_error code=%s status=%s details=%s",
            exc.code,
            exc.status_code,
            exc.details,
        )
        return _error_response(exc)

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------
    @app.post("/v1/chat/completions")
    async def chat_completions(
        payload: ChatCompletionRequest,
        x_matrix_trace_id: str | None = Header(default=None, alias="X-Matrix-Trace-Id"),
        x_matrix_task: str | None = Header(default=None, alias="X-Matrix-Task"),
    ) -> JSONResponse:
        trace_id = x_matrix_trace_id or uuid.uuid4().hex
        request = payload.to_domain(trace_id=trace_id)
        # 请求头可补充 task_type（微站内部调用时比改请求体更方便）
        if x_matrix_task and not request.matrix.task_type:
            request.matrix.task_type = x_matrix_task

        if payload.stream:
            # 诚实处理：流式尚未实现，明确拒绝而不是假装成功
            raise InvalidRequestError(
                "本服务暂不支持 stream=true；请改用 stream=false 获取完整响应",
                details={"supported": False, "hint": "后续版本将支持 SSE 流式响应"},
            )

        result = gw.chat(request)
        return JSONResponse(
            status_code=200,
            content=_completion_response(result, cfg),
            headers={
                "X-Matrix-Tier": result.decision.contract_tier,
                "X-Matrix-Cache": "hit" if result.cache_hit else "miss",
                "X-Matrix-Degrade-Level": str(result.degrade.level),
                "X-Matrix-Trace-Id": trace_id,
            },
        )

    # ------------------------------------------------------------------
    # 用量查询
    # ------------------------------------------------------------------
    @app.get("/v1/usage/{matrix_uid}")
    async def get_usage(matrix_uid: str, limit: int = 20) -> dict[str, Any]:
        now = utcnow()
        tz = cfg.billing.timezone
        day = day_key(now, tz)
        month = month_key(now, tz)
        snapshot = gw.budget.snapshot(matrix_uid, now=now)
        records = gw.ledger.user_records(matrix_uid, limit=max(1, min(limit, 200)))
        stats = gw.ledger.stats()

        user_calls = sum(1 for _ in gw.ledger.user_records(matrix_uid, limit=1_000_000))
        user_cost = gw.ledger.user_monthly_cost(matrix_uid, month)

        return {
            "matrix_uid": matrix_uid,
            "currency": cfg.currency,
            "window": {
                "timezone": tz,
                "day": day,
                "month": month,
            },
            "daily": {
                "cost": round(snapshot.user_daily_used, 8),
                "limit": snapshot.user_daily_limit,
                "remaining": round(
                    snapshot.user_daily_limit - snapshot.user_daily_used, 8
                ),
                "usage_ratio": round(snapshot.user_daily_ratio, 4),
            },
            "monthly": {
                "cost": round(snapshot.user_monthly_used, 8),
                "limit": snapshot.user_monthly_limit,
                "remaining": round(
                    snapshot.user_monthly_limit - snapshot.user_monthly_used, 8
                ),
                "usage_ratio": round(snapshot.user_monthly_ratio, 4),
            },
            "annual_target": {
                "target_per_user": cfg.billing.annual_cost_target_per_user,
                # 达标投影：按本月日均 × 365 折算（仅在有本月消费时才有意义）
                "projected_from_month": round(user_cost / max(now.day, 1) * 365, 4),
                "on_track": (user_cost / max(now.day, 1) * 365)
                <= cfg.billing.annual_cost_target_per_user,
            },
            "calls": user_calls,
            "recent": [r.to_dict() for r in records],
            "service_totals": stats,
            # 诚实标注：台账是进程内内存实现
            "storage": {
                "persistent": False,
                "note": "内存台账：重启清零、多副本不共享；生产需换 Redis/PostgreSQL 实现",
            },
        }

    # ------------------------------------------------------------------
    # 模型列表（OpenAI 兼容习惯）
    # ------------------------------------------------------------------
    @app.get("/v1/models")
    async def list_models() -> dict[str, Any]:
        # 需求文档 §6 的 4→3 档映射在此显式暴露
        tier_to_contract = {"tier-01": "flash", "tier-02": "flash", "tier-03": "pro", "tier-04": "local"}
        return {
            "object": "list",
            "data": [
                {
                    "id": spec.model,
                    "object": "model",
                    "owned_by": "matrixos",
                    "x_matrix": {
                        "tier": spec.tier_id,
                        "tier_contract": spec.contract_tier,
                        "name": spec.name,
                        "duties": list(spec.duties),
                        "price_input_per_million": spec.price_input_per_million,
                        "price_output_per_million": spec.price_output_per_million,
                        "context_limit": spec.context_limit,
                        "local_only": spec.local_only,
                        "providers": list(spec.providers),
                        "provider_available": bool(gw.pool.available(spec.providers)),
                    },
                }
                for spec in cfg.tiers.values()
            ],
            "x_matrix_mapping": {
                "note": "需求文档的 4 级 TIER → 契约 3 档 model_tier 的显式映射（TD-09）",
                "tiers": {
                    tid: {"contract_tier": spec.contract_tier, "model": spec.model}
                    for tid, spec in cfg.tiers.items()
                },
                "aliases": {"flash": "tier-01", "pro": "tier-03", "local": "tier-04"},
            },
        }

    # ------------------------------------------------------------------
    # 敏感数据预检
    # ------------------------------------------------------------------
    @app.post("/v1/scan")
    async def scan_text(payload: dict[str, Any]) -> dict[str, Any]:
        """微站可在真正提交前先自查，避免「提交后才发现被拒」。"""
        text = payload.get("text")
        if not isinstance(text, str):
            raise InvalidRequestError("请求体必须包含字符串字段 text")
        result = gw.scanner.scan(text)
        return {
            "verdict": result.verdict,
            "force_local": result.force_local,
            "cache_shareable": result.cache_shareable,
            "matched_rules": result.matched_rule_ids
            if cfg.sensitivity.expose_matched_rules
            else [],
            "categories": sorted({f.category for f in result.findings}),
            "reasons": [f.reason for f in result.findings],
        }

    # ------------------------------------------------------------------
    # 健康与就绪
    # ------------------------------------------------------------------
    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "config_version": cfg.version,
            "config_path": str(cfg.source_path),
        }

    @app.get("/ready")
    async def ready() -> JSONResponse:
        """就绪检查：四档是否各自有可用 Provider。

        刻意不因为「某档不可用」而整体返回 503：
        TIER 04 不可用只影响敏感任务（会返回 451），其余档位仍应服务。
        因此 ready 返回 200 + 明细，把判断交给编排层（k8s 只关心进程是否可用）。
        """
        detail: dict[str, Any] = {}
        for tier_id, spec in cfg.tiers.items():
            available = gw.pool.available(spec.providers)
            detail[tier_id] = {
                "model": spec.model,
                "providers": list(spec.providers),
                "available": available,
                "usable": bool(available),
            }
        all_ok = all(item["usable"] for item in detail.values())
        return JSONResponse(
            status_code=200,
            content={
                "status": "ready" if all_ok else "degraded",
                "all_tiers_available": all_ok,
                "tiers": detail,
                "note": (
                    "TIER 04 不可用时，敏感数据请求会返回 451 而非降级到云端（合规红线）"
                ),
            },
        )

    # ------------------------------------------------------------------
    # 内部统计
    # ------------------------------------------------------------------
    @app.get("/v1/admin/stats")
    async def admin_stats() -> dict[str, Any]:
        now = utcnow()
        tz = cfg.billing.timezone
        stats = gw.ledger.stats()
        cache_stats = gw.cache.stats if gw.cache is not None else {}
        return {
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "window": {"timezone": tz, "day": day_key(now, tz), "month": month_key(now, tz)},
            "budget": {
                "global_daily_cost": round(
                    gw.ledger.global_daily_cost(day_key(now, tz)), 8
                ),
                "global_daily_limit": cfg.budget.global_daily_cost_limit,
                "global_monthly_cost": round(
                    gw.ledger.global_monthly_cost(month_key(now, tz)), 8
                ),
                "global_monthly_limit": cfg.budget.global_monthly_cost_limit,
            },
            "ledger": stats,
            "cache": {
                "enabled": gw.cache is not None,
                "size": gw.cache.size if gw.cache is not None else 0,
                **cache_stats,
            },
            "breaker_open": {
                name: gw.pool.breaker.is_open(name) for name in cfg.providers
            },
        }

    return app


def app_factory_from_env() -> FastAPI:
    """供 ``uvicorn copilot_router.api:app`` 使用的工厂。"""
    config_path = os.environ.get("COPILOT_ROUTER_CONFIG")
    return create_app(load_config(config_path))


# uvicorn 入口（模块级 app 实例，便于 `uvicorn copilot_router.api:app`）
try:  # pragma: no cover - 仅在作为服务启动时执行
    app = app_factory_from_env()
except Exception as _exc:  # noqa: BLE001
    # 配置缺失时也要能 import（测试会用 create_app 注入配置），
    # 但把真实原因记录下来，避免启动失败后毫无线索
    logger.error("copilot-router 启动时加载配置失败：%s", _exc)
    app = None  # type: ignore[assignment]
