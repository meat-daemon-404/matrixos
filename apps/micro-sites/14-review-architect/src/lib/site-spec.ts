/**
 * 14 · 综述拓扑推演与写作舱 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：文献综述大纲与段落证据绑定库
 * 投送：paper_doi_bundle → retract-radar（15 撤稿深海声呐与伦理合规仪）
 * 接收：comparison_matrix_row（来自 13 图表熔炉的对比矩阵行）
 *
 * 为什么这么写：
 *   一条记录 = 综述里的**一个章节**。章节标题来自 REVIEW_OUTLINE（大纲树），
 *   归属流派来自 REVIEW_CLUSTERS（拓扑聚类），绑定的证据段落 / 页码 / PDF 坐标
 *   来自 PAPER_ROWS —— 三段数据同源，改一处不会出现「章节写 A 派、引文却是 B」。
 *   投送时把各章节引用的 DOI 去重打包成 paper_doi_bundle，交给 15 站做撤稿体检。
 *
 * ⚠️ 共享数据里的锚点是 camelCase 且带 note；虫洞契约的锚点层是 snake_case 且
 *    `additionalProperties: false` —— 多一个 note 字段整封投送就过不了校验，
 *    所以下面所有锚点都逐字段搬运、显式丢弃 note。
 */

import {
  PAPER_ROWS,
  REVIEW_CLUSTERS,
  REVIEW_OUTLINE,
  createRowSpec,
  defaultRowOfEnvelope,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

type OutlineNode = (typeof REVIEW_OUTLINE)[number];
type ReviewClusterRow = (typeof REVIEW_CLUSTERS)[number];

/** o4 / o5 / o6 是三个流派的二级章节，o7 是跨流派总结章节（无单一 clusterId）。 */
const [, , , O4, O5, O6, O7] = REVIEW_OUTLINE;

/* ── 大纲树：章节编号由 level 递推，不手写 ──────────────────────────── */

/** 章节编号：level 1 递增章号，level 2 在该章下递增节号（1 / 1.1 / 2 / 2.1 …）。 */
const SECTION_NO: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  let chapter = 0;
  let sub = 0;
  for (const node of REVIEW_OUTLINE) {
    if (node.level === 1) {
      chapter += 1;
      sub = 0;
      map.set(node.id, String(chapter));
    } else {
      sub += 1;
      map.set(node.id, `${chapter}.${sub}`);
    }
  }
  return map;
})();

const sectionNoOf = (node: OutlineNode): string => SECTION_NO.get(node.id) ?? node.id;

/** 大纲节点 → 归属流派。引言 / 流派综述 / 总结这类一级章节没有 clusterId，返回 undefined。 */
function clusterOfNode(node: OutlineNode): ReviewClusterRow | undefined {
  if (!('clusterId' in node)) return undefined;
  const clusterId = node.clusterId;
  return REVIEW_CLUSTERS.find((cluster) => cluster.id === clusterId);
}

/** 按 DOI 找到共享对比矩阵里的那一行 —— 页码 / 坐标 / 核验等级的唯一真源。 */
function paperOf(doi: string) {
  return PAPER_ROWS.find((paper) => paper.anchor.sourceDoiOrUrl === doi);
}

/** 某章节代表文献的实测 EQE 字符串（如 `28.4%`），用来把段落摘录与矩阵数据对齐。 */
function eqeForNode(node: OutlineNode): string {
  const cluster = clusterOfNode(node);
  if (!cluster) return '—';
  return paperOf(cluster.representativeDoi)?.eqe ?? '—';
}

/** 把 `28.4%` 这类字符串解析成数值，用于派生跨流派差值。 */
function eqeValueForNode(node: OutlineNode): number {
  const raw = eqeForNode(node);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

/** 准二维路线与氟代交联路线的初始效率差（28.4 − 26.8 = 1.6 个百分点），派生不手抄。 */
const EQE_GAP = (eqeValueForNode(O4) - eqeValueForNode(O6)).toFixed(1);

/* ── 锚点：共享数据（camelCase）→ 虫洞契约（snake_case，无 note）──────── */

function paragraphAnchor(doi: string): WormholeEvidenceAnchor {
  const paper = paperOf(doi);
  if (!paper) return { source_doi_or_url: doi, verification_level: 'Level_B_Preprint' };
  const { sourceDoiOrUrl, pdfPage, bbox, verificationLevel } = paper.anchor;
  return {
    source_doi_or_url: sourceDoiOrUrl,
    verification_level: verificationLevel,
    ...(pdfPage === undefined ? {} : { pdf_page: pdfPage }),
    ...(bbox === undefined ? {} : { bbox }),
  };
}

/** 章节级锚点：跨流派汇总章节没有单篇原文，用大纲页面地址承载（仍是合法锚点）。 */
function outlineAnchor(nodeId: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://review-lab.matrixos.cc.cd/outlines/${nodeId}`,
    verification_level: 'Level_B_Preprint',
  };
}

