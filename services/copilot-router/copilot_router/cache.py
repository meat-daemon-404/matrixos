"""相似请求缓存与合并（R-T05 缓解措施 ①：提高缓存命中）。

为什么这是控制成本的**主要手段**（需求文档 §6 + R-T05）：
试点校同专业学生的查询高度重叠 —— 同一篇热门论文的摘要、同一个导师的画像、
同一份期刊的格式要求，会被几十个人反复问。这类请求复用结果，
成本可以趋近于「只付一次」。

三级命中（从便宜到贵）::

    exact   归一化消息全等 + 同档位 + 同 scope
            最便宜，O(1) 字典查找
    public_identifier
            公共标识（DOI / arXiv ID / OpenReview ID）相同
            视为同一问题，即使措辞不同也复用
    similar trigram + token 混合相似度 ≥ 阈值
            处理「换个说法的同一个问题」

**隔离与合规边界（关键）**：

1. 默认按 ``matrix_uid`` 隔离。只有任务类型在
   ``cache.cross_user_shareable_task_types`` 白名单内、且判定为「公共问题」
   （含公共标识、命中不涉及任何敏感规则）的请求，才允许跨用户复用。
   否则 A 用户的私有上下文会被 B 用户命中 —— 这是数据泄漏，不是成本优化。

2. 敏感数据（``sensitivity.cache_shareable == False``）**永不进缓存**。
   连同一个用户自己的缓存也不回放：未发表数据的分析结果不等于可复用，
   用户可能已经改了数据。

3. 高温采样（``temperature > max_temperature_for_cache``）不进缓存：
   采样结果本就不可复现，缓存等于伪造确定性。

single-flight 合并：
    并发到达的相同/相似请求只让一个打到上游，其余等待它的结果。
    这对早报合成（08:00 全体用户同时开 App）是最有效的一招。
"""

from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Generic, TypeVar

from .config import CacheSpec

T = TypeVar("T")

#: 公共标识正则（DOI / arXiv / OpenReview）
import re

_PUBLIC_ID_PATTERNS = (
    re.compile(r"10\.\d{4,9}/[-._;()/:a-zA-Z0-9]+"),  # DOI
    re.compile(r"arxiv[:.\s]*(\d{4}\.\d{4,5})(v\d+)?", re.IGNORECASE),  # arXiv
    re.compile(r"openreview\.net/forum\?id=([A-Za-z0-9_-]+)", re.IGNORECASE),
)


def extract_public_identifiers(text: str) -> frozenset[str]:
    """提取文本中的公共学术标识，用于「同一论文 = 同一问题」的判定。"""
    found: set[str] = set()
    for pattern in _PUBLIC_ID_PATTERNS:
        for match in pattern.finditer(text):
            found.add(match.group(0).strip().lower())
    return frozenset(found)


# ---------------------------------------------------------------------------
# 归一化
# ---------------------------------------------------------------------------
_JSON_WS = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """归一化：去行首角色前缀差异、压缩空白、统一大小写、去尾部标点。

    刻意**不做**语义改写或翻译 —— 归一化必须保守，宁可少命中也不要错命中。
    """
    lowered = text.strip().lower()
    lowered = _JSON_WS.sub(" ", lowered)
    lowered = lowered.rstrip("。.,!?！？;；")
    return lowered


def exact_key(
    *,
    matrix_uid: str | None,
    tier_id: str,
    model: str,
    normalized: str,
    scope: str,
) -> str:
    """精确缓存键。``scope`` 用于区分跨用户共享域与用户私有域。"""
    owner = scope if scope == "shared" else f"user:{matrix_uid or 'anonymous'}"
    payload = f"{owner}|{tier_id}|{model}|{normalized}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 相似度
# ---------------------------------------------------------------------------
def _trigrams(text: str) -> frozenset[str]:
    if len(text) < 3:
        return frozenset({text}) if text else frozenset()
    return frozenset(text[i : i + 3] for i in range(len(text) - 2))


def _tokens(text: str) -> frozenset[str]:
    """按非字母数字和非 CJK 切词。对中文取单字二元组也足够（见下）。"""
    parts = re.split(r"[^0-9a-zA-Z\u4e00-\u9fff]+", text)
    out: set[str] = set()
    for part in parts:
        if not part:
            continue
        if len(part) <= 3:
            out.add(part)
        else:
            # 中文长串按 2 字窗口切，英文长词整体保留
            if any("\u4e00" <= ch <= "\u9fff" for ch in part):
                out.update(part[i : i + 2] for i in range(len(part) - 1))
            else:
                out.add(part)
    return frozenset(out)


