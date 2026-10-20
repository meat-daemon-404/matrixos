"""密码哈希：PBKDF2-SHA256（≥310,000 迭代，与 ADR-05 端侧口径一致）。

服务端凭据体系只在校园 CAS 未接通时作为兜底（S1-03e），但一旦存在就必须做对：
- 迭代次数 600,000（OWASP 2023 对 PBKDF2-SHA256 的推荐值，高于 310k 下限）；
- 存 ``pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>``，便于未来提升迭代数；
- 校验用 ``hmac.compare_digest`` 常量时间比较。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

ALGORITHM = "pbkdf2_sha256"
DEFAULT_ITERATIONS = 600_000
_SALT_BYTES = 16


def hash_password(password: str, *, iterations: int = DEFAULT_ITERATIONS) -> str:
    if not password:
        raise ValueError("密码不能为空")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "$".join(
        (
            ALGORITHM,
            str(iterations),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        )
    )


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or not password:
        return False
    try:
        algorithm, iterations_raw, salt_b64, hash_b64 = stored.split("$")
        if algorithm != ALGORITHM:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, int(iterations_raw)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def needs_rehash(stored: str | None, *, iterations: int = DEFAULT_ITERATIONS) -> bool:
    """迭代数低于当前标准时提示重算（登录成功后静默升级）。"""
    if not stored:
        return True
    try:
        _, iterations_raw, _, _ = stored.split("$")
        return int(iterations_raw) < iterations
    except (ValueError, TypeError):
        return True
