/**
 * Demo 数据（虚构但自洽）。
 *
 * 这里的数值刻意保持「业务可解释」：每一组都对应 specs/microsites.json 里
 * 某个真实微站的业务语义，而不是 lorem 占位。理由很简单——仪器的视觉设计
 * 只有灌进真实量纲的数据才能看出它是否成立（刻度范围、红线位置、读数位宽）。
 *
 * 所有导出都用 `satisfies` 约束到组件库的公开类型上，因此**类型漂移会直接
 * 让 demo 的 typecheck 失败**，等于给组件 props 加了一层契约守卫。
 */

import type {
  BalancePan,
  EvidenceAnchor,
  GaugeColumn,
  KanbanColumn,
  KanbanTask,
  SonarBlip,
  StarOrbitStation,
  WormholeTarget,
} from '../src/index';

/* -------------------------------------------------------------------------- */
/* 旋钮演示的格式化                                                            */
/* -------------------------------------------------------------------------- */

/** 拟合时间常数 τ（ns），演示高精度小数步进。 */
export const TAU_MIN = 0;
export const TAU_MAX = 5;

/* -------------------------------------------------------------------------- */
/* SonarDisc · 05 站「五源跨库引文声呐 / 15 站撤稿深海声呐」                    */
/* -------------------------------------------------------------------------- */

export const SONAR_BLIPS = [
  {
    id: 'blip-1',
    angle: 24,
    radius: 0.82,
    risk: 'critical',
    label: 'Nature 2023 · 钙钛矿钝化',
    detail: '已命中撤稿库：图像复用（Fig. 3b 与 Fig. 5a）',
    weight: 1.4,
  },
  {
    id: 'blip-2',
    angle: 68,
    radius: 0.54,
    risk: 'caution',
    label: 'Adv. Mater. 2024 · 界面工程',
    detail: '预印本，尚未同行评议；自引率 31%',
    weight: 1.1,
  },
  {
    id: 'blip-3',
    angle: 112,
    radius: 0.31,
    risk: 'safe',
    label: 'Science 2022 · 缺陷钝化机理',
    detail: 'Level A · 双库交叉验证通过',
  },
  {
    id: 'blip-4',
    angle: 155,
    radius: 0.93,
    risk: 'critical',
    label: 'JACS 2021 · 载流子寿命',
    detail: '勘误声明：表 2 数据整列更正',
    weight: 1.3,
  },
  {
    id: 'blip-5',
    angle: 203,
    radius: 0.47,
    risk: 'safe',
    label: 'PRL 2020 · 光谱拟合',
    detail: 'Level A · 原始数据可复现',
  },
  {
    id: 'blip-6',
    angle: 246,
    radius: 0.68,
    risk: 'caution',
    label: 'Chem. Rev. 2019 · 综述',
    detail: '二手引文，未回溯一手数据',
  },
  {
    id: 'blip-7',
    angle: 291,
    radius: 0.22,
    risk: 'safe',
    label: 'Nano Lett. 2024 · 稳定性',
    detail: 'Level A · 与实验记录一致',
  },
  {
    id: 'blip-8',
    angle: 335,
    radius: 0.77,
    risk: 'caution',
    label: 'arXiv 2501.xxxxx · 预印本',
    detail: '仅预印本，作者未回应数据请求',
  },
] satisfies readonly SonarBlip[];

/* -------------------------------------------------------------------------- */
/* PrecisionBalance · 16 站「云衡 · 数字天平综测核算器」                        */
/* -------------------------------------------------------------------------- */

export const BALANCE_PANS = [
  {
    id: 'pan-moral',
    label: '德育',
    value: 82,
    capacity: 100,
    accent: 'indigo',
    hint: '课程思政 ×1.0 · 志愿服务 ×0.6',
    weights: [
      { id: 'w1', label: '思政课', mass: 0.42 },
      { id: 'w2', label: '志愿服务', mass: 0.26 },
      { id: 'w3', label: '荣誉表彰', mass: 0.14 },
    ],
  },
  {
    id: 'pan-intellect',
    label: '智育',
    value: 91.4,
    capacity: 100,
    accent: 'cyan',
    hint: '必修加权 ×0.75 · 选修边际 ×0.25',
    weights: [
      { id: 'w4', label: '必修加权', mass: 0.55 },
      { id: 'w5', label: '学科竞赛', mass: 0.22 },
      { id: 'w6', label: '论文', mass: 0.14 },
    ],
  },
  {
    id: 'pan-research',
    label: '科研双创',
    value: 64.5,
    capacity: 100,
    accent: 'emerald',
    hint: '大创结题 ×1.5 · 软著 ×0.8',
    weights: [
      { id: 'w7', label: '大创结题', mass: 0.38 },
      { id: 'w8', label: '软著', mass: 0.17 },
      { id: 'w9', label: '专利受理', mass: 0.09 },
    ],
  },
] satisfies readonly BalancePan[];

