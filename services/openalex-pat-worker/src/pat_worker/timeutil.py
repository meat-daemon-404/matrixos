"""时间与日期工具。

单独立一个模块的原因是 Windows 上 `zoneinfo` 没有系统 tz 数据库：
未安装 `tzdata` 包时 `ZoneInfo("Asia/Shanghai")` 会抛 ZoneInfoNotFoundError。
早报的「08:00」和 brief_date 都依赖时区，不能因为装漏一个可选包就整个服务起不来，
因此这里做**显式降级**并在降级时给出可观测的 warning，而不是静默用 UTC。
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

#: tzdata 缺失时的降级偏移表。Asia/Shanghai 自 1991 年后无夏令时，
#: 用固定 UTC+8 与真实时区完全等价，可安全替代。
_FIXED_OFFSETS: dict[str, int] = {
    "Asia/Shanghai": 8,
    "Asia/Chongqing": 8,
    "Asia/Hong_Kong": 8,
    "Asia/Taipei": 8,
    "Asia/Tokyo": 9,
    "Asia/Seoul": 9,
    "UTC": 0,
    "Etc/UTC": 0,
}

_fallback_notice: list[str] = []


def resolve_tz(name: str) -> tzinfo:
    """解析 IANA 时区名；tzdata 缺失时按已知偏移降级，最后兜底 UTC。"""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        pass
    offset_hours = _FIXED_OFFSETS.get(name)
    if offset_hours is not None:
        notice = (
            f"时区 {name} 降级为固定 UTC{offset_hours:+d}（缺少 tzdata 包，"
            "请 pip install tzdata 以启用完整时区数据库）"
        )
        if notice not in _fallback_notice:
            _fallback_notice.append(notice)
        return _FixedOffset(offset_hours)
    notice = f"未知时区 {name!r}，已兜底为 UTC"
    if notice not in _fallback_notice:
        _fallback_notice.append(notice)
    return UTC


def tz_fallback_warnings() -> list[str]:
    """返回降级过程中记录过的告警，供 /healthz 暴露。"""
    return list(_fallback_notice)


def reset_tz_warnings() -> None:
    _fallback_notice.clear()


class _FixedOffset(tzinfo):
    """最小可用的固定偏移时区。APScheduler 只要 tzinfo 能给出 utcoffset 即可。"""

    def __init__(self, hours: int) -> None:
        self._offset = timedelta(hours=hours)
        self._name = f"UTC{hours:+d}"

    def utcoffset(self, dt: datetime | None) -> timedelta:  # noqa: ARG002
        return self._offset

    def tzname(self, dt: datetime | None) -> str:  # noqa: ARG002
        return self._name

    def dst(self, dt: datetime | None) -> timedelta:  # noqa: ARG002
        return timedelta(0)

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"<FixedOffset {self._name}>"


def ensure_aware(value: datetime, tz: tzinfo) -> datetime:
    """把 naive datetime 视作 `tz` 本地时间；aware 的原样返回。"""
    if value.tzinfo is None:
        return value.replace(tzinfo=tz)
    return value


def isoformat_offset(value: datetime, tz: tzinfo) -> str:
    """输出带偏移的 ISO 8601（小程序端 Date 能直接解析）。"""
    return ensure_aware(value, tz).astimezone(tz).isoformat(timespec="seconds")


def brief_date_for(moment: datetime, tz: tzinfo) -> str:
    """早报归属日期：按业务时区取日期，不是 UTC 日期。"""
    return ensure_aware(moment, tz).astimezone(tz).strftime("%Y-%m-%d")


def window_for(now: datetime, hours: int, tz: tzinfo) -> tuple[datetime, datetime]:
    """返回 (start, end) 监听窗口，end 即 now。"""
    end = ensure_aware(now, tz)
    return end - timedelta(hours=hours), end


def short_hash(payload: object, length: int = 8) -> str:
    """稳定短哈希：键排序 + 紧凑分隔符，跨进程跨平台一致。"""
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:length]
