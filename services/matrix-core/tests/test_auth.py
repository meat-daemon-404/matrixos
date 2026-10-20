"""P0 鉴权：JWT 签发/校验、refresh 轮转、jti 黑名单、令牌重放。

这些用例保护的是"身份不可伪造、不可重放、登出真的生效"三件事。
每一条都对应一个具体的攻击动作，注释里写明了攻击面。
"""

from __future__ import annotations

import time
import uuid

import jwt as pyjwt
import pytest

from app.core.security.passwords import (
    DEFAULT_ITERATIONS,
    hash_password,
    needs_rehash,
    verify_password,
)
from app.core.security.tokens import (
    TOKEN_TYPE_ACCESS,
    TOKEN_TYPE_REFRESH,
    TokenExpired,
    TokenInvalid,
    TokenSigner,
)
from app.core.errors import MatrixError
from app.services import auth as auth_service

from .conftest import ALICE, BOB, CURVELAB, TEST_PASSWORD, full_scope


# ================================================================== JWT 基础


def test_access_token_roundtrip_keeps_identity(signer: TokenSigner) -> None:
    jti = str(uuid.uuid4())
    token = signer.sign_access_token(
        matrix_uid=ALICE,
        jti=jti,
        scope=full_scope(),
        station_id=CURVELAB,
        client_id=f"site:{CURVELAB}",
        epoch=3,
    )
    claims = signer.verify(token, expected_typ=TOKEN_TYPE_ACCESS)

    assert claims.typ == TOKEN_TYPE_ACCESS
    assert claims.sub == ALICE
    assert claims.jti == jti
    assert claims.epoch == 3
    assert claims.station_id == CURVELAB
    assert set(claims.scope) == set(full_scope())
    assert claims.exp > claims.iat


def test_access_token_ttl_is_fifteen_minutes(signer: TokenSigner) -> None:
    """S1-08 硬要求：mx_at = 15 min。"""
    token = signer.sign_access_token(
        matrix_uid=ALICE,
        jti=str(uuid.uuid4()),
        scope=full_scope(),
        station_id=CURVELAB,
        client_id=f"site:{CURVELAB}",
    )
    claims = signer.verify(token)
    assert claims.exp - claims.iat == 15 * 60


def test_tampered_payload_breaks_signature(signer: TokenSigner) -> None:
    """攻击：改 payload 里的 sub 冒充别人（签名不动）。"""
    token = signer.sign_access_token(
        matrix_uid=BOB,
        jti=str(uuid.uuid4()),
        scope=full_scope(),
        station_id=CURVELAB,
        client_id=f"site:{CURVELAB}",
    )
    header, payload, signature = token.split(".")
    # 换掉中间段：签名随之失效
    forged = f"{header}.{payload[:-4]}AAAA.{signature}"
    with pytest.raises(TokenInvalid):
        signer.verify(forged)


def test_token_signed_by_foreign_key_is_rejected(signer: TokenSigner) -> None:
    """攻击：攻击者用自己的 RSA 私钥自签一枚，并照抄 kid。"""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    attacker_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    attacker_pem = attacker_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    now = int(time.time())
    forged = pyjwt.encode(
        {
            "typ": TOKEN_TYPE_ACCESS,
            "sub": ALICE,
            "jti": str(uuid.uuid4()),
            "iss": signer.settings.jwt_issuer,
            "aud": signer.settings.jwt_audience,
            "iat": now,
            "nbf": now,
            "exp": now + 900,
            "scope": ["admin:*"],
            "epoch": 1,
        },
        attacker_pem,
        algorithm="RS256",
        headers={"kid": signer.key_store.current.kid},
    )
    with pytest.raises(TokenInvalid):
        signer.verify(forged)


