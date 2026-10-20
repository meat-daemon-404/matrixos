"""口袋端（微信小程序伴侣）的 ORM 模型（WBS S2-17~S2-20 的服务端半边）。

**为什么这些表存在**：口袋端的 13 个 `/v1/pocket/*` 端点此前全是前端 mock，
数据不落库，所以「手机推一条待办 → 桌面 2s 内出现」这条双端协同链路根本无法验证。
本模块把它变成真实持久化：手机写入的行，桌面用同一个 `matrix_uid` 读得到。

**与 W2 铁律的关系（重要）**：`QueueItem` 存的是**元数据与证据锚点**
（DOI / 页码 / 验证等级），**不存 payload 正文**——正文仍由浏览器端 P2P 传递，
这里只留 `payload_hash` 做完整性对账。这与 `wormhole_receipt` 表刻意不设正文列
是同一个约束（见 `app/models/wormhole.py`）。锚点本身是引用而非正文，
`asset_node.evidence_anchors` 早已这么存，口径一致。

表设计取舍：
- `micro_goal` 与 `checkin_record` 拆开：目标是长期实体，打卡是「某天某目标」的事实，
  这样 POST/DELETE 可逆且天然幂等（重复打卡同一天同目标不产生第二条记录）。
- 日期一律存 `String(10)`（`YYYY-MM-DD`，UTC）而不是 Date 列：SQLite/PostgreSQL
  对 Date 的时区处理不一致，字符串比较在两侧都成立，且 streak 计算就是集合运算。
- `idempotency_key` 唯一约束是推送幂等的**结构性保证**：并发重推由数据库拦，
  不靠「先查再插」的应用层竞态。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.clock import now
from app.db.base import Base, jsonb

# 与 apps/wechat-pocket/miniprogram/api/types.ts 的闭枚举逐字对齐，不得擅自扩展。
GOAL_KINDS: tuple[str, ...] = ("study", "research", "desktop")

QUEUE_STATUSES: tuple[str, ...] = ("pending", "claimed", "done")

QUEUE_ORIGINS: tuple[str, ...] = ("morning_card", "checkin_goal", "manual")

# MentorStage：五态状态机，只允许前进一步（见 services/pocket.py 的跃迁表）
MENTOR_STAGES: tuple[str, ...] = (
    "email_sent",
    "email_read",
    "interview_scheduled",
    "interview_passed",
    "joined",
)

PAYLOAD_TYPES: tuple[str, ...] = (
    "paper_doi_bundle",
    "comparison_matrix_row",
    "curve_fit_parameters",
    "mentor_match_card",
    "verified_cv_evidence",
)

# 学期累计打卡的目标天数（云衡综测里的「学业惯性」指标，与口袋端 UI 的分母一致）
TERM_TARGET_DAYS = 60


def _in_sql(column: str, values: tuple[str, ...]) -> str:
    """渲染 `col IN ('a','b')`。

    必须用**单引号**字面量：Python 的 `repr` 在元素含单引号时会改用双引号，
    SQLite 恰好接受双引号串（所以本地测试全绿），但 PostgreSQL 会把 `"x"` 当成
    **标识符**，迁移直接报错。本仓库所有枚举约束都走这个函数，
    杜绝「测试方言宽松、生产方言炸」的差异。
    """
    literals = ", ".join("'" + value.replace("'", "''") + "'" for value in values)
    return f"{column} IN ({literals})"


class MicroGoal(Base):
    """学业微目标本体（长期实体）。某天的完成与否在 `checkin_record`。"""

    __tablename__ = "micro_goal"

    goal_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    matrix_uid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="study")
    # 目标态文案，如「2 篇」/「1 组」
    target: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )

    __table_args__ = (
        CheckConstraint(_in_sql("kind", GOAL_KINDS), name="ck_micro_goal_kind_enum"),
        Index("ix_micro_goal_owner_kind", "matrix_uid", "kind"),
    )


class CheckinRecord(Base):
    """「某目标在某一天完成了」这一事实。DELETE 即取消打卡（可逆）。"""

    __tablename__ = "checkin_record"

    checkin_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    goal_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("micro_goal.goal_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    matrix_uid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # YYYY-MM-DD（UTC）。唯一约束天然防重复打卡。
    checkin_date: Mapped[str] = mapped_column(String(10), nullable=False)
    done_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("goal_id", "checkin_date", name="uq_checkin_record_goal_date"),
        Index("ix_checkin_record_owner_date", "matrix_uid", "checkin_date"),
    )


class MentorReminder(Base):
    """星门导师进组提醒（与 lab-kanban 的 `已发信→已读→待面试→已进组` 同源）。"""

    __tablename__ = "mentor_reminder"

    reminder_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    matrix_uid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    mentor_name: Mapped[str] = mapped_column(String(128), nullable=False)
    mentor_title: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    lab: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    stage: Mapped[str] = mapped_column(String(32), nullable=False, default="email_sent")
    # 面试/事件开始时刻
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
    location: Mapped[str] = mapped_column(Text, nullable=False, default="")
    read_receipt: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    acknowledged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # 五维星象仪给出的匹配度 0-100
    match_score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 导师代表作锚点（引用，不是正文）
    evidence_anchors: Mapped[list] = mapped_column(jsonb(), nullable=False, default=list)
    # 3 页口头答辩提纲：[{page,title,points[]}]
    outline: Mapped[list] = mapped_column(jsonb(), nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now, nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            _in_sql("stage", MENTOR_STAGES),
            name="ck_mentor_reminder_stage_enum",
        ),
        CheckConstraint(
            "match_score >= 0 AND match_score <= 100",
            name="ck_mentor_reminder_match_score_range",
        ),
        Index("ix_mentor_reminder_owner_stage", "matrix_uid", "stage"),
    )


class MorningDismissal(Base):
    """早报卡「已忽略」事实。

    卡 id 由「uid + 日期 + 序号」确定性派生（见 services/pocket.py），
    所以忽略状态能跨刷新存活——这正是 `types.ts` 里
    「稳定用于已忽略去重」的服务端落点。

    复合主键 `(matrix_uid, card_id)` 本身就是去重保证，
    因此不再另加 UniqueConstraint；服务层可直接 `session.get(…, (uid, card))`。
    """

    __tablename__ = "morning_dismissal"

    matrix_uid: Mapped[str] = mapped_column(String(64), primary_key=True)
    card_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    dismissed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )


class QueueItem(Base):
    """桌面待办队列条目：手机推入、桌面认领/完成。"""

    __tablename__ = "queue_item"

    item_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    matrix_uid: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    origin: Mapped[str] = mapped_column(String(32), nullable=False, default="manual")
    # 来源引用 id（哪张早报卡 / 哪个目标）
    origin_ref: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    title: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # 完成后要唤醒的桌面微站 site_key（如 `matrix-cross`）
    target_station: Mapped[str] = mapped_column(String(64), nullable=False)
    desktop_action: Mapped[str] = mapped_column(Text, nullable=False, default="")
    payload_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # W1：证据不可为空，锚点落库（引用元数据，不含正文）
    evidence_anchors: Mapped[list] = mapped_column(jsonb(), nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 投送来源站点（用于落虫洞收据）
    source_app: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # 元数据哈希：与 wormhole_receipt.payload_hash 对账
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    # 收据号（wormhole_receipt.receipt_id）；没走虫洞时为空串
    receipt_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    # 幂等键：同一 key 重复推送复用同一条目与同一收据
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            _in_sql("status", QUEUE_STATUSES),
            name="ck_queue_item_status_enum",
        ),
        CheckConstraint(
            _in_sql("origin", QUEUE_ORIGINS),
            name="ck_queue_item_origin_enum",
        ),
        CheckConstraint(
            _in_sql("payload_type", PAYLOAD_TYPES),
            name="ck_queue_item_payload_type_enum",
        ),
        # 「claimed 才有 claimed_at」这类一致性交给服务层断言：
        # SQLite 的 CheckConstraint 对 NULL 比较的行为与 PostgreSQL 有差异，
        # 写进 DDL 反而会造成两种方言下约束强弱不一致的假安全感。
        Index("ix_queue_item_owner_status_created", "matrix_uid", "status", "created_at"),
    )
