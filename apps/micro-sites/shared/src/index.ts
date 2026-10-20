/**
 * 微站演示数据与仪器绑定表。
 *
 * 为什么集中在一处：
 * 18 个微站如果各自编造 demo 数据，很快就会出现「同一份综测分在两个站不一样」
 * 这类不一致，答辩演示时尤其致命。这里按 ADR-001 的站点归属，
 * 把每个站点绑定到 instrument-ui 的一个仪器组件 + 一份可复现的 demo 数据。
 *
 * 数据全部是**确定性**的（固定 seed / 固定常量），刷新页面不跳变——
 * 视觉评审与截图对比才可靠。
 *
 * ⚠️ 本文件的所有类型均直接引用 @matrixos/instrument-ui 的导出，
 * 字段名以该库的实现为准（不是契约里的 snake_case）。
 */
import type {
  ScatterPoint,
  SonarBlip,
  GaugeColumn,
  BalancePan,
  EvidenceAnchor,
  KanbanColumn,
  KanbanTask,
} from '@matrixos/instrument-ui';

/* ==========================================================================
 * 通用：确定性伪随机（mulberry32）
 * ========================================================================== */
function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==========================================================================
 * 01 · 学分绩点动态配重台
 * ========================================================================== */

export interface CourseWeight {
  readonly id: string;
  readonly name: string;
  readonly credits: number;
  readonly currentGrade: number;
  readonly targetGrade: number;
  readonly core: boolean;
}

/** 光电专业大三课表（真实场景从教务系统拉，此处为 demo） */
export const GPA_COURSES: readonly CourseWeight[] = [
  { id: 'c1', name: '量子力学', credits: 4, currentGrade: 88, targetGrade: 95, core: true },
  { id: 'c2', name: '固体物理', credits: 3, currentGrade: 85, targetGrade: 92, core: true },
  { id: 'c3', name: '光电检测技术', credits: 3, currentGrade: 91, targetGrade: 96, core: true },
  { id: 'c4', name: '数学物理方法', credits: 4, currentGrade: 79, targetGrade: 88, core: true },
  { id: 'c5', name: '专业英语', credits: 2, currentGrade: 87, targetGrade: 90, core: false },
  { id: 'c6', name: '工程伦理', credits: 1, currentGrade: 93, targetGrade: 93, core: false },
];

/** 成绩 → 绩点（4.0 制，常见换算） */
export function gradeToPoint(grade: number): number {
  if (grade >= 90) return 4.0;
  if (grade >= 85) return 3.7;
  if (grade >= 80) return 3.3;
  if (grade >= 75) return 3.0;
  if (grade >= 70) return 2.7;
  if (grade >= 65) return 2.3;
  return 2.0;
}

/** 学分加权 GPA。useTarget=true 时按目标成绩算（用于模拟「如果考到 X 分」）。 */
export function weightedGpa(courses: readonly CourseWeight[], useTarget = false): number {
  let sum = 0;
  let credits = 0;
  for (const c of courses) {
    sum += gradeToPoint(useTarget ? c.targetGrade : c.currentGrade) * c.credits;
    credits += c.credits;
  }
  return credits === 0 ? 0 : sum / credits;
}

/* ==========================================================================
 * 03 · 大创五科目经费液位仪
 * ========================================================================== */

/**
 * 国家级大创 ¥20,000 标准报销科目（数值来自 Bundle 预算表）。
 * 劳务费红线 20% 是高校财务硬规定 —— redline 让组件在超标时阻断。
 */
export const GRANT_COLUMNS: readonly GaugeColumn[] = [
  { id: 'compute', label: '云算力与测试加工', value: 6800, capacity: 6800, unit: '¥' },
  { id: 'ip', label: '知识产权与出版版面', value: 4500, capacity: 4500, unit: '¥' },
  // 劳务：已用 2500 / 预算 2500，上限按 20% 红线计为 4000
  { id: 'labor', label: '学生科研测试劳务', value: 2500, capacity: 4000, redline: 0.2, unit: '¥' },
  { id: 'travel', label: '跨校调研与竞赛差旅', value: 3500, capacity: 3500, unit: '¥' },
  { id: 'data', label: '数据采集与文献耗材', value: 2700, capacity: 2700, unit: '¥' },
];

