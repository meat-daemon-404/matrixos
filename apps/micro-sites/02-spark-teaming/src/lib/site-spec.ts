/**
 * 02 · 双创互补组队雷达 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：大创/挑战杯组队契约与分工表
 * 投送：verified_cv_evidence → evidence-cv（证据简历工坊）
 * 接收：verified_cv_evidence（来自证据简历工坊的已验真技能证据）
 *
 * 一条记录 = 一份组队契约：和谁组、互补度多少、谁补哪一维、怎么分工、契约条款是什么。
 * 「互补度」不手抄，全部由共享的 TEAMMATES 与 SELF_SKILLS 现算：
 *   五维增益 = Σ max(0, 队友该维分 − 我方该维分)
 *   短板覆盖 = 我方 < 60 分的维度里，被队友补上的个数
 * 这样上方「技能极坐标互补盘」与下方台账永远是同一份数字，答辩时不会出现
 * 「盘上显示 92.4%、台账写 92.5%」这类对不上的事故。
 *
 * 为什么把「技能重叠」也算成一条正经记录：互补度是名义分，五维增益才是实际收益。
 * 只报互补度会让「两个实验型选手组队」看起来很美，实际一个维度都补不上。
 */

import {
  SKILL_LABELS,
  SELF_SKILLS,
  TEAMMATES,
  createRowSpec,
  type RowSeed,
  type TeammateCandidate,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

/* ───────────────────────────── 共享数据的派生量 ───────────────────────────── */

const DOMAIN = 'spark.matrixos.cc.cd';

/** 五维技能。顺序即 UI 上的展示顺序（硬件 / 算法 / 商业 / 实验 / 写作）。 */
const SKILL_KEYS = ['hardware', 'algorithm', 'business', 'experiment', 'writing'] as const;
type SkillKey = (typeof SKILL_KEYS)[number];

/** 我方短板线：低于 60 分视为「必须靠队友补」的维度。 */
const WEAK_LINE = 60;
const WEAK_KEYS = SKILL_KEYS.filter((key) => SELF_SKILLS[key] < WEAK_LINE);

function gainOf(teammate: TeammateCandidate, key: SkillKey): number {
  return Math.max(0, teammate.skills[key] - SELF_SKILLS[key]);
}

function gainTotalOf(teammate: TeammateCandidate): number {
  return SKILL_KEYS.reduce((sum, key) => sum + gainOf(teammate, key), 0);
}

/** 我方短板的覆盖数：队友在哪几个 <60 的维度上确实强于我方。 */
function coveredOf(teammate: TeammateCandidate): number {
  return WEAK_KEYS.filter((key) => gainOf(teammate, key) > 0).length;
}

/** 主攻位 = 增益最大的那一维（平手时按 SKILL_KEYS 顺序取先出现的）。 */
function focusOf(teammate: TeammateCandidate): SkillKey {
  let best: SkillKey = SKILL_KEYS[0];
  for (const key of SKILL_KEYS) {
    if (gainOf(teammate, key) > gainOf(teammate, best)) best = key;
  }
  return best;
}

function gainTextOf(teammate: TeammateCandidate): string {
  return SKILL_KEYS.map((key) => `${SKILL_LABELS[key]} +${gainOf(teammate, key)}`).join(' / ');
}

/** 风险判定：名义互补度之外，再用五维增益总量给一句人话结论。 */
function riskOf(teammate: TeammateCandidate): string {
  const total = gainTotalOf(teammate);
  if (total >= 40) return '互补充分';
  if (total >= 10) return '部分互补';
  return '技能重叠';
}

/* ───────────────────────────── 契约模板（业务文案） ───────────────────────────── */

interface ContractPlan {
  readonly role: string;
  readonly duty: string;
  readonly clauses: readonly string[];
}

const FALLBACK_PLAN: ContractPlan = {
  role: '待定主攻位',
  duty: '面谈后写入分工（谁负责硬件、谁负责算法、谁负责商业与写作）',
  clauses: ['分工确认书需双方签字', '退出机制：任一方可在中期检查前书面退出'],
};

/**
 * 每个队友的分工与条款。这里只写**业务文案**，不写任何数字 ——
 * 互补度、增益、短板覆盖全部由上面的函数现算，避免两处数字漂移。
 */
const CONTRACT_PLANS: Readonly<Record<string, ContractPlan>> = {
  tm1: {
    role: '算法主攻位',
    duty: '算法实现与数据处理全流程（模型选型、训练脚本、消融实验）',
    clauses: [
      '代码进同一仓库、按周提交，算法部分由陈同学一人署名负责',
      '署名顺序：算法贡献第一作者，我方负责硬件与实验',
      '竞赛报名费与差旅按 5:5 分摊',
    ],
  },
  tm2: {
    role: '商业与写作位',
    duty: '商业计划书、财务测算与答辩 PPT 撰写（含挑战杯商业组赛道适配）',
    clauses: [
      '商业计划书由林同学主笔，我方提供技术章节素材',
      '校级初赛前完成 3 轮互审，每轮 48 小时内回稿',
      '获奖奖金按贡献度 4:6 分配（技术 40% / 商业 60%）',
    ],
  },
  tm3: {
    role: '实验执行位（备选顺位）',
    duty: '材料制备与实验执行，作为我方实验能力的冗余备份',
    clauses: [
      '技能高度重叠：除实验维度外几乎无增益，需先明确主次避免重复劳动',
      '定位为第三顺位备选：我方保留实验主导权，赵同学负责重复性样品制备',
      '若前两位队友档期冲突，再启用本合同',
    ],
  },
};

function planOf(teammateId: string): ContractPlan {
  return CONTRACT_PLANS[teammateId] ?? FALLBACK_PLAN;
}

/* ───────────────────────────── 证据锚点与文本工具 ───────────────────────────── */

/**
 * 组队契约在站内的存档页。契约是本站自存档文件、未经第三方双验，
 * 所以用 Level_B_Preprint（不是 Level_A_Verified）。
 */
function contractAnchor(teammateId: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://${DOMAIN}/contracts/${teammateId}`,
    verification_level: 'Level_B_Preprint',
  };
}

