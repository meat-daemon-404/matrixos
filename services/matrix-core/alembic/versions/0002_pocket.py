"""口袋端持久化：micro_goal / checkin_record / mentor_reminder / queue_item

Revision ID: 0002_pocket
Revises: 0001_initial
Create Date: 2026-10-20

覆盖 WBS `S2-17`~`S2-20` 的服务端半边：小程序的 13 个 `/v1/pocket/*` 端点从
「纯前端 mock」变成真实落库，手机推入的待办桌面读得到。

**方言策略与 0001 一致**：PostgreSQL 上 `jsonb`，其它方言降级为 `JSON`，
表结构与约束保持不变，同一份脚本在两种环境下都能 upgrade/downgrade。

枚举约束一律用**单引号** SQL 字面量。双引号串在 SQLite 里恰好被当字符串接受
（于是本地测试全绿），但 PostgreSQL 会解析成标识符并在迁移当天报错——
「测试方言宽松、生产方言炸」是本项目刻意要消除的一类差异。
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_pocket"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _json_type() -> sa.types.TypeEngine:
    """PostgreSQL → JSONB；其它方言 → JSON。"""
    if _is_postgres():
        from sqlalchemy.dialects.postgresql import JSONB

        return JSONB()
    return sa.JSON()


def _in_sql(column: str, values: Sequence[str]) -> str:
    literals = ", ".join("'" + value.replace("'", "''") + "'" for value in values)
    return f"{column} IN ({literals})"


GOAL_KINDS = ("study", "research", "desktop")
QUEUE_STATUSES = ("pending", "claimed", "done")
QUEUE_ORIGINS = ("morning_card", "checkin_goal", "manual")
MENTOR_STAGES = (
    "email_sent",
    "email_read",
    "interview_scheduled",
    "interview_passed",
    "joined",
)
PAYLOAD_TYPES = (
    "paper_doi_bundle",
    "comparison_matrix_row",
    "curve_fit_parameters",
    "mentor_match_card",
    "verified_cv_evidence",
)


# ------------------------------------------------------------------ upgrade


def upgrade() -> None:
    op.create_table(
        "micro_goal",
        sa.Column("goal_id", sa.Uuid(), primary_key=True),
        sa.Column("matrix_uid", sa.String(64), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("kind", sa.String(16), nullable=False, server_default="study"),
        sa.Column("target", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(_in_sql("kind", GOAL_KINDS), name="ck_micro_goal_kind_enum"),
    )
    op.create_index("ix_micro_goal_matrix_uid", "micro_goal", ["matrix_uid"])
    op.create_index("ix_micro_goal_owner_kind", "micro_goal", ["matrix_uid", "kind"])

    op.create_table(
        "checkin_record",
        sa.Column("checkin_id", sa.Uuid(), primary_key=True),
        sa.Column(
            "goal_id",
            sa.Uuid(),
            sa.ForeignKey(
                "micro_goal.goal_id",
                ondelete="CASCADE",
                name="fk_checkin_record_goal_id_micro_goal",
            ),
            nullable=False,
        ),
        sa.Column("matrix_uid", sa.String(64), nullable=False),
        # YYYY-MM-DD（UTC）。用字符串而非 Date：两种方言的时区语义不一致，
        # 而 streak 计算本质是日期集合运算，字符串比较在两侧都成立。
        sa.Column("checkin_date", sa.String(10), nullable=False),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("goal_id", "checkin_date", name="uq_checkin_record_goal_date"),
    )
    op.create_index("ix_checkin_record_goal_id", "checkin_record", ["goal_id"])
    op.create_index("ix_checkin_record_matrix_uid", "checkin_record", ["matrix_uid"])
    op.create_index(
        "ix_checkin_record_owner_date", "checkin_record", ["matrix_uid", "checkin_date"]
    )

    op.create_table(
        "mentor_reminder",
        sa.Column("reminder_id", sa.Uuid(), primary_key=True),
        sa.Column("matrix_uid", sa.String(64), nullable=False),
        sa.Column("mentor_name", sa.String(128), nullable=False),
        sa.Column("mentor_title", sa.String(64), nullable=False, server_default=""),
        sa.Column("lab", sa.String(255), nullable=False, server_default=""),
        sa.Column("stage", sa.String(32), nullable=False, server_default="email_sent"),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("location", sa.Text(), nullable=False, server_default=""),
        sa.Column("read_receipt", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledged", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("match_score", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("evidence_anchors", _json_type(), nullable=False),
        sa.Column("outline", _json_type(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            _in_sql("stage", MENTOR_STAGES), name="ck_mentor_reminder_stage_enum"
        ),
        sa.CheckConstraint(
            "match_score >= 0 AND match_score <= 100",
            name="ck_mentor_reminder_match_score_range",
        ),
    )
    op.create_index("ix_mentor_reminder_matrix_uid", "mentor_reminder", ["matrix_uid"])
    op.create_index(
        "ix_mentor_reminder_owner_stage", "mentor_reminder", ["matrix_uid", "stage"]
    )

    op.create_table(
        "morning_dismissal",
        sa.Column("matrix_uid", sa.String(64), nullable=False),
        sa.Column("card_id", sa.String(64), nullable=False),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("matrix_uid", "card_id", name="pk_morning_dismissal"),
    )

    op.create_table(
        "queue_item",
        sa.Column("item_id", sa.Uuid(), primary_key=True),
        sa.Column("matrix_uid", sa.String(64), nullable=False),
        sa.Column("origin", sa.String(32), nullable=False, server_default="manual"),
        sa.Column("origin_ref", sa.String(128), nullable=False, server_default=""),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("target_station", sa.String(64), nullable=False),
        sa.Column("desktop_action", sa.Text(), nullable=False, server_default=""),
        sa.Column("payload_type", sa.String(64), nullable=False),
        # W1：锚点是引用元数据，不含正文（与 wormhole_receipt 的 W2 口径一致）
        sa.Column("evidence_anchors", _json_type(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_app", sa.String(255), nullable=False, server_default=""),
        sa.Column("payload_hash", sa.String(64), nullable=False, server_default=""),
        sa.Column("receipt_id", sa.String(36), nullable=False, server_default=""),
        # 幂等的结构性保证：并发重推由数据库拦，不靠应用层「先查再插」的竞态
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("idempotency_key", name="uq_queue_item_idempotency_key"),
        sa.CheckConstraint(
            _in_sql("status", QUEUE_STATUSES), name="ck_queue_item_status_enum"
        ),
        sa.CheckConstraint(
            _in_sql("origin", QUEUE_ORIGINS), name="ck_queue_item_origin_enum"
        ),
        sa.CheckConstraint(
            _in_sql("payload_type", PAYLOAD_TYPES), name="ck_queue_item_payload_type_enum"
        ),
    )
    op.create_index("ix_queue_item_matrix_uid", "queue_item", ["matrix_uid"])
    op.create_index(
        "ix_queue_item_owner_status_created",
        "queue_item",
        ["matrix_uid", "status", "created_at"],
    )


# ------------------------------------------------------------------ downgrade


def downgrade() -> None:
    # 逆序删除：checkin_record 外键引用 micro_goal，必须先删子表
    op.drop_table("queue_item")
    op.drop_table("morning_dismissal")
    op.drop_table("mentor_reminder")
    op.drop_table("checkin_record")
    op.drop_table("micro_goal")
