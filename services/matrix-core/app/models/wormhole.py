"""Wormhole 收据模型（architecture §5.2 / W2 规则）。

**铁律：服务端只存哈希与元数据，绝不存 payload 正文。**
本表连一个能装正文的列都没有——这是刻意的结构性保证：
即便有人误传 ``payload`` 也写不进来（见 services/wormhole.py 的显式拒绝）。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.clock import now
from app.db.base import Base, jsonb


class WormholeReceipt(Base):
    """一次虫洞投送的收据。"""

    __tablename__ = "wormhole_receipt"

    receipt_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    trace_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True)
    matrix_uid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    source_app: Mapped[str] = mapped_column(String(255), nullable=False)
    target_app: Mapped[str] = mapped_column(String(255), nullable=False)
    source_station: Mapped[str] = mapped_column(String(64), nullable=False)
    target_station: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # envelope.payload 的规范化 JSON 哈希（服务端只做完整性校验，不解读正文）
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # envelope.payload.data 的哈希：用于大载荷「只传引用」场景的二次校验
    payload_data_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    evidence_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 验证等级分布：Level_A_Verified / Level_B_Preprint / Retracted_Warning 的计数
    verification_levels: Mapped[dict] = mapped_column(jsonb(), nullable=False, default=dict)
    highest_verification_level: Mapped[str] = mapped_column(
        String(32), nullable=False, default="Level_B_Preprint"
    )
    # 目标站 manifest 的 accepts 命中情况（W3：只投给声明过的目标）
    target_accepts_declared: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    scope_used: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )

    __table_args__ = (
        Index("ix_wormhole_receipt_matrix_uid_created", "matrix_uid", "created_at"),
        Index("ix_wormhole_receipt_target_station", "target_station"),
    )
