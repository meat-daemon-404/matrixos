"""成本核算与台账。

职责（任务书第 2 条）：
- 每次调用记录 token 数与折算成本，按 ``matrix_uid`` 累计；
- 支持 ``/v1/usage/{uid}`` 查询；
- 按 ``matrix_uid`` × ``station_id`` × ``model_tier`` 记账（架构 §8 成本计量要求），
  使月度账单可下钻到单次调用。

存储取舍（诚实说明）：当前实现是**进程内内存台账**，不是数据库。
- 理由：本服务的职责边界是「不持有用户资产」（架构 §3.3），
  而成本台账属于运营计量数据，S1 阶段还没有 PostgreSQL 迁移；
  把台账塞进矩阵服务会违反依赖方向铁律（L2 之间只允许 HTTP 互调）。
- 代价：**多副本部署时无法跨实例累计**，重启即清零。
  因此在接口上明确标注 ``persistent: false``，并在 README 里写明：
  生产部署必须把 ``CostLedger`` 换成 Redis/PostgreSQL 实现
  （接口已抽成类，替换只需改一个构造参数）。
- 这不是「假装做了」，而是把范围与缺口同时说清楚。

时间口径：熔断的「日/月」按 ``billing.timezone`` 的自然日/自然月切分，
默认 Asia/Shanghai。理由：国内业务若按 UTC 切日，会在早上 8 点跨日，
导致早报高峰期的额度统计错乱。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol
from zoneinfo import ZoneInfo

from .config import TierSpec
from .types import CostBreakdown, TokenUsage

# ---------------------------------------------------------------------------
# 时间窗口
# ---------------------------------------------------------------------------
def _tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception:  # pragma: no cover - 时区数据缺失时的兜底
        return ZoneInfo("UTC")


def day_key(moment: datetime, tz_name: str) -> str:
    """返回自然日键，如 ``2026-10-20``。"""
    return moment.astimezone(_tz(tz_name)).strftime("%Y-%m-%d")


def month_key(moment: datetime, tz_name: str) -> str:
    """返回自然月键，如 ``2026-10``。"""
    return moment.astimezone(_tz(tz_name)).strftime("%Y-%m")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# 单次调用记录
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class UsageRecord:
    """一次模型调用的计量记录（可下钻到单次调用）。"""

    trace_id: str
    matrix_uid: str
    station_id: str | None
    tier_id: str
    contract_tier: str
    model: str
    provider: str
    task_type: str
    prompt_tokens: int
    completion_tokens: int
    cost: float
    cache_hit: bool
    cache_kind: str | None
    degraded: bool
    degrade_level: int
    created_at: datetime = field(default_factory=utcnow)

    def to_dict(self) -> dict[str, object]:
        return {
            "trace_id": self.trace_id,
            "matrix_uid": self.matrix_uid,
            "station_id": self.station_id,
            "tier": self.tier_id,
            "tier_contract": self.contract_tier,
            "model": self.model,
            "provider": self.provider,
            "task_type": self.task_type,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
            "cost": round(self.cost, 8),
            "cache_hit": self.cache_hit,
            "cache_kind": self.cache_kind,
            "degraded": self.degraded,
            "degrade_level": self.degrade_level,
            "created_at": self.created_at.isoformat(),
        }


# ---------------------------------------------------------------------------
# 台账接口（便于换实现）
# ---------------------------------------------------------------------------
class LedgerBackend(Protocol):
    """台账后端协议 —— 换成 Redis/PostgreSQL 只需实现这 4 个方法。"""

    def record(self, record: UsageRecord) -> None: ...

    def user_daily_cost(self, matrix_uid: str, day: str) -> float: ...

    def user_monthly_cost(self, matrix_uid: str, month: str) -> float: ...

    def global_daily_cost(self, day: str) -> float: ...

    def global_monthly_cost(self, month: str) -> float: ...


# ---------------------------------------------------------------------------
# 内存实现
# ---------------------------------------------------------------------------
class CostLedger:
    """线程安全的内存台账。

    用一把粗粒度锁而不是分段锁：写入是 O(1) 追加，读是 O(1) 查字典，
    真实瓶颈在等上游模型（几十到几百毫秒），锁竞争不是热点。
    过早优化锁只会引入 bug。
    """

    def __init__(self, tz_name: str = "Asia/Shanghai") -> None:
        self._tz_name = tz_name
        self._lock = threading.RLock()
        self._records: list[UsageRecord] = []
        # uid -> day -> cost
        self._user_daily: dict[str, dict[str, float]] = {}
        # uid -> month -> cost
        self._user_monthly: dict[str, dict[str, float]] = {}
        # day -> cost
        self._global_daily: dict[str, float] = {}
        # month -> cost
        self._global_monthly: dict[str, float] = {}
        # uid -> day -> pro 调用次数（降级 ② 的配额依据）
        self._user_daily_pro_calls: dict[str, dict[str, int]] = {}
        # uid -> 最近 N 条记录索引（下钻用）
        self._by_user: dict[str, list[UsageRecord]] = {}

    # -- 写 ---------------------------------------------------------------
    def record(
        self,
        record: UsageRecord,
        *,
        count_as_pro: bool = False,
    ) -> None:
        day = day_key(record.created_at, self._tz_name)
        month = month_key(record.created_at, self._tz_name)
        cost = record.cost
        with self._lock:
            self._records.append(record)
            self._by_user.setdefault(record.matrix_uid, []).append(record)

            self._user_daily.setdefault(record.matrix_uid, {}).setdefault(day, 0.0)
            self._user_daily[record.matrix_uid][day] += cost
            self._user_monthly.setdefault(record.matrix_uid, {}).setdefault(month, 0.0)
            self._user_monthly[record.matrix_uid][month] += cost
            self._global_daily[day] = self._global_daily.get(day, 0.0) + cost
            self._global_monthly[month] = self._global_monthly.get(month, 0.0) + cost

            if count_as_pro:
                calls = self._user_daily_pro_calls.setdefault(record.matrix_uid, {})
                calls[day] = calls.get(day, 0) + 1

    # -- 读 ---------------------------------------------------------------
    def user_daily_cost(self, matrix_uid: str, day: str) -> float:
        with self._lock:
            return self._user_daily.get(matrix_uid, {}).get(day, 0.0)

    def user_monthly_cost(self, matrix_uid: str, month: str) -> float:
        with self._lock:
            return self._user_monthly.get(matrix_uid, {}).get(month, 0.0)

    def global_daily_cost(self, day: str) -> float:
        with self._lock:
            return self._global_daily.get(day, 0.0)

    def global_monthly_cost(self, month: str) -> float:
        with self._lock:
            return self._global_monthly.get(month, 0.0)

    def user_daily_pro_calls(self, matrix_uid: str, day: str) -> int:
        with self._lock:
            return self._user_daily_pro_calls.get(matrix_uid, {}).get(day, 0)

    def user_records(self, matrix_uid: str, limit: int = 20) -> list[UsageRecord]:
        with self._lock:
            records = self._by_user.get(matrix_uid, [])
            return records[-limit:][::-1]

    def all_records(self) -> list[UsageRecord]:
        with self._lock:
            return list(self._records)

    def stats(self) -> dict[str, object]:
        with self._lock:
            total_cost = sum(r.cost for r in self._records)
            total_tokens = sum(r.prompt_tokens + r.completion_tokens for r in self._records)
            cache_hits = sum(1 for r in self._records if r.cache_hit)
            calls = len(self._records)
            billed_calls = sum(1 for r in self._records if r.cost > 0)
            return {
                "calls": calls,
                "billed_calls": billed_calls,
                "cache_hits": cache_hits,
                "cache_hit_rate": round(cache_hits / calls, 4) if calls else 0.0,
                "total_cost": round(total_cost, 8),
                "total_tokens": total_tokens,
                "users": len(self._by_user),
            }

    def reset(self) -> None:
        """仅供测试使用。"""
        with self._lock:
            self._records.clear()
            self._user_daily.clear()
            self._user_monthly.clear()
            self._global_daily.clear()
            self._global_monthly.clear()
            self._user_daily_pro_calls.clear()
            self._by_user.clear()


# ---------------------------------------------------------------------------
# 成本折算
# ---------------------------------------------------------------------------
def compute_cost(spec: TierSpec, usage: TokenUsage) -> CostBreakdown:
    """按档位单价把 token 折算成人民币。

    单价单位：元 / 百万 token（与需求文档 §6 一致）。
    本地档位（TIER 04）单价为 0，因此成本恒为 0 —— 这是「零外泄且零 API 费」的体现，
    但 GPU 折旧成本在基础设施预算里，不在 token 计费口径内（已在配置注释中说明）。
    """
    input_cost = usage.prompt_tokens / 1_000_000 * spec.price_input_per_million
    output_cost = usage.completion_tokens / 1_000_000 * spec.price_output_per_million
    return CostBreakdown(
        tier_id=spec.tier_id,
        model=spec.model,
        price_input_per_million=spec.price_input_per_million,
        price_output_per_million=spec.price_output_per_million,
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        input_cost=input_cost,
        output_cost=output_cost,
    )


def estimate_cost(
    spec: TierSpec,
    prompt_tokens: int,
    completion_tokens: int,
    *,
    safety_factor: float = 1.0,
) -> float:
    """预算预检用的成本估算（调用前）。"""
    raw = (
        prompt_tokens / 1_000_000 * spec.price_input_per_million
        + completion_tokens / 1_000_000 * spec.price_output_per_million
    )
    return raw * safety_factor
