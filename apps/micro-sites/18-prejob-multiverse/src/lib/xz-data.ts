/**
 * 学职平台数据集访问层。
 *
 * 数据来源：https://xz.chsi.com.cn（学职平台，教育部学生服务与素质发展中心）
 * 采集与精简：见 .tmp/xz-crawl/coverage.md，构建脚本 .tmp/fleet-recon/build-dataset.mjs
 *
 * 这里只做「读 + 类型 + 检索」，不含任何网络请求 —— 数据在构建期就以 JSON 静态落地，
 * 因此本模块在 next dev / next build / 静态导出（output: export）三种模式下行为一致。
 *
 * 合规：职业案例正文受原站登录墙保护，本数据集只含公开列表里的一句话履历摘要；
 * 专业介绍等长文本著作权归原站。所有消费方必须展示来源并链回原站（见 XZ_META.notice）。
 */
import casesJson from './xz-data/xz-cases.json';
import caseStatsJson from './xz-data/xz-case-stats.json';
import occTreeJson from './xz-data/xz-occupation-tree.json';
import specsJson from './xz-data/xz-specialities.json';
import specStatsJson from './xz-data/xz-spec-stats.json';
import topicsJson from './xz-data/xz-topics.json';
import assessmentsJson from './xz-data/xz-assessments.json';
import videoIndexJson from './xz-data/xz-video-index.json';
import metaJson from './xz-data/xz-meta.json';

/**
 * 职业 zhiyId → 微视频。JSON 形如 { map: Record<zhiyId, {...> }，
 * 外层还带 source/note 等溯源字段（见 build-dataset.mjs 的 buildVideoIndex）。
 * 类型声明推迟到 XzOccupationVideo 之后，这里先按结构取 map。
 */
const VIDEO_MAP: Record<string, { videoId: string; title: string; duration: string | null; praise: number }> = (
  videoIndexJson as unknown as {
    map: Record<string, { videoId: string; title: string; duration: string | null; praise: number }>;
  }
).map;

/* ── 类型 ─────────────────────────────────────────────────────────────── */

export interface XzCase {
  readonly id: string;
  /** 一句话履历：姓名届次 + 毕业院校 + 专业 + 现单位职务（已去 HTML） */
  readonly summary: string;
  /** 现职岗位描述 */
  readonly role: string;
  readonly industryId: string | null;
  readonly industry: string | null;
  readonly groupId: string | null;
  readonly group: string | null;
  readonly province: string | null;
  readonly provinceCode: string | null;
  readonly likes: number;
  readonly collects: number;
  readonly recommended: boolean;
  readonly picId: string | null;
  /**
   * 原站未文档化的枚举整数，语义未知。刻意保留原值、不做猜测映射。
   * 见 coverage.md「已知脏点」。
   */
  readonly rawTypes: {
    readonly gznxType: number | null;
    readonly xlccType: number | null;
    readonly zwcjType: number | null;
  };
}

export interface XzSatisfaction {
  readonly rank: number;
  readonly count: number;
}

export interface XzCourse {
  readonly name: string;
  readonly type: number | null;
  readonly difficulty: number | null;
  readonly practicality: number | null;
  /**
   * 热度投票量 = 原站 diffTotal + praTotal。
   * ⚠️ 不是原站的 `vote` 字段 —— 那个是布尔「我是否投过票」。
   */
  readonly votes: number;
}

/** 学长学姐建议（原站 xdxmSuggestList，真实形状 {advice, school, year}）。 */
export interface XzJuniorAdvice {
  readonly advice: string;
  readonly school: string | null;
  readonly year: number | null;
}

/**
 * 轻 detail —— 列表与摘要够用，随主数据集一起加载。
 */
export interface XzSpecLightDetail {
  readonly gradScale: string | null;
  readonly year: number | null;
  readonly gender: { readonly boy: number; readonly girl: number } | null;
  readonly satisfaction: {
    readonly overall: XzSatisfaction | null;
    readonly condition: XzSatisfaction | null;
    readonly teaching: XzSatisfaction | null;
    readonly employment: XzSatisfaction | null;
  };
  readonly schoolTypes: readonly string[];
  readonly offerCount: number | null;
}

/**
 * 重 detail —— 长文本，单独文件 + 按需加载。
 *
 * 为什么拆：全量 1778 条详情让主数据集涨到 3.1MB、微站路由涨到 838KB（gzip 前）。
 * 列表页根本用不到 intro/courses/juniorAdvice 这些长文本，点开详情才需要，
 * 所以让它们落在 xz-spec-details.json，由 useSpecHeavyDetail 异步取用。
 */
