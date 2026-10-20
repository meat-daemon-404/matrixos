"""结构化日志。

- 默认 JSON 行式输出（便于采集），开发可切 ``MATRIX_CORE_LOG_JSON=false``；
- 每条日志自动带 ``trace_id`` / ``service`` / ``env``；
- 脱敏处理器在渲染前执行（见 core/redaction.py），保证 token 与 payload 正文永不落盘。
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog

from app.core.config import get_settings
from app.core.redaction import structlog_redact_processor
from app.core.tracing import get_trace_id


def _add_static_fields(_logger: Any, _name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    event_dict.setdefault("service", settings.app_name)
    event_dict.setdefault("env", settings.app_env)
    event_dict.setdefault("trace_id", get_trace_id())
    return event_dict


def _add_logger_name(logger: Any, _name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    """写入 logger 名——**不能用** ``structlog.stdlib.add_logger_name``。

    那个 processor 直接读 ``logger.name``，而我们用的是 ``PrintLoggerFactory``
    （直接写 stdout，不经 stdlib logging 拦截），``PrintLogger`` 没有 ``name``
    属性，一旦调用就会在启动日志处抛 ``AttributeError`` 让整个 lifespan 失败。
    这里做属性缺失兜底，任何 logger 工厂下都安全。
    """
    name = getattr(logger, "name", None)
    if name:
        event_dict.setdefault("logger", name)
    return event_dict


def configure_logging(level: str | None = None, json_output: bool | None = None) -> None:
    """配置 structlog + 标准库 logging（幂等，可重复调用）。"""
    settings = get_settings()
    log_level = (level or settings.log_level).upper()
    use_json = settings.log_json if json_output is None else json_output

    shared_processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        _add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        _add_static_fields,
        structlog_redact_processor,  # 必须在渲染之前
    ]

    renderer: Any = (
        structlog.processors.JSONRenderer(ensure_ascii=False)
        if use_json
        else structlog.dev.ConsoleRenderer(colors=False)
    )

    structlog.configure(
        processors=[*shared_processors, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, log_level, logging.INFO)
        ),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )

    # 让第三方库（uvicorn/sqlalchemy）也走同一条输出通道
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=log_level, force=True)
    for noisy, noisy_level in (
        ("uvicorn.access", logging.WARNING),
        ("sqlalchemy.engine", logging.WARNING),
        ("asyncpg", logging.WARNING),
    ):
        logging.getLogger(noisy).setLevel(noisy_level)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name or "matrix-core")
