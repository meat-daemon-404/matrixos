"""Wormhole 收据服务（architecture §5.2 / §5.3 W2 规则）。

**铁律（W2）：服务端只存哈希与元数据，绝不存 payload 正文。**

这不是「约定」而是结构性的：
1. ``wormhole_receipt`` 表里没有任何能装正文的列（见 models/wormhole.py）；
2. 本模块收到完整 envelope 时，**只在内存里算哈希，随后丢弃**，不回写、不缓存；
3. 请求体里出现 ``payload`` / ``data`` 之类正文字段时按 422 显式拒绝
   （``WORMHOLE_PAYLOAD_FORBIDDEN``），而不是「忽略它」——静默忽略会让
   调用方误以为正文被接收，是更危险的失败模式。

为什么要这么做（架构原话）：若 payload 走服务端中转，``matrix-core`` 就成了 18 站
全部科研数据的汇聚点，泄露即全损；且与 TIER 04「本地 LoRA 处理未发表原始数据」
的零外泄承诺冲突。W2 让虫洞在**数据面**上是 P2P 的，服务端只做计费与审计。
"""

from __future__ import annotations

import hashlib
import json
import uuid as _uuid
from dataclasses import dataclass
from typing import Any, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import ensure_utc, now
from app.core.config import Settings
from app.core.errors import ErrorCode, MatrixError
from app.core.security.scopes import can_emit_station, parse_scope
from app.core.security.tokens import TokenSigner
from app.core.sites import HUB_SITE_KEY, is_known_site, known_site_keys, site_key_of_domain
from app.core.tracing import is_uuid
from app.models.wormhole import WormholeReceipt
from app.services import audit
from app.services.auth import issue_idt

# 这些键出现在请求体顶层即代表调用方试图把正文交给服务端（W2 违规）
FORBIDDEN_BODY_KEYS: tuple[str, ...] = (
    "payload",
    "data",
    "payload_data",
    "content",
    "body",
    "raw",
    "envelope_body",
)

# 键名含 "payload" 但属**元数据**的白名单（不当作正文拒绝）
META_BODY_KEYS: frozenset[str] = frozenset(
    {"payload_hash", "payload_size", "payload_type", "payload_data_hash"}
)

# verification_level 的强弱顺序：用于计算「本次投送的最高证据等级」
_LEVEL_ORDER: dict[str, int] = {
    "Level_B_Preprint": 1,
    "Level_A_Verified": 2,
    "Retracted_Warning": 3,
}


@dataclass(frozen=True)
class ReceiptResult:
    """收据落库结果（含一次性 mx_idt 明文，供目标站交换）。"""

    receipt_id: str
    trace_id: str
    payload_hash: str
    payload_data_hash: str
    evidence_count: int
    highest_verification_level: str
    matrix_uid: str
    source_app: str
    target_app: str
    payload_type: str
    created_at: str
    mx_idt: str
    mx_idt_expires_in: int
    deduplicated: bool = False


# ------------------------------------------------------------------ 哈希