/**
 * 毕业生真实去向 —— 决策树的对照数据。
 *
 * ⚠️ 语义红线：`paths.考研 = 7` 表示「该专业 **7% 的毕业生选择了考研**」，
 * 是**去向占比**，不是「考研成功率 7%」。决策树的 `probabilities.success`
 * 是模型对成功概率的估计，两者含义不同，**不可相乘、平均或互相替换**，
 * 只能并排展示供用户自己对照。
 */
export interface XzFlow {
  /** 职业流向 top6，按占比降序 */
  readonly occTop?: readonly {
    readonly name: string;
    readonly pct: number;
    /** 可接职业分类树；原站部分职业该字段为空，故为 null */
    readonly zhiyId: string | null;
  }[];
  /**
   * 路径型去向占比（白名单：考研 / 公务员 / 事业单位人员 / 出国 / 参军）。
   * 键为原站原文，不做翻译或归并。
   */
  readonly paths?: Readonly<Record<string, number>>;
  /** 升学方向（可报考的研究生学科） */
  readonly advances?: readonly { readonly name: string; readonly code: string | null }[];
  /** 从业行业分布（原站只给名字列表，无占比） */
  readonly industries?: readonly string[];
}

export interface XzSpecHeavyDetail {
  readonly intro: string;
  readonly direction: string;
  readonly courses: readonly XzCourse[];
  readonly related: readonly string[];
  /**
   * 学长学姐经验话（原站 `xdxmSuggestList` =「向学弟学妹建议」）。
   * 注意这**不是**毕业去向 —— 是某院校某届学生留下的一句建议。
   */
  readonly juniorAdvice: readonly XzJuniorAdvice[];
  /**
   * 毕业去向统计。仅 741/1778 个专业有（冷门专业原站无此数据），
   * 缺失时 UI 应显示「原站无该数据」而不是 0 或空列表。
   */
  readonly flow?: XzFlow;
}

/** 合并视图 —— 已同时拿到轻与重字段的调用方用这个。 */
export type XzSpecDetail = XzSpecLightDetail & XzSpecHeavyDetail;

/*
 * 重 detail 不在这里 import。
 *
 * 之前这里有一句 `import heavyDetailJson from './xz-data/xz-spec-details.json'`
 * 加一个同步查表函数 —— 那 539 KB gzip 就被 webpack 打进了主 chunk，
 * 让路由涨到 833 kB。现在改由 lib/use-heavy-detail.ts 用字面量 `import()`
 * 切成独立异步 chunk，只在用户展开详情时才下载。
 *
 * 类型 XzSpecHeavyDetail 仍在本文件导出：它只是类型，编译期即擦除，不进 bundle。
 */

export interface XzSpeciality {
  readonly specId: string;
  readonly code: string;
  readonly name: string;
  /** 门类代码，如 105012。注意原站 ml 是代码、xk 是名字，两者不对称 */
  readonly facultyCode: string;
  readonly faculty: string;
  readonly category: string;
  readonly level: string;
  readonly rankPopularity: number;
  readonly rankRecommended: number | null;
  readonly evlCount: number;
  readonly evlScore: number | null;
  /**
   * 轻 detail（满意度/规模/院校数）。长文本见 useSpecHeavyDetail。
   * undefined = 该专业未采集任何详情。
   */
  readonly detail?: XzSpecLightDetail;
}

export interface XzOccupationGroup {
  readonly ktId: string;
  readonly ktName: string;
  /**
   * 原站 /occupation 导航树里的叫法。
   * 与 ktName 不同时，说明**原站自身**两个接口对同一 ktId 给了不同名字
   * （实测 3 处，如 KTHZID_20210121 案例侧「公共服务类」/ 导航树「社会服务类」）。
   * 两个名字都保留，不取舍 —— 这不是采集错误。
   */
  readonly officialName?: string | null;
  readonly officialIndustry?: string | null;
  readonly occupations: readonly { readonly id: string; readonly name: string }[];
}

/**
 * 职业 → 微视频索引，键是原站 zhiyId。
 *
 * 为什么能按 id 连而不是按名字猜：视频「中学教师」与流向数据里的
 * 「初中教师／高中教师」共享**原站自己给的**同一个 zhiyId，
 * 所以连接关系来自原站，不是本站的本体归并判断。
 * 名字口径只命中 12.7%，id 口径命中 60.6%。
 * 只有 91 条、约 4KB gzip，故静态引入（不像 539KB 的重 detail 需要懒加载）。
 */
export interface XzOccupationVideo {
  readonly videoId: string;
  readonly title: string;
  readonly duration: string | null;
  readonly praise: number;
}

/** 按 zhiyId 查职业微视频；查不到返回 null（60.6% 的流向行有，其余确实没有）。 */
export function occupationVideo(zhiyId: string | null | undefined): XzOccupationVideo | null {
  if (!zhiyId) return null;
  return VIDEO_MAP[zhiyId] ?? null;
}

