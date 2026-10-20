"""进程内限流器（写操作防刷库）。

为什么不用 Redis：ADR-12 的成本约束下，matrix-core 不额外引入 Redis 依赖；
单实例内存计数足够挡住脚本刷库。多副本部署时该限流退化为「每副本独立」——
这是有意接受的降级，已在 README 的「已知边界」里写明。
"""

from __future__ import annotations

import time
from collections import deque
from typing import Deque

from app.core.errors import ErrorCode, MatrixError


class SlidingWindowLimiter:
    """滑动窗口计数器：``limit`` 次 / ``window`` 秒 / 每个 key。"""

    def __init__(self, limit: int, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, Deque[float]] = {}

    def _now(self) -> float:
        return time.monotonic()

    def check(self, key: str) -> None:
        """超限抛 ``MatrixError(RATE_LIMITED)``；否则记一次。"""
        if self.limit <= 0:
            return
        now = self._now()
        bucket = self._hits.setdefault(key, deque())
        cutoff = now - self.window
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= self.limit:
            retry_after = max(1, int(self.window - (now - bucket[0])))
            raise MatrixError(
                ErrorCode.RATE_LIMITED,
                f"请求过于频繁，请 {retry_after} 秒后重试",
                headers={"Retry-After": str(retry_after)},
                log_extra={"limit_key": key, "limit": self.limit},
            )
        bucket.append(now)

    def reset(self, key: str | None = None) -> None:
        if key is None:
            self._hits.clear()
        else:
            self._hits.pop(key, None)

    @property
    def size(self) -> int:
        return len(self._hits)


# 默认实例：写操作 120 次/分钟/用户（可由 Settings 覆盖后重建）
_default_limiter = SlidingWindowLimiter(limit=120)


def get_write_limiter() -> SlidingWindowLimiter:
    return _default_limiter
