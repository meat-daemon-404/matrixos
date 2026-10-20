"""编排层：采集 → 归并 → 打分 → 选卡 → 落库。"""

from pat_worker.pipeline.brief import (
    BriefBuildResult,
    ScoredCandidate,
    compose_brief,
    heat_level,
    score_candidates,
    select_cards,
)
from pat_worker.pipeline.merge import MergedPaper, merge_items
from pat_worker.pipeline.runner import (
    BuildOutcome,
    CollectOutcome,
    apply_dedupe,
    build_daily_brief,
    collect_all,
    filter_window,
    regenerate_brief_for_date,
    summarize_outcome,
)

__all__ = [
    "BriefBuildResult",
    "BuildOutcome",
    "CollectOutcome",
    "MergedPaper",
    "ScoredCandidate",
    "apply_dedupe",
    "build_daily_brief",
    "collect_all",
    "compose_brief",
    "filter_window",
    "heat_level",
    "merge_items",
    "regenerate_brief_for_date",
    "score_candidates",
    "select_cards",
    "summarize_outcome",
]
