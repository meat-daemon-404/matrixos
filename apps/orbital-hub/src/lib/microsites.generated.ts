/**
 * ⚠️ 自动生成 · 请勿手改
 * 生成命令：pnpm gen:site --emit-registry
 * 唯一事实源：specs/microsites.json（花名册）+ docs/01-plan/00-adr-001-microsite-numbering.md（目录命名）
 * 源文件校验和（sha256 前 16 位）：dc810a51575b0849
 *
 * 为什么不用 `import spec from '../../../../specs/microsites.json'`：
 * Next 的模块图以 app 目录为根，跨出仓库根去引 JSON 会踩 outputFileTracingRoot 与
 * externalDir 的边界；把花名册编译成类型安全的 TS 常量更稳，且能在这里一次性
 * 把 `orbitName` 解析成轨道索引/枚举/强调色，hub 侧不再做字符串解析。
 */

export type OrbitKey =
  | 'study'
  | 'spark'
  | 'pat_hot'
  | 'xingmen'
  | 'workshop'
  | 'cloud_balance'
  | 'pre_job';

export type PayloadType =
  | 'paper_doi_bundle'
  | 'comparison_matrix_row'
  | 'curve_fit_parameters'
  | 'mentor_match_card'
  | 'verified_cv_evidence';

export interface MicrositeStation {
  readonly id: string;
  /** 域名前缀，等于 manifest 的 app_id */
  readonly appId: string;
  /** ADR-001 目录名 */
  readonly dirName: string;
  readonly pkgName: string;
  readonly name: string;
  readonly domain: string;
  /** 开发端口：3010 + (id - 1) */
  readonly devPort: number;
  /** 1..7 */
  readonly orbitIndex: number;
  readonly orbitKey: OrbitKey;
  readonly orbitName: string;
  /** 花名册的 orbit 分组：1-2 / 3-4 / 5 / 6-7 */
  readonly orbitGroup: string;
  readonly accent: string;
  readonly uiStyle: string;
  readonly ledger: string;
  readonly desc: string;
  readonly source: string;
  readonly accepts: readonly PayloadType[];
  readonly emits: readonly PayloadType[];
}

export interface OrbitMeta {
  readonly index: number;
  readonly key: OrbitKey;
  readonly label: string;
  readonly accent: string;
  readonly stationCount: number;
}

