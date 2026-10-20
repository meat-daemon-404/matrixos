"""跨层共享的数据模型。

`PaperItem` 是**采集层的统一出口**：无论来自 arXiv、OpenAlex、Crossref 还是 RSS，
都先归一化成它，再进归并/打分/选卡。这样做的好处是加第 5 个信源时只需要写
一个 `collect() -> list[PaperItem]`，下游一行都不用改。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

#: 信源标识，与 morning-brief.schema.json 的 source_id 枚举严格一致。
#: 新增信源必须同时改 schema 与本枚举——这是刻意的双写，防止契约漂移。
SOURCE_IDS: tuple[str, ...] = (
    "arxiv",
    "openalex",
    "crossref",
    "nature_photonics",
    "nature",
    "nature_physics",
    "nature_materials",
)


@dataclass(slots=True)
class PaperItem:
    """一条归一化后的文献记录。字段全部可选，由采集器按各自能力填充。"""

    source: str
    title: str
    published_at: datetime
    #: 原文链接。必须 https，且优先 DOI 解析链接。
    url: str = ""
    doi: str = ""
    arxiv_id: str = ""
    abstract: str = ""
    #: 已归一化为 PAT-HOT 的档位名（见 domain.heat.VENUE_TIERS）
    venue_tier: str = "unknown"
    venue_name: str = ""
    cited_by_count: int | None = None
    citation_baseline: float | None = None
    topic_momentum: float | None = None
    tags: tuple[str, ...] = ()
    #: 用于跨源归并的键，采集器必须尽力填充。空串表示该源无法提供。
    dedupe_keys: tuple[str, ...] = ()
    flags: frozenset[str] = frozenset()
    #: 该条在源侧的原始标识，便于排查
    raw_id: str = ""

    def __post_init__(self) -> None:
        self.title = (self.title or "").strip()
        self.doi = (self.doi or "").strip().lower()
        self.arxiv_id = (self.arxiv_id or "").strip()
        self.url = (self.url or "").strip()
        self.abstract = (self.abstract or "").strip()

    @property
    def all_dedupe_keys(self) -> tuple[str, ...]:
        keys: list[str] = []
        if self.doi:
            keys.append(f"doi:{self.doi}")
        if self.arxiv_id:
            keys.append(f"arxiv:{self.arxiv_id}")
        keys.extend(k for k in self.dedupe_keys if k)
        if self.title:
            # 标题键一定要有：跨源归并的最后一道保险。用归一化后的前 80 字符做键，
            # 而不是全标题，容忍副标题/标点差异。
            keys.append(f"title:{_title_key(self.title)}")
        return tuple(dict.fromkeys(keys))


def _title_key(title: str) -> str:
    """标题归一化：小写、去标点、压空白。"""
    cleaned = []
    for ch in title.casefold():
        if ch.isalnum():
            cleaned.append(ch)
        elif ch.isspace() and cleaned and cleaned[-1] != " ":
            cleaned.append(" ")
    return "".join(cleaned).strip()[:80]


@dataclass(slots=True)
class CollectedBatch:
    """一个信源一次采集的结果。失败不影响其他源（部分可用是常态）。"""

    source: str
    items: list[PaperItem] = field(default_factory=list)
    ok: bool = True
    error: str = ""
    fetched: int = 0


def source_family(source: str) -> str:
    """把信源折叠成「族」，用于早报 runner_up 槽位的多样性约束。

    为什么需要：Nature Photonics 与 Nature Physics 都是 nature.com 的 RSS，
    内容同源；若两卡都出自 nature 族，等于把「跨源共振」这张牌浪费了。
    """
    if source.startswith("nature"):
        return "nature"
    return source
