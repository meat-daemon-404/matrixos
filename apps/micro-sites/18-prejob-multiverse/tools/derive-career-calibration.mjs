// 生成 18-prejob-multiverse 的「生涯路径 × 学职平台真实数据」校准表。
//
// 为什么要生成而不是运行时聚合：
//   src/lib/xz-data.ts 静态 import 了 xz-specialities.json(918 KB) + xz-cases.json(427 KB)，
//   若 site-spec.ts 直接 import 它，会把 1.35 MB 并进 workbench 所在 chunk，抵消
//   use-heavy-detail.ts 的懒加载优化（见 packages/xz-knowledge/test/lazy-load-guard.test.ts）。
//   所以这里离线把 1778 条专业聚合掉，产出 ~5 KB 的常量表，站点只读这张表。
//
// 用法：
//   node tools/derive-career-calibration.mjs            # 重新生成 src/lib/career-calibration.ts
//   node tools/derive-career-calibration.mjs --check    # 只比对，不写盘（CI / 校验用）
//
// 数据来源：学职平台 xz.chsi.com.cn（教育部学生服务与素质发展中心），
//   由 src/lib/xz-data/ 下的采集快照提供，statYear = 2025。

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, '..');
const DATA = join(SITE, 'src', 'lib', 'xz-data');
const OUT = join(SITE, 'src', 'lib', 'career-calibration.ts');

const readJson = (name) => JSON.parse(readFileSync(join(DATA, name), 'utf8'));

const SPECIALITIES = readJson('xz-specialities.json');
const CASE_STATS = readJson('xz-case-stats.json');
const META = readJson('xz-meta.json');

// ---------------------------------------------------------------------------
// 路径 → 专业面白名单
//
// 只圈「本科」层次（level 含「本科」：本科（普通教育）+ 本科（职业教育）），
// 因为三条路径都是本科毕业后的分流。按「学科门类 / 专业类」两级圈，
// 不按整个学科门类圈 —— 门类下混着大量高职专科专业，会把口径污染掉。
// ---------------------------------------------------------------------------
const PATHS = [
  {
    id: 'p1',
    name: '推免直博',
    // 学术型深造：基础理学 + 工科主干 + 交叉学科
    scopes: [
      ['工学', '材料类'],
      ['工学', '电子信息类'],
      ['工学', '机械类'],
      ['工学', '计算机类'],
      ['工学', '电气类'],
      ['工学', '自动化类'],
      ['工学', '力学类'],
      ['工学', '仪器类'],
      ['理学', '化学类'],
      ['理学', '物理学类'],
      ['理学', '数学类'],
      ['理学', '生物科学类'],
    ],
    // 案例参照：直博毕业后主要去向是高校 / 科研院所，对应案例库里的「教育/行政」。
    // 案例数只作「这个方向有多少真实职业人物样本」的参照，不参与校准乘法。
    caseIndustries: ['教育/行政'],
  },
  {
    id: 'p2',
    name: '头部光企研发',
    // 光电 / 半导体 / 通信 / 新能源 对口专业面
    scopes: [
      ['工学', '电子信息类'],
      ['工学', '材料类'],
      ['工学', '仪器类'],
      ['电子与信息', '电子信息类'],
      ['电子与信息', '通信类'],
      ['电子与信息', '集成电路类'],
      ['装备制造', '自动化类'],
      ['能源动力与材料', '新能源发电工程类'],
      ['理学', '物理学类'],
    ],
    caseIndustries: ['互联网/通信'],
  },
  {
    id: 'p3',
    name: '选调考公',
    // 选调生 / 公务员 对口专业面
    scopes: [
      ['法学', '法学类'],
      ['法学', '政治学类'],
      ['法学', '社会学类'],
      ['法学', '马克思主义理论类'],
      ['公共管理与服务', '公共管理类'],
      ['公共管理与服务', '公共事业类'],
      ['公安与司法', '法律实务类'],
      ['公安与司法', '公安管理类'],
      ['管理学', '公共管理类'],
    ],
    // 案例参照：选调生进入的是党政机关 / 监察法律 / 社会服务序列。
    caseIndustries: ['公务员/监察法律/社会服务'],
  },
];

// ---------------------------------------------------------------------------
// 聚合工具
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const isUndergrad = (s) => typeof s.level === 'string' && s.level.includes('本科');
const inScope = (s, scopes) => scopes.some(([faculty, category]) => s.faculty === faculty && s.category === category);

// 满意度只有 rank>0 且 count>0 才是真实投票结果；rank=0 表示该专业没人评过。
const validSat = (s) => {
  const e = s.detail?.satisfaction?.employment;
  return Boolean(e) && Number.isFinite(e.rank) && e.rank > 0 && Number.isFinite(e.count) && e.count > 0;
};

