/**
 * 18 个微站的虫洞契约（单一事实源）
 * =====================================================================================
 *
 * 为什么单独抽出来：
 *   这些 accepts / emits 会同时被三处消费 ——
 *     1. scripts/gen-site.mjs        生成 matrix-app.manifest.json
 *     2. scripts/wire-workbench.mjs  重建 manifest 并做生态自检
 *     3. 各站 src/lib/site-spec.ts   emit.payloadType / accept.payloadType
 *   三处各持一份曾经漂移过（gen-site 的 HOOKS 还是骨架期旧值，导致 `--force`
 *   会把已完工的 manifest 打回 accepts:[] / emits:[]）。抽成一份后不可能再漂。
 *
 * 字段
 * ----
 *   exportName  台账在 localStorage key 里的后缀（`mx.<appId>.<exportName>`），
 *               site-spec.ts 里必须一字不差，否则跨站串数据
 *   accepts     本站能消费的 payload_type（进 manifest.accepts）
 *   emits       本站产出的 payload_type（进 manifest.emits）
 *   emitTarget  emits 的接收方 app_id（SDK 投送前会校验对方 manifest.accepts 含此类型）
 *   acceptFrom  accepts 的主要来源 app_id
 *   acceptNote  一句话说明「收到这条数据后本站干什么」（写进 README 与验收说明）
 *
 * 自检判据（wire-workbench.mjs 文件末执行）
 *   ① 每站 emits 必须出现在 emitTarget 站的 accepts 里（否则 SDK W3 校验抛
 *      UnsupportedPayloadError，投送必然失败）
 *   ② 每站 accepts 至少有一个类型被 acceptFrom 站 emits（否则是死契约）
 *   ③ 每站 accepts 的类型必须至少有一站 emits
 *
 * 五值枚举（specs/contracts/matrix-app-manifest.schema.json）：
 *   paper_doi_bundle / comparison_matrix_row / curve_fit_parameters /
 *   mentor_match_card / verified_cv_evidence
 */

