"""RSA 密钥管理：本地生成 + 轮转 + 旧公钥保留窗口（S1-08 验收项）。

- 私钥/公钥落 ``services/matrix-core/keys/``，私钥已在 .gitignore 白名单外；
- ``keys/current/`` 存放签发用密钥对；``keys/previous/<kid>/`` 存放轮转前的公钥，
  验签时按 JWT header 的 ``kid`` 选公钥——这保证「密钥轮转时旧公钥保留窗口可用」；
- 生成脚本见 ``scripts/generate_keys.py``（入库），服务启动也可按需自动生成（开发环境）。
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.clock import now, ts_of
from app.core.config import Settings, get_settings

PRIVATE_KEY_FILE = "private.pem"
PUBLIC_KEY_FILE = "public.pem"
META_FILE = "meta.json"


@dataclass(frozen=True)
class KeyPair:
    """签发/验签所需的密钥材料。"""

    kid: str
    private_pem: bytes
    public_pem: bytes
    created_at: datetime

    @property
    def private_key(self) -> Any:
        return serialization.load_pem_private_key(self.private_pem, password=None)

    @property
    def public_key(self) -> Any:
        return serialization.load_pem_public_key(self.public_pem)


def _write_private(path: Path, data: bytes) -> None:
    path.write_bytes(data)
    try:  # POSIX 权限收紧；Windows 上该调用是 no-op
        path.chmod(0o600)
    except OSError:  # pragma: no cover - 平台差异
        pass


def generate_keypair(bits: int = 2048) -> tuple[bytes, bytes]:
    """生成 RSA 2048 密钥对（PEM，PKCS#8 私钥 + SubjectPublicKeyInfo 公钥）。"""
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = (
        private_key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    return private_pem, public_pem


def write_keypair(keys_dir: Path, kid: str, private_pem: bytes, public_pem: bytes) -> Path:
    """把密钥对写入 ``keys/current``，并记录 meta.json。"""
    current = keys_dir / "current"
    current.mkdir(parents=True, exist_ok=True)
    _write_private(current / PRIVATE_KEY_FILE, private_pem)
    (current / PUBLIC_KEY_FILE).write_bytes(public_pem)
    meta = {"kid": kid, "created_at": now().isoformat(), "algorithm": "RS256", "bits": 2048}
    (current / META_FILE).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return current


class KeyStore:
    """密钥仓库：当前密钥 + 历史公钥（按 kid 索引）。"""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.keys_dir: Path = self.settings.keys_dir
        self._current: KeyPair | None = None
        self._history: dict[str, bytes] = {}
        self._retention_days = self.settings.key_retention_days

    # ---- 路径 ----
    @property
    def current_dir(self) -> Path:
        return self.keys_dir / "current"

    @property
    def previous_dir(self) -> Path:
        return self.keys_dir / "previous"

    # ---- 读取 ----
    def load(self, *, create_if_missing: bool | None = None) -> "KeyStore":
        """载入当前密钥与历史公钥；缺失时按配置决定是否自动生成。"""
        allow_create = (
            self.settings.auto_generate_keys if create_if_missing is None else create_if_missing
        )
        if not (self.current_dir / PRIVATE_KEY_FILE).exists():
            if not allow_create:
                raise FileNotFoundError(
                    f"未找到 RSA 密钥：{self.current_dir / PRIVATE_KEY_FILE}；"
                    "请先执行 python scripts/generate_keys.py"
                )
            self.ensure_keypair()

        private_pem = (self.current_dir / PRIVATE_KEY_FILE).read_bytes()
        public_pem = (self.current_dir / PUBLIC_KEY_FILE).read_bytes()
        meta = self._read_meta(self.current_dir)
        kid = meta.get("kid") or _default_kid()
        created_raw = meta.get("created_at")
        created_at = (
            datetime.fromisoformat(created_raw) if isinstance(created_raw, str) else now()
        )
        self._current = KeyPair(
            kid=kid,
            private_pem=private_pem,
            public_pem=public_pem,
            created_at=created_at,
        )

        self._history = {}
        if self.previous_dir.exists():
            for child in sorted(self.previous_dir.iterdir()):
                public_file = child / PUBLIC_KEY_FILE
                if child.is_dir() and public_file.exists():
                    self._history[child.name] = public_file.read_bytes()
        return self

    def ensure_keypair(self, kid: str | None = None) -> KeyPair:
        """生成并写入一组新密钥（不覆盖已有 current，除非显式轮转）。"""
        private_pem, public_pem = generate_keypair()
        new_kid = kid or _default_kid()
        write_keypair(self.keys_dir, new_kid, private_pem, public_pem)
        return KeyPair(new_kid, private_pem, public_pem, now())

    def rotate(self, kid: str | None = None) -> KeyPair:
        """轮转：current 移到 previous/<old_kid>/，然后生成新 keypair。"""
        self.load(create_if_missing=True)
        assert self._current is not None
        old = self._current
        self.previous_dir.mkdir(parents=True, exist_ok=True)
        target = self.previous_dir / old.kid
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        (target / PUBLIC_KEY_FILE).write_bytes(old.public_pem)
        (target / META_FILE).write_text(
            json.dumps(
                {"kid": old.kid, "retired_at": now().isoformat()}, ensure_ascii=False, indent=2
            ),
            encoding="utf-8",
        )
        # 旧私钥立即销毁（只保留公钥用于验签窗口）
        for private_name in (PRIVATE_KEY_FILE,):
            stale = self.current_dir / private_name
            if stale.exists():
                stale.unlink()

        private_pem, public_pem = generate_keypair()
        new_kid = kid or _default_kid()
        write_keypair(self.keys_dir, new_kid, private_pem, public_pem)
        return KeyPair(new_kid, private_pem, public_pem, now())

    # ---- 访问 ----
    @property
    def current(self) -> KeyPair:
        if self._current is None:
            self.load()
        assert self._current is not None
        return self._current

    @property
    def history(self) -> dict[str, bytes]:
        if self._current is None:
            self.load()
        return dict(self._history)

    def public_key_for(self, kid: str | None) -> bytes | None:
        """按 kid 取验签公钥；未知 kid 返回 None（调用方按无效令牌处理）。"""
        if not kid:
            return self.current.public_pem
        if kid == self.current.kid:
            return self.current.public_pem
        return self.history.get(kid)

    def public_jwks(self) -> dict[str, Any]:
        """导出 JWKS（供各微站本地验签，避免每次回源）。"""
        from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
        from jwt.algorithms import RSAAlgorithm

        keys: list[dict[str, Any]] = []
        for kid, pem in {**self.history, self.current.kid: self.current.public_pem}.items():
            public_key = serialization.load_pem_public_key(pem)
            if not isinstance(public_key, RSAPublicKey):  # pragma: no cover - 类型守卫
                continue
            jwk = json.loads(RSAAlgorithm.to_jwk(public_key))
            jwk.update({"kid": kid, "use": "sig", "alg": "RS256"})
            keys.append(jwk)
        return {"keys": keys}

    def expire_history(self) -> list[str]:
        """清理超出保留窗口的历史公钥（运维定时任务调用）。"""
        removed: list[str] = []
        if not self.previous_dir.exists():
            return removed
        deadline = ts_of(now() - timedelta(days=self._retention_days))
        for child in self.previous_dir.iterdir():
            if not child.is_dir():
                continue
            meta = self._read_meta(child)
            retired_raw = meta.get("retired_at")
            retired_at = ts_of(datetime.fromisoformat(retired_raw)) if retired_raw else deadline
            if retired_at < deadline:
                shutil.rmtree(child)
                removed.append(child.name)
        return removed

    @staticmethod
    def _read_meta(directory: Path) -> dict[str, Any]:
        meta_file = directory / META_FILE
        if not meta_file.exists():
            return {}
        try:
            return json.loads(meta_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:  # pragma: no cover - 损坏的 meta 不应阻断启动
            return {}


def _default_kid() -> str:
    """kid 用生成时间戳，保证单调可读且不重复。"""
    return f"k{ts_of(now())}"
