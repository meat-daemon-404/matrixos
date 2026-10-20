"""领域计算层：纯函数、无 I/O、可用固定输入精确单测。"""

from pat_worker.domain.fit import FitResult, score_fit
from pat_worker.domain.heat import (
    HEAT_ALGORITHM_VERSION,
    WEIGHTS,
    HeatBreakdown,
    PaperSignal,
    heat_level,
    score_heat,
)
from pat_worker.domain.mentor import (
    DIMENSIONS,
    AuthorRecord,
    Dimension,
    MentorProfile,
    WorkRecord,
    build_mentor_profile,
    h_index_from_citations,
    h_index_series,
)

__all__ = [
    "DIMENSIONS",
    "HEAT_ALGORITHM_VERSION",
    "WEIGHTS",
    "AuthorRecord",
    "Dimension",
    "FitResult",
    "HeatBreakdown",
    "MentorProfile",
    "PaperSignal",
    "WorkRecord",
    "build_mentor_profile",
    "h_index_from_citations",
    "h_index_series",
    "heat_level",
    "score_fit",
    "score_heat",
]
