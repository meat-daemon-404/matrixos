"""密码学小工具：哈希、随机串、PKCE。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid

# OAuth2 令牌前缀：便于在日志/抓包里一眼区分令牌类型（日志仍会脱敏）
ACCESS_TOKEN_PREFIX = "mxat"
REFRESH_TOKEN_PREFIX = "mxrt"
IDT_PREFIX = "mxidt"
AUTH_CODE_PREFIX = "mxac"


def sha256_hex(value: str | bytes) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def hash_secret(secret: str) -> str:
    """令牌/授权码的落地形式：统一 SHA-256（高熵随机值无需慢哈希）。"""
    return sha256_hex(secret)


def constant_time_compare(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def random_token(prefix: str, nbytes: int = 32) -> str:
    """高熵随机串 + 前缀，例如 ``mxrt_...``。"""
    return f"{prefix}_{secrets.token_urlsafe(nbytes)}"


def new_jti() -> str:
    return str(uuid.uuid4())


def new_family_id() -> str:
    return str(uuid.uuid4())


def b64url_sha256(value: str) -> str:
    """PKCE S256：BASE64URL(SHA256(verifier))，无填充。"""
    digest = hashlib.sha256(value.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def verify_pkce(code_verifier: str, code_challenge: str, method: str | None) -> bool:
    """校验 PKCE；``method`` 为 None/plain 时按明文比对，S256 按哈希比对。"""
    if not code_verifier or not code_challenge:
        return False
    if (method or "plain").upper() == "S256":
        return constant_time_compare(b64url_sha256(code_verifier), code_challenge)
    return constant_time_compare(code_verifier, code_challenge)


def generate_client_secret() -> str:
    return f"mxs_{secrets.token_urlsafe(32)}"


def generate_devkey() -> str:
    return f"mxdk_{secrets.token_urlsafe(32)}"
