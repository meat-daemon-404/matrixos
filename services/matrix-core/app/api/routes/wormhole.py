"""``/v1/wormhole/*`` 路由（architecture §5.2 / W2 铁律 / S1-09）。

端点清单：
- ``POST /wormhole/receipt``          落收据 + 签发一次性 mx_idt
- ``GET  /wormhole/receipt/{id}``     查收据（**永不含 payload 正文**）
- ``GET  /wormhole/receipts``         列本人收据（审计视角）
- ``POST /wormhole/validate``         仅校验 envelope（不落库，供 SDK 预检）

**W2 在此处的两条落地**：
1. ``POST /receipt`` 的请求体若带 ``payload`` 等正文字段 → 422 显式拒绝；
2. 所有响应的 schema 里根本没有正文字段，连「意外带出」的可能性都不存在。
"""

from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, status

from app.api.deps import SessionDep, SettingsDep, SignerDep
from app.api.security import IdentityDep
from app.schemas.wormhole import (
    WormholeEnvelope,
    WormholeReceiptPublic,
    WormholeReceiptRequest,
    WormholeReceiptResponse,
)
from app.services import wormhole as wormhole_service

router = APIRouter(prefix="/wormhole", tags=["wormhole"])


@router.post(
    "/receipt",
    status_code=status.HTTP_201_CREATED,
    summary="落虫洞收据（只存哈希与元数据）+ 签发一次性 mx_idt",
    response_model=WormholeReceiptResponse,
)
async def create_receipt(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    signer: SignerDep,
    identity: IdentityDep,
    payload: WormholeReceiptRequest,
) -> WormholeReceiptResponse:
    """W2：服务端只存哈希与元数据，绝不存 payload 正文。

    请求体带 ``payload`` / ``data`` 等正文字段时返回 422
    （``wormhole.payload_forbidden``）——刻意不「忽略」，因为静默忽略会让
    调用方误以为正文已被接收。

    **为什么读原始请求体而不是加一个 ``Body()`` 参数**：FastAPI 会把同一个
    JSON body 的多个模型参数**合并**成一个 object schema 再生成本次请求的
    校验模型——于是 ``WormholeReceiptRequest`` 的全部字段被误判为必填，
    只传元数据的正常请求会 422，而 W2 的正文检查却永远拿不到 body。
    读原始字节既保住了真实的模型校验，又让正文检查真正生效。
    """
    raw = await request.body()
    if raw.strip():
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            parsed = None
        if isinstance(parsed, dict):
            wormhole_service.reject_payload_body(parsed)

    result = await wormhole_service.create_receipt(
        session,
        settings=settings,
        signer=signer,
        matrix_uid=identity.matrix_uid,
        scope=identity.scope,
        trace_id=payload.trace_id,
        source_app=payload.source_app,
        target_app=payload.target_app,
        payload_type=payload.payload_type,
        evidence_count=payload.evidence_count,
        payload_hash=payload.payload_hash,
        payload_size=payload.payload_size,
        verification_levels=payload.verification_levels,
        target_accepts_payload_type=payload.target_accepts_payload_type,
        envelope=payload.envelope,
    )
    await session.commit()
    return WormholeReceiptResponse(
        receipt_id=result.receipt_id,
        trace_id=result.trace_id,
        source_app=result.source_app,
        target_app=result.target_app,
        payload_type=result.payload_type,
        payload_hash=result.payload_hash,
        evidence_count=result.evidence_count,
        highest_verification_level=result.highest_verification_level,
        created_at=result.created_at,
        matrix_uid=result.matrix_uid,
        mx_idt=result.mx_idt,
        mx_idt_expires_in=result.mx_idt_expires_in,
    )


@router.get(
    "/receipt/{receipt_id}",
    summary="查收据（仅本人；永不含 payload 正文）",
    response_model=WormholeReceiptPublic,
)
async def get_receipt(
    session: SessionDep,
    identity: IdentityDep,
    receipt_id: str,
) -> WormholeReceiptPublic:
    receipt = await wormhole_service.get_receipt(
        session, matrix_uid=identity.matrix_uid, receipt_id=receipt_id
    )
    return WormholeReceiptPublic(**wormhole_service.receipt_to_public(receipt))


@router.get(
    "/receipts",
    summary="列本人收据（审计：谁在何时把哪条数据投给了哪个站）",
    response_model=dict,
)
async def list_receipts(
    session: SessionDep,
    identity: IdentityDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    trace_id: Annotated[str | None, Query()] = None,
) -> dict:
    receipts, total = await wormhole_service.list_receipts(
        session,
        matrix_uid=identity.matrix_uid,
        limit=limit,
        offset=offset,
        trace_id=trace_id,
    )
    return {
        "items": [wormhole_service.receipt_to_public(item) for item in receipts],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.post(
    "/validate",
    summary="仅校验 envelope（不落库）；供 SDK 投送前预检",
    response_model=dict,
)
async def validate_envelope(
    identity: IdentityDep,
    payload: WormholeEnvelope,
) -> dict:
    """校验三件事：W1 证据非空、矩阵身份一致、payload 类型合法。

    不写库、不发 idt —— 这是「投送前先问一声」的轻量路径。
    """
    _ = identity
    anchors = payload.payload.evidence_anchors
    levels, highest = wormhole_service.count_levels(
        [anchor.model_dump() for anchor in anchors]
    )
    return {
        "valid": True,
        "trace_id": payload.trace_id,
        "payload_type": payload.payload_type,
        "evidence_count": len(anchors),
        "verification_levels": levels,
        "highest_verification_level": highest,
        "payload_hash": wormhole_service.hash_payload(payload.payload.model_dump()),
        "payload_data_hash": wormhole_service.hash_payload_data(payload.payload.data),
        "source_station": wormhole_service.station_of_app(payload.source_app),
        "target_station": wormhole_service.station_of_app(payload.target_app),
    }