def test_unknown_kid_is_rejected(signer: TokenSigner) -> None:
    """攻击：把 kid 改成不存在的值，赌服务端会回落到"任意公钥"。"""
    token = signer.sign_access_token(
        matrix_uid=ALICE,
        jti=str(uuid.uuid4()),
        scope=full_scope(),
        station_id=CURVELAB,
        client_id=f"site:{CURVELAB}",
    )
    header, payload, signature = token.split(".")
    import base64
    import json

    raw = json.loads(base64.urlsafe_b64decode(header + "=="))
    raw["kid"] = "k-not-a-real-kid"
    forged_header = (
        base64.urlsafe_b64encode(json.dumps(raw).encode()).decode().rstrip("=")
    )
    with pytest.raises(TokenInvalid, match="密钥不可识别"):
        signer.verify(f"{forged_header}.{payload}.{signature}")


def test_expired_token_raises_expired(signer: TokenSigner) -> None:
    token = signer.sign_access_token(
        matrix_uid=ALICE,
        jti=str(uuid.uuid4()),
        scope=full_scope(),
        station_id=CURVELAB,
        client_id=f"site:{CURVELAB}",
        ttl=-10,  # 签发即过期
    )
    with pytest.raises(TokenExpired):
        signer.verify(token)


def test_wrong_issuer_is_rejected(signer: TokenSigner) -> None:
    """攻击：自建一个 iss 相同的"平行体系"——必须拒绝。"""
    now = int(time.time())
    token = pyjwt.encode(
        {
            "typ": TOKEN_TYPE_ACCESS,
            "sub": ALICE,
            "jti": str(uuid.uuid4()),
            "iss": "https://evil.example.com",
            "aud": signer.settings.jwt_audience,
            "iat": now,
            "exp": now + 900,
        },
        signer.key_store.current.private_key,
        algorithm="RS256",
        headers={"kid": signer.key_store.current.kid},
    )
    with pytest.raises(TokenInvalid):
        signer.verify(token)


def test_refresh_token_cannot_be_used_as_access_token(signer: TokenSigner) -> None:
    """攻击：把 mx_rt 当 mx_at 塞进 Authorization 头。"""
    token = signer.sign_refresh_token(
        matrix_uid=ALICE,
        jti=str(uuid.uuid4()),
        family_id=str(uuid.uuid4()),
        client_id=f"site:{CURVELAB}",
        scope=full_scope(),
    )
    with pytest.raises(Exception) as excinfo:
        signer.verify(token, expected_typ=TOKEN_TYPE_ACCESS)
    assert getattr(excinfo.value, "code", None) == "type_mismatch"


def test_empty_token_is_invalid(signer: TokenSigner) -> None:
    for empty in ("", None, "not-a-jwt"):
        with pytest.raises(TokenInvalid):
            signer.verify(empty)  # type: ignore[arg-type]


def test_jwks_exposes_only_public_material(signer: TokenSigner) -> None:
    """JWKS 是公开端点：绝不能漏出私钥。"""
    jwks = signer.key_store.public_jwks()
    assert len(jwks["keys"]) >= 1
    for key in jwks["keys"]:
        assert key["kty"] == "RSA"
        assert key["alg"] == "RS256"
        assert "d" not in key, "JWKS 里出现了私钥指数 d"
        assert "p" not in key and "q" not in key


# ================================================================== 口令哈希


def test_password_hash_uses_production_iteration_count() -> None:
    """ADR-05：PBKDF2-SHA256 ≥ 310k（实现取 600k）。"""
    stored = hash_password("hunter2")
    assert stored.startswith("pbkdf2_sha256$")
    iterations = int(stored.split("$")[1])
    assert iterations == DEFAULT_ITERATIONS >= 310_000


def test_password_verify_and_rehash_detection() -> None:
    stored = hash_password("hunter2", iterations=1_000)
    assert verify_password("hunter2", stored) is True
    assert verify_password("hunter3", stored) is False
    assert verify_password("hunter2", None) is False
    # 低迭代的旧哈希应被识别为需要升级
    assert needs_rehash(stored) is True
    assert needs_rehash(hash_password("x"), iterations=DEFAULT_ITERATIONS) is False


