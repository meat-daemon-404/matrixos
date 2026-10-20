"""请求/响应领域模型。

刻意不依赖 FastAPI 的 pydantic 传输模型：领域模型用 dataclass，
这样 ``routing`` / ``billing`` / ``sensitivity`` / ``budget`` 等模块
可以在**没有安装 FastAPI 的环境里被直接 import 与单测**
（ADR-11 要求 copilot-router 单测 ≥ 70%，领域逻辑必须可独立测试）。

FastAPI 的 pydantic 模型定义在 ``api_models.py``，只做协议校验与转换。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Role = Literal["system", "user", "assistant", "tool"]
#: 契约档位 —— 与 specs/contracts/dispatch-contract.schema.json 的 model_tier 枚举一致（3 档）
ContractTier = Literal["flash", "pro", "local"]
#: 内部档位 —— 需求文档的 4 级 TIER（01/02 都映射到契约档 flash）
TierId = Literal["tier-01", "tier-02", "tier-03", "tier-04"]
#: 敏感数据判定结果
SensitivityVerdict = Literal["clean", "restricted", "blocked"]


@dataclass(slots=True)
class ChatMessage:
    role: Role
    content: str

    def to_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass(slots=True)
class MatrixHints:
    """MatrixOS 扩展字段（请求体 ``matrix`` 对象）。

    这是一个**可选**扩展，不破坏 OpenAI 兼容性：标准的 ``model`` / ``messages``
    / ``temperature`` 等字段照常工作，只是缺少 ``matrix`` 时拿不到用户归属、
    站内上下文与敏感度声明。
    """

    matrix_uid: str | None = None
    station_id: str | None = None
    task_type: str | None = None
    #: 客户端自报敏感度（只会被「取更严格者」采纳，不能用来降低判定）
    sensitivity: SensitivityVerdict | None = None
    #: 降级 ③：用户显式主动触发长文本任务
    user_triggered: bool = False
    #: 用户显式声明「本请求可跨用户共享缓存」（仅对公共问题有意义）
    allow_cross_user_cache: bool = True


@dataclass(slots=True)
class ChatRequest:
    messages: list[ChatMessage]
    model: str = "auto"
    temperature: float = 0.2
    max_tokens: int | None = None
    matrix: MatrixHints = field(default_factory=MatrixHints)
    #: 便于日志与跨服务追踪（架构 §8 要求 trace_id 贯穿）
    trace_id: str | None = None

    def prompt_text(self) -> str:
        """拼接全部消息文本，供敏感识别与缓存归一化使用。"""
        return "\n".join(f"{m.role}: {m.content}" for m in self.messages)


@dataclass(slots=True)
class SensitivityFinding:
    """单条敏感规则命中。

    刻意**不记录命中的原文片段** —— 命中内容本身是敏感数据，
    留痕只需规则 ID 与类别即可满足审计（架构 §8 审计要求）。
    """

    rule_id: str
    name: str
    category: str
    severity: Literal["block", "warn"]
    reason: str
    score: float


@dataclass(slots=True)
class SensitivityResult:
    verdict: SensitivityVerdict
    findings: list[SensitivityFinding] = field(default_factory=list)
    #: 判定是否强制本地（verdict == blocked 或 restricted）
    force_local: bool = False
    #: 是否允许结果进入跨用户共享缓存
    cache_shareable: bool = True

    @property
    def matched_rule_ids(self) -> list[str]:
        return [f.rule_id for f in self.findings]

    @property
    def blocked(self) -> bool:
        return self.verdict == "blocked"


@dataclass(slots=True)
class TokenUsage:
    prompt_tokens: int
    completion_tokens: int

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass(slots=True)
class CostBreakdown:
    tier_id: str
    model: str
    price_input_per_million: float
    price_output_per_million: float
    prompt_tokens: int
    completion_tokens: int
    input_cost: float
    output_cost: float

    @property
    def total_cost(self) -> float:
        return round(self.input_cost + self.output_cost, 8)


@dataclass(slots=True)
class RouteDecision:
    """路由结果 —— 一次决策的完整可解释快照（用于审计与测试断言）。"""

    tier_id: TierId
    contract_tier: ContractTier
    model: str
    task_type: str
    #: 决策来源：explicit_tier | explicit_task | heuristic | default | sensitivity_forced
    decided_by: str
    prompt_tokens: int
    length_bucket: str
    reason: str
    #: 因敏感数据被强制改判到本地
    forced_local_by_sensitivity: bool = False


@dataclass(slots=True)
class DegradeDecision:
    """降级决策（软闸）。level 0 表示未降级。"""

    level: int = 0
    notices: list[str] = field(default_factory=list)
    #: 因降级被改判到的档位（None = 不改判）
    reroute_to: str | None = None
    #: 降级是否要求用户显式触发长文本
    require_manual_trigger: bool = False

    @property
    def degraded(self) -> bool:
        return self.level > 0


@dataclass(slots=True)
class ChatResult:
    """网关处理结果（纯领域对象，与 HTTP 无关）。"""

    content: str
    decision: RouteDecision
    usage: TokenUsage
    cost: CostBreakdown
    provider: str
    cache_hit: bool = False
    cache_kind: str | None = None  # exact | similar | public_identifier
    coalesced: bool = False  # 是否由 similar-request 合并（single-flight）返回
    degrade: DegradeDecision = field(default_factory=DegradeDecision)
    sensitivity: SensitivityResult | None = None
    trace_id: str | None = None
    latency_ms: float = 0.0
    #: token 数是否为估算（上游未返回 usage 时用估算兜底）—— 诚实标注，不假装精确
    tokens_estimated: bool = False
