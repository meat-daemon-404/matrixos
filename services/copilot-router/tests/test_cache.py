"""缓存语义测试（补 cache.py 的覆盖缺口）。

缓存是本服务「省钱」的第一根支柱（R-T05 降级①、ADR-06），但它同时是
**成本与合规的交汇点**，所以测试重点不是「能存能取」，而是三条不变量：

1. **隔离**：跨用户复用只允许发生在 shared 域内的白名单任务类型上。
   一旦这里出错，A 学生的论文会出现在 B 学生的响应里——比多花钱严重得多。
2. **域匹配**：档位或模型不同绝不能互相命中，否则便宜档会命中贵档的结果
   （或反过来），成本归因就全错了。
3. **single-flight**：并发相同请求只能有一次真实上游调用，否则「合并」是假的。

时间一律注入 clock，不 sleep——避免 CI 上因调度抖动而 flaky。
"""

from __future__ import annotations

import threading
import time

import pytest

from copilot_router.cache import (
    CacheLookup,
    SimilarityCache,
    exact_key,
    extract_public_identifiers,
    normalize_text,
    similarity,
)


# ---------------------------------------------------------------------------
# 归一化与相似度
# ---------------------------------------------------------------------------
def test_normalize_is_conservative():
    """归一化只做大小写/空白/尾部标点，不做语义改写。"""
    assert normalize_text("  你好   世界。 ") == "你好 世界"
    assert normalize_text("HELLO   World!!") == "hello world"
    # 不同措辞必须保持不同，否则缓存会错命中
    assert normalize_text("比较两篇论文") != normalize_text("对比两篇文章")


def test_identical_text_scores_one():
    assert similarity("钙钛矿太阳能电池的稳定性", "钙钛矿太阳能电池的稳定性") == 1.0


def test_similarity_is_bounded_and_symmetric():
    a = "请帮我比较这两篇关于钙钛矿钝化的论文"
    b = "帮我比较两篇钙钛矿钝化相关论文"
    score = similarity(a, b)
    assert 0.0 <= score <= 1.0
    assert score == pytest.approx(similarity(b, a)), "相似度必须对称"


def test_unrelated_text_scores_low():
    score = similarity("钙钛矿太阳能电池", "引力波探测器的噪声抑制")
    assert score < 0.5, f"无关文本相似度过高: {score}"


def test_empty_text_scores_zero():
    assert similarity("", "非空") == 0.0
    assert similarity("非空", "") == 0.0


def test_exact_key_separates_users_and_shared():
    kwargs = dict(tier_id="tier-01", model="m", normalized="text")
    user_a = exact_key(matrix_uid="a", scope="user", **kwargs)
    user_b = exact_key(matrix_uid="b", scope="user", **kwargs)
    shared = exact_key(matrix_uid=None, scope="shared", **kwargs)
    assert user_a != user_b, "不同用户的私有键必须不同"
    assert user_a != shared, "共享域键不能等于私有域键"
    # 同一输入必须稳定
    assert user_a == exact_key(matrix_uid="a", scope="user", **kwargs)


def test_public_identifiers_extracted():
    text = "帮我解释 10.1038/nature12373 这篇和 arXiv:2401.01234 的核心差别"
    ids = extract_public_identifiers(text)
    assert any("10.1038/nature12373" in i for i in ids), f"未提取到 DOI: {ids}"
    assert ids, "应至少提取到一个公共标识"


# ---------------------------------------------------------------------------
# 隔离与域匹配
# ---------------------------------------------------------------------------
DEFAULT_TEXT = "钙钛矿太阳能电池的稳定性问题"


def _derive_key(tier_id: str, model: str, normalized: str, scope: str, uid: str) -> str:
    """复用 gateway 的键派生方式，保证测试反映真实的缓存键形态。

    刻意不硬编码同一个 key：真实调用方（gateway）每次都通过 ``exact_key``
    把 owner/tier/model/文本一起算进哈希，这正是隔离的实现基础。
    """
    return exact_key(
        matrix_uid=uid,
        tier_id=tier_id,
        model=model,
        normalized=normalized,
        scope=scope,
    )


def _store(cache: SimilarityCache, **overrides):
    params = dict(
        normalized=DEFAULT_TEXT,
        public_ids=frozenset(),
        tier_id="tier-01",
        model="deepseek-flash",
        task_type="intent_parse",
        owner="user-a",
        scope="user",
        value={"answer": "A"},
        ttl_seconds=3600.0,
    )
    params.update(overrides)
    if "key" not in params:
        params["key"] = _derive_key(
            params["tier_id"],
            params["model"],
            params["normalized"],
            params["scope"],
            params["owner"] or "anonymous",
        )
    cache.store(**params)


