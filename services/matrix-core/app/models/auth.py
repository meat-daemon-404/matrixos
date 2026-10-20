"""身份相关 ORM 模型（S1-08 / S1-09）。

安全约定：
- 授权码、refresh token、mx_idt 一律**只存 SHA-256 哈希**，明文不落库；
- refresh token 属「轮转族」（family），一次使用即作废；重放触发整族失效；
- access token 的 ``jti`` 进黑名单表，配合用户级 ``auth_epoch`` 实现 logout-all。
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
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
from app.db.base import Base, jsonb


class MatrixUser(Base):
    """MatrixID 用户（全域唯一身份）。"""

    __tablename__ = "matrix_user"

    matrix_uid: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    # 兜底凭据体系（校园 CAS 未接通时用邮箱+密码，见 S1-03e）
    password_hash: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # 授权能力（entitlements）：供 /v1/auth/userinfo 返回，决定默认 scope 上限
    entitlements: Mapped[list[str]] = mapped_column(jsonb(), nullable=False, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # 全局登出计数器：access token 内携带 epoch，与库内不一致即整体失效
    auth_epoch: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now
    )


class OAuthClient(Base):
    """注册的 OAuth2 客户端（官方微站 / hub / 第三方实验室站）。"""

    __tablename__ = "oauth_client"

    client_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_name: Mapped[str] = mapped_column(String(128), nullable=False)
    # 公共客户端（iframe 内微站）不持有 secret，强制 PKCE
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    client_secret_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    redirect_uris: Mapped[list[str]] = mapped_column(jsonb(), nullable=False, default=list)
    allowed_scopes: Mapped[list[str]] = mapped_column(jsonb(), nullable=False, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OAuthAuthCode(Base):
    """授权码：一次性、短效（默认 5 min），绑定 PKCE challenge。"""

    __tablename__ = "oauth_auth_code"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), ForeignKey("oauth_client.client_id"))
    matrix_uid: Mapped[str] = mapped_column(String(64), ForeignKey("matrix_user.matrix_uid"))
    redirect_uri: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False, default="")
    code_challenge: Mapped[str | None] = mapped_column(String(128), nullable=True)
    code_challenge_method: Mapped[str | None] = mapped_column(String(16), nullable=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 原子性标记：非空即已被兑换，二次兑换直接拒绝
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (Index("ix_oauth_auth_code_expires_at", "expires_at"),)


class RefreshToken(Base):
    """refresh token（mx_rt）：轮转族 + 重放检测。"""

    __tablename__ = "refresh_token"

    token_id: Mapped[str] = mapped_column(String(36), primary_key=True)  # jti
    family_id: Mapped[str] = mapped_column(String(36), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    matrix_uid: Mapped[str] = mapped_column(String(64), ForeignKey("matrix_user.matrix_uid"))
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False, default="")
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    replaced_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 重放被检测到时置 true，用于审计与告警
    reuse_detected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        Index("ix_refresh_token_family_id", "family_id"),
        Index("ix_refresh_token_matrix_uid", "matrix_uid"),
        Index("ix_refresh_token_expires_at", "expires_at"),
    )

    children: Mapped[list["RefreshToken"]] = relationship(
        "RefreshToken",
        primaryjoin="RefreshToken.replaced_by == RefreshToken.token_id",
        foreign_keys="RefreshToken.replaced_by",
        viewonly=True,
        uselist=False,
    )


class InteractionToken(Base):
    """mx_idt：iframe / 虫洞一次性交换凭证（120 s）。"""

    __tablename__ = "interaction_token"

    jti: Mapped[str] = mapped_column(String(36), primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    matrix_uid: Mapped[str] = mapped_column(String(64), ForeignKey("matrix_user.matrix_uid"))
    target_station: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False, default="")
    trace_id: Mapped[str] = mapped_column(String(36), nullable=False)
    payload_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_interaction_token_expires_at", "expires_at"),
        Index("ix_interaction_token_matrix_uid", "matrix_uid"),
    )


class LoginSession(Base):
    """统一登录页的短时会话（授权码流程的前半段）。"""

    __tablename__ = "login_session"

    session_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    matrix_uid: Mapped[str] = mapped_column(String(64), ForeignKey("matrix_user.matrix_uid"))
    client_id: Mapped[str] = mapped_column(String(64), nullable=False)
    redirect_uri: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False, default="")
    code_challenge: Mapped[str | None] = mapped_column(String(128), nullable=True)
    code_challenge_method: Mapped[str | None] = mapped_column(String(16), nullable=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class TokenBlacklist(Base):
    """jti 黑名单：登出 / 吊销单个 access token。"""

    __tablename__ = "token_blacklist"

    jti: Mapped[str] = mapped_column(String(36), primary_key=True)
    matrix_uid: Mapped[str] = mapped_column(String(64), nullable=False)
    reason: Mapped[str] = mapped_column(String(64), nullable=False, default="logout")
    # 过期后可安全清理（access token 最长 15 min，留足余量）
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    __table_args__ = (Index("ix_token_blacklist_expires_at", "expires_at"),)


class AuditEvent(Base):
    """审计流水：登录、签发、轮转、重放、资产写入、虫洞收据。

    只记元数据，绝不记 token 明文与 payload 正文（W2 规则）。
    """

    __tablename__ = "audit_event"

    event_id: Mapped[str] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    matrix_uid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    station_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    trace_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    detail: Mapped[dict] = mapped_column(jsonb(), nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    __table_args__ = (
        Index("ix_audit_event_matrix_uid", "matrix_uid"),
        Index("ix_audit_event_action_created_at", "action", "created_at"),
        UniqueConstraint("event_id", name="uq_audit_event_event_id"),
    )
