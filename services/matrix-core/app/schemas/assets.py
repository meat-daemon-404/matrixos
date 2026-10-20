"""资产图谱的请求/响应契约（S1-11 / S1-12）。

字段严格对齐 architecture §6.2 的 asset_node / asset_edge / asset_chunk，
不擅自增删业务字段。
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.assets import ASSET_TYPES, EDGE_RELATIONS, VERIFICATION_LEVELS

AssetType = Literal[
    "paper",
    "dataset",
    "fit_result",
    "figure",
    "review_draft",
    "mentor_card",
    "cv_version",
    "score_record",
    "grant_record",
]
VerificationLevel = Literal["Level_A_Verified", "Level_B_Preprint", "Retracted_Warning"]
EdgeRelation = Literal["derived_from", "cites", "evidences", "supersedes", "relates_to"]


class EvidenceAnchorIn(BaseModel):
    """与 Wormhole envelope 同构的证据锚点（architecture §6.2）。"""

    model_config = ConfigDict(extra="forbid")

    source_doi_or_url: str = Field(min_length=1)
    pdf_page: int | None = Field(default=None, ge=1)
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    verification_level: VerificationLevel


class AssetCreateRequest(BaseModel):
    """POST /v1/assets。"""

    model_config = ConfigDict(extra="forbid")

    station_id: str = Field(description="产生该资产的微站 site_key，如 curvelab")
    asset_type: AssetType
    title: str = ""
    payload: dict = Field(default_factory=dict)
    evidence_anchors: list[EvidenceAnchorIn] = Field(default_factory=list)
    verification_level: VerificationLevel = "Level_B_Preprint"
    trace_id: str | None = Field(default=None, description="溯源到虫洞投送的 trace_id")

    # 注意：这里**刻意不做** evidence_anchors 非空校验。
    #
    # 原因（2026-10-20 实测）：FastAPI 在把请求体绑定到 `payload` 参数时就会跑
    # Pydantic 校验，**早于**路由函数体内的 `assert_can_write` 权限检查。
    # 如果在这里拒绝空锚点，会得到「无权用户收到 422 而非 403」——
    # 即权限检查被数据校验抢先，既泄露了「这个字段有约束」的信息，
    # 也让「越权必须先 403」这条安全语义失守。
    #
    # 合规红线校验因此下沉到 service 层（app/services/assets.py 的
    # create_asset），在 scope 检查之后执行。见 tests/test_asset_redline.py。

    @field_validator("evidence_anchors")
    @classmethod
    def _level_consistency(cls, value: list[EvidenceAnchorIn]) -> list[EvidenceAnchorIn]:
        """占位：逐条锚点的形状由 EvidenceAnchorIn 自身保证。

        非空校验不在这里——见上方注释与 service 层实现。
        """
        return value


class AssetUpdateRequest(BaseModel):
    """PATCH /v1/assets/{asset_id}：乐观锁通过 expected_version 表达。"""

    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    payload: dict | None = None
    evidence_anchors: list[EvidenceAnchorIn] | None = None
    verification_level: VerificationLevel | None = None
    expected_version: int | None = Field(
        default=None, ge=1, description="期望的当前版本；不匹配返回 409"
    )
    trace_id: str | None = None


class AssetChunkOut(BaseModel):
    chunk_id: str
    chunk_index: int
    content: str
    # 不返回向量本体（体积大且无展示价值），只标记是否存在
    has_embedding: bool


class AssetOut(BaseModel):
    """资产节点对外视图。"""

    asset_id: str
    matrix_uid: str
    station_id: str
    asset_type: str
    title: str
    payload: dict
    evidence_anchors: list[dict]
    verification_level: str
    trace_id: str | None = None
    version: int
    created_at: str
    updated_at: str
    chunk_count: int = 0


class AssetDetailOut(AssetOut):
    chunks: list[AssetChunkOut] = Field(default_factory=list)
    # 一跳邻居（可在 2 跳内做溯源，见 S1-12 验收）
    edges_out: list["AssetEdgeOut"] = Field(default_factory=list)
    edges_in: list["AssetEdgeOut"] = Field(default_factory=list)


class AssetEdgeOut(BaseModel):
    edge_id: str
    from_asset_id: str
    to_asset_id: str
    relation: str
    weight: float
    inference: str = "automated"
    evidence_ref: str | None = None
    created_at: str


class AssetListResponse(BaseModel):
    items: list[AssetOut]
    total: int
    limit: int
    offset: int


class SearchRequest(BaseModel):
    """POST /v1/assets/search：pgvector 语义检索。"""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=8000)
    top_k: int = Field(default=10, ge=1, le=50)
    station_ids: list[str] | None = Field(
        default=None, description="限定来源站；None = 全部有 read 权限的站"
    )
    asset_types: list[AssetType] | None = None
    min_score: float = Field(default=0.0, ge=0.0, le=1.0)
    include_shared: bool = Field(
        default=False, description="是否包含同组只读资产（预留，Stage 2 打开）"
    )


class SearchHit(BaseModel):
    asset_id: str
    chunk_id: str
    chunk_index: int
    content: str
    score: float = Field(description="余弦相似度，1.0 为最相似")
    station_id: str
    asset_type: str
    title: str
    matrix_uid: str
    verification_level: str


class SearchResponse(BaseModel):
    query: str
    top_k: int
    hits: list[SearchHit]
    total_candidates: int
    embedding_model: str


class EdgeCreateRequest(BaseModel):
    """POST /v1/assets/{asset_id}/edges：手工补边（自动化只产 3 类，见 S1-12）。"""

    model_config = ConfigDict(extra="forbid")

    to_asset_id: str
    relation: EdgeRelation
    weight: float = Field(default=1.0, ge=0.0, le=1.0)
    evidence_ref: str | None = None


class EdgeInferenceRequest(BaseModel):
    """POST /v1/assets/graph/infer：对当前用户资产跑一次边推断（幂等）。"""

    model_config = ConfigDict(extra="forbid")

    station_ids: list[str] | None = None
    asset_ids: list[str] | None = None
    dry_run: bool = False


class EdgeInferenceResponse(BaseModel):
    scanned_assets: int
    created_edges: int
    skipped_existing: int
    relations: dict[str, int]
    dry_run: bool
    trace_id: str


class TracePathNode(BaseModel):
    asset_id: str
    asset_type: str
    title: str
    station_id: str
    verification_level: str


class TracePath(BaseModel):
    """一次溯源路径（S1-12 验收：拟合结果 → 2 跳内找到论文与证据锚点）。"""

    hops: int
    nodes: list[TracePathNode]
    relations: list[str]
    evidence_anchors: list[dict]


class TraceResponse(BaseModel):
    asset_id: str
    max_hops: int
    paths: list[TracePath]


def _validate_enums() -> None:
    """确保 schemas 里的 Literal 与 models 的枚举常量一致（防漂移）。"""
    assert set(AssetType.__args__) == set(ASSET_TYPES)  # type: ignore[attr-defined]
    assert set(VerificationLevel.__args__) == set(VERIFICATION_LEVELS)  # type: ignore[attr-defined]
    assert set(EdgeRelation.__args__) == set(EDGE_RELATIONS)  # type: ignore[attr-defined]


_validate_enums()


AssetDetailOut.model_rebuild()
