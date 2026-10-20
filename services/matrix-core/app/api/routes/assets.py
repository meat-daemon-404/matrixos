"""``/v1/assets/*`` 路由（S1-11 / S1-12）。

端点清单：
- ``POST   /assets``                    创建（scope 必须含该站 write）
- ``GET    /assets``                    列表（仅本人 + 有 read 权限的站）
- ``GET    /assets/{asset_id}``         详情（含 chunks 与一跳邻居）
- ``PATCH  /assets/{asset_id}``         更新（乐观锁 expected_version）
- ``DELETE /assets/{asset_id}``         删除（级联 chunks + 边）
- ``POST   /assets/search``             向量检索（pgvector / 降级路径）
- ``POST   /assets/{asset_id}/edges``   手工补边
- ``POST   /assets/graph/infer``        边推断（幂等）
- ``GET    /assets/{asset_id}/trace``   多跳溯源（默认 2 跳）

**越权防线**：所有操作都经 ``IdentityDep``（验签 + 吊销 + epoch），
再在 service 层用 ``assert_can_read`` / ``assert_can_write`` 判 scope，
最后用 ``matrix_uid == 当前用户`` 过滤数据行。三层缺一不可。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, status

from app.api.security import IdentityDep
from app.api.deps import SessionDep, SettingsDep
from app.schemas.assets import (
    AssetCreateRequest,
    AssetDetailOut,
    AssetEdgeOut,
    AssetListResponse,
    AssetOut,
    AssetUpdateRequest,
    EdgeCreateRequest,
    EdgeInferenceRequest,
    EdgeInferenceResponse,
    SearchRequest,
    SearchResponse,
    TraceResponse,
)
from app.services import assets as asset_service
from app.services import graph as graph_service
from app.services.embedding import get_embedding_provider

router = APIRouter(prefix="/assets", tags=["assets"])


# ------------------------------------------------------------------ CRUD


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    summary="创建资产节点（写入 + 切片在同一事务）",
    response_model=AssetDetailOut,
)
async def create_asset(
    session: SessionDep,
    settings: SettingsDep,
    identity: IdentityDep,
    payload: AssetCreateRequest,
) -> AssetDetailOut:
    node = await asset_service.create_asset(
        session,
        settings=settings,
        provider=get_embedding_provider(),
        scope=identity.scope,
        matrix_uid=identity.matrix_uid,
        station_id=payload.station_id,
        asset_type=payload.asset_type,
        title=payload.title,
        payload=payload.payload,
        evidence_anchors=[anchor.model_dump() for anchor in payload.evidence_anchors],
        verification_level=payload.verification_level,
        trace_id=payload.trace_id,
    )
    await session.commit()
    await session.refresh(node)
    return AssetDetailOut(**asset_service.asset_to_dict(node), chunks=[], edges_out=[], edges_in=[])


@router.get("", summary="列出本人资产（按创建时间倒序）", response_model=AssetListResponse)
async def list_assets(
    session: SessionDep,
    identity: IdentityDep,
    station_ids: Annotated[list[str] | None, Query()] = None,
    asset_types: Annotated[list[str] | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AssetListResponse:
    nodes, total = await asset_service.list_assets(
        session,
        scope=identity.scope,
        matrix_uid=identity.matrix_uid,
        station_ids=station_ids,
        asset_types=asset_types,
        limit=limit,
        offset=offset,
    )
    return AssetListResponse(
        items=[AssetOut(**asset_service.asset_to_dict(node)) for node in nodes],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{asset_id}", summary="资产详情（含切片与一跳邻居）", response_model=AssetDetailOut)
async def get_asset(
    session: SessionDep,
    identity: IdentityDep,
    asset_id: str,
) -> AssetDetailOut:
    node = await asset_service.get_asset(
        session, scope=identity.scope, matrix_uid=identity.matrix_uid, asset_id=asset_id
    )
    edges_out, edges_in = await asset_service.list_edges(session, asset_id=str(node.asset_id))
    data = asset_service.asset_to_dict(node)
    return AssetDetailOut(
        **data,
        chunks=[
            {
                "chunk_id": str(chunk.chunk_id),
                "chunk_index": chunk.chunk_index,
                "content": chunk.content,
                "has_embedding": chunk.embedding is not None,
            }
            for chunk in (node.chunks or [])
        ],
        edges_out=[AssetEdgeOut(**asset_service.edge_to_dict(edge)) for edge in edges_out],
        edges_in=[AssetEdgeOut(**asset_service.edge_to_dict(edge)) for edge in edges_in],
    )


@router.patch("/{asset_id}", summary="更新资产（乐观锁）", response_model=AssetDetailOut)
async def update_asset(
    session: SessionDep,
    settings: SettingsDep,
    identity: IdentityDep,
    asset_id: str,
    payload: AssetUpdateRequest,
) -> AssetDetailOut:
    node = await asset_service.update_asset(
        session,
        settings=settings,
        provider=get_embedding_provider(),
        scope=identity.scope,
        matrix_uid=identity.matrix_uid,
        asset_id=asset_id,
        title=payload.title,
        payload=payload.payload,
        evidence_anchors=(
            [anchor.model_dump() for anchor in payload.evidence_anchors]
            if payload.evidence_anchors is not None
            else None
        ),
        verification_level=payload.verification_level,
        expected_version=payload.expected_version,
        trace_id=payload.trace_id,
    )
    await session.commit()
    await session.refresh(node)
    edges_out, edges_in = await asset_service.list_edges(session, asset_id=str(node.asset_id))
    return AssetDetailOut(
        **asset_service.asset_to_dict(node),
        chunks=[
            {
                "chunk_id": str(chunk.chunk_id),
                "chunk_index": chunk.chunk_index,
                "content": chunk.content,
                "has_embedding": chunk.embedding is not None,
            }
            for chunk in (node.chunks or [])
        ],
        edges_out=[AssetEdgeOut(**asset_service.edge_to_dict(edge)) for edge in edges_out],
        edges_in=[AssetEdgeOut(**asset_service.edge_to_dict(edge)) for edge in edges_in],
    )


@router.delete(
    "/{asset_id}", status_code=status.HTTP_204_NO_CONTENT, summary="删除资产（级联切片与边）"
)
async def delete_asset(session: SessionDep, identity: IdentityDep, asset_id: str) -> None:
    await asset_service.delete_asset(
        session, scope=identity.scope, matrix_uid=identity.matrix_uid, asset_id=asset_id
    )
    await session.commit()


# ------------------------------------------------------------------ 向量检索


@router.post(
    "/search", summary="pgvector 语义检索（权限条件在候选集之前）", response_model=SearchResponse
)
async def search_assets(
    session: SessionDep,
    identity: IdentityDep,
    payload: SearchRequest,
) -> SearchResponse:
    hits, total, model = await asset_service.search_assets(
        session,
        provider=get_embedding_provider(),
        scope=identity.scope,
        matrix_uid=identity.matrix_uid,
        query=payload.query,
        top_k=payload.top_k,
        station_ids=payload.station_ids,
        asset_types=payload.asset_types,
        min_score=payload.min_score,
    )
    return SearchResponse(
        query=payload.query,
        top_k=payload.top_k,
        hits=[hit.__dict__ for hit in hits],
        total_candidates=total,
        embedding_model=model,
    )


# ------------------------------------------------------------------ 图：边与溯源


@router.post(
    "/{asset_id}/edges",
    status_code=status.HTTP_201_CREATED,
    summary="手工补边（自动化只产 derived_from / cites / evidences）",
    response_model=AssetEdgeOut | None,
)
async def create_edge(
    session: SessionDep,
    identity: IdentityDep,
    asset_id: str,
    payload: EdgeCreateRequest,
) -> AssetEdgeOut | None:
    """已存在同一 (from, to, relation) 三元组时返回 ``null``（幂等）。"""
    edge = await asset_service.create_edge(
        session,
        scope=identity.scope,
        matrix_uid=identity.matrix_uid,
        from_asset_id=asset_id,
        to_asset_id=payload.to_asset_id,
        relation=payload.relation,
        weight=payload.weight,
        evidence_ref=payload.evidence_ref,
    )
    await session.commit()
    if edge is None:
        return None
    return AssetEdgeOut(**asset_service.edge_to_dict(edge))


@router.post(
    "/graph/infer",
    summary="对本人资产跑一次边推断（幂等：重复跑不产生重复边）",
    response_model=EdgeInferenceResponse,
)
async def infer_edges(
    session: SessionDep,
    identity: IdentityDep,
    payload: EdgeInferenceRequest,
) -> EdgeInferenceResponse:
    report = await graph_service.infer_edges(
        session,
        matrix_uid=identity.matrix_uid,
        station_ids=payload.station_ids,
        asset_ids=payload.asset_ids,
        dry_run=payload.dry_run,
    )
    if not payload.dry_run:
        await session.commit()
    return EdgeInferenceResponse(**report.as_dict())


@router.get(
    "/{asset_id}/trace",
    summary="多跳溯源（默认 2 跳：拟合结果 → 论文与证据锚点）",
    response_model=TraceResponse,
)
async def trace_asset(
    session: SessionDep,
    identity: IdentityDep,
    asset_id: str,
    max_hops: Annotated[int, Query(ge=1, le=5)] = 2,
) -> TraceResponse:
    root = await asset_service.get_asset(
        session, scope=identity.scope, matrix_uid=identity.matrix_uid, asset_id=asset_id
    )
    paths = await graph_service.trace_two_hops(
        session,
        matrix_uid=identity.matrix_uid,
        root=root,
        max_hops=max_hops,
    )
    return TraceResponse(asset_id=str(root.asset_id), max_hops=max_hops, paths=paths)
