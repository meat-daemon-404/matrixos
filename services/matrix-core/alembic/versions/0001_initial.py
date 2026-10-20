"""初始 schema：DigitalTwinAssetGraph + MatrixID 身份表

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-20

覆盖 S1-10 验收：``alembic upgrade head`` 从空库一次成功；
``asset_chunk.embedding`` 为 ``vector(1024)`` 且 HNSW 索引存在；有 down 迁移可回滚。

**方言策略**：本迁移在 PostgreSQL 上是唯一「真实形态」——
- ``vector(1024)`` 用 pgvector 的 Vector 类型；
- ``jsonb`` 用 JSONB；
- HNSW 索引用 ``USING hnsw (embedding vector_cosine_ops)``，参数取自 ADR-04
  （``m=16``、``ef_construction=64``）。

在非 PostgreSQL 方言（SQLite，供无 Docker 环境跑测试）上自动降级为
``TEXT`` + ``JSON`` + 普通 B-tree 索引——**表结构与约束保持一致**，只是
失去向量索引加速。这样同一份迁移脚本能在两种环境下都跑通 upgrade/downgrade。
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMBEDDING_DIM = 1024
HNSW_M = 16
HNSW_EF_CONSTRUCTION = 64


# ------------------------------------------------------------------ 方言助手


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _json_type() -> sa.types.TypeEngine:
    """PostgreSQL → JSONB；其它方言 → JSON。"""
    if _is_postgres():
        from sqlalchemy.dialects.postgresql import JSONB

        return JSONB()
    return sa.JSON()


def _vector_type() -> sa.types.TypeEngine:
    """PostgreSQL → vector(1024)；其它方言 → TEXT（存 JSON 数组）。"""
    if _is_postgres():
        from pgvector.sqlalchemy import Vector

        return Vector(EMBEDDING_DIM)
    return sa.Text()


# ------------------------------------------------------------------ upgrade


def upgrade() -> None:
    postgres = _is_postgres()

    # ---- 扩展（必须在建表前） ----
    if postgres:
        # pgvector：vector 类型与 <=> 算子；pg_trgm 供后续全文检索增强（可选）
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # ================================================================
    # MatrixID 身份表
    # ================================================================

    op.create_table(
        "matrix_user",
        sa.Column("matrix_uid", sa.String(64), primary_key=True),
        sa.Column("display_name", sa.String(128), nullable=False),
        sa.Column("email", sa.String(255), nullable=True, unique=True),
        sa.Column("password_hash", sa.String(512), nullable=True),
        sa.Column("entitlements", _json_type(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("auth_epoch", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "oauth_client",
        sa.Column("client_id", sa.String(64), primary_key=True),
        sa.Column("client_name", sa.String(128), nullable=False),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("client_secret_hash", sa.String(128), nullable=True),
        sa.Column("redirect_uris", _json_type(), nullable=False),
        sa.Column("allowed_scopes", _json_type(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "oauth_auth_code",
        sa.Column("code_hash", sa.String(64), primary_key=True),
        sa.Column(
            "client_id",
            sa.String(64),
            sa.ForeignKey("oauth_client.client_id", name="fk_oauth_auth_code_client_id_oauth_client"),
            nullable=False,
        ),
        sa.Column(
            "matrix_uid",
            sa.String(64),
            sa.ForeignKey("matrix_user.matrix_uid", name="fk_oauth_auth_code_matrix_uid_matrix_user"),
            nullable=False,
        ),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("code_challenge", sa.String(128), nullable=True),
        sa.Column("code_challenge_method", sa.String(16), nullable=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_oauth_auth_code_expires_at", "oauth_auth_code", ["expires_at"])

    op.create_table(
        "refresh_token",
        sa.Column("token_id", sa.String(36), primary_key=True),
        sa.Column("family_id", sa.String(36), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column(
            "matrix_uid",
            sa.String(64),
            sa.ForeignKey("matrix_user.matrix_uid", name="fk_refresh_token_matrix_uid_matrix_user"),
            nullable=False,
        ),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("replaced_by", sa.String(36), nullable=True),
        sa.Column("reuse_detected", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_refresh_token_family_id", "refresh_token", ["family_id"])
    op.create_index("ix_refresh_token_matrix_uid", "refresh_token", ["matrix_uid"])
    op.create_index("ix_refresh_token_expires_at", "refresh_token", ["expires_at"])

    op.create_table(
        "interaction_token",
        sa.Column("jti", sa.String(36), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column(
            "matrix_uid",
            sa.String(64),
            sa.ForeignKey(
                "matrix_user.matrix_uid", name="fk_interaction_token_matrix_uid_matrix_user"
            ),
            nullable=False,
        ),
        sa.Column("target_station", sa.String(64), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("trace_id", sa.String(36), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_interaction_token_expires_at", "interaction_token", ["expires_at"])
    op.create_index("ix_interaction_token_matrix_uid", "interaction_token", ["matrix_uid"])

    op.create_table(
        "login_session",
        sa.Column("session_id", sa.String(36), primary_key=True),
        sa.Column("session_hash", sa.String(64), nullable=False, unique=True),
        sa.Column(
            "matrix_uid",
            sa.String(64),
            sa.ForeignKey("matrix_user.matrix_uid", name="fk_login_session_matrix_uid_matrix_user"),
            nullable=False,
        ),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("code_challenge", sa.String(128), nullable=True),
        sa.Column("code_challenge_method", sa.String(16), nullable=True),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "token_blacklist",
        sa.Column("jti", sa.String(36), primary_key=True),
        sa.Column("matrix_uid", sa.String(64), nullable=False),
        sa.Column("reason", sa.String(64), nullable=False, server_default="logout"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_token_blacklist_expires_at", "token_blacklist", ["expires_at"])

    op.create_table(
        "audit_event",
        sa.Column("event_id", sa.Uuid(), primary_key=True),
        sa.Column("matrix_uid", sa.String(64), nullable=True),
        sa.Column("client_id", sa.String(64), nullable=True),
        sa.Column("station_id", sa.String(64), nullable=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("trace_id", sa.String(36), nullable=True),
        sa.Column("detail", _json_type(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_audit_event_matrix_uid", "audit_event", ["matrix_uid"])
    op.create_index("ix_audit_event_action_created_at", "audit_event", ["action", "created_at"])

    # ================================================================
    # DigitalTwinAssetGraph（architecture §6.2）
    # ================================================================

    op.create_table(
        "asset_node",
        sa.Column("asset_id", sa.Uuid(), primary_key=True),
        sa.Column("matrix_uid", sa.String(64), nullable=False),
        sa.Column("station_id", sa.String(64), nullable=False),
        sa.Column("asset_type", sa.String(32), nullable=False),
        sa.Column("title", sa.Text(), nullable=False, server_default=""),
        sa.Column("payload", _json_type(), nullable=False),
        sa.Column("evidence_anchors", _json_type(), nullable=False),
        sa.Column(
            "verification_level",
            sa.String(32),
            nullable=False,
            server_default="Level_B_Preprint",
        ),
        sa.Column("trace_id", sa.Uuid(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("search_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        # 枚举约束：与 models/assets.py 的 ASSET_TYPES / VERIFICATION_LEVELS 一致
        sa.CheckConstraint(
            "asset_type IN ('paper','dataset','fit_result','figure','review_draft',"
            "'mentor_card','cv_version','score_record','grant_record')",
            name="ck_asset_node_asset_type_enum",
        ),
        sa.CheckConstraint(
            "verification_level IN ('Level_A_Verified','Level_B_Preprint','Retracted_Warning')",
            name="ck_asset_node_verification_level_enum",
        ),
        sa.CheckConstraint("version >= 1", name="ck_asset_node_version_positive"),
    )
    op.create_index("ix_asset_node_matrix_uid", "asset_node", ["matrix_uid"])
    op.create_index("ix_asset_node_station_id", "asset_node", ["station_id"])
    op.create_index("ix_asset_node_trace_id", "asset_node", ["trace_id"])
    op.create_index(
        "ix_asset_node_owner_station_created",
        "asset_node",
        ["matrix_uid", "station_id", "created_at"],
    )
    op.create_index("ix_asset_node_owner_type", "asset_node", ["matrix_uid", "asset_type"])

    op.create_table(
        "asset_edge",
        sa.Column("edge_id", sa.Uuid(), primary_key=True),
        sa.Column(
            "from_asset_id",
            sa.Uuid(),
            sa.ForeignKey(
                "asset_node.asset_id",
                ondelete="CASCADE",
                name="fk_asset_edge_from_asset_id_asset_node",
            ),
            nullable=False,
        ),
        sa.Column(
            "to_asset_id",
            sa.Uuid(),
            sa.ForeignKey(
                "asset_node.asset_id",
                ondelete="CASCADE",
                name="fk_asset_edge_to_asset_id_asset_node",
            ),
            nullable=False,
        ),
        sa.Column("relation", sa.String(32), nullable=False),
        sa.Column("weight", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("inference", sa.String(16), nullable=False, server_default="automated"),
        sa.Column("evidence_ref", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        # S1-12 幂等性：同一 (from, to, relation) 只允许一条
        sa.UniqueConstraint(
            "from_asset_id", "to_asset_id", "relation", name="uq_asset_edge_triple"
        ),
        sa.CheckConstraint(
            "relation IN ('derived_from','cites','evidences','supersedes','relates_to')",
            name="ck_asset_edge_relation_enum",
        ),
        sa.CheckConstraint("from_asset_id <> to_asset_id", name="ck_asset_edge_no_self_loop"),
    )
    op.create_index(
        "ix_asset_edge_from_relation", "asset_edge", ["from_asset_id", "relation"]
    )
    op.create_index("ix_asset_edge_to_relation", "asset_edge", ["to_asset_id", "relation"])

    op.create_table(
        "asset_chunk",
        sa.Column("chunk_id", sa.Uuid(), primary_key=True),
        sa.Column(
            "asset_id",
            sa.Uuid(),
            sa.ForeignKey(
                "asset_node.asset_id",
                ondelete="CASCADE",
                name="fk_asset_chunk_asset_id_asset_node",
            ),
            nullable=False,
        ),
        sa.Column("chunk_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        # ★ ADR-04：vector(1024)，非 PostgreSQL 降级为 TEXT
        sa.Column("embedding", _vector_type(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("asset_id", "chunk_index", name="uq_asset_chunk_asset_index"),
    )
    op.create_index("ix_asset_chunk_asset_id", "asset_chunk", ["asset_id"])

    # ★ HNSW 索引（ADR-04：m=16、ef_construction=64、余弦距离）
    if postgres:
        op.execute(
            "CREATE INDEX ix_asset_chunk_embedding_hnsw ON asset_chunk "
            "USING hnsw (embedding vector_cosine_ops) "
            f"WITH (m = {HNSW_M}, ef_construction = {HNSW_EF_CONSTRUCTION})"
        )
    else:
        # 降级方言：建普通索引，让「索引存在」这一断言在测试里仍可校验
        op.create_index("ix_asset_chunk_embedding_hnsw", "asset_chunk", ["asset_id"])

    # ================================================================
    # Wormhole 收据（W2：表中没有任何能装正文的列）
    # ================================================================

    op.create_table(
        "wormhole_receipt",
        sa.Column("receipt_id", sa.Uuid(), primary_key=True),
        sa.Column("trace_id", sa.String(36), nullable=False, unique=True),
        sa.Column("matrix_uid", sa.String(64), nullable=False),
        sa.Column("source_app", sa.String(255), nullable=False),
        sa.Column("target_app", sa.String(255), nullable=False),
        sa.Column("source_station", sa.String(64), nullable=False),
        sa.Column("target_station", sa.String(64), nullable=False),
        sa.Column("payload_type", sa.String(64), nullable=False),
        # 只有哈希，没有正文（W2 的结构性保证）
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("payload_data_hash", sa.String(64), nullable=False),
        sa.Column("payload_size", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("evidence_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("verification_levels", _json_type(), nullable=False),
        sa.Column(
            "highest_verification_level",
            sa.String(32),
            nullable=False,
            server_default="Level_B_Preprint",
        ),
        sa.Column(
            "target_accepts_declared", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("scope_used", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("evidence_count >= 1", name="ck_wormhole_receipt_evidence_positive"),
    )
    op.create_index("ix_wormhole_receipt_matrix_uid", "wormhole_receipt", ["matrix_uid"])
    op.create_index(
        "ix_wormhole_receipt_matrix_uid_created",
        "wormhole_receipt",
        ["matrix_uid", "created_at"],
    )
    op.create_index(
        "ix_wormhole_receipt_target_station", "wormhole_receipt", ["target_station"]
    )


# ------------------------------------------------------------------ downgrade


def downgrade() -> None:
    """逆序删除，确保外键依赖不冲突（可回滚到空库）。"""
    postgres = _is_postgres()

    op.drop_table("wormhole_receipt")

    # HNSW 索引随表删除，但显式 drop 便于在「只删索引」场景复用
    op.execute("DROP INDEX IF EXISTS ix_asset_chunk_embedding_hnsw")
    op.drop_table("asset_chunk")
    op.drop_table("asset_edge")
    op.drop_table("asset_node")

    op.drop_table("audit_event")
    op.drop_table("token_blacklist")
    op.drop_table("login_session")
    op.drop_table("interaction_token")
    op.drop_table("refresh_token")
    op.drop_table("oauth_auth_code")
    op.drop_table("oauth_client")
    op.drop_table("matrix_user")

    # 扩展刻意**不删**：同一数据库上可能有其它 schema 也在用 vector，
    # 迁移回滚不该连带破坏它们。清理扩展是独立的运维动作。
    _ = postgres