export const CONTRACTS = {
  '01': {
    exportName: 'gpa-plans',
    accepts: ['verified_cv_evidence'],
    emits: ['verified_cv_evidence'],
    // GPA 配重方案是「已验真的学业证据」，交给证据简历工坊做简历锚点。
    emitTarget: 'evidence-cv',
    acceptFrom: 'evidence-cv',
    acceptNote: '接收证据简历工坊回传的已验真 GPA 基准，校准本站配重推演的起点。',
  },
  '02': {
    exportName: 'spark-teamups',
    accepts: ['verified_cv_evidence'],
    emits: ['verified_cv_evidence'],
    // 组队契约里的技能画像要能被简历验真，交给证据简历工坊。
    emitTarget: 'evidence-cv',
    acceptFrom: 'evidence-cv',
    acceptNote: '接收队友的已验真技能证据，用于互补度匹配打分。',
  },
  '03': {
    exportName: 'grant-receipts',
    accepts: ['paper_doi_bundle'],
    emits: ['verified_cv_evidence'],
    // 国创产出（论文 / 软著）作为报销凭据的证据，交给证据简历工坊。
    emitTarget: 'evidence-cv',
    acceptFrom: 'lit-sonar',
    acceptNote: '接收文献声呐投来的论文 DOI 包，把国创产出挂到对应报销凭据上。',
  },
  '04': {
    exportName: 'pat-subscriptions',
    accepts: ['paper_doi_bundle'],
    emits: ['paper_doi_bundle'],
    emitTarget: 'lit-sonar',
    acceptFrom: 'lit-sonar',
    acceptNote: '接收文献声呐回流的跨库引文包，补全早报里的「开山鼻祖」线索。',
  },
  '05': {
    exportName: 'lit-collections',
    accepts: ['paper_doi_bundle'],
    emits: ['paper_doi_bundle'],
    emitTarget: 'matrix-cross',
    acceptFrom: 'pat-hot',
    acceptNote: '接收学科脉冲雷达投来的前沿论文包，直接落成收藏夹里的待读条目。',
  },
  '06': {
    exportName: 'mentor-profiles',
    accepts: ['paper_doi_bundle', 'curve_fit_parameters'],
    emits: ['mentor_match_card'],
    emitTarget: 'cold-email',
    acceptFrom: 'lit-sonar',
    acceptNote: '接收文献声呐投来的论文包，自动抽取作者与机构，回填导师画像的「近 3 年活跃度」。',
  },
  '07': {
    exportName: 'cold-email-drafts',
    accepts: ['mentor_match_card', 'curve_fit_parameters'],
    emits: ['mentor_match_card'],
    // 套磁信定稿后变成一张「导师接触卡」，交给进组跟进台账去跑状态机。
    emitTarget: 'lab-kanban',
    acceptFrom: 'mentor',
    acceptNote: '接收导师星象仪投来的匹配卡，作为套磁信草稿的收件人依据。',
  },
  '08': {
    exportName: 'lab-pipeline',
    accepts: ['mentor_match_card'],
    emits: ['verified_cv_evidence'],
    // 「已进组」是简历里最硬的一条科研经历，落成证据交给简历工坊。
    emitTarget: 'evidence-cv',
    acceptFrom: 'cold-email',
    acceptNote: '接收套磁信推演器投来的导师接触卡，自动开一条「已发信」状态。',
  },
  '09': {
    exportName: 'cross-matrix',
    accepts: ['paper_doi_bundle'],
    emits: ['comparison_matrix_row'],
    emitTarget: 'curvelab',
    acceptFrom: 'lit-sonar',
    acceptNote: '接收文献声呐投来的论文包，自动抽成对比矩阵的一列。',
  },
  '10': {
    exportName: 'formula-cards',
    accepts: ['paper_doi_bundle'],
    emits: ['comparison_matrix_row'],
    // 公式 / 参量抽取的结果是「矩阵行」，交给综述写作舱做段落证据绑定。
    emitTarget: 'review-lab',
    acceptFrom: 'lit-sonar',
    acceptNote: '接收文献声呐投来的论文包，逐页抽出公式与物理量纲，落成符号表条目。',
  },
  '11': {
    exportName: 'curvelab-datasets',
    accepts: ['comparison_matrix_row'],
    emits: ['curve_fit_parameters'],
    emitTarget: 'chart-foundry',
    acceptFrom: 'matrix-cross',
    acceptNote: '接收对比矩阵行，作为拟合数据集的元信息（材料 / 方法 / 工况）。',
  },
  '12': {
    exportName: 'repro-checklists',
    accepts: ['paper_doi_bundle', 'curve_fit_parameters'],
    emits: ['paper_doi_bundle'],
    // 复现清单 + 论文锚点，交给撤稿声呐做引文合规体检。
    emitTarget: 'retract-radar',
    acceptFrom: 'curvelab',
    acceptNote: '接收 CurveLab 投来的拟合参量，写进复现清单的超参栏。',
  },
  '13': {
    exportName: 'chart-scripts',
    accepts: ['curve_fit_parameters', 'comparison_matrix_row'],
    emits: ['comparison_matrix_row'],
    // 出图结果按「图-数据-结论」摊成矩阵行，交给综述写作舱。
    emitTarget: 'review-lab',
    acceptFrom: 'curvelab',
    acceptNote: '接收 CurveLab 投来的拟合参量，直接生成一张符合期刊规范的矢量图脚本。',
  },
  '14': {
    exportName: 'review-outlines',
    accepts: ['paper_doi_bundle', 'comparison_matrix_row'],
    emits: ['paper_doi_bundle'],
    emitTarget: 'retract-radar',
    acceptFrom: 'chart-foundry',
    acceptNote: '接收图表熔炉投来的矩阵行，把图号绑定到综述对应段落。',
  },
  '15': {
    exportName: 'retract-reports',
    accepts: ['paper_doi_bundle'],
    emits: ['paper_doi_bundle'],
    // 体检通过的引文包才允许进简历，交给证据简历工坊。
    emitTarget: 'evidence-cv',
    acceptFrom: 'repro-check',
    acceptNote: '接收复现核验舱投来的论文包，逐条排查撤稿与勘误引文。',
  },
  '16': {
    exportName: 'yunheng-items',
    accepts: ['paper_doi_bundle', 'verified_cv_evidence'],
    emits: ['verified_cv_evidence'],
    emitTarget: 'evidence-cv',
    acceptFrom: 'evidence-cv',
    acceptNote: '接收已验真的科研证据，按综测细则自动折算加分项。',
  },
  '17': {
    exportName: 'cv-versions',
    accepts: [
      'paper_doi_bundle',
      'comparison_matrix_row',
      'curve_fit_parameters',
      'mentor_match_card',
      'verified_cv_evidence',
    ],
    emits: ['verified_cv_evidence'],
    emitTarget: 'prejob',
    acceptFrom: 'retract-radar',
    acceptNote: '接收各站投来的已验真证据，逐条嵌进简历对应经历的 DOI 锚点。',
  },
  '18': {
    exportName: 'career-paths',
    accepts: ['verified_cv_evidence'],
    emits: ['verified_cv_evidence'],
    // 决策结果回写成「已验真的能力画像」，回传简历工坊做闭环。
    emitTarget: 'evidence-cv',
    acceptFrom: 'evidence-cv',
    acceptNote: '接收简历工坊投来的已验真能力画像，作为生涯路径推演的输入。',
  },
};

