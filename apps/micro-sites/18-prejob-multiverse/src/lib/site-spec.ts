/**
 * 18 · 生涯多重宇宙期望决策树 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：保研直博 / 选调考公 / 大厂 Offer 对比树
 * 投送：verified_cv_evidence → evidence-cv（证据简历工坊）
 * 接收：verified_cv_evidence（来自证据简历工坊的已验真能力画像）
 *
 * 为什么这么写：增删改清空导出投送接收的**语义**由 `createRowSpec` 固化，
 * 这里只描述「这棵决策树有哪些路径、路径长什么样、投出去带什么字段」。
 *
 * ## 数字从哪来（本站与 17 站最大的不同）
 *
 * `CAREER_PATHS` 里的 85 / 120 / 70 万是模型假设值，学职平台也不提供薪资字段 ——
 * 所以「万元」量级无法被真实数据测量。这里能做的是**相对校准**：
 *
 *   1. `tools/derive-career-calibration.mjs` 离线把学职平台 1778 条专业目录里的
 *      本科层次专业按「学科门类 / 专业类」圈到每条生涯路径，聚合出
 *      就业满意度（票数加权）、评价票数、平均开设院校数三个维度；
 *   2. 三维加权成「专业面现实指数」，除以全库现实指数得到校准系数（clamp 到 ±20%）；
 *   3. 期望收益 = round(模型基准 × 校准系数)；概率 = 50% 模型先验 + 50% 就业满意度分档占比；
 *      五年轨迹 = 模型轨迹逐项 × 校准系数。
 *
 * 生成结果落在 `src/lib/career-calibration.ts`（约 6 KB 常量，`--check` 可校验一致性）。
 *
 * 为什么不在运行时聚合：`src/lib/xz-data.ts` 静态 import 了 918 KB + 427 KB 的 JSON，
 * 直接在 site-spec 里 import 它会把 1.35 MB 并进 workbench chunk，抵消
 * `use-heavy-detail.ts` 的懒加载优化（`packages/xz-knowledge/test/lazy-load-guard.test.ts`
 * 专门盯着这条线）。所以这里只读生成好的小常量表。
 *
 * ## 语义红线（不能越）
 *
 * 学职平台的 `flow.paths` 是**去向占比**（7% 的毕业生选择考研），不是**成功率**；
 * 决策树的 `probabilities.success` 是模型估计。两者不可相乘、平均或互相替换，
 * 所以本站完全不碰 `flow.paths`。`probabilities` 用的是「就业满意度分档占比」这个
 * 代理指标，并在台账与 README 里明写它是代理指标，不是真实成功率。
 */

import {
  CAREER_PATHS,
  CV_ENTRIES,
  createRowSpec,
  type ConsumableEnvelope,
  type RowSeed,
} from '@matrixos/microsite-data';
import { CAREER_CALIBRATION } from './career-calibration';

const LEDGER_NAME = '保研直博 / 选调考公 / 大厂 Offer 对比树';

/** 本站基线锚点：台账被清空后投送仍要满足「至少 1 条锚点」的契约红线。 */
const STATION_ANCHOR = {
  source_doi_or_url: 'https://prejob.matrixos.cc.cd/',
  verification_level: 'Level_B_Preprint',
} as const;

type SdkAnchor = (typeof CV_ENTRIES)[number]['anchors'][number];
type ContractAnchor = NonNullable<RowSeed['anchor']>;

/* ───────────────────────── 生成表的结构视图 ───────────────────────── */

/**
 * 为什么要单独声明视图类型：`career-calibration.ts` 是 `as const` 的生成产物，
 * 字段是字面量类型；重新生成时若某条路径满意度变成 null，直接依赖字面量类型
 * 会让本文件编译失败。用视图类型把「可能为空」如实表达出来，生成脚本怎么改都稳。
 */
