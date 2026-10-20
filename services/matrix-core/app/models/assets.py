"""DigitalTwinAssetGraph 的 ORM 模型（S1-10 / S1-11 / S1-12）。

表结构与 architecture §6.2 逐字段对齐（**不擅自加业务字段**）：

- asset_node：主表，含 matrix_uid / station_id / asset_type / title / payload /
  evidence_anchors / verification_level / trace_id / version；
- asset_edge：图边，relation ∈ derived_from | cites | evidences | supersedes | relates_to；
- asset_chunk：向量分片，embedding vector(1024) + HNSW 索引。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.clock import now
from app.db.base import Base, VectorType, jsonb

# asset_type 枚举：与 architecture §6.2 完全一致，不得擅自扩展（ADR-10：加类型要走契约流程）
ASSET_TYPES: tuple[str, ...] = (
    "paper",
    "dataset",
    "fit_result",
    "figure",
    "review_draft",
    "mentor_card",
    "cv_version",
    "score_record",
    "grant_record",
)

VERIFICATION_LEVELS: tuple[str, ...] = (
    "Level_A_Verified",
    "Level_B_Preprint",
    "Retracted_Warning",
)

# architecture §6.2：5 种关系。边推断（S1-12）只自动产出前三种
EDGE_RELATIONS: tuple[str, ...] = (
    "derived_from",
    "cites",
    "evidences",
    "supersedes",
    "relates_to",
)
INFERRED_RELATIONS: tuple[str, ...] = ("derived_from", "cites", "evidences")


class AssetNode(Base):
    """资产节点（图的主表）。"""

    __tablename__ = "asset_node"

    asset_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    matrix_uid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    station_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    asset_type: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False, default="")
    payload: Mapped[dict] = mapped_column(jsonb(), nullable=False, default=dict)
    evidence_anchors: Mapped[list] = mapped_column(jsonb(), nullable=False, default=list)
    verification_level: Mapped[str] = mapped_column(
        String(32), nullable=False, default="Level_B_Preprint"
    )
    trace_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # 检索用的正文（由 payload/title 派生的可读文本），不对外返回正文以外的语义
    search_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now, nullable=False
    )

    chunks: Mapped[list["AssetChunk"]] = relationship(
        back_populates="asset", cascade="all, delete-orphan", lazy="selectin"
    )

    __table_args__ = (
        # 常用查询：某人某站按时间倒序
        Index("ix_asset_node_owner_station_created", "matrix_uid", "station_id", "created_at"),
        Index("ix_asset_node_owner_type", "matrix_uid", "asset_type"),
        Index("ix_asset_node_trace_id", "trace_id"),
    )


class AssetEdge(Base):
    """资产图谱边：多跳溯源的载体（Supersedes 等关系不自动推断）。"""

    __tablename__ = "asset_edge"

    edge_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    from_asset_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("asset_node.asset_id", ondelete="CASCADE"), nullable=False
    )
    to_asset_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("asset_node.asset_id", ondelete="CASCADE"), nullable=False
    )
    relation: Mapped[str] = mapped_column(String(32), nullable=False, default="relates_to")
    weight: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    # 推断来源（automated / manual）与置信度说明，便于审计「这条边凭什么存在」
    inference: Mapped[str] = mapped_column(String(16), nullable=False, default="automated")
    evidence_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )

    from_asset: Mapped["AssetNode"] = relationship(foreign_keys=[from_asset_id], lazy="joined")
    to_asset: Mapped["AssetNode"] = relationship(foreign_keys=[to_asset_id], lazy="joined")

    __table_args__ = (
        # 幂等性（S1-12 验收）：同一 (from, to, relation) 只允许一条边
        UniqueConstraint(
            "from_asset_id", "to_asset_id", "relation", name="uq_asset_edge_triple"
        ),
        CheckConstraint(
            "relation IN ('derived_from','cites','evidences','supersedes','relates_to')",
            name="relation_enum",
        ),
        CheckConstraint("from_asset_id <> to_asset_id", name="no_self_loop"),
        Index("ix_asset_edge_from_relation", "from_asset_id", "relation"),
        Index("ix_asset_edge_to_relation", "to_asset_id", "relation"),
    )


class AssetChunk(Base):
    """向量检索分片：embedding 为 vector(1024)，HNSW 余弦索引。"""

    __tablename__ = "asset_chunk"

    chunk_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("asset_node.asset_id", ondelete="CASCADE"), nullable=False
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    embedding: Mapped[list[float] | None] = mapped_column(VectorType(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )

    asset: Mapped["AssetNode"] = relationship(back_populates="chunks")

    __table_args__ = (
        UniqueConstraint("asset_id", "chunk_index", name="uq_asset_chunk_asset_index"),
        Index("ix_asset_chunk_asset_id", "asset_id"),
    )
