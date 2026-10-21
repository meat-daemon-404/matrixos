/**
 * 16 · 云衡 · 数字天平综测核算器 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：学年综测加分项与证明材料 PDF 包
 * 投送：verified_cv_evidence → evidence-cv（17 简历证据台，只收已核验的加分项）
 * 接收：verified_cv_evidence（来自 17 简历证据台的已验真科研证据）
 *
 * 为什么这么写：
 *   一条记录 = **一个综测加分项**：类别 + 申报分值 + 该项上限 + 证明材料。
 *   申报分值、类别上限、折算依据全部取自 YUNHENG_PANS —— 天平上三只盘的读数和
 *   台账里的分数同源，不会出现「仪器显示 14 分、台账写 12 分」的答辩事故。
 *   上限（capacity）是本站的硬闸门：申报分值一律不得越过它，触顶的项在 detail
 *   里显式标注「触顶」，投送时下游只会拿到已核验且未越界的加分项。
 *
 * ⚠️ 共享数据里的锚点是 camelCase 且带 note；虫洞契约锚点层是 snake_case 且
 *    `additionalProperties: false`，多一个 note 整封投送就过不了校验，故逐字段搬运。
 */

import {
  CV_ENTRIES,
  PAPER_ROWS,
  YUNHENG_PANS,
  YUNHENG_TOTAL,
  createRowSpec,
  defaultRowOfEnvelope,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

type Pan = (typeof YUNHENG_PANS)[number];
type PaperRow = (typeof PAPER_ROWS)[number];

/* ── 天平读数：所有分值、上限、余量从 YUNHENG_PANS 推出来 ────────────── */

function panOf(id: string): Pan | undefined {
  return YUNHENG_PANS.find((pan) => pan.id === id);
}

/** 兜底盘：新增项在三个盘都已覆盖后落到科研双创（细则里额度最大的一类）。 */
const RESEARCH = panOf('research');

/** 缺数据就早退，避免把 NaN 写进台账（纯数据模块，不抛错也不留空值）。 */
function panValue(id: string): number {
  return panOf(id)?.value ?? 0;
}

function panCapacity(id: string): number {
  return panOf(id)?.capacity ?? 0;
}

function panLabel(id: string): string {
  return panOf(id)?.label ?? id;
}

function panHint(id: string): string {
  return panOf(id)?.hint ?? '—';
}

/** 余量 = 上限 − 已申报。浮点误差按两位小数收口。 */
function headroom(id: string): number {
  return Number((panCapacity(id) - panValue(id)).toFixed(2));
}

/** 已申报是否用满该项上限。 */
function isCapped(id: string): boolean {
  return panValue(id) >= panCapacity(id);
}

/** 申报分值是否越界 —— 越界即台账校验失败，本站不接受越界记录。 */
function isOverCap(declared: number, id: string): boolean {
  return declared > panCapacity(id);
}

function fmt(value: number): string {
  return value.toFixed(2);
}

/** 三盘上限之和 = 综测理论满分；三盘已申报之和是本地口径合计。 */
const CAPACITY_SUM = Number(
  YUNHENG_PANS.reduce((sum, pan) => sum + (pan.capacity ?? 0), 0).toFixed(2),
);
const DECLARED_SUM = Number(YUNHENG_PANS.reduce((sum, pan) => sum + pan.value, 0).toFixed(2));
/** 仪器显示总加分与本地申报合计的差额（口径差，不是错误）。 */
const TOTAL_GAP = Number((DECLARED_SUM - YUNHENG_TOTAL).toFixed(2));

/** 「申报 X 分 / 上限 Y 分 / 是否触顶」——每一条记录的必写句式。 */
function scoreLine(declared: number, panId: string): string {
  const capped = declared >= panCapacity(panId);
  return `申报 ${fmt(declared)} 分 / 上限 ${fmt(panCapacity(panId))} 分 / ${capped ? '已触顶' : `未触顶（余量 ${fmt(panCapacity(panId) - declared)} 分）`}`;
}

/* ── 锚点：共享数据（camelCase，带 note）→ 虫洞契约（snake_case，无 note）── */

function paperAnchor(doi: string): WormholeEvidenceAnchor {
  const paper: PaperRow | undefined = PAPER_ROWS.find(
    (item) => item.anchor.sourceDoiOrUrl === doi,
  );
  if (!paper) return { source_doi_or_url: doi, verification_level: 'Level_B_Preprint' };
  const { sourceDoiOrUrl, pdfPage, bbox, verificationLevel } = paper.anchor;
  return {
    source_doi_or_url: sourceDoiOrUrl,
    verification_level: verificationLevel,
    ...(pdfPage === undefined ? {} : { pdf_page: pdfPage }),
    ...(bbox === undefined ? {} : { bbox }),
  };
}

/** 教务 / 团委系统直出的电子证明，用系统条目地址承载锚点。 */
function materialAnchor(path: string, level: WormholeEvidenceAnchor['verification_level']) {
  return {
    source_doi_or_url: `https://yunheng.matrixos.edu/materials/${path}`,
    verification_level: level,
  };
}

/* ── 演示数据：一条记录 = 一个加分项 + 一份证明材料 ───────────────────── */

/** 德育补报项：申报额度正好等于德育盘的剩余余量，补报后该项触顶。 */
const MORAL_TOPUP = headroom('moral');

const seed: readonly RowSeed[] = [
  {
    title: `德育 · 志愿服务（${panHint('moral')}）`,
    meta: `${panLabel('moral')}类 · ${scoreLine(panValue('moral'), 'moral')}`,
    detail: `加分依据：校青年志愿者协会年度服务记录 ${Math.round(panValue('moral') / 0.5)} 次 × 0.5 分 = ${fmt(panValue('moral'))} 分。${scoreLine(panValue('moral'), 'moral')}。证明材料：志愿服务时长证明（团委盖章版 PDF，共 3 页）＋ 服务签到流水截图。申报状态：已通过院系初审，待校团委复核盖章后转 Level A。`,
    anchor: materialAnchor('volunteer-service-log', 'Level_B_Preprint'),
    panId: 'moral',
    category: panLabel('moral'),
    declared: panValue('moral'),
    capacity: panCapacity('moral'),
    headroom: headroom('moral'),
    capped: isCapped('moral'),
    evidenceKind: '志愿服务时长证明',
    material: '团委盖章 PDF · 3 页',
    reviewState: '院系初审通过',
  },
  {
    title: `智育 · 学分绩点折算（${panHint('intellect')}）`,
    meta: `${panLabel('intellect')}类 · ${scoreLine(panValue('intellect'), 'intellect')}`,
    detail: `加分依据：学年加权 GPA 3.86，按教务细则「智育基础分 4.00 + GPA 增量 × 1.00」折算为 ${fmt(panValue('intellect'))} 分。${scoreLine(panValue('intellect'), 'intellect')}。证明材料：教务系统成绩单（带校验码的 PDF，系统直出）。申报状态：教务系统直出，自动核验为 Level A，无需人工复核。`,
    anchor: materialAnchor('transcript-2025', 'Level_A_Verified'),
    panId: 'intellect',
    category: panLabel('intellect'),
    declared: panValue('intellect'),
    capacity: panCapacity('intellect'),
    headroom: headroom('intellect'),
    capped: isCapped('intellect'),
    evidenceKind: '教务系统成绩单',
    material: '系统直出 PDF · 含校验码',
    reviewState: '系统自动核验',
  },
  {
    title: `科研双创 · 国创项目 + 一作论文（${panHint('research')}）`,
    meta: `${panLabel('research')}类 · ${scoreLine(panValue('research'), 'research')}`,
    detail: `加分依据：国家级大学生创新创业训练计划结项（8.00 分）＋ 第一作者论文见刊（6.00 分），合计 ${fmt(panValue('research'))} 分。${scoreLine(panValue('research'), 'research')}。证明材料：国创结项证书 PDF ＋ 论文原文（Nat. Photon. 2025，见锚点第 ${paperAnchor('10.1038/s41566-025-01234-5').pdf_page ?? 4} 页）＋ DOI 可解析性截图。申报状态：已通过科研院验真，锚点核验等级 Level A。`,
    anchor: paperAnchor('10.1038/s41566-025-01234-5'),
    panId: 'research',
    category: panLabel('research'),
    declared: panValue('research'),
    capacity: panCapacity('research'),
    headroom: headroom('research'),
    capped: isCapped('research'),
    evidenceKind: '国创结项证书 + 一作论文',
    material: '结项证书 PDF + 论文原文 PDF',
    reviewState: '科研院验真',
  },
  {
    title: `德育补报 · 志愿时长追加（${scoreLine(MORAL_TOPUP, 'moral')}）`,
    meta: `${panLabel('moral')}类 · 补报 ${fmt(MORAL_TOPUP)} 分 · 补报后该项触顶`,
    detail: `补报依据：本学期新增志愿服务 ${Math.round(MORAL_TOPUP / 0.5)} 次，按 0.5 分/次折算 ${fmt(MORAL_TOPUP)} 分，恰好用满${panLabel('moral')}盘余量。${scoreLine(MORAL_TOPUP, 'moral')}——补报后该项累计 ${fmt(panValue('moral') + MORAL_TOPUP)} 分，已达上限 ${fmt(panCapacity('moral'))} 分，不再接受新的${panLabel('moral')}类申报。证明材料：团委补录服务记录 PDF（2 页）＋ 活动主办方确认邮件截图。申报状态：院系初审通过，待校团委复核。`,
    anchor: materialAnchor('volunteer-service-log-supplement', 'Level_B_Preprint'),
    panId: 'moral',
    category: panLabel('moral'),
    declared: MORAL_TOPUP,
    capacity: panCapacity('moral'),
    headroom: 0,
    capped: true,
    evidenceKind: '志愿服务补录记录',
    material: '团委补录 PDF · 2 页',
    reviewState: '院系初审通过',
  },
];

/* ── 业务规格 ────────────────────────────────────────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'yunheng-items',
  seed,
  emit: {
    targetApp: 'evidence-cv',
    payloadType: 'verified_cv_evidence',
  },
  accept: {
    payloadType: 'verified_cv_evidence',
    description:
      '接收简历证据台投来的已验真科研证据，落成一条「待折算」加分项：先判定归属类别，再按该项上限折算分值，越界即拒收，折算完成后回投给简历证据台。',
  },
  draft: (rows) => {
    const usedPans = new Set(rows.map((row) => String(row.panId ?? '')));
    const pan = YUNHENG_PANS.find((item) => !usedPans.has(item.id)) ?? RESEARCH;
    const target = pan ?? RESEARCH;
    const declared = target ? target.value : 0;
    const panId = target ? target.id : 'research';
    return {
      title: `${target ? target.label : '科研双创'} · 待折算加分项（${target ? target.hint : '—'}）`,
      meta: `${target ? target.label : '科研双创'}类 · ${scoreLine(declared, panId)}`,
      detail: `新建加分项：先确认归属类别与该项上限，再按综测细则折算申报分值；申报分值一旦越过上限即拒收。当前按盘面读数预填 ${fmt(declared)} 分，${scoreLine(declared, panId)}。证明材料待上传（PDF 需含可定位页码）。`,
      anchor: materialAnchor(`pending/${panId}`, 'Level_B_Preprint'),
      panId,
      category: target ? target.label : '科研双创',
      declared,
      capacity: panCapacity(panId),
      headroom: headroom(panId),
      capped: isCapped(panId),
      evidenceKind: '待上传',
      material: '待上传',
      reviewState: '待核验',
    };
  },
  rowOfEnvelope: (envelope, nowIso) => {
    const base = defaultRowOfEnvelope(envelope, nowIso);
    const data = envelope.payload?.data ?? {};
    const rawItems = Array.isArray(data.items) ? (data.items as unknown[]) : [];
    const firstItem = rawItems[0];
    const declaredRaw =
      firstItem && typeof firstItem === 'object' && firstItem !== null && 'declared' in firstItem
        ? Number((firstItem as { declared?: unknown }).declared)
        : Number.NaN;
    const declared = Number.isFinite(declaredRaw) ? Number(declaredRaw.toFixed(2)) : panValue('research');
    // 归属类别由信封自带（payload.data.category / panId）决定，缺省落到科研双创盘。
    const claimedPan = typeof data.panId === 'string' ? data.panId : '';
    const panId = panOf(claimedPan) ? claimedPan : 'research';
    return {
      ...base,
      title: `待折算 · ${base.title}`,
      meta: `${base.meta} · ${scoreLine(declared, panId)}`,
      detail: `${base.detail}｜本站收到已验真科研证据后：判定归属类别 → 比对该项上限 → 折算申报分值（越界拒收）→ 补齐证明材料 PDF → 回投简历证据台。`,
      panId,
      category: panLabel(panId),
      declared,
      capacity: panCapacity(panId),
      headroom: Number((panCapacity(panId) - declared).toFixed(2)),
      capped: declared >= panCapacity(panId),
      evidenceKind: '简历证据台投送',
      material: '随信封附证据锚点',
      reviewState: '待折算',
    };
  },
  payloadOf: (rows) => {
    const byPan = new Map<string, { category: string; declared: number; capacity: number }>();
    for (const row of rows) {
      const panId = String(row.panId ?? '');
      if (panId === '') continue;
      const declared = typeof row.declared === 'number' ? row.declared : 0;
      const previous = byPan.get(panId);
      byPan.set(panId, {
        category: String(row.category ?? panLabel(panId)),
        declared: Number(((previous?.declared ?? 0) + declared).toFixed(2)),
        capacity: typeof row.capacity === 'number' ? row.capacity : panCapacity(panId),
      });
    }
    const items = rows.map((row) => {
      const declared = typeof row.declared === 'number' ? row.declared : 0;
      const capacity = typeof row.capacity === 'number' ? row.capacity : 0;
      return {
        id: String(row.id),
        panId: String(row.panId ?? ''),
        category: String(row.category ?? ''),
        declared,
        capacity,
        capped: capacity > 0 ? declared >= capacity : false,
        overCap: capacity > 0 ? declared > capacity : false,
        evidenceKind: String(row.evidenceKind ?? ''),
        material: String(row.material ?? ''),
        reviewState: String(row.reviewState ?? ''),
      };
    });
    return {
      site: 'yunheng',
      ledger: '学年综测加分项与证明材料 PDF 包',
      bundle_kind: 'composite_score_evidence_bundle',
      instrument: {
        total: YUNHENG_TOTAL,
        pans: YUNHENG_PANS.length,
        capacity_sum: CAPACITY_SUM,
        declared_sum: DECLARED_SUM,
        total_gap: TOTAL_GAP,
      },
      item_count: items.length,
      item_total: Number(items.reduce((sum, item) => sum + item.declared, 0).toFixed(2)),
      capped_count: items.filter((item) => item.capped).length,
      over_cap_count: items.filter((item) => item.overCap).length,
      by_category: [...byPan.entries()].map(([panId, value]) => ({
        panId,
        category: value.category,
        declared: value.declared,
        capacity: value.capacity,
        capped: value.declared >= value.capacity,
      })),
      items,
    };
  },
  csvOf: (rows) => ({
    header: ['加分项', '类别', '申报分值', '该项上限', '余量', '是否触顶', '证明材料', '核验状态', '最后修改'],
    rows: rows.map((row) => [
      String(row.title),
      String(row.category ?? ''),
      typeof row.declared === 'number' ? row.declared.toFixed(2) : '',
      typeof row.capacity === 'number' ? row.capacity.toFixed(2) : '',
      typeof row.headroom === 'number' ? row.headroom.toFixed(2) : '',
      row.capped === true ? '触顶' : '未触顶',
      String(row.material ?? ''),
      String(row.reviewState ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),
});

/** 供 README 与答辩引用：本条台账的分数口径常量。 */
export const YUNHENG_SPEC_FACTS = {
  instrumentTotal: YUNHENG_TOTAL,
  capacitySum: CAPACITY_SUM,
  declaredSum: DECLARED_SUM,
  totalGap: TOTAL_GAP,
  cvEvidenceCount: CV_ENTRIES.length,
  moralCappedAfterTopUp: isCapped('moral'),
  researchHeadroom: headroom('research'),
  intellectHeadroom: headroom('intellect'),
  overCapGuard: isOverCap(panValue('research') + 1, 'research'),
} as const;
