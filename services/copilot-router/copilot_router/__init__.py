"""MatrixOS copilot-router —— 四级大模型混部路由与成本控制网关。

分层（便于在没有 FastAPI 的环境里单独测试领域逻辑）::

    api.py            ← FastAPI 传输层（唯一 import fastapi 的地方）
    gateway.py        ← 编排：敏感识别 → 路由 → 熔断/降级 → 缓存 → Provider → 记账
    routing.py        ← 四级路由决策
    sensitivity.py    ← 敏感数据识别（合规红线）
    budget.py         ← 成本熔断（硬闸）
    degradation.py    ← R-T05 三级降级（软闸）
    cache.py          ← 相似请求合并
    billing.py        ← 成本台账
    providers/        ← DeepSeek / Qwen / 本地 LoRA 统一适配层
    config.py         ← 读取 config/tiers.yaml

依据文档：
    docs/01-plan/01-architecture.md §3.3（copilot-router 职责边界）
    docs/01-plan/04-tech-decisions.md ADR-06（模型分级路由）
    docs/01-plan/05-risks.md R-T05（成本目标风险与缓解措施）
    docs/00-analysis/02-requirements.md §6（模型分级矩阵与预算）
"""

from .config import RouterConfig, load_config
from .errors import (
    BudgetExceededError,
    ComplianceEgressError,
    ConfigError,
    CopilotError,
    InvalidRequestError,
    NoProviderAvailableError,
    UpstreamError,
)
from .gateway import CopilotGateway
from .types import ChatMessage, ChatRequest

__all__ = [
    "BudgetExceededError",
    "ChatMessage",
    "ChatRequest",
    "ComplianceEgressError",
    "ConfigError",
    "CopilotError",
    "CopilotGateway",
    "InvalidRequestError",
    "NoProviderAvailableError",
    "RouterConfig",
    "UpstreamError",
    "load_config",
]

__version__ = "0.1.0"
