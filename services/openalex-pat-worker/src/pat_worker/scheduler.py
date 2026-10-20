"""每日 08:00 定时任务。

用 APScheduler 的 `AsyncIOScheduler` + `CronTrigger`，而不是 `asyncio.sleep` 轮询：

- **时区必须显式指定**。`CronTrigger(hour=8)` 若不传 timezone，用的是
  调度器默认时区（容器里通常是 UTC），结果是北京时间 16:00 推送。这是本项目
  最容易犯且最难发现的 bug，因此 `build_scheduler` 强制传 tz。
- **`misfire_grace_time`**：机器凌晨休眠/重启后，08:00 的触发点可能被错过。
  APScheduler 默认 1 秒宽限，超过就丢弃。这里设 2 小时——只要 10:00 前醒过来
  就补发，符合「晨间早报」的产品语义。
- **`coalesce=True`**：错过多轮只跑一次，不会连发三份早报。
- **`max_instances=1`**：上一轮还在跑（如 arXiv 被限速拖慢）时，新一轮跳过，
  避免两个任务同时写同一天早报。

手动触发端点 `/internal/pat/refresh` 走的是同一套 `build_daily_brief`，
只是 `now` 用当前时刻，因此手动跑与定时跑**产出同构**，不会出现「手动能出、
定时出不来」这类只有生产才暴露的问题。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from pat_worker.pipeline.runner import build_daily_brief, summarize_outcome
from pat_worker.settings import Settings
from pat_worker.store.sqlite_store import Store
from pat_worker.timeutil import resolve_tz

logger = logging.getLogger(__name__)

JOB_ID_DAILY_BRIEF = "pat.daily_brief"

#: 错过触发点后的补跑宽限（秒）。2 小时。
MISFIRE_GRACE_SECONDS = 2 * 60 * 60


@dataclass(slots=True)
class BriefJobState:
    """最近一次定时任务的结果，供 /healthz 与 /internal/pat/status 读取。"""

    last_run_at: datetime | None = None
    last_digest_id: str = ""
    last_ok: bool = True
    last_error: str = ""
    run_count: int = 0
    failure_count: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "last_run_at": self.last_run_at.isoformat() if self.last_run_at else None,
            "last_digest_id": self.last_digest_id,
            "last_ok": self.last_ok,
            "last_error": self.last_error,
            "run_count": self.run_count,
            "failure_count": self.failure_count,
        }


JOB_STATE = BriefJobState()


async def run_daily_brief_job(
    *, settings: Settings, store: Store, now: datetime | None = None
) -> dict[str, Any]:
    """执行一次早报生成。定时器与手动端点共用此函数。

    绝不抛异常给调度器：APScheduler 在 job 抛异常时会记 traceback 但不再重试，
    而早报的可用性要求我们「这一轮失败了也要能出下一轮」。因此这里吞掉异常、
    写进 JOB_STATE，并返回结构化结果让调用方判断。
    """
    moment = now or datetime.now(resolve_tz(settings.timezone))
    JOB_STATE.run_count += 1
    JOB_STATE.last_run_at = moment
    try:
        outcome = await build_daily_brief(settings=settings, store=store, now=moment)
    except Exception as exc:  # noqa: BLE001 - 调度任务必须自愈
        JOB_STATE.last_ok = False
        JOB_STATE.failure_count += 1
        JOB_STATE.last_error = f"{type(exc).__name__}: {exc}"
        logger.exception("早报生成失败")
        return {"ok": False, "error": JOB_STATE.last_error}

    summary = summarize_outcome(outcome)
    JOB_STATE.last_ok = True
    JOB_STATE.last_error = ""
    JOB_STATE.last_digest_id = str(summary.get("digest_id") or "")
    logger.info(
        "早报生成成功 digest=%s cards=%s selected=%s failures=%s",
        summary.get("digest_id"),
        summary.get("cards"),
        summary.get("selected"),
        summary.get("failures"),
    )
    return {"ok": True, **summary}


def build_scheduler(settings: Settings, store: Store) -> AsyncIOScheduler:
    """构造调度器（未启动）。调用方负责 `scheduler.start()` / `shutdown()`。"""
    tz = resolve_tz(settings.timezone)
    hour, minute = settings.brief_cron_hour_minute()
    scheduler = AsyncIOScheduler(timezone=tz)

    trigger = CronTrigger(
        hour=hour,
        minute=minute,
        timezone=tz,
        misfire_grace_time=MISFIRE_GRACE_SECONDS,
        coalesce=True,
        max_instances=1,
    )

    scheduler.add_job(
        run_daily_brief_job,
        trigger=trigger,
        id=JOB_ID_DAILY_BRIEF,
        name="PAT-HOT 每日三卡早报",
        kwargs={"settings": settings, "store": store},
        replace_existing=True,
        # 明确不设置 jitter：08:00 是产品承诺的时间点，随机抖动会让用户困惑。
        # 上游限速由 HttpClient 的 per-host 限速器承担，不靠抖动错峰。
    )

    logger.info(
        "调度器已装配：每日 %02d:%02d (%s) 生成早报", hour, minute, settings.timezone
    )
    return scheduler


def next_run_time(scheduler: AsyncIOScheduler) -> str | None:
    """下一次触发时刻（ISO 8601）。调度器未启动时返回 None。"""
    job = scheduler.get_job(JOB_ID_DAILY_BRIEF)
    if job is None or job.next_run_time is None:
        return None
    return job.next_run_time.isoformat(timespec="seconds")
