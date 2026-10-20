"""依赖注入装配（S1-06 的「依赖注入」验收项）。

所有 API 通过 ``Depends`` 获取：配置、数据库会话、令牌签发器、当前身份。
测试里通过 ``app.dependency_overrides`` 替换即可，无需 monkeypatch 全局。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.errors import ErrorCode, MatrixError
from app.core.security.keys import KeyStore
from app.core.security.tokens import TokenClaims, TokenError, TokenSigner, TokenInvalid
from app.db.session import Database, set_session


def settings_dep() -> Settings:
    return get_settings()


def get_database(request: Request) -> Database:
    database = getattr(request.app.state, "database", None)
    if database is None:  # pragma: no cover - 生命周期装配错误
        raise RuntimeError("Database 未在应用生命周期内初始化")
    return database


def get_key_store(request: Request) -> KeyStore:
    key_store = getattr(request.app.state, "key_store", None)
    if key_store is None:  # pragma: no cover
        raise RuntimeError("KeyStore 未在应用生命周期内初始化")
    return key_store


def get_token_signer(
    settings: Annotated[Settings, Depends(settings_dep)],
    key_store: Annotated[KeyStore, Depends(get_key_store)],
) -> TokenSigner:
    return TokenSigner(settings=settings, key_store=key_store)


async def get_session(
    database: Annotated[Database, Depends(get_database)],
) -> AsyncIterator[AsyncSession]:
    """每请求一个会话；异常自动回滚。"""
    async with database.session() as session:
        set_session(session)
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            set_session(None)


SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(settings_dep)]
SignerDep = Annotated[TokenSigner, Depends(get_token_signer)]
KeyStoreDep = Annotated[KeyStore, Depends(get_key_store)]
DatabaseDep = Annotated[Database, Depends(get_database)]


def extract_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


async def get_current_token(
    request: Request,
    signer: SignerDep,
    settings: SettingsDep,
    authorization: Annotated[str | None, Header()] = None,
) -> TokenClaims:
    """从 Authorization 头或 mx_at Cookie 取 access token 并校验。

    支持 Cookie 是因为非 iframe 场景走域级 Cookie（ADR-03）；iframe 场景由
    前端把 exchange 得到的 mx_at 放进 Authorization 头。
    """
    token = extract_bearer(authorization) or request.cookies.get(settings.access_cookie_name)
    if not token:
        raise MatrixError(
            ErrorCode.LOGIN_REQUIRED,
            "缺少访问令牌（Authorization: Bearer 或 mx_at Cookie）",
        )
    try:
        claims = signer.verify(token, expected_typ="mx_at")
    except TokenError as exc:
        raise matrix_error_for_token(exc) from exc
    return claims


def matrix_error_for_token(exc: TokenError) -> MatrixError:
    mapping = {
        "expired": ErrorCode.TOKEN_EXPIRED,
        "invalid": ErrorCode.TOKEN_INVALID,
        "type_mismatch": ErrorCode.TOKEN_TYPE_MISMATCH,
    }
    return MatrixError(
        mapping.get(exc.code, ErrorCode.TOKEN_INVALID),
        exc.message,
        headers={"WWW-Authenticate": "Bearer error=\"invalid_token\""},
    )


CurrentToken = Annotated[TokenClaims, Depends(get_current_token)]


async def get_optional_token(
    request: Request,
    signer: SignerDep,
    settings: SettingsDep,
    authorization: Annotated[str | None, Header()] = None,
) -> TokenClaims | None:
    """可选身份：用于 introspect 这类「匿名也可调但带身份更好」的端点。"""
    token = extract_bearer(authorization) or request.cookies.get(settings.access_cookie_name)
    if not token:
        return None
    try:
        return signer.verify(token, expected_typ="mx_at")
    except TokenError:
        return None


OptionalToken = Annotated[TokenClaims | None, Depends(get_optional_token)]
