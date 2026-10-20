"""错误类型与 HTTP 状态码映射。

设计原则：**超限必须返回明确错误，而不是静默降级**（任务书第 3 条 + ADR-06）。
因此每个错误都带稳定的机器可读 ``code``，供 18 个微站做分支处理。
"""

from __future__ import annotations

from typing import Any


class CopilotError(Exception):
    """所有本服务错误的基类。

    ``code`` 是稳定的机器可读标识，微站按它分支，不按 message 文案分支。
    ``status_code`` 是 HTTP 状态码。
    """

    code: str = "copilot_error"
    status_code: int = 500

    def __init__(
        self,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        """OpenAI 兼容的错误外壳：{"error": {...}}。"""
        payload: dict[str, Any] = {
            "message": self.message,
            "type": self.code,
            "code": self.code,
        }
        if self.details:
            payload["details"] = self.details
        return {"error": payload}


class ConfigError(CopilotError):
    """config/tiers.yaml 缺失、格式错误或自相矛盾。"""

    code = "config_error"
    status_code = 500


class InvalidRequestError(CopilotError):
    """请求体不合法（缺字段、超长、未知档位等）。"""

    code = "invalid_request_error"
    status_code = 400


class BudgetExceededError(CopilotError):
    """成本熔断触发 —— 硬闸。

    这是「明确错误」而非「静默降级」的兑现：微站拿到 402 后应当向用户
    展示真实原因，而不是假装成功。
    """

    code = "budget_exceeded"
    status_code = 402


class ComplianceEgressError(CopilotError):
    """合规红线：敏感数据被阻止发往云端，且本地模型不可用。

    这种情况下**宁可失败也不上云**（ADR-05 / R-R02 兜底策略）。
    """

    code = "compliance_egress_blocked"
    status_code = 451


class NoProviderAvailableError(CopilotError):
    """该档位下所有可用 Provider 均不可用（含熔断短路）。"""

    code = "no_provider_available"
    status_code = 503


class UpstreamError(CopilotError):
    """上游模型返回错误。"""

    code = "upstream_error"
    status_code = 502


class LongTextManualTriggerRequiredError(CopilotError):
    """降级 ③：长文本任务需用户主动触发（R-T05 缓解措施排序的第三档）。"""

    code = "manual_trigger_required"
    status_code = 429
