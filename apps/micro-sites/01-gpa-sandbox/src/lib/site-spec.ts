/**
 * 01 · 学分绩点动态配重台 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：学期目标绩点与选课博弈方案库
 * 投送：verified_cv_evidence → evidence-cv（证据简历工坊）
 * 接收：verified_cv_evidence（来自证据简历工坊的已验真 GPA 基准）
 *
 * 为什么这么写：增删改清空导出投送接收的**语义**由 `createRowSpec` 固化，
 * 这里只描述「这个站有哪些方案、方案长什么样、投出去带什么字段」。
 * 演示数值直接由共享课表算出来，避免手抄数字与仪器面板对不上。
 */

import {
  GPA_COURSES,
  createRowSpec,
  weightedGpa,
  type RowSeed,
} from '@matrixos/microsite-data';

const CURRENT_GPA = weightedGpa(GPA_COURSES, false);
const TARGET_GPA = weightedGpa(GPA_COURSES, true);
const GAP = TARGET_GPA - CURRENT_GPA;
const fmt = (value: number): string => value.toFixed(2);
const CREDITS = GPA_COURSES.reduce((sum, course) => sum + course.credits, 0);
const CORE = GPA_COURSES.filter((course) => course.core).length;

function planAnchor(slug: string) {
  return {
    source_doi_or_url: `https://gpa.matrixos.cc.cd/plans/${slug}`,
    verification_level: 'Level_B_Preprint' as const,
  };
}

const seed: readonly RowSeed[] = [
  {
    title: '方案 A · 保研冲刺线',
    meta: `核心 GPA ${fmt(TARGET_GPA)} · ${CREDITS} 学分 · 提升 +${fmt(GAP)}`,
    detail: `把 ${CORE} 门核心课的复习预算拉满：量子力学与数学物理方法各提 7 分，专业英语保底 90。非核心课维持现状，不额外投入。`,
    anchor: planAnchor('plan-a'),
    plan: 'A',
    gpa: Number(fmt(TARGET_GPA)),
    risk: '低',
  },
  {
    title: '方案 B · 出国交换友好',
    meta: `核心 GPA ${fmt(CURRENT_GPA + GAP * 0.6)} · 弱化非核心课`,
    detail:
      '工程伦理与专业英语不再加码，把腾出的复习时间全部压给固体物理和光电检测技术；适合同时准备语言考试的一学期。',
    anchor: planAnchor('plan-b'),
    plan: 'B',
    gpa: Number(fmt(CURRENT_GPA + GAP * 0.6)),
    risk: '中',
  },
  {
    title: '方案 C · 风险兜底',
    meta: `核心 GPA ${fmt(CURRENT_GPA)} · 维持现状`,
    detail:
      '只把数学物理方法从 79 拉到 85，其余全部按当前水平锁定。期末难度上调时仍能守住 3.6 的保研资格线。',
    anchor: planAnchor('plan-c'),
    plan: 'C',
    gpa: Number(fmt(CURRENT_GPA)),
    risk: '低',
  },
];

export const siteSpec = createRowSpec({
  exportName: 'gpa-plans',
  seed,
  emit: {
    targetApp: 'evidence-cv',
    payloadType: 'verified_cv_evidence',
  },
  accept: {
    payloadType: 'verified_cv_evidence',
    description:
      '接收证据简历工坊回传的已验真 GPA 基准，落成本站一条「基准方案」，用来校准后续配重推演的起点。',
  },
  draft: (rows) => ({
    title: `新配重方案 ${String(rows.length + 1).padStart(2, '0')}`,
    meta: `核心 GPA 待定 · ${CREDITS} 学分`,
    detail: '点「编辑」填入目标分数与课程取舍；配重推演会立刻反映到上方仪器面板。',
    plan: String.fromCharCode(65 + (rows.length % 6)),
    gpa: Number(fmt(CURRENT_GPA)),
    risk: '待评估',
  }),
  payloadOf: (rows) => ({
    site: 'gpa',
    ledger: '学期目标绩点与选课博弈方案库',
    currentGpa: Number(fmt(CURRENT_GPA)),
    targetGpa: Number(fmt(TARGET_GPA)),
    credits: CREDITS,
    coreCourses: CORE,
    plans: rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      plan: String(row.plan ?? ''),
      gpa: row.gpa ?? null,
      risk: String(row.risk ?? '待评估'),
      detail: String(row.detail),
    })),
  }),
  csvOf: (rows) => ({
    header: ['方案编号', '方案名', '目标 GPA', '风险等级', '说明', '最后修改'],
    rows: rows.map((row) => [
      String(row.plan ?? ''),
      String(row.title),
      String(row.gpa ?? ''),
      String(row.risk ?? ''),
      String(row.detail),
      String(row.updatedAt ?? ''),
    ]),
  }),
});