def similarity(left: str, right: str) -> float:
    """trigram Jaccard 与 token Jaccard 的加权平均。

    为什么不用 embedding：缓存判定在每次请求的关键路径上，embedding 需要
    额外一次模型调用（或者本地模型常驻内存），成本与延迟都不划算。
    trigram + token 对「同一问题的不同措辞」召回足够，且完全无副作用。
    代价是对「语义相同但用词完全不同」的问题会漏命中 —— 这是明确的取舍。
    """
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0
    a_tri, b_tri = _trigrams(left), _trigrams(right)
    a_tok, b_tok = _tokens(left), _tokens(right)
    tri_score = len(a_tri & b_tri) / len(a_tri | b_tri) if (a_tri | b_tri) else 0.0
    tok_score = len(a_tok & b_tok) / len(a_tok | b_tok) if (a_tok | b_tok) else 0.0
    return 0.6 * tri_score + 0.4 * tok_score


# ---------------------------------------------------------------------------
# 缓存条目
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class CacheEntry(Generic[T]):
    key: str
    normalized: str
    public_ids: frozenset[str]
    tier_id: str
    model: str
    task_type: str
    scope: str
    owner: str | None
    value: T
    created_at: float
    ttl_seconds: float

    def is_expired(self, now: float) -> bool:
        return (now - self.created_at) > self.ttl_seconds


@dataclass(slots=True)
class CacheLookup(Generic[T]):
    hit: bool
    kind: str | None = None  # exact | similar | public_identifier
    value: T | None = None
    score: float = 0.0
    entry_key: str | None = None


# ---------------------------------------------------------------------------
# 带 single-flight 的缓存
# ---------------------------------------------------------------------------
@dataclass(slots=True)
class _PendingCall:
    event: threading.Event = field(default_factory=threading.Event)
    value: object | None = None
    error: BaseException | None = None