export const GRANT_TOTAL = 20000;

/* ==========================================================================
 * 04 · PAT-HOT 学科脉冲雷达
 * ========================================================================== */

export interface PatHotItem {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly heat: number;
  readonly doi: string;
  readonly summary: string;
  readonly tags: readonly string[];
}

/** 物理·天文·光电 24h 前沿（demo，非真实抓取） */
export const PAT_HOT_ITEMS: readonly PatHotItem[] = [
  {
    id: 'p1',
    title: '钙钛矿太阳能电池界面钝化的准二维策略',
    source: 'Nature Photonics',
    heat: 98.4,
    doi: '10.1038/s41566-025-01234-5',
    summary: 'PEAI 准二维钝化将界面缺陷密度降低两个数量级，峰值 EQE 达 28.4%。',
    tags: ['钙钛矿', '界面工程'],
  },
  {
    id: 'p2',
    title: '手性钙钛矿自旋选择性传输的直接观测',
    source: 'JACS',
    heat: 91.2,
    doi: '10.1021/jacs.4c0112',
    summary: '室温下观测到手性钙钛矿的 CISS 效应，自旋极化率超过 60%。',
    tags: ['手性', '自旋电子学'],
  },
  {
    id: 'p3',
    title: '超快激光脉冲在拓扑绝缘体中的相干控制',
    source: 'Physical Review Letters',
    heat: 85.7,
    doi: '10.1103/PhysRevLett.134.123456',
    summary: '飞秒脉冲实现拓扑表面态的相干操控，为拓扑量子计算提供新路径。',
    tags: ['超快光学', '拓扑'],
  },
  {
    id: 'p4',
    title: '可调谐等离激元超表面的可见光全息显示',
    source: 'Advanced Materials',
    heat: 79.3,
    doi: '10.1002/adma.202501234',
    summary: '基于相变材料的主动超表面，实现动态全息图像的毫秒级切换。',
    tags: ['超表面', '全息'],
  },
];

/* ==========================================================================
 * 05 · 五源跨库引文声呐站
 * ========================================================================== */

export interface CitationNode {
  readonly id: string;
  readonly label: string;
  readonly year: number;
  readonly citations: number;
  readonly seminal: boolean;
  /** 归一化坐标 0..1 */
  readonly x: number;
  readonly y: number;
}

export const CITATION_NODES: readonly CitationNode[] = [
  { id: 'n1', label: 'Miyata 2015', year: 2015, citations: 2840, seminal: true, x: 0.18, y: 0.32 },
  { id: 'n2', label: 'Kojima 2009', year: 2009, citations: 5120, seminal: true, x: 0.1, y: 0.62 },
  { id: 'n3', label: 'Lee 2018', year: 2018, citations: 1420, seminal: false, x: 0.4, y: 0.22 },
  { id: 'n4', label: 'Jiang 2021', year: 2021, citations: 890, seminal: false, x: 0.58, y: 0.44 },
  { id: 'n5', label: 'Zhang 2023', year: 2023, citations: 430, seminal: false, x: 0.74, y: 0.28 },
  { id: 'n6', label: 'Chen 2025', year: 2025, citations: 88, seminal: false, x: 0.86, y: 0.6 },
];

/* ==========================================================================
 * 06 · 星门导师五维星象仪
 * ========================================================================== */

export interface MentorCandidate {
  readonly id: string;
  readonly name: string;
  readonly affiliation: string;
  readonly matchScore: number;
  readonly dimensions: {
    readonly activity: number;
    readonly hIndexSlope: number;
    readonly funding: number;
    readonly undergradFriendly: number;
    readonly directionFit: number;
  };
}