const LEVELS = ['Level_A_Verified', 'Level_B_Preprint', 'Retracted_Warning'] as const;
type VerificationLevel = (typeof LEVELS)[number];

function isLevel(value: unknown): value is VerificationLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/**
 * 外部信封里的锚点 → 契约形状。
 *
 * 为什么要白名单重投影：虫洞信封的锚点层是 `additionalProperties: false`，
 * 只要多带一个字段（历史数据里有过 `note`），整个信封就过不了校验。
 * 这里只保留契约允许的四个字段，非法值一律丢弃或降级，保证本站发出的信封永远合法。
 */
function anchorFrom(raw: unknown): WormholeEvidenceAnchor | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const url = record.source_doi_or_url;
  if (typeof url !== 'string' || url === '') return undefined;

  const page = record.pdf_page;
  const pdfPage =
    typeof page === 'number' && Number.isFinite(page) ? Math.trunc(page) : undefined;

  let bbox: readonly [number, number, number, number] | undefined;
  const rawBox = record.bbox;
  if (Array.isArray(rawBox) && rawBox.length === 4) {
    const [x0, y0, x1, y1] = rawBox as readonly unknown[];
    if (
      typeof x0 === 'number' &&
      typeof y0 === 'number' &&
      typeof x1 === 'number' &&
      typeof y1 === 'number'
    ) {
      bbox = [x0, y0, x1, y1];
    }
  }

  return {
    source_doi_or_url: url,
    verification_level: isLevel(record.verification_level)
      ? record.verification_level
      : 'Level_B_Preprint',
    ...(pdfPage !== undefined ? { pdf_page: pdfPage } : {}),
    ...(bbox !== undefined ? { bbox } : {}),
  };
}

