/**
 * 08 · 太空任务式进组跟进台账 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：已发信→已读→待面试→已进组状态机
 * 投送：verified_cv_evidence → evidence-cv（17 区块链级学术证据简历工坊）
 * 接收：mentor_match_card ← cold-email（07 证据内嵌式套磁信推演器）
 *
 * 为什么这么写：
 *   一条记录 = **一位导师的跟进流水**：当前处在状态机的哪一级、走过的时间线、
 *   下一合法跃迁、下一步动作。阶段定义来自 `KANBAN_COLUMNS`（5 列 =
 *   已建档 / 已发信 / 已读待复 / 待面试 / 已进组），卡片内容来自 `KANBAN_TASKS`，
 *   导师画像来自 `MENTORS`，代表作锚点来自 `PAPER_ROWS`。四段数据同源，
 *   改一处不会出现「看板卡片写已进组、台账还停在已发信」。
 *
 * 状态机语义（写进每条 detail，不是形容词）：
 *   已发信 → 已读待复 → 待面试 → 已进组 **只能逐级推进**，跳级会被 TaskKanban 的
 *   `onTaskMove` 拒绝（返回 false）。所以每条记录都写死「当前阶段 → 下一合法跃迁」，
 *   台账与仪器面板共用同一套阶段序，答辩时点开任意一条都能自证。
 *
 * 投送语义：
 *   只有「已进组」（终态）的流水才是能写进简历的科研经历，所以
 *   `payload.joinedEvidence` 只装终态条目；完整流水线放在 `payload.pipeline`
 *   里供下游追溯，`payload.stageCounts` 给出各阶段在办量。
 *
 * 锚点注意（踩过的坑）：共享数据里的锚点是 SDK 的 camelCase 形状
 * （`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel`，还多带一个
 * `note`），而虫洞信封契约的锚点层是 `additionalProperties: false` 的
 * snake_case。所以这里逐字段转换并**丢掉 note** —— 多一个字段整个信封就过不了
 * `specs/contracts/wormhole-envelope.schema.json`。
 */

