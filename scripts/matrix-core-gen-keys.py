#!/usr/bin/env python
"""生成 matrix-core 生产用 RSA 密钥对（RS256）。

为什么要这个脚本，而不是复用 `scripts/gen-keys.mjs`：
    两者写的目录布局不一样，而**只有 Python 这份和 KeyStore 对得上**。
    旧脚本写 `keys/private.pem`；KeyStore 读的是 `keys/current/private.pem`
    （见 app/core/security/keys.py 的 PRIVATE_KEY_FILE + current_dir）。
    用旧脚本生成后服务仍会报「未找到 RSA 密钥」，或退化成 auto_generate_keys
    又生成一套——两种都不是想要的结果。

用法：
    # 生成到默认目录 services/matrix-core/keys（本地用）
    python scripts/matrix-core-gen-keys.py

    # 生成到指定目录（推荐：先在受控机器上生成，再挂进容器）
    python scripts/matrix-core-gen-keys.py --out ./keys

    # 轮转：把当前密钥移到 previous/<kid>/ 再生成新的一组
    python scripts/matrix-core-gen-keys.py --rotate

    # 只打印公钥 JWKS（供微站本地验签，不含私钥）
    python scripts/matrix-core-gen-keys.py --jwks

安全约定：
- 私钥文件权限固定 600（POSIX）；Windows 上 chmod 是 no-op，靠 NTFS ACL。
- 脚本**不覆盖**已存在的私钥，除非显式给 --rotate 或 --force。
- 绝不把私钥写进日志；--jwks 只输出公钥部分。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# 允许直接 `python scripts/matrix-core-gen-keys.py`（不加 -m）
REPO_ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = REPO_ROOT / "services" / "matrix-core"
sys.path.insert(0, str(SERVICE_ROOT))

DEFAULT_KEYS_DIR = SERVICE_ROOT / "keys"

# Windows 控制台默认 GBK（cp936），CI 里常见 LC_ALL=C（ASCII）——这两种情况下打印
# "✓" 会抛 UnicodeEncodeError。危险之处在于：**密钥其实已经写盘成功**，却因为最后
# 一行日志崩掉、退出码非 0，会被误判成「生成失败」；更糟的是本脚本的幂等保护会让
# 重跑直接拒绝覆盖，运维只能被迫用 --force（那会让所有已签发 token 立即失效）。
# 所以统一把输出切到 UTF-8，编码不了就降级成替代字符，绝不因日志中断主流程。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _kid() -> str:
    """与 app/core/security/keys.py 的 _default_kid 同构：k<unix ts>。"""
    return f"k{int(datetime.now(timezone.utc).timestamp())}"


def _write_private(path: Path, data: bytes) -> None:
    path.write_bytes(data)
    if os.name == "posix":
        path.chmod(0o600)


def generate(out: Path, *, rotate: bool, force: bool) -> int:
    """生成一组新密钥到 ``out/current/``。"""
    # 延迟导入：让 --help 不等 cryptography 装完也能用
    from app.core.security.keys import generate_keypair

    current = out / "current"
    private_path = current / "private.pem"
    public_path = current / "public.pem"
    meta_path = current / "meta.json"

    if private_path.exists() and not (rotate or force):
        print(f"✗ 私钥已存在，拒绝覆盖：{private_path}", file=sys.stderr)
        print("", file=sys.stderr)
        print("  如确需重新生成，二选一：", file=sys.stderr)
        print("    --rotate  把旧密钥移到 previous/<kid>/ 后生成新的（推荐）", file=sys.stderr)
        print("    --force   直接覆盖（⚠️ 所有已签发 token 立即失效）", file=sys.stderr)
        return 1

    if rotate and private_path.exists():
        old_meta = {}
        if meta_path.exists():
            try:
                old_meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                old_meta = {}
        old_kid = old_meta.get("kid") or _kid()

        previous = out / "previous" / old_kid
        previous.mkdir(parents=True, exist_ok=True)
        # 旧私钥**不保留**：轮转后只留公钥用于验签保留窗口
        if public_path.exists():
            shutil.copy2(public_path, previous / "public.pem")
        (previous / "meta.json").write_text(
            json.dumps(
                {"kid": old_kid, "retired_at": _now_iso()}, ensure_ascii=False, indent=2
            ),
            encoding="utf-8",
        )
        print(f"✓ 旧公钥已归档：{previous}（验签保留窗口内有效）")

    current.mkdir(parents=True, exist_ok=True)
    private_pem, public_pem = generate_keypair()
    kid = _kid()

    _write_private(private_path, private_pem)
    public_path.write_bytes(public_pem)
    meta_path.write_text(
        json.dumps(
            {"kid": kid, "created_at": _now_iso(), "algorithm": "RS256", "bits": 2048},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"✓ RSA 密钥对已生成（kid={kid}）")
    print(f"  私钥: {private_path}   ← 🔴 绝不提交，绝不打进镜像")
    print(f"  公钥: {public_path}")
    print(f"  元数据: {meta_path}")
    print("")
    print("  容器部署时挂载整个 keys 目录：")
    print(f"    -v {out}:/var/lib/matrix-core/keys:ro")
    print("  并确保：MATRIX_CORE_AUTO_GENERATE_KEYS=false")
    return 0


def print_jwks(out: Path) -> int:
    """输出公钥 JWKS（可安全公开，供微站本地验签）。"""
    from app.core.config import Settings
    from app.core.security.keys import KeyStore

    keys_dir = out
    if not (keys_dir / "current" / "public.pem").exists():
        print(f"✗ 找不到密钥：{keys_dir / 'current' / 'public.pem'}", file=sys.stderr)
        return 1

    # 用真实配置类的 keys_dir 语义构造一个最小 Settings，避免 KeyStore 回落到默认目录
    settings = Settings(keys_dir=keys_dir, auto_generate_keys=False)
    store = KeyStore(settings).load(create_if_missing=False)
    print(json.dumps(store.public_jwks(), ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="生成 / 轮转 matrix-core 的 RS256 密钥对",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_KEYS_DIR,
        help=f"密钥目录（默认 {DEFAULT_KEYS_DIR}）",
    )
    parser.add_argument(
        "--rotate",
        action="store_true",
        help="把现有密钥移到 previous/<kid>/ 后生成新的一组",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="直接覆盖现有私钥（⚠️ 会让所有已签发 token 失效）",
    )
    parser.add_argument(
        "--jwks",
        action="store_true",
        help="只输出公钥 JWKS，不生成任何东西",
    )
    args = parser.parse_args(argv)

    out = args.out.expanduser().resolve()

    if args.jwks:
        return print_jwks(out)
    return generate(out, rotate=args.rotate, force=args.force)


if __name__ == "__main__":
    raise SystemExit(main())
