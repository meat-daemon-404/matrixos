"""跨源归并与去重。

同一篇论文常在 arXiv（预印本）、OpenAlex（收录）、Crossref（DOI 注册）、
Nature RSS（见刊）四处各出现一次。若不归并，早报三卡会被同一篇占满，
「跨源提及」这个因子也失去意义——它会因为自己的重复而虚高。

归并策略（并查集，按传递闭包）：

1. 每条 PaperItem 贡献若干 dedupe key（doi / arxiv / 标题）。
2. 任一 key 相同的两条视为同一实体，合并成一个 `MergedPaper`。
3. 合并时按**字段优先级**取最可信的值，而不是简单取第一条：
   - 期刊名/档位：Crossref > OpenAlex > Nature RSS > arXiv（出版方注册最权威）
   - 引用数：取最大值（不同源的统计时点不同，最大者最接近真实）
   - 发布时间：取**最早**（首次公开时间才对「24h 新」有意义）
   - 摘要：取最长的（信息量最大）
4. `sources` 集合的大小就是热度算法的 `source_count`——这是「跨源提及」的物理含义。

为什么不直接用标题模糊匹配（fuzzy）：24h 窗口内条目数在几百量级，精确 key 足够；
引入模糊匹配会在「同标题不同文」上误合并，代价（推错论文）远高于收益。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from pat_worker.models import PaperItem

#: 字段来源优先级。数字越小越可信。
VENUE_AUTHORITY: dict[str, int] = {
    "crossref": 0,
    "openalex": 1,
    "nature_photonics": 2,
    "nature_physics": 2,
    "nature_materials": 2,
    "nature": 2,
    "arxiv": 3,
}


@dataclass(slots=True)
class MergedPaper:
    """归并后的实体。下游（打分、选卡）只认这个类型。"""

    title: str
    published_at: datetime
    url: str
    doi: str = ""
    arxiv_id: str = ""
    abstract: str = ""
    venue_tier: str = "unknown"
    venue_name: str = ""
    cited_by_count: int | None = None
    citation_baseline: float | None = None
    topic_momentum: float | None = None
    tags: tuple[str, ...] = ()
    flags: frozenset[str] = frozenset()
    sources: tuple[str, ...] = ()
    members: list[PaperItem] = field(default_factory=list)

    @property
    def source_count(self) -> int:
        return len(self.sources)

    @property
    def primary_source(self) -> str:
        """卡片上显示的单一信源：取权威度最高的那个。"""
        if not self.sources:
            return ""
        return min(self.sources, key=lambda s: VENUE_AUTHORITY.get(s, 9))

    def to_item(self) -> PaperItem:
        """回落成 PaperItem，供只需要单条记录的调用方使用。"""
        return PaperItem(
            source=self.primary_source,
            title=self.title,
            published_at=self.published_at,
            url=self.url,
            doi=self.doi,
            arxiv_id=self.arxiv_id,
            abstract=self.abstract,
            venue_tier=self.venue_tier,
            venue_name=self.venue_name,
            cited_by_count=self.cited_by_count,
            citation_baseline=self.citation_baseline,
            topic_momentum=self.topic_momentum,
            tags=self.tags,
            flags=self.flags,
        )


class _UnionFind:
    """最小并查集。条目量级只有几百，路径压缩足够，无需按秩合并。"""

    def __init__(self, size: int) -> None:
        self._parent = list(range(size))

    def find(self, x: int) -> int:
        while self._parent[x] != x:
            self._parent[x] = self._parent[self._parent[x]]
            x = self._parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self._parent[rb] = ra


def merge_items(items: list[PaperItem]) -> list[MergedPaper]:
    """把多源条目归并成唯一条目集合。保持输入顺序的稳定输出（便于复现）。"""
    if not items:
        return []

    uf = _UnionFind(len(items))
    key_owner: dict[str, int] = {}
    for index, item in enumerate(items):
        for key in item.all_dedupe_keys:
            owner = key_owner.get(key)
            if owner is None:
                key_owner[key] = index
            else:
                uf.union(owner, index)

    groups: dict[int, list[PaperItem]] = {}
    for index, item in enumerate(items):
        groups.setdefault(uf.find(index), []).append(item)

    merged: list[MergedPaper] = []
    # 按组内第一条的下标排序，保证输出顺序只取决于输入顺序
    index_of_first = {
        root: min(i for i, item in enumerate(items) if uf.find(i) == root) for root in groups
    }
    for root in sorted(groups, key=lambda r: index_of_first[r]):
        merged.append(_combine(groups[root]))
    return merged


def _combine(group: list[PaperItem]) -> MergedPaper:
    """合并同组条目。规则见模块文档。"""
    # 期刊权威度：选出 venue 信息最可信的那条作为基准
    venue_source = min(group, key=lambda it: VENUE_AUTHORITY.get(it.source, 9))

    longest_abstract = max(group, key=lambda it: len(it.abstract or ""))
    earliest = min(group, key=lambda it: it.published_at)

    citations = [it.cited_by_count for it in group if it.cited_by_count is not None]
    cited_by_count = max(citations) if citations else None

    baselines = [it.citation_baseline for it in group if it.citation_baseline is not None]
    citation_baseline = max(baselines) if baselines else None

    momenta = [it.topic_momentum for it in group if it.topic_momentum is not None]
    topic_momentum = max(momenta) if momenta else None

    doi = next((it.doi for it in group if it.doi), "")
    arxiv_id = next((it.arxiv_id for it in group if it.arxiv_id), "")
    # URL 优先给 DOI 链接（长期稳定），其次 arXiv abs 页
    url = ""
    if doi:
        url = f"https://doi.org/{doi}"
    elif arxiv_id:
        url = f"https://arxiv.org/abs/{arxiv_id}"
    else:
        url = next((it.url for it in group if it.url.startswith("https://")), "")

    tags: list[str] = []
    for item in group:
        for tag in item.tags:
            if tag and tag not in tags:
                tags.append(tag)

    sources = tuple(dict.fromkeys(it.source for it in group if it.source))

    return MergedPaper(
        title=venue_source.title or earliest.title,
        published_at=earliest.published_at,
        url=url,
        doi=doi,
        arxiv_id=arxiv_id,
        abstract=longest_abstract.abstract,
        # 档位取最可信来源；但若任一条目被判为预印本而另一条已见刊，
        # 以「更权威的来源」为准，这正是要的结果。
        venue_tier=venue_source.venue_tier,
        venue_name=venue_source.venue_name,
        cited_by_count=cited_by_count,
        citation_baseline=citation_baseline,
        topic_momentum=topic_momentum,
        tags=tuple(tags[:5]),
        flags=frozenset().union(*(it.flags for it in group)),
        members=list(group),
    )