export const STATIONS: readonly MicrositeStation[] = [
  {
    id: "01",
    appId: "gpa",
    dirName: "01-gpa-sandbox",
    pkgName: "@matrixos/microsite-01-gpa-sandbox",
    name: "学分绩点动态配重台",
    domain: "gpa.matrixos.cc.cd",
    devPort: 3010,
    orbitIndex: 1,
    orbitKey: "study",
    orbitName: "轨道 1 · 学阶",
    orbitGroup: "1-2",
    accent: "#6366f1",
    uiStyle: "精密推子配重仪",
    ledger: "学期目标绩点与选课博弈方案库",
    desc: "拖动推子模拟不同选修课成绩对保研/出国核心 GPA 的边际贡献。",
    source: "ScholarMatrix 拆解",
    accepts: ["verified_cv_evidence"],
    emits: ["verified_cv_evidence"],
  },
  {
    id: "02",
    appId: "spark",
    dirName: "02-spark-teaming",
    pkgName: "@matrixos/microsite-02-spark-teaming",
    name: "双创互补组队雷达",
    domain: "spark.matrixos.cc.cd",
    devPort: 3011,
    orbitIndex: 2,
    orbitKey: "spark",
    orbitName: "轨道 2 · 星火",
    orbitGroup: "1-2",
    accent: "#8b5cf6",
    uiStyle: "技能极坐标互补盘",
    ledger: "大创/挑战杯组队契约与分工表",
    desc: "匹配跨院系（硬件+算法+商业）互补队友并自动生成大创申报书初稿。",
    source: "ScholarMatrix 拆解",
    accepts: ["verified_cv_evidence"],
    emits: ["verified_cv_evidence"],
  },
  {
    id: "03",
    appId: "grant-audit",
    dirName: "03-grant-audit",
    pkgName: "@matrixos/microsite-03-grant-audit",
    name: "大创五科目经费液位仪",
    domain: "grant-audit.matrixos.cc.cd",
    devPort: 3012,
    orbitIndex: 2,
    orbitKey: "spark",
    orbitName: "轨道 2 · 星火",
    orbitGroup: "1-2",
    accent: "#8b5cf6",
    uiStyle: "五柱流体压差计",
    ledger: "国创 ¥20,000 报销凭据与红线台账",
    desc: "内置劳务费 ≤20% 硬件限位阀，实时监控算力、软著、差旅报销进度。",
    source: "MatrixOS 原创",
    accepts: ["paper_doi_bundle"],
    emits: ["verified_cv_evidence"],
  },
  {
    id: "04",
    appId: "pat-hot",
    dirName: "04-pat-radar",
    pkgName: "@matrixos/microsite-04-pat-radar",
    name: "PAT-HOT 学科脉冲雷达",
    domain: "pat-hot.matrixos.cc.cd",
    devPort: 3013,
    orbitIndex: 3,
    orbitKey: "pat_hot",
    orbitName: "轨道 3 · 情报",
    orbitGroup: "3-4",
    accent: "#f59e0b",
    uiStyle: "24h 频谱瀑布流",
    ledger: "订阅学科关键词与早报历史库",
    desc: "监听 arXiv / Nature Photonics 24h 前沿动态，每日 08:00 推送三卡早报。",
    source: "PAT-HOT 实机原型",
    accepts: ["paper_doi_bundle"],
    emits: ["paper_doi_bundle"],
  },
  {
    id: "05",
    appId: "lit-sonar",
    dirName: "05-lit-sonar",
    pkgName: "@matrixos/microsite-05-lit-sonar",
    name: "五源跨库引文声呐站",
    domain: "lit-sonar.matrixos.cc.cd",
    devPort: 3014,
    orbitIndex: 3,
    orbitKey: "pat_hot",
    orbitName: "轨道 3 · 情报",
    orbitGroup: "3-4",
    accent: "#f59e0b",
    uiStyle: "引力透镜拓扑图",
    ledger: "课题组专题文献收藏夹与引文树",
    desc: "聚合 OpenAlex/arXiv/PubMed/Crossref，可视化呈现开山鼻祖与最新演进。",
    source: "ScholarMatrix 拆解",
    accepts: ["paper_doi_bundle"],
    emits: ["paper_doi_bundle"],
  },
  {
    id: "06",
    appId: "mentor",
    dirName: "06-xingmen-mentor",
    pkgName: "@matrixos/microsite-06-xingmen-mentor",
    name: "星门 · 导师五维星象仪",
    domain: "mentor.matrixos.cc.cd",
    devPort: 3015,
    orbitIndex: 4,
    orbitKey: "xingmen",
    orbitName: "轨道 4 · 星门",
    orbitGroup: "3-4",
    accent: "#06b6d4",
    uiStyle: "天文星象五维雷达",
    ledger: "目标博导/硕导全景学术画像库",
    desc: "量化分析导师近 3 年活跃度、H-index 斜率、经费充足度与本科生友好度。",
    source: "星门 实机原型",
    accepts: ["paper_doi_bundle","curve_fit_parameters"],
    emits: ["mentor_match_card"],
  },
  {
    id: "07",
    appId: "cold-email",
    dirName: "07-cold-email-lab",
    pkgName: "@matrixos/microsite-07-cold-email-lab",
    name: "证据内嵌式套磁信推演器",
    domain: "cold-email.matrixos.cc.cd",
    devPort: 3016,
    orbitIndex: 4,
    orbitKey: "xingmen",
    orbitName: "轨道 4 · 星门",
    orbitGroup: "3-4",
    accent: "#06b6d4",
    uiStyle: "双栏红蓝对抗推演器",
    ledger: "多版本套磁信草稿与导师审阅评分",
    desc: "结合导师最新代表作与学生复现实验数据，生成高回复率个性化套磁信。",
    source: "星门 实机原型",
    accepts: ["mentor_match_card","curve_fit_parameters"],
    emits: ["mentor_match_card"],
  },
  {
    id: "08",
    appId: "lab-kanban",
    dirName: "08-lab-kanban",
    pkgName: "@matrixos/microsite-08-lab-kanban",
    name: "太空任务式进组跟进台账",
    domain: "lab-kanban.matrixos.cc.cd",
    devPort: 3017,
    orbitIndex: 4,
    orbitKey: "xingmen",
    orbitName: "轨道 4 · 星门",
    orbitGroup: "3-4",
    accent: "#06b6d4",
    uiStyle: "航天任务控制看板",
    ledger: "已发信→已读→待面试→已进组状态机",
    desc: "全周期追踪套磁与暑研面试节点，支持一键同步至手机端强提醒。",
    source: "星门 实机原型",
    accepts: ["mentor_match_card"],
    emits: ["verified_cv_evidence"],
  },
  {
    id: "09",
    appId: "matrix-cross",
    dirName: "09-matrix-cross",
    pkgName: "@matrixos/microsite-09-matrix-cross",
    name: "Matrix-Cross 跨论文对比矩阵",
    domain: "matrix-cross.matrixos.cc.cd",
    devPort: 3018,
    orbitIndex: 5,
    orbitKey: "workshop",
    orbitName: "轨道 5 · 工坊",
    orbitGroup: "5",
    accent: "#10b981",
    uiStyle: "激光溯源对比网格",
    ledger: "多篇顶刊核心实验参量横向对比表",
    desc: "自动抽取多篇 PDF 的材料、方法与性能指标，悬停单元格激射 PDF 原文坐标。",
    source: "ScholarMatrix 核心",
    accepts: ["paper_doi_bundle"],
    emits: ["comparison_matrix_row"],
  },
  {
    id: "10",
    appId: "pdf-sniper",
    dirName: "10-pdf-sniper",
    pkgName: "@matrixos/microsite-10-pdf-sniper",
    name: "PDF 公式与参量狙击镜",
    domain: "pdf-sniper.matrixos.cc.cd",
    devPort: 3019,
    orbitIndex: 5,
    orbitKey: "workshop",
    orbitName: "轨道 5 · 工坊",
    orbitGroup: "5",
    accent: "#10b981",
    uiStyle: "双栏光学瞄准阅读器",
    ledger: "高亮批注、公式符号表与难例卡片",
    desc: "点击文内复杂偏微分方程，右侧自动展开物理量纲解释与 Python 求解代码。",
    source: "ScholarMatrix 拆解",
    accepts: ["paper_doi_bundle"],
    emits: ["comparison_matrix_row"],
  },
  {
    id: "11",
    appId: "curvelab",
    dirName: "11-curvelab-fit",
    pkgName: "@matrixos/microsite-11-curvelab-fit",
    name: "CurveLab 非线性拟合示波器",
    domain: "curvelab.matrixos.cc.cd",
    devPort: 3020,
    orbitIndex: 5,
    orbitKey: "workshop",
    orbitName: "轨道 5 · 工坊",
    orbitGroup: "5",
    accent: "#10b981",
    uiStyle: "荧光示波器与阻尼旋钮",
    ledger: "实验原始数据集与 30+ 回归模型库",
    desc: "内置双指数衰减、洛伦兹峰拟合等 30+ 统计模型，实时显示置信带与 R²。",
    source: "ScholarMatrix 核心",
    accepts: ["comparison_matrix_row"],
    emits: ["curve_fit_parameters"],
  },
  {
    id: "12",
    appId: "repro-check",
    dirName: "12-repro-check",
    pkgName: "@matrixos/microsite-12-repro-check",
    name: "顶刊代码复现核验舱",
    domain: "repro-check.matrixos.cc.cd",
    devPort: 3021,
    orbitIndex: 5,
    orbitKey: "workshop",
    orbitName: "轨道 5 · 工坊",
    orbitGroup: "5",
    accent: "#10b981",
    uiStyle: "飞行前机械检查单",
    ledger: "依赖环境、随机种子与超参复现清单",
    desc: "自动扫描论文关联 GitHub 仓库，生成 Docker 环境配置与复现避坑指南。",
    source: "ScholarMatrix 拆解",
    accepts: ["paper_doi_bundle","curve_fit_parameters"],
    emits: ["paper_doi_bundle"],
  },
  {
    id: "13",
    appId: "chart-foundry",
    dirName: "13-chart-foundry",
    pkgName: "@matrixos/microsite-13-chart-foundry",
    name: "Nature 级出版图表熔炉",
    domain: "chart-foundry.matrixos.cc.cd",
    devPort: 3022,
    orbitIndex: 5,
    orbitKey: "workshop",
    orbitName: "轨道 5 · 工坊",
    orbitGroup: "5",
    accent: "#10b981",
    uiStyle: "光学暗房调色台",
    ledger: "TikZ / Matplotlib 出版级绘图脚本库",
    desc: "一键将拟合数据转换为符合 Nature / IEEE 双栏字号与色盲友好规范的矢量图。",
    source: "ScholarMatrix 拆解",
    accepts: ["curve_fit_parameters","comparison_matrix_row"],
    emits: ["comparison_matrix_row"],
  },
  {
    id: "14",
    appId: "review-lab",
    dirName: "14-review-architect",
    pkgName: "@matrixos/microsite-14-review-architect",
    name: "综述拓扑推演与写作舱",
    domain: "review-lab.matrixos.cc.cd",
    devPort: 3023,
    orbitIndex: 5,
    orbitKey: "workshop",
    orbitName: "轨道 5 · 工坊",
    orbitGroup: "5",
    accent: "#10b981",
    uiStyle: "章节逻辑流建筑台",
    ledger: "文献综述大纲与段落证据绑定库",
    desc: "将对比矩阵中的多篇文献按技术流派自动聚类，生成带精准引文的综述初稿。",
    source: "ScholarMatrix 拆解",
    accepts: ["paper_doi_bundle","comparison_matrix_row"],
    emits: ["paper_doi_bundle"],
  },
  {
    id: "15",
    appId: "retract-radar",
    dirName: "15-retract-radar",
    pkgName: "@matrixos/microsite-15-retract-radar",
    name: "撤稿深海声呐与伦理合规仪",
    domain: "retract-radar.matrixos.cc.cd",
    devPort: 3024,
    orbitIndex: 5,
    orbitKey: "workshop",
    orbitName: "轨道 5 · 工坊",
    orbitGroup: "5",
    accent: "#10b981",
    uiStyle: "360° 极坐标声呐盘",
    ledger: "论文引文合规体检报告与伦理声明",
    desc: "对接 Crossref 与 PubPeer 排查撤稿与勘误引文，自动生成顶刊 AI 使用披露声明。",
    source: "ScholarMatrix 拆解",
    accepts: ["paper_doi_bundle"],
    emits: ["paper_doi_bundle"],
  },
  {
    id: "16",
    appId: "yunheng",
    dirName: "16-yunheng-scale",
    pkgName: "@matrixos/microsite-16-yunheng-scale",
    name: "云衡 · 数字天平综测核算器",
    domain: "yunheng.matrixos.cc.cd",
    devPort: 3025,
    orbitIndex: 6,
    orbitKey: "cloud_balance",
    orbitName: "轨道 6 · 云衡",
    orbitGroup: "6-7",
    accent: "#22d3ee",
    uiStyle: "精密三盘电子天平",
    ledger: "学年综测加分项与证明材料 PDF 包",
    desc: "自动汇总科研论文、软著与竞赛记录，按高校综测细则满额配重并导出申报表。",
    source: "预职 & ScholarMatrix",
    accepts: ["paper_doi_bundle","verified_cv_evidence"],
    emits: ["verified_cv_evidence"],
  },
  {
    id: "17",
    appId: "evidence-cv",
    dirName: "17-evidence-cv",
    pkgName: "@matrixos/microsite-17-evidence-cv",
    name: "区块链级学术证据简历工坊",
    domain: "evidence-cv.matrixos.cc.cd",
    devPort: 3026,
    orbitIndex: 7,
    orbitKey: "pre_job",
    orbitName: "轨道 7 · 预职",
    orbitGroup: "6-7",
    accent: "#f43f5e",
    uiStyle: "绿标验真数字徽章台",
    ledger: "多版本保研/求职证据级简历库",
    desc: "简历中每一条科研经历均嵌入可点击验真的 DOI 锚点、拟合图与代码仓库哈希。",
    source: "预职 WorkBuddy 原型",
    accepts: ["paper_doi_bundle","comparison_matrix_row","curve_fit_parameters","mentor_match_card","verified_cv_evidence"],
    emits: ["verified_cv_evidence"],
  },
  {
    id: "18",
    appId: "prejob",
    dirName: "18-prejob-multiverse",
    pkgName: "@matrixos/microsite-18-prejob-multiverse",
    name: "生涯多重宇宙期望决策树",
    domain: "prejob.matrixos.cc.cd",
    devPort: 3027,
    orbitIndex: 7,
    orbitKey: "pre_job",
    orbitName: "轨道 7 · 预职",
    orbitGroup: "6-7",
    accent: "#f43f5e",
    uiStyle: "量子分岔概率光轨沙盘",
    ledger: "保研直博 / 选调考公 / 大厂 Offer 对比树",
    desc: "基于全息数字孪生底座，量化推演不同生涯路径未来 5 年的期望收益与风险。",
    source: "预职 WorkBuddy 原型",
    accepts: ["verified_cv_evidence"],
    emits: ["verified_cv_evidence"],
  },
] as const;

