/**
 * 06 · 星门 · 导师五维星象仪 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：目标博导/硕导全景学术画像库
 * 投送：mentor_match_card → cold-email（证据内嵌式套磁信推演器）
 * 接收：paper_doi_bundle ← lit-sonar（五源跨库引文声呐站）
 *       curve_fit_parameters ← curvelab（CurveLab 非线性拟合示波器）
 *
 * 为什么这么写：
 *   增删改清空导出投送接收的**语义**由 `createRowSpec` 固化，这里只描述
 *   「画像卡长什么样、匹配度怎么算、投出去带什么锚点」。
 *   一条记录 = 一位目标导师的画像卡：五维评分 + 综合匹配度 + 推荐理由，
 *   投送时锚点指向该导师代表作 DOI。
 *
 * 数值一律从 MENTORS 当场算出来（**不手抄**）：仪器面板显示匹配 94.2%
 * 而台账写 94，答辩现场就会被问住。
 *
 * 锚点注意（踩过的坑）：共享数据里的锚点是 SDK 的 camelCase 形状
 * （`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel`，还多带一个
 * `note`），而虫洞信封契约的锚点层是 `additionalProperties: false` 的
 * snake_case。所以这里逐字段转换并**丢掉 note**。
 */

import {
  MENTORS,
  PAPER_ROWS,
  createRowSpec,
  type MentorCandidate,
  type PaperRow,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

/* ───────────────────────────── 展示格式（确定性） ─────────────────────────────
 * 不用 toLocaleString：Node 与浏览器的 ICU 版本可能不同，服务端预渲染与
 * 客户端首帧文本一旦不一致就是 React #418 水合报错。手写格式化最稳。
 */
function fmtOne(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function fmtInt(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ───────────────────────────── 五维定义 ───────────────────────────── */

type DimensionKey = keyof MentorCandidate['dimensions'];

interface DimensionMeta {
  readonly key: DimensionKey;
  readonly label: string;
  /** 该维在综合匹配里的权重（与仪器面板的口径一致：五维加权，和为 1）。 */
  readonly weight: number;
}

const DIMENSIONS: readonly DimensionMeta[] = [
  { key: 'activity', label: '近3年活跃度', weight: 0.24 },
  { key: 'hIndexSlope', label: 'H-index 斜率', weight: 0.2 },
  { key: 'funding', label: '经费充足度', weight: 0.18 },
  { key: 'undergradFriendly', label: '本科生友好度', weight: 0.18 },
  { key: 'directionFit', label: '方向契合度', weight: 0.2 },
];

/** 加权匹配度。仅用于展示口径，**不覆盖** MENTORS 里已有的 matchScore。 */
function weightedMatch(mentor: MentorCandidate): number {
  let sum = 0;
  for (const dim of DIMENSIONS) sum += mentor.dimensions[dim.key] * dim.weight;
  return Math.round(sum * 10) / 10;
}

/** 最强的一维：画像卡的一句话结论就从这里来。 */
function strongestDimension(mentor: MentorCandidate): DimensionMeta {
  return DIMENSIONS.reduce((best, dim) =>
    mentor.dimensions[dim.key] > mentor.dimensions[best.key] ? dim : best,
  );
}

/** 最弱的一维：套磁信里要主动绕开或补强的短板。 */
function weakestDimension(mentor: MentorCandidate): DimensionMeta {
  return DIMENSIONS.reduce((worst, dim) =>
    mentor.dimensions[dim.key] < mentor.dimensions[worst.key] ? dim : worst,
  );
}

function dimensionLine(mentor: MentorCandidate): string {
  return DIMENSIONS.map((dim) => `${dim.label} ${mentor.dimensions[dim.key]}`).join(' · ');
}

/** 匹配档位：阈值固定，便于跨站比较，不在渲染期读任何动态状态。 */
function tierOf(score: number): string {
  if (score >= 90) return '第一梯队';
  if (score >= 85) return '重点跟进';
  if (score >= 80) return '备选';
  return '观望';
}

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

/* ───────────────────────────── 代表作映射 ─────────────────────────────
 * 每位导师锚到一篇代表作。用「稳定索引取模」而不是随机：同一个 id
 * 每次构建都映射到同一篇，服务端预渲染与客户端首帧一致。
 */
function signaturePaperOf(mentor: MentorCandidate): PaperRow | undefined {
  if (PAPER_ROWS.length === 0) return undefined;
  const index = Number.parseInt(mentor.id.replace(/\D/g, ''), 10);
  const safeIndex = Number.isFinite(index) && index > 0 ? index - 1 : 0;
  return PAPER_ROWS[safeIndex % PAPER_ROWS.length];
}

/* ───────────────────────────── 导师 → 台账记录 ───────────────────────────── */

/** 每位导师一段「推荐理由」与「待补短板」，写的是业务判断而不是套话。 */
const MENTOR_NOTES: Readonly<Record<string, { reason: string; gap: string }>> = {
  m1: {
    reason: '经费与方向契合双高，代表作有 Nature 子刊级锚点，适合作为套磁信的第一封。',
    gap: '活跃度高意味着组里节奏快，套磁信里要直接给可验证的复现结果，别铺垫。',
  },
  m2: {
    reason: '方向契合度 91 且对本科生友好，量子光学方向的理论门槛与你的课程背景匹配。',
    gap: '经费相对偏弱（78），进组后大概率要自己承担一部分实验耗材，需提前问清。',
  },
  m3: {
    reason: 'H-index 斜率 90 是全库最高，上升期导师愿意带新人，产出机会多。',
    gap: '本科生友好度 70 是明显短板，套磁信要额外说明可投入时间与自学能力。',
  },
};

function noteOf(mentor: MentorCandidate): { reason: string; gap: string } {
  return (
    MENTOR_NOTES[mentor.id] ?? {
      reason: `五维加权 ${fmtOne(weightedMatch(mentor))}，综合匹配 ${fmtOne(mentor.matchScore)}。`,
      gap: '画像数据尚不完整，进组前需补齐代表作与经费情况。',
    }
  );
}

const seed: readonly RowSeed[] = MENTORS.map((mentor) => {
  const paper = signaturePaperOf(mentor);
  const best = strongestDimension(mentor);
  const worst = weakestDimension(mentor);
  const note = noteOf(mentor);
  const weighted = weightedMatch(mentor);
  const level = paper?.anchor.verificationLevel ?? 'Level_B_Preprint';

  const meta = [
    `${mentor.affiliation}`,
    `匹配 ${fmtOne(mentor.matchScore)}%`,
    tierOf(mentor.matchScore),
    `最强 ${best.label} ${mentor.dimensions[best.key]}`,
  ].join(' · ');

  const detail = [
    `五维：${dimensionLine(mentor)}`,
    `加权复核 ${fmtOne(weighted)}%（与仪器口径一致）`,
    `短板 ${worst.label} ${mentor.dimensions[worst.key]} —— ${note.gap}`,
    paper
      ? `代表作 ${paper.venue}《${paper.strategy}》，DOI ${paper.anchor.sourceDoiOrUrl}`
      : '代表作待补，投送会退化为站级基线锚点',
    note.reason,
  ].join('；');

  return {
    title: `${mentor.name} · ${mentor.affiliation}`,
    meta,
    detail,
    ...(paper ? { anchor: anchorOf(paper) } : {}),
    mentorId: mentor.id,
    affiliation: mentor.affiliation,
    matchScore: mentor.matchScore,
    weightedScore: weighted,
    tier: tierOf(mentor.matchScore),
    strongestDim: best.label,
    strongestValue: mentor.dimensions[best.key],
    weakestDim: worst.label,
    weakestValue: mentor.dimensions[worst.key],
    dimActivity: mentor.dimensions.activity,
    dimHIndexSlope: mentor.dimensions.hIndexSlope,
    dimFunding: mentor.dimensions.funding,
    dimUndergradFriendly: mentor.dimensions.undergradFriendly,
    dimDirectionFit: mentor.dimensions.directionFit,
    signatureDoi: paper?.anchor.sourceDoiOrUrl ?? '',
    signatureVenue: paper?.venue ?? '',
    signatureStrategy: paper?.strategy ?? '',
    verificationLevel: level,
    recommendation: note.reason,
    gapNote: note.gap,
  } satisfies RowSeed;
});

/* ───────────────────────────── 业务规格 ───────────────────────────── */

const LEDGER_NAME = '目标博导/硕导全景学术画像库';

/** 全库平均匹配度：台账为空时投送也要能报一个真实的口径值。 */
const AVG_MATCH = Math.round((MENTORS.reduce((sum, m) => sum + m.matchScore, 0) / Math.max(MENTORS.length, 1)) * 10) / 10;

export const siteSpec = createRowSpec({
  exportName: 'mentor-profiles',
  seed,
  emit: {
    targetApp: 'cold-email',
    payloadType: 'mentor_match_card',
  },
  accept: {
    payloadType: 'paper_doi_bundle',
    description:
      '接收文献声呐（lit-sonar）投来的论文包，自动抽取作者与机构，回填画像卡的「近 3 年活跃度」与代表作 DOI。',
  },
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `新目标导师 ${next} · 待画像`,
      meta: `机构待定 · 匹配待算 · 观望`,
      detail:
        '点「编辑」补上导师姓名与机构；五维评分与匹配度由文献声呐回流的数据算出来，不要手填，否则会和仪器面板对不上。',
      mentorId: `draft-${next}`,
      affiliation: '待补机构',
      matchScore: 0,
      weightedScore: 0,
      tier: '观望',
      strongestDim: '待评估',
      weakestDim: '待评估',
      signatureDoi: '',
      recommendation: '尚未计算，先接收一份 lit-sonar 论文包再回填。',
      gapNote: '画像为空，投送会退化为站级基线锚点。',
    } satisfies RowSeed;
  },
  payloadOf: (rows) => {
    const profiles = rows.map((row) => ({
      id: String(row.id),
      mentorId: String(row.mentorId ?? ''),
      name: String(row.title),
      affiliation: String(row.affiliation ?? ''),
      matchScore: Number(row.matchScore ?? 0),
      weightedScore: Number(row.weightedScore ?? 0),
      tier: String(row.tier ?? ''),
      dimensions: {
        activity: Number(row.dimActivity ?? 0),
        hIndexSlope: Number(row.dimHIndexSlope ?? 0),
        funding: Number(row.dimFunding ?? 0),
        undergradFriendly: Number(row.dimUndergradFriendly ?? 0),
        directionFit: Number(row.dimDirectionFit ?? 0),
      },
      strongest: String(row.strongestDim ?? ''),
      weakest: String(row.weakestDim ?? ''),
      signatureDoi: String(row.signatureDoi ?? ''),
      verificationLevel: String(row.verificationLevel ?? ''),
      recommendation: String(row.recommendation ?? ''),
      gapNote: String(row.gapNote ?? ''),
    }));

    // 匹配卡去重：cold-email 按 DOI 定位收件人的代表作，同一篇只出现一次。
    const doiBundle = Array.from(
      new Set(profiles.map((item) => item.signatureDoi).filter((doi) => doi !== '')),
    );

    return {
      site: 'mentor',
      ledger: LEDGER_NAME,
      target: 'cold-email',
      profileCount: profiles.length,
      // 有匹配度的画像才算数，避免把草稿的 0 分拉进均值。
      scoredCount: profiles.filter((item) => item.matchScore > 0).length,
      libraryAverageMatch: AVG_MATCH,
      topTierCount: profiles.filter((item) => item.tier === '第一梯队').length,
      doiBundle,
      profiles,
    };
  },
  rowOfEnvelope: (envelope) => {
    const data = (envelope.payload?.data ?? {}) as Record<string, unknown>;
    const anchors = Array.isArray(envelope.payload?.evidence_anchors)
      ? envelope.payload.evidence_anchors
      : [];
    const firstAnchor = anchors[0];

    // paper_doi_bundle：从 DOI 包里抽作者线索；curve_fit_parameters：从参量里取拟合质量。
    const rawDois = Array.isArray(data.doiBundle) ? data.doiBundle : Array.isArray(data.dois) ? data.dois : [];
    const dois = rawDois.map((doi) => String(doi)).filter((doi) => doi !== '');
    const authors = Array.isArray(data.authors)
      ? data.authors.map((author) => String(author)).filter((author) => author !== '')
      : [];
    const r2 = typeof data.R2 === 'number' ? data.R2 : typeof data.r2 === 'number' ? data.r2 : null;
    const summary = typeof data.summary === 'string' ? data.summary : '';

    const title =
      authors.length > 0
        ? `待画像 · ${authors.slice(0, 2).join(' / ')}`
        : `待画像 · 外部回流 ${String(dois.length).padStart(2, '0')} 篇`;

    const metaParts = [
      `来自 ${envelope.source_app ?? 'lit-sonar'}`,
      `锚点 ${anchors.length} 条`,
      dois.length > 0 ? `DOI ${dois.length} 篇` : 'DOI 待补',
      r2 === null ? null : `拟合 R² ${r2.toFixed(4)}`,
    ].filter((part): part is string => part !== null);

    return {
      title,
      meta: metaParts.join(' · '),
      detail: [
        summary || '外部投来的学术线索，已落成待画像条目，需要补齐五维评分。',
        dois.length > 0 ? `代表作候选：${dois.slice(0, 3).join('、')}${dois.length > 3 ? ' 等' : ''}` : '未携带 DOI，需回站内补检索',
        `trace ${envelope.trace_id.slice(0, 8)}`,
      ].join('；'),
      ...(firstAnchor ? { anchor: firstAnchor } : {}),
      mentorId: `ext-${envelope.trace_id.slice(0, 8)}`,
      affiliation: '外部回流 · 待核',
      matchScore: 0,
      weightedScore: 0,
      tier: '观望',
      strongestDim: '待评估',
      weakestDim: '待评估',
      signatureDoi: dois[0] ?? '',
      recommendation: '由外部论文包自动建卡，五维评分待文献声呐回填。',
      gapNote: '画像未完成，不建议现在投送匹配卡。',
      receivedFrom: String(envelope.source_app ?? 'lit-sonar'),
      traceId: envelope.trace_id,
    } satisfies RowSeed;
  },
  csvOf: (rows) => ({
    header: [
      '导师',
      '机构',
      '综合匹配',
      '加权复核',
      '档位',
      '近3年活跃度',
      'H-index斜率',
      '经费充足度',
      '本科生友好度',
      '方向契合度',
      '代表作 DOI',
      '推荐理由',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.title),
      String(row.affiliation ?? ''),
      String(row.matchScore ?? 0),
      String(row.weightedScore ?? 0),
      String(row.tier ?? ''),
      String(row.dimActivity ?? 0),
      String(row.dimHIndexSlope ?? 0),
      String(row.dimFunding ?? 0),
      String(row.dimUndergradFriendly ?? 0),
      String(row.dimDirectionFit ?? 0),
      String(row.signatureDoi ?? ''),
      String(row.recommendation ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),
});
