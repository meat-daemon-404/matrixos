"""MatrixID 授权服务：OAuth2 授权码流 + JWT 签/验 + refresh 轮转 + jti 黑名单。

对应验收（S1-08）：
1. 完整授权码流程可端到端跑通；
2. refresh 重放被拒绝，并**触发 token family 失效**（整族作废）；
3. mx_at = 15 min，mx_rt = 30 d 滑动；
4. 密钥轮转时旧公钥保留窗口内仍可验签（KeyStore.public_key_for）。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import now, plus_seconds, ts_of
from app.core.config import Settings
from app.core.errors import ErrorCode, MatrixError
from app.core.security.crypto import (
    hash_secret,
    new_family_id,
    new_jti,
    random_token,
    verify_pkce,
)
from app.core.security.passwords import hash_password, needs_rehash, verify_password
from app.core.security.scopes import (
    has_station_scope,
    normalize_scope,
    parse_scope,
    scopes_for_station,
    validate_scope_request,
)
from app.core.security.tokens import (
    TOKEN_TYPE_ACCESS,
    TOKEN_TYPE_IDT,
    TOKEN_TYPE_REFRESH,
    TokenClaims,
    TokenError,
    TokenSigner,
)
from app.core.sites import HUB_SITE_KEY, known_site_keys, site_key_of_domain
from app.core.tracing import get_trace_id
from app.models.auth import (
    InteractionToken,
    LoginSession,
    MatrixUser,
    OAuthAuthCode,
    OAuthClient,
    RefreshToken,
    TokenBlacklist,
)
from app.services import audit

# ---------------------------------------------------------------- 数据载体


@dataclass(frozen=True)
class IssuedTokens:
    access_token: str
    refresh_token: str
    scope: str
    matrix_uid: str
    expires_in: int
    refresh_expires_in: int
    jti: str
    station_id: str | None


@dataclass(frozen=True)
class AuthorizeOutcome:
    code: str
    redirect_uri: str
    state: str | None


# ---------------------------------------------------------------- 客户端与用户


async def get_client(session: AsyncSession, client_id: str) -> OAuthClient:
    client = await session.get(OAuthClient, client_id)
    if client is None or not client.is_active:
        raise MatrixError(ErrorCode.INVALID_CLIENT, f"未知或已停用的客户端：{client_id}")
    return client


def validate_redirect_uri(client: OAuthClient, redirect_uri: str) -> None:
    """严格精确匹配（不做前缀/通配），防开放重定向。"""
    allowed = list(client.redirect_uris or [])
    if redirect_uri not in allowed:
        raise MatrixError(
            ErrorCode.INVALID_REDIRECT_URI,
            "redirect_uri 未在该客户端注册",
        )


async def get_user(session: AsyncSession, matrix_uid: str) -> MatrixUser:
    user = await session.get(MatrixUser, matrix_uid)
    if user is None or not user.is_active:
        raise MatrixError(ErrorCode.UNAUTHORIZED, "用户不存在或已停用")
    return user


def default_scope_for_user(user: MatrixUser, site_key: str) -> list[str]:
    """默认提权：用户对自己站点具备 read/write/emit（architecture §4.5）。"""
    base = [f"station:{site_key}:read", f"station:{site_key}:write"]
    if "emit" in (user.entitlements or []) or "student" in (user.entitlements or []):
        base.append(f"station:{site_key}:emit")
    return base


async def authenticate(
    session: AsyncSession, *, email: str, password: str
) -> MatrixUser:
    """兜底凭据登录（校园 CAS 未接通时）；失败不区分「用户不存在/密码错」。"""
    result = await session.execute(select(MatrixUser).where(MatrixUser.email == email.lower()))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(password, user.password_hash):
        raise MatrixError(ErrorCode.INVALID_CREDENTIALS, "邮箱或密码错误")
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    return user


# ---------------------------------------------------------------- 授权码


async def create_authorization_code(
    session: AsyncSession,
    *,
    settings: Settings,
    client: OAuthClient,
    user: MatrixUser,
    redirect_uri: str,
    requested_scope: list[str],
    code_challenge: str | None,
    code_challenge_method: str | None,
) -> str:
    """生成授权码（一次性，默认 5 min）。返回明文码，服务端只留哈希。"""
    scope_list = requested_scope or default_scope_for_user(user, _station_from_client(client))
    validated = validate_scope_request(
        scope_list, allowed=client.allowed_scopes or [], site_keys=known_site_keys()
    )
    code = random_token("mxac", nbytes=32)
    session.add(
        OAuthAuthCode(
            code_hash=hash_secret(code),
            client_id=client.client_id,
            matrix_uid=user.matrix_uid,
            redirect_uri=redirect_uri,
            scope=normalize_scope(validated),
            code_challenge=code_challenge,
            code_challenge_method=(code_challenge_method or ("S256" if code_challenge else None)),
            expires_at=plus_seconds(settings.auth_code_ttl_seconds),
        )
    )
    await audit.record(
        session,
        action="auth.authorize",
        matrix_uid=user.matrix_uid,
        client_id=client.client_id,
        detail={"scope": normalize_scope(validated), "redirect_uri": redirect_uri},
    )
    return code


def _station_from_client(client: OAuthClient) -> str:
    """客户端 → 站点。约定 client_id 形如 ``site:curvelab`` 或直接用 site_key。"""
    if client.client_id.startswith("site:"):
        return client.client_id.split(":", 1)[1]
    if client.client_id in known_site_keys():
        return client.client_id
    return HUB_SITE_KEY


async def consume_authorization_code(
    session: AsyncSession,
    *,
    code: str,
    client_id: str,
    redirect_uri: str | None,
    code_verifier: str | None,
) -> OAuthAuthCode:
    """兑换授权码。**原子占用**：并发二次兑换只有一次能成功。"""
    code_hash = hash_secret(code)
    result = await session.execute(
        select(OAuthAuthCode).where(OAuthAuthCode.code_hash == code_hash)
    )
    record = result.scalar_one_or_none()
    if record is None:
        raise MatrixError(ErrorCode.INVALID_GRANT, "授权码无效")
    if record.client_id != client_id:
        raise MatrixError(ErrorCode.INVALID_GRANT, "授权码与客户端不匹配")
    if record.consumed_at is not None:
        raise MatrixError(ErrorCode.INVALID_GRANT, "授权码已被使用")
    if ts_of(record.expires_at) <= ts_of(now()):
        raise MatrixError(ErrorCode.INVALID_GRANT, "授权码已过期")
    if record.redirect_uri and redirect_uri and record.redirect_uri != redirect_uri:
        raise MatrixError(ErrorCode.INVALID_GRANT, "redirect_uri 不匹配")
    if record.code_challenge:
        if not verify_pkce(
            code_verifier or "", record.code_challenge, record.code_challenge_method
        ):
            raise MatrixError(ErrorCode.INVALID_GRANT, "PKCE 校验失败")

    # 条件更新实现原子占用：只有 consumed_at IS NULL 时才写入
    claim = await session.execute(
        update(OAuthAuthCode)
        .where(
            OAuthAuthCode.code_hash == code_hash,
            OAuthAuthCode.consumed_at.is_(None),
        )
        .values(consumed_at=now())
    )
    if claim.rowcount == 0:
        raise MatrixError(ErrorCode.INVALID_GRANT, "授权码已被使用")
    await session.refresh(record)
    return record


# ---------------------------------------------------------------- 令牌签发与轮转


async def issue_tokens(
    session: AsyncSession,
    *,
    settings: Settings,
    signer: TokenSigner,
    user: MatrixUser,
    client_id: str,
    scope: str | list[str],
    station_id: str | None = None,
    family_id: str | None = None,
) -> IssuedTokens:
    """签发 mx_at + mx_rt（mx_rt 落库哈希，属某一轮转族）。"""
    scope_list = parse_scope(scope)
    normalized = normalize_scope(scope_list)
    station = station_id or _station_for_scope(scope_list)

    access_jti = new_jti()
    access_token = signer.sign_access_token(
        matrix_uid=user.matrix_uid,
        jti=access_jti,
        scope=scope_list,
        station_id=station,
        client_id=client_id,
        epoch=user.auth_epoch,
    )

    refresh_jti = new_jti()
    family = family_id or new_family_id()
    refresh_secret = random_token("mxrt", nbytes=32)
    refresh_token = signer.sign_refresh_token(
        matrix_uid=user.matrix_uid,
        jti=refresh_jti,
        family_id=family,
        client_id=client_id,
        scope=scope_list,
    )
    session.add(
        RefreshToken(
            token_id=refresh_jti,
            family_id=family,
            token_hash=hash_secret(refresh_secret),
            matrix_uid=user.matrix_uid,
            client_id=client_id,
            scope=normalized,
            expires_at=plus_seconds(settings.refresh_token_ttl_seconds),
        )
    )
    await audit.record(
        session,
        action="auth.token_issued",
        matrix_uid=user.matrix_uid,
        client_id=client_id,
        station_id=station,
        detail={"jti": access_jti, "family": family, "scope": normalized},
    )
    return IssuedTokens(
        access_token=access_token,
        # 组合形态：<jwt>.<secret>，服务端只保存 secret 的哈希 + jwt 内 jti
        refresh_token=f"{refresh_token}.{refresh_secret}",
        scope=normalized,
        matrix_uid=user.matrix_uid,
        expires_in=settings.access_token_ttl_seconds,
        refresh_expires_in=settings.refresh_token_ttl_seconds,
        jti=access_jti,
        station_id=station,
    )


def _station_for_scope(scope: list[str]) -> str | None:
    """从 scope 推断主站（第一个 station:<key>:* 的 key）。"""
    for item in scope:
        parts = item.split(":")
        if len(parts) == 3 and parts[0] == "station":
            return parts[1]
    return None


def split_refresh_token(raw: str) -> tuple[str, str] | None:
    """拆 ``<jwt>.<secret>`` 形态的 refresh token。

    安全设计：即使攻击者拿到 JWT 本体（例如从日志/内存泄漏），没有后面的
    secret 也无法通过库内的哈希比对，因此 refresh token 实际是「JWT + 服务器端密钥」
    的双因子形态。
    """
    return _split_jwt_secret(raw)


def _split_jwt_secret(raw: str) -> tuple[str, str] | None:
    """通用拆分：``<jwt>.<secret>`` → (jwt, secret)；形状不符返回 None。"""
    if not raw or not isinstance(raw, str):
        return None
    jwt_part, dot, secret = raw.rpartition(".")
    if not dot or not secret:
        return None
    # JWT 由三段 base64url 组成：header.payload.signature
    if jwt_part.count(".") != 2 or not jwt_part.startswith("eyJ"):
        return None
    return jwt_part, secret


async def rotate_refresh_token(
    session: AsyncSession,
    *,
    settings: Settings,
    signer: TokenSigner,
    raw_refresh_token: str,
) -> IssuedTokens:
    """refresh token 轮转（含重放检测）。

    重放处理：一旦发现某枚已使用过的 refresh token 被再次提交，
    立即把**整个 family** 标记为 revoked + reuse_detected，并拒绝本次请求。
    这是 OAuth2 Security BCP 推荐的「轮转族失效」做法。
    """
    parsed = split_refresh_token(raw_refresh_token)
    if parsed is None:
        raise MatrixError(ErrorCode.TOKEN_INVALID, "refresh token 格式非法")
    jwt_part, secret = parsed

    try:
        claims = signer.verify(jwt_part, expected_typ=TOKEN_TYPE_REFRESH)
    except TokenError as exc:
        code = {
            "expired": ErrorCode.TOKEN_EXPIRED,
            "invalid": ErrorCode.TOKEN_INVALID,
            "type_mismatch": ErrorCode.TOKEN_TYPE_MISMATCH,
        }.get(exc.code, ErrorCode.TOKEN_INVALID)
        raise MatrixError(code, exc.message) from exc

    record = await session.get(RefreshToken, claims.jti)
    if record is None:
        raise MatrixError(ErrorCode.TOKEN_INVALID, "refresh token 不受信任")

    # 哈希比对：防止伪造同 jti 的令牌
    if record.token_hash != hash_secret(secret):
        raise MatrixError(ErrorCode.TOKEN_INVALID, "refresh token 校验失败")

    if record.revoked_at is not None:
        raise MatrixError(ErrorCode.TOKEN_REVOKED, "refresh token 已失效")

    # --- 重放检测：已使用过却再次提交 ---
    if record.used_at is not None:
        await _revoke_family(session, record.family_id, reason="reuse_detected")
        await audit.record(
            session,
            action="auth.refresh_reuse_detected",
            matrix_uid=record.matrix_uid,
            client_id=record.client_id,
            detail={"family": record.family_id, "token_id": record.token_id},
            trace_id=get_trace_id(),
        )
        await session.commit()
        raise MatrixError(
            ErrorCode.REFRESH_REUSE_DETECTED,
            "检测到 refresh token 重放，该令牌族已全部失效，请重新登录",
        )

    if ts_of(record.expires_at) <= ts_of(now()):
        record.revoked_at = now()
        raise MatrixError(ErrorCode.TOKEN_EXPIRED, "refresh token 已过期")

    user = await get_user(session, record.matrix_uid)

    # 原子占用旧令牌
    claim = await session.execute(
        update(RefreshToken)
        .where(
            RefreshToken.token_id == record.token_id,
            RefreshToken.used_at.is_(None),
            RefreshToken.revoked_at.is_(None),
        )
        .values(used_at=now())
    )
    if claim.rowcount == 0:
        # 并发竞争输者：视为重放，整族失效
        await _revoke_family(session, record.family_id, reason="concurrent_reuse")
        await session.commit()
        raise MatrixError(
            ErrorCode.REFRESH_REUSE_DETECTED,
            "refresh token 并发重放，该令牌族已全部失效，请重新登录",
        )

    issued = await issue_tokens(
        session,
        settings=settings,
        signer=signer,
        user=user,
        client_id=record.client_id,
        scope=record.scope,
        station_id=_station_for_scope(parse_scope(record.scope)),
        family_id=record.family_id,
    )
    # 记录轮转链
    record.replaced_by = _refresh_id_of(issued.refresh_token, signer)
    await audit.record(
        session,
        action="auth.refresh_rotated",
        matrix_uid=record.matrix_uid,
        client_id=record.client_id,
        detail={"family": record.family_id, "old": record.token_id},
    )
    return issued


def _refresh_id_of(raw: str, signer: TokenSigner) -> str | None:
    parsed = split_refresh_token(raw)
    if parsed is None:
        return None
    try:
        return signer.verify(parsed[0], expected_typ=TOKEN_TYPE_REFRESH).jti
    except TokenError:  # pragma: no cover - 自签令牌不应失败
        return None


async def _revoke_family(session: AsyncSession, family_id: str, *, reason: str) -> int:
    """整族失效（重放响应）。"""
    result = await session.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now(), reuse_detected=(reason == "reuse_detected"))
    )
    return result.rowcount or 0


# ---------------------------------------------------------------- access token 判定


async def assert_access_token_live(
    session: AsyncSession, claims: TokenClaims
) -> MatrixUser:
    """access token 的二次判定：jti 黑名单 + 用户 epoch + 用户状态。"""
    if claims.typ != TOKEN_TYPE_ACCESS:
        raise MatrixError(ErrorCode.TOKEN_TYPE_MISMATCH, "需要 access token")

    if claims.jti and await session.get(TokenBlacklist, claims.jti) is not None:
        raise MatrixError(ErrorCode.TOKEN_REVOKED, "令牌已被吊销")

    user = await get_user(session, claims.sub)
    if user.auth_epoch != claims.epoch:
        raise MatrixError(ErrorCode.TOKEN_REVOKED, "令牌已因全局登出失效")
    return user


async def blacklist_jti(
    session: AsyncSession,
    *,
    jti: str,
    matrix_uid: str,
    expires_at_ts: int,
    reason: str = "logout",
) -> None:
    from app.core.clock import from_ts

    session.add(
        TokenBlacklist(
            jti=jti,
            matrix_uid=matrix_uid,
            reason=reason,
            expires_at=from_ts(expires_at_ts),
        )
    )
    await session.flush()


async def logout_access_token(
    session: AsyncSession, claims: TokenClaims
) -> None:
    """单令牌登出：拉黑 jti。"""
    await blacklist_jti(
        session, jti=claims.jti, matrix_uid=claims.sub, expires_at_ts=claims.exp
    )
    await audit.record(
        session, action="auth.logout", matrix_uid=claims.sub, client_id=claims.client_id
    )


async def logout_all(session: AsyncSession, user: MatrixUser) -> int:
    """全局登出：推进 auth_epoch（所有已签发 access token 立即失效）+ 吊销全部 refresh。"""
    user.auth_epoch = (user.auth_epoch or 1) + 1
    revoked = await session.execute(
        update(RefreshToken)
        .where(RefreshToken.matrix_uid == user.matrix_uid, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now())
    )
    await audit.record(
        session,
        action="auth.logout_all",
        matrix_uid=user.matrix_uid,
        detail={"revoked_refresh": revoked.rowcount or 0, "epoch": user.auth_epoch},
    )
    return revoked.rowcount or 0


async def purge_expired(session: AsyncSession) -> dict[str, int]:
    """清理过期黑名单/授权码/会话/IDT（运维定时任务，也可在测试里调用）。"""
    moment = now()
    removed: dict[str, int] = {}
    for model, column, label in (
        (TokenBlacklist, TokenBlacklist.expires_at, "blacklist"),
        (OAuthAuthCode, OAuthAuthCode.expires_at, "auth_code"),
        (LoginSession, LoginSession.expires_at, "login_session"),
        (InteractionToken, InteractionToken.expires_at, "idt"),
    ):
        result = await session.execute(delete(model).where(column < moment))
        removed[label] = result.rowcount or 0
    return removed


# ---------------------------------------------------------------- introspect


async def introspect_token(
    session: AsyncSession,
    *,
    signer: TokenSigner,
    token: str,
    audience: str | None,
) -> dict:
    """RFC 7662：返回令牌是否有效及能力。**不改状态、不交换。**"""
    inactive = {"active": False}
    try:
        claims = signer.verify(token, expected_typ=TOKEN_TYPE_ACCESS)
    except TokenError:
        return inactive

    if await session.get(TokenBlacklist, claims.jti) is not None:
        return inactive

    user = await session.get(MatrixUser, claims.sub)
    if user is None or not user.is_active or user.auth_epoch != claims.epoch:
        return inactive

    stations: dict[str, list[str]] = {}
    for item in claims.scope:
        parts = item.split(":")
        if len(parts) == 3 and parts[0] == "station":
            stations.setdefault(parts[1], []).append(parts[2])
        elif item == "admin:*":
            stations.setdefault("*", []).append("admin")

    audience_allowed = True
    if audience:
        audience_allowed = has_station_scope(claims.scope, audience, "read") or has_station_scope(
            claims.scope, audience, "write"
        )

    return {
        "active": True,
        "matrix_uid": claims.sub,
        "scope": list(claims.scope),
        "client_id": claims.client_id,
        "station_id": claims.station_id,
        "exp": claims.exp,
        "iat": claims.iat,
        "typ": claims.typ,
        "stations": stations,
        "audience_allowed": audience_allowed,
    }


def scope_verbs_for(scope: str | list[str], site_key: str) -> set[str]:
    return scopes_for_station(scope, site_key)


# ---------------------------------------------------------------- mx_idt（S1-09）


async def issue_idt(
    session: AsyncSession,
    *,
    settings: Settings,
    signer: TokenSigner,
    matrix_uid: str,
    target_station: str,
    scope: str | list[str] | None = None,
    trace_id: str | None = None,
    payload_hash: str | None = None,
) -> tuple[str, int]:
    """签发 mx_idt（120 s 一次性）。返回 (明文, 有效期秒)。"""
    if target_station not in known_site_keys():
        raise MatrixError(ErrorCode.IDT_STATION_MISMATCH, f"未知目标站：{target_station}")
    scope_list = parse_scope(scope) or [f"station:{target_station}:read"]
    jti = new_jti()
    resolved_trace = trace_id or get_trace_id()
    secret = random_token("mxidt", nbytes=24)
    token = signer.sign_idt(
        matrix_uid=matrix_uid,
        jti=jti,
        target_station=target_station,
        trace_id=resolved_trace,
        scope=scope_list,
        payload_hash=payload_hash,
    )
    session.add(
        InteractionToken(
            jti=jti,
            token_hash=hash_secret(secret),
            matrix_uid=matrix_uid,
            target_station=target_station,
            scope=normalize_scope(scope_list),
            trace_id=resolved_trace,
            payload_hash=payload_hash,
            expires_at=plus_seconds(settings.idt_ttl_seconds),
        )
    )
    await audit.record(
        session,
        action="auth.idt_issued",
        matrix_uid=matrix_uid,
        station_id=target_station,
        trace_id=resolved_trace,
        detail={"jti": jti, "scope": normalize_scope(scope_list)},
    )
    return f"{token}.{secret}", settings.idt_ttl_seconds


async def exchange_idt(
    session: AsyncSession,
    *,
    settings: Settings,
    signer: TokenSigner,
    mx_idt: str,
    station_id: str | None = None,
) -> IssuedTokens:
    """用 mx_idt 换 mx_at（不签发 refresh：iframe 内存身份，不落 Cookie）。

    一次性语义靠**原子条件更新**保证：并发交换时只有一个请求能把
    ``consumed_at`` 从 NULL 改为当前时间，其余全部 401。
    """
    parsed = split_idt(mx_idt)
    if parsed is None:
        raise MatrixError(ErrorCode.IDT_INVALID, "mx_idt 格式非法")
    jwt_part, secret = parsed

    try:
        claims = signer.verify(jwt_part, expected_typ=TOKEN_TYPE_IDT)
    except TokenError as exc:
        if exc.code == "expired":
            raise MatrixError(ErrorCode.IDT_EXPIRED, "mx_idt 已过期（有效期 120 秒）") from exc
        raise MatrixError(ErrorCode.IDT_INVALID, exc.message) from exc

    record = await session.get(InteractionToken, claims.jti)
    if record is None or record.token_hash != hash_secret(secret):
        raise MatrixError(ErrorCode.IDT_INVALID, "mx_idt 不受信任")

    if station_id and station_id != record.target_station:
        raise MatrixError(
            ErrorCode.IDT_STATION_MISMATCH,
            f"mx_idt 绑定目标站为 {record.target_station}，不能用于 {station_id}",
        )

    now_moment = now()
    if record.consumed_at is not None:
        raise MatrixError(ErrorCode.IDT_ALREADY_USED, "mx_idt 已被使用（一次性凭证）")
    if ts_of(record.expires_at) <= ts_of(now_moment):
        raise MatrixError(ErrorCode.IDT_EXPIRED, "mx_idt 已过期（有效期 120 秒）")

    # 原子占用
    claim = await session.execute(
        update(InteractionToken)
        .where(
            InteractionToken.jti == record.jti,
            InteractionToken.consumed_at.is_(None),
        )
        .values(consumed_at=now_moment)
    )
    if claim.rowcount == 0:
        raise MatrixError(ErrorCode.IDT_ALREADY_USED, "mx_idt 已被使用（一次性凭证）")

    user = await get_user(session, record.matrix_uid)
    scope_list = parse_scope(record.scope)

    access_jti = new_jti()
    access_token = signer.sign_access_token(
        matrix_uid=user.matrix_uid,
        jti=access_jti,
        scope=scope_list,
        station_id=record.target_station,
        client_id=None,
        epoch=user.auth_epoch,
    )
    await audit.record(
        session,
        action="auth.idt_exchanged",
        matrix_uid=user.matrix_uid,
        station_id=record.target_station,
        trace_id=record.trace_id,
        detail={"jti": record.jti},
    )
    return IssuedTokens(
        access_token=access_token,
        refresh_token="",  # iframe 场景不发放 refresh（不落 Cookie，见 ADR-03）
        scope=normalize_scope(scope_list),
        matrix_uid=user.matrix_uid,
        expires_in=settings.access_token_ttl_seconds,
        refresh_expires_in=0,
        jti=access_jti,
        station_id=record.target_station,
    )


def split_idt(raw: str) -> tuple[str, str] | None:
    """拆 ``mx_idt`` 的 ``<jwt>.<secret>``。"""
    return _split_jwt_secret(raw)


# ---------------------------------------------------------------- 辅助


def compute_payload_hash(payload: object) -> str:
    """规范化 JSON 的 SHA-256（排序键 + 紧凑分隔符），用于虫洞完整性校验。"""
    import json

    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def default_scope_for_station(site_key: str, verbs: tuple[str, ...] = ("read", "write")) -> list[str]:
    return [f"station:{site_key}:{verb}" for verb in verbs]


def expires_at_of(ttl_seconds: int) -> object:
    return now() + timedelta(seconds=ttl_seconds)


# ---------------------------------------------------------------- 登录会话（S1-08 前半段）


async def create_login_session(
    session: AsyncSession,
    *,
    settings: Settings,
    user: MatrixUser,
    client_id: str,
    redirect_uri: str,
    scope: str,
    code_challenge: str | None = None,
    code_challenge_method: str | None = None,
) -> str:
    """统一登录页认证成功后建立一个短时会话（默认 15 min）。

    返回明文 ``session_secret``；库内只存其 SHA-256。有了它，浏览器在
    ``/authorize`` 时不必每次重输密码，而后端仍然不持有任何长期凭据。
    """
    session_id = new_jti()
    secret = random_token("mxses", nbytes=32)
    session.add(
        LoginSession(
            session_id=session_id,
            session_hash=hash_secret(secret),
            matrix_uid=user.matrix_uid,
            client_id=client_id,
            redirect_uri=redirect_uri,
            scope=scope,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
            expires_at=plus_seconds(settings.login_session_ttl_seconds),
        )
    )
    await audit.record(
        session,
        action="auth.login_session_created",
        matrix_uid=user.matrix_uid,
        client_id=client_id,
        detail={"session_id": session_id},
    )
    return f"{session_id}.{secret}"


async def resolve_login_session(
    session: AsyncSession, *, raw: str | None
) -> LoginSession | None:
    """校验登录会话（形状 ``<session_id>.<secret>``），过期/不匹配返回 None。

    返回 None 而不是抛错：调用方据「有无会话」决定是要求登录还是继续。
    """
    if not raw or not isinstance(raw, str):
        return None
    session_id, dot, secret = raw.rpartition(".")
    if not dot or not session_id or not secret:
        return None
    record = await session.get(LoginSession, session_id)
    if record is None:
        return None
    if record.session_hash != hash_secret(secret):
        return None
    if ts_of(record.expires_at) <= ts_of(now()):
        return None
    return record


async def drop_login_session(session: AsyncSession, *, raw: str | None) -> bool:
    """登出时销毁登录会话。"""
    record = await resolve_login_session(session, raw=raw)
    if record is None:
        return False
    await session.execute(delete(LoginSession).where(LoginSession.session_id == record.session_id))
    return True


__all__ = [
    "AuthorizeOutcome",
    "IssuedTokens",
    "create_login_session",
    "drop_login_session",
    "resolve_login_session",
    "TOKEN_TYPE_ACCESS",
    "TOKEN_TYPE_IDT",
    "TOKEN_TYPE_REFRESH",
    "assert_access_token_live",
    "authenticate",
    "blacklist_jti",
    "compute_payload_hash",
    "consume_authorization_code",
    "create_authorization_code",
    "default_scope_for_user",
    "exchange_idt",
    "get_client",
    "get_user",
    "introspect_token",
    "issue_idt",
    "issue_tokens",
    "logout_access_token",
    "logout_all",
    "purge_expired",
    "rotate_refresh_token",
    "site_key_of_domain",
    "split_idt",
    "split_refresh_token",
    "validate_redirect_uri",
]