export const MENTORS: readonly MentorCandidate[] = [
  {
    id: 'm1',
    name: '张教授',
    affiliation: '光电国家研究中心',
    matchScore: 94.2,
    dimensions: { activity: 92, hIndexSlope: 88, funding: 95, undergradFriendly: 90, directionFit: 96 },
  },
  {
    id: 'm2',
    name: '李教授',
    affiliation: '物理系 · 量子光学',
    matchScore: 87.5,
    dimensions: { activity: 85, hIndexSlope: 82, funding: 78, undergradFriendly: 88, directionFit: 91 },
  },
  {
    id: 'm3',
    name: '王博导',
    affiliation: '超快激光实验室',
    matchScore: 81.3,
    dimensions: { activity: 78, hIndexSlope: 90, funding: 82, undergradFriendly: 70, directionFit: 79 },
  },
];

/* ==========================================================================
 * 08 · 太空任务式进组跟进台账
 * ========================================================================== */

export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  { id: 'queued', title: 'STAGE 01 · 已建档', subtitle: 'Drafted', accent: 'indigo' },
  { id: 'sent', title: 'STAGE 02 · 已发信', subtitle: 'Sent', accent: 'cyan' },
  { id: 'read', title: 'STAGE 03 · 已读待复', subtitle: 'Awaiting', accent: 'amber', wipLimit: 3 },
  { id: 'interview', title: 'STAGE 04 · 待面试', subtitle: 'Interview', accent: 'violet' },
  { id: 'joined', title: 'STAGE 05 · 已进组', subtitle: 'Joined', accent: 'emerald', locked: true },
];

export const KANBAN_TASKS: readonly KanbanTask[] = [
  {
    id: 't1',
    columnId: 'queued',
    title: '李教授 · 量子光学',
    summary: '匹配 87.5% · 套磁信待写',
    priority: 'P1',
    tags: ['待办'],
  },
  {
    id: 't2',
    columnId: 'sent',
    title: '刘教授 · 钙钛矿器件',
    summary: '已发信 3 天 · 暂无回音',
    priority: 'P2',
    tags: ['等待'],
  },
  {
    id: 't3',
    columnId: 'read',
    title: '陈教授 · 光学超表面',
    summary: '已读 2 天 · 建议跟进',
    priority: 'P0',
    tags: ['跟进'],
    due: '2026-10-22',
  },
  {
    id: 't4',
    columnId: 'interview',
    title: '张教授 · 光电国重',
    summary: '周五 15:00 · 光电楼 302',
    priority: 'P0',
    tags: ['面试'],
    due: '2026-10-24',
  },
  {
    id: 't5',
    columnId: 'joined',
    title: '王博导 · 超快激光',
    summary: '已开放工位 · 下周报到',
    tags: ['完成'],
  },
];

/* ==========================================================================
 * 09 · Matrix-Cross 跨论文对比矩阵
 * ========================================================================== */

export interface PaperRow {
  readonly id: string;
  readonly venue: string;
  readonly strategy: string;
  readonly eqe: string;
  readonly anchor: EvidenceAnchor;
}

/**
 * 对比矩阵示例行，每行带 PDF 原文锚点 —— 这是 v3 的核心卖点（杜绝幻觉）。
 * 注意字段名与契约不同：库内部用 camelCase，虫洞投送时再转 snake_case。
 */
export const PAPER_ROWS: readonly PaperRow[] = [
  {
    id: 'r1',
    venue: 'Nat. Photon. 2025',
    strategy: 'PEAI 准二维钝化',
    eqe: '28.4%',
    anchor: {
      sourceDoiOrUrl: '10.1038/s41566-025-01234-5',
      pdfPage: 4,
      bbox: [72.5, 144.0, 300.25, 210.75],
      verificationLevel: 'Level_A_Verified',
      note: 'Fig. 2b',
    },
  },
  {
    id: 'r2',
    venue: 'Adv. Mater. 2024',
    strategy: 'R/S-MBA 手性界面',
    eqe: '25.1%',
    anchor: {
      sourceDoiOrUrl: '10.1002/adma.202401234',
      pdfPage: 7,
      bbox: [60.0, 200.0, 280.5, 320.25],
      verificationLevel: 'Level_A_Verified',
      note: 'Tab. S3',
    },
  },
  {
    id: 'r3',
    venue: 'JACS 2025',
    strategy: '双氟代配体交联',
    eqe: '26.8%',
    anchor: {
      sourceDoiOrUrl: '10.1021/jacs.4c0112',
      pdfPage: 3,
      bbox: [55.0, 180.0, 290.0, 260.0],
      verificationLevel: 'Level_B_Preprint',
      note: 'Para. 2',
    },
  },
];