def canonical_json(value: Any) -> str:
    """规范化 JSON：排序键 + 紧凑分隔符 + 不转义非 ASCII。

    调用方与服务端必须用同一套规范化规则，否则「同一份 payload」在两侧算出
    不同哈希，完整性校验会假报警。因此规则固化在代码里并由本函数唯一实现。
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def hash_payload(payload: Any) -> str:
    """``envelope.payload``（含 data + evidence_anchors）的 SHA-256。"""
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def hash_payload_data(data: Any) -> str:
    """``envelope.payload.data`` 的 SHA-256（大载荷「只传引用」时的二次校验）。"""
    return hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()


def count_levels(anchors: Sequence[dict]) -> tuple[dict[str, int], str]:
    """统计证据锚点的等级分布，并取「最高」等级。

    注意「最高」按**严重度**而非优良度：``Retracted_Warning`` 一旦出现即置顶，
    因为它必须在下游 UI 强制显示撤稿告警，不能被 Level_A 掩盖。
    """
    counts: dict[str, int] = {}
    for anchor in anchors or []:
        if not isinstance(anchor, dict):
            continue
        level = anchor.get("verification_level")
        if isinstance(level, str) and level in _LEVEL_ORDER:
            counts[level] = counts.get(level, 0) + 1
    return _highest_of(counts)


def count_levels_from_counts(counts: dict[str, int] | None) -> tuple[dict[str, int], str]:
    """仅凭等级计数推断「最高等级」（无 envelope 时的路径）。"""
    clean: dict[str, int] = {}
    for level, count in (counts or {}).items():
        if level in _LEVEL_ORDER:
            try:
                value = int(count)
            except (TypeError, ValueError):
                continue
            if value > 0:
                clean[level] = value
    return _highest_of(clean)


def _highest_of(counts: dict[str, int]) -> tuple[dict[str, int], str]:
    if not counts:
        return {}, "Level_B_Preprint"
    highest = max(counts, key=lambda item: (_LEVEL_ORDER[item], counts[item]))
    return counts, highest


# ------------------------------------------------------------------ 站点映射与 W3


def station_of_app(app_name: str) -> str:
    """``curvelab.matrixos.edu`` → ``curvelab``；无法识别时返回空串。"""
    if not app_name or not isinstance(app_name, str):
        return ""
    key = site_key_of_domain(app_name)
    if key and is_known_site(key):
        return key
    # 允许直接传 site_key（简化 hub / 测试调用）
    if app_name == HUB_SITE_KEY or app_name in known_site_keys():
        return app_name
    return ""


def assert_can_emit(scope: str | list[str], source_station: str) -> None:
    """W3 前置：只有源站具备 ``emit`` 才能发起投送。"""
    if not source_station:
        raise MatrixError(
            ErrorCode.WORMHOLE_INVALID_ENVELOPE,
            "source_app 无法映射到已注册站点，请使用 *.matrixos.edu 全域名或合法 site_key",
        )
    if not can_emit_station(scope, source_station):
        raise MatrixError(
            ErrorCode.WORMHOLE_RECEIPT_EMIT_DENIED,
            f"缺少站点 {source_station} 的 emit 权限，无法发起虫洞投送",
            log_extra={"station_id": source_station},
        )


def reject_payload_body(body: dict[str, Any]) -> None:
    """请求体里带正文键 → 显式 422（W2）。

    ``payload_hash`` / ``payload_size`` / ``payload_type`` / ``payload_data_hash``
    是元数据，键名含 "payload" 但按白名单放行。
    """
    for key in body:
        if key in META_BODY_KEYS:
            continue
        if key in FORBIDDEN_BODY_KEYS:
            raise MatrixError(
                ErrorCode.WORMHOLE_PAYLOAD_FORBIDDEN,
                f"服务端不接收 payload 正文（检测到字段 {key}）；"
                "请只提交哈希与元数据，正文由浏览器端 P2P 传递",
            )


# ------------------------------------------------------------------ 收据


async def create_receipt(
    session: AsyncSession,
    *,
    settings: Settings,
    signer: TokenSigner,
    matrix_uid: str,
    scope: str | list[str],
    trace_id: str,
    source_app: str,
    target_app: str,
    payload_type: str,
    evidence_count: int,
    payload_hash: str,
    payload_size: int = 0,
    verification_levels: dict[str, int] | None = None,
    target_accepts_payload_type: bool = True,
    envelope: Any | None = None,
    payload_data_hash: str | None = None,
) -> ReceiptResult:
    """落一条虫洞收据，并签发一次性 mx_idt（供目标站换 mx_at）。

    ``envelope`` 若提供，则**在内存中**重算哈希做二次校验，随后立即丢弃；
    正文绝不进入返回值、审计或数据库。

    幂等语义：同一 ``trace_id`` 重投不新建收据（trace 是投送的唯一标识），
    但仍签发新的 mx_idt —— 因为 idt 是一次性消耗品，重试往往是「上次的
    idt 已用掉/已过期」，此时必须能给客户端一个新凭证，否则重试永远失败。
    """
    if not is_uuid(trace_id):
        raise MatrixError(ErrorCode.WORMHOLE_INVALID_ENVELOPE, "trace_id 必须是 UUID")
    normalized_trace = trace_id.lower()

    source_station = station_of_app(source_app)
    target_station = station_of_app(target_app)
    assert_can_emit(scope, source_station)
    if not target_station:
        raise MatrixError(
            ErrorCode.WORMHOLE_INVALID_ENVELOPE,
            "target_app 无法映射到已注册站点（W3：只能投给声明过的目标）",
        )

    levels = dict(verification_levels or {})
    highest = "Level_B_Preprint"
    data_hash = payload_data_hash or payload_hash

    if envelope is not None:
        # 二次校验：客户端哈希必须与服务端重算一致（防篡改）
        recomputed = hash_payload(envelope.payload.model_dump())
        if recomputed != payload_hash:
            raise MatrixError(
                ErrorCode.WORMHOLE_INVALID_ENVELOPE,
                "payload_hash 与 envelope 重算结果不一致（正文可能在传输中被修改）",
            )
        data_hash = hash_payload_data(envelope.payload.data)
        levels, highest = count_levels(
            [anchor.model_dump() for anchor in envelope.payload.evidence_anchors]
        )
        evidence_count = len(envelope.payload.evidence_anchors)

    # W1：证据不可为空（schema 已有 minItems=1，这里是纵向双保险）
    if evidence_count < 1:
        raise MatrixError(
            ErrorCode.WORMHOLE_EVIDENCE_REQUIRED,
            "evidence_count 至少为 1（W1：证据不可为空）",
        )
    if envelope is None:
        levels, highest = count_levels_from_counts(levels)

    existing = await session.scalar(
        select(WormholeReceipt).where(WormholeReceipt.trace_id == normalized_trace)
    )
    if existing is not None:
        mx_idt, ttl = await issue_idt(
            session,
            settings=settings,
            signer=signer,
            matrix_uid=matrix_uid,
            target_station=existing.target_station,
            trace_id=existing.trace_id,
            payload_hash=existing.payload_hash,
        )
        return _result_of(existing, mx_idt=mx_idt, ttl=ttl, deduplicated=True)

    receipt = WormholeReceipt(
        trace_id=normalized_trace,
        matrix_uid=matrix_uid,
        source_app=source_app,
        target_app=target_app,
        source_station=source_station,
        target_station=target_station,
        payload_type=payload_type,
        payload_hash=payload_hash,
        payload_data_hash=data_hash,
        payload_size=payload_size,
        evidence_count=evidence_count,
        verification_levels=levels,
        highest_verification_level=highest,
        target_accepts_declared=target_accepts_payload_type,
        scope_used=" ".join(sorted({str(item) for item in parse_scope(scope)})),
    )
    session.add(receipt)
    await session.flush()

    mx_idt, ttl = await issue_idt(
        session,
        settings=settings,
        signer=signer,
        matrix_uid=matrix_uid,
        target_station=target_station,
        trace_id=normalized_trace,
        payload_hash=payload_hash,
    )

    await audit.record(
        session,
        action="wormhole.receipt_created",
        matrix_uid=matrix_uid,
        station_id=source_station,
        trace_id=normalized_trace,
        detail={
            "receipt_id": str(receipt.receipt_id),
            "payload_type": payload_type,
            # 只记哈希与计数，绝不记正文（W2）
            "payload_hash": payload_hash,
            "payload_size": payload_size,
            "evidence_count": evidence_count,
            "target_station": target_station,
        },
    )
    await session.flush()
    return _result_of(receipt, mx_idt=mx_idt, ttl=ttl, deduplicated=False)


def _result_of(
    receipt: WormholeReceipt, *, mx_idt: str, ttl: int, deduplicated: bool
) -> ReceiptResult:
    return ReceiptResult(
        receipt_id=str(receipt.receipt_id),
        trace_id=receipt.trace_id,
        payload_hash=receipt.payload_hash,
        payload_data_hash=receipt.payload_data_hash,
        evidence_count=receipt.evidence_count,
        highest_verification_level=receipt.highest_verification_level,
        matrix_uid=receipt.matrix_uid,
        source_app=receipt.source_app,
        target_app=receipt.target_app,
        payload_type=receipt.payload_type,
        created_at=_iso(receipt.created_at),
        mx_idt=mx_idt,
        mx_idt_expires_in=ttl,
        deduplicated=deduplicated,
    )


def _iso(moment: Any) -> str:
    return ensure_utc(moment).isoformat() if moment is not None else ""


# ------------------------------------------------------------------ 读


async def get_receipt(
    session: AsyncSession, *, matrix_uid: str, receipt_id: str
) -> WormholeReceipt:
    """按 receipt_id 读收据：仅本人可见（跨用户返回 404，不泄漏存在性）。"""
    try:
        parsed = _uuid.UUID(str(receipt_id))
    except (ValueError, AttributeError, TypeError):
        raise MatrixError(ErrorCode.WORMHOLE_RECEIPT_NOT_FOUND, "收据不存在") from None
    receipt = await session.get(WormholeReceipt, parsed)
    if receipt is None or receipt.matrix_uid != matrix_uid:
        raise MatrixError(ErrorCode.WORMHOLE_RECEIPT_NOT_FOUND, "收据不存在")
    return receipt


async def list_receipts(
    session: AsyncSession,
    *,
    matrix_uid: str,
    limit: int = 20,
    offset: int = 0,
    trace_id: str | None = None,
) -> tuple[list[WormholeReceipt], int]:
    """列出本人收据（审计视角：谁在何时把哪条数据投给了哪个站）。"""
    conditions = [WormholeReceipt.matrix_uid == matrix_uid]
    if trace_id and is_uuid(trace_id):
        conditions.append(WormholeReceipt.trace_id == trace_id.lower())

    total = await session.scalar(
        select(func.count()).select_from(WormholeReceipt).where(*conditions)
    )
    result = await session.execute(
        select(WormholeReceipt)
        .where(*conditions)
        .order_by(WormholeReceipt.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(result.scalars().all()), int(total or 0)


def receipt_to_public(receipt: WormholeReceipt) -> dict[str, Any]:
    """对外视图：**永不含 payload 正文**（连字段都不存在）。"""
    return {
        "receipt_id": str(receipt.receipt_id),
        "trace_id": receipt.trace_id,
        "matrix_uid": receipt.matrix_uid,
        "source_app": receipt.source_app,
        "target_app": receipt.target_app,
        "source_station": receipt.source_station,
        "target_station": receipt.target_station,
        "payload_type": receipt.payload_type,
        "payload_hash": receipt.payload_hash,
        "payload_data_hash": receipt.payload_data_hash,
        "payload_size": receipt.payload_size,
        "evidence_count": receipt.evidence_count,
        "verification_levels": receipt.verification_levels or {},
        "highest_verification_level": receipt.highest_verification_level,
        "target_accepts_declared": receipt.target_accepts_declared,
        "created_at": _iso(receipt.created_at),
    }


def now_iso() -> str:
    return now().isoformat()


__all__ = [
    "FORBIDDEN_BODY_KEYS",
    "META_BODY_KEYS",
    "ReceiptResult",
    "assert_can_emit",
    "canonical_json",
    "count_levels",
    "count_levels_from_counts",
    "create_receipt",
    "get_receipt",
    "hash_payload",
    "hash_payload_data",
    "list_receipts",
    "now_iso",
    "receipt_to_public",
    "reject_payload_body",
    "station_of_app",
]