/* -------------------------------------------------------------------------- */
/* FluidGaugeBank · 03 站「大创五科目经费液位仪」                               */
/* -------------------------------------------------------------------------- */

/**
 * 五科目预算合计 = ¥20,000（国创标准额度）。
 * 劳务费一栏**故意越线**，用来演示红线阻断动效与 aria-live 断言。
 */
export const GAUGE_COLUMNS = [
  {
    id: 'col-labor',
    label: '劳务费',
    value: 3760,
    capacity: 4000,
    redline: 0.9,
    unit: '¥',
    accent: 'rose',
    hint: '占总预算 ≤20%（¥4,000 硬上限）',
  },
  {
    id: 'col-hardware',
    label: '硬件设备',
    value: 4120,
    capacity: 6000,
    redline: 0.95,
    unit: '¥',
    hint: '采购需附三方比价单',
  },
  {
    id: 'col-compute',
    label: '算力租用',
    value: 2980,
    capacity: 4000,
    redline: 0.9,
    unit: '¥',
    hint: 'GPU 机时，按月结算',
  },
  {
    id: 'col-ip',
    label: '软著与出版',
    value: 1860,
    capacity: 3000,
    redline: 0.85,
    unit: '¥',
    hint: '版面费需录用通知',
  },
  {
    id: 'col-travel',
    label: '差旅会议',
    value: 1240,
    capacity: 3000,
    redline: 0.8,
    unit: '¥',
    hint: '需会议邀请函 + 行程单',
  },
] satisfies readonly GaugeColumn[];

/* -------------------------------------------------------------------------- */
/* EvidenceLink · 09 站「Matrix-Cross 跨论文对比矩阵」                          */
/* -------------------------------------------------------------------------- */

export const EVIDENCE_ANCHORS = [
  {
    sourceDoiOrUrl: '10.1038/s41586-023-06214-1',
    pdfPage: 7,
    bbox: [72.5, 118.4, 372.9, 146.2] as const,
    verificationLevel: 'Level_A_Verified',
    note: 'Fig. 3b · 人工复核 2026-10-12',
  },
  {
    sourceDoiOrUrl: '10.1002/adma.202401887',
    pdfPage: 3,
    bbox: [64.0, 402.1, 331.6, 428.7] as const,
    verificationLevel: 'Level_B_Preprint',
    note: '预印本源，等待正式见刊',
  },
  {
    sourceDoiOrUrl: '10.1021/jacs.1c04412',
    pdfPage: 11,
    bbox: [88.2, 512.0, 402.4, 539.5] as const,
    verificationLevel: 'Retracted_Warning',
    note: '勘误声明 · 表 2 数据整列更正',
  },
] satisfies readonly EvidenceAnchor[];

/* -------------------------------------------------------------------------- */
/* StarOrbit · 数据取自 specs/microsites.json 的真实花名册                      */
/* -------------------------------------------------------------------------- */

export const ORBIT_STATIONS = [
  {
    id: 'st-11',
    name: 'CurveLab 非线性拟合示波器',
    orbit: 1,
    stationId: '11',
    domain: 'curvelab.matrixos.edu',
    uiStyle: '荧光示波器与阻尼旋钮',
    accent: 'cyan',
    state: 'live',
    preview: { kind: 'sparkline', data: [12, 18, 15, 24, 31, 28, 36, 41] },
  },
  {
    id: 'st-09',
    name: 'Matrix-Cross 跨论文对比矩阵',
    orbit: 2,
    stationId: '09',
    domain: 'matrix-cross.matrixos.edu',
    uiStyle: '激光溯源对比网格',
    accent: 'indigo',
    state: 'active',
    preview: { kind: 'matrix', data: [1, 0, 1, 1, 0, 1] },
  },
  {
    id: 'st-15',
    name: '撤稿深海声呐与伦理合规仪',
    orbit: 3,
    stationId: '15',
    domain: 'retract-radar.matrixos.edu',
    uiStyle: '360° 极坐标声呐盘',
    accent: 'rose',
    state: 'live',
    preview: { kind: 'radar', data: [3, 5, 2, 4, 1] },
  },
  {
    id: 'st-16',
    name: '云衡 · 数字天平综测核算器',
    orbit: 4,
    stationId: '16',
    domain: 'yunheng.matrixos.edu',
    uiStyle: '精密三盘电子天平',
    accent: 'amber',
    state: 'active',
    preview: { kind: 'bars', data: [82, 91, 65] },
  },
  {
    id: 'st-08',
    name: '太空任务式进组跟进台账',
    orbit: 5,
    stationId: '08',
    domain: 'lab-kanban.matrixos.edu',
    uiStyle: '航天任务控制看板',
    accent: 'emerald',
    state: 'active',
    preview: { kind: 'bars', data: [4, 2, 1] },
  },
  {
    id: 'st-18',
    name: '生涯多重宇宙期望决策树',
    orbit: 6,
    stationId: '18',
    domain: 'prejob.matrixos.edu',
    uiStyle: '量子分岔概率光轨沙盘',
    accent: 'violet',
    state: 'idle',
    preview: { kind: 'sparkline', data: [8, 14, 11, 19, 26] },
  },
  {
    id: 'st-03',
    name: '大创五科目经费液位仪',
    orbit: 7,
    stationId: '03',
    domain: 'grant-audit.matrixos.edu',
    uiStyle: '五柱流体压差计',
    accent: 'rose',
    state: 'offline',
  },
] satisfies readonly StarOrbitStation[];