/* ==========================================================================
 * 11 · CurveLab 非线性拟合示波器
 * ========================================================================== */

/** 双指数衰减的确定性散点（模拟 TRPL 测量） */
export function curvelabPoints(count = 180, seed = 20261020, noise = 1.2): readonly ScatterPoint[] {
  const rand = createRandom(seed);
  const out: ScatterPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i / (count - 1)) * 10;
    const base = 3.2 * Math.exp(-t / 1.4) + 1.1 * Math.exp(-t / 5.5);
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    out.push({ x: t, y: base + g * noise * (0.6 + 0.4 * (i / count)) });
  }
  return out;
}

/* ==========================================================================
 * 12 · 顶刊代码复现核验舱
 * ========================================================================== */

export interface ReproCheck {
  readonly id: string;
  readonly item: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly detail: string;
}

export const REPRO_CHECKS: readonly ReproCheck[] = [
  { id: 'k1', item: '依赖环境', status: 'pass', detail: 'requirements.txt 锁定版本，Python 3.11' },
  { id: 'k2', item: '数据可得性', status: 'pass', detail: 'Figshare 开放数据 DOI 可解析' },
  { id: 'k3', item: '随机种子', status: 'warn', detail: '仅主实验固定 seed，消融未说明' },
  { id: 'k4', item: '超参完整性', status: 'fail', detail: '缺少学习率与 batch size 记录' },
  { id: 'k5', item: '硬件要求', status: 'pass', detail: '单卡 A100 可复现' },
];

/* ==========================================================================
 * 15 · 撤稿深海声呐与伦理合规仪
 * ========================================================================== */

export const RETRACT_BLIPS: readonly SonarBlip[] = [
  { id: 'b1', label: '37 篇引文 Level-A 通过', angle: 20, radius: 0.3, risk: 'safe' },
  { id: 'b2', label: 'Crossref 零撤稿', angle: 80, radius: 0.5, risk: 'safe' },
  { id: 'b3', label: '1 篇图像重复质疑', angle: 150, radius: 0.6, risk: 'caution' },
  { id: 'b4', label: 'DOI:10.1021/jacs.4c0112', angle: 165, radius: 0.55, risk: 'caution', detail: 'PubPeer 有 2 条评论' },
  { id: 'b5', label: '2 篇勘误未处理', angle: 220, radius: 0.4, risk: 'critical', weight: 1.4 },
  { id: 'b6', label: '引用格式不规范', angle: 300, radius: 0.7, risk: 'safe' },
];

/* ==========================================================================
 * 16 · 云衡数字天平综测核算器
 * ========================================================================== */

export const YUNHENG_PANS: readonly BalancePan[] = [
  { id: 'moral', label: '德育', value: 2.0, capacity: 3.0, hint: '志愿 ×0.5' },
  { id: 'intellect', label: '智育', value: 4.86, capacity: 5.0, hint: 'GPA 3.86' },
  { id: 'research', label: '科研双创', value: 14.0, capacity: 15.0, hint: '国创 +1 作论文' },
];

export const YUNHENG_TOTAL = 18.5;

/* ==========================================================================
 * 17 · 区块链级学术证据简历工坊
 * ========================================================================== */

export interface CvEntry {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly period: string;
  readonly anchors: readonly EvidenceAnchor[];
}

