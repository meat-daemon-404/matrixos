/**
 * 17 · 区块链级学术证据简历工坊 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：多版本保研/求职证据级简历库（一条记录 = 一个简历版本）
 * 接收：五类全收 —— paper_doi_bundle / comparison_matrix_row / curve_fit_parameters
 *       / mentor_match_card / verified_cv_evidence（主要来源 retract-radar，实际各站都会投）
 * 投送：verified_cv_evidence → prejob（生涯多重宇宙决策树）
 *
 * 为什么这么写：增删改清空导出投送接收的**语义**由 `createRowSpec` 固化，
 * 这里只描述「这个站有哪些简历版本、版本长什么样、投出去带什么字段」。
 *
 * 本站的两个核心难点：
 *   1. **锚点形状转换**。共享数据 `CV_ENTRIES` / `PAPER_ROWS` 里的锚点是 SDK 的 camelCase
 *      形状（`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel` / `note`），
 *      而虫洞信封契约是 snake_case 且锚点层 `additionalProperties: false`。
 *      所以 `toContractAnchor()` 逐字段挑出来重建，`note` 一律丢弃 —— 多带一个字段，
 *      整个信封就过不了 `specs/contracts/wormhole-envelope.schema.json` 校验。
 *   2. **五类 payload 的汇聚分流**。`rowOfEnvelope()` 按 `payload_type` 分流，
 *      分别落成「论文证据 / 对比矩阵证据 / 拟合参数证据 / 导师匹配证据 / 简历证据」，
 *      未知类型退化为「外部证据」而不是抛错（回调必须是纯函数且不抛错）。
 *
 * 演示数值全部由 `@matrixos/microsite-data` 的 `CV_ENTRIES` / `PAPER_ROWS` 算出来，
 * 不手抄，避免台账与仪器面板对不上。
 */

import {
  CV_ENTRIES,
  PAPER_ROWS,
  createRowSpec,
  type ConsumableEnvelope,
  type RowSeed,
} from '@matrixos/microsite-data';

const LEDGER_NAME = '多版本保研/求职证据级简历库';

/** 本站基线锚点：没有任何可用锚点时兜底，保证投送信封永远满足「至少 1 条锚点」。 */
const STATION_ANCHOR = {
  source_doi_or_url: 'https://evidence-cv.matrixos.edu/',
  verification_level: 'Level_B_Preprint',
} as const;

type SdkAnchor = (typeof CV_ENTRIES)[number]['anchors'][number];
type ContractAnchor = NonNullable<RowSeed['anchor']>;

/** 一个简历版本里收录的一条经历（锚点已转成契约形状）。 */
interface CvVersionEntry {
  readonly entryId: string;
  readonly title: string;
  readonly role: string;
  readonly period: string;
  readonly anchors: readonly ContractAnchor[];
}

/* ───────────────────────── 纯函数小工具 ───────────────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim() === '' ? fallback : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstRecord(value: unknown): Record<string, unknown> {
  for (const item of listOf(value)) {
    const record = asRecord(item);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function isBbox(value: unknown): value is readonly [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

/* ───────────────────────── 锚点：camelCase → snake_case ───────────────────────── */

/**
 * SDK 锚点 → 虫洞契约锚点。
 *
 * 契约里锚点层是 `additionalProperties: false`，只有
 * `source_doi_or_url` / `verification_level` / `pdf_page` / `bbox` 四个字段，
 * 所以 `note` 必须丢弃（共享数据里每条锚点都带 `note`，直接展开就会让信封非法）。
 */
function toContractAnchor(raw: SdkAnchor | undefined): ContractAnchor {
  if (!raw) return { ...STATION_ANCHOR };
  return {
    source_doi_or_url: raw.sourceDoiOrUrl,
    verification_level: raw.verificationLevel,
    ...(typeof raw.pdfPage === 'number' ? { pdf_page: raw.pdfPage } : {}),
    ...(raw.bbox ? { bbox: raw.bbox } : {}),
  };
}

