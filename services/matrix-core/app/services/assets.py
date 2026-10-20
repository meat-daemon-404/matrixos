"""资产图谱服务（S1-11 / S1-12）。

三条硬约束：
1. **权限在 SQL 层过滤**（ADR-04 的核心论点）：向量检索的 WHERE 里必带
   ``matrix_uid == 当前用户`` 与 scope 允许的 ``station_id``，绝不先取 top-k 再在
   应用层过滤（那样会泄漏存在性并让越权数据占据候选位）；
2. **写入走事务**：node + chunks 在同一事务内提交，失败不留半条数据；
3. **不在 payload 里制造契约外字段**：payload 原样存取，校验交给 schema 层。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import now, ts_of
from app.core.config import Settings
from app.core.errors import ErrorCode, MatrixError
from app.core.security.scopes import parse_scope, scopes_for_station
from app.core.sites import known_site_keys
from app.core.tracing import get_trace_id, is_uuid
from app.db.base import is_postgres, vector_literal
from app.models.assets import AssetChunk, AssetEdge, AssetNode
from app.services import audit
from app.services.embedding import EmbeddingProvider, chunk_text, cosine_similarity


@dataclass(frozen=True)
class SearchResult:
    chunk_id: str
    asset_id: str
    chunk_index: int
    content: str
    score: float
    station_id: str
    asset_type: str
    title: str
    matrix_uid: str
    verification_level: str


# ------------------------------------------------------------------ 权限


def readable_stations(scope: str | list[str]) -> set[str]:
    """当前身份可读的站点集合（read 或 write 均含读权限）。"""
    stations: set[str] = set()
    for item in parse_scope(scope):
        if item == "admin:*":
            return set(known_site_keys())
        parts = item.split(":")
        if len(parts) == 3 and parts[0] == "station" and parts[2] in {"read", "write", "emit"}:
            stations.add(parts[1])
    return stations


def writable_stations(scope: str | list[str]) -> set[str]:
    """可写站点集合：只有 write 动词（emit 不等于写权限）。"""
    stations: set[str] = set()
    for item in parse_scope(scope):
        if item == "admin:*":
            return set(known_site_keys())
        parts = item.split(":")
        if len(parts) == 3 and parts[0] == "station" and parts[2] == "write":
            stations.add(parts[1])
    return stations


def assert_can_read(scope: str | list[str], station_id: str) -> None:
    if station_id not in readable_stations(scope):
        raise MatrixError(
            ErrorCode.ASSET_FORBIDDEN,
            f"缺少站点 {station_id} 的读权限",
            log_extra={"station_id": station_id, "scope": parse_scope(scope)},
        )


def assert_can_write(scope: str | list[str], station_id: str) -> None:
    if station_id not in writable_stations(scope):
        raise MatrixError(
            ErrorCode.ASSET_FORBIDDEN,
            f"缺少站点 {station_id} 的写权限",
            log_extra={"station_id": station_id, "scope": parse_scope(scope)},
        )


def verbs_for(scope: str | list[str], station_id: str) -> set[str]:
    return scopes_for_station(scope, station_id)


# ------------------------------------------------------------------ 序列化


def _iso(moment: Any) -> str:
    if moment is None:
        return ""
    from app.core.clock import ensure_utc

    return ensure_utc(moment).isoformat()


def asset_to_dict(asset: AssetNode, *, chunk_count: int | None = None) -> dict[str, Any]:
    return {
        "asset_id": str(asset.asset_id),
        "matrix_uid": asset.matrix_uid,
        "station_id": asset.station_id,
        "asset_type": asset.asset_type,
        "title": asset.title,
        "payload": asset.payload or {},
        "evidence_anchors": asset.evidence_anchors or [],
        "verification_level": asset.verification_level,
        "trace_id": str(asset.trace_id) if asset.trace_id else None,
        "version": asset.version,
        "created_at": _iso(asset.created_at),
        "updated_at": _iso(asset.updated_at),
        "chunk_count": chunk_count if chunk_count is not None else len(asset.chunks or []),
    }


def edge_to_dict(edge: AssetEdge) -> dict[str, Any]:
    return {
        "edge_id": str(edge.edge_id),
        "from_asset_id": str(edge.from_asset_id),
        "to_asset_id": str(edge.to_asset_id),
        "relation": edge.relation,
        "weight": float(edge.weight),
        "inference": edge.inference,
        "evidence_ref": edge.evidence_ref,
        "created_at": _iso(edge.created_at),
    }


# ------------------------------------------------------------------ 文本与切片


def build_search_text(asset_type: str, title: str, payload: dict, anchors: Sequence[dict]) -> str:
    """把结构化资产压成可检索的纯文本（title + payload 关键标量 + 证据来源）。"""
    parts: list[str] = [title or "", asset_type.replace("_", " ")]
    parts.extend(_flatten_scalars(payload))
    for anchor in anchors or []:
        source = anchor.get("source_doi_or_url") if isinstance(anchor, dict) else None
        if source:
            parts.append(str(source))
        level = anchor.get("verification_level") if isinstance(anchor, dict) else None
        if level:
            parts.append(str(level))
    return "\n".join(part for part in parts if part).strip()


def _flatten_scalars(value: Any, *, prefix: str = "", depth: int = 0) -> list[str]:
    """只取标量做索引，避免把整个 jsonb 塑形成超长文本。"""
    if depth > 4:
        return []
    out: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            out.extend(_flatten_scalars(item, prefix=str(key), depth=depth + 1))
    elif isinstance(value, (list, tuple)):
        for item in value[:20]:
            out.extend(_flatten_scalars(item, prefix=prefix, depth=depth + 1))
    elif isinstance(value, bool):
        out.append(f"{prefix}:{str(value).lower()}")
    elif isinstance(value, (int, float, str)) and str(value).strip():
        text = str(value)
        out.append(f"{prefix}:{text}" if prefix else text)
    return out


def build_chunks(
    text: str, *, settings: Settings, provider: EmbeddingProvider
) -> list[tuple[int, str, list[float]]]:
    pieces = chunk_text(text, size=settings.chunk_size, overlap=settings.chunk_overlap)
    pieces = pieces[: settings.max_chunks_per_asset]
    return [(index, piece, provider.embed(piece)) for index, piece in enumerate(pieces)]


# ------------------------------------------------------------------ 写


async def create_asset(
    session: AsyncSession,
    *,
    settings: Settings,
    provider: EmbeddingProvider,
    scope: str | list[str],
    matrix_uid: str,
    station_id: str,
    asset_type: str,
    title: str,
    payload: dict,
    evidence_anchors: list[dict],
    verification_level: str,
    trace_id: str | None = None,
) -> AssetNode:
    """创建资产（node + chunks 同一事务）。"""
    assert_can_write(scope, station_id)

    # ── 合规红线：证据锚点至少 1 条（ADR-000 / wormhole-envelope minItems:1）──
    #
    # 为什么校验放在这里而不是 Pydantic schema：
    # FastAPI 在绑定请求体时就跑 schema 校验，**早于**上面的 assert_can_write。
    # 若放在 schema 层，无权用户会收到 422 而非 403 —— 越权必须先被拒绝，
    # 不能让数据校验抢先（既泄露字段约束，也破坏安全语义）。
    #
    # 为什么这条校验必须存在（2026-10-20 实测）：
    # 原实现的 `_level_consistency` validator 是空壳，`POST /v1/assets`
    # 传 `evidence_anchors: []` 仍能 201 成功，资产入库后无法溯源。
    # 这比 wormhole 端点更危险 —— 虫洞端点至少校验了 evidence_count >= 1，
    # 而资产是长期沉淀的那一侧。
    if not evidence_anchors:
        raise MatrixError(
            ErrorCode.VALIDATION_FAILED,
            "evidence_anchors 不能为空：每个科研资产必须至少绑定 1 条证据锚点"
            "（source_doi_or_url + verification_level），这是 v3 的合规红线",
            status_code=422,
        )

    asset_id = uuid.uuid4()
    search_text = build_search_text(asset_type, title, payload, evidence_anchors)
    node = AssetNode(
        asset_id=asset_id,
        matrix_uid=matrix_uid,
        station_id=station_id,
        asset_type=asset_type,
        title=title,
        payload=payload,
        evidence_anchors=evidence_anchors,
        verification_level=_derive_verification_level(verification_level, evidence_anchors),
        trace_id=_coerce_uuid(trace_id) or _coerce_uuid(get_trace_id()),
        version=1,
        search_text=search_text,
    )
    session.add(node)
    await session.flush()

    for index, content, embedding in build_chunks(search_text, settings=settings, provider=provider):
        session.add(
            AssetChunk(
                chunk_id=uuid.uuid4(),
                asset_id=asset_id,
                chunk_index=index,
                content=content,
                embedding=embedding,
            )
        )

    await audit.record(
        session,
        action="asset.created",
        matrix_uid=matrix_uid,
        station_id=station_id,
        detail={
            "asset_id": str(asset_id),
            "asset_type": asset_type,
            "evidence_count": len(evidence_anchors),
            "payload_hash": _payload_digest(payload),
        },
        trace_id=trace_id if is_uuid(trace_id) else None,
    )
    await session.flush()
    return node


def _derive_verification_level(declared: str, anchors: Sequence[dict]) -> str:
    """资产等级不得高于其证据锚点的最低等级（防止虚报 Level_A）。"""
    order = {"Level_B_Preprint": 1, "Level_A_Verified": 2, "Retracted_Warning": 3}
    levels = [
        anchor.get("verification_level")
        for anchor in anchors or []
        if isinstance(anchor, dict) and anchor.get("verification_level") in order
    ]
    if not levels:
        return declared
    if "Retracted_Warning" in levels:
        return "Retracted_Warning"
    weakest = min(levels, key=lambda item: order[item])
    if order.get(declared, 0) > order[weakest]:
        return weakest
    return declared


def _payload_digest(payload: Any) -> str:
    import hashlib
    import json

    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _coerce_uuid(value: Any) -> uuid.UUID | None:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    if isinstance(value, str) and is_uuid(value):
        return uuid.UUID(value)
    return None


async def get_asset(
    session: AsyncSession,
    *,
    scope: str | list[str],
    matrix_uid: str,
    asset_id: str,
) -> AssetNode:
    """读取资产：仅本人 + 该站读权限。跨用户与跨站都返回 404/403。"""
    asset = await _load_asset(session, asset_id)
    if asset.matrix_uid != matrix_uid:
        # 不泄漏「该 id 存在」这一信息
        raise MatrixError(ErrorCode.ASSET_NOT_FOUND, "资产不存在")
    assert_can_read(scope, asset.station_id)
    return asset


async def _load_asset(session: AsyncSession, asset_id: str) -> AssetNode:
    parsed = _coerce_uuid(asset_id)
    if parsed is None:
        raise MatrixError(ErrorCode.ASSET_NOT_FOUND, "资产不存在")
    asset = await session.get(AssetNode, parsed)
    if asset is None:
        raise MatrixError(ErrorCode.ASSET_NOT_FOUND, "资产不存在")
    return asset


async def update_asset(
    session: AsyncSession,
    *,
    settings: Settings,
    provider: EmbeddingProvider,
    scope: str | list[str],
    matrix_uid: str,
    asset_id: str,
    title: str | None = None,
    payload: dict | None = None,
    evidence_anchors: list[dict] | None = None,
    verification_level: str | None = None,
    expected_version: int | None = None,
    trace_id: str | None = None,
) -> AssetNode:
    """更新资产：乐观锁 + 重建切片（同一事务）。"""
    asset = await get_asset(
        session, scope=scope, matrix_uid=matrix_uid, asset_id=asset_id
    )
    assert_can_write(scope, asset.station_id)

    if expected_version is not None and asset.version != expected_version:
        raise MatrixError(
            ErrorCode.ASSET_VERSION_CONFLICT,
            f"版本冲突：期望 {expected_version}，实际 {asset.version}",
        )

    if title is not None:
        asset.title = title
    if payload is not None:
        asset.payload = payload
    if evidence_anchors is not None:
        asset.evidence_anchors = evidence_anchors
    if verification_level is not None:
        asset.verification_level = _derive_verification_level(
            verification_level, asset.evidence_anchors or []
        )
    elif evidence_anchors is not None:
        asset.verification_level = _derive_verification_level(
            asset.verification_level, asset.evidence_anchors or []
        )

    asset.version = (asset.version or 1) + 1
    asset.search_text = build_search_text(
        asset.asset_type, asset.title, asset.payload or {}, asset.evidence_anchors or []
    )
    asset.updated_at = now()

    # 重建切片：先删后插（同一事务内）
    await session.execute(delete(AssetChunk).where(AssetChunk.asset_id == asset.asset_id))
    for index, content, embedding in build_chunks(
        asset.search_text, settings=settings, provider=provider
    ):
        session.add(
            AssetChunk(
                chunk_id=uuid.uuid4(),
                asset_id=asset.asset_id,
                chunk_index=index,
                content=content,
                embedding=embedding,
            )
        )

    await audit.record(
        session,
        action="asset.updated",
        matrix_uid=matrix_uid,
        station_id=asset.station_id,
        detail={"asset_id": str(asset.asset_id), "version": asset.version},
        trace_id=trace_id if is_uuid(trace_id) else None,
    )
    await session.flush()
    await session.refresh(asset)
    return asset


async def delete_asset(
    session: AsyncSession,
    *,
    scope: str | list[str],
    matrix_uid: str,
    asset_id: str,
) -> None:
    """删除资产（级联删除 chunks 与相关边）。"""
    asset = await get_asset(
        session, scope=scope, matrix_uid=matrix_uid, asset_id=asset_id
    )
    assert_can_write(scope, asset.station_id)
    await session.execute(
        delete(AssetEdge).where(
            (AssetEdge.from_asset_id == asset.asset_id)
            | (AssetEdge.to_asset_id == asset.asset_id)
        )
    )
    await session.execute(delete(AssetChunk).where(AssetChunk.asset_id == asset.asset_id))
    await session.delete(asset)
    await audit.record(
        session,
        action="asset.deleted",
        matrix_uid=matrix_uid,
        station_id=asset.station_id,
        detail={"asset_id": str(asset.asset_id)},
    )
    await session.flush()


async def list_assets(
    session: AsyncSession,
    *,
    scope: str | list[str],
    matrix_uid: str,
    station_ids: list[str] | None = None,
    asset_types: list[str] | None = None,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[AssetNode], int]:
    """列出本人资产；只能看有 read 权限的站。"""
    readable = readable_stations(scope)
    if not readable:
        raise MatrixError(ErrorCode.ASSET_FORBIDDEN, "当前身份没有任何站的读权限")

    wanted = set(station_ids) - readable if station_ids else readable
    if station_ids:
        denied = set(station_ids) - readable
        if denied:
            raise MatrixError(
                ErrorCode.ASSET_FORBIDDEN,
                f"缺少站点 {sorted(denied)} 的读权限",
            )
        wanted = set(station_ids)

    conditions = [AssetNode.matrix_uid == matrix_uid, AssetNode.station_id.in_(wanted)]
    if asset_types:
        conditions.append(AssetNode.asset_type.in_(asset_types))

    total = await session.scalar(
        select(func.count()).select_from(AssetNode).where(*conditions)
    )
    result = await session.execute(
        select(AssetNode)
        .where(*conditions)
        .order_by(AssetNode.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(result.scalars().all()), int(total or 0)


# ------------------------------------------------------------------ 向量检索


async def search_assets(
    session: AsyncSession,
    *,
    provider: EmbeddingProvider,
    scope: str | list[str],
    matrix_uid: str,
    query: str,
    top_k: int,
    station_ids: list[str] | None = None,
    asset_types: list[str] | None = None,
    min_score: float = 0.0,
) -> tuple[list[SearchResult], int, str]:
    """pgvector 语义检索。

    PostgreSQL 走 ``embedding <=> :query``（HNSW 索引生效）的 SQL 排序；
    其他方言走 Python 余弦计算（口径一致，仅失去索引加速）。
    **权限条件始终在候选集之前**（SQL WHERE 里），不存在「先取全库再过滤」的越权窗口。
    """
    readable = readable_stations(scope)
    if not readable:
        raise MatrixError(ErrorCode.ASSET_FORBIDDEN, "当前身份没有任何站的读权限")

    if station_ids:
        denied = set(station_ids) - readable
        if denied:
            raise MatrixError(
                ErrorCode.ASSET_FORBIDDEN, f"缺少站点 {sorted(denied)} 的读权限"
            )
        targets = set(station_ids)
    else:
        targets = readable

    query_vector = provider.embed(query)
    conditions = [
        AssetNode.matrix_uid == matrix_uid,
        AssetNode.station_id.in_(targets),
    ]
    if asset_types:
        conditions.append(AssetNode.asset_type.in_(asset_types))

    total_candidates = await session.scalar(
        select(func.count())
        .select_from(AssetChunk)
        .join(AssetNode, AssetNode.asset_id == AssetChunk.asset_id)
        .where(*conditions)
    )

    rows: list[SearchResult] = []
    if is_postgres(session):
        rows = await _search_postgres(
            session,
            query_vector=query_vector,
            conditions=conditions,
            top_k=top_k,
            min_score=min_score,
        )
    else:
        rows = await _search_fallback(
            session,
            query_vector=query_vector,
            conditions=conditions,
            top_k=top_k,
            min_score=min_score,
        )

    return rows, int(total_candidates or 0), provider.name


async def _search_postgres(
    session: AsyncSession,
    *,
    query_vector: list[float],
    conditions: list[Any],
    top_k: int,
    min_score: float,
) -> list[SearchResult]:
    """原生 pgvector 路径：``<=>`` 余弦距离，配合 HNSW 索引。"""
    from sqlalchemy import text as sql_text

    literal = vector_literal(query_vector)
    stmt = sql_text(
        """
        SELECT c.chunk_id, c.asset_id, c.chunk_index, c.content,
               n.station_id, n.asset_type, n.title, n.matrix_uid, n.verification_level,
               1 - (c.embedding <=> CAST(:query_vector AS vector)) AS score
        FROM asset_chunk AS c
        JOIN asset_node AS n ON n.asset_id = c.asset_id
        WHERE n.matrix_uid = :matrix_uid
          AND n.station_id = ANY(:stations)
          AND (:has_types = false OR n.asset_type = ANY(:asset_types))
          AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> CAST(:query_vector AS vector)
        LIMIT :limit
        """
    )
    # 从 ORM 条件里提取参数，避免重复拼 SQL
    params = _extract_where_params(conditions)
    result = await session.execute(
        stmt,
        {
            "query_vector": literal,
            "matrix_uid": params["matrix_uid"],
            "stations": params["stations"],
            "has_types": bool(params.get("asset_types")),
            "asset_types": params.get("asset_types") or [],
            "limit": top_k,
        },
    )
    out: list[SearchResult] = []
    for row in result.mappings():
        score = float(row["score"])
        if score < min_score:
            continue
        out.append(
            SearchResult(
                chunk_id=str(row["chunk_id"]),
                asset_id=str(row["asset_id"]),
                chunk_index=int(row["chunk_index"]),
                content=row["content"],
                score=score,
                station_id=row["station_id"],
                asset_type=row["asset_type"],
                title=row["title"],
                matrix_uid=row["matrix_uid"],
                verification_level=row["verification_level"],
            )
        )
    return out


async def _search_fallback(
    session: AsyncSession,
    *,
    query_vector: list[float],
    conditions: list[Any],
    top_k: int,
    min_score: float,
) -> list[SearchResult]:
    """非 PostgreSQL 方言：把候选集取回后做等价的余弦计算。"""
    result = await session.execute(
        select(AssetChunk, AssetNode)
        .join(AssetNode, AssetNode.asset_id == AssetChunk.asset_id)
        .where(*conditions)
    )
    scored: list[SearchResult] = []
    for chunk, node in result.all():
        if chunk.embedding is None:
            continue
        score = cosine_similarity(query_vector, list(chunk.embedding))
        if score < min_score:
            continue
        scored.append(
            SearchResult(
                chunk_id=str(chunk.chunk_id),
                asset_id=str(node.asset_id),
                chunk_index=int(chunk.chunk_index),
                content=chunk.content,
                score=score,
                station_id=node.station_id,
                asset_type=node.asset_type,
                title=node.title,
                matrix_uid=node.matrix_uid,
                verification_level=node.verification_level,
            )
        )
    scored.sort(key=lambda item: item.score, reverse=True)
    return scored[:top_k]


def _extract_where_params(conditions: Iterable[Any]) -> dict[str, Any]:
    """从 SQLAlchemy 条件对象里取出 pgvector 路径需要的参数。"""
    from sqlalchemy.sql.elements import BinaryExpression, BooleanClauseList

    params: dict[str, Any] = {"stations": [], "asset_types": []}
    for condition in conditions:
        if isinstance(condition, BooleanClauseList):  # pragma: no cover - 组合条件
            continue
        if not isinstance(condition, BinaryExpression):  # pragma: no cover
            continue
        column = getattr(condition.left, "key", None)
        right = condition.right
        value = getattr(right, "value", right)
        if column == "matrix_uid":
            params["matrix_uid"] = value
        elif column == "station_id":
            params["stations"] = list(value) if isinstance(value, (list, tuple, set)) else [value]
        elif column == "asset_type":
            params["asset_types"] = (
                list(value) if isinstance(value, (list, tuple, set)) else [value]
            )
    params.setdefault("matrix_uid", "")
    return params


# ------------------------------------------------------------------ 边与溯源


async def list_edges(
    session: AsyncSession, *, asset_id: str
) -> tuple[list[AssetEdge], list[AssetEdge]]:
    parsed = _coerce_uuid(asset_id)
    if parsed is None:
        raise MatrixError(ErrorCode.ASSET_NOT_FOUND, "资产不存在")
    out_result = await session.execute(
        select(AssetEdge).where(AssetEdge.from_asset_id == parsed)
    )
    in_result = await session.execute(select(AssetEdge).where(AssetEdge.to_asset_id == parsed))
    return list(out_result.scalars().unique()), list(in_result.scalars().unique())


async def create_edge(
    session: AsyncSession,
    *,
    scope: str | list[str],
    matrix_uid: str,
    from_asset_id: str,
    to_asset_id: str,
    relation: str,
    weight: float = 1.0,
    evidence_ref: str | None = None,
    inference: str = "manual",
) -> AssetEdge | None:
    """建边（幂等：同一三元组已存在则返回 None）。"""
    source = await get_asset(
        session, scope=scope, matrix_uid=matrix_uid, asset_id=from_asset_id
    )
    target = await get_asset(
        session, scope=scope, matrix_uid=matrix_uid, asset_id=to_asset_id
    )
    assert_can_write(scope, source.station_id)

    if source.asset_id == target.asset_id:
        raise MatrixError(ErrorCode.ASSET_PAYLOAD_INVALID, "不允许自环边")

    existing = await session.scalar(
        select(AssetEdge.edge_id).where(
            AssetEdge.from_asset_id == source.asset_id,
            AssetEdge.to_asset_id == target.asset_id,
            AssetEdge.relation == relation,
        )
    )
    if existing is not None:
        return None

    edge = AssetEdge(
        edge_id=uuid.uuid4(),
        from_asset_id=source.asset_id,
        to_asset_id=target.asset_id,
        relation=relation,
        weight=weight,
        inference=inference,
        evidence_ref=evidence_ref,
    )
    session.add(edge)
    await session.flush()
    return edge


async def trace_paths(
    session: AsyncSession,
    *,
    scope: str | list[str],
    matrix_uid: str,
    asset_id: str,
    max_hops: int = 2,
    limit_paths: int = 20,
) -> list[dict[str, Any]]:
    """从某资产向外做 BFS 溯源（默认 2 跳，满足 S1-12「2 跳内找到论文与证据」）。"""
    root = await get_asset(session, scope=scope, matrix_uid=matrix_uid, asset_id=asset_id)

    visited: set[uuid.UUID] = {root.asset_id}
    frontier: list[tuple[AssetNode, list[AssetNode], list[str]]] = [(root, [root], [])]
    output: list[dict[str, Any]] = []

    for _hop in range(max(1, max_hops)):
        next_frontier: list[tuple[AssetNode, list[AssetNode], list[str]]] = []
        for node, path_nodes, path_relations in frontier:
            edges = await session.execute(
                select(AssetEdge).where(
                    AssetEdge.from_asset_id == node.asset_id,
                    AssetEdge.relation.in_(["derived_from", "cites", "evidences"]),
                )
            )
            for edge in edges.scalars().unique():
                neighbour = await session.get(AssetNode, edge.to_asset_id)
                if neighbour is None or neighbour.matrix_uid != matrix_uid:
                    continue
                if neighbour.asset_id in visited:
                    continue
                visited.add(neighbour.asset_id)
                new_nodes = [*path_nodes, neighbour]
                new_relations = [*path_relations, edge.relation]
                output.append(
                    {
                        "hops": len(new_relations),
                        "nodes": [_node_summary(item) for item in new_nodes],
                        "relations": new_relations,
                        "evidence_anchors": neighbour.evidence_anchors or [],
                    }
                )
                if len(new_relations) < max_hops:
                    next_frontier.append((neighbour, new_nodes, new_relations))
        frontier = next_frontier
        if not frontier or len(output) >= limit_paths:
            break

    # 短路径优先（2 跳内优先展示直接来源）
    output.sort(key=lambda item: item["hops"])
    return output[:limit_paths]


def _node_summary(node: AssetNode) -> dict[str, Any]:
    return {
        "asset_id": str(node.asset_id),
        "asset_type": node.asset_type,
        "title": node.title,
        "station_id": node.station_id,
        "verification_level": node.verification_level,
    }


async def count_assets(
    session: AsyncSession, *, matrix_uid: str, station_id: str | None = None
) -> int:
    conditions = [AssetNode.matrix_uid == matrix_uid]
    if station_id:
        conditions.append(AssetNode.station_id == station_id)
    return int(await session.scalar(select(func.count()).select_from(AssetNode).where(*conditions)) or 0)


def contains_expired(asset: AssetNode, ttl_seconds: int = 0) -> bool:  # pragma: no cover
    """占位：未使用。保留以说明「资产没有 TTL」是刻意的。"""
    return ts_of(asset.created_at) < 0