export const CV_ENTRIES: readonly CvEntry[] = [
  {
    id: 'cv1',
    title: '钙钛矿太阳能电池界面钝化研究',
    role: '第一作者',
    period: '2025.03 - 2025.09',
    anchors: [
      {
        sourceDoiOrUrl: '10.1038/s41566-025-01234-5',
        pdfPage: 4,
        bbox: [72.5, 144.0, 300.25, 210.75],
        verificationLevel: 'Level_A_Verified',
        note: 'Fig. 2b 原文',
      },
    ],
  },
  {
    id: 'cv2',
    title: 'MatrixOS 科研工作台（软件著作权）',
    role: '独立开发',
    period: '2025.06 - 至今',
    anchors: [
      {
        sourceDoiOrUrl: 'https://github.com/meat-daemon-404/matrixos',
        verificationLevel: 'Level_A_Verified',
        note: 'GitHub 仓库哈希验真',
      },
    ],
  },
];

/* ==========================================================================
 * 02 · 双创互补组队雷达 —— 技能极坐标互补盘
 * ========================================================================== */

export interface TeammateCandidate {
  readonly id: string;
  readonly name: string;
  readonly major: string;
  /** 五维技能评分（0-100）：硬件 / 算法 / 商业 / 实验 / 写作 */
  readonly skills: {
    readonly hardware: number;
    readonly algorithm: number;
    readonly business: number;
    readonly experiment: number;
    readonly writing: number;
  };
  /** 与当前用户的互补度（0-100） */
  readonly complementScore: number;
}

export const TEAMMATES: readonly TeammateCandidate[] = [
  {
    id: 'tm1',
    name: '陈同学',
    major: '计算机学院',
    complementScore: 92.4,
    skills: { hardware: 35, algorithm: 95, business: 40, experiment: 30, writing: 55 },
  },
  {
    id: 'tm2',
    name: '林同学',
    major: '商学院',
    complementScore: 86.1,
    skills: { hardware: 20, algorithm: 30, business: 96, experiment: 25, writing: 88 },
  },
  {
    id: 'tm3',
    name: '赵同学',
    major: '材料学院',
    complementScore: 78.5,
    skills: { hardware: 70, algorithm: 45, business: 30, experiment: 92, writing: 60 },
  },
];

/** 当前用户自己的技能画像（对照基准） */
export const SELF_SKILLS = {
  hardware: 88,
  algorithm: 52,
  business: 35,
  experiment: 90,
  writing: 68,
} as const;

export const SKILL_LABELS: Readonly<Record<keyof typeof SELF_SKILLS, string>> = {
  hardware: '硬件',
  algorithm: '算法',
  business: '商业',
  experiment: '实验',
  writing: '写作',
};

/* ==========================================================================
 * 05 · 五源跨库引文声呐站 —— 已有 CITATION_NODES，补充边关系
 * ========================================================================== */

export interface CitationEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'cites' | 'extends' | 'refutes';
}

export const CITATION_EDGES: readonly CitationEdge[] = [
  { from: 'n2', to: 'n1', kind: 'extends' },
  { from: 'n1', to: 'n3', kind: 'extends' },
  { from: 'n3', to: 'n4', kind: 'cites' },
  { from: 'n4', to: 'n5', kind: 'extends' },
  { from: 'n5', to: 'n6', kind: 'cites' },
  { from: 'n4', to: 'n6', kind: 'refutes' },
];

/** 数据源覆盖情况 */
export const CITATION_SOURCES = [
  { id: 'openalex', label: 'OpenAlex', count: 2840 },
  { id: 'arxiv', label: 'arXiv', count: 1920 },
  { id: 'pubmed', label: 'PubMed', count: 640 },
  { id: 'crossref', label: 'Crossref', count: 1740 },
  { id: 'semantic', label: 'Semantic Scholar', count: 1210 },
] as const;

/* ==========================================================================
 * 07 · 证据内嵌式套磁信推演器 —— 双栏红蓝对抗
 * ========================================================================== */

export interface EmailDraft {
  readonly id: string;
  readonly version: string;
  readonly subject: string;
  readonly body: string;
  /** 导师视角评分（0-100），模拟「红队」审阅 */
  readonly redTeamScore: number;
  readonly redTeamIssues: readonly string[];
}

