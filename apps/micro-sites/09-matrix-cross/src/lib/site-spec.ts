/**
 * 09 · Matrix-Cross 跨论文对比矩阵 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：多篇顶刊核心实验参量横向对比表
 * 投送：comparison_matrix_row → curvelab（11 CurveLab 非线性拟合示波器）
 * 接收：paper_doi_bundle ← lit-sonar（05 五源跨库引文声呐）
 *
 * 为什么这么写：
 *   一条记录 = **对比矩阵的一行**：一篇顶刊的 venue + 钝化界面策略 + 关键参量
 *   （EQE 峰值）+ 证据锚点（DOI / 页码 / PDF 坐标）。行内的排名、与上界的差值、
 *   坐标面积全部由 `PAPER_ROWS` 当场算出来 —— 派生值不手抄，否则就会出现
 *   「仪器面板显示 28.4%、台账写 28%」这类答辩事故。
 *
 * 投送语义：
 *   `comparison_matrix_row` 顾名思义是「一行」。本站投送的是**当前矩阵里 EQE 最高的
 *   那一行**（`payload.data.row`），因为 CurveLab 建一条拟合数据集只需要一条
 *   材料 / 方法 / 工况元信息，而不是整张表。整张矩阵仍随包带上（`payload.data.matrix`），
 *   供下游追溯「这一行是在什么坐标系里比出来的」。
 *
 * 锚点注意（本站是重灾区）：
 *   共享数据里的锚点是 SDK 的 camelCase 形状
 *   （`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel`，还多带一个 `note`），
 *   而虫洞信封契约的锚点层是 `additionalProperties: false` 的 snake_case。
 *   所以这里逐字段转换并**丢掉 note** —— 多一个字段，整个信封就过不了
 *   `specs/contracts/wormhole-envelope.schema.json` 的校验。
 */

