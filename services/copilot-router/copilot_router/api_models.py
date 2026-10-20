"""FastAPI 传输层模型（仅协议校验与转换）。

刻意与领域模型分离（``types.py`` 用 dataclass）：
- 领域逻辑可在未安装 FastAPI 的环境里测试（ADR-11 要求单测 ≥ 70%）；
- 协议演进（OpenAI 兼容字段增删）不会污染路由/计费/合规逻辑。

兼容性说明：
- ``model`` 支持标准 OpenAI 语义（具体模型名）与 MatrixOS 扩展（``auto`` /
  ``tier-01``..``tier-04`` / ``flash|pro|local``）；
- 标准字段 ``messages`` / ``temperature`` / ``max_tokens`` / ``stream`` / ``user``
  照常工作，不要求调用方知道 MatrixOS 的扩展；
- ``matrix`` 是可选扩展对象，缺失时拿不到用户归属（会记到 ``anonymous``）。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .types import ChatMessage, ChatRequest, MatrixHints, SensitivityVerdict


class MessageModel(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: Literal["system", "user", "assistant", "tool"] = "user"
    content: str = ""

    @field_validator("content", mode="before")
    @classmethod
    def _coerce_content(cls, value: Any) -> str:
        """兼容 OpenAI 的多段 content（list of {type,text}）。

        只取 text 段，图片等非文本段忽略并留空 —— 本服务的四级模型都是文本模型，
        静默丢弃图片比报错更危险，因此这里保留原文的可见性：
        非文本段会被替换成占位标记，让上游模型知道「这里原本有非文本内容」。
        """
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts: list[str] = []
            for item in value:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    if item.get("type") == "text" and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                    else:
                        parts.append(f"[unsupported content part: {item.get('type', 'unknown')}]")
            return "".join(parts)
        return str(value)


class MatrixHintsModel(BaseModel):
    """MatrixOS 扩展字段。"""

    model_config = ConfigDict(extra="forbid")

    matrix_uid: str | None = Field(default=None, max_length=128)
    station_id: str | None = Field(
        default=None,
        description="7 站生涯闭环节点，与 dispatch-contract.schema.json 的 enum 一致",
        pattern="^(study|spark|pat_hot|xingmen|workshop|cloud_balance|pre_job)$",
    )
    task_type: str | None = Field(default=None, max_length=64)
    sensitivity: SensitivityVerdict | None = None
    user_triggered: bool = Field(
        default=False, description="降级 ③：用户显式主动触发长文本任务"
    )
    allow_cross_user_cache: bool = Field(
        default=True, description="是否允许本请求结果进入跨用户共享缓存（仅公共问题生效）"
    )


class ChatCompletionRequest(BaseModel):
    """OpenAI 兼容的请求体 + MatrixOS 扩展。"""

    model_config = ConfigDict(extra="allow")

    model: str = "auto"
    messages: list[MessageModel] = Field(min_length=1)
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1)
    stream: bool = False
    user: str | None = Field(default=None, description="OpenAI 标准 user 字段，作为 matrix_uid 的兜底")
    matrix: MatrixHintsModel | None = None

    def to_domain(self, *, trace_id: str | None = None) -> ChatRequest:
        matrix = self.matrix or MatrixHintsModel()
        uid = matrix.matrix_uid or self.user
        return ChatRequest(
            messages=[ChatMessage(role=m.role, content=m.content) for m in self.messages],
            model=self.model,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            matrix=MatrixHints(
                matrix_uid=uid,
                station_id=matrix.station_id,
                task_type=matrix.task_type,
                sensitivity=matrix.sensitivity,
                user_triggered=matrix.user_triggered,
                allow_cross_user_cache=matrix.allow_cross_user_cache,
            ),
            trace_id=trace_id,
        )


class UsageQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    matrix_uid: str
