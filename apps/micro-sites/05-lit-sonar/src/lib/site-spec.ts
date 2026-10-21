/**
 * 05 · 五源跨库引文声呐站 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：课题组专题文献收藏夹与引文树
 * 投送：paper_doi_bundle → matrix-cross（跨论文对比矩阵）
 * 接收：paper_doi_bundle ← pat-hot（PAT-HOT 学科脉冲雷达）
 *
 * 为什么这么写：
 *   增删改清空导出投送接收的**语义**由 `createRowSpec` 固化，这里只描述
 *   「这个站有哪些收藏夹、一个收藏夹长什么样、投出去带哪些 DOI」。
 *   一条记录 = 一个专题收藏夹，含该夹的引文树摘要（节点数 / 种子文献 /
 *   总被引 / 五源覆盖）与代表文献 DOI。
 *
 * 数值一律从共享演示数据当场算出来（CITATION_NODES / CITATION_EDGES /
 * CITATION_SOURCES / PAPER_ROWS），**不手抄**：仪器面板显示某节点被引
 * 5,120 而台账写 5,000，答辩现场就会被问住。
 *
 * 锚点注意（踩过的坑）：共享数据里的锚点是 SDK 的 camelCase 形状
 * （`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel`，还多带一个
 * `note`），而虫洞信封契约的锚点层是 `additionalProperties: false` 的
 * snake_case。所以这里逐字段转换并**丢掉 note** —— 多一个字段整个信封就
 * 过不了 `specs/contracts/wormhole-envelope.schema.json`。
 */