import {
  PAPER_ROWS,
  createRowSpec,
  type PaperRow,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

/* ───────────────────────── 展示格式（确定性） ─────────────────────────
 * 不用 toLocaleString：Node 与浏览器的 ICU 版本可能不同，服务端预渲染与客户端
 * 首帧文本一旦不一致就是 React #418 水合报错。手写格式化最稳。
 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function fmtOne(value: number): string {
  return round1(value).toFixed(1);
}

/** 坐标面积（pt²）：bbox 的真实用法是「这一格数值占了原文多大一块」，不只是画个框。 */
function areaOf(bbox: readonly [number, number, number, number]): number {
  return Math.round((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
}

/* ───────────────────────── 锚点转换（camelCase → snake_case） ───────────────────────── */

/**
 * camelCase（SDK / instrument-ui）→ snake_case（虫洞信封契约）。
 * `note` 在契约里不存在，必须丢弃；`pdf_page` / `bbox` 只在有值时出现
 * （`exactOptionalPropertyTypes` 虽关，但契约层不允许 `undefined` 占位）。
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

/** 矩阵里新建、尚未绑定 DOI 的行用站内矩阵页兜底（Level B，绝不冒充 Level A）。 */
function matrixAnchor(slug: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://matrix-cross.matrixos.edu/matrix/${slug}`,
    verification_level: 'Level_B_Preprint',
  };
}

/* ───────────────────────── 参量解析与派生统计（不手抄数字） ───────────────────────── */

/** `28.4%` → 28.4。解析失败按 0 处理，绝不抛错（回调必须是纯函数）。 */
function eqeValueOf(paper: PaperRow): number {
  const value = Number.parseFloat(paper.eqe);
  return Number.isFinite(value) ? value : 0;
}

const EQE_VALUES: readonly number[] = PAPER_ROWS.map(eqeValueOf);
const ROW_COUNT = PAPER_ROWS.length;
/** 矩阵上界 / 下界：用 Math.max 而不是 sort，避免就地改动共享常量。 */
const BEST_EQE = EQE_VALUES.length > 0 ? Math.max(...EQE_VALUES) : 0;
const WORST_EQE = EQE_VALUES.length > 0 ? Math.min(...EQE_VALUES) : 0;
const EQE_SPREAD = round1(BEST_EQE - WORST_EQE);

/** 排名（1 = 效率最高）：数一数有几行比它高，+1。并列同名次。 */
function rankOf(value: number): number {
  return EQE_VALUES.filter((item) => item > value).length + 1;
}

/** 与矩阵上界的差值（百分点）：正数表示落后。 */
function deltaToBestOf(value: number): number {
  return round1(BEST_EQE - value);
}

/** 证据完整度：DOI + 页码 + 坐标三项。站内到处强调「这条数值能不能被点回原文」。 */
function completenessOf(paper: PaperRow): number {
  const source = paper.anchor;
  const parts = [
    source.sourceDoiOrUrl !== '',
    typeof source.pdfPage === 'number',
    Array.isArray(source.bbox) && source.bbox.length === 4,
  ];
  return parts.filter(Boolean).length;
}

const VERIFICATION_TEXT: Readonly<Record<string, string>> = {
  Level_A_Verified: 'Level A · 已双验',
  Level_B_Preprint: 'Level B · 仅预印本',
  Retracted_Warning: '已命中撤稿库',
};

function verificationTextOf(level: string): string {
  return VERIFICATION_TEXT[level] ?? level;
}

/** 三档证据的行数分布：矩阵的「可信度底数」，投送时随包带上。 */
function verificationBreakdown(): { levelA: number; levelB: number; retracted: number } {
  const count = (level: string): number =>
    PAPER_ROWS.filter((paper) => paper.anchor.verificationLevel === level).length;
  return {
    levelA: count('Level_A_Verified'),
    levelB: count('Level_B_Preprint'),
    retracted: count('Retracted_Warning'),
  };
}

const BREAKDOWN = verificationBreakdown();

/* ───────────────────────── 每行为什么值得对比（业务判断，不含数字） ─────────────────────────
 * 数字一律由派生量给出，这里只写「这一行在矩阵里的角色」，避免文字与数据打架。
 */
const ROW_ROLE: Readonly<Record<string, string>> = {
  r1: '矩阵的效率上界样本：CurveLab 拿它当拟合曲线的上界基准，而不是当平均值用。',
  r2: '手性界面路线的对照样本：界面工程与准二维完全不同，适合做双曲线对照而非简单排序。',
  r3: '唯一的预印本行：效率接近上界但未双验，下游拟合只能当软约束，不能当硬性上界。',
};

function roleOf(paperId: string): string {
  return ROW_ROLE[paperId] ?? '矩阵新增行：待补「这一行在对比里的角色」说明。';
}

/* ───────────────────────── 矩阵列定义 ───────────────────────── */

const LEDGER_NAME = '多篇顶刊核心实验参量横向对比表';

/** 矩阵的列定义：行内字段 → 展示列。顺序即仪器面板表格的列序。 */
const MATRIX_COLUMNS: ReadonlyArray<{ key: string; label: string; unit: string }> = [
  { key: 'venue', label: '顶刊文献', unit: '' },
  { key: 'strategy', label: '钝化界面工程', unit: '' },
  { key: 'eqe', label: 'EQE 峰值', unit: '%' },
  { key: 'rank', label: '矩阵排名', unit: '' },
  { key: 'deltaToBest', label: '落后上界', unit: 'pt' },
  { key: 'verificationLevel', label: '证据等级', unit: '' },
  { key: 'pdfPage', label: '原文页码', unit: 'P' },
  { key: 'bboxArea', label: '坐标面积', unit: 'pt²' },
];

const COLUMN_LABELS = MATRIX_COLUMNS.map((column) => column.label).join(' / ');

/* ───────────────────────── 论文 → 台账记录 ───────────────────────── */

function paperSeed(paper: PaperRow, position: number): RowSeed {
  const value = eqeValueOf(paper);
  const rank = rankOf(value);
  const delta = deltaToBestOf(value);
  const anchor = anchorOf(paper);
  const page = paper.anchor.pdfPage;
  const bbox = paper.anchor.bbox;
  const completeness = completenessOf(paper);
  const isBest = rank === 1;
  const note = paper.anchor.note ?? '未标注图号';

  const title = `${paper.venue} · ${paper.strategy}`;

  const meta = [
    `EQE ${paper.eqe}`,
    `排名 ${rank}/${ROW_COUNT}`,
    isBest ? '矩阵上界' : `落后上界 ${fmtOne(delta)} pt`,
    verificationTextOf(paper.anchor.verificationLevel),
    `锚点 ${completeness}/3`,
  ].join(' · ');

  const detail = [
    `对比维度：${COLUMN_LABELS}`,
    `关键参量 EQE ${paper.eqe}（${isBest ? '本矩阵最高' : `低于上界 ${fmtOne(delta)} 个百分点，上界 ${fmtOne(BEST_EQE)}%`}）`,
    `证据锚点：DOI ${paper.anchor.sourceDoiOrUrl} · P.${typeof page === 'number' ? page : '—'} ${note}${
      bbox ? ` · bbox [${bbox.join(', ')}] · ${areaOf(bbox)} pt²` : ' · 无 PDF 坐标'
    }`,
    `证据等级 ${paper.anchor.verificationLevel}：${
      paper.anchor.verificationLevel === 'Level_A_Verified'
        ? '已双验，可直接作为硬约束投送'
        : '未双验，下游只能当软约束'
    }`,
    `行角色：${roleOf(paper.id)}`,
  ].join('；');

  return {
    title,
    meta,
    detail,
    anchor,
    paperId: paper.id,
    rowIndex: position + 1,
    venue: paper.venue,
    strategy: paper.strategy,
    eqe: paper.eqe,
    eqeValue: value,
    rank,
    rowCount: ROW_COUNT,
    deltaToBest: delta,
    isBest,
    isWorst: round1(value - WORST_EQE) === 0,
    spread: EQE_SPREAD,
    verificationLevel: paper.anchor.verificationLevel,
    verificationText: verificationTextOf(paper.anchor.verificationLevel),
    sourceDoi: paper.anchor.sourceDoiOrUrl,
    pdfPage: typeof page === 'number' ? page : 0,
    bbox: bbox ? [...bbox] : [],
    bboxArea: bbox ? areaOf(bbox) : 0,
    figureNote: note,
    anchorCompleteness: completeness,
    rowRole: roleOf(paper.id),
  } satisfies RowSeed;
}

const seed: readonly RowSeed[] = PAPER_ROWS.map((paper, index) => paperSeed(paper, index));

/* ───────────────────────── 业务规格 ───────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'cross-matrix',
  seed,
  emit: {
    targetApp: 'curvelab',
    payloadType: 'comparison_matrix_row',
  },
  accept: {
    payloadType: 'paper_doi_bundle',
    description:
      '接收文献声呐（lit-sonar）投来的论文包，自动落成对比矩阵的一列：包里的 DOI 先建成「待抽取行」，补齐 EQE 峰值与 PDF 页码坐标后即可作为拟合数据集的元信息投送给 CurveLab。',
  },

  /** 新增一条 = 在矩阵末尾插一行「待抽取行」，它不计入排名，直到 EQE 被抽出来。 */
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `待抽取行 ${next} · 未绑定 DOI`,
      meta: ['EQE 待抽', `排名 未入矩阵/${ROW_COUNT}`, '落后上界待算', 'Level B · 仅预印本', '锚点 0/3'].join(
        ' · ',
      ),
      detail: [
        `对比维度：${COLUMN_LABELS}`,
        '关键参量：EQE 待从 PDF 正文抽取；抽到之前不要把它算进矩阵排名，否则会污染上界',
        '证据锚点：站内矩阵页（Level_B_Preprint，未绑定 DOI / 页码 / 坐标，锚点 0/3）',
        '证据等级 Level_B_Preprint：未双验，投送时会被下游标为「待复核」',
        '行角色：矩阵新增行，先抽参量，再决定它在对比里当上界、对照还是软约束。',
      ].join('；'),
      anchor: matrixAnchor(`pending-${next}`),
      paperId: `draft-${next}`,
      rowIndex: rows.length + 1,
      venue: '待绑定顶刊',
      strategy: '待填钝化策略',
      eqe: '待抽',
      eqeValue: 0,
      rank: 0,
      rowCount: ROW_COUNT + 1,
      deltaToBest: 0,
      isBest: false,
      isWorst: false,
      spread: EQE_SPREAD,
      verificationLevel: 'Level_B_Preprint',
      verificationText: verificationTextOf('Level_B_Preprint'),
      sourceDoi: '',
      pdfPage: 0,
      bbox: [],
      bboxArea: 0,
      figureNote: '待绑定图号',
      anchorCompleteness: 0,
      rowRole: roleOf(`draft-${next}`),
    } satisfies RowSeed;
  },

  /** 收到论文包：先落成「待抽取行」，把 DOI 清单留在记录里，等人工逐篇抽参量。 */
  rowOfEnvelope: (envelope) => {
    const data = envelope.payload.data;
    const anchors: readonly WormholeEvidenceAnchor[] = Array.isArray(envelope.payload.evidence_anchors)
      ? envelope.payload.evidence_anchors
      : [];
    const firstAnchor = anchors[0];
    const anchor =
      firstAnchor ?? matrixAnchor(`inbox-${String(envelope.trace_id).slice(0, 8)}`);

    const rawDois = Array.isArray(data.doiBundle)
      ? data.doiBundle
      : Array.isArray(data.dois)
        ? data.dois
        : [];
    const dois = rawDois.map((doi) => String(doi)).filter((doi) => doi !== '');
    const sourceApp = String(envelope.source_app ?? 'lit-sonar');
    const traceShort = String(envelope.trace_id).slice(0, 8);
    const collectionCount = Number(data.collectionCount ?? 0);

    return {
      title: `待抽取 · 论文包 ${String(dois.length).padStart(2, '0')} 篇`,
      meta: [
        'EQE 待抽',
        `来源 ${sourceApp}`,
        `DOI ${dois.length} 个`,
        collectionCount > 0 ? `收藏夹 ${collectionCount} 个` : '单篇投送',
        `锚点 ${anchors.length} 条`,
      ].join(' · '),
      detail: [
        `接收 ${String(envelope.payload_type ?? 'paper_doi_bundle')} · 来源 ${sourceApp} · trace ${traceShort}`,
        `对比维度：${COLUMN_LABELS}`,
        dois.length > 0
          ? `待抽取 DOI：${dois.slice(0, 3).join('、')}${dois.length > 3 ? ' 等' : ''}`
          : '论文包未携带 DOI，需回站内补检索',
        '下一步：逐篇打开 PDF，把 EQE 峰值与页码坐标抽进本行；抽完这一行才进矩阵排名',
        `证据锚点取自投来信封（${anchors.length} 条），未双验时下游只能当软约束`,
      ].join('；'),
      anchor,
      paperId: `ext-${traceShort}`,
      rowIndex: 0,
      venue: '待绑定顶刊',
      strategy: '待抽取策略',
      eqe: '待抽',
      eqeValue: 0,
      rank: 0,
      rowCount: ROW_COUNT + 1,
      deltaToBest: 0,
      isBest: false,
      isWorst: false,
      spread: EQE_SPREAD,
      verificationLevel: anchor.verification_level,
      verificationText: verificationTextOf(anchor.verification_level),
      sourceDoi: dois[0] ?? '',
      pdfPage: typeof anchor.pdf_page === 'number' ? anchor.pdf_page : 0,
      bbox: Array.isArray(anchor.bbox) ? [...anchor.bbox] : [],
      bboxArea:
        Array.isArray(anchor.bbox) && anchor.bbox.length === 4
          ? areaOf(anchor.bbox as readonly [number, number, number, number])
          : 0,
      figureNote: '待绑定图号',
      anchorCompleteness: 0,
      rowRole: '外部流入行：先抽参量，再决定它在矩阵里当上界、对照还是软约束。',
      receivedFrom: sourceApp,
      traceId: String(envelope.trace_id),
      doiBundle: dois,
    } satisfies RowSeed;
  },

  /** 投送载荷：`row` 是那一行（CurveLab 建数据集用），`matrix` 是整张表（追溯坐标系用）。 */
  payloadOf: (rows) => {
    const matrix = rows.map((row) => ({
      id: String(row.id),
      paperId: String(row.paperId ?? ''),
      venue: String(row.venue ?? ''),
      strategy: String(row.strategy ?? ''),
      eqe: String(row.eqe ?? ''),
      eqeValue: Number(row.eqeValue ?? 0),
      rank: Number(row.rank ?? 0),
      deltaToBest: Number(row.deltaToBest ?? 0),
      verificationLevel: String(row.verificationLevel ?? ''),
      sourceDoi: String(row.sourceDoi ?? ''),
      pdfPage: Number(row.pdfPage ?? 0),
      bbox: Array.isArray(row.bbox) ? row.bbox.map((item) => Number(item)) : [],
      figureNote: String(row.figureNote ?? ''),
      rowRole: String(row.rowRole ?? ''),
    }));

    // 锁定行 = 矩阵里 EQE 最高的那一行（eqeValue 为 0 的待抽取行不会被选中）。
    const focused = matrix.reduce<(typeof matrix)[number] | undefined>(
      (best, row) => (best === undefined || row.eqeValue > best.eqeValue ? row : best),
      undefined,
    );

    return {
      site: 'matrix-cross',
      ledger: LEDGER_NAME,
      target: 'curvelab',
      matrixName: '顶刊钝化策略 × EQE 峰值',
      rowCount: matrix.length,
      columnCount: MATRIX_COLUMNS.length,
      columns: MATRIX_COLUMNS.map((column) => ({ key: column.key, label: column.label, unit: column.unit })),
      // 上界 / 下界 / 极差：CurveLab 画拟合曲线时直接拿这三个值定 y 轴范围。
      bestEqe: BEST_EQE,
      worstEqe: WORST_EQE,
      spread: EQE_SPREAD,
      verification: BREAKDOWN,
      // comparison_matrix_row 的「那一行」：材料 / 方法 / 工况元信息，供 CurveLab 建数据集。
      row: focused ?? null,
      matrix,
    };
  },

  csvOf: (rows) => ({
    header: [
      '顶刊文献',
      '钝化界面工程',
      'EQE 峰值',
      '矩阵排名',
      '落后上界(pt)',
      '证据等级',
      '原文页码',
      'PDF 坐标',
      '图号',
      'DOI',
      '锚点完整度',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.venue ?? ''),
      String(row.strategy ?? ''),
      String(row.eqe ?? ''),
      Number(row.rank ?? 0) > 0 ? `${String(row.rank)}/${String(row.rowCount ?? ROW_COUNT)}` : '未入排名',
      fmtOne(Number(row.deltaToBest ?? 0)),
      String(row.verificationLevel ?? ''),
      Number(row.pdfPage ?? 0) > 0 ? `P.${String(row.pdfPage)}` : '—',
      Array.isArray(row.bbox) && row.bbox.length === 4
        ? `[${row.bbox.map((item) => String(item)).join(', ')}]`
        : '—',
      String(row.figureNote ?? ''),
      String(row.sourceDoi ?? ''),
      `${String(row.anchorCompleteness ?? 0)}/3`,
      String(row.updatedAt ?? ''),
    ]),
  }),
});

/** 全站口径值：README 与答辩口径都从这里引用，避免两处写不一样的数字。 */
export const CROSS_MATRIX_STATS = {
  ledger: LEDGER_NAME,
  rows: ROW_COUNT,
  columns: MATRIX_COLUMNS.length,
  bestEqe: BEST_EQE,
  worstEqe: WORST_EQE,
  spread: EQE_SPREAD,
  verification: BREAKDOWN,
} as const;