class SimilarityCache(Generic[T]):
    """相似请求缓存 + single-flight 合并。

    线程模型：一把锁保护索引结构，``get_or_compute`` 在锁外执行真实计算，
    避免慢上游把全部请求串行化。
    """

    def __init__(
        self,
        spec: CacheSpec,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._spec = spec
        self._clock = clock
        self._lock = threading.RLock()
        # 精确键索引
        self._by_key: dict[str, CacheEntry[T]] = {}
        # 相似候选列表（按插入顺序，超过上限时淘汰最旧）
        self._entries: list[CacheEntry[T]] = []
        # single-flight：进行中的调用
        self._pending: dict[str, _PendingCall] = {}
        # 统计
        self._stats = {
            "exact_hits": 0,
            "similar_hits": 0,
            "public_id_hits": 0,
            "misses": 0,
            "coalesced": 0,
            "evictions": 0,
            "writes": 0,
        }

    # -- 查找 -------------------------------------------------------------
    def lookup(
        self,
        *,
        key: str,
        normalized: str,
        public_ids: frozenset[str],
        tier_id: str,
        model: str,
        task_type: str,
        owner: str | None,
        scope: str,
        similarity_threshold: float | None = None,
    ) -> CacheLookup[T]:
        now = self._clock()
        threshold = (
            similarity_threshold
            if similarity_threshold is not None
            else self._spec.similarity_threshold
        )
        with self._lock:
            # ---- 1. 精确命中 --------------------------------------------
            entry = self._by_key.get(key)
            if entry is not None and not entry.is_expired(now):
                self._stats["exact_hits"] += 1
                return CacheLookup(
                    hit=True, kind="exact", value=entry.value, score=1.0, entry_key=entry.key
                )

            # ---- 2. 公共标识命中 ----------------------------------------
            if public_ids:
                for candidate in self._iter_candidates():
                    if candidate.is_expired(now):
                        continue
                    if not self._same_domain(candidate, tier_id, model, owner, scope):
                        continue
                    if candidate.public_ids & public_ids:
                        self._stats["public_id_hits"] += 1
                        return CacheLookup(
                            hit=True,
                            kind="public_identifier",
                            value=candidate.value,
                            score=self._spec.public_identifier_similarity,
                            entry_key=candidate.key,
                        )

            # ---- 3. 相似命中 --------------------------------------------
            if len(normalized) >= self._spec.similarity_min_prompt_tokens:
                best: CacheEntry[T] | None = None
                best_score = 0.0
                checked = 0
                for candidate in self._iter_candidates():
                    if checked >= self._spec.similarity_candidate_limit:
                        break
                    if candidate.is_expired(now):
                        continue
                    if not self._same_domain(candidate, tier_id, model, owner, scope):
                        continue
                    checked += 1
                    score = similarity(normalized, candidate.normalized)
                    if score > best_score:
                        best_score = score
                        best = candidate
                if best is not None and best_score >= threshold:
                    self._stats["similar_hits"] += 1
                    return CacheLookup(
                        hit=True,
                        kind="similar",
                        value=best.value,
                        score=round(best_score, 4),
                        entry_key=best.key,
                    )

            self._stats["misses"] += 1
            return CacheLookup(hit=False)

    def _iter_candidates(self):  # type: ignore[no-untyped-def]
        """新的优先（热门内容命中率更高，且更可能是当前版本）。"""
        for entry in reversed(self._entries):
            yield entry

    def _same_domain(
        self,
        entry: CacheEntry[T],
        tier_id: str,
        model: str,
        owner: str | None,
        scope: str,
    ) -> bool:
        """隔离校验：档位/模型必须一致，跨用户复用仅在 shared 域内允许。"""
        if entry.tier_id != tier_id or entry.model != model:
            return False
        if entry.scope != scope:
            return False
        if scope == "shared":
            return True
        return entry.owner == owner

    # -- 写入 -------------------------------------------------------------
    def store(
        self,
        *,
        key: str,
        normalized: str,
        public_ids: frozenset[str],
        tier_id: str,
        model: str,
        task_type: str,
        owner: str | None,
        scope: str,
        value: T,
        ttl_seconds: float,
    ) -> None:
        now = self._clock()
        with self._lock:
            # 同键覆盖（更新为最新结果）
            existing = self._by_key.get(key)
            if existing is not None:
                existing.value = value
                existing.created_at = now
                existing.ttl_seconds = ttl_seconds
                self._stats["writes"] += 1
                return
            entry: CacheEntry[T] = CacheEntry(
                key=key,
                normalized=normalized,
                public_ids=public_ids,
                tier_id=tier_id,
                model=model,
                task_type=task_type,
                scope=scope,
                owner=owner,
                value=value,
                created_at=now,
                ttl_seconds=ttl_seconds,
            )
            self._by_key[key] = entry
            self._entries.append(entry)
            self._stats["writes"] += 1
            self._evict_if_needed(now)

    def _evict_if_needed(self, now: float) -> None:
        """先清过期，再按 FIFO 淘汰到上限以内。"""
        if len(self._entries) <= self._spec.max_entries and not any(
            e.is_expired(now) for e in self._entries
        ):
            return
        survivors: list[CacheEntry[T]] = []
        for entry in self._entries:
            if entry.is_expired(now):
                self._by_key.pop(entry.key, None)
                self._stats["evictions"] += 1
            else:
                survivors.append(entry)
        overflow = len(survivors) - self._spec.max_entries
        if overflow > 0:
            for entry in survivors[:overflow]:
                self._by_key.pop(entry.key, None)
            survivors = survivors[overflow:]
            self._stats["evictions"] += overflow
        self._entries = survivors

    # -- single-flight ----------------------------------------------------
    def get_or_compute(
        self,
        *,
        key: str,
        compute: Callable[[], T],
    ) -> tuple[T, bool]:
        """合并并发相同请求。

        返回 ``(value, coalesced)``。``coalesced=True`` 表示本线程是「跟随者」，
        结果来自另一个线程的计算，**没有产生上游调用**（因此也不应重复记账）。
        """
        with self._lock:
            call = self._pending.get(key)
            if call is None:
                call = _PendingCall()
                self._pending[key] = call
                leader = True
            else:
                leader = False
                self._stats["coalesced"] += 1

        if not leader:
            call.event.wait()
            if call.error is not None:
                raise call.error
            return call.value, True  # type: ignore[return-value]

        try:
            value = compute()
        except BaseException as exc:  # noqa: BLE001 - 必须把异常传给跟随者
            with self._lock:
                self._pending.pop(key, None)
            call.error = exc
            call.event.set()
            raise
        with self._lock:
            self._pending.pop(key, None)
        call.value = value
        call.event.set()
        return value, False

    # -- 运维 -------------------------------------------------------------
    @property
    def stats(self) -> dict[str, int]:
        with self._lock:
            return dict(self._stats)

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._entries)

    def clear(self) -> None:
        with self._lock:
            self._by_key.clear()
            self._entries.clear()
            self._pending.clear()
            for key in self._stats:
                self._stats[key] = 0