/** 收进来的锚点再洗一遍：只保留契约字段，非法等级退化为 Level_B_Preprint。 */
function sanitizeAnchor(value: unknown): ContractAnchor | null {
  const raw = asRecord(value);
  const source = str(raw.source_doi_or_url);
  if (source === '') return null;
  const level = raw.verification_level;
  const verificationLevel =
    level === 'Level_A_Verified' || level === 'Level_B_Preprint' || level === 'Retracted_Warning'
      ? level
      : 'Level_B_Preprint';
  const page = num(raw.pdf_page);
  return {
    source_doi_or_url: source,
    verification_level: verificationLevel,
    ...(page !== null && page >= 1 ? { pdf_page: Math.trunc(page) } : {}),
    ...(isBbox(raw.bbox) ? { bbox: raw.bbox } : {}),
  };
}

interface LevelCounts {
  readonly levelA: number;
  readonly levelB: number;
  readonly retracted: number;
}

function countLevels(anchors: readonly ContractAnchor[]): LevelCounts {
  let levelA = 0;
  let levelB = 0;
  let retracted = 0;
  for (const anchor of anchors) {
    if (anchor.verification_level === 'Level_A_Verified') levelA += 1;
    else if (anchor.verification_level === 'Level_B_Preprint') levelB += 1;
    else retracted += 1;
  }
  return { levelA, levelB, retracted };
}

/* ───────────────────────── 条目池：来自共享演示数据 ───────────────────────── */

/** CV_ENTRIES 的两条科研经历，锚点转成契约形状。 */
const CV_POOL: readonly CvVersionEntry[] = CV_ENTRIES.map((entry) => ({
  entryId: entry.id,
  title: entry.title,
  role: entry.role,
  period: entry.period,
  anchors: entry.anchors.map((anchor) => toContractAnchor(anchor)),
}));

/**
 * 跨论文对比矩阵里「未定稿」的证据（PAPER_ROWS 中非 Level-A 的行）。
 * 简历版本可以收录预印本证据，但必须如实标注 Level_B —— 这正是本站「证据级」的意思。
 */
function preprintEntries(): readonly CvVersionEntry[] {
  const out: CvVersionEntry[] = [];
  for (const row of PAPER_ROWS) {
    if (row.anchor.verificationLevel === 'Level_A_Verified') continue;
    const year = /\d{4}/.exec(row.venue)?.[0] ?? '待刊';
    out.push({
      entryId: `matrix-${row.id}`,
      title: `${row.strategy}（${row.venue}）`,
      role: '跨论文对比矩阵补充证据',
      period: year,
      anchors: [toContractAnchor(row.anchor)],
    });
  }
  return out;
}

const ENTRY_POOL: readonly CvVersionEntry[] = [...CV_POOL, ...preprintEntries()];
const ENTRY_INDEX = new Map(ENTRY_POOL.map((entry) => [entry.entryId, entry]));
const PREPRINT_IDS = ENTRY_POOL.filter((entry) => entry.entryId.startsWith('matrix-')).map(
  (entry) => entry.entryId,
);

function resolveEntries(ids: readonly string[]): readonly CvVersionEntry[] {
  const out: CvVersionEntry[] = [];
  for (const id of ids) {
    const entry = ENTRY_INDEX.get(id);
    if (entry) out.push(entry);
  }
  return out;
}

/* ───────────────────────── 三个简历版本 ───────────────────────── */

interface VersionRecipe {
  readonly version: string;
  readonly title: string;
  readonly purpose: string;
  readonly emphasis: string;
  /** 引用 ENTRY_POOL 的 entryId；缺失的条目会被安静跳过（数据变了也不炸）。 */
  readonly entryIds: readonly string[];
}