# ================================================================== refresh 轮转


@pytest.fixture()
def bob_tokens(settings, signer, client):
    """通过真实登录端点给 Bob 签发一对令牌。"""
    response = client.post(
        "/v1/auth/login",
        params={"issue_tokens": "true"},
        json={
            "client_id": f"site:{CURVELAB}",
            "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
            "scope": "station:curvelab:read station:curvelab:write",
            "email": "bob@matrixos.edu",
            "password": TEST_PASSWORD,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["tokens"]


def test_refresh_rotation_issues_new_pair(client, bob_tokens) -> None:
    response = client.post(
        "/v1/auth/refresh", json={"refresh_token": bob_tokens["refresh_token"]}
    )
    assert response.status_code == 200, response.text
    rotated = response.json()
    assert rotated["refresh_token"] != bob_tokens["refresh_token"], "refresh 必须轮转"
    assert rotated["access_token"] != bob_tokens["access_token"]
    assert rotated["matrix_uid"] == BOB


def test_rotated_refresh_token_works_once(client, bob_tokens) -> None:
    first = client.post("/v1/auth/refresh", json={"refresh_token": bob_tokens["refresh_token"]})
    assert first.status_code == 200
    second = client.post("/v1/auth/refresh", json={"refresh_token": first.json()["refresh_token"]})
    assert second.status_code == 200, second.text


def test_refresh_token_replay_is_rejected(client, bob_tokens) -> None:
    """**核心红线**：已用过的 mx_rt 再次提交必须被拒。"""
    assert client.post(
        "/v1/auth/refresh", json={"refresh_token": bob_tokens["refresh_token"]}
    ).status_code == 200

    replay = client.post("/v1/auth/refresh", json={"refresh_token": bob_tokens["refresh_token"]})
    assert replay.status_code == 401
    assert replay.json()["code"] == "auth.refresh_reuse_detected"


def test_replay_revokes_entire_family(client, bob_tokens) -> None:
    """重放被检测到后，该族最新那枚也必须失效（OAuth2 Security BCP）。"""
    first = client.post("/v1/auth/refresh", json={"refresh_token": bob_tokens["refresh_token"]})
    assert first.status_code == 200
    newest = first.json()["refresh_token"]

    # 攻击者重放旧令牌 → 触发整族失效
    client.post("/v1/auth/refresh", json={"refresh_token": bob_tokens["refresh_token"]})

    victim = client.post("/v1/auth/refresh", json={"refresh_token": newest})
    assert victim.status_code == 401, "重放后家族内最新令牌仍然可用，整族失效没生效"
    assert victim.json()["code"] == "auth.token_revoked"


def test_forged_refresh_secret_is_rejected(client, bob_tokens) -> None:
    """攻击：知道 jti 但不知道服务器端 secret —— 换掉 ``.<secret>`` 段。"""
    jwt_part, _, _secret = bob_tokens["refresh_token"].rpartition(".")
    forged = f"{jwt_part}.mxrt_attacker_guessed_secret"
    response = client.post("/v1/auth/refresh", json={"refresh_token": forged})
    assert response.status_code == 401
    assert response.json()["code"] in {"auth.token_invalid", "auth.token_revoked"}


def test_malformed_refresh_token_is_rejected(client) -> None:
    for bad in ("garbage", "a.b", "eyJhbGciOiJSUzI1NiJ9.x.y."):
        response = client.post("/v1/auth/refresh", json={"refresh_token": bad})
        assert response.status_code in {400, 401}, bad


# ================================================================== jti 黑名单


def test_logout_blacklists_jti(client, auth) -> None:
    headers = auth(matrix_uid=BOB)
    assert client.get("/v1/auth/userinfo", headers=headers).status_code == 200

    assert client.post("/v1/auth/logout", headers=headers).status_code == 200

    after = client.get("/v1/auth/userinfo", headers=headers)
    assert after.status_code == 401
    assert after.json()["code"] == "auth.token_revoked"


def test_logged_out_token_is_rejected_by_assets_too(client, auth) -> None:
    """登出必须在**所有**受保护端点上生效，而不只是 userinfo。"""
    headers = auth(matrix_uid=BOB)
    assert client.get("/v1/assets", headers=headers).status_code == 200
    assert client.post("/v1/auth/logout", headers=headers).status_code == 200
    assert client.get("/v1/assets", headers=headers).status_code == 401


def test_logout_all_bumps_epoch_and_kills_every_token(client, auth) -> None:
    """全局登出：推进 auth_epoch，所有已签发 mx_at 立即失效。"""
    old_a = auth(matrix_uid=BOB)
    old_b = auth(matrix_uid=BOB)  # 同一用户的另一枚令牌

    assert client.post("/v1/auth/logout-all", headers=old_a).status_code == 200

    for headers in (old_a, old_b):
        response = client.get("/v1/auth/userinfo", headers=headers)
        assert response.status_code == 401
        assert response.json()["code"] == "auth.token_revoked"


def test_token_with_stale_epoch_is_rejected(client, make_token) -> None:
    """攻击：缓存一枚 epoch=0 的旧令牌，绕过 logout-all。"""
    stale = make_token(matrix_uid=BOB, epoch=0)
    response = client.get("/v1/auth/userinfo", headers={"Authorization": f"Bearer {stale}"})
    assert response.status_code == 401
    assert response.json()["code"] == "auth.token_revoked"


def test_logout_all_revokes_refresh_tokens(client, auth, bob_tokens) -> None:
    headers = auth(matrix_uid=BOB)
    assert client.post("/v1/auth/logout-all", headers=headers).status_code == 200
    response = client.post("/v1/auth/refresh", json={"refresh_token": bob_tokens["refresh_token"]})
    assert response.status_code == 401
    assert response.json()["code"] == "auth.token_revoked"


# ================================================================== 授权码与 PKCE


def test_authorization_code_is_single_use(client, login) -> None:
    headers = login()
    exchange = client.get(
        "/v1/auth/authorize",
        params={
            "client_id": f"site:{CURVELAB}",
            "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
            "scope": "station:curvelab:read",
        },
        cookies=_cookies_from(client),
    )
    # 走 cookie 需要真实登录会话；这里改用 /authorize/redirect 拿 code
    assert exchange.status_code in {200, 401}

    redirect = client.post(
        "/v1/auth/authorize/redirect",
        json={
            "client_id": f"site:{CURVELAB}",
            "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
            "scope": "station:curvelab:read",
            "email": "alice@matrixos.edu",
            "password": TEST_PASSWORD,
        },
        follow_redirects=False,
    )
    assert redirect.status_code == 302
    code = _code_from_location(redirect.headers["location"])

    first = client.post(
        "/v1/auth/token",
        json={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": f"site:{CURVELAB}",
            "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
        },
    )
    assert first.status_code == 200, first.text

    second = client.post(
        "/v1/auth/token",
        json={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": f"site:{CURVELAB}",
            "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
        },
    )
    assert second.status_code == 400
    assert second.json()["code"] == "auth.invalid_grant"


def test_authorize_rejects_unregistered_redirect_uri(client, login) -> None:
    """开放重定向防御：redirect_uri 必须精确匹配注册值。"""
    response = client.post(
        "/v1/auth/authorize/redirect",
        json={
            "client_id": f"site:{CURVELAB}",
            "redirect_uri": "https://evil.example.com/steal",
            "scope": "station:curvelab:read",
            "email": "alice@matrixos.edu",
            "password": TEST_PASSWORD,
        },
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert response.json()["code"] == "auth.invalid_redirect_uri"


def test_pkce_s256_is_enforced(client) -> None:
    """公共客户端必须 PKCE：code_challenge 存在时缺 verifier → 拒绝。"""
    import hashlib
    import base64

    verifier = "a" * 64
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    redirect = client.post(
        "/v1/auth/authorize/redirect",
        json={
            "client_id": f"site:{CURVELAB}",
            "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
            "scope": "station:curvelab:read",
            "email": "alice@matrixos.edu",
            "password": TEST_PASSWORD,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    assert redirect.status_code == 302
    code = _code_from_location(redirect.headers["location"])

    without_verifier = client.post(
        "/v1/auth/token",
        json={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": f"site:{CURVELAB}",
            "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
        },
    )
    assert without_verifier.status_code == 400
    assert without_verifier.json()["code"] == "auth.invalid_grant"


def test_invalid_credentials_do_not_leak_user_existence(client) -> None:
    """邮箱不存在与密码错误必须返回同一个错误码与文案。"""
    base = {
        "client_id": f"site:{CURVELAB}",
        "redirect_uri": f"https://{CURVELAB}.matrixos.edu/cb",
        "scope": "station:curvelab:read",
    }
    unknown = client.post(
        "/v1/auth/login",
        json={**base, "email": "nobody@matrixos.edu", "password": TEST_PASSWORD},
    )
    wrong = client.post(
        "/v1/auth/login",
        json={**base, "email": "alice@matrixos.edu", "password": "wrong-password"},
    )
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["code"] == wrong.json()["code"] == "auth.invalid_credentials"
    assert unknown.json()["message"] == wrong.json()["message"]


def test_unknown_client_is_rejected(client) -> None:
    response = client.post(
        "/v1/auth/login",
        json={
            "client_id": "site:not-registered",
            "redirect_uri": "https://not-registered.matrixos.edu/cb",
            "scope": "",
            "email": "alice@matrixos.edu",
            "password": TEST_PASSWORD,
        },
    )
    assert response.status_code == 401
    assert response.json()["code"] == "auth.invalid_client"


# ================================================================== introspect


def test_introspect_reports_inactive_after_logout(client, auth) -> None:
    headers = auth(matrix_uid=BOB)
    token = headers["Authorization"].split(" ", 1)[1]

    active = client.post("/v1/auth/introspect", json={"token": token})
    assert active.status_code == 200
    assert active.json()["active"] is True
    assert active.json()["matrix_uid"] == BOB

    client.post("/v1/auth/logout", headers=headers)

    inactive = client.post("/v1/auth/introspect", json={"token": token})
    assert inactive.status_code == 200
    assert inactive.json()["active"] is False


def test_introspect_reports_station_permissions(client, auth) -> None:
    headers = auth(matrix_uid=BOB, scope=["station:curvelab:read"])
    token = headers["Authorization"].split(" ", 1)[1]

    response = client.post(
        "/v1/auth/introspect", json={"token": token, "audience": CURVELAB}
    )
    body = response.json()
    assert body["active"] is True
    assert body["audience_allowed"] is True
    assert body["stations"] == {CURVELAB: ["read"]}

    other = client.post(
        "/v1/auth/introspect", json={"token": token, "audience": "prejob"}
    )
    assert other.json()["audience_allowed"] is False


def test_introspect_garbage_token_is_inactive_not_error(client) -> None:
    response = client.post("/v1/auth/introspect", json={"token": "nonsense"})
    assert response.status_code == 200
    assert response.json()["active"] is False


# ================================================================== mx_idt


def test_idt_exchange_is_single_use(client, auth) -> None:
    """iframe 场景：mx_idt 一次性，二次交换必须 401。"""
    headers = auth(matrix_uid=BOB)
    issued = client.post(
        "/v1/auth/idt", json={"target_station": CURVELAB}, headers=headers
    )
    assert issued.status_code == 200, issued.text
    mx_idt = issued.json()["mx_idt"]

    first = client.post("/v1/auth/exchange", json={"mx_idt": mx_idt, "station_id": CURVELAB})
    assert first.status_code == 200, first.text
    assert first.json()["matrix_uid"] == BOB

    second = client.post("/v1/auth/exchange", json={"mx_idt": mx_idt, "station_id": CURVELAB})
    assert second.status_code == 401
    assert second.json()["code"] == "auth.idt_already_used"


def test_idt_cannot_be_redeemed_at_another_station(client, auth) -> None:
    headers = auth(matrix_uid=BOB)
    issued = client.post(
        "/v1/auth/idt", json={"target_station": CURVELAB}, headers=headers
    )
    mx_idt = issued.json()["mx_idt"]

    response = client.post(
        "/v1/auth/exchange", json={"mx_idt": mx_idt, "station_id": "prejob"}
    )
    assert response.status_code == 403
    assert response.json()["code"] == "auth.idt_station_mismatch"


def test_idt_rejects_unknown_target_station(client, auth) -> None:
    response = client.post(
        "/v1/auth/idt", json={"target_station": "not-a-site"}, headers=auth(matrix_uid=BOB)
    )
    assert response.status_code == 403
    assert response.json()["code"] == "auth.idt_station_mismatch"


def test_idt_ttl_is_120_seconds(client, auth) -> None:
    issued = client.post(
        "/v1/auth/idt", json={"target_station": CURVELAB}, headers=auth(matrix_uid=BOB)
    )
    assert issued.json()["expires_in"] == 120


def test_idt_requires_authentication(client) -> None:
    response = client.post("/v1/auth/idt", json={"target_station": CURVELAB})
    assert response.status_code == 401


# ================================================================== 辅助


def _code_from_location(location: str) -> str:
    from urllib.parse import parse_qs, urlparse

    query = parse_qs(urlparse(location).query)
    assert "code" in query, location
    return query["code"][0]


def _cookies_from(client) -> dict[str, str]:
    return {cookie.name: cookie.value for cookie in client.cookies.jar}


# ================================================================== 服务层直测


def test_assert_access_token_live_rejects_blacklisted_jti(settings, signer, db_run) -> None:
    """服务层直测：黑名单命中即拒绝（不依赖 HTTP 层）。"""
    from app.core.security.tokens import TokenClaims

    jti = str(uuid.uuid4())
    claims = TokenClaims(
        typ=TOKEN_TYPE_ACCESS,
        sub=ALICE,
        jti=jti,
        iss=settings.jwt_issuer,
        aud=settings.jwt_audience,
        iat=int(time.time()),
        exp=int(time.time()) + 900,
        scope=full_scope(),
        epoch=1,
    )

    def scenario(session):
        async def run():
            # epoch 匹配时放行
            user = await auth_service.assert_access_token_live(session, claims)
            assert user.matrix_uid == ALICE
            await auth_service.blacklist_jti(
                session, jti=jti, matrix_uid=ALICE, expires_at_ts=claims.exp
            )
            await session.commit()
            with pytest.raises(MatrixError) as excinfo:
                await auth_service.assert_access_token_live(session, claims)
            return excinfo.value.code

        return run()

    assert db_run(scenario) == "auth.token_revoked"


def test_purge_expired_removes_only_expired_rows(settings, signer, db_run) -> None:
    """运维清理：过期黑名单被删，未过期保留。"""
    from app.core.clock import from_ts, now, ts_of

    def scenario(session):
        async def run():
            from app.models.auth import TokenBlacklist

            current = ts_of(now())
            session.add_all(
                [
                    TokenBlacklist(
                        jti=str(uuid.uuid4()),
                        matrix_uid=ALICE,
                        reason="logout",
                        expires_at=from_ts(current - 60),  # 已过期
                    ),
                    TokenBlacklist(
                        jti=str(uuid.uuid4()),
                        matrix_uid=ALICE,
                        reason="logout",
                        expires_at=from_ts(current + 3600),  # 仍有效
                    ),
                ]
            )
            await session.commit()
            removed = await auth_service.purge_expired(session)
            await session.commit()
            return removed

        return run()

    result = db_run(scenario)
    assert result["blacklist"] == 1
