/**
 * 15 · 撤稿深海声呐与伦理合规仪 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：论文引文合规体检报告与伦理声明
 * 投送：paper_doi_bundle → evidence-cv（17 简历证据台，只收「体检放行」的 DOI）
 * 接收：paper_doi_bundle（来自 10 复现核验舱的待检论文包）
 *
 * 为什么这么写：
 *   一条记录 = **一份引文合规体检报告**：被检论文 + 声呐检出的风险项 + 伦理声明。
 *   风险等级、风险项文案、声呐坐标全部取自 RETRACT_BLIPS —— 声呐盘上亮几个点，
 *   台账里就落几条报告，不会出现「盘上是红的、台账写着安全」。
 *   本站的核心是**拦截**：命中撤稿库的引文，锚点必须落成 Retracted_Warning，
 *   下游 evidence-cv 拿到这个等级会直接拒绝入库 —— 这是整条链路的伦理红线。
 *
 * ⚠️ 共享数据里的锚点是 camelCase 且带 note；虫洞契约锚点层是 snake_case 且
 *    `additionalProperties: false`，多一个 note 整封投送就过不了校验，故逐字段搬运。
 */

import {
  PAPER_ROWS,
  RETRACT_BLIPS,
  REVIEW_CLUSTERS,
  createRowSpec,
  defaultRowOfEnvelope,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

type Blip = (typeof RETRACT_BLIPS)[number];
type PaperRow = (typeof PAPER_ROWS)[number];

/* ── 声呐读数：所有计数从 RETRACT_BLIPS 推出来，不手抄 ──────────────── */

const BLIP_COUNT = RETRACT_BLIPS.length;
const SAFE_COUNT = RETRACT_BLIPS.filter((blip) => blip.risk === 'safe').length;
const CAUTION_COUNT = RETRACT_BLIPS.filter((blip) => blip.risk === 'caution').length;
const CRITICAL_COUNT = RETRACT_BLIPS.filter((blip) => blip.risk === 'critical').length;

/** 待检语料的规模：来自 14 站同源的三个流派聚类。 */
const CLUSTER_PAPERS = REVIEW_CLUSTERS.reduce((sum, cluster) => sum + cluster.papers, 0);
const CLUSTER_CITATIONS = REVIEW_CLUSTERS.reduce((sum, cluster) => sum + cluster.citations, 0);
/** 每篇平均被引，报告里用来说明「命中 1 篇会污染多少条引用」。 */
const CITATIONS_PER_PAPER = Math.round(CLUSTER_CITATIONS / CLUSTER_PAPERS);

function blipOf(id: string): Blip | undefined {
  return RETRACT_BLIPS.find((blip) => blip.id === id);
}

function riskLabel(risk: string): string {
  if (risk === 'safe') return '安全';
  if (risk === 'caution') return '关注';
  return '撤稿/勘误';
}

/** 声呐点的极坐标 → 可读位置，让台账里的描述与盘面上的光点对得上。 */
function bearingOf(id: string): string {
  const blip = blipOf(id);
  if (!blip) return '方位未知';
  return `方位 ${blip.angle}° / 半径 ${blip.radius.toFixed(2)}`;
}

function blipText(id: string): string {
  const blip = blipOf(id);
  if (!blip) return '未检出';
  const detail = blip.detail ? `（${blip.detail}）` : '';
  return `${blip.label}${detail}`;
}

/** 按 DOI 找到共享对比矩阵里的那一行 —— 页码 / 坐标的唯一真源。 */
function paperOf(doi: string): PaperRow | undefined {
  return PAPER_ROWS.find((paper) => paper.anchor.sourceDoiOrUrl === doi);
}

/* ── 锚点：共享数据（camelCase，带 note）→ 虫洞契约（snake_case，无 note）── */

function paperAnchor(doi: string, level?: WormholeEvidenceAnchor['verification_level']) {
  const paper = paperOf(doi);
  if (!paper) {
    return {
      source_doi_or_url: doi,
      verification_level: level ?? ('Level_B_Preprint' as const),
    };
  }
  const { sourceDoiOrUrl, pdfPage, bbox, verificationLevel } = paper.anchor;
  return {
    source_doi_or_url: sourceDoiOrUrl,
    verification_level: level ?? verificationLevel,
    ...(pdfPage === undefined ? {} : { pdf_page: pdfPage }),
    ...(bbox === undefined ? {} : { bbox }),
  };
}

/** 撤稿 / 勘误类证据的来源是数据库条目而不是原文，用条目地址承载锚点。 */
function registryAnchor(registryPath: string, level: WormholeEvidenceAnchor['verification_level']) {
  return {
    source_doi_or_url: `https://retract-radar.matrixos.edu/registry/${registryPath}`,
    verification_level: level,
  };
}

/* ── 演示数据：一条记录 = 一份引文合规体检报告 ────────────────────────── */

const RETRACTED_DOI = '10.1021/jacs.4c0112';
const VERIFIED_DOI = '10.1038/s41566-025-01234-5';
const CHIRAL_DOI = '10.1002/adma.202401234';

/** 三篇代表文献的核验等级，从共享矩阵里取，不在本地另立一套判断。 */
const RETRACTED_LEVEL = 'Retracted_Warning' as const;

const seed: readonly RowSeed[] = [
  {
    title: `全量引文合规体检 · ${CLUSTER_PAPERS} 篇 / ${CLUSTER_CITATIONS} 条被引`,
    meta: `Crossref + PubPeer 双库交叉 · 声呐 ${BLIP_COUNT} 点 · 安全 ${SAFE_COUNT} / 关注 ${CAUTION_COUNT} / 撤稿 ${CRITICAL_COUNT}`,
    detail: `体检范围：三个流派聚类共 ${CLUSTER_PAPERS} 篇代表作、${CLUSTER_CITATIONS} 条被引，逐条比对 Crossref 撤稿库与 PubPeer 质疑帖。判定：声呐盘 ${SAFE_COUNT} 个安全点全部通过，未发现整篇撤稿；${blipText('b6')} 属格式问题，已批量修正。伦理声明：本综述全部引文经双库核验，无撤稿、无勘误未处理；AI 仅用于文献聚类与措辞润色，未参与事实判断，按顶刊要求披露于 Methods 末段。`,
    anchor: paperAnchor(VERIFIED_DOI),
    reportKind: '全量体检',
    checkedDois: REVIEW_CLUSTERS.map((cluster) => cluster.representativeDoi),
    riskLevel: '安全',
    riskItems: [`安全 ${SAFE_COUNT} 点`, `${blipText('b6')}（已修正）`],
    citationImpact: `${CLUSTER_PAPERS} 篇 / ${CLUSTER_CITATIONS} 条被引`,
    ethics: '引文双库核验通过；AI 使用范围限定为聚类与润色，已在 Methods 末段披露。',
    verdict: '放行',
    verification: 'Level_A_Verified',
    bearing: bearingOf('b1'),
  },
  {
    title: `撤稿拦截 · ${RETRACTED_DOI} 双氟代配体交联`,
    meta: `风险等级 撤稿/勘误 · ${bearingOf('b5')} · 该引文已被撤稿，禁止引用`,
    detail: `体检对象：JACS 2025 双氟代配体交联（DOI ${RETRACTED_DOI}）。检出：${blipText('b4')}；${blipText('b5')}。判定：该引文已被撤稿，禁止引用 —— 不得进入综述正文、参考文献表与简历证据链；若已写入草稿，须整段替换并加注勘误说明。影响面：该 DOI 在本站绑定 ${CLUSTER_PAPERS} 篇代表作中的 1 篇，按均被引 ${CITATIONS_PER_PAPER} 条估算，需回溯排查约 ${CITATIONS_PER_PAPER} 条二次引用。伦理声明：撤稿引文一律从证据链剔除，不作「技术路线代表文献」使用；如确需讨论该工作，只能以「已撤稿案例」身份出现在方法学局限一节。`,
    anchor: paperAnchor(RETRACTED_DOI, RETRACTED_LEVEL),
    reportKind: '撤稿拦截',
    checkedDois: [RETRACTED_DOI],
    riskLevel: '撤稿/勘误',
    riskItems: [blipText('b4'), blipText('b5')],
    citationImpact: `1 篇代表作 · 约 ${CITATIONS_PER_PAPER} 条二次引用待回溯`,
    ethics: '撤稿引文已从证据链剔除；如需讨论，仅以「已撤稿案例」出现在方法学局限一节。',
    verdict: '拦截 · 禁止引用',
    verification: RETRACTED_LEVEL,
    bearing: bearingOf('b4'),
  },
  {
    title: `图像重复质疑 · ${CHIRAL_DOI} 手性界面`,
    meta: `风险等级 关注 · ${bearingOf('b3')} · 待作者回应，暂缓引用`,
    detail: `体检对象：Adv. Mater. 2024 手性 R/S-MBA 界面（DOI ${CHIRAL_DOI}）。检出：${blipText('b3')}，PubPeer 讨论仍在进行，期刊尚未发布 Expression of Concern。判定：暂定「关注」——可以引用方法学描述，但不得把该文的效率数值（25.1%）写进对比矩阵的结论句，待作者回应后复检。伦理声明：处于质疑期的文献在综述中须标注「数据待核实」，不得作为流派代表性证据单独支撑论断。`,
    anchor: paperAnchor(CHIRAL_DOI),
    reportKind: '质疑待回应',
    checkedDois: [CHIRAL_DOI],
    riskLevel: '关注',
    riskItems: [blipText('b3'), blipText('b4')],
    citationImpact: '1 篇代表作 · 结论句暂缓引用',
    ethics: '质疑期文献须标注「数据待核实」，不得单独支撑流派论断。',
    verdict: '暂缓 · 方法学可引',
    verification: 'Level_A_Verified',
    bearing: bearingOf('b3'),
  },
  {
    title: `勘误未处理 · ${CRITICAL_COUNT} 组引用版本过期`,
    meta: `风险等级 撤稿/勘误 · ${bearingOf('b5')} · 引用版本与最新版不一致`,
    detail: `体检对象：综述参考文献表中 ${CRITICAL_COUNT} 组条目仍指向勘误前的旧版 PDF。检出：${blipText('b5')}；旧版页码与当前 Crossref 元数据不一致，正文引用的图号（Fig. 2b / Tab. S3）在勘误版中已移位。判定：须按勘误版重取页码与坐标后重新绑定锚点，否则下游简历证据台会因页码错位判为「无法定位」。伦理声明：勘误属于作者主动更正，不构成学术不端，但引用必须使用勘误后版本，并在方法学一节注明版本日期。`,
    anchor: registryAnchor('errata/jacs-4c0112', 'Level_B_Preprint'),
    reportKind: '勘误复核',
    checkedDois: [RETRACTED_DOI, CHIRAL_DOI],
    riskLevel: '撤稿/勘误',
    riskItems: [blipText('b5'), 'Fig. 2b / Tab. S3 页码移位'],
    citationImpact: `${CRITICAL_COUNT} 组条目需按勘误版重绑锚点`,
    ethics: '勘误不构成学术不端，但引用须用勘误后版本并注明版本日期。',
    verdict: '返工 · 重绑锚点',
    verification: 'Level_B_Preprint',
    bearing: bearingOf('b5'),
  },
];

/* ── 业务规格 ────────────────────────────────────────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'retract-reports',
  seed,
  emit: {
    targetApp: 'evidence-cv',
    payloadType: 'paper_doi_bundle',
  },
  accept: {
    payloadType: 'paper_doi_bundle',
    description:
      '接收复现核验舱投来的论文包，落成一条「待体检」报告：逐条比对 Crossref 撤稿库与 PubPeer，把检出风险项与伦理声明写清，再决定放行或拦截。',
  },
  draft: (rows) => {
    const used = new Set(rows.flatMap((row) => (Array.isArray(row.checkedDois) ? (row.checkedDois as unknown[]).map(String) : [])));
    const candidates = REVIEW_CLUSTERS.map((cluster) => cluster.representativeDoi);
    const next = candidates.find((doi) => !used.has(doi)) ?? candidates[0] ?? RETRACTED_DOI;
    const paper = paperOf(next);
    const anchor = paper ? paperAnchor(next) : registryAnchor(`queue/${next}`, 'Level_B_Preprint');
    return {
      title: `待体检 · ${next}`,
      meta: `新入队 · ${bearingOf('b2')} · 双库核验待执行`,
      detail: `体检队列新增一条：${next}${paper ? `（${paper.venue} · ${paper.strategy}）` : ''}。待执行：Crossref 撤稿库比对 → PubPeer 质疑帖检索 → 判定风险等级 → 写伦理声明。未出结论前一律按「关注」对待，不得进入下游证据链。`,
      anchor,
      reportKind: '待体检',
      checkedDois: [next],
      riskLevel: '关注',
      riskItems: ['双库核验待执行'],
      citationImpact: `1 篇 · 待评估`,
      ethics: '结论出具前按「关注」处理，不进入下游证据链。',
      verdict: '待判定',
      verification: anchor.verification_level,
      bearing: bearingOf('b2'),
    };
  },
  rowOfEnvelope: (envelope, nowIso) => {
    const base = defaultRowOfEnvelope(envelope, nowIso);
    const data = envelope.payload?.data ?? {};
    const rawDois = Array.isArray(data.dois) ? (data.dois as unknown[]) : [];
    const dois = rawDois.map((item) => String(item)).filter((doi) => doi !== '');
    const first = dois[0] ?? '';
    const paper = first === '' ? undefined : paperOf(first);
    return {
      ...base,
      title: `待体检 · ${first === '' ? base.title : first}`,
      meta: `${base.meta} · 双库核验待执行`,
      detail: `${base.detail}｜本站收到论文包（${dois.length} 个 DOI）后：Crossref 撤稿库比对 → PubPeer 检索 → 判定风险等级 → 写伦理声明 → 放行或拦截。`,
      reportKind: '待体检',
      checkedDois: dois,
      riskLevel: '关注',
      riskItems: ['双库核验待执行'],
      citationImpact: `${dois.length} 篇 · 待评估`,
      ethics: '结论出具前按「关注」处理，不进入下游证据链。',
      verdict: '待判定',
      verification: paper ? paper.anchor.verificationLevel : 'Level_B_Preprint',
      bearing: bearingOf('b2'),
    };
  },
  payloadOf: (rows) => {
    /**
     * 同一 DOI 可能出现在多份报告里（全量体检说放行、单篇拦截说禁止）。
     * 最终状态取**最严重**的一档：拦截 > 待定 > 放行 —— 下游只认最保守的结论。
     */
    const status = new Map<string, 'cleared' | 'pending' | 'blocked'>();
    const SEVERITY = { cleared: 1, pending: 2, blocked: 3 } as const;
    for (const row of rows) {
      const verdict = String(row.verdict ?? '');
      const mine: 'cleared' | 'pending' | 'blocked' = verdict.includes('拦截')
        ? 'blocked'
        : verdict.includes('放行')
          ? 'cleared'
          : 'pending';
      const list = Array.isArray(row.checkedDois) ? (row.checkedDois as unknown[]) : [];
      for (const item of list) {
        const doi = String(item);
        if (doi === '') continue;
        const previous = status.get(doi);
        if (previous === undefined || SEVERITY[mine] > SEVERITY[previous]) status.set(doi, mine);
      }
    }
    const dois = [...status.keys()];
    const pick = (kind: 'cleared' | 'pending' | 'blocked'): string[] =>
      dois.filter((doi) => status.get(doi) === kind);
    return {
      site: 'retract-radar',
      ledger: '论文引文合规体检报告与伦理声明',
      bundle_kind: 'citation_compliance_bundle',
      sonar: {
        blips: BLIP_COUNT,
        safe: SAFE_COUNT,
        caution: CAUTION_COUNT,
        critical: CRITICAL_COUNT,
      },
      checked_count: dois.length,
      cleared_count: pick('cleared').length,
      pending_count: pick('pending').length,
      blocked_count: pick('blocked').length,
      dois,
      cleared_dois: pick('cleared'),
      pending_dois: pick('pending'),
      blocked_dois: pick('blocked'),
      reports: rows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        reportKind: String(row.reportKind ?? ''),
        riskLevel: String(row.riskLevel ?? ''),
        verdict: String(row.verdict ?? ''),
        riskItems: Array.isArray(row.riskItems)
          ? (row.riskItems as unknown[]).map((item) => String(item))
          : [],
        ethics: String(row.ethics ?? ''),
        verification: String(row.verification ?? ''),
      })),
    };
  },
  csvOf: (rows) => ({
    header: ['被检论文', '报告类型', '风险等级', '检出风险项', '判定', '核验等级', '伦理声明', '最后修改'],
    rows: rows.map((row) => [
      String(row.title),
      String(row.reportKind ?? ''),
      String(row.riskLevel ?? ''),
      Array.isArray(row.riskItems) ? (row.riskItems as unknown[]).map(String).join('；') : '',
      String(row.verdict ?? ''),
      String(row.verification ?? ''),
      String(row.ethics ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),
});
