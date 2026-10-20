"""CLI 入口：`python -m pat_worker` / `pat-worker`。

三种用法：
    pat-worker serve                 # 启动 HTTP 服务（含 08:00 调度）
    pat-worker brief --dry-run       # 只生成早报并打印，不落库、不注册推送
    pat-worker brief                 # 生成早报并落库
    pat-worker mentor <author_id>    # 在终端打印一位导师的五维画像

为什么不只提供 `uvicorn ...` 一种方式：08:00 的准时率需要能被运维单独验证，
`brief --dry-run` 是在不动生产台账的前提下验证采集链路的最短路径。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime

from pat_worker import __version__
from pat_worker.pipeline.runner import build_daily_brief, summarize_outcome
from pat_worker.settings import load_settings
from pat_worker.store.sqlite_store import Store
from pat_worker.timeutil import resolve_tz


def _setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


async def _cmd_brief(*, dry_run: bool) -> int:
    settings = load_settings()
    tz = resolve_tz(settings.timezone)
    now = datetime.now(tz)
    store = Store(":memory:" if dry_run else settings.store_path)
    try:
        outcome = await build_daily_brief(
            settings=settings, store=store, now=now, use_dedupe=not dry_run
        )
    finally:
        store.close()

    print(json.dumps(outcome.payload, ensure_ascii=False, indent=2))
    print("\n--- 摘要 ---", file=sys.stderr)
    print(json.dumps(summarize_outcome(outcome), ensure_ascii=False, indent=2), file=sys.stderr)
    return 0


async def _cmd_mentor(author_id: str, keywords: str) -> int:
    from pat_worker.http.client import PoliteHttpClient
    from pat_worker.services.mentor_service import build_profile

    settings = load_settings()
    tz = resolve_tz(settings.timezone)
    store = Store(settings.store_path)
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
        profile = await build_profile(
            client,
            settings=settings,
            author_id=author_id,
            now=datetime.now(tz),
            target_keywords=tuple(k.strip() for k in keywords.split(",") if k.strip()),
            store=store,
        )
    finally:
        await client.aclose()
        store.close()

    if profile is None:
        print(f"未找到 OpenAlex 作者 {author_id}", file=sys.stderr)
        return 1
    print(json.dumps(profile.to_dict(), ensure_ascii=False, indent=2))
    return 0


def _cmd_serve(host: str | None, port: int | None) -> int:
    import uvicorn

    settings = load_settings()
    uvicorn.run(
        "pat_worker.app:app",
        host=host or settings.host,
        port=port or settings.port,
        log_level=settings.log_level.lower(),
        reload=False,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pat-worker",
        description="MatrixOS 04 站 PAT-HOT / 06 站星门 数据面服务",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="启动 HTTP 服务与 08:00 定时任务")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)

    brief = sub.add_parser("brief", help="生成一次早报并打印")
    brief.add_argument(
        "--dry-run",
        action="store_true",
        help="不落库、不登记推送台账、不参与去重",
    )

    mentor = sub.add_parser("mentor", help="打印一位导师的五维画像")
    mentor.add_argument("author_id", help="OpenAlex 作者 id，如 A5023888391")
    mentor.add_argument("--keywords", default="", help="逗号分隔的目标关键词")

    args = parser.parse_args(argv)
    _setup_logging(load_settings().log_level)

    if args.command == "serve":
        return _cmd_serve(args.host, args.port)
    if args.command == "brief":
        return asyncio.run(_cmd_brief(dry_run=args.dry_run))
    if args.command == "mentor":
        return asyncio.run(_cmd_mentor(args.author_id, args.keywords))
    parser.print_help()
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