import {
  CITATION_EDGES,
  CITATION_NODES,
  CITATION_SOURCES,
  PAPER_ROWS,
  createRowSpec,
  type CitationEdge,
  type CitationNode,
  type PaperRow,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

/* ───────────────────────────── 展示格式（确定性） ─────────────────────────────
 * 不用 toLocaleString：Node 与浏览器的 ICU 版本可能不同，服务端预渲染与
 * 客户端首帧文本一旦不一致就是 React #418 水合报错。手写千分位最稳。
 */
function fmtInt(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 0.3402 → "34.0%"。 */
function fmtPct(ratio: number): string {
  return `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;
}

/* ───────────────────────────── 五源索引 ───────────────────────────── */

/** 五源索引总量（OpenAlex + arXiv + PubMed + Crossref + Semantic Scholar）。 */
const SOURCE_TOTAL = CITATION_SOURCES.reduce((sum, source) => sum + source.count, 0);

/** 主源：索引量最大的那个库。用 reduce 而不是 sort，避免改动共享常量。 */
const PRIMARY_SOURCE = CITATION_SOURCES.reduce(
  (best, source) => (source.count > best.count ? source : best),
  CITATION_SOURCES[0]!,
);

/** 有数据的源数 —— 五个库都返回了记录，所以是 5/5（不是写死的 5，是数出来的）。 */
const SOURCES_COVERED = CITATION_SOURCES.filter((source) => source.count > 0).length;

/* ───────────────────────────── 锚点转换 ───────────────────────────── */

/**
 * camelCase（SDK / instrument-ui）→ snake_case（虫洞信封契约）。
 * `note` 在契约里不存在，必须丢弃；`pdf_page` / `bbox` 只在有值时出现。
 */
function anchorOf(paper: PaperRow): WormholeEvidenceAnchor {
  const source = paper.anchor;
  return {
    source_doi_or_url: source.sourceDoiOrUrl,
    verification_level: source.verificationLevel,
    ...(typeof source.pdfPage === 'number' ? { pdf_page: source.pdfPage } : {}),
    ...(source.bbox ? { bbox: source.bbox } : {}),
  };
}

const VERIFICATION_TEXT: Readonly<Record<string, string>> = {
  Level_A_Verified: 'Level A · 已双验',
  Level_B_Preprint: 'Level B · 仅预印本',
  Retracted_Warning: '已命中撤稿库',
};

/* ───────────────────────────── 收藏夹 → 台账记录 ───────────────────────────── */

interface CollectionPlan {
  readonly title: string;
  readonly topic: string;
  readonly status: string;
  readonly note: string;
  /** 该夹覆盖的引文树节点（可跨夹重叠：一篇论文本来就会属于多个专题）。 */
  readonly nodeIds: readonly string[];
  /** 代表文献（投送时的 DOI 锚点来源），对应 PAPER_ROWS 的 id。 */
  readonly paperId: string;
}

/**
 * 三个收藏夹把 6 个节点切成「源头 → 演进 → 前沿」三段，相邻段共享 1 个节点。
 * 这样每条 seed 的节点数 / 总被引 / 关系类型都不同，能真实覆盖业务场景，
 * 而不是「示例 1 / 示例 2 / 示例 3」。
 */
const COLLECTION_PLANS: readonly CollectionPlan[] = [
  {
    title: '钙钛矿钝化 · 机理主脉',
    topic: '准二维钝化 / 缺陷钝化机理',
    status: '已归档',
    note: '开山工作与两次机理修订都在这一夹里，写综述的引言部分直接从它取文献。',
    nodeIds: ['n2', 'n1', 'n3'],
    paperId: 'r1',
  },
  {
    title: '界面工程 · 手性钝化演进',
    topic: 'R/S-MBA 手性界面 / 界面能级调控',
    status: '在读',
    note: '手性界面这条线还在快速演进，每周由学科脉冲雷达自动补新条目。',
    nodeIds: ['n3', 'n4', 'n5'],
    paperId: 'r2',
  },
  {
    title: '前沿追踪 · 配体交联与反驳证据',
    topic: '双氟代配体交联 / 反例追踪',
    status: '待读',
    note: '刻意保留一条 refutes 关系：反驳证据比支持证据更能说明边界条件。',
    nodeIds: ['n4', 'n5', 'n6'],
    paperId: 'r3',
  },
];

const EDGE_KIND_LABEL: Readonly<Record<CitationEdge['kind'], string>> = {
  cites: 'cites',
  extends: 'extends',
  refutes: 'refutes',
};

function nodesOf(nodeIds: readonly string[]): readonly CitationNode[] {
  return nodeIds
    .map((id) => CITATION_NODES.find((node) => node.id === id))
    .filter((node): node is CitationNode => Boolean(node));
}

/** 夹内边：两端都在该收藏夹节点集合里的引文关系。 */
function edgesOf(nodeIds: readonly string[]): readonly CitationEdge[] {
  return CITATION_EDGES.filter(
    (edge) => nodeIds.includes(edge.from) && nodeIds.includes(edge.to),
  );
}

/** 种子文献：优先取标记了 seminal 的节点；没有标记时退回被引最高的节点。 */
function seminalOf(nodes: readonly CitationNode[]): CitationNode | undefined {
  const flagged = nodes.filter((node) => node.seminal);
  const pool = flagged.length > 0 ? flagged : nodes;
  return pool.reduce<CitationNode | undefined>(
    (best, node) => (best === undefined || node.citations > best.citations ? node : best),
    undefined,
  );
}

function edgeSummary(edges: readonly CitationEdge[]): string {
  const counts = new Map<CitationEdge['kind'], number>();
  for (const edge of edges) counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
  const parts: string[] = [];
  for (const kind of ['extends', 'cites', 'refutes'] as const) {
    const count = counts.get(kind) ?? 0;
    if (count > 0) parts.push(`${EDGE_KIND_LABEL[kind]} ${count}`);
  }
  return parts.length > 0 ? parts.join(' / ') : '无夹内关系';
}

function yearSpanOf(nodes: readonly CitationNode[]): string {
  if (nodes.length === 0) return '—';
  const years = nodes.map((node) => node.year);
  return `${Math.min(...years)}–${Math.max(...years)}`;
}

const seed: readonly RowSeed[] = COLLECTION_PLANS.map((plan) => {
  const nodes = nodesOf(plan.nodeIds);
  const edges = edgesOf(plan.nodeIds);
  const seminal = seminalOf(nodes);
  const paper = PAPER_ROWS.find((row) => row.id === plan.paperId);
  const totalCitations = nodes.reduce((sum, node) => sum + node.citations, 0);
  const primaryShare = SOURCE_TOTAL === 0 ? 0 : PRIMARY_SOURCE.count / SOURCE_TOTAL;
  const level = paper?.anchor.verificationLevel ?? 'Level_B_Preprint';

  const meta = [
    `${nodes.length} 节点`,
    `种子 ${seminal?.label ?? '待定'}`,
    `总被引 ${fmtInt(totalCitations)}`,
    `五源 ${SOURCES_COVERED}/${CITATION_SOURCES.length}`,
  ].join(' · ');

  const detail = [
    `覆盖 ${nodes.map((node) => node.label).join(' / ')}（${yearSpanOf(nodes)}）`,
    `引文关系 ${edges.length} 条（${edgeSummary(edges)}）`,
    `主源 ${PRIMARY_SOURCE.label} 占五源索引 ${fmtPct(primaryShare)}`,
    paper
      ? `代表文献 ${paper.venue}《${paper.strategy}》，锚点 ${VERIFICATION_TEXT[level] ?? level}`
      : '尚未关联代表文献，投送会退化为站级基线锚点',
    plan.note,
  ].join('；');

  return {
    title: plan.title,
    meta,
    detail,
    ...(paper ? { anchor: anchorOf(paper) } : {}),
    topic: plan.topic,
    status: plan.status,
    nodeIds: [...plan.nodeIds],
    nodeCount: nodes.length,
    nodeLabels: nodes.map((node) => node.label),
    seminalLabel: seminal?.label ?? '',
    seminalYear: seminal?.year ?? 0,
    totalCitations,
    yearSpan: yearSpanOf(nodes),
    edgeCount: edges.length,
    edgeSummary: edgeSummary(edges),
    sourcesCovered: SOURCES_COVERED,
    sourcesTotal: CITATION_SOURCES.length,
    primarySource: PRIMARY_SOURCE.label,
    primarySourceSharePct: Number(fmtPct(primaryShare).replace('%', '')),
    representativeDoi: paper?.anchor.sourceDoiOrUrl ?? '',
    representativeVenue: paper?.venue ?? '',
    representativeStrategy: paper?.strategy ?? '',
    verificationLevel: level,
  } satisfies RowSeed;
});

/* ───────────────────────────── 业务规格 ───────────────────────────── */

const LEDGER_NAME = '课题组专题文献收藏夹与引文树';

export const siteSpec = createRowSpec({
  exportName: 'lit-collections',
  seed,
  emit: {
    targetApp: 'matrix-cross',
    payloadType: 'paper_doi_bundle',
  },
  accept: {
    payloadType: 'paper_doi_bundle',
    description:
      '接收学科脉冲雷达（pat-hot）投来的前沿论文包，直接落成收藏夹里的「待读」条目，DOI 与页码一并保留。',
  },
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `新专题收藏夹 ${next}`,
      meta: `0 节点 · 待检索 · 五源 ${SOURCES_COVERED}/${CITATION_SOURCES.length}`,
      detail:
        '点「编辑」补上专题名与检索式；收藏夹里的引文树由五源声呐自动补全，投送时按代表文献 DOI 带锚点。',
      topic: '待定',
      status: '待读',
      nodeIds: [],
      nodeCount: 0,
      totalCitations: 0,
      edgeCount: 0,
      sourcesCovered: 0,
      sourcesTotal: CITATION_SOURCES.length,
      primarySource: PRIMARY_SOURCE.label,
      representativeDoi: '',
    } satisfies RowSeed;
  },
  payloadOf: (rows) => {
    const collections = rows.map((row) => {
      const nodeIds = Array.isArray(row.nodeIds) ? row.nodeIds.map((id) => String(id)) : [];
      return {
        id: String(row.id),
        title: String(row.title),
        topic: String(row.topic ?? ''),
        status: String(row.status ?? ''),
        nodeCount: Number(row.nodeCount ?? nodeIds.length),
        totalCitations: Number(row.totalCitations ?? 0),
        seminal: String(row.seminalLabel ?? ''),
        yearSpan: String(row.yearSpan ?? ''),
        edgeCount: Number(row.edgeCount ?? 0),
        representativeDoi: String(row.representativeDoi ?? ''),
        verificationLevel: String(row.verificationLevel ?? ''),
        nodeIds,
      };
    });

    // DOI 包去重：matrix-cross 拿到的是一串可直接检索的 DOI，不是重复锚点。
    const doiBundle = Array.from(
      new Set(collections.map((item) => item.representativeDoi).filter((doi) => doi !== '')),
    );

    return {
      site: 'lit-sonar',
      ledger: LEDGER_NAME,
      target: 'matrix-cross',
      collectionCount: collections.length,
      doiCount: doiBundle.length,
      doiBundle,
      // 五源索引随包带上，目标站能判断这批 DOI 的覆盖度而不必回查本站。
      sourceIndex: CITATION_SOURCES.map((source) => ({
        source: source.id,
        label: source.label,
        records: source.count,
      })),
      collections,
    };
  },
  rowOfEnvelope: (envelope) => {
    const data = (envelope.payload?.data ?? {}) as Record<string, unknown>;
    const anchors = Array.isArray(envelope.payload?.evidence_anchors)
      ? envelope.payload.evidence_anchors
      : [];
    const rawDois = Array.isArray(data.doiBundle)
      ? data.doiBundle
      : Array.isArray(data.dois)
        ? data.dois
        : [];
    const dois = rawDois.map((doi) => String(doi)).filter((doi) => doi !== '');
    const summary = typeof data.summary === 'string' ? data.summary : '';
    const firstAnchor = anchors[0];

    return {
      title: `待读 · 前沿论文包 ${String(dois.length).padStart(2, '0')} 篇`,
      meta: `来自 ${envelope.source_app ?? 'pat-hot'} · 锚点 ${anchors.length} 条 · 待入夹`,
      detail: [
        summary || '学科脉冲雷达推来的前沿论文包，已落成待读条目。',
        dois.length > 0 ? `DOI：${dois.slice(0, 3).join('、')}${dois.length > 3 ? ' 等' : ''}` : 'DOI 列表为空，需回站内补检索',
        `trace ${envelope.trace_id.slice(0, 8)}`,
      ].join('；'),
      ...(firstAnchor ? { anchor: firstAnchor } : {}),
      topic: '前沿追踪（自动接收）',
      status: '待读',
      nodeIds: [],
      nodeCount: 0,
      totalCitations: 0,
      edgeCount: 0,
      sourcesCovered: 0,
      sourcesTotal: CITATION_SOURCES.length,
      representativeDoi: dois[0] ?? '',
      receivedFrom: String(envelope.source_app ?? 'pat-hot'),
      traceId: envelope.trace_id,
    } satisfies RowSeed;
  },
  csvOf: (rows) => ({
    header: [
      '收藏夹',
      '专题',
      '状态',
      '节点数',
      '种子文献',
      '总被引',
      '年份跨度',
      '五源覆盖',
      '代表文献 DOI',
      '校验等级',
      '说明',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.title),
      String(row.topic ?? ''),
      String(row.status ?? ''),
      String(row.nodeCount ?? 0),
      String(row.seminalLabel ?? ''),
      String(row.totalCitations ?? 0),
      String(row.yearSpan ?? ''),
      `${String(row.sourcesCovered ?? 0)}/${String(row.sourcesTotal ?? CITATION_SOURCES.length)}`,
      String(row.representativeDoi ?? ''),
      String(row.verificationLevel ?? ''),
      String(row.detail),
      String(row.updatedAt ?? ''),
    ]),
  }),
});
