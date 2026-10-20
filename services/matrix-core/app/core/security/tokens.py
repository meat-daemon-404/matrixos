"""RS256 JWT 签发与校验（S1-08）。

令牌类型（``typ`` 声明）：
- ``mx_at``：access token，15 min，携带 matrix_uid / scope / station_id / jti / epoch；
- ``mx_rt``：refresh token 本体也是一枚 JWT（真正的失效判断在库里的 token_hash 与
  轮转族状态，JWT 只承载定位信息）；
- ``mx_idt``：interaction token，120 s，一次性，绑定 trace_id 与目标站。

验签要点：
1. 按 header ``kid`` 选公钥——支持密钥轮转时旧公钥保留窗口；
2. 强制校验 ``iss`` / ``aud`` / ``exp`` / ``iat``；
3. ``jti`` 黑名单与 ``auth_epoch`` 由 service 层二次判定（JWT 层只管密码学正确性）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import jwt

from app.core.clock import now_ts
from app.core.config import Settings, get_settings
from app.core.security.keys import KeyStore

TOKEN_TYPE_ACCESS = "mx_at"
TOKEN_TYPE_REFRESH = "mx_rt"
TOKEN_TYPE_IDT = "mx_idt"


@dataclass(frozen=True)
class TokenClaims:
    """校验通过后的声明视图。"""

    typ: str
    sub: str
    jti: str
    iss: str
    aud: str | list[str]
    iat: int
    exp: int
    scope: list[str] = field(default_factory=list)
    station_id: str | None = None
    client_id: str | None = None
    epoch: int = 1
    trace_id: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def has_scope(self) -> bool:
        return bool(self.scope)


class TokenError(Exception):
    """JWT 层错误；由 api 层翻译成统一错误响应。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.reason: str = code


class TokenExpired(TokenError):
    def __init__(self, message: str = "令牌已过期") -> None:
        super().__init__("expired", message)


class TokenInvalid(TokenError):
    def __init__(self, message: str = "令牌无效") -> None:
        super().__init__("invalid", message)


class TokenSigner:
    """JWT 签发器：默认算法 RS256（ADR-03）。"""

    def __init__(
        self,
        settings: Settings | None = None,
        key_store: KeyStore | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.key_store = key_store or KeyStore(self.settings)

    @property
    def algorithm(self) -> str:
        return self.settings.jwt_algorithm

    def _base_claims(self, *, typ: str, matrix_uid: str, ttl: int, jti: str) -> dict[str, Any]:
        issued = now_ts()
        return {
            "typ": typ,
            "sub": matrix_uid,
            "jti": jti,
            "iss": self.settings.jwt_issuer,
            "aud": self.settings.jwt_audience,
            "iat": issued,
            "nbf": issued,
            "exp": issued + ttl,
        }

    def _sign(self, claims: dict[str, Any]) -> str:
        key = self.key_store.current
        headers = {"kid": key.kid}
        return jwt.encode(
            claims,
            key.private_key,
            algorithm=self.algorithm,
            headers=headers,
        )

    # ---- 三类令牌 ----
    def sign_access_token(
        self,
        *,
        matrix_uid: str,
        jti: str,
        scope: list[str],
        station_id: str | None,
        client_id: str | None,
        epoch: int = 1,
        ttl: int | None = None,
    ) -> str:
        claims = self._base_claims(
            typ=TOKEN_TYPE_ACCESS,
            matrix_uid=matrix_uid,
            ttl=ttl if ttl is not None else self.settings.access_token_ttl_seconds,
            jti=jti,
        )
        claims.update(
            {
                "scope": list(scope),
                "station_id": station_id,
                "client_id": client_id,
                "epoch": epoch,
            }
        )
        return self._sign(claims)

    def sign_refresh_token(
        self,
        *,
        matrix_uid: str,
        jti: str,
        family_id: str,
        client_id: str,
        scope: list[str],
        ttl: int | None = None,
    ) -> str:
        claims = self._base_claims(
            typ=TOKEN_TYPE_REFRESH,
            matrix_uid=matrix_uid,
            ttl=ttl if ttl is not None else self.settings.refresh_token_ttl_seconds,
            jti=jti,
        )
        claims.update({"family": family_id, "client_id": client_id, "scope": list(scope)})
        return self._sign(claims)

    def sign_idt(
        self,
        *,
        matrix_uid: str,
        jti: str,
        target_station: str,
        trace_id: str,
        scope: list[str],
        payload_hash: str | None = None,
        ttl: int | None = None,
    ) -> str:
        claims = self._base_claims(
            typ=TOKEN_TYPE_IDT,
            matrix_uid=matrix_uid,
            ttl=ttl if ttl is not None else self.settings.idt_ttl_seconds,
            jti=jti,
        )
        claims.update(
            {
                "station_id": target_station,
                "trace_id": trace_id,
                "scope": list(scope),
                "payload_hash": payload_hash,
            }
        )
        return self._sign(claims)

    # ---- 校验 ----
    def verify(self, token: str, *, expected_typ: str | None = None) -> TokenClaims:
        """验签 + 声明解析；失败抛 ``TokenExpired`` / ``TokenInvalid``。"""
        if not token or not isinstance(token, str):
            raise TokenInvalid("令牌为空")

        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise TokenInvalid("令牌头部不可解析") from exc

        kid = header.get("kid")
        public_pem = self.key_store.public_key_for(kid)
        if public_pem is None:
            # 未知 kid：可能是已过保留窗口的旧密钥，或伪造
            raise TokenInvalid("令牌签名密钥不可识别")

        try:
            payload = jwt.decode(
                token,
                public_pem,
                algorithms=[self.algorithm],
                audience=self.settings.jwt_audience,
                issuer=self.settings.jwt_issuer,
                options={"require": ["exp", "iat", "sub", "iss", "aud"]},
            )
        except jwt.ExpiredSignatureError as exc:
            raise TokenExpired() from exc
        except jwt.PyJWTError as exc:
            raise TokenInvalid("令牌验签失败") from exc

        typ = payload.get("typ", "")
        if expected_typ and typ != expected_typ:
            raise TokenError("type_mismatch", f"令牌类型不匹配：期望 {expected_typ}，实际 {typ}")

        scope_raw = payload.get("scope", [])
        if isinstance(scope_raw, str):
            scope = [item for item in scope_raw.split(" ") if item]
        else:
            scope = [str(item) for item in scope_raw]

        return TokenClaims(
            typ=typ,
            sub=str(payload.get("sub", "")),
            jti=str(payload.get("jti", "")),
            iss=str(payload.get("iss", "")),
            aud=payload.get("aud", ""),
            iat=int(payload.get("iat", 0)),
            exp=int(payload.get("exp", 0)),
            scope=scope,
            station_id=payload.get("station_id"),
            client_id=payload.get("client_id"),
            epoch=int(payload.get("epoch", 1)),
            trace_id=payload.get("trace_id"),
            raw=payload,
        )


def peek_unverified(token: str) -> dict[str, Any]:
    """不验签地读取声明（仅供日志/审计与错误分类使用，不作授权依据）。"""
    try:
        return jwt.decode(token, options={"verify_signature": False, "verify_aud": False})
    except jwt.PyJWTError:  # pragma: no cover - 防御
        return {}


def peek_header(token: str) -> dict[str, Any]:
    try:
        return jwt.get_unverified_header(token)
    except jwt.PyJWTError:  # pragma: no cover
        return {}