/** 原站视频页（实测公开可访问，无需登录）。 */
export function xzVideoUrl(videoId: string): string {
  return 'https://xz.chsi.com.cn/video/detail.action?id=' + encodeURIComponent(videoId);
}

/** 有微视频的职业数，供 UI 显示覆盖度。 */
export const XZ_VIDEO_COUNT = Object.keys(VIDEO_MAP).length;

/** 原站职业微视频栏目地址。 */
export const XZ_VIDEOS_HOME = 'https://xz.chsi.com.cn/video/index.action';

/** 原站专题（/zthz/list.action）。摘要是原站创作文本，已截断，展示须回链。 */
export interface XzTopic {
  readonly title: string;
  readonly summary: string | null;
  /** 可跳转的绝对 URL；原站没给则为 null，不编造。 */
  readonly url: string | null;
  readonly imageUrl: string | null;
  readonly date: string | null;
  readonly top: boolean;
}

/**
 * 职业测评目录项 —— **只有名称/分类/简介/回链四个字段**。
 *
 * 契约层面刻意不给题目、选项、计分规则、常模留位置：
 * 量表由平台联合北大 / 北师大 / 南师大编制，属受著作权保护的心理测量工具。
 */
export interface XzAssessment {
  readonly title: string;
  readonly catalog: string | null;
  readonly desc: string | null;
  readonly url: string;
}

export interface XzTally {
  readonly name: string;
  readonly count: number;
}

/* ── 数据集 ───────────────────────────────────────────────────────────── */

export const XZ_CASES = casesJson as readonly XzCase[];
export const XZ_SPECIALITIES = specsJson as readonly XzSpeciality[];
export const XZ_OCCUPATION_TREE = occTreeJson as readonly XzOccupationGroup[];
export const XZ_TOPICS = topicsJson as readonly XzTopic[];
export const XZ_ASSESSMENTS = assessmentsJson as readonly XzAssessment[];
export const XZ_CASE_STATS = caseStatsJson as {
  readonly total: number;
  readonly byIndustry: readonly XzTally[];
  readonly byGroup: readonly XzTally[];
  readonly byProvince: readonly XzTally[];
};
export const XZ_SPEC_STATS = specStatsJson as {
  readonly total: number;
  readonly withDetail: number;
  readonly faculties: number;
  readonly categories: number;
  readonly byLevel: readonly XzTally[];
};
export const XZ_META = metaJson as {
  readonly source: string;
  /** 最后一次真正向原站请求并落盘 lead 数据的时刻（不含离线提取，见下）。 */
  readonly collectedAt: string;
  /** 本数据集的构建时刻，每次跑 build-dataset 都会变。 */
  readonly builtAt?: string;
  /**
   * sections/ 离线提取的最近运行时刻。
   * 与 collectedAt 分开记录：它反映「我什么时候跑的提取脚本」，
   * 不代表数据何时采集 —— 混进 collectedAt 会让下游一致性校验产生假警报。
   */
  readonly sectionCollectedAt?: string | null;
  readonly notice: string;
  readonly homeUrl: string;
  readonly cases: { readonly endpoint: string; readonly total: number; readonly detailBlocked: string };
  readonly specialities: {
    readonly endpoints: readonly string[];
    readonly total: number;
    readonly withDetail: number;
    readonly detailSource: string;
    /** 统计截止年度，由数据众数派生（不是硬编码常量）。 */
    readonly statYear: number | null;
    /** 字段级覆盖率（百分比整数）。UI 读它，不写死数字。 */
    readonly fieldCoverage: {
      readonly intro: number;
      readonly direction: number;
      readonly courses: number;
      readonly related: number;
      readonly juniorAdvice: number;
      readonly satisfaction: number;
      readonly gradScale: number;
      readonly offerCount: number;
      /** 恒为 0：原站未登录不返回真实性别比例。 */
      readonly gender: number;
    };
  };
  readonly occupations: { readonly endpoint: string; readonly groups: number; readonly total: number };
};

/** 原站专业详情页地址，用于「查看原文」回链。 */
export function xzSpecialityUrl(specId: string): string {
  return 'https://xz.chsi.com.cn/speciality/detail.action?specId=' + encodeURIComponent(specId);
}

/** 原站职业人物栏目地址。案例正文有登录墙，故只回链到栏目而非详情页。 */
export const XZ_CASES_HOME = 'https://xz.chsi.com.cn/occucase/index.action';
export const XZ_SPECIALITIES_HOME = 'https://xz.chsi.com.cn/speciality/index.action';

/* ── 检索 ─────────────────────────────────────────────────────────────── */

/** 中文子串匹配（大小写无关，忽略空白）。数据量 1778/722，线性扫足够快。 */
function matches(haystack: readonly string[], needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return haystack.some((h) => (h ?? '').toLowerCase().includes(q));
}