const RECIPES: readonly VersionRecipe[] = [
  {
    version: 'v1',
    title: '保研版 v1 · 学术证据优先',
    purpose: '推免 / 直博申请',
    emphasis: '第一屏就放已验真的论文锚点与软著仓库哈希，GPA 等量化项作为辅助证据',
    entryIds: ['cv1', 'cv2'],
  },
  {
    version: 'v2',
    title: '求职版 v2 · 学术 + 工程全量',
    purpose: '头部光电 / 半导体企业研发岗',
    emphasis: '论文、软著、在投预印本三条证据全给，让面试官自己判断证据强度',
    entryIds: ['cv1', 'cv2', ...PREPRINT_IDS],
  },
  {
    version: 'v3',
    title: '套磁版 v3 · 方向精准匹配',
    purpose: '暑期科研 / 套磁',
    emphasis: '只保留与目标课题组方向直接相关的论文与在投工作，避免信息过载',
    entryIds: ['cv1', ...PREPRINT_IDS],
  },
];

const seed: readonly RowSeed[] = RECIPES.map((recipe) => {
  const entries = resolveEntries(recipe.entryIds);
  const anchors = entries.flatMap((entry) => entry.anchors);
  const levels = countLevels(anchors);
  const levelNote = levels.retracted > 0 ? ` / 撤稿警示 ${levels.retracted}` : '';
  const levelB = levels.levelB > 0 ? ` / Level-B ${levels.levelB}` : '';
  return {
    title: recipe.title,
    meta: `${recipe.purpose} · ${entries.length} 条经历 · ${anchors.length} 个证据锚点 · Level-A ${levels.levelA}${levelB}${levelNote}`,
    detail: `${recipe.emphasis}。锚点已按虫洞契约转成 snake_case（source_doi_or_url / verification_level / pdf_page / bbox），SDK 侧的 note 字段按契约要求丢弃。`,
    anchor: anchors[0] ?? { ...STATION_ANCHOR },
    version: recipe.version,
    purpose: recipe.purpose,
    evidenceType: 'verified_cv_evidence',
    entryCount: entries.length,
    anchorCount: anchors.length,
    levelA: levels.levelA,
    levelB: levels.levelB,
    retracted: levels.retracted,
    entries,
  } satisfies RowSeed;
});

/* ───────────────────────── 五类 payload 的分流 ───────────────────────── */

const TYPE_LABEL: Readonly<Record<string, string>> = {
  paper_doi_bundle: '论文证据',
  comparison_matrix_row: '对比矩阵证据',
  curve_fit_parameters: '拟合参数证据',
  mentor_match_card: '导师匹配证据',
  verified_cv_evidence: '简历证据',
};

/** 五类全收的固定顺序（README 与投送 payload 都按这个顺序列）。 */
const TYPE_ORDER = [
  { type: 'paper_doi_bundle', label: '论文证据', from: 'lit-sonar / retract-radar' },
  { type: 'comparison_matrix_row', label: '对比矩阵证据', from: 'matrix-cross / chart-foundry' },
  { type: 'curve_fit_parameters', label: '拟合参数证据', from: 'curvelab' },
  { type: 'mentor_match_card', label: '导师匹配证据', from: 'mentor / cold-email' },
  { type: 'verified_cv_evidence', label: '简历证据', from: 'gpa / spark / yunheng / prejob' },
] as const;

interface PayloadSummary {
  readonly title: string;
  readonly detail: string;
  readonly entries: readonly CvVersionEntry[];
}

function labelOf(type: string): string {
  return TYPE_LABEL[type] ?? '外部证据';
}