import {
  KANBAN_COLUMNS,
  KANBAN_TASKS,
  MENTORS,
  PAPER_ROWS,
  createRowSpec,
  type MentorCandidate,
  type PaperRow,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

type KanbanColumnRow = (typeof KANBAN_COLUMNS)[number];
type KanbanTaskRow = (typeof KANBAN_TASKS)[number];

/* ───────────────────────── 展示格式（确定性） ─────────────────────────
 * 不用 toLocaleString：Node 与浏览器的 ICU 版本可能不同，服务端预渲染与
 * 客户端首帧文本一旦不一致就是 React #418 水合报错。手写格式化最稳。
 */
function fmtOne(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/* ───────────────────────── 状态机（本站的核心业务规则） ───────────────────────── */

/** 阶段 id 序列：queued → sent → read → interview → joined。 */
const STAGE_IDS: readonly string[] = KANBAN_COLUMNS.map((column) => column.id);

/** 终态 id 由数据推出（最后一列），不写死字符串。 */
const TERMINAL_ID: string = KANBAN_COLUMNS[KANBAN_COLUMNS.length - 1]?.id ?? 'joined';

/** 「STAGE 03 · 已读待复」→「已读待复」。阶段短名是 detail 与 CSV 里唯一使用的名字。 */
function shortStage(column: KanbanColumnRow): string {
  return column.title.replace(/^STAGE\s*\d+\s*·\s*/, '').trim();
}

function stageIndexOf(columnId: string): number {
  const index = STAGE_IDS.indexOf(columnId);
  return index < 0 ? 0 : index;
}

function columnAt(index: number): KanbanColumnRow | undefined {
  return KANBAN_COLUMNS[index];
}

/** 时间线：已走过的打 ✓、当前打 ◉、未到打 ○。 */
function timelineOf(currentIndex: number): string {
  return KANBAN_COLUMNS.map((column, index) => {
    const mark = index < currentIndex ? '✓' : index === currentIndex ? '◉' : '○';
    return `${shortStage(column)} ${mark}`;
  }).join(' → ');
}

/** 下一合法跃迁：只能 index + 1；终态返回空串（不可再迁出）。 */
function nextStageOf(currentIndex: number): string {
  const next = columnAt(currentIndex + 1);
  return next ? shortStage(next) : '';
}

/**
 * 每个阶段的「下一步动作」。写的是可执行的判断，不是「继续跟进」这类套话：
 * 每一条都对应一个可验收的动作（发信 / 补信 / 交计划 / 归档）。
 */
const NEXT_ACTION: Readonly<Record<string, string>> = {
  queued: '复核五维画像与代表作，起草首封套磁信；本阶段只能跃迁到「已发信」，不能直接进「已读待复」',
  sent: '发信后第 3 天检查已读回执；未读就换主题行重发一次，仍无回音则归档为低温线索',
  read: '48 小时内补一封跟进信：附一篇同方向复现笔记，把「感兴趣」换成「我复现了 Fig. 2b」',
  interview: '面试前 24h 交一页纸研究计划；面试当天回信致谢，并把进组材料清单写死在邮件里',
  joined: '归档进组材料（接收函 / 工位门禁 / 首周任务），并把本阶段成果投送 verified_cv_evidence 给证据简历工坊',
};

/* ───────────────────────── 锚点转换 ───────────────────────── */

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

/**
 * 没有代表作 DOI 的流水（星门未覆盖的导师、新建草稿）用站内流水页兜底。
 * `Level_B_Preprint` 在这里的语义是「未被双验」，绝不冒充 Level A。
 */
function labAnchor(slug: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://lab-kanban.matrixos.cc.cd/pipeline/${slug}`,
    verification_level: 'Level_B_Preprint',
  };
}

/* ───────────────────────── 导师 / 代表作映射 ───────────────────────── */

/** 卡片标题形如「李教授 · 量子光学」，用姓名子串匹配星门的五维画像。 */
function mentorOf(title: string): MentorCandidate | undefined {
  return MENTORS.find((mentor) => title.includes(mentor.name));
}

/** 导师代表作：按导师在 MENTORS 里的序号取 PAPER_ROWS，保证「同一个导师永远同一篇」。 */
function paperOfMentor(mentor: MentorCandidate | undefined): PaperRow | undefined {
  if (!mentor || PAPER_ROWS.length === 0) return undefined;
  const index = MENTORS.findIndex((item) => item.id === mentor.id);
  if (index < 0) return undefined;
  return PAPER_ROWS[index % PAPER_ROWS.length];
}

/* ───────────────────────── 全站统计（不手抄） ───────────────────────── */

const TOTAL = KANBAN_TASKS.length;
const JOINED_COUNT = KANBAN_TASKS.filter((task) => task.columnId === TERMINAL_ID).length;
/** 进组转化率（%）：看板上有几条走到了终态。 */
const JOINED_RATE = TOTAL === 0 ? 0 : Math.round((JOINED_COUNT / TOTAL) * 100);

/* ───────────────────────── 卡片 → 台账记录 ───────────────────────── */

const LEDGER_NAME = '已发信→已读→待面试→已进组状态机';

/**
 * 造一条跟进流水。阶段 / 匹配度 / 代表作 / WIP 占用全部从共享数据推出来，
 * 手写的只有「下一步动作」这类业务判断。
 */
function pipelineSeed(task: KanbanTaskRow, position: number): RowSeed {
  const stageIndex = stageIndexOf(task.columnId);
  const stage = columnAt(stageIndex);
  const stageName = stage ? shortStage(stage) : task.columnId;
  const nextName = nextStageOf(stageIndex);
  const mentor = mentorOf(task.title);
  const paper = paperOfMentor(mentor);
  const direction = task.title.split('·')[1]?.trim() ?? '方向待定';
  const tags = Array.isArray(task.tags) ? task.tags.map((tag) => String(tag)) : [];
  const due = task.due ?? '';
  const wipLimit = stage?.wipLimit ?? 0;
  const wipUsed = KANBAN_TASKS.filter((item) => item.columnId === task.columnId).length;
  const terminal = task.columnId === TERMINAL_ID;
  const anchor = paper ? anchorOf(paper) : labAnchor(task.id);

  const title = `M-${String(position + 1).padStart(2, '0')} · ${task.title}`;

  const meta = [
    stageName,
    task.priority ?? 'P2',
    tags.length > 0 ? tags.join('/') : '无标签',
    mentor ? `匹配 ${fmtOne(mentor.matchScore)}%` : '匹配待算',
    wipLimit > 0 ? `WIP ${wipUsed}/${wipLimit}` : `第 ${stageIndex + 1}/${KANBAN_COLUMNS.length} 阶段`,
  ].join(' · ');

  const detail = [
    `状态机 ${timelineOf(stageIndex)}（只能逐级推进，跳级会被拒绝）`,
    nextName === ''
      ? `当前 ${stageName} 是终态：不可再跃迁，成果已可投送 verified_cv_evidence`
      : `当前 ${stageName} → 下一合法跃迁 ${nextName}`,
    `阶段画像：${task.summary ?? '暂无摘要'}${due === '' ? '' : ` · 截止 ${due}`}`,
    mentor
      ? `匹配依据：${mentor.name}（${mentor.affiliation}）五维匹配 ${fmtOne(mentor.matchScore)}%`
      : '匹配依据：星门未覆盖这位导师，方向契合度靠套磁信正文与代表作补足',
    paper
      ? `证据锚点：${paper.venue} DOI ${paper.anchor.sourceDoiOrUrl}（P.${paper.anchor.pdfPage ?? '—'} ${paper.anchor.note ?? ''}）`
      : `证据锚点：站内流水页 ${anchor.source_doi_or_url}（${anchor.verification_level}，未绑定 DOI）`,
    `下一步动作：${NEXT_ACTION[task.columnId] ?? '按阶段序推进'}`,
  ].join('；');

  return {
    title,
    meta,
    detail,
    anchor,
    taskId: task.id,
    mentorName: mentor?.name ?? task.title.split('·')[0]?.trim() ?? task.title,
    mentorAffiliation: mentor?.affiliation ?? '',
    direction,
    stage: task.columnId,
    stageIndex,
    stageTitle: stageName,
    stageSubtitle: stage?.subtitle ?? '',
    priority: task.priority ?? 'P2',
    tags,
    due,
    nextStage: nextName,
    nextAction: NEXT_ACTION[task.columnId] ?? '按阶段序推进',
    timeline: timelineOf(stageIndex),
    passedStages: stageIndex,
    remainingStages: Math.max(KANBAN_COLUMNS.length - 1 - stageIndex, 0),
    wipUsed,
    wipLimit,
    terminal,
    matchScore: mentor ? mentor.matchScore : 0,
    verificationLevel: anchor.verification_level,
    evidenceSource: anchor.source_doi_or_url,
    deliverable: terminal
      ? '进组材料归档 + 首周任务清单（可投送 verified_cv_evidence）'
      : '尚未进组，暂不可投送',
    missionCode: 'XINGMEN-2026',
  } satisfies RowSeed;
}

const seed: readonly RowSeed[] = KANBAN_TASKS.map((task, index) => pipelineSeed(task, index));

/* ───────────────────────── 业务规格 ───────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'lab-pipeline',
  seed,
  emit: {
    targetApp: 'evidence-cv',
    payloadType: 'verified_cv_evidence',
  },
  accept: {
    payloadType: 'mentor_match_card',
    description:
      '接收套磁信推演器（cold-email）投来的导师匹配卡，自动开一条「已发信」状态：导师画像、五维匹配度与引用 DOI 一并落成跟进流水，之后只能逐级推进到已读待复 → 待面试 → 已进组。',
  },
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    const stageIndex = 0;
    return {
      title: `M-${next} · 待建档导师`,
      meta: [
        shortStage(columnAt(0) ?? KANBAN_COLUMNS[0]!),
        'P2',
        '待办',
        '匹配待算',
        `第 1/${KANBAN_COLUMNS.length} 阶段`,
      ].join(' · '),
      detail: [
        `状态机 ${timelineOf(stageIndex)}（只能逐级推进，跳级会被拒绝）`,
        `当前 已建档 → 下一合法跃迁 ${nextStageOf(stageIndex) || '已发信'}`,
        '阶段画像：尚未填写导师与方向，点「编辑」补上；仪器看板的列由本台账的 stage 字段驱动',
        '证据锚点：站内流水页（Level_B_Preprint，未绑定 DOI；绑定代表作后会升级为 Level_A_Verified）',
        `下一步动作：${NEXT_ACTION.queued ?? '复核画像后起草首封套磁信'}`,
      ].join('；'),
      anchor: labAnchor(`pending-${next}`),
      taskId: `draft-${next}`,
      mentorName: '待建档导师',
      mentorAffiliation: '',
      direction: '方向待定',
      stage: STAGE_IDS[0] ?? 'queued',
      stageIndex,
      stageTitle: shortStage(columnAt(0) ?? KANBAN_COLUMNS[0]!),
      stageSubtitle: columnAt(0)?.subtitle ?? '',
      priority: 'P2',
      tags: ['待办'],
      due: '',
      nextStage: nextStageOf(stageIndex) || '已发信',
      nextAction: NEXT_ACTION.queued ?? '复核画像后起草首封套磁信',
      timeline: timelineOf(stageIndex),
      passedStages: 0,
      remainingStages: KANBAN_COLUMNS.length - 1,
      wipUsed: 0,
      wipLimit: 0,
      terminal: false,
      matchScore: 0,
      verificationLevel: 'Level_B_Preprint',
      evidenceSource: `https://lab-kanban.matrixos.cc.cd/pipeline/pending-${next}`,
      deliverable: '尚未进组，暂不可投送',
      missionCode: 'XINGMEN-2026',
    } satisfies RowSeed;
  },
  rowOfEnvelope: (envelope) => {
    const data = (envelope.payload?.data ?? {}) as Record<string, unknown>;
    const anchors = Array.isArray(envelope.payload?.evidence_anchors)
      ? envelope.payload.evidence_anchors
      : [];
    const firstAnchor = anchors[0];
    const recipient = (data.recipient ?? {}) as Record<string, unknown>;
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    const firstProfile = (profiles[0] ?? {}) as Record<string, unknown>;

    const sourceApp = String(envelope.source_app ?? 'cold-email');
    const name = String(recipient.name ?? firstProfile.name ?? data.mentorName ?? '外部匹配卡');
    const affiliation = String(recipient.affiliation ?? firstProfile.affiliation ?? '');
    const matchScore = Number(recipient.matchScore ?? firstProfile.matchScore ?? 0);
    const rawDois = Array.isArray(data.doiBundle)
      ? data.doiBundle
      : Array.isArray(data.dois)
        ? data.dois
        : [];
    const dois = rawDois.map((doi) => String(doi)).filter((doi) => doi !== '');

    // 契约备注（microsite-contracts 08 站 acceptNote）：收到匹配卡即自动开「已发信」。
    const stageIndex = stageIndexOf('sent');
    const anchor = firstAnchor ?? labAnchor(`inbox-${envelope.trace_id.slice(0, 8)}`);

    return {
      title: `收卡 · ${name} · 待发信`,
      meta: [
        shortStage(columnAt(stageIndex) ?? KANBAN_COLUMNS[stageIndex]!),
        `来自 ${sourceApp}`,
        Number.isFinite(matchScore) && matchScore > 0 ? `匹配 ${fmtOne(matchScore)}%` : '匹配待算',
        `锚点 ${anchors.length} 条`,
      ].join(' · '),
      detail: [
        `接收 ${String(envelope.payload_type ?? 'mentor_match_card')} · 来源 ${sourceApp} · trace ${envelope.trace_id.slice(0, 8)}`,
        `状态机 ${timelineOf(stageIndex)}（自动开「已发信」，之后只能逐级推进）`,
        `当前 已发信 → 下一合法跃迁 ${nextStageOf(stageIndex) || '已读待复'}`,
        `导师画像：${name}${affiliation === '' ? '' : `（${affiliation}）`}${matchScore > 0 ? `，五维匹配 ${fmtOne(matchScore)}%` : ''}`,
        dois.length > 0
          ? `引用 DOI：${dois.slice(0, 3).join('、')}`
          : '匹配卡未携带 DOI，锚点用站内流水页兜底',
        `下一步动作：${NEXT_ACTION.sent ?? '发信后第 3 天检查已读回执'}`,
      ].join('；'),
      anchor,
      taskId: `ext-${envelope.trace_id.slice(0, 8)}`,
      mentorName: name,
      mentorAffiliation: affiliation,
      direction: '方向待补',
      stage: 'sent',
      stageIndex,
      stageTitle: shortStage(columnAt(stageIndex) ?? KANBAN_COLUMNS[stageIndex]!),
      stageSubtitle: columnAt(stageIndex)?.subtitle ?? '',
      priority: 'P1',
      tags: ['接收'],
      due: '',
      nextStage: nextStageOf(stageIndex) || '已读待复',
      nextAction: NEXT_ACTION.sent ?? '发信后第 3 天检查已读回执',
      timeline: timelineOf(stageIndex),
      passedStages: stageIndex,
      remainingStages: Math.max(KANBAN_COLUMNS.length - 1 - stageIndex, 0),
      wipUsed: 0,
      wipLimit: 0,
      terminal: false,
      matchScore: Number.isFinite(matchScore) ? matchScore : 0,
      verificationLevel: anchor.verification_level,
      evidenceSource: anchor.source_doi_or_url,
      deliverable: '尚未进组，暂不可投送',
      missionCode: 'XINGMEN-2026',
      receivedFrom: sourceApp,
      traceId: envelope.trace_id,
      dois,
    } satisfies RowSeed;
  },
  payloadOf: (rows) => {
    const total = rows.length;
    const stageCounts = KANBAN_COLUMNS.map((column) => ({
      stage: column.id,
      title: shortStage(column),
      subtitle: column.subtitle ?? '',
      count: rows.filter((row) => String(row.stage ?? '') === column.id).length,
      wipLimit: column.wipLimit ?? 0,
    }));
    const joined = rows.filter((row) => String(row.stage ?? '') === TERMINAL_ID);

    return {
      site: 'lab-kanban',
      ledger: LEDGER_NAME,
      target: 'evidence-cv',
      missionCode: 'XINGMEN-2026',
      // 状态机随包带上：下游能判断这条证据是不是真的走到了终态，而不是听一句「已进组」。
      stageModel: KANBAN_COLUMNS.map((column) => ({
        id: column.id,
        title: shortStage(column),
        subtitle: column.subtitle ?? '',
        wipLimit: column.wipLimit ?? 0,
        locked: column.locked === true,
      })),
      pipelineCount: total,
      joinedCount: joined.length,
      joinedRate: total === 0 ? 0 : Math.round((joined.length / total) * 100),
      stageCounts,
      // 只有终态流水才是可写进简历的科研经历 —— 这是本站投送的核心语义。
      joinedEvidence: joined.map((row) => ({
        id: String(row.id),
        taskId: String(row.taskId ?? ''),
        mentor: String(row.mentorName ?? ''),
        affiliation: String(row.mentorAffiliation ?? ''),
        direction: String(row.direction ?? ''),
        evidenceSource: String(row.evidenceSource ?? ''),
        verificationLevel: String(row.verificationLevel ?? ''),
        deliverable: String(row.deliverable ?? ''),
        detail: String(row.detail),
      })),
      pipeline: rows.map((row) => ({
        id: String(row.id),
        taskId: String(row.taskId ?? ''),
        mentor: String(row.mentorName ?? ''),
        affiliation: String(row.mentorAffiliation ?? ''),
        direction: String(row.direction ?? ''),
        stage: String(row.stage ?? ''),
        stageIndex: Number(row.stageIndex ?? 0),
        nextStage: String(row.nextStage ?? ''),
        nextAction: String(row.nextAction ?? ''),
        priority: String(row.priority ?? ''),
        matchScore: Number(row.matchScore ?? 0),
        verificationLevel: String(row.verificationLevel ?? ''),
        evidenceSource: String(row.evidenceSource ?? ''),
      })),
    };
  },
  csvOf: (rows) => ({
    header: [
      '任务代号',
      '导师',
      '方向',
      '当前阶段',
      '阶段序号',
      '优先级',
      '标签',
      '五维匹配',
      '下一合法跃迁',
      '下一步动作',
      '证据等级',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.taskId ?? ''),
      String(row.mentorName ?? ''),
      String(row.direction ?? ''),
      String(row.stageTitle ?? ''),
      Number(row.stageIndex ?? 0) + 1,
      String(row.priority ?? ''),
      Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)).join('/') : '',
      Number(row.matchScore ?? 0) > 0 ? `${fmtOne(Number(row.matchScore ?? 0))}%` : '待算',
      String(row.nextStage ?? '') || '终态',
      String(row.nextAction ?? ''),
      String(row.verificationLevel ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),
});

/** 全站口径值：README 与答辩口径都从这里引用，避免两处写不一样的数字。 */
export const LAB_PIPELINE_STATS = {
  ledger: LEDGER_NAME,
  stages: KANBAN_COLUMNS.length,
  tasks: TOTAL,
  joined: JOINED_COUNT,
  joinedRate: JOINED_RATE,
  terminalStage: TERMINAL_ID,
} as const;
