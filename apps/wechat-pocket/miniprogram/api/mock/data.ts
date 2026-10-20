/**
 * 口袋端 mock 数据集。
 *
 * ⚠️ **数据来源声明**：本文件的所有数值均取自蓝图图纸 05 与需求文档
 * `docs/00-analysis/02-requirements.md` §5.1 的实装文案，不是编造的随机数：
 *   - 热度 98.4 / Nature Photonics / EQE 28.4%
 *   - 热度 94.1 / arXiv:2610.0492
 *   - 张教授 · 光电国重 · 周五 15:00 · 光电楼 B402 · 48 小时倒计时
 *   - MatrixID #MX-2026-8842 (Level-A)、GPA 3.86、综测 +18.5、精读 142 篇
 *   - 2/3 已完成；晚 20:00 电脑端 CurveLab 跑完衰减拟合
 *   - 桌面队列 2 条：Nat.Phot.25 已挂载、CurveLab 预备拟合
 *
 * 需求文档 §5.1 已指出「承诺 3 张卡、实装 2 张」的矛盾。本端按**产品承诺补足第 3 张**，
 * 并在 README 中登记该决定（补第 3 张而非改文案），与 S2-18 的验收口径一致。
 */

import type {
  AcademicCard,
  CheckinDay,
  MentorBoard,
  MicroGoal,
  MorningBriefing,
  MorningCard,
  QueueItem,
} from '../types';

/* ---------------- 时间工具：让 mock 永远"今天" ---------------- */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function today(): Date {
  return new Date();
}