export const EMAIL_DRAFTS: readonly EmailDraft[] = [
  {
    id: 'd1',
    version: '草案 A · 平铺直叙',
    subject: '关于钙钛矿界面钝化研究的请教',
    body: `张教授您好，

我是光电专业大三学生孙同学，对您 2025 年发表在 Nature Photonics 上的
准二维钝化工作非常感兴趣。我正在做大创课题，方向是钙钛矿太阳能电池的
界面工程。

我已复现了您论文中的双指数衰减拟合（R² = 0.988），并在此基础上尝试了
R/S-MBA 手性界面的对照实验。

不知您本学期是否有接收本科生的计划？希望能有机会向您请教。

祝好
孙同学`,
    redTeamScore: 62,
    redTeamIssues: ['缺少具体的数据证据锚点', '没有说明能为课题组带来什么', '自我定位不够清晰'],
  },
  {
    id: 'd2',
    version: '草案 B · 证据嵌入版',
    subject: '准二维钝化复现结果 + 关于进组学习的请求',
    body: `张教授您好，

我是光电专业大三学生孙同学（GPA 3.86，专业前 4.2%）。

我复现了您 Nat. Photon. 2025 论文（DOI 10.1038/s41566-025-01234-5）
Fig. 2b 的双指数衰减拟合，R² = 0.9884，τ₁ = 14.2 ns、τ₂ = 89.5 ns，
与原文报告值偏差 < 3%（见附件拟合图与残差分析）。

进一步，我在 PEAI 钝化基础上做了 R/S-MBA 手性界面的对照，观察到
EQE 从 28.4% 降至 25.1%，与 Adv. Mater. 2024 的趋势一致。

我希望能在您课题组学习界面工程的系统方法。如果您本学期有接收计划，
我可以每周投入 15 小时，从数据整理与样品制备做起。

附：拟合代码仓库 [GitHub 链接]、实验记录本 [PDF]

祝好
孙同学`,
    redTeamScore: 91,
    redTeamIssues: [],
  },
];

export const EMAIL_TIPS = [
  '首段说明来意，不要铺垫过长',
  '具体引用导师的某篇论文（含 DOI）',
  '展示你实际做了什么，而非「很感兴趣」',
  '说明可投入时间与能承担的工作',
  '附件给可验证的证据（代码、图、记录）',
] as const;

/* ==========================================================================
 * 10 · PDF 公式与参量狙击镜 —— 双栏光学瞄准
 * ========================================================================== */

export interface FormulaEntry {
  readonly id: string;
  readonly latex: string;
  readonly plain: string;
  /** 物理量纲解释 */
  readonly dimension: string;
  readonly explanation: string;
  readonly python: string;
}

export const FORMULAS: readonly FormulaEntry[] = [
  {
    id: 'f1',
    latex: 'I(t) = A_1 e^{-t/\\tau_1} + A_2 e^{-t/\\tau_2}',
    plain: 'I(t) = A₁e^(-t/τ₁) + A₂e^(-t/τ₂)',
    dimension: 'A₁, A₂ 无量纲（归一化强度）；τ₁, τ₂ 单位 ns',
    explanation: '双指数衰减模型，描述载流子在快、慢两个通道的复合过程。常用于 TRPL 时间分辨荧光测量。',
    python: `import numpy as np
def bi_exp(t, A1, tau1, A2, tau2):
    return A1 * np.exp(-t / tau1) + A2 * np.exp(-t / tau2)`,
  },
  {
    id: 'f2',
    latex: 'R^2 = 1 - \\frac{\\sum (y_i - \\hat{y}_i)^2}{\\sum (y_i - \\bar{y})^2}',
    plain: 'R² = 1 - Σ(yᵢ - ŷᵢ)² / Σ(yᵢ - ȳ)²',
    dimension: '无量纲，取值范围 (-∞, 1]',
    explanation: '决定系数，衡量拟合优度。1 表示完美拟合，0 表示与均值预测等效，负值说明模型比均值还差。',
    python: `def r_squared(y_true, y_pred):
    ss_res = np.sum((y_true - y_pred) ** 2)
    ss_tot = np.sum((y_true - np.mean(y_true)) ** 2)
    return 1 - ss_res / ss_tot`,
  },
  {
    id: 'f3',
    latex: 'EQE = \\frac{J_{sc}}{q \\Phi}',
    plain: 'EQE = J_sc / (q · Φ)',
    dimension: 'J_sc 单位 A/m²；q = 1.602×10⁻¹⁹ C；Φ 为单位面积光子通量',
    explanation: '外量子效率，收集到的电子数与入射光子数之比。EQE 超过 100% 意味着存在多激子产生等增益机制。',
    python: `q = 1.602e-19  # 元电荷 (C)

def eqe(J_sc, photon_flux):
    """J_sc: A/m^2, photon_flux: 光子/(m^2·s)"""
    return J_sc / (q * photon_flux)`,
  },
];