/* ── 演示数据：一条记录 = 一个章节 + 一段绑定的原文证据 ──────────────── */

/**
 * 造一条「章节 + 段落证据绑定」记录。
 * 篇数 / 被引 / EQE / 页码 / 坐标全部从共享数据推出来，手写的只有摘录文字本身。
 */
function sectionSeed(node: OutlineNode, paragraph: string): RowSeed {
  const cluster = clusterOfNode(node);
  const doi = cluster?.representativeDoi ?? '';
  const anchor = cluster ? paragraphAnchor(doi) : outlineAnchor(node.id);
  const paper = cluster ? paperOf(doi) : undefined;
  const figureRef = paper?.anchor.note ?? '大纲页';
  const pageText = paper?.anchor.pdfPage === undefined ? '大纲页' : `第 ${paper.anchor.pdfPage} 页`;
  const bboxText = paper?.anchor.bbox ? `bbox [${paper.anchor.bbox.join(', ')}]` : '无 PDF 坐标';
  const boundDois = cluster ? [doi] : REVIEW_CLUSTERS.map((item) => item.representativeDoi);

  return {
    title: `${sectionNoOf(node)} ${node.text}`,
    meta: cluster
      ? `${cluster.school} · ${cluster.papers} 篇 · 被引 ${cluster.citations} · 代表 DOI ${doi}`
      : `跨流派汇总 · 绑定 ${boundDois.length} 个代表 DOI · 大纲节点 ${node.id}`,
    detail: `段落证据 ${node.id.toUpperCase()} · 绑定原文${pageText} ${figureRef}（${bboxText}）。摘录：「${paragraph}」写作约束：段落数值只可原样引用，不得二次换算；改标题不影响段落绑定，换 DOI 会同时改聚类归属与引文表。`,
    anchor,
    section: node.id,
    sectionNo: sectionNoOf(node),
    level: node.level,
    school: cluster?.school ?? '跨流派汇总',
    schoolId: cluster?.id ?? '',
    doi,
    boundDois,
    paragraph,
    figureRef,
    verification: anchor.verification_level,
  };
}

const seed: readonly RowSeed[] = [
  sectionSeed(
    O4,
    `准二维层把界面缺陷密度由 1.2×10¹⁶ cm⁻³ 压到 3.4×10¹⁵ cm⁻³，非辐射复合寿命由 1.8 μs 延长到 6.4 μs，器件 EQE 达 ${eqeForNode(O4)}；但层数超过 4 层后空穴抽取受阻，效率回落到 24% 以下。`,
  ),
  sectionSeed(
    O5,
    `手性 R-MBA 界面借 CISS 效应引入自旋选择性，复合通道被部分禁戒，器件 EQE 达 ${eqeForNode(O5)}，自旋极化率 62%；短板是同一批样品的极化率离散度 ±11%，可重复性仍待验证。`,
  ),
  sectionSeed(
    O6,
    `双氟代配体在界面形成交联网络，85 ℃ / 85% RH 老化 1000 h 后效率保持率 92%（对照组 61%）；初始 EQE 为 ${eqeForNode(O6)}，略低于准二维路线。`,
  ),
  sectionSeed(
    O7,
    `三个流派在效率—稳定性权衡上分歧明显：准二维路线效率领先但工艺窗口窄；手性界面引入新的自旋自由度但可重复性不足；氟代交联稳定性最优，代价是初始效率低 ${EQE_GAP} 个百分点。真正的空白是缺少跨流派的统一寿命评价协议。`,
  ),
];