/** 今天 08:00 的 ISO 串。 */
function todayAt(hour: number, minute = 0): string {
  const d = today();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** 今天 + n 天、指定钟点的 ISO 串。 */
function dayOffsetAt(days: number, hour: number, minute = 0): string {
  const d = today();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

/**
 * 「周五 15:00」的下一次出现。
 * 蓝图写的是固定周五，这里按真实日历推算，让倒计时在任何一天都成立。
 */
function nextFridayAt(hour: number): string {
  const d = today();
  const dow = d.getDay(); // 0=Sun, 5=Fri
  let delta = (5 - dow + 7) % 7;
  // 若今天就是周五但已过时点，推到下周五
  if (delta === 0 && d.getHours() >= hour) delta = 7;
  d.setDate(d.getDate() + delta);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/* ---------------- 1. 晨间三卡 ---------------- */

const MORNING_CARDS: MorningCard[] = [
  {
    id: 'card-natphoton-2025-peai',
    index: 1,
    station: 'pat-hot.matrixos.edu',
    source: 'Nature Photonics',
    title: '钙钛矿 PEAI 准二维钝化突破',
    summary: '准二维钝化将界面非辐射复合压到 4.1%，器件 EQE 抬到 28.4%，与你大创的钝化课题同源。',
    heat: 98.4,
    metrics: [
      { label: 'EQE', value: '28.4%' },
      { label: 'Voc', value: '1.28 V' },
      { label: '稳定性', value: 'T95 > 1200h' },
    ],
    fitNote: '契合大创课题 · 钝化界面工程',
    payloadType: 'paper_doi_bundle',
    targetStation: 'matrix-cross.matrixos.edu',
    desktopAction: '自动唤醒 Matrix-Cross 并挂载该行对比参数',
    evidenceAnchors: [
      {
        source_doi_or_url: '10.1038/s41566-025-01688-2',
        pdf_page: 4,
        bbox: [72.5, 188.0, 410.2, 233.7],
        verification_level: 'Level_A_Verified',
      },
    ],
    publishedAt: todayAt(7, 40),
  },
  {
    id: 'card-arxiv-2610-0492',
    index: 2,
    station: 'pat-hot.matrixos.edu',
    source: 'arXiv:2610.0492',
    title: '双指数衰减拟合的非线性最小二乘改进',
    summary: '提出加权残差重标定，τ₁/τ₂ 相关系数从 0.78 降到 0.21，直接可用于你的 TRPL 数据。',
    heat: 94.1,
    metrics: [
      { label: 'R² 提升', value: '+0.011' },
      { label: 'τ₁ 偏差', value: '-3.2%' },
      { label: '代码', value: 'GitHub 已开源' },
    ],
    fitNote: '可直接替换 CurveLab 现有拟合核',
    payloadType: 'curve_fit_parameters',
    targetStation: 'curvelab.matrixos.edu',
    desktopAction: '在 CurveLab 载入该拟合核并预置参数',
    evidenceAnchors: [
      {
        source_doi_or_url: 'https://arxiv.org/abs/2610.0492',
        pdf_page: 7,
        bbox: [58.0, 96.4, 388.1, 142.9],
        verification_level: 'Level_B_Preprint',
      },
    ],
    publishedAt: todayAt(7, 52),
  },
  {
    id: 'card-advmater-2024-chiral',
    index: 3,
    station: 'pat-hot.matrixos.edu',
    source: 'Adv. Mater.',
    title: '手性分子界面钝化的自旋选择性',
    summary: '手性界面使开路电压损失降至 0.41 V，为你下一轮对比矩阵补上「界面偶极」这一维。',
    heat: 91.7,
    metrics: [
      { label: 'ΔVoc', value: '0.41 V' },
      { label: '自旋极化', value: '68%' },
      { label: '对标', value: 'Adv. Mater. 24' },
    ],
    fitNote: '补齐对比矩阵缺失的「界面偶极」列',
    payloadType: 'comparison_matrix_row',
    targetStation: 'matrix-cross.matrixos.edu',
    desktopAction: '向 Matrix-Cross 追加一行对比参量',
    evidenceAnchors: [
      {
        source_doi_or_url: '10.1002/adma.202407731',
        pdf_page: 6,
        bbox: [64.2, 210.5, 402.8, 258.0],
        verification_level: 'Level_A_Verified',
      },
    ],
    publishedAt: todayAt(7, 58),
  },
];

export function mockMorningBriefing(): MorningBriefing {
  return {
    briefingDate: toDateStr(today()),
    generatedAt: todayAt(8, 0),
    keywords: ['钙钛矿钝化', 'TRPL 拟合', '手性界面'],
    cards: MORNING_CARDS.map((c) => ({ ...c })),
    desktopQueueCount: 2,
  };
}

/* ---------------- 2. 打卡 ---------------- */

function mockGoals(): MicroGoal[] {
  return [
    {
      id: 'goal-paper-read',
      title: '精读 2 篇钙钛矿钝化顶刊',
      note: '早读时间 07:30–08:20，已读完第 1 篇',
      kind: 'study',
      target: '2 篇',
      done: false,
    },
    {
      id: 'goal-trpl-fit',
      title: '晚 20:00 电脑端 CurveLab 跑完衰减拟合',
      note: '晚自习开电脑即刻攻坚 · 已加入桌面队列',
      kind: 'desktop',
      target: '1 组',
      done: false,
    },
    {
      id: 'goal-mentor-mail',
      title: '给张教授回一封补充材料邮件',
      note: '附上复现实验的 R²=0.9884 曲线图',
      kind: 'research',
      target: '1 封',
      done: true,
      doneAt: todayAt(7, 20),
    },
  ];
}

export function mockCheckinDay(): CheckinDay {
  const goals = mockGoals();
  // 蓝图文案：2/3 已完成。上面 mock 里只有 1 个 true，这里再补一个以对齐文案
  goals[0]!.done = true;
  goals[0]!.doneAt = todayAt(8, 20);

  const d = today();
  const week: boolean[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const x = new Date(d);
    x.setDate(x.getDate() - i);
    // 周三是断签日，其余已打；今天按当前完成度
    week.push(i === 0 ? false : x.getDay() !== 3);
  }

  return {
    date: toDateStr(d),
    goals,
    streak: 6,
    week,
    termDays: 47,
    termTarget: 120,
  };
}

/* ---------------- 3. 进组提醒 ---------------- */

export function mockMentorBoard(): MentorBoard {
  const interviewAt = nextFridayAt(15);
  return {
    reminders: [
      {
        id: 'reminder-zhang-interview',
        mentorName: '张教授',
        mentorTitle: '博导 · 光电国家研究中心',
        lab: '光电国重 · 钙钛矿光电器件组',
        stage: 'interview_scheduled',
        stageLabel: '待面试',
        startsAt: interviewAt,
        location: '光电楼 B402',
        readReceipt: true,
        readAt: todayAt(9, 12),
        acknowledged: false,
        matchScore: 94.2,
        evidenceAnchors: [
          {
            source_doi_or_url: '10.1038/s41566-025-01688-2',
            pdf_page: 1,
            bbox: [48.0, 62.0, 300.5, 88.4],
            verification_level: 'Level_A_Verified',
          },
        ],
        outline: [
          {
            page: 1,
            title: '30 秒自我介绍（电梯间版）',
            points: [
              '光电信息科学与工程 · 大三 · GPA 3.86（专业前 4.2%）',
              '国创「钙钛矿钝化界面工程」负责人，1 作论文在投',
              '能独立完成 TRPL 双指数拟合与 Nature 级矢量图',
            ],
          },
          {
            page: 2,
            title: '我的复现实验（可验真）',
            points: [
              '按 PEAI 准二维钝化方案复现，R² = 0.9884',
              'τ₁ = 14.2 ns / τ₂ = 89.5 ns，与原文偏差 < 5%',
              '代码与原始散点已在 3 个 GitHub 仓库开源（含 seed）',
            ],
          },
          {
            page: 3,
            title: '进组后的第一步',
            points: [
              '第一周：复现组内基线器件，产出可比对的 EQE 曲线',
              '第一月：把手性界面钝化那条线接入现有对比矩阵',
              '预期贡献：补齐「界面偶极」维度并沉淀为组内台账',
            ],
          },
        ],
      },
      {
        id: 'reminder-li-cold-email',
        mentorName: '李研究员',
        mentorTitle: '硕导 · 宽禁带半导体组',
        lab: '材料学院 · 宽禁带半导体',
        stage: 'email_read',
        stageLabel: '已读待回复',
        startsAt: dayOffsetAt(2, 10, 30),
        location: '线上（腾讯会议）',
        readReceipt: true,
        readAt: dayOffsetAt(-1, 21, 4),
        acknowledged: true,
        matchScore: 81.5,
        evidenceAnchors: [
          {
            source_doi_or_url: '10.1002/adma.202407731',
            pdf_page: 3,
            bbox: [60.0, 150.0, 360.0, 190.0],
            verification_level: 'Level_A_Verified',
          },
        ],
      },
    ],
    nextEventAt: interviewAt,
    syncedAt: new Date().toISOString(),
  };
}

/* ---------------- 4. 学术名片 ---------------- */

export function mockAcademicCard(): AcademicCard {
  return {
    matrixUid: 'MX-2026-8842',
    displayName: '孙同学',
    subtitle: '光电大三 · GPA 3.86 · 国创负责人',
    school: '华中光电科技大学',
    major: '光电信息科学与工程',
    grade: '2023 级（大三）',
    qrPayload: 'https://card.matrixos.edu/c/MX-2026-8842?src=wechat-pocket&v=1',
    metrics: [
      { label: 'GPA', value: '3.86', hint: '专业前 4.2%' },
      { label: '综测加分', value: '+18.5', hint: '云衡已核算' },
      { label: '精读文献', value: '142', hint: '篇 · Level-A 37' },
      { label: '复现仓库', value: '3', hint: 'GitHub 已验真' },
    ],
    evidences: [
      {
        kind: 'doi',
        label: '一作论文（在投）',
        ref: '10.1038/s41566-025-01688-2',
        verification: 'Level_A_Verified',
        verifiedNote: 'DOI 可解析 · Crossref 命中 · 无撤稿记录',
      },
      {
        kind: 'github',
        label: 'TRPL 双指数拟合复现',
        ref: 'github.com/mx-lab/trpl-biexp-fit',
        verification: 'Level_A_Verified',
        verifiedNote: '含随机种子与 Dockerfile · 最近提交 3 天前',
      },
      {
        kind: 'github',
        label: '钙钛矿 EQE 数据清洗',
        ref: 'github.com/mx-lab/pvk-eqe-clean',
        verification: 'Level_A_Verified',
        verifiedNote: 'CI 通过 · 复现成功率 100%',
      },
      {
        kind: 'patent',
        label: '软件著作权（受理）',
        ref: '2026SR0318842',
        verification: 'Level_B_Preprint',
        verifiedNote: '受理号可查 · 证书待下发',
      },
      {
        kind: 'competition',
        label: '挑战杯 · 省一等奖',
        ref: 'TZB-2025-HB-0142',
        verification: 'Level_A_Verified',
        verifiedNote: '省赛公示名单可核',
      },
    ],
    verificationLevel: 'Level_A_Verified',
    updatedAt: new Date().toISOString(),
  };
}

/* ---------------- 5. 桌面队列 ---------------- */

export function mockQueueItems(): QueueItem[] {
  const morning = MORNING_CARDS;
  return [
    {
      id: 'q-natphoton-mounted',
      origin: 'morning_card',
      originRef: morning[0]!.id,
      title: 'Nat. Phot. 25 · PEAI 准二维钝化',
      note: '已挂载到 Matrix-Cross 对比矩阵第 3 行',
      targetStation: 'matrix-cross.matrixos.edu',
      desktopAction: '自动唤醒 Matrix-Cross',
      payloadType: 'paper_doi_bundle',
      evidenceAnchors: morning[0]!.evidenceAnchors,
      status: 'claimed',
      claimedAt: new Date(Date.now() - 26 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      receiptId: 'rcpt_01H8Z9K2A',
    },
    {
      id: 'q-curvelab-prefit',
      origin: 'checkin_goal',
      originRef: 'goal-trpl-fit',
      title: 'CurveLab 预备拟合（τ₁/τ₂）',
      note: '晚自习开电脑即刻攻坚',
      targetStation: 'curvelab.matrixos.edu',
      desktopAction: '在 CurveLab 预置双指数初值 τ₁=14.2 / τ₂=89.5',
      payloadType: 'curve_fit_parameters',
      evidenceAnchors: morning[1]!.evidenceAnchors,
      status: 'pending',
      createdAt: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      receiptId: 'rcpt_01H8Z9K2B',
    },
  ];
}