interface PathCalibrationView {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly caseIndustries: readonly string[];
  readonly caseCount: number;
  readonly caseShare: number;
  readonly specialityCount: number;
  readonly ratedCount: number;
  readonly satisfaction: number | null;
  readonly votes: number;
  readonly avgOfferCount: number | null;
  readonly avgScore: number | null;
  readonly realityIndex: number;
  readonly calibration: number;
  readonly modelGain: number;
  readonly expectedGain: number;
  readonly risk: string;
  readonly modelTrajectory: readonly number[];
  readonly trajectory: readonly number[];
  readonly modelProbabilities: {
    readonly success: number;
    readonly neutral: number;
    readonly fail: number;
  };
  readonly probabilities: {
    readonly success: number;
    readonly neutral: number;
    readonly fail: number;
  };
  readonly topSpeciality: {
    readonly specId: string;
    readonly code: string;
    readonly name: string;
    readonly faculty: string;
    readonly category: string;
    readonly evlCount: number;
    readonly evlScore: number | null;
    readonly satisfactionRank: number | null;
    readonly satisfactionCount: number | null;
    readonly url: string;
  } | null;
}

interface GlobalView {
  readonly specialityCount: number;
  readonly ratedCount: number;
  readonly satisfaction: number | null;
  readonly votes: number;
  readonly avgOfferCount: number | null;
  readonly realityIndex: number;
}

const PATHS: readonly PathCalibrationView[] = CAREER_CALIBRATION.paths;
const GLOBAL: GlobalView = CAREER_CALIBRATION.global;
const META = CAREER_CALIBRATION.meta;

/** 路径描述（`CAREER_PATHS` 里有，生成表里只存推演数字，避免两处重复）。 */
const PATH_DESCRIPTION = new Map<string, string>(CAREER_PATHS.map((path) => [path.id, path.description]));

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