/* ── 业务规格 ────────────────────────────────────────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'review-outlines',
  seed,
  emit: {
    targetApp: 'retract-radar',
    payloadType: 'paper_doi_bundle',
  },
  accept: {
    payloadType: 'comparison_matrix_row',
    description:
      '接收图表熔炉投来的对比矩阵行，落成一条「待绑定段落」章节：先选流派，再把矩阵行的图号与 PDF 坐标绑到章节段落，绑定完成后再投送给撤稿声呐。',
  },
  draft: (rows) => {
    const used = new Set(rows.map((row) => String(row.section ?? '')));
    const node = REVIEW_OUTLINE.find((item) => !used.has(item.id)) ?? O7;
    const cluster = clusterOfNode(node);
    const anchor = cluster ? paragraphAnchor(cluster.representativeDoi) : outlineAnchor(node.id);
    return {
      title: `${sectionNoOf(node)} ${node.text}`,
      meta: cluster
        ? `${cluster.school} · 待绑定证据段落 · 代表 DOI ${cluster.representativeDoi}`
        : '跨流派汇总 · 待绑定证据段落',
      detail:
        '新建章节：先在仪器面板选中对应流派，再把 PDF 原文段落（页码 + 坐标）绑到本节；未绑定段落的章节投送时只带大纲页锚点，下游撤稿体检会把它标成「待补锚」。',
      anchor,
      section: node.id,
      sectionNo: sectionNoOf(node),
      level: node.level,
      school: cluster?.school ?? '跨流派汇总',
      schoolId: cluster?.id ?? '',
      doi: cluster?.representativeDoi ?? '',
      boundDois: cluster
        ? [cluster.representativeDoi]
        : REVIEW_CLUSTERS.map((item) => item.representativeDoi),
      paragraph: '待绑定',
      figureRef: '待绑定',
      verification: anchor.verification_level,
    };
  },
  rowOfEnvelope: (envelope, nowIso) => {
    const base = defaultRowOfEnvelope(envelope, nowIso);
    const data = envelope.payload?.data ?? {};
    const doi = typeof data.doi === 'string' ? data.doi : '';
    return {
      ...base,
      title: `待绑定段落 · ${base.title}`,
      meta: `${base.meta} · 矩阵行待挂到综述章节`,
      detail: `${base.detail}｜本站收到矩阵行后：选中对应流派 → 把矩阵行的图号与 PDF 坐标绑到章节段落 → 绑定完成再投送给撤稿声呐。`,
      section: 'inbox',
      sectionNo: '—',
      level: 0,
      school: '待归类流派',
      schoolId: '',
      doi,
      boundDois: doi === '' ? [] : [doi],
      paragraph: '待绑定',
      figureRef: typeof data.figure === 'string' ? data.figure : '待绑定',
      verification: base.anchor ? base.anchor.verification_level : 'Level_B_Preprint',
    };
  },
  payloadOf: (rows) => {
    const dois: string[] = [];
    for (const row of rows) {
      const bound = Array.isArray(row.boundDois) ? (row.boundDois as unknown[]) : [];
      for (const item of bound) {
        const doi = String(item);
        if (doi !== '' && !dois.includes(doi)) dois.push(doi);
      }
    }
    return {
      site: 'review-lab',
      ledger: '文献综述大纲与段落证据绑定库',
      bundle_kind: 'review_outline_doi_bundle',
      outlineNodes: REVIEW_OUTLINE.length,
      clusters: REVIEW_CLUSTERS.map((cluster) => ({
        id: cluster.id,
        school: cluster.school,
        papers: cluster.papers,
        citations: cluster.citations,
        representative_doi: cluster.representativeDoi,
        key_claim: cluster.keyClaim,
      })),
      sectionCount: rows.length,
      doi_count: dois.length,
      dois,
      sections: rows.map((row) => ({
        id: String(row.id),
        section: String(row.section ?? ''),
        sectionNo: String(row.sectionNo ?? ''),
        level: typeof row.level === 'number' ? row.level : null,
        title: String(row.title),
        school: String(row.school ?? ''),
        doi: String(row.doi ?? ''),
        boundDois: Array.isArray(row.boundDois)
          ? (row.boundDois as unknown[]).map((item) => String(item))
          : [],
        paragraph: String(row.paragraph ?? ''),
        figureRef: String(row.figureRef ?? ''),
        verification: String(row.verification ?? ''),
      })),
    };
  },
  csvOf: (rows) => ({
    header: [
      '章节编号',
      '章节标题',
      '层级',
      '归属流派',
      '绑定证据段落',
      '代表性 DOI',
      '核验等级',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.sectionNo ?? ''),
      String(row.title),
      typeof row.level === 'number' ? row.level : '',
      String(row.school ?? ''),
      String(row.paragraph ?? ''),
      String(row.doi ?? ''),
      String(row.verification ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),
});
