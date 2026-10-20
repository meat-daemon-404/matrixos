"""Wormhole envelope 的 Pydantic 契约。

**逐字段对齐 `specs/contracts/wormhole-envelope.schema.json`（已冻结）**：
- 6 个必填字段：trace_id / matrix_uid / source_app / target_app / payload_type / payload；
- ``additionalProperties: false`` → 这里用 ``extra="forbid"``；
- ``payload_type`` 为封闭枚举（5 值）；
- ``payload.evidence_anchors`` 至少 1 条（W1 规则）；
- ``verification_level`` 为 3 值枚举。

**不新增任何字段。** 大载荷引用走 ``payload.data`` 内部（schema 未约束其字段），
见 architecture §5.4——那是数据内部的自由 object，不是契约扩展。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 封闭枚举：不得擅自扩展（architecture §5.1）
PayloadType = Literal[
    "paper_doi_bundle",
    "comparison_matrix_row",
    "curve_fit_parameters",
    "mentor_match_card",
    "verified_cv_evidence",
]

VerificationLevel = Literal["Level_A_Verified", "Level_B_Preprint", "Retracted_Warning"]

VERIFICATION_LEVEL_ORDER: dict[str, int] = {
    "Level_B_Preprint": 1,
    "Level_A_Verified": 2,
    "Retracted_Warning": 3,
}


class EvidenceAnchor(BaseModel):
    """证据锚点：``additionalProperties: false``，只有 4 个字段。"""

    model_config = ConfigDict(extra="forbid")

    source_doi_or_url: str = Field(min_length=1)
    pdf_page: int | None = Field(default=None, ge=1)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    verification_level: VerificationLevel


class WormholePayload(BaseModel):
    """``payload``：数据 + 证据锚点，无其它字段。"""

    model_config = ConfigDict(extra="forbid")

    # schema 里是自由 object，因此这里也保持宽松 dict（不约束内部字段）
    data: dict = Field(default_factory=dict)
    evidence_anchors: list[EvidenceAnchor] = Field(min_length=1)

    @field_validator("evidence_anchors")
    @classmethod
    def _no_empty_anchor(cls, value: list[EvidenceAnchor]) -> list[EvidenceAnchor]:
        if not value:
            raise ValueError("evidence_anchors 至少需要 1 条（W1 规则）")
        return value


class WormholeEnvelope(BaseModel):
    """完整虫洞信封。服务端只用它做**校验与取哈希**，不落 payload 正文。"""

    model_config = ConfigDict(extra="forbid")

    trace_id: str = Field(description="UUID，与 HTTP X-Trace-Id / 日志 trace_id 同源")
    matrix_uid: str
    source_app: str = Field(min_length=1)
    target_app: str = Field(min_length=1)
    payload_type: PayloadType
    payload: WormholePayload
    created_at: str | None = None

    @field_validator("trace_id")
    @classmethod
    def _uuid_shape(cls, value: str) -> str:
        from app.core.tracing import is_uuid

        if not is_uuid(value):
            raise ValueError("trace_id 必须是 UUID")
        return value.lower()


class WormholeReceiptRequest(BaseModel):
    """`POST /v1/wormhole/receipt` 的请求体。

    **刻意不含 payload 正文字段**：调用方要么只传元数据（SDK 侧已本地校验信封），
    要么传完整 envelope（本服务只算哈希后丢弃）。传 ``payload`` 之外的正文键会被
    422 拒绝（见 services/wormhole.py 的显式检查）。
    """

    model_config = ConfigDict(extra="forbid")

    trace_id: str
    source_app: str = Field(min_length=1)
    target_app: str = Field(min_length=1)
    payload_type: PayloadType
    evidence_count: int = Field(ge=1, description="证据锚点条数（W1：至少 1）")
    # 必填：完整性校验需要哈希；SDK 侧算好后只传哈希，正文永不出浏览器
    payload_hash: str = Field(
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
        description="envelope.payload 的规范化 JSON 的 SHA-256（小写 hex）",
    )
    payload_size: int = Field(default=0, ge=0, le=64 * 1024 * 1024)
    verification_levels: dict[str, int] = Field(default_factory=dict)
    # 目标声明（W3：只投给 manifest 里 accepts 过的目标）
    target_accepts_payload_type: bool = True
    # 可选：完整信封（服务端复用其哈希做二次校验，但绝不入库正文）
    envelope: WormholeEnvelope | None = None

    @field_validator("trace_id")
    @classmethod
    def _uuid_shape(cls, value: str) -> str:
        from app.core.tracing import is_uuid

        if not is_uuid(value):
            raise ValueError("trace_id 必须是 UUID")
        return value.lower()


class WormholeReceiptResponse(BaseModel):
    """收据响应：只回元数据 + 一次性 mx_idt。"""

    receipt_id: str
    trace_id: str
    source_app: str
    target_app: str
    payload_type: str
    payload_hash: str
    evidence_count: int
    highest_verification_level: str
    created_at: str
    matrix_uid: str
    # iframe / 虫洞投送的一次性交换凭证（120 s），供目标站换 mx_at
    mx_idt: str
    mx_idt_expires_in: int


class WormholeReceiptPublic(BaseModel):
    """查询收据时的返回（**永不含 payload 正文**）。"""

    receipt_id: str
    trace_id: str
    matrix_uid: str
    source_app: str
    target_app: str
    source_station: str
    target_station: str
    payload_type: str
    payload_hash: str
    payload_data_hash: str
    payload_size: int
    evidence_count: int
    verification_levels: dict[str, int]
    highest_verification_level: str
    target_accepts_declared: bool
    created_at: str