/** 模拟双栏 PDF 的原文段落（截图式呈现） */
export const PDF_SNIPPETS = [
  {
    id: 's1',
    page: 4,
    text: 'The TRPL decay curves were fitted with a bi-exponential model. The fitted lifetimes were τ₁ = 14.2 ns and τ₂ = 89.5 ns, with R² = 0.9884.',
    formulaId: 'f1',
  },
  {
    id: 's2',
    page: 5,
    text: 'The external quantum efficiency (EQE) was calculated from the J–V measurements and the spectral response.',
    formulaId: 'f3',
  },
  {
    id: 's3',
    page: 8,
    text: 'Goodness of fit was evaluated using the coefficient of determination R² across all devices.',
    formulaId: 'f2',
  },
] as const;

/* ==========================================================================
 * 13 · Nature 级出版图表熔炉 —— 光学暗房调色台
 * ========================================================================== */

export interface ChartStyle {
  readonly id: string;
  readonly name: string;
  readonly journal: string;
  readonly columnWidth: string;
  readonly fontSize: string;
  readonly dpi: number;
  readonly colorBlindSafe: boolean;
  readonly palette: readonly string[];
}

export const CHART_STYLES: readonly ChartStyle[] = [
  {
    id: 'nature',
    name: 'Nature 双栏',
    journal: 'Nature / Nature Photonics',
    columnWidth: '89 mm（单栏）/ 183 mm（双栏）',
    fontSize: '5–7 pt',
    dpi: 300,
    colorBlindSafe: true,
    palette: ['#0C2C4D', '#1B7C8C', '#57B8A8', '#E8A33D', '#C94C4C'],
  },
  {
    id: 'ieee',
    name: 'IEEE Transactions',
    journal: 'IEEE 系列',
    columnWidth: '88.9 mm / 181 mm',
    fontSize: '8 pt',
    dpi: 600,
    colorBlindSafe: true,
    palette: ['#000000', '#4D4D4D', '#0072B2', '#D55E00', '#009E73'],
  },
  {
    id: 'screen',
    name: '屏幕演示',
    journal: '答辩 / 幻灯片',
    columnWidth: '自适应',
    fontSize: '14–18 pt',
    dpi: 150,
    colorBlindSafe: true,
    palette: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e'],
  },
];

/* ==========================================================================
 * 14 · 综述拓扑推演与写作舱 —— 章节逻辑流
 * ========================================================================== */

export interface ReviewCluster {
  readonly id: string;
  readonly school: string;
  readonly papers: number;
  readonly citations: number;
  readonly keyClaim: string;
  readonly representativeDoi: string;
}

export const REVIEW_CLUSTERS: readonly ReviewCluster[] = [
  {
    id: 'c1',
    school: '准二维钝化流派',
    papers: 12,
    citations: 1840,
    keyClaim: '引入大有机阳离子形成准二维层，抑制界面非辐射复合',
    representativeDoi: '10.1038/s41566-025-01234-5',
  },
  {
    id: 'c2',
    school: '手性界面流派',
    papers: 7,
    citations: 620,
    keyClaim: '利用手性分子诱导 CISS 效应，同时提升效率与自旋选择性',
    representativeDoi: '10.1002/adma.202401234',
  },
  {
    id: 'c3',
    school: '双氟代配体交联',
    papers: 9,
    citations: 980,
    keyClaim: '氟代配体交联增强界面稳定性，改善器件寿命',
    representativeDoi: '10.1021/jacs.4c0112',
  },
];