function aggregate(list) {
  let satWeighted = 0;
  let votes = 0;
  let offerSum = 0;
  let offerN = 0;
  let scoreSum = 0;
  let high = 0;
  let mid = 0;
  let low = 0;
  for (const s of list) {
    if (Number.isFinite(s.evlScore)) scoreSum += s.evlScore;
    if (Number.isFinite(s.detail?.offerCount)) {
      offerSum += s.detail.offerCount;
      offerN += 1;
    }
    if (!validSat(s)) continue;
    const e = s.detail.satisfaction.employment;
    satWeighted += e.rank * e.count;
    votes += e.count;
    if (e.rank >= 4.0) high += 1;
    else if (e.rank >= 3.5) mid += 1;
    else low += 1;
  }
  const rated = high + mid + low;
  return {
    n: list.length,
    rated,
    sat: votes > 0 ? satWeighted / votes : null,
    votes,
    offer: offerN > 0 ? offerSum / offerN : null,
    evlScore: list.length > 0 ? scoreSum / list.length : null,
    share:
      rated > 0
        ? { success: high / rated, neutral: mid / rated, fail: low / rated }
        : { success: 0, neutral: 0, fail: 0 },
  };
}

// 专业面现实指数：三个维度加权，每项先归一化到 0..1。
//   0.55 · 就业满意度加权均值 / 5      —— 毕业生对就业的主观评价（票数加权）
//   0.30 · log10(1 + 评价票数) / 7      —— 数据样本厚度（多少真实投票撑着这个均值）
//   0.15 · 平均开设院校数 / 300         —— 专业面的院校覆盖广度（结构性供给指标）
function realityIndex(a) {
  const sat = clamp((a.sat ?? 0) / 5, 0, 1);
  const depth = clamp(Math.log10(1 + a.votes) / 7, 0, 1);
  const breadth = clamp((a.offer ?? 0) / 300, 0, 1);
  return 0.55 * sat + 0.3 * depth + 0.15 * breadth;
}

// 案例数（学职平台真实职业人物样本）按行业分布查表
const caseByIndustry = new Map((CASE_STATS.byIndustry ?? []).map((r) => [r.name, r.count]));

const undergrad = SPECIALITIES.filter(isUndergrad);
const globalAgg = aggregate(undergrad);
const globalIndex = realityIndex(globalAgg);
const caseTotal = CASE_STATS.total ?? 0;

// 模型侧基准（与 @matrixos/microsite-data 的 CAREER_PATHS 一一对应；由脚本从该包读取，
// 避免手抄 —— 见下方 readModelPaths）
const MODEL_BASE = readModelPaths();

function readModelPaths() {
  // dist 是 CommonJS，直接 require 即可（脚本跑在 Node 里，不受 Next 打包约束）
  const mod = require('@matrixos/microsite-data');
  return mod.CAREER_PATHS.map((p) => ({
    id: p.id,
    name: p.name,
    expectedGain: p.expectedGain,
    risk: p.risk,
    trajectory: [...p.trajectory],
    probabilities: { ...p.probabilities },
  }));
}

function pickTopSpeciality(list) {
  // 代表专业：评价票数最多（= 这个专业面里最受关注、样本最厚的那个）
  let best = null;
  for (const s of list) {
    const c = s.evlCount ?? 0;
    if (!best || c > (best.evlCount ?? 0)) best = s;
  }
  if (!best) return null;
  const e = best.detail?.satisfaction?.employment;
  return {
    specId: best.specId,
    code: best.code,
    name: best.name,
    faculty: best.faculty,
    category: best.category,
    evlCount: best.evlCount ?? 0,
    evlScore: best.evlScore ?? null,
    satisfactionRank: validSat(best) ? e.rank : null,
    satisfactionCount: validSat(best) ? e.count : null,
    url: `https://xz.chsi.com.cn/speciality/detail.action?specId=${best.specId}`,
  };
}

function normalizeProbabilities(model, share) {
  // 50% 模型先验 + 50% 学职平台就业满意度分档占比
  const blended = {
    success: 0.5 * model.success + 0.5 * share.success,
    neutral: 0.5 * model.neutral + 0.5 * share.neutral,
  };
  const success = round(blended.success, 2);
  const neutral = round(blended.neutral, 2);
  const fail = round(1 - success - neutral, 2);
  return { success, neutral, fail };
}

