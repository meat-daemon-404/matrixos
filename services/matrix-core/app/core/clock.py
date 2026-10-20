"""时间工具：统一 UTC + 秒级精度，便于测试注入假时钟。

测试里用 ``FrozenClock`` 手动推进时间，让「令牌过期 / mx_idt 120s 失效」
这类用例无需真实等待。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

UTC = timezone.utc


def now() -> datetime:
    """当前 UTC 时间（统一入口，便于替换）。"""
    return datetime.now(tz=UTC)


def now_ts() -> int:
    """当前 Unix 秒。"""
    return int(now().timestamp())


def ts_of(moment: datetime) -> int:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return int(moment.timestamp())


def from_ts(value: int | float) -> datetime:
    return datetime.fromtimestamp(value, tz=UTC)


def plus_seconds(seconds: int, *, base: datetime | None = None) -> datetime:
    return (base or now()) + timedelta(seconds=seconds)


def ensure_utc(moment: datetime) -> datetime:
    """把可能 naive 的时间统一成 UTC aware（SQLite 读回时是 naive）。"""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


class FrozenClock:
    """可手动推进的时钟，测试用。"""

    def __init__(self, start: datetime | None = None) -> None:
        self._current = start or datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self._current

    def advance(self, seconds: int) -> datetime:
        self._current = self._current + timedelta(seconds=seconds)
        return self._current