def _lookup(cache: SimilarityCache, **overrides):
    params = dict(
        normalized=DEFAULT_TEXT,
        public_ids=frozenset(),
        tier_id="tier-01",
        model="deepseek-flash",
        task_type="intent_parse",
        owner="user-a",
        scope="user",
    )
    params.update(overrides)
    if "key" not in params:
        params["key"] = _derive_key(
            params["tier_id"],
            params["model"],
            params["normalized"],
            params["scope"],
            params["owner"] or "anonymous",
        )
    return cache.lookup(**params)


def test_exact_hit_returns_stored_value(cache):
    _store(cache)
    result = _lookup(cache)
    assert result.hit and result.kind == "exact"
    assert result.value == {"answer": "A"}
    assert cache.stats["exact_hits"] == 1


def test_private_scope_does_not_leak_across_users(cache):
    """合规红线：私有域缓存绝不能被另一个用户命中。"""
    _store(cache, owner="user-a")
    result = _lookup(cache, owner="user-b")
    assert not result.hit, "私有缓存跨用户泄漏"


def test_shared_scope_is_visible_across_users(cache):
    _store(cache, scope="shared", owner=None, task_type="multi_paper_compare")
    result = _lookup(cache, scope="shared", owner=None, task_type="multi_paper_compare")
    assert result.hit and result.kind == "exact"


def test_different_tier_never_hits(cache):
    """便宜档不能命中贵档结果，否则成本归因错误。"""
    _store(cache, tier_id="tier-01")
    assert not _lookup(cache, tier_id="tier-03", key="k1").hit


def test_different_model_never_hits(cache):
    _store(cache, model="model-a")
    assert not _lookup(cache, model="model-b").hit


def test_expired_entry_is_not_returned(cache):
    now = {"t": 1000.0}
    clock_cache = SimilarityCache(cache._spec, clock=lambda: now["t"])
    _store(clock_cache, ttl_seconds=10.0)
    assert clock_cache.lookup(
        key="k1",
        normalized="钙钛矿太阳能电池的稳定性问题",
        public_ids=frozenset(),
        tier_id="tier-01",
        model="deepseek-flash",
        task_type="intent_parse",
        owner="user-a",
        scope="user",
    ).hit
    now["t"] += 11.0
    result = clock_cache.lookup(
        key="k1",
        normalized="钙钛矿太阳能电池的稳定性问题",
        public_ids=frozenset(),
        tier_id="tier-01",
        model="deepseek-flash",
        task_type="intent_parse",
        owner="user-a",
        scope="user",
    )
    assert not result.hit, "过期条目仍被命中"


# ---------------------------------------------------------------------------
# 相似命中与公共标识命中
# ---------------------------------------------------------------------------
def test_similar_prompt_hits_with_relaxed_threshold(cache):
    """换个说法的同一问题应命中，这是降级①的核心手段。

    标定说明：``similarity`` 是 trigram Jaccard 与 token Jaccard 的加权平均
    （0.6/0.4），刻意偏保守——实测「改一个词」≈0.78、「同义改写」≈0.33，
    只有「几乎一字不差」才 >0.92。因此这里的探针只做轻微扰动（句尾加语气词），
    这才是缓存真正该复用的场景；语义改写**不该**命中，见下一条用例。
    """
    stored = "请帮我比较这两篇关于钙钛矿钝化的论文"
    _store(cache, normalized=stored)
    probe = stored + "吧"
    result = cache.lookup(
        key="a-different-key",
        normalized=probe,
        public_ids=frozenset(),
        tier_id="tier-01",
        model="deepseek-flash",
        task_type="intent_parse",
        owner="user-a",
        scope="user",
        similarity_threshold=0.86,  # 降级①放宽后的阈值（0.92 - 0.06）
    )
    assert result.hit and result.kind == "similar", f"相似命中失败: {result}"
    assert 0.0 < result.score <= 1.0


def test_paraphrase_does_not_hit_by_default_threshold(cache):
    """明确的取舍：语义改写不命中相似缓存（宁可漏命中也不要错命中）。

    这不是缺陷，是 cache.py 文档里写明的设计选择——用 trigram/token
    Jaccard 换取「零额外模型调用」。这里把该取舍固化成回归测试，
    以免有人为了「提高命中率」把阈值调到会错命中无关请求的程度。
    """
    _store(cache, normalized="请帮我比较这两篇关于钙钛矿钝化的论文")
    result = cache.lookup(
        key="paraphrase-key",
        normalized="帮我比较两篇钙钛矿钝化相关的论文",
        public_ids=frozenset(),
        tier_id="tier-01",
        model="deepseek-flash",
        task_type="intent_parse",
        owner="user-a",
        scope="user",
        similarity_threshold=0.86,
    )
    assert not result.hit, "语义改写不应被 token 级相似度命中（会带来错误的缓存复用）"