/* -------------------------------------------------------------------------- */
/* WormholeRing · 跨站投送目标                                                  */
/* -------------------------------------------------------------------------- */

export const WORMHOLE_TARGETS = [
  {
    id: 'target-mentor',
    name: '星门 · 导师五维星象仪',
    domain: 'mentor.matrixos.edu',
    accent: 'violet',
    accepts: ['curve_fit_parameters', 'evidence_bundle'],
  },
  {
    id: 'target-cv',
    name: '区块链级学术证据简历工坊',
    domain: 'evidence-cv.matrixos.edu',
    accent: 'emerald',
    accepts: ['evidence_bundle'],
  },
  {
    id: 'target-cross',
    name: 'Matrix-Cross 对比矩阵',
    domain: 'matrix-cross.matrixos.edu',
    accent: 'indigo',
    accepts: ['curve_fit_parameters'],
  },
  {
    id: 'target-review',
    name: '综述拓扑推演写作舱',
    domain: 'review-lab.matrixos.edu',
    accent: 'cyan',
    accepts: ['evidence_bundle'],
  },
] satisfies readonly WormholeTarget[];

/* -------------------------------------------------------------------------- */
/* TaskKanban · 08 站「太空任务式进组跟进台账」                                 */
/* -------------------------------------------------------------------------- */

export const KANBAN_COLUMNS = [
  { id: 'drafting', title: '待寄箱', subtitle: 'Drafting · Searching', accent: 'indigo', wipLimit: 4 },
  { id: 'transit', title: '已发信', subtitle: 'Transit · Awaiting', accent: 'amber', wipLimit: 6 },
  { id: 'read', title: '已读', subtitle: 'Read · Follow-up', accent: 'cyan' },
  { id: 'interview', title: '待面试', subtitle: 'Interview · Scheduled', accent: 'violet' },
  { id: 'joined', title: '已进组', subtitle: 'Joined · Archive', accent: 'emerald', locked: true },
] satisfies readonly KanbanColumn[];

export const KANBAN_TASKS = [
  {
    id: 'task-1',
    title: '张教授 · 钙钛矿钝化',
    summary: '引用其 2023 Nature 子刊，附 τ₁ 拟合曲线',
    columnId: 'drafting',
    accent: 'indigo',
    priority: 'P0',
    tags: ['钙钛矿', '钝化'],
    progress: 0.35,
    assignee: 'ZL',
  },
  {
    id: 'task-2',
    title: '李研究员 · 界面工程',
    summary: '缺证据锚点，已阻断发送',
    columnId: 'drafting',
    accent: 'rose',
    priority: 'P1',
    tags: ['界面'],
    blocked: true,
    blockedReason: '3 个参量无 DOI 锚点',
    assignee: 'WM',
  },
  {
    id: 'task-3',
    title: '王老师 · 光谱拟合',
    summary: '已附 CurveLab 拟合报告与 95% 置信带',
    columnId: 'transit',
    accent: 'amber',
    priority: 'P1',
    tags: ['拟合', '光谱'],
    progress: 0.6,
    assignee: 'ZL',
    due: '2026-10-24',
  },
  {
    id: 'task-4',
    title: '陈教授 · 载流子寿命',
    summary: '对方已读，等待补充原始数据',
    columnId: 'read',
    accent: 'cyan',
    priority: 'P2',
    assignee: 'WM',
  },
  {
    id: 'task-5',
    title: '周课题组 · 稳定性测试',
    summary: '周五 15:00 线上面试',
    columnId: 'interview',
    accent: 'violet',
    priority: 'P0',
    window: '周五 15:00 面试',
    progress: 0.85,
    assignee: 'ZL',
  },
] satisfies readonly KanbanTask[];