/** 按 payload_type 分流，把不同站的 payload.data 描述成一条可读记录。 */
function describePayload(type: string, data: Record<string, unknown>): PayloadSummary {
  if (type === 'paper_doi_bundle') {
    const dois = listOf(data.doiBundle ?? data.dois ?? data.doiList)
      .map((item) => str(item))
      .filter((item) => item !== '');
    const collections = listOf(data.collections ?? data.papers);
    const first = firstRecord(data.collections ?? data.papers);
    const head = dois.slice(0, 3).join('、');
    return {
      title: `论文证据 · ${dois.length || collections.length || 1} 篇待嵌锚点`,
      detail: head
        ? `DOI：${head}${dois.length > 3 ? ' 等' : ''}；已落成待分配的论文证据条目，可挂到任一简历版本`
        : `${str(first.title, '未附 DOI 列表')}；已落成待分配的论文证据条目`,
      entries: dois.slice(0, 3).map((doi, index) => ({
        entryId: `recv-doi-${index + 1}`,
        title: doi,
        role: '论文 DOI 证据（待挂载）',
        period: '',
        anchors: [],
      })),
    };
  }

  if (type === 'comparison_matrix_row') {
    const rows = listOf(data.rows ?? data.matrixRows ?? data.matrix);
    const venues: string[] = [];
    for (const item of rows.slice(0, 3)) {
      const record = asRecord(item);
      const label = str(record.venue ?? record.name ?? record.title);
      if (label !== '') venues.push(label);
    }
    return {
      title: `对比矩阵证据 · ${rows.length || 1} 行对比`,
      detail:
        venues.length > 0
          ? `覆盖 ${venues.join('、')}${rows.length > 3 ? ' 等' : ''}；已落成待挂载的对比矩阵证据条目`
          : '跨论文对比矩阵已入库，等待挂到简历版本',
      entries: [],
    };
  }

  if (type === 'curve_fit_parameters') {
    const datasets = listOf(data.datasets ?? data.fits ?? data.curves);
    const first = firstRecord(data.datasets ?? data.fits ?? data.curves);
    const r2 = num(first.rSquared ?? first.r2 ?? data.rSquared ?? data.r2);
    return {
      title: `拟合参数证据 · ${datasets.length || 1} 组曲线`,
      detail: `${r2 !== null ? `最优拟合 R² = ${r2.toFixed(4)}；` : ''}拟合参数已入库，可作为方法学证据挂到简历条目`,
      entries: [],
    };
  }

  if (type === 'mentor_match_card') {
    const profiles = listOf(data.profiles ?? data.mentors ?? data.cards);
    const first = firstRecord(data.profiles ?? data.mentors ?? data.cards);
    const name = str(first.name ?? data.mentorName ?? data.name, '导师匹配卡');
    const score = num(first.matchScore ?? data.matchScore);
    return {
      title: `导师匹配证据 · ${name}`,
      detail: `${score !== null ? `匹配度 ${score.toFixed(1)}%；` : ''}匹配卡已入库，可在套磁版简历里引用`,
      entries: [],
    };
  }

  if (type === 'verified_cv_evidence') {
    const versions = listOf(data.versions ?? data.plans);
    const capabilities = listOf(data.capabilities ?? data.entries ?? data.items);
    const gpa = num(data.gpa ?? data.currentGpa ?? data.targetGpa);
    const parts = [
      versions.length > 0 ? `含 ${versions.length} 个简历版本` : `含 ${capabilities.length} 条能力证据`,
      gpa !== null ? `GPA ${gpa.toFixed(2)}` : '',
      '已并入证据库，等待分配到具体版本',
    ];
    return {
      title: `简历证据 · ${str(data.ledger, '已验真能力画像')}`,
      detail: parts.filter((part) => part !== '').join('；'),
      entries: [],
    };
  }

  const fallbackKeys = Object.keys(data).slice(0, 3);
  return {
    title: `外部证据 · ${labelOf(type)}`,
    detail:
      fallbackKeys.length > 0
        ? `未登记的 payload_type「${type}」，已按通用字段落库（${fallbackKeys.join('、')}）`
        : `未登记的 payload_type「${type}」，已按通用规则落库`,
    entries: [],
  };
}