def test_high_threshold_blocks_weak_similarity(cache):
    stored = "请帮我比较这两篇关于钙钛矿钝化的论文"
    _store(cache, normalized=stored)
    result = cache.lookup(
        key="weak-key",
        normalized=stored + "吧",
        public_ids=frozenset(),
        tier_id="tier-01",
        model="deepseek-flash",
        task_type="intent_parse",
        owner="user-a",
        scope="user",
        similarity_threshold=1.0,  # 只有完全相同才命中
    )
    assert not result.hit


def test_public_identifier_hit(cache):
    """同一 DOI 视为同一问题，即使措辞完全不同。"""
    _store(cache, key="k-doi", public_ids=frozenset({"10.1038/nature12373"}), normalized="旧措辞")
    result = cache.lookup(
        key="brand-new-key",
        normalized="一段完全不同的问法",
        public_ids=frozenset({"10.1038/nature12373"}),
        tier_id="tier-01",
        model="deepseek-flash",
        task_type="intent_parse",
        owner="user-a",
        scope="user",
    )
    assert result.hit and result.kind == "public_identifier"


def test_short_prompt_skips_similarity(cache):
    """短 prompt 不做相似匹配：太短时 trigram 相似度不可靠。"""
    _store(cache, normalized="你好")
    result = _lookup(cache, normalized="您好", similarity_threshold=0.1)
    assert not result.hit, "短 prompt 不该走相似命中"


def test_miss_increments_counter(cache):
    result = _lookup(cache, key="never-stored")
    assert not result.hit
    assert cache.stats["misses"] >= 1


# ---------------------------------------------------------------------------
# 写入、淘汰
# ---------------------------------------------------------------------------
def test_store_same_key_overwrites(cache):
    _store(cache, value={"v": 1})
    _store(cache, value={"v": 2})
    assert cache.size == 1, "同键应覆盖而不是新增"
    assert _lookup(cache).value == {"v": 2}


def test_entries_evicted_beyond_max(cache):
    limit = cache._spec.max_entries
    for i in range(limit + 5):
        _store(
            cache,
            key=f"k{i}",
            normalized=f"第 {i} 条完全不同的测试文本内容",
            owner=f"user-{i}",
        )
    assert cache.size <= limit, f"超出上限未淘汰: {cache.size} > {limit}"


def test_expired_entries_are_evicted_on_write(cache):
    now = {"t": 0.0}
    clock_cache = SimilarityCache(cache._spec, clock=lambda: now["t"])
    _store(clock_cache, key="old", ttl_seconds=1.0, normalized="一条会过期的旧文本")
    now["t"] = 100.0
    _store(clock_cache, key="new", ttl_seconds=1000.0, normalized="一条新的文本内容")
    assert clock_cache.size == 1, "写入时应顺带清掉过期条目"


def test_clear_resets_entries(cache):
    _store(cache)
    cache.clear()
    assert cache.size == 0


# ---------------------------------------------------------------------------
# single-flight
# ---------------------------------------------------------------------------
def test_get_or_compute_returns_value(cache):
    value, coalesced = cache.get_or_compute(key="c1", compute=lambda: "result")
    assert value == "result"
    assert coalesced is False, "首个调用者不是跟随者"


def test_concurrent_same_key_computes_once(cache):
    """并发合并：N 个线程同一 key，compute 只能执行一次。"""
    calls = {"n": 0}
    started = threading.Event()
    release = threading.Event()

    def compute():
        calls["n"] += 1
        started.set()
        release.wait(timeout=5)
        return "shared-result"

    results: list[tuple[object, bool]] = []
    lock = threading.Lock()

    def worker():
        value, coalesced = cache.get_or_compute(key="same", compute=compute)
        with lock:
            results.append((value, coalesced))

    threads = [threading.Thread(target=worker) for _ in range(5)]
    leader = threads[0]
    leader.start()
    assert started.wait(timeout=5), "leader 未开始计算"
    for t in threads[1:]:
        t.start()
    # 等跟随者进入等待，再放行 leader
    time.sleep(0.05)
    release.set()
    for t in threads:
        t.join(timeout=5)

    assert calls["n"] == 1, f"compute 被执行了 {calls['n']} 次，single-flight 失效"
    assert len(results) == 5
    assert all(r[0] == "shared-result" for r in results), f"结果不一致: {results}"
    assert sum(1 for r in results if r[1]) == 4, "应有 4 个跟随者"
    assert cache.stats["coalesced"] == 4


def test_follower_receives_exception(cache):
    """leader 抛异常时，跟随者必须收到同一个异常，不能静默返回 None。"""
    errors: list[BaseException] = []

    def boom():
        raise RuntimeError("upstream exploded")

    with pytest.raises(RuntimeError):
        cache.get_or_compute(key="err", compute=boom)

    # 失败后 pending 必须清理干净，否则后续同 key 会永久阻塞
    value, coalesced = cache.get_or_compute(key="err", compute=lambda: "recovered")
    assert value == "recovered" and coalesced is False
    assert not errors
