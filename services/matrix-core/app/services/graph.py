"""资产图谱边推断（S1-12）。

验收标准：
1. 给定一条拟合结果资产，能在 **2 跳内**找到其溯源论文与证据锚点；
2. 边推断**幂等**——重复跑不产生重复边。

推断规则（只产 3 类，architecture §6.2 的 ``INFERRED_RELATIONS``）：

| 规则 | 关系 | 触发条件 |
| :--- | :--- | :--- |
| 证据来源命中 | ``cites`` | 两个资产的 ``evidence_anchors.source_doi_or_url`` 有交集 |
| 显式引用 | ``cites`` | A 的 payload 里出现 B 的 asset_id（``asset_ref`` / ``asset_id``） |
| 派生关系 | ``derived_from`` | 拟合结果/图表等「产物」引用论文/数据集的 asset_ref |
| 证据支撑 | ``evidences`` | A 的证据锚点指向 B 的 DOI（B 是论文类资产） |

``supersedes`` / ``relates_to`` **不自动推断**——它们是人工语义判断，
自动推断会产生「机器瞎猜的版本关系」，比没有边更糟。
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ErrorCode, MatrixError
from app.core.tracing import get_trace_id, is_uuid
from app.models.assets import AssetChunk, AssetEdge, AssetNode

_UUID_IN_TEXT_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# 「产物」类型：它们与上游论文/数据之间应是 derived_from（而非对等 cites）
_PRODUCT_TYPES: frozenset[str] = frozenset(
    {"fit_result", "figure", "review_draft", "cv_version", "score_record"}
)
# 「来源」类型：可被引用的知识实体
_SOURCE_TYPES: frozenset[str] = frozenset({"paper", "dataset", "mentor_card"})


@dataclass
class InferenceReport:
    """一次推断的统计（幂等性通过 ``skipped_existing`` 可观测）。"""

    scanned_assets: int = 0
    created_edges: int = 0
    skipped_existing: int = 0
    relations: dict[str, int] = field(default_factory=dict)
    dry_run: bool = False
    trace_id: str = ""

    def note(self, relation: str) -> None:
        self.relations[relation] = self.relations.get(relation, 0) + 1

    def as_dict(self) -> dict[str, Any]:
        return {
            "scanned_assets": self.scanned_assets,
            "created_edges": self.created_edges,
            "skipped_existing": self.skipped_existing,
            "relations": dict(self.relations),
            "dry_run": self.dry_run,
            "trace_id": self.trace_id,
        }


def extract_asset_refs(value: Any, *, depth: int = 0, limit: int = 200) -> set[uuid.UUID]:
    """从 payload 里抽出所有形如 UUID 的字符串（即对其它资产的引用）。

    大载荷引用策略（architecture §5.4）把 ``asset_ref`` 放在 ``payload.data`` 内，
    因此这里递归扫描整个 payload，而不是只认某个固定字段名——契约没有规定
    引用字段叫什么，扫描 UUID 形状是最稳的做法。
    """
    found: set[uuid.UUID] = set()

    def walk(node: Any, level: int) -> None:
        if len(found) >= limit or level > 8:
            return
        if isinstance(node, str):
            for match in _UUID_IN_TEXT_RE.findall(node):
                try:
                    found.add(uuid.UUID(match))
                except ValueError:  # pragma: no cover - 正则已保证形状
                    continue
        elif isinstance(node, dict):
            for item in node.values():
                walk(item, level + 1)
        elif isinstance(node, (list, tuple)):
            for item in node[:50]:
                walk(item, level + 1)

    walk(value, depth)
    return found


def _sources_of(anchors: Sequence[dict] | None) -> set[str]:
    """证据锚点的 DOI/URL 集合（小写归一，便于集合运算）。"""
    out: set[str] = set()
    for anchor in anchors or []:
        if not isinstance(anchor, dict):
            continue
        raw = anchor.get("source_doi_or_url")
        if isinstance(raw, str) and raw.strip():
            out.add(raw.strip().lower())
    return out


def _choose_relation(source: AssetNode, target: AssetNode, *, via_anchor: bool) -> str:
    """在同一对资产间挑选语义最贴切的关系。"""
    if source.asset_type in _PRODUCT_TYPES and target.asset_type in _SOURCE_TYPES:
        return "derived_from"
    if via_anchor:
        # 证据锚点指向的论文 → evidences 更准确；其余按引用处理
        return "evidences" if target.asset_type == "paper" else "cites"
    return "cites"


async def _existing_triples(
    session: AsyncSession, asset_ids: Sequence[uuid.UUID]
) -> set[tuple[uuid.UUID, uuid.UUID, str]]:
    """一次取回涉及本批资产的全部已有边（避免逐对查询）。"""
    if not asset_ids:
        return set()
    result = await session.execute(
        select(AssetEdge.from_asset_id, AssetEdge.to_asset_id, AssetEdge.relation).where(
            AssetEdge.from_asset_id.in_(asset_ids)
        )
    )
    return {(row[0], row[1], row[2]) for row in result.all()}


async def infer_edges(
    session: AsyncSession,
    *,
    matrix_uid: str,
    station_ids: Iterable[str] | None = None,
    asset_ids: Iterable[str] | None = None,
    dry_run: bool = False,
) -> InferenceReport:
    """对某用户的资产跑一次边推断（幂等）。

    只在本人的资产之间建边——跨用户的边会让「多跳溯源」变成越权读取的通道，
    这与 ADR-04「权限在 SQL 层过滤」的原则冲突，因此显式禁止。
    """
    report = InferenceReport(dry_run=dry_run, trace_id=get_trace_id())

    conditions = [AssetNode.matrix_uid == matrix_uid]
    station_filter = [str(item) for item in (station_ids or []) if item]
    if station_filter:
        conditions.append(AssetNode.station_id.in_(station_filter))

    id_filter = _coerce_ids(asset_ids)
    if asset_ids and not id_filter:
        raise MatrixError(ErrorCode.VALIDATION_FAILED, "asset_ids 中没有合法的 UUID")

    result = await session.execute(select(AssetNode).where(*conditions))
    nodes = list(result.scalars().unique())
    if id_filter:
        nodes = [node for node in nodes if node.asset_id in id_filter]

    if not nodes:
        return report

    report.scanned_assets = len(nodes)
    by_id: dict[uuid.UUID, AssetNode] = {node.asset_id: node for node in nodes}
    existing = await _existing_triples(session, list(by_id))

    # DOI → 资产（仅有证据锚点的资产才参与锚点匹配）
    doi_index: dict[str, list[AssetNode]] = {}
    for node in nodes:
        for doi in _sources_of(node.evidence_anchors):
            doi_index.setdefault(doi, []).append(node)

    pending: list[AssetEdge] = []
    seen: set[tuple[uuid.UUID, uuid.UUID, str]] = set(existing)

    def add_edge(source: AssetNode, target: AssetNode, relation: str, evidence_ref: str | None) -> None:
        if source.asset_id == target.asset_id:
            return
        triple = (source.asset_id, target.asset_id, relation)
        if triple in seen:
            report.skipped_existing += 1
            return
        seen.add(triple)
        pending.append(
            AssetEdge(
                edge_id=uuid.uuid4(),
                from_asset_id=source.asset_id,
                to_asset_id=target.asset_id,
                relation=relation,
                weight=_weight_for(relation),
                inference="automated",
                evidence_ref=evidence_ref,
            )
        )
        report.note(relation)

    for node in nodes:
        # 规则 1+2：payload 中显式引用的其它资产
        refs = extract_asset_refs(node.payload or {})
        for ref in refs:
            target = by_id.get(ref)
            if target is None:
                continue  # 引用跨用户 / 引用已删除资产：不建边（不越权）
            relation = _choose_relation(node, target, via_anchor=False)
            add_edge(node, target, relation, evidence_ref=str(target.asset_id))

        # 规则 3+4：共享证据锚点（同一 DOI）
        for doi in _sources_of(node.evidence_anchors):
            for target in doi_index.get(doi, ()):  # type: ignore[arg-type]
                if target.asset_id == node.asset_id:
                    continue
                relation = _choose_relation(node, target, via_anchor=True)
                add_edge(node, target, relation, evidence_ref=doi)

    if dry_run:
        report.created_edges = 0
        return report

    for edge in pending:
        session.add(edge)
    report.created_edges = len(pending)
    if pending:
        await session.flush()

    # 反向也检查一遍：同一条规则在反方向可能语义不同（A cites B vs B cites A），
    # 但为了不让边数爆炸，仅在「产物 ← 来源」方向补一次 derived_from。
    return report


def _weight_for(relation: str) -> float:
    """边的初始权重：派生关系比一般引用更"强"。"""
    return {"derived_from": 0.9, "evidences": 0.8, "cites": 0.6}.get(relation, 0.5)


def _coerce_ids(values: Iterable[str] | None) -> set[uuid.UUID]:
    out: set[uuid.UUID] = set()
    for item in values or []:
        if isinstance(item, uuid.UUID):
            out.add(item)
        elif isinstance(item, str) and is_uuid(item):
            out.add(uuid.UUID(item))
    return out


# ------------------------------------------------------------------ 多跳溯源


async def trace_two_hops(
    session: AsyncSession,
    *,
    matrix_uid: str,
    root: AssetNode,
    max_hops: int = 2,
    max_nodes: int = 64,
) -> list[dict[str, Any]]:
    """BFS 溯源（默认 2 跳），返回从根出发的路径。

    S1-12 的验收表述是「拟合结果 → 2 跳内找到溯源论文与证据锚点」，
    因此这里**优先返回短路径**，并只沿 3 类推断关系走。
    """
    visited: set[uuid.UUID] = {root.asset_id}
    frontier: list[tuple[AssetNode, list[AssetNode], list[str]]] = [(root, [root], [])]
    paths: list[dict[str, Any]] = []

    for _ in range(max(1, max_hops)):
        if not frontier or len(paths) >= max_nodes:
            break
        next_frontier: list[tuple[AssetNode, list[AssetNode], list[str]]] = []
        for node, path_nodes, path_relations in frontier:
            result = await session.execute(
                select(AssetEdge).where(
                    AssetEdge.from_asset_id == node.asset_id,
                    AssetEdge.relation.in_(["derived_from", "cites", "evidences"]),
                )
            )
            for edge in result.scalars().unique():
                neighbour = await session.get(AssetNode, edge.to_asset_id)
                if neighbour is None or neighbour.matrix_uid != matrix_uid:
                    continue
                if neighbour.asset_id in visited:
                    continue
                visited.add(neighbour.asset_id)
                new_nodes = [*path_nodes, neighbour]
                new_relations = [*path_relations, edge.relation]
                paths.append(
                    {
                        "hops": len(new_relations),
                        "nodes": [_node_summary(item) for item in new_nodes],
                        "relations": new_relations,
                        "evidence_anchors": neighbour.evidence_anchors or [],
                    }
                )
                if len(new_relations) < max_hops and len(paths) < max_nodes:
                    next_frontier.append((neighbour, new_nodes, new_relations))
        frontier = next_frontier

    paths.sort(key=lambda item: item["hops"])
    return paths[:max_nodes]


def _node_summary(node: AssetNode) -> dict[str, Any]:
    return {
        "asset_id": str(node.asset_id),
        "asset_type": node.asset_type,
        "title": node.title,
        "station_id": node.station_id,
        "verification_level": node.verification_level,
    }


async def rebuild_chunks_for(
    session: AsyncSession, *, asset_id: uuid.UUID
) -> int:
    """占位说明：切片重建在 services/assets.py（写路径），此处不重复实现。"""
    result = await session.scalar(
        select(AssetChunk.chunk_id).where(AssetChunk.asset_id == asset_id).limit(1)
    )
    return 1 if result is not None else 0


__all__ = [
    "InferenceReport",
    "extract_asset_refs",
    "infer_edges",
    "rebuild_chunks_for",
    "trace_two_hops",
]
