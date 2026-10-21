/**
 * 07 · 证据内嵌式套磁信推演器 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：多版本套磁信草稿与导师审阅评分
 * 投送：mentor_match_card → lab-kanban（太空任务式进组跟进台账）
 * 接收：mentor_match_card ← mentor（星门 · 导师五维星象仪）
 *       curve_fit_parameters ← curvelab（CurveLab 非线性拟合示波器）
 *
 * 为什么这么写：
 *   增删改清空导出投送接收的**语义**由 `createRowSpec` 固化，这里只描述
 *   「一个草稿版本长什么样、红队怎么打分、投出去带什么匹配卡」。
 *   一条记录 = 一个套磁信版本 + 红队评分 + 待修问题清单，
 *   投送时锚点指向该版本引用的那篇导师代表作 DOI。
 *
 * 数值一律从 EMAIL_DRAFTS 当场算出来（**不手抄**）：仪器面板显示红队 91
 * 而台账写 90，答辩现场就会被问住。红队评分、问题条数、证据密度全部
 * 由共享数据推导。
 *
 * 锚点注意（踩过的坑）：共享数据里的锚点是 SDK 的 camelCase 形状
 * （`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel`，还多带一个
 * `note`），而虫洞信封契约的锚点层是 `additionalProperties: false` 的
 * snake_case。所以这里逐字段转换并**丢掉 note**。
 */