/** 契约里的五值枚举，manifest schema 与 site-spec 都只能取这五个。 */
export const PAYLOAD_TYPES = [
  'paper_doi_bundle',
  'comparison_matrix_row',
  'curve_fit_parameters',
  'mentor_match_card',
  'verified_cv_evidence',
];

/** manifest 的基础权限；emits / accepts 非空时再追加 wormhole:send / wormhole:receive。 */
export const BASE_PERMISSIONS = [
  'matrix_id:read',
  'profile:read',
  'assets:read',
  'assets:write',
];

/**
 * 由契约算出某站的 manifest 权限表。
 * 权限是声明式的能力面：不接受虫洞却声明 wormhole:receive 会被契约校验当噪音。
 */
export function permissionsFor(contract) {
  const permissions = [...BASE_PERMISSIONS];
  if (contract.emits.length > 0) permissions.push('wormhole:send');
  if (contract.accepts.length > 0) permissions.push('wormhole:receive');
  return permissions;
}

/**
 * 生态自检：返回人类可读的问题列表（空数组 = 全部自洽）。
 * 判据见文件头「自检判据」。
 *
 * @param {Map<string, string>} appIdToId  app_id → 站号（权威源是各站 matrix-app.manifest.json，
 *                                         由调用方读盘后传入；本文件不重复持有映射）
 * @returns {string[]} 问题列表
 */
export function auditContracts(appIdToId) {
  const problems = [];

  const idOf = (appId) => {
    const id = appIdToId.get(appId);
    if (id === undefined) {
      problems.push(`契约引用了不存在的 app_id「${appId}」`);
      return null;
    }
    return id;
  };

  const emittersOfType = new Map();
  for (const [id, contract] of Object.entries(CONTRACTS)) {
    for (const type of contract.emits) {
      const list = emittersOfType.get(type) ?? [];
      list.push(id);
      emittersOfType.set(type, list);
    }
  }

  for (const [id, contract] of Object.entries(CONTRACTS)) {
    // ① emits 必须被 emitTarget 站的 accepts 消费，否则 SDK W3 校验必然抛
    const targetId = idOf(contract.emitTarget);
    if (targetId !== null) {
      const target = CONTRACTS[targetId];
      for (const type of contract.emits) {
        if (!target.accepts.includes(type)) {
          problems.push(
            `${id} 站 emits ${type}，但目标站 ${targetId}（${contract.emitTarget}）的 accepts 不含该类型`,
          );
        }
      }
    }

    // ② accepts 至少有一个类型被 acceptFrom 站 emits
    const sourceId = idOf(contract.acceptFrom);
    if (sourceId !== null && contract.accepts.length > 0) {
      const source = CONTRACTS[sourceId];
      const covered = contract.accepts.some((type) => source.emits.includes(type));
      if (!covered) {
        problems.push(
          `${id} 站 accepts [${contract.accepts.join(', ')}]，但来源站 ${sourceId}（${contract.acceptFrom}）一个都不 emits`,
        );
      }
    }

    // ③ accepts 的每个类型必须至少有一站 emits（否则永远收不到）
    for (const type of contract.accepts) {
      if (!emittersOfType.has(type)) {
        problems.push(`${id} 站 accepts ${type}，但 18 站里没有任何一站 emits 该类型`);
      }
    }

    // ④ 枚举合法性
    for (const type of [...contract.accepts, ...contract.emits]) {
      if (!PAYLOAD_TYPES.includes(type)) {
        problems.push(`${id} 站契约含非法 payload_type「${type}」`);
      }
    }
  }

  return problems;
}