export const ORBITS: readonly OrbitMeta[] = [
  { index: 1, key: "study", label: "轨道 1 · 学阶", accent: "#6366f1", stationCount: 1 },
  { index: 2, key: "spark", label: "轨道 2 · 星火", accent: "#8b5cf6", stationCount: 2 },
  { index: 3, key: "pat_hot", label: "轨道 3 · 情报", accent: "#f59e0b", stationCount: 2 },
  { index: 4, key: "xingmen", label: "轨道 4 · 星门", accent: "#06b6d4", stationCount: 3 },
  { index: 5, key: "workshop", label: "轨道 5 · 工坊", accent: "#10b981", stationCount: 7 },
  { index: 6, key: "cloud_balance", label: "轨道 6 · 云衡", accent: "#22d3ee", stationCount: 1 },
  { index: 7, key: "pre_job", label: "轨道 7 · 预职", accent: "#f43f5e", stationCount: 2 },
] as const;

export const STATION_BY_ID: Readonly<Record<string, MicrositeStation>> = STATIONS.reduce(
  (acc, station) => {
    acc[station.id] = station;
    return acc;
  },
  {} as Record<string, MicrositeStation>,
);

export const STATIONS_BY_ORBIT: Readonly<Record<number, readonly MicrositeStation[]>> = ORBITS.reduce(
  (acc, orbit) => {
    acc[orbit.index] = STATIONS.filter((station) => station.orbitIndex === orbit.index);
    return acc;
  },
  {} as Record<number, readonly MicrositeStation[]>,
);

/** 轨道分布必须是 3 / 5 / 7 / 3（架构 §2.1 落地规则 4）；生成期已校验，这里留一道运行时断言。 */
export const ORBIT_GROUP_DISTRIBUTION: Readonly<Record<string, number>> = STATIONS.reduce(
  (acc, station) => {
    acc[station.orbitGroup] = (acc[station.orbitGroup] ?? 0) + 1;
    return acc;
  },
  {} as Record<string, number>,
);