import {
  EMAIL_DRAFTS,
  EMAIL_TIPS,
  MENTORS,
  PAPER_ROWS,
  createRowSpec,
  type EmailDraft,
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

/* ───────────────────────────── 收件人（导师）映射 ─────────────────────────────
 * 套磁信的第一收件人是匹配度最高的那位导师 —— 这正是星门投过来的匹配卡
 * 要解决的问题。用 reduce 取最高分，不 sort（不改动共享常量）。
 */
const PRIMARY_MENTOR: MentorCandidate = MENTORS.reduce((best, mentor) =>
  mentor.matchScore > best.matchScore ? mentor : best,
);

/** 收件人代表作：优先取论文包里与该导师同序的那篇，保证锚点有真实出处。 */
function paperForMentor(mentor: MentorCandidate): PaperRow | undefined {
  if (PAPER_ROWS.length === 0) return undefined;
  const index = Number.parseInt(mentor.id.replace(/\D/g, ''), 10);
  const safeIndex = Number.isFinite(index) && index > 0 ? index - 1 : 0;
  return PAPER_ROWS[safeIndex % PAPER_ROWS.length];
}

const PRIMARY_PAPER = paperForMentor(PRIMARY_MENTOR);

/* ───────────────────────────── 红队评分口径 ─────────────────────────────
 * 红队分数不只看「问题条数」，还看证据密度：正文里出现 DOI、数值、图表
 * 引用、附件说明，都是「可验证」的信号。这里把信号量化出来，让台账里
 * 的「证据密度」不是一个拍脑袋的形容词。
 */
interface EvidenceSignals {
  readonly hasDoi: boolean;
  readonly hasNumeric: boolean;
  readonly hasFigureRef: boolean;
  readonly hasAttachment: boolean;
  readonly hasTimeCommitment: boolean;
  readonly bodyLength: number;
  readonly density: number;
}

function evidenceOf(draft: EmailDraft): EvidenceSignals {
  const body = draft.body;
  const hasDoi = /10\.\d{4,9}\//.test(body);
  const hasNumeric = /\d+\.\d+|\d+\s*%/.test(body);
  const hasFigureRef = /Fig\.|Table|图\s*\d|表\s*\d/.test(body);
  const hasAttachment = /附[件：:]|附件|GitHub|记录本/.test(body);
  const hasTimeCommitment = /每周|小时|投入/.test(body);
  const checks = [hasDoi, hasNumeric, hasFigureRef, hasAttachment, hasTimeCommitment];
  const density = checks.filter(Boolean).length / checks.length;
  return {
    hasDoi,
    hasNumeric,
    hasFigureRef,
    hasAttachment,
    hasTimeCommitment,
    bodyLength: body.length,
    density: Math.round(density * 100),
  };
}

/** 红队结论：问题数为 0 且证据密度 ≥ 60% 才算「可发送」。 */
function verdictOf(draft: EmailDraft, evidence: EvidenceSignals): string {
  if (draft.redTeamIssues.length === 0 && evidence.density >= 60) return '可发送';
  if (draft.redTeamIssues.length <= 1 && evidence.density >= 40) return '改一版再发';
  return '不建议发送';
}

/** 证据清单：命中哪几条，写成人能读的一行。 */
function evidenceLine(evidence: EvidenceSignals): string {
  const hit: string[] = [];
  if (evidence.hasDoi) hit.push('DOI');
  if (evidence.hasNumeric) hit.push('数值');
  if (evidence.hasFigureRef) hit.push('图表引用');
  if (evidence.hasAttachment) hit.push('附件');
  if (evidence.hasTimeCommitment) hit.push('投入承诺');
  return hit.length > 0 ? hit.join(' / ') : '无硬证据';
}

/* ───────────────────────────── 草稿 → 台账记录 ───────────────────────────── */

/**
 * 每个版本对应的「这一版为什么这么写」—— 写的是迭代判断，不是套话。
 * 用版本 id 查表，查不到时退回由红队分数生成的诚实描述。
 */
const DRAFT_NOTES: Readonly<Record<string, string>> = {
  d1: '平铺直叙版：只表达了「感兴趣」，没有任何可验证的东西，红队一眼就能看出是群发模板。',
  d2: '证据嵌入版：把复现的 R²、时间常数、对照实验结果全部写进正文，并把附件列清楚，红队无意见。',
};

function noteOf(draft: EmailDraft, evidence: EvidenceSignals): string {
  if (DRAFT_NOTES[draft.id]) return DRAFT_NOTES[draft.id]!;
  if (draft.redTeamIssues.length === 0) {
    return `红队无意见，证据命中 ${evidenceLine(evidence)}，正文 ${evidence.bodyLength} 字符。`;
  }
  return `红队提出 ${draft.redTeamIssues.length} 条意见，证据命中 ${evidenceLine(evidence)}。`;
}

const seed: readonly RowSeed[] = EMAIL_DRAFTS.map((draft) => {
  const evidence = evidenceOf(draft);
  const verdict = verdictOf(draft, evidence);
  const paper = PRIMARY_PAPER;
  const level = paper?.anchor.verificationLevel ?? 'Level_B_Preprint';
  const issueCount = draft.redTeamIssues.length;

  const meta = [
    `红队 ${draft.redTeamScore}`,
    verdict,
    issueCount > 0 ? `${issueCount} 条待修` : '无待修问题',
    `证据密度 ${evidence.density}%`,
  ].join(' · ');

  const detail = [
    `主题：${draft.subject}`,
    `收件人：${PRIMARY_MENTOR.name}（${PRIMARY_MENTOR.affiliation}，匹配 ${fmtOne(PRIMARY_MENTOR.matchScore)}%）`,
    issueCount > 0
      ? `待修问题：${draft.redTeamIssues.join('；')}`
      : `红队结论：${verdict}，五条写作要点全部命中`,
    `证据命中 ${evidenceLine(evidence)}，正文 ${evidence.bodyLength} 字符`,
    paper ? `引用锚点 ${paper.venue} DOI ${paper.anchor.sourceDoiOrUrl}` : '未绑定引用锚点，投送会退化为站级基线锚点',
    noteOf(draft, evidence),
  ].join('；');

  return {
    title: draft.version,
    meta,
    detail,
    ...(paper ? { anchor: anchorOf(paper) } : {}),
    draftId: draft.id,
    subject: draft.subject,
    // 正文原样保留（含换行）：JSON 序列化会自动转义，不要在写盘时拍平。
    body: draft.body,
    redTeamScore: draft.redTeamScore,
    redTeamIssueCount: issueCount,
    redTeamIssues: [...draft.redTeamIssues],
    verdict,
    evidenceDensity: evidence.density,
    evidenceHits: evidenceLine(evidence),
    bodyLength: evidence.bodyLength,
    recipientName: PRIMARY_MENTOR.name,
    recipientAffiliation: PRIMARY_MENTOR.affiliation,
    recipientMatchScore: PRIMARY_MENTOR.matchScore,
    citedDoi: paper?.anchor.sourceDoiOrUrl ?? '',
    citedVenue: paper?.venue ?? '',
    verificationLevel: level,
    tipCount: EMAIL_TIPS.length,
  } satisfies RowSeed;
});

/* ───────────────────────────── 业务规格 ───────────────────────────── */

const LEDGER_NAME = '多版本套磁信草稿与导师审阅评分';

/** 全库平均红队分：台账为空时投送也要能报一个真实的口径值。 */
const AVG_RED_TEAM = Math.round((EMAIL_DRAFTS.reduce((sum, d) => sum + d.redTeamScore, 0) / Math.max(EMAIL_DRAFTS.length, 1)) * 10) / 10;

/** 最好的一版：投送匹配卡时优先把它的结论带给跟进台账。 */
const BEST_DRAFT = EMAIL_DRAFTS.reduce((best, draft) =>
  draft.redTeamScore > best.redTeamScore ? draft : best,
);

export const siteSpec = createRowSpec({
  exportName: 'cold-email-drafts',
  seed,
  emit: {
    targetApp: 'lab-kanban',
    payloadType: 'mentor_match_card',
  },
  accept: {
    payloadType: 'mentor_match_card',
    description:
      '接收导师星象仪（mentor）投来的匹配卡，作为套磁信草稿的收件人依据：五维评分、匹配度、代表作 DOI 一并落成一条待写版本。',
  },
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `草案 ${next} · 待撰写`,
      meta: `红队待评 · 证据密度 0% · 待补引用`,
      detail: `点「编辑」补上主题与正文；写作时对照五条要点（${EMAIL_TIPS.join('；')}），红队会按证据密度重新打分。`,
      draftId: `draft-${next}`,
      subject: '（待填）关于进组学习的请求',
      body: '',
      redTeamScore: 0,
      redTeamIssueCount: 0,
      redTeamIssues: [],
      verdict: '待评',
      evidenceDensity: 0,
      evidenceHits: '无硬证据',
      bodyLength: 0,
      recipientName: PRIMARY_MENTOR.name,
      recipientAffiliation: PRIMARY_MENTOR.affiliation,
      recipientMatchScore: PRIMARY_MENTOR.matchScore,
      citedDoi: PRIMARY_PAPER?.anchor.sourceDoiOrUrl ?? '',
      citedVenue: PRIMARY_PAPER?.venue ?? '',
      verificationLevel: PRIMARY_PAPER?.anchor.verificationLevel ?? 'Level_B_Preprint',
      tipCount: EMAIL_TIPS.length,
    } satisfies RowSeed;
  },
  payloadOf: (rows) => {
    const drafts = rows.map((row) => ({
      id: String(row.id),
      draftId: String(row.draftId ?? ''),
      version: String(row.title),
      subject: String(row.subject ?? ''),
      redTeamScore: Number(row.redTeamScore ?? 0),
      verdict: String(row.verdict ?? ''),
      issueCount: Number(row.redTeamIssueCount ?? 0),
      issues: Array.isArray(row.redTeamIssues) ? row.redTeamIssues.map((issue) => String(issue)) : [],
      evidenceDensity: Number(row.evidenceDensity ?? 0),
      citedDoi: String(row.citedDoi ?? ''),
      verificationLevel: String(row.verificationLevel ?? ''),
    }));

    // 匹配卡去重：进组跟进台账按 DOI 认人，同一篇代表作只出现一次。
    const doiBundle = Array.from(
      new Set(drafts.map((item) => item.citedDoi).filter((doi) => doi !== '')),
    );

    return {
      site: 'cold-email',
      ledger: LEDGER_NAME,
      target: 'lab-kanban',
      draftCount: drafts.length,
      // 可发送的版本数：跟进台账据此判断要不要直接发信。
      sendableCount: drafts.filter((item) => item.verdict === '可发送').length,
      averageRedTeamScore: AVG_RED_TEAM,
      bestRedTeamScore: BEST_DRAFT.redTeamScore,
      bestVersion: BEST_DRAFT.version,
      recipient: {
        name: PRIMARY_MENTOR.name,
        affiliation: PRIMARY_MENTOR.affiliation,
        matchScore: PRIMARY_MENTOR.matchScore,
        dimensions: PRIMARY_MENTOR.dimensions,
      },
      tipCount: EMAIL_TIPS.length,
      doiBundle,
      drafts,
    };
  },
  rowOfEnvelope: (envelope) => {
    const data = (envelope.payload?.data ?? {}) as Record<string, unknown>;
    const anchors = Array.isArray(envelope.payload?.evidence_anchors)
      ? envelope.payload.evidence_anchors
      : [];
    const firstAnchor = anchors[0];

    // mentor_match_card：收件人画像随卡带来；curve_fit_parameters：拟合质量用来写证据段。
    const recipient = (data.recipient ?? {}) as Record<string, unknown>;
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    const firstProfile = (profiles[0] ?? {}) as Record<string, unknown>;
    const name = String(
      recipient.name ?? firstProfile.name ?? (typeof data.mentorName === 'string' ? data.mentorName : '') ?? '',
    );
    const affiliation = String(recipient.affiliation ?? firstProfile.affiliation ?? '');
    const matchScore = Number(recipient.matchScore ?? firstProfile.matchScore ?? 0);
    const rawDois = Array.isArray(data.doiBundle) ? data.doiBundle : Array.isArray(data.dois) ? data.dois : [];
    const dois = rawDois.map((doi) => String(doi)).filter((doi) => doi !== '');
    const r2 = typeof data.R2 === 'number' ? data.R2 : typeof data.r2 === 'number' ? data.r2 : null;

    const title = name !== '' ? `草案 · 致 ${name}` : '草案 · 外部匹配卡';

    const metaParts = [
      `来自 ${envelope.source_app ?? 'mentor'}`,
      `锚点 ${anchors.length} 条`,
      Number.isFinite(matchScore) && matchScore > 0 ? `匹配 ${fmtOne(matchScore)}%` : '匹配待算',
      r2 === null ? null : `拟合 R² ${r2.toFixed(4)}`,
    ].filter((part): part is string => part !== null);

    return {
      title,
      meta: metaParts.join(' · '),
      detail: [
        affiliation !== ''
          ? `收件人 ${name}（${affiliation}）由导师星象仪投来的匹配卡确定。`
          : '匹配卡未携带完整画像，收件人待核。',
        dois.length > 0 ? `引用锚点候选：${dois.slice(0, 3).join('、')}` : '未携带 DOI，需回站内补引用',
        r2 === null ? '' : `拟合 R² ${r2.toFixed(4)} 可直接写进证据段。`,
        `trace ${envelope.trace_id.slice(0, 8)}`,
      ]
        .filter((part) => part !== '')
        .join('；'),
      ...(firstAnchor ? { anchor: firstAnchor } : {}),
      draftId: `ext-${envelope.trace_id.slice(0, 8)}`,
      subject: '（待填）关于进组学习的请求',
      body: '',
      redTeamScore: 0,
      redTeamIssueCount: 0,
      redTeamIssues: [],
      verdict: '待评',
      evidenceDensity: 0,
      evidenceHits: '无硬证据',
      bodyLength: 0,
      recipientName: name,
      recipientAffiliation: affiliation,
      recipientMatchScore: Number.isFinite(matchScore) ? matchScore : 0,
      citedDoi: dois[0] ?? '',
      verificationLevel: firstAnchor?.verification_level ?? 'Level_B_Preprint',
      tipCount: EMAIL_TIPS.length,
      receivedFrom: String(envelope.source_app ?? 'mentor'),
      traceId: envelope.trace_id,
    } satisfies RowSeed;
  },
  csvOf: (rows) => ({
    header: [
      '版本',
      '主题',
      '收件人',
      '红队评分',
      '结论',
      '待修问题数',
      '证据密度',
      '证据命中',
      '引用 DOI',
      '正文长度',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.title),
      String(row.subject ?? ''),
      String(row.recipientName ?? ''),
      String(row.redTeamScore ?? 0),
      String(row.verdict ?? ''),
      String(row.redTeamIssueCount ?? 0),
      `${String(row.evidenceDensity ?? 0)}%`,
      String(row.evidenceHits ?? ''),
      String(row.citedDoi ?? ''),
      String(row.bodyLength ?? 0),
      String(row.updatedAt ?? ''),
    ]),
  }),
});