/**
 * 接收回调：把任意一站的信封并成一条「证据条目」。
 *
 * 分流规则（对应五类全收）：
 *   paper_doi_bundle      → 论文证据（列出 DOI）
 *   comparison_matrix_row → 对比矩阵证据（列出去向期刊/策略）
 *   curve_fit_parameters  → 拟合参数证据（带 R²）
 *   mentor_match_card     → 导师匹配证据（带导师名与匹配度）
 *   verified_cv_evidence  → 简历证据（带版本数 / GPA）
 *   其它                  → 外部证据（不抛错，通用落库）
 */
function rowOfEnvelope(envelope: ConsumableEnvelope, nowIso: string): RowSeed {
  const data = asRecord(envelope.payload?.data);
  const anchors: ContractAnchor[] = [];
  for (const raw of listOf(envelope.payload?.evidence_anchors)) {
    const anchor = sanitizeAnchor(raw);
    if (anchor) anchors.push(anchor);
  }
  const type = str(envelope.payload_type, 'verified_cv_evidence');
  const source = str(envelope.source_app, 'unknown');
  const summary = describePayload(type, data);
  const levels = countLevels(anchors);
  const traceId = str(envelope.trace_id, 'unknown');
  return {
    title: summary.title,
    meta: `来自 ${source} · ${type} · 证据锚点 ${anchors.length} 条`,
    detail: `${summary.detail}；接收于 ${nowIso.slice(0, 19).replace('T', ' ')}，trace ${traceId.slice(0, 8)}`,
    anchor: anchors[0] ?? { ...STATION_ANCHOR },
    evidenceType: type,
    sourceApp: source,
    traceId,
    receivedAt: nowIso,
    entryCount: summary.entries.length,
    anchorCount: anchors.length,
    levelA: levels.levelA,
    levelB: levels.levelB,
    retracted: levels.retracted,
    entries: summary.entries,
  } satisfies RowSeed;
}

/* ───────────────────────── 规格 ───────────────────────── */

