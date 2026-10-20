"""信源采集器。每个模块暴露一个 `collect_*` 协程，失败时返回带 error 的
`CollectedBatch` 而不是抛异常——早报的可用性优先于单源的正确性。
"""

from pat_worker.collectors.arxiv import collect_arxiv, normalize_arxiv_id, parse_arxiv_feed
from pat_worker.collectors.crossref import collect_crossref, crossref_item_to_paper
from pat_worker.collectors.nature import collect_nature, parse_nature_feed, source_id_for_url
from pat_worker.collectors.openalex import (
    author_from_payload,
    classify_venue,
    collect_openalex_works,
    decode_abstract,
    fetch_author,
    fetch_author_works,
    search_authors,
    work_from_payload,
    work_to_item,
)

__all__ = [
    "author_from_payload",
    "classify_venue",
    "collect_arxiv",
    "collect_crossref",
    "collect_nature",
    "collect_openalex_works",
    "crossref_item_to_paper",
    "decode_abstract",
    "fetch_author",
    "fetch_author_works",
    "normalize_arxiv_id",
    "parse_arxiv_feed",
    "parse_nature_feed",
    "search_authors",
    "source_id_for_url",
    "work_from_payload",
    "work_to_item",
]