const paths = PATHS.map((spec) => {
  const model = MODEL_BASE.find((p) => p.id === spec.id);
  if (!model) throw new Error(`CAREER_PATHS 里找不到 ${spec.id}`);

  const set = undergrad.filter((s) => inScope(s, spec.scopes));
  const agg = aggregate(set);
  const index = realityIndex(agg);
  // 校准系数限制在 ±20%：学职平台提供的是「相对校准」，不是绝对量级。
  const calibration = clamp(index / globalIndex, 0.8, 1.2);

  const expectedGain = Math.round(model.expectedGain * calibration);
  const trajectory = model.trajectory.map((v) => Math.max(1, Math.round(v * calibration)));
  const probabilities = normalizeProbabilities(model.probabilities, agg.share);

  const cases = spec.caseIndustries.reduce((acc, name) => acc + (caseByIndustry.get(name) ?? 0), 0);

  return {
    id: spec.id,
    name: model.name,
    scopes: spec.scopes.map(([faculty, category]) => `${faculty}/${category}`),
    caseIndustries: spec.caseIndustries,
    caseCount: cases,
    caseShare: caseTotal > 0 ? round(cases / caseTotal, 3) : 0,
    specialityCount: set.length,
    ratedCount: agg.rated,
    satisfaction: agg.sat === null ? null : round(agg.sat, 2),
    votes: agg.votes,
    avgOfferCount: agg.offer === null ? null : round(agg.offer, 1),
    avgScore: agg.evlScore === null ? null : round(agg.evlScore, 2),
    realityIndex: round(index, 3),
    calibration: round(calibration, 3),
    modelGain: model.expectedGain,
    expectedGain,
    risk: model.risk,
    modelTrajectory: model.trajectory,
    trajectory,
    modelProbabilities: model.probabilities,
    probabilities,
    topSpeciality: pickTopSpeciality(set),
  };
});

const payload = {
  meta: {
    source: '学职平台 xz.chsi.com.cn（教育部学生服务与素质发展中心）',
    homeUrl: META.homeUrl ?? 'https://xz.chsi.com.cn/',
    statYear: META.specialities?.statYear ?? 2025,
    collectedAt: META.collectedAt ?? null,
    specialityTotal: META.specialities?.total ?? SPECIALITIES.length,
    undergradTotal: undergrad.length,
    caseTotal,
    caseCollected: META.cases?.total ?? null,
    notice:
      '学职平台不提供薪资与升学率字段。本表只把「就业满意度 / 评价票数 / 开设院校数」用于相对校准，' +
      '不构成对期望收益绝对量级的真实测量；期望收益的万元量级仍来自 MatrixOS 模型假设。',
  },
  global: {
    specialityCount: undergrad.length,
    ratedCount: globalAgg.rated,
    satisfaction: globalAgg.sat === null ? null : round(globalAgg.sat, 2),
    votes: globalAgg.votes,
    avgOfferCount: globalAgg.offer === null ? null : round(globalAgg.offer, 1),
    realityIndex: round(globalIndex, 3),
  },
  paths,
};

const banner = `// 本文件由 tools/derive-career-calibration.mjs 自动生成，请勿手改。
// 重新生成：node tools/derive-career-calibration.mjs
// 校验一致：node tools/derive-career-calibration.mjs --check
//
// 数据来源：${payload.meta.source}
// 采集快照：${payload.meta.collectedAt ?? '未知'}（statYear ${payload.meta.statYear}）
// 口径：${payload.meta.specialityTotal} 条专业目录中筛出 ${payload.meta.undergradTotal} 条本科层次专业；
//       ${payload.meta.caseTotal} 条职业人物案例仅作行业参照，不参与校准乘法。

`;

const body = `export const CAREER_CALIBRATION = ${JSON.stringify(payload, null, 2)} as const;

export type CareerCalibration = typeof CAREER_CALIBRATION;
export type CareerPathCalibration = CareerCalibration['paths'][number];
`;

const text = banner + body;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error(`✗ 缺少 ${OUT}，请先运行 node tools/derive-career-calibration.mjs`);
    process.exit(1);
  }
  if (current !== text) {
    console.error('✗ career-calibration.ts 与 xz 数据不一致，请重新生成');
    process.exit(1);
  }
  console.log('✓ career-calibration.ts 与 xz 数据一致');
  process.exit(0);
}

writeFileSync(OUT, text, 'utf8');

console.log(`✓ 已写出 ${OUT}（${Buffer.byteLength(text, 'utf8')} 字节）`);
console.log(`  全库本科专业 ${payload.global.specialityCount} 条，就业满意度加权均值 ${payload.global.satisfaction}，现实指数 ${payload.global.realityIndex}`);
for (const p of paths) {
  console.log(
    `  ${p.id} ${p.name}: ${p.specialityCount} 专业（${p.ratedCount} 有评）` +
      ` 满意度 ${p.satisfaction} 票 ${p.votes} 院校 ${p.avgOfferCount}` +
      ` 现实指数 ${p.realityIndex} 校准 ${p.calibration}` +
      ` → ${p.modelGain} ⇒ ${p.expectedGain} 万，概率 ${p.probabilities.success}/${p.probabilities.neutral}/${p.probabilities.fail}` +
      ` 案例 ${p.caseCount}`,
  );
}