function textOf(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringListOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/* ───────────────────────────── 一条组队契约 ───────────────────────────── */

function contractRow(teammate: TeammateCandidate, status: '契约生效' | '待谈判'): RowSeed {
  const plan = planOf(teammate.id);
  const focus = focusOf(teammate);
  const gainTotal = gainTotalOf(teammate);
  const covered = coveredOf(teammate);
  const risk = riskOf(teammate);
  const focusGain = gainOf(teammate, focus);

  const verdict =
    risk === '技能重叠'
      ? `与我方技能高度重叠，最强一维${SKILL_LABELS[focus]}也只 +${focusGain}，建议只作备选顺位`
      : `最强一维${SKILL_LABELS[focus]} +${focusGain}，正好补上我方短板`;

  return {
    title: `${teammate.name} · ${plan.role}`,
    meta: `互补度 ${teammate.complementScore.toFixed(1)}% · 五维增益 +${gainTotal} · 短板覆盖 ${covered}/${WEAK_KEYS.length} · ${risk}`,
    detail: `分工：${plan.duty}。互补判定：${verdict}（五维增益 ${gainTextOf(teammate)}）。契约条款：${plan.clauses.join('；')}。当前状态：${status}。`,
    anchor: contractAnchor(teammate.id),
    teammateId: teammate.id,
    teammateName: teammate.name,
    major: teammate.major,
    complementScore: teammate.complementScore,
    gainTotal,
    coveredWeak: covered,
    weakTotal: WEAK_KEYS.length,
    focus: SKILL_LABELS[focus],
    risk,
    duty: plan.duty,
    clauses: [...plan.clauses],
    status,
  };
}

/** 演示数据：每个候选队友一条契约，全部由共享画像算出来（不手抄任何数字）。 */
const seed: readonly RowSeed[] = TEAMMATES.map((teammate) => contractRow(teammate, '契约生效'));

/* ───────────────────────────── 业务规格 ───────────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'spark-teamups',
  seed,
  emit: {
    targetApp: 'evidence-cv',
    payloadType: 'verified_cv_evidence',
  },
  accept: {
    payloadType: 'verified_cv_evidence',
    description:
      '接收证据简历工坊回传的已验真技能证据，落成本站一条「技能验真回执」，用来给互补度打分补上第三方证据。',
  },

  draft: (rows) => {
    const used = new Set(rows.map((row) => String(row.teammateId ?? '')));
    const fresh = TEAMMATES.find((teammate) => !used.has(teammate.id));
    const fallbackIndex = rows.length % Math.max(TEAMMATES.length, 1);
    const teammate = fresh ?? TEAMMATES[fallbackIndex];
    if (!teammate) {
      return {
        title: '待补全组队契约',
        meta: '暂无可用队友画像',
        detail: '先在共享演示数据里补充 TEAMMATES，再新增契约。',
        clauses: [],
      };
    }
    return contractRow(teammate, '待谈判');
  },

  payloadOf: (rows) => ({
    site: 'spark',
    ledger: '大创/挑战杯组队契约与分工表',
    selfSkills: { ...SELF_SKILLS },
    skillLabels: { ...SKILL_LABELS },
    weakDimensions: WEAK_KEYS.map((key) => SKILL_LABELS[key]),
    contractCount: rows.length,
    contracts: rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      teammateId: String(row.teammateId ?? ''),
      teammateName: String(row.teammateName ?? ''),
      major: String(row.major ?? ''),
      complementScore: numberOr(row.complementScore, 0),
      gainTotal: numberOr(row.gainTotal, 0),
      coveredWeak: numberOr(row.coveredWeak, 0),
      focus: String(row.focus ?? '待评估'),
      risk: String(row.risk ?? '待评估'),
      status: String(row.status ?? '待谈判'),
      duty: String(row.duty ?? ''),
      clauses: stringListOf(row.clauses),
      detail: String(row.detail),
    })),
  }),

  csvOf: (rows) => ({
    header: [
      '队友',
      '学院',
      '主攻位',
      '互补度',
      '五维增益',
      '短板覆盖',
      '风险判定',
      '分工',
      '契约条款',
      '状态',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.teammateName ?? ''),
      String(row.major ?? ''),
      String(row.focus ?? ''),
      numberOr(row.complementScore, 0),
      numberOr(row.gainTotal, 0),
      numberOr(row.coveredWeak, 0),
      String(row.risk ?? ''),
      String(row.duty ?? ''),
      stringListOf(row.clauses).join('；'),
      String(row.status ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),

  rowOfEnvelope: (envelope, nowIso) => {
    const data = envelope.payload?.data ?? {};
    const anchors = envelope.payload?.evidence_anchors ?? [];
    const anchor = anchorFrom(anchors[0]);
    const name = textOf(data.teammateName ?? data.name ?? data.title ?? data.label, '外部队友');
    const source = textOf(envelope.source_app, 'evidence-cv');

    return {
      title: `技能验真回执 · ${name}`,
      meta: `来自 ${source} · 锚点 ${anchors.length} 条 · 待并入互补度打分`,
      detail: `证据简历工坊回传的已验真技能证据：${textOf(
        data.summary ?? data.detail ?? data.description,
        '（未附文字摘要，仅凭锚点校验）',
      )}。并入后可在互补度盘上重新对齐该队友的五维分，再据此修订分工与条款。`,
      ...(anchor ? { anchor } : {}),
      teammateId: textOf(data.teammateId, ''),
      teammateName: name,
      complementScore: numberOr(data.complementScore, 0),
      gainTotal: 0,
      coveredWeak: 0,
      focus: '待复核',
      risk: '待复核',
      duty: '待按验真证据重新分工',
      clauses: [],
      status: '待谈判',
      receivedAt: nowIso,
      traceId: textOf(envelope.trace_id, 'unknown'),
    };
  },
});