function isBbox(value: unknown): value is readonly [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

/** 百分比展示：0.52 → 52%。 */
function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const RISK_LABEL: Readonly<Record<string, string>> = {
  low: '低',
  medium: '中',
  high: '高',
};

function riskLabel(risk: string): string {
  return RISK_LABEL[risk] ?? risk;
}

/* ───────────────────────── 锚点：SDK camelCase → 契约 snake_case ───────────────────────── */

/**
 * 契约里锚点层是 `additionalProperties: false`，只有
 * `source_doi_or_url` / `verification_level` / `pdf_page` / `bbox` 四个字段，
 * 共享数据每条锚点都带 `note`，直接展开就会让信封非法 —— 所以逐字段重建。
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

/** 收进来的锚点再洗一遍：只留契约字段，非法等级退化为 Level_B_Preprint。 */
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

/**
 * 学职平台专业详情页回链。
 *
 * 等价于 `xz-data.ts` 的 `xzSpecialityUrl()`，但这里**刻意内联**而不是 import：
 * 那个模块静态 import 了 1.35 MB JSON，为拼一个 URL 把整包数据拖进 chunk 不划算。
 * 回链是合规硬要求（docs/03-xz-integration/02-compliance.md 第 2 条）。
 */
function xzSpecialityAnchor(specId: string): ContractAnchor {
  return {
    source_doi_or_url: `https://xz.chsi.com.cn/speciality/detail.action?specId=${specId}`,
    verification_level: 'Level_B_Preprint',
  };
}

/* ───────────────────────── 演示数据：三条生涯路径 ───────────────────────── */

function pathSeed(path: PathCalibrationView): RowSeed {
  const top = path.topSpeciality;
  const description = PATH_DESCRIPTION.get(path.id) ?? path.name;
  const satisfaction = path.satisfaction === null ? '无评价' : `${path.satisfaction.toFixed(2)} 分`;
  const offer = path.avgOfferCount === null ? '未知' : `${path.avgOfferCount.toFixed(1)} 所`;
  const topPart =
    top === null
      ? '代表专业：暂无'
      : `代表专业：${top.name}（${top.faculty}/${top.category}，${top.evlCount} 条评价${
          top.satisfactionRank === null ? '' : `，就业满意度 ${top.satisfactionRank.toFixed(1)}`
        }）`;
  return {
    title: `${path.name} · 五年期望 ${path.expectedGain} 万`,
    meta: `成功 ${pct(path.probabilities.success)} · 中性 ${pct(path.probabilities.neutral)} · 失败 ${pct(
      path.probabilities.fail,
    )} · 风险 ${riskLabel(path.risk)} · 学职校准 ×${path.calibration.toFixed(2)}`,
    detail:
      `${description}。学职平台专业面：${path.specialityCount} 条本科专业（${path.ratedCount} 条有就业满意度评价，` +
      `票数加权 ${satisfaction} / ${path.votes} 票），平均开设院校 ${offer}；${topPart}。` +
      `校准后五年期望 ${path.expectedGain} 万（模型基准 ${path.modelGain} 万 × ${path.calibration.toFixed(3)}）；` +
      `万元量级仍为模型假设，学职平台不提供薪资字段。`,
    anchor: top === null ? { ...STATION_ANCHOR } : xzSpecialityAnchor(top.specId),
    pathId: path.id,
    kind: 'career-path',
    expectedGain: path.expectedGain,
    modelGain: path.modelGain,
    risk: riskLabel(path.risk),
    riskCode: path.risk,
    calibration: path.calibration,
    probabilities: { ...path.probabilities },
    modelProbabilities: { ...path.modelProbabilities },
    trajectory: [...path.trajectory],
    modelTrajectory: [...path.modelTrajectory],
    specialityCount: path.specialityCount,
    ratedCount: path.ratedCount,
    satisfaction: path.satisfaction,
    votes: path.votes,
    avgOfferCount: path.avgOfferCount,
    realityIndex: path.realityIndex,
    caseCount: path.caseCount,
    scopes: [...path.scopes],
    topSpeciality: top === null ? null : { ...top },
    source: META.source,
    statYear: META.statYear,
  } satisfies RowSeed;
}

const seed: readonly RowSeed[] = PATHS.map(pathSeed);

/* ───────────────────────── 接收：已验真能力画像 ───────────────────────── */

interface IncomingSummary {
  readonly title: string;
  readonly detail: string;
  readonly versionCount: number;
  readonly entryCount: number;
  readonly evidence: readonly Record<string, unknown>[];
}

/**
 * 按 payload_type 分流。
 *
 * 本站 manifest 只 accepts `verified_cv_evidence`（来自 evidence-cv），
 * 但接收侧不假设对端一定守约：未知类型走通用落库，绝不抛错
 * （回调必须是纯函数且不抛错 —— 一条脏信封不能把整个台账搞崩）。
 */
function describeIncoming(type: string, data: Record<string, unknown>): IncomingSummary {
  if (type === 'verified_cv_evidence') {
    const versions = listOf(data.versions ?? data.plans);
    const capabilities = listOf(data.capabilities ?? data.entries ?? data.items);
    const verification = asRecord(data.verification);
    const levelA = num(verification.levelA) ?? 0;
    const levelB = num(verification.levelB) ?? 0;
    const retracted = num(verification.retracted) ?? 0;
    const entryCount = num(data.entryCount) ?? capabilities.length;
    const evidence: Record<string, unknown>[] = [];
    for (const item of capabilities.slice(0, 3)) {
      const record = asRecord(item);
      if (Object.keys(record).length > 0) evidence.push(record);
    }
    return {
      title: `能力画像 · ${str(data.ledger, '已验真证据简历库')}`,
      detail:
        `含 ${versions.length} 个简历版本 / ${entryCount} 条能力证据；` +
        `Level-A ${levelA} · Level-B ${levelB}${retracted > 0 ? ` · 撤稿警示 ${retracted}` : ''}；` +
        '作为决策树推演的输入，不直接改写路径数字',
      versionCount: versions.length,
      entryCount,
      evidence,
    };
  }

  const keys = Object.keys(data).slice(0, 3);
  return {
    title: `外部推演输入 · ${type}`,
    detail:
      keys.length > 0
        ? `未登记的 payload_type「${type}」，已按通用字段落库（${keys.join('、')}）`
        : `未登记的 payload_type「${type}」，已按通用规则落库`,
    versionCount: 0,
    entryCount: 0,
    evidence: [],
  };
}

function rowOfEnvelope(envelope: ConsumableEnvelope, nowIso: string): RowSeed {
  const data = asRecord(envelope.payload?.data);
  const anchors: ContractAnchor[] = [];
  for (const raw of listOf(envelope.payload?.evidence_anchors)) {
    const anchor = sanitizeAnchor(raw);
    if (anchor) anchors.push(anchor);
  }
  const type = str(envelope.payload_type, 'verified_cv_evidence');
  const source = str(envelope.source_app, 'unknown');
  const traceId = str(envelope.trace_id, 'unknown');
  const summary = describeIncoming(type, data);
  const levels = countLevels(anchors);
  return {
    title: summary.title,
    meta: `来自 ${source} · ${type} · 证据锚点 ${anchors.length} 条`,
    detail: `${summary.detail}；接收于 ${nowIso.slice(0, 19).replace('T', ' ')}，trace ${traceId.slice(0, 8)}`,
    anchor: anchors[0] ?? { ...STATION_ANCHOR },
    pathId: '',
    kind: 'capability-input',
    evidenceType: type,
    sourceApp: source,
    traceId,
    receivedAt: nowIso,
    anchorCount: anchors.length,
    levelA: levels.levelA,
    levelB: levels.levelB,
    retracted: levels.retracted,
    versionCount: summary.versionCount,
    entryCount: summary.entryCount,
    evidence: summary.evidence,
  } satisfies RowSeed;
}

/* ───────────────────────── 规格 ───────────────────────── */

const baseSpec = createRowSpec({
  exportName: 'career-paths',

  seed,

  emit: {
    targetApp: 'evidence-cv',
    payloadType: 'verified_cv_evidence',
  },

  accept: {
    payloadType: 'verified_cv_evidence',
    description:
      '接收证据简历工坊投来的已验真能力画像，落成一条「推演输入」记录，挂在决策树顶部供对照；路径数字不会被自动改写。',
  },

  draft: (rows) => {
    const index = String(rows.length + 1).padStart(2, '0');
    return {
      title: `新建生涯路径 ${index} · 待填推演参数`,
      meta: '五年期望待定 · 概率待评估 · 风险待定',
      detail:
        '点「编辑」写路径名与假设；推演参数请对照学职平台专业面数据填写，不要把模型假设写成观测值。',
      pathId: `custom-${index}`,
      kind: 'career-path',
      expectedGain: null,
      modelGain: null,
      risk: '待评估',
      riskCode: 'unknown',
      calibration: null,
      probabilities: { success: null, neutral: null, fail: null },
      trajectory: [],
      specialityCount: 0,
      source: '手工新增',
    } satisfies RowSeed;
  },

  payloadOf: (rows, nowIso) => {
    const paths: Record<string, unknown>[] = [];
    const inputs: Record<string, unknown>[] = [];
    let low = 0;
    let medium = 0;
    let high = 0;
    let gainMin: number | null = null;
    let gainMax: number | null = null;
    let best: Record<string, unknown> | null = null;

    for (const row of rows) {
      if (str(row.pathId) === '') {
        inputs.push({
          id: String(row.id),
          title: String(row.title),
          meta: String(row.meta),
          evidenceType: str(row.evidenceType, 'verified_cv_evidence'),
          sourceApp: str(row.sourceApp, 'unknown'),
          anchorCount: num(row.anchorCount) ?? 0,
          entryCount: num(row.entryCount) ?? 0,
        });
        continue;
      }

      const gain = num(row.expectedGain);
      const probabilities = asRecord(row.probabilities);
      const risk = str(row.riskCode, 'unknown');
      if (risk === 'low') low += 1;
      else if (risk === 'medium') medium += 1;
      else if (risk === 'high') high += 1;
      if (gain !== null) {
        gainMin = gainMin === null ? gain : Math.min(gainMin, gain);
        gainMax = gainMax === null ? gain : Math.max(gainMax, gain);
      }

      const entry = {
        id: String(row.id),
        pathId: str(row.pathId),
        name: String(row.title),
        expectedGain: gain,
        risk: str(row.risk, '待评估'),
        calibration: num(row.calibration),
        probabilities: {
          success: num(probabilities.success),
          neutral: num(probabilities.neutral),
          fail: num(probabilities.fail),
        },
        trajectory: listOf(row.trajectory).map((value) => num(value) ?? 0),
        specialityCount: num(row.specialityCount) ?? 0,
        satisfaction: num(row.satisfaction),
        topSpeciality: row.topSpeciality ?? null,
        detail: String(row.detail),
      };
      paths.push(entry);

      if (best === null || (gain !== null && gain > (num(best.expectedGain) ?? -1))) best = entry;
    }

    return {
      site: 'prejob',
      ledger: LEDGER_NAME,
      target: 'evidence-cv',
      generatedAt: nowIso,
      pathCount: paths.length,
      capabilityInputCount: inputs.length,
      expectedGainRange:
        gainMin === null || gainMax === null ? null : { min: gainMin, max: gainMax },
      riskProfile: { low, medium, high },
      recommended: best,
      calibration: {
        source: META.source,
        homeUrl: META.homeUrl,
        statYear: META.statYear,
        collectedAt: META.collectedAt,
        specialityTotal: META.specialityTotal,
        undergradTotal: META.undergradTotal,
        caseTotal: META.caseTotal,
        globalSatisfaction: GLOBAL.satisfaction,
        globalRealityIndex: GLOBAL.realityIndex,
        notice: META.notice,
      },
      paths,
      /* evidence-cv 的接收侧会读 data.capabilities 作为「能力证据」条数，这里按路径给出。 */
      capabilities: paths.map((path) => {
        const gain = num(path.expectedGain);
        const probability = asRecord(path.probabilities);
        const success = num(probability.success);
        return {
          name: `生涯路径可行性 · ${str(path.name)}`,
          evidence:
            `${gain === null ? '期望收益待定' : `五年期望 ${gain} 万`}` +
            `${success === null ? '' : ` · 成功概率 ${pct(success)}`}` +
            ` · 风险 ${str(path.risk, '待评估')}`,
          source: META.source,
        };
      }),
      inputs,
    };
  },

  rowOfEnvelope,

  csvOf: (rows) => ({
    header: [
      '路径编号',
      '路径名',
      '五年期望（万）',
      '成功概率',
      '中性概率',
      '失败概率',
      '风险',
      '学职校准系数',
      '专业面样本数',
      '最后修改',
    ],
    rows: rows.map((row) => {
      const probabilities = asRecord(row.probabilities);
      const success = num(probabilities.success);
      const neutral = num(probabilities.neutral);
      const fail = num(probabilities.fail);
      return [
        str(row.pathId, '—'),
        String(row.title),
        String(num(row.expectedGain) ?? ''),
        success === null ? '' : pct(success),
        neutral === null ? '' : pct(neutral),
        fail === null ? '' : pct(fail),
        str(row.risk, '待评估'),
        String(num(row.calibration) ?? ''),
        String(num(row.specialityCount) ?? ''),
        String(row.updatedAt ?? ''),
      ];
    }),
  }),
});

/* ───────────────────────── 本地演示信封 ───────────────────────── */

/**
 * 为什么挂在 `createRowSpec` 之外：`RowSpecConfig` 没有 `demoEnvelope` 这一项
 * （它属于 `SiteWorkbenchSpec.accept`，工厂不透传）。直接写进 config 会报 TS2353。
 *
 * 演示信封模拟 evidence-cv 投来的已验真能力画像：锚点用 `CV_ENTRIES` 的真实 DOI /
 * 仓库地址，并按契约转成 snake_case（丢弃 SDK 侧的 `note`）。
 */
function buildDemoEnvelope(nowIso: string): ConsumableEnvelope {
  const entries = CV_ENTRIES.map((entry) => ({
    entryId: entry.id,
    title: entry.title,
    role: entry.role,
    period: entry.period,
    anchors: entry.anchors.map((anchor) => toContractAnchor(anchor)),
  }));
  const anchors: ContractAnchor[] = [];
  for (const entry of entries) {
    for (const anchor of entry.anchors) anchors.push(anchor);
  }
  const levels = countLevels(anchors);
  const stamp = nowIso.replace(/[^0-9]/g, '').slice(0, 14);
  return {
    trace_id: `demo-cv-${stamp}`,
    source_app: 'evidence-cv',
    payload_type: 'verified_cv_evidence',
    payload: {
      data: {
        site: 'evidence-cv',
        ledger: '多版本保研/求职证据级简历库',
        versionCount: 3,
        entryCount: entries.length,
        anchorCount: anchors.length,
        verification: {
          levelA: levels.levelA,
          levelB: levels.levelB,
          retracted: levels.retracted,
        },
        versions: [
          {
            id: 'demo-version-01',
            title: '保研版 v1 · 学术证据优先',
            purpose: '推免 / 直博申请',
            entryCount: entries.length,
            entries,
          },
        ],
        capabilities: entries.map((entry) => ({
          name: entry.title,
          role: entry.role,
          period: entry.period,
          anchorCount: entry.anchors.length,
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
