"""``/v1/auth/*`` 路由（S1-06 / S1-08 / S1-09）。

端点清单：
- ``GET  /authorize``    授权码流起点（校验 client/redirect/scope → 发 code）
- ``POST /login``        统一登录页提交（兜底凭据体系）→ 登录会话 + Cookie
- ``POST /token``        authorization_code / refresh_token 兑换
- ``POST /refresh``      显式 refresh（等价于 token 的 refresh_token grant）
- ``POST /introspect``   RFC 7662，供微站校验
- ``POST /exchange``     mx_idt → mx_at（iframe 场景）
- ``POST /idt``          hub 主动签发 mx_idt（非虫洞的普通 iframe 打开）
- ``GET  /userinfo``     最小身份信息
- ``POST /logout``       单令牌登出（拉黑 jti）
- ``POST /logout-all``   全局登出（推进 epoch + 吊销全部 refresh）
- ``GET  /jwks``         公钥集（供微站本地验签）
- ``GET  /sites``        已知站点清单（SDK 构建 scope 用）
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Cookie, Query, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse

from app.api.deps import SessionDep, SettingsDep, SignerDep
from app.api.security import IdentityDep
from app.core.config import Settings
from app.core.errors import ErrorCode, MatrixError
from app.core.sites import known_site_keys
from app.core.tracing import get_trace_id
from app.schemas.auth import (
    AuthorizeQuery,
    ExchangeRequest,
    ExchangeResponse,
    IdtIssueRequest,
    IdtIssueResponse,
    IntrospectRequest,
    IntrospectResponse,
    JwksResponse,
    LoginRequest,
    LogoutResponse,
    RefreshRequest,
    TokenExchangeRequest,
    TokenResponse,
    UserInfoResponse,
)
from app.services import auth as auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


# ------------------------------------------------------------------ 帮助


def _set_session_cookies(
    response: Response, settings: Settings, *, access: str, refresh: str
) -> None:
    """写域级 Cookie（ADR-03：``Domain=.matrixos.edu``，HttpOnly）。

    iframe 场景不依赖这两个 Cookie（走 mx_idt 交换），因此即使第三方 Cookie
    被浏览器拦截，鉴权仍然可用。
    """
    common = {
        "domain": settings.cookie_domain or None,
        "secure": settings.cookie_secure,
        "samesite": settings.cookie_samesite,
        "httponly": True,
    }
    response.set_cookie(
        settings.access_cookie_name,
        access,
        max_age=settings.access_token_ttl_seconds,
        path="/",
        **common,
    )
    response.set_cookie(
        settings.refresh_cookie_name,
        refresh,
        max_age=settings.refresh_token_ttl_seconds,
        # 路径限定：refresh 只在 /v1/auth 下发送（减少暴露面）
        path=f"{settings.api_prefix}/auth",
        **common,
    )


def _token_response(issued: auth_service.IssuedTokens) -> TokenResponse:
    return TokenResponse(
        access_token=issued.access_token,
        token_type="Bearer",
        expires_in=issued.expires_in,
        refresh_token=issued.refresh_token,
        refresh_expires_in=issued.refresh_expires_in,
        scope=issued.scope,
        matrix_uid=issued.matrix_uid,
        station_id=issued.station_id,
    )


def _scope_list(raw: str | None) -> list[str]:
    return [item for item in (raw or "").replace(",", " ").split() if item]


# ------------------------------------------------------------------ authorize


@router.get("/authorize", summary="OAuth2 授权码：校验 client/redirect/scope 后签发一次性 code")
async def authorize(
    session: SessionDep,
    settings: SettingsDep,
    response_type: Annotated[str, Query(pattern="^code$")] = "code",
    client_id: Annotated[str, Query()] = "",
    redirect_uri: Annotated[str, Query()] = "",
    scope: Annotated[str, Query()] = "",
    state: Annotated[str | None, Query()] = None,
    code_challenge: Annotated[str | None, Query()] = None,
    code_challenge_method: Annotated[str | None, Query()] = None,
    mx_sess: Annotated[str | None, Cookie(alias="mx_sess")] = None,
) -> JSONResponse:
    """授权码流前端。

    「已登录」由登录会话 Cookie ``mx_sess`` 表达（由 ``/login`` 写入）。
    没有会话时返回 401 并指向登录页，而不是静默降级——避免
    「以为登录了其实没登录」这类最难排查的故障。
    """
    _ = AuthorizeQuery(
        response_type=response_type,
        client_id=client_id,
        redirect_uri=redirect_uri,
        scope=scope,
        state=state,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
    )
    client = await auth_service.get_client(session, client_id)
    auth_service.validate_redirect_uri(client, redirect_uri)

    login_session = await auth_service.resolve_login_session(session, raw=mx_sess)
    if login_session is None:
        raise MatrixError(
            ErrorCode.LOGIN_REQUIRED,
            f"未登录或登录会话已过期，请先 POST {settings.api_prefix}/auth/login",
        )

    user = await auth_service.get_user(session, login_session.matrix_uid)
    code = await auth_service.create_authorization_code(
        session,
        settings=settings,
        client=client,
        user=user,
        redirect_uri=redirect_uri,
        requested_scope=_scope_list(scope) or _scope_list(login_session.scope),
        code_challenge=code_challenge or login_session.code_challenge,
        code_challenge_method=code_challenge_method
        or login_session.code_challenge_method,
    )
    await session.commit()
    return JSONResponse({"code": code, "state": state, "redirect_uri": redirect_uri})


@router.post(
    "/authorize/redirect",
    summary="登录页提交后发码并 302 回客户端（浏览器直跳路径）",
    response_class=RedirectResponse,
)
async def authorize_redirect(
    session: SessionDep,
    settings: SettingsDep,
    payload: LoginRequest,
) -> RedirectResponse:
    """一条龙：校验凭据 → 建登录会话 → 发码 → 302 带 code 与 state 回客户端。"""
    client = await auth_service.get_client(session, payload.client_id)
    auth_service.validate_redirect_uri(client, payload.redirect_uri)
    user = await auth_service.authenticate(
        session, email=payload.email, password=payload.password
    )
    await auth_service.create_login_session(
        session,
        settings=settings,
        user=user,
        client_id=client.client_id,
        redirect_uri=payload.redirect_uri,
        scope=payload.scope,
        code_challenge=payload.code_challenge,
        code_challenge_method=payload.code_challenge_method,
    )
    code = await auth_service.create_authorization_code(
        session,
        settings=settings,
        client=client,
        user=user,
        redirect_uri=payload.redirect_uri,
        requested_scope=_scope_list(payload.scope),
        code_challenge=payload.code_challenge,
        code_challenge_method=payload.code_challenge_method,
    )
    await session.commit()

    separator = "&" if "?" in payload.redirect_uri else "?"
    location = f"{payload.redirect_uri}{separator}code={code}"
    if payload.state:
        location += f"&state={payload.state}"
    return RedirectResponse(location, status_code=status.HTTP_302_FOUND)


@router.post(
    "/login",
    summary="统一登录页：校验凭据 → 登录会话 Cookie（+ 可选直接发令牌）",
    response_model=None,
)
async def login(
    session: SessionDep,
    settings: SettingsDep,
    signer: SignerDep,
    payload: LoginRequest,
    response: Response,
    issue_tokens: Annotated[bool, Query(description="true = 直接返回令牌（同源简化路径）")] = False,
) -> Response:
    """兜底凭据登录（校园 CAS 未接通时）。

    默认只建立登录会话并写 ``mx_sess`` Cookie，随后由 ``/authorize`` 发码 ——
    这是标准授权码流。``issue_tokens=true`` 时直接签发令牌，供 hub 自身
    （同源页面）省掉一次往返。
    """
    client = await auth_service.get_client(session, payload.client_id)
    auth_service.validate_redirect_uri(client, payload.redirect_uri)
    user = await auth_service.authenticate(
        session, email=payload.email, password=payload.password
    )
    raw_session = await auth_service.create_login_session(
        session,
        settings=settings,
        user=user,
        client_id=client.client_id,
        redirect_uri=payload.redirect_uri,
        scope=payload.scope,
        code_challenge=payload.code_challenge,
        code_challenge_method=payload.code_challenge_method,
    )

    body: dict[str, object] = {
        "matrix_uid": user.matrix_uid,
        "display_name": user.display_name,
        "login_session_expires_in": settings.login_session_ttl_seconds,
    }

    if issue_tokens:
        issued = await auth_service.issue_tokens(
            session,
            settings=settings,
            signer=signer,
            user=user,
            client_id=client.client_id,
            scope=_scope_list(payload.scope)
            or auth_service.default_scope_for_user(user, _station_of(client)),
        )
        _set_session_cookies(
            response, settings, access=issued.access_token, refresh=issued.refresh_token
        )
        body["tokens"] = _token_response(issued).model_dump()

    await session.commit()
    response.set_cookie(
        settings.session_cookie_name,
        raw_session,
        max_age=settings.login_session_ttl_seconds,
        domain=settings.cookie_domain or None,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        httponly=True,
        path="/",
    )
    return JSONResponse(body)


def _station_of(client: object) -> str:
    from app.models.auth import OAuthClient

    assert isinstance(client, OAuthClient)
    return auth_service._station_from_client(client)


# ------------------------------------------------------------------ token / refresh


@router.post(
    "/token", summary="令牌端点：authorization_code 或 refresh_token", response_model=TokenResponse
)
async def token(
    session: SessionDep,
    settings: SettingsDep,
    signer: SignerDep,
    payload: TokenExchangeRequest,
    response: Response,
) -> TokenResponse:
    if payload.grant_type == "authorization_code":
        if not payload.code:
            raise MatrixError(ErrorCode.INVALID_GRANT, "缺少 code")
        if not payload.client_id:
            raise MatrixError(ErrorCode.INVALID_GRANT, "缺少 client_id")
        record = await auth_service.consume_authorization_code(
            session,
            code=payload.code,
            client_id=payload.client_id,
            redirect_uri=payload.redirect_uri,
            code_verifier=payload.code_verifier,
        )
        user = await auth_service.get_user(session, record.matrix_uid)
        issued = await auth_service.issue_tokens(
            session,
            settings=settings,
            signer=signer,
            user=user,
            client_id=record.client_id,
            scope=record.scope,
            station_id=auth_service._station_for_scope(_scope_list(record.scope)),
        )
    else:
        if not payload.refresh_token:
            raise MatrixError(ErrorCode.INVALID_GRANT, "缺少 refresh_token")
        issued = await auth_service.rotate_refresh_token(
            session, settings=settings, signer=signer, raw_refresh_token=payload.refresh_token
        )

    _set_session_cookies(
        response, settings, access=issued.access_token, refresh=issued.refresh_token
    )
    await session.commit()
    return _token_response(issued)


@router.post(
    "/refresh", summary="refresh 轮转（一次性；重放触发整族失效）", response_model=TokenResponse
)
async def refresh(
    session: SessionDep,
    settings: SettingsDep,
    signer: SignerDep,
    response: Response,
    payload: RefreshRequest | None = None,
    mx_rt: Annotated[str | None, Cookie(alias="mx_rt")] = None,
) -> TokenResponse:
    """接受两种来源：请求体 ``refresh_token`` 或 ``mx_rt`` Cookie。"""
    raw = (payload.refresh_token if payload else None) or mx_rt
    if not raw:
        raise MatrixError(ErrorCode.INVALID_GRANT, "缺少 refresh_token")
    issued = await auth_service.rotate_refresh_token(
        session, settings=settings, signer=signer, raw_refresh_token=raw
    )
    _set_session_cookies(
        response, settings, access=issued.access_token, refresh=issued.refresh_token
    )
    await session.commit()
    return _token_response(issued)


# ------------------------------------------------------------------ introspect / exchange


@router.post(
    "/introspect", summary="RFC 7662：微站校验令牌并读取能力", response_model=IntrospectResponse
)
async def introspect(
    session: SessionDep,
    signer: SignerDep,
    payload: IntrospectRequest,
) -> IntrospectResponse:
    """令牌无效时返回 ``active: false``（RFC 7662 语义），不抛错。

    这样调用方（微站）只需看 ``active`` 字段，无需区分 401 与 200。
    """
    data = await auth_service.introspect_token(
        session, signer=signer, token=payload.token, audience=payload.audience
    )
    return IntrospectResponse(**data)


@router.post(
    "/exchange",
    summary="用 mx_idt 换 mx_at（iframe 场景核心机制，S1-09）",
    response_model=ExchangeResponse,
)
async def exchange(
    session: SessionDep,
    settings: SettingsDep,
    signer: SignerDep,
    payload: ExchangeRequest,
) -> ExchangeResponse:
    """一次性：同一 mx_idt 二次交换返回 401（``auth.idt_already_used``）。"""
    issued = await auth_service.exchange_idt(
        session,
        settings=settings,
        signer=signer,
        mx_idt=payload.mx_idt,
        station_id=payload.station_id,
    )
    await session.commit()
    return ExchangeResponse(
        access_token=issued.access_token,
        token_type="Bearer",
        expires_in=issued.expires_in,
        scope=issued.scope,
        matrix_uid=issued.matrix_uid,
        station_id=issued.station_id or "",
        trace_id=get_trace_id(),
    )


@router.post(
    "/idt",
    summary="hub 主动签发 mx_idt（打开普通 iframe 微站时的一次性身份交接）",
    response_model=IdtIssueResponse,
)
async def issue_idt_endpoint(
    session: SessionDep,
    settings: SettingsDep,
    signer: SignerDep,
    identity: IdentityDep,
    payload: IdtIssueRequest,
) -> IdtIssueResponse:
    """需要已登录身份（mx_at），且只能为自己签发。"""
    trace = payload.trace_id or get_trace_id()
    mx_idt, ttl = await auth_service.issue_idt(
        session,
        settings=settings,
        signer=signer,
        matrix_uid=identity.matrix_uid,
        target_station=payload.target_station,
        scope=payload.scope or None,
        trace_id=trace,
    )
    await session.commit()
    return IdtIssueResponse(
        mx_idt=mx_idt,
        expires_in=ttl,
        target_station=payload.target_station,
        trace_id=trace,
    )


# ------------------------------------------------------------------ userinfo / logout / jwks


@router.get("/userinfo", summary="最小身份信息（hub 首页展示）", response_model=UserInfoResponse)
async def userinfo(session: SessionDep, identity: IdentityDep) -> UserInfoResponse:
    """走 ``IdentityDep`` 而非裸 ``CurrentToken``：登出后必须立即失效。

    只验签是不够的——jti 黑名单与 ``auth_epoch`` 是「登出真的生效」的唯一凭据，
    ``assert_access_token_live`` 才会去查它们。
    """
    user = identity.user
    return UserInfoResponse(
        matrix_uid=user.matrix_uid,
        display_name=user.display_name,
        entitlements=list(user.entitlements or []),
        scope=identity.scope,
        station_id=identity.station_id,
        epoch=user.auth_epoch,
    )


@router.post("/logout", summary="单令牌登出（jti 进黑名单）", response_model=LogoutResponse)
async def logout(
    session: SessionDep,
    settings: SettingsDep,
    identity: IdentityDep,
    response: Response,
    mx_sess: Annotated[str | None, Cookie(alias="mx_sess")] = None,
) -> LogoutResponse:
    await auth_service.logout_access_token(session, identity.claims)
    await auth_service.drop_login_session(session, raw=mx_sess)
    await session.commit()
    _clear_cookies(response, settings)
    return LogoutResponse(revoked=1, message="已登出")


@router.post(
    "/logout-all",
    summary="全局登出：推进 epoch 使全部 mx_at 失效并吊销所有 refresh",
    response_model=LogoutResponse,
)
async def logout_all(
    session: SessionDep,
    settings: SettingsDep,
    identity: IdentityDep,
    response: Response,
) -> LogoutResponse:
    user = identity.user
    revoked = await auth_service.logout_all(session, user)
    await session.commit()
    _clear_cookies(response, settings)
    return LogoutResponse(revoked=revoked, epoch=user.auth_epoch, message="已全局登出")


def _clear_cookies(response: Response, settings: Settings) -> None:
    domain = settings.cookie_domain or None
    for name, path in (
        (settings.access_cookie_name, "/"),
        (settings.refresh_cookie_name, f"{settings.api_prefix}/auth"),
        (settings.session_cookie_name, "/"),
    ):
        response.delete_cookie(name, domain=domain, path=path)


@router.get("/jwks", summary="JWKS：供微站本地验签", response_model=JwksResponse)
async def jwks(request: Request) -> JwksResponse:
    key_store = getattr(request.app.state, "key_store", None)
    if key_store is None:  # pragma: no cover - 生命周期错误
        raise MatrixError(ErrorCode.INTERNAL, "密钥仓库未初始化")
    return JwksResponse(keys=key_store.public_jwks().get("keys", []))


@router.get("/sites", summary="已知站点清单（SDK 构建 scope 用）")
async def sites() -> dict[str, list[str]]:
    return {"site_keys": sorted(known_site_keys())}