export interface CaseFilter {
  readonly industry?: string | null;
  readonly group?: string | null;
  readonly province?: string | null;
  readonly q?: string;
}

export function filterCases(f: CaseFilter): readonly XzCase[] {
  return XZ_CASES.filter(
    (c) =>
      (!f.industry || c.industry === f.industry) &&
      (!f.group || c.group === f.group) &&
      (!f.province || c.province === f.province) &&
      matches([c.summary, c.role, c.industry ?? '', c.group ?? '', c.province ?? ''], f.q ?? ''),
  );
}

export interface SpecFilter {
  readonly faculty?: string | null;
  readonly category?: string | null;
  readonly level?: string | null;
  readonly q?: string;
  readonly onlyWithDetail?: boolean;
}

export function filterSpecialities(f: SpecFilter): readonly XzSpeciality[] {
  return XZ_SPECIALITIES.filter(
    (s) =>
      (!f.faculty || s.faculty === f.faculty) &&
      (!f.category || s.category === f.category) &&
      (!f.level || s.level === f.level) &&
      (!f.onlyWithDetail || s.detail != null) &&
      matches([s.name, s.code, s.faculty, s.category, s.level], f.q ?? ''),
  );
}

export type SpecSort = 'popularity' | 'recommended' | 'score' | 'code';

export function sortSpecialities(
  list: readonly XzSpeciality[],
  by: SpecSort,
): readonly XzSpeciality[] {
  const copy = [...list];
  switch (by) {
    case 'popularity':
      return copy.sort((a, b) => b.evlCount - a.evlCount);
    case 'recommended':
      return copy.sort(
        (a, b) => (a.rankRecommended ?? Number.MAX_SAFE_INTEGER) - (b.rankRecommended ?? Number.MAX_SAFE_INTEGER),
      );
    case 'score':
      return copy.sort((a, b) => (b.evlScore ?? 0) - (a.evlScore ?? 0));
    case 'code':
      return copy.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
    default:
      return copy;
  }
}

/** 门类 → 专业类 → 专业 的三级索引，供目录浏览器使用。 */
export interface FacultyNode {
  readonly faculty: string;
  readonly facultyCode: string;
  readonly categories: readonly {
    readonly category: string;
    readonly specs: readonly XzSpeciality[];
  }[];
  readonly total: number;
}

const FACULTY_INDEX: readonly FacultyNode[] = buildFacultyIndex();

function buildFacultyIndex(): readonly FacultyNode[] {
  const byFaculty = new Map<string, Map<string, XzSpeciality[]>>();
  for (const s of XZ_SPECIALITIES) {
    let cats = byFaculty.get(s.faculty);
    if (!cats) {
      cats = new Map();
      byFaculty.set(s.faculty, cats);
    }
    const arr = cats.get(s.category);
    if (arr) arr.push(s);
    else cats.set(s.category, [s]);
  }
  return [...byFaculty.entries()]
    .map(([faculty, cats]) => {
      const categories = [...cats.entries()]
        .map(([category, specs]) => ({
          category,
          specs: [...specs].sort((a, b) => b.evlCount - a.evlCount),
        }))
        .sort((a, b) => b.specs.length - a.specs.length);
      const first = categories[0]?.specs[0];
      return {
        faculty,
        facultyCode: first?.facultyCode ?? '',
        categories,
        total: categories.reduce((n, c) => n + c.specs.length, 0),
      };
    })
    .sort((a, b) => b.total - a.total);
}

export function facultyIndex(): readonly FacultyNode[] {
  return FACULTY_INDEX;
}

/** 职业大类 → 该大类下的具体职业，并带每个职业的案例数。 */
export function occupationGroupsWithCounts(): readonly {
  readonly group: XzOccupationGroup;
  readonly caseCount: number;
}[] {
  const counts = new Map<string, number>();
  for (const c of XZ_CASES) {
    if (c.groupId) counts.set(c.groupId, (counts.get(c.groupId) ?? 0) + 1);
  }
  return XZ_OCCUPATION_TREE.map((group) => ({
    group,
    caseCount: counts.get(group.ktId) ?? 0,
  })).sort((a, b) => b.caseCount - a.caseCount);
}

/* ── 分页 ─────────────────────────────────────────────────────────────── */

export function paginate<T>(
  list: readonly T[],
  page: number,
  perPage: number,
): { readonly items: readonly T[]; readonly page: number; readonly totalPages: number; readonly total: number } {
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safe = Math.min(Math.max(1, page), totalPages);
  const start = (safe - 1) * perPage;
  return { items: list.slice(start, start + perPage), page: safe, totalPages, total };
}

/** 数字千分位，供 UI 直接展示。 */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}