export const REVIEW_OUTLINE = [
  { id: 'o1', level: 1, text: '引言：钙钛矿太阳能电池的效率瓶颈' },
  { id: 'o2', level: 2, text: '界面非辐射复合的物理机制' },
  { id: 'o3', level: 1, text: '界面工程三大技术流派' },
  { id: 'o4', level: 2, text: '准二维钝化：范式与局限', clusterId: 'c1' },
  { id: 'o5', level: 2, text: '手性界面：自旋自由度的引入', clusterId: 'c2' },
  { id: 'o6', level: 2, text: '氟代交联：稳定性优先路线', clusterId: 'c3' },
  { id: 'o7', level: 1, text: '流派比较与研究空白' },
] as const;

/* ==========================================================================
 * 18 · 生涯多重宇宙期望决策树 —— 量子分岔概率光轨
 * ========================================================================== */

export interface CareerPath {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 五年期望收益（万元） */
  readonly expectedGain: number;
  /** 风险评级 */
  readonly risk: 'low' | 'medium' | 'high';
  /** 各年收益轨迹（万元），与 expectedGain 自洽 */
  readonly trajectory: readonly number[];
  readonly probabilities: {
    readonly success: number;
    readonly neutral: number;
    readonly fail: number;
  };
}

/**
 * 三条生涯路径的五年推演。
 * 数值自洽性：trajectory 的均值应约等于 expectedGain / 5。
 */
export const CAREER_PATHS: readonly CareerPath[] = [
  {
    id: 'p1',
    name: '推免直博',
    description: '保研本校直博，5 年博士毕业进入高校或研究所',
    expectedGain: 85,
    risk: 'medium',
    trajectory: [2, 4, 6, 8, 15],
    probabilities: { success: 0.62, neutral: 0.28, fail: 0.1 },
  },
  {
    id: 'p2',
    name: '头部光企研发',
    description: '硕士毕业后进入头部光电企业做研发工程师',
    expectedGain: 120,
    risk: 'low',
    trajectory: [18, 22, 25, 27, 28],
    probabilities: { success: 0.78, neutral: 0.18, fail: 0.04 },
  },
  {
    id: 'p3',
    name: '选调考公',
    description: '应届考取定向选调，进入体制内技术管理岗',
    expectedGain: 70,
    risk: 'low',
    trajectory: [10, 12, 14, 16, 18],
    probabilities: { success: 0.55, neutral: 0.35, fail: 0.1 },
  },
];

/* ==========================================================================
 * 站点 → 仪器绑定表
 * ========================================================================== */

export type InstrumentKind =
  | 'gpa-pusher'
  | 'spark-radar'
  | 'grant-gauge'
  | 'pat-radar'
  | 'citation-sonar'
  | 'mentor-radar'
  | 'cold-email'
  | 'lab-kanban'
  | 'matrix-cross'
  | 'pdf-sniper'
  | 'curvelab'
  | 'repro-checklist'
  | 'chart-foundry'
  | 'review-lab'
  | 'retract-sonar'
  | 'yunheng-balance'
  | 'evidence-cv'
  | 'prejob-tree';

/** 按站点 id 索引的仪器类型。页面据此决定渲染哪个仪器组件。 */
export const SITE_INSTRUMENT: Readonly<Record<string, InstrumentKind>> = {
  '01': 'gpa-pusher',
  '02': 'spark-radar',
  '03': 'grant-gauge',
  '04': 'pat-radar',
  '05': 'citation-sonar',
  '06': 'mentor-radar',
  '07': 'cold-email',
  '08': 'lab-kanban',
  '09': 'matrix-cross',
  '10': 'pdf-sniper',
  '11': 'curvelab',
  '12': 'repro-checklist',
  '13': 'chart-foundry',
  '14': 'review-lab',
  '15': 'retract-sonar',
  '16': 'yunheng-balance',
  '17': 'evidence-cv',
  '18': 'prejob-tree',
};

/** 哪些站点已接上真实仪器（未列出的仍为骨架）。 */
export const IMPLEMENTED_SITES: readonly string[] = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09',
  '10', '11', '12', '13', '14', '15', '16', '17', '18',
];