const baseSpec = createRowSpec({
  exportName: 'cv-versions',

  seed,

  emit: {
    targetApp: 'prejob',
    payloadType: 'verified_cv_evidence',
  },

  accept: {
    // manifest.accepts 有五类，面板展示取第一个；rowOfEnvelope 负责处理全部五类。
    payloadType: 'paper_doi_bundle',
    description:
      '五类全收：论文 DOI 包 / 对比矩阵行 / 拟合参数 / 导师匹配卡 / 已验真简历证据，逐条落成证据条目，挂到对应简历版本的锚点上。',
  },

  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `新建简历版本 v${next} · 待选条目`,
      meta: '用途待定 · 0 条经历 · 0 个证据锚点',
      detail:
        '点「编辑」写版本名与用途，再用接收区把各站投来的证据逐条挂到本版本；没有锚点的记录不会进投递信封。',
      version: `v${next}`,
      purpose: '待定',
      evidenceType: 'verified_cv_evidence',
      entryCount: 0,
      anchorCount: 0,
      levelA: 0,
      levelB: 0,
      retracted: 0,
      entries: [],
    } satisfies RowSeed;
  },

  payloadOf: (rows, nowIso) => {
    const versions = rows.map((row) => {
      const entries = listOf(row.entries).map((item) => {
        const entry = asRecord(item);
        const anchors: ContractAnchor[] = [];
        for (const raw of listOf(entry.anchors)) {
          const anchor = sanitizeAnchor(raw);
          if (anchor) anchors.push(anchor);
        }
        return {
          entryId: str(entry.entryId),
          title: str(entry.title),
          role: str(entry.role),
          period: str(entry.period),
          anchorCount: anchors.length,
          anchors,
        };
      });
      return {
        id: String(row.id),
        title: String(row.title),
        version: str(row.version),
        purpose: str(row.purpose, '待定'),
        evidenceType: str(row.evidenceType, 'verified_cv_evidence'),
        entryCount: num(row.entryCount) ?? entries.length,
        anchorCount: num(row.anchorCount) ?? 0,
        verification: {
          levelA: num(row.levelA) ?? 0,
          levelB: num(row.levelB) ?? 0,
          retracted: num(row.retracted) ?? 0,
        },
        entries,
      };
    });

    /* 去重后的条目数：同一篇论文出现在三个版本里，对 prejob 只算一条能力证据。 */
    const entryIds = new Set<string>();
    for (const version of versions) {
      for (const entry of version.entries) {
        if (entry.entryId !== '') entryIds.add(entry.entryId);
      }
    }

    let levelA = 0;
    let levelB = 0;
    let retracted = 0;
    let anchorCount = 0;
    for (const version of versions) {
      levelA += version.verification.levelA;
      levelB += version.verification.levelB;
      retracted += version.verification.retracted;
      anchorCount += version.anchorCount;
    }

    /* 五类覆盖度：接收过哪类证据，这里就有数（seed 行都是本站原生 verified_cv_evidence）。 */
    const typeCounts = new Map<string, number>();
    for (const row of rows) {
      const type = str(row.evidenceType, 'verified_cv_evidence');
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    }

    return {
      site: 'evidence-cv',
      ledger: LEDGER_NAME,
      target: 'prejob',
      generatedAt: nowIso,
      versionCount: versions.length,
      entryCount: entryIds.size,
      anchorCount,
      verification: { levelA, levelB, retracted },
      acceptedTypes: TYPE_ORDER.map((item) => ({
        type: item.type,
        label: item.label,
        count: typeCounts.get(item.type) ?? 0,
      })),
      versions,
    };
  },

  rowOfEnvelope,

  csvOf: (rows) => ({
    header: [
      '简历版本',
      '用途',
      '条目数',
      '证据锚点数',
      'Level-A',
      'Level-B',
      '撤稿警示',
      '证据类型',
      '说明',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.title),
      str(row.purpose, '待定'),
      String(num(row.entryCount) ?? 0),
      String(num(row.anchorCount) ?? 0),
      String(num(row.levelA) ?? 0),
      String(num(row.levelB) ?? 0),
      String(num(row.retracted) ?? 0),
      str(row.evidenceType, 'verified_cv_evidence'),
      String(row.detail),
      String(row.updatedAt ?? ''),
    ]),
  }),
});

/**
 * 本地演示信封：真的用 PAPER_ROWS 的 3 篇代表文献拼一个 paper_doi_bundle，
 * 锚点走同一个 camelCase → snake_case 转换（note 丢弃）。
 * 这样「接收演示」按钮演示的是真实分流路径，不是空壳。
 *
 * 为什么挂在 createRowSpec 之外：`RowSpecConfig` 没有 `demoEnvelope` 这一项
 * （它是 `SiteWorkbenchSpec.accept` 上的字段），工厂没有透传，所以在返回值上补。
 */
function buildDemoEnvelope(nowIso: string): ConsumableEnvelope {
  const anchors = PAPER_ROWS.map((row) => toContractAnchor(row.anchor));
  const doiBundle = PAPER_ROWS.map((row) => row.anchor.sourceDoiOrUrl);
  const stamp = nowIso.replace(/[^0-9]/g, '').slice(0, 14);
  return {
    trace_id: `demo-paper-${stamp}`,
    source_app: 'lit-sonar',
    payload_type: 'paper_doi_bundle',
    payload: {
      data: {
        site: 'lit-sonar',
        ledger: '五源跨库引文声呐站',
        target: 'evidence-cv',
        collectionCount: PAPER_ROWS.length,
        doiCount: doiBundle.length,
        doiBundle,
        papers: PAPER_ROWS.map((row) => ({
          venue: row.venue,
          strategy: row.strategy,
          eqe: row.eqe,
        })),
      },
      evidence_anchors: anchors,
    },
  };
}

export const siteSpec = {
  ...baseSpec,
  accept: {
    ...baseSpec.accept,
    demoEnvelope: buildDemoEnvelope,
  },
};
