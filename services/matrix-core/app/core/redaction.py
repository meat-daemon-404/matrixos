"""敏感字段脱敏（S1-21 / architecture §5.3 W2 的工程实现）。

红线：
1. token 明文（mx_at / mx_rt / mx_idt / 授权码 / 密码 / Cookie）不得进日志；
2. 虫洞 payload 正文不得进日志——服务端只保留哈希与元数据；
3. 证据锚点里的 DOI 可以留（它是公开标识），但不留 bbox 全量以外的隐私字段。

脱敏在 **日志渲染前** 完成（structlog processor），且提供 ``redact_mapping`` 供
审计落库前复用，避免"日志脱敏了但审计表写全文"的另一种漏法。
"""

from __future__ import annotations

import re
from typing import Any, Iterable

MASK = "***REDACTED***"

# 键名命中即整值替换（大小写不敏感、允许前缀后缀）
SENSITIVE_KEY_PATTERNS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "cookie",
    "csrf",
    "credential",
    "private_key",
    "api_key",
    "devkey",
    "passphrase",
)

# 这些键的内容属于「正文」，服务端一律不留（W2 规则）
PAYLOAD_KEY_PATTERNS: tuple[str, ...] = (
    "payload",  # 注意：本服务的审计项用 payload_hash / payload_type，不含 payload
    "payload_data",
    "data_body",
    "content",  # 分片正文
    "raw",
    "raw_body",
)

# 形如 JWT / Bearer 头的值，即使键名没命中也要打掉
_SECRET_VALUE_RE = re.compile(
    r"(?i)\b(bearer\s+)?eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}\b"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-+/=]{8,}")
_COOKIE_PAIR_RE = re.compile(r"(?i)\b(mx_at|mx_rt|mx_idt|mx_sess)=([^;\s]+)")

REDACTED_KEYS: frozenset[str] = frozenset({"payload_hash", "payload_type", "payload_size"})


def _matches(key: str, patterns: Iterable[str]) -> bool:
    lowered = key.lower()
    if lowered in REDACTED_KEYS:
        return False
    return any(pat in lowered for pat in patterns)


def redact_string(value: str, max_len: int = 512) -> str:
    """对自由文本做正则级脱敏 + 截断（防止日志被大字段撑爆）。"""
    out = _SECRET_VALUE_RE.sub(MASK, value)
    out = _BEARER_RE.sub(MASK, out)
    out = _COOKIE_PAIR_RE.sub(lambda m: f"{m.group(1)}={MASK}", out)
    if len(out) > max_len:
        out = out[:max_len] + f"…(truncated, {len(value)} chars)"
    return out


def _redact_value(value: Any, *, depth: int = 0, max_items: int = 50) -> Any:
    if depth > 6:
        return "…"
    if isinstance(value, str):
        return redact_string(value)
    if isinstance(value, bytes):
        return f"<bytes {len(value)}>"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= max_items:
                out["…"] = f"({len(value)} keys)"
                break
            key_str = str(key)
            if _matches(key_str, SENSITIVE_KEY_PATTERNS | PAYLOAD_KEY_PATTERNS):
                out[key_str] = MASK
            else:
                out[key_str] = _redact_value(item, depth=depth + 1, max_items=max_items)
        return out
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        if len(items) > max_items:
            return [_redact_value(item, depth=depth + 1) for item in items[:max_items]] + [
                f"…({len(items)} items)"
            ]
        return [_redact_value(item, depth=depth + 1) for item in items]
    return value


def redact_mapping(data: dict[str, Any]) -> dict[str, Any]:
    """脱敏一个事件字典（structlog 用）。"""
    return {str(key): _redact_value(value) for key, value in data.items()}


def redact_for_audit(data: dict[str, Any]) -> dict[str, Any]:
    """审计/落库前的脱敏：比日志更宽松的键白名单，但仍不含 token 与正文。

    与 ``redact_mapping`` 的差别：这里额外允许 ``trace_id`` / ``*_hash`` /
    ``*_type`` / ``scope`` 等审计必需字段原样保存（它们本身不含明文）。
    """
    return redact_mapping(data)


def structlog_redact_processor(
    _logger: Any, _method_name: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    """structlog processor：渲染前对 event_dict 做脱敏。"""
    return redact_mapping(event_dict)
