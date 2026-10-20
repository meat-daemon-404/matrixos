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
  '01', '03', '04', '06', '08', '09', '11', '12', '15', '16', '17',
];
