"""openalex-pat-worker —— MatrixOS 04 站 PAT-HOT 与 06 站星门的数据面服务。

分层（只允许上层依赖下层）：

    api/         FastAPI 路由与依赖注入，不含业务规则
    pipeline/    编排：采集 → 归并 → 打分 → 选卡 → 合成早报
    collectors/  单源采集器，各自负责该源的礼貌池参数与响应解析
    domain/      纯计算：热度算法、五维画像、关键词契合度。无 I/O
    store/       SQLite 持久化：已读回执、早报归档、导师缓存
    http/        限速、重试、缓存、礼貌池 UA 的统一出站客户端

`domain/` 是唯一允许写「公式」的地方，且必须保持纯函数，便于单测。
"""

from pat_worker.domain.heat import HEAT_ALGORITHM_VERSION, HeatBreakdown, score_heat
from pat_worker.domain.mentor import MentorProfile, build_mentor_profile
from pat_worker.settings import Settings, get_settings

__all__ = [
    "HEAT_ALGORITHM_VERSION",
    "HeatBreakdown",
    "MentorProfile",
    "Settings",
    "build_mentor_profile",
    "get_settings",
    "score_heat",
]

__version__ = "0.1.0"
