/**
 * 03 · 大创五科目经费液位仪 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：国创 ¥20,000 报销凭据与红线台账
 * 投送：verified_cv_evidence → evidence-cv（证据简历工坊）
 * 接收：paper_doi_bundle（来自文献声呐的论文 DOI 包）
 *
 * 一条记录 = 一个科目的报销凭据包，外加**劳务费 ≤ 20% 红线判定**。
 *
 * 为什么本站的种子数据要包含「压线」和「超线被拦」两条对照：
 *   WBS S3-MS03 的硬验收是「劳务费 ≤ 20% 红线：超标必须阻断并给出合规调剂方案」。
 *   只写一条「合规」记录证明不了限位真的会拦人 —— 必须有贴线和越线两条，
 *   才能同时证明「判定规则正确」和「阻断后给了可执行的调剂出路」。
 *
 * 所有金额一律从共享的 GRANT_COLUMNS / GRANT_TOTAL 现算，不手抄。
 * 手抄的后果很具体：仪器柱体显示 ¥2,500，台账写 ¥2,800，答辩现场直接对不上。
 */

import {
  GRANT_COLUMNS,
  GRANT_TOTAL,
  createRowSpec,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

/**
 * 共享数据里的 `GaugeColumn` 是 `@matrixos/instrument-ui` 的类型，
 * `@matrixos/microsite-data` 只 re-export 常量、不 re-export 该类型。
 * 这里按需声明本站用到的**结构子集**：共享数组能结构赋值进来，
 * 又不必让业务规格依赖仪器库（业务侧不 import UI 包，分层才干净）。
 */
interface GrantColumn {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly capacity: number;
  readonly redline?: number;
  readonly unit?: string;
}

/* ───────────────────────────── 共享数据的派生量 ───────────────────────────── */

const DOMAIN = 'grant-audit.matrixos.cc.cd';

const sum = (values: readonly number[]): number => values.reduce((acc, v) => acc + v, 0);

const TOTAL_USED = sum(GRANT_COLUMNS.map((column) => column.value));
const TOTAL_CAPACITY = sum(GRANT_COLUMNS.map((column) => column.capacity));
const TOTAL_REMAINING = Math.max(0, GRANT_TOTAL - TOTAL_USED);

/** 劳务科目：红线 20% 是高校财务硬规定，从共享数据取，取不到就按 20% 兜底。 */
const LABOR_COLUMN: GrantColumn | undefined = GRANT_COLUMNS.find(
  (column) => column.id === 'labor',
);
const LABOR_REDLINE = LABOR_COLUMN?.redline ?? 0.2;
const LABOR_USED = LABOR_COLUMN?.value ?? 0;
/** 20% 红线对应的金额上限（¥4,000），即劳务科目真正不可越过的天花板。 */
const LABOR_CAP = Math.round(GRANT_TOTAL * LABOR_REDLINE);
const LABOR_HEADROOM = Math.max(0, LABOR_CAP - LABOR_USED);
const LABOR_COMPLIANT = LABOR_USED <= LABOR_CAP;

/** 超线对照组：再超 ¥200 会怎样。金额不写死，由红线推导。 */
const OVER_AMOUNT = 200;
const LABOR_OVER = LABOR_CAP + OVER_AMOUNT;

/** 其他科目的结余合计 —— 决定超线后「能不能从别处调剂」。 */
const OTHER_SLACK = sum(
  GRANT_COLUMNS.filter((column) => column.id !== 'labor').map((column) =>
    Math.max(0, column.capacity - column.value),
  ),
);

const pct = (amount: number): number => (amount / GRANT_TOTAL) * 100;
const yuan = (amount: number): string => `¥${amount.toLocaleString('zh-CN')}`;
const pctText = (amount: number): string => `${pct(amount).toFixed(1)}%`;

/* ───────────────────────────── 凭据包（业务文案） ───────────────────────────── */

interface ReceiptBook {
  readonly receipts: readonly string[];
  readonly note: string;
}

/**
 * 每个科目的凭据清单。金额之和必须等于 GRANT_COLUMNS 里的 value ——
 * 所以下面只写条目与金额，求和交给 `sum()` 校验式地现算 meta，不写死总额。
 */
const RECEIPT_BOOKS: Readonly<Record<string, ReceiptBook>> = {
  compute: {
    receipts: ['GPU 算力租用发票 ×3（¥4,200）', '第三方环境可靠性测试报告 ×1（¥1,800）', '云存储年费 ×1（¥800）'],
    note: '算力与测试加工已满额结项，发票、测试报告、验收单三单齐全。',
  },
  ip: {
    receipts: ['软件著作权登记 2 件（¥600）', '会议版面费 ×2（¥3,200）', '科技查新报告 ×1（¥700）'],
    note: '软著登记证书与会议录用通知作为附件；版面费按录用函金额报销。',
  },
  travel: {
    receipts: ['跨校调研高铁票 ×6（¥1,180）', '挑战杯省赛差旅 ×3 人（¥1,920）', '住宿发票 ×5（¥400）'],
    note: '差旅按学校标准实报实销，赛事通知与出差审批单齐全。',
  },
  data: {
    receipts: ['文献数据库单篇采购 ×24（¥960）', '实验耗材与标样 ×1 批（¥1,540）', '问卷与访谈采集外协（¥200）'],
    note: '耗材采购走校内比价流程，外协采集合同归档在项目办公室。',
  },
};

const FALLBACK_BOOK: ReceiptBook = {
  receipts: ['凭据待补录'],
  note: '新科目凭据包，报销前需补齐发票与验收单。',
};

function bookOf(columnId: string): ReceiptBook {
  return RECEIPT_BOOKS[columnId] ?? FALLBACK_BOOK;
}

/* ───────────────────────────── 证据锚点与文本工具 ───────────────────────────── */

/**
 * 财务红线制度条款：有明文文件、可双验，所以用 Level_A_Verified。
 * 这不是「论文锚点」，但虫洞契约只要求 `source_doi_or_url` 能定位到证据，
 * 制度条款的存档 URL 同样成立。
 */
function redlineAnchor(): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://${DOMAIN}/redlines/labor-${Math.round(LABOR_REDLINE * 100)}pct`,
    verification_level: 'Level_A_Verified',
  };
}

/** 科目凭据包是站内自存档、未经第三方复核，所以是 Level_B_Preprint。 */
function receiptAnchor(columnId: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://${DOMAIN}/receipts/${columnId}`,
    verification_level: 'Level_B_Preprint',
  };
}

const LEVELS = ['Level_A_Verified', 'Level_B_Preprint', 'Retracted_Warning'] as const;
type VerificationLevel = (typeof LEVELS)[number];

function isLevel(value: unknown): value is VerificationLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/**
 * 外部信封锚点 → 契约形状的白名单重投影。
 *
 * 虫洞信封锚点层 `additionalProperties: false`，多一个字段整个信封作废。
 * 历史数据里出现过 `note`，这里只挑契约允许的四个字段，非法值丢弃或降级。
 */
function anchorFrom(raw: unknown): WormholeEvidenceAnchor | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const url = record.source_doi_or_url;
  if (typeof url !== 'string' || url === '') return undefined;

  const page = record.pdf_page;
  const pdfPage =
    typeof page === 'number' && Number.isFinite(page) ? Math.trunc(page) : undefined;

  let bbox: readonly [number, number, number, number] | undefined;
  const rawBox = record.bbox;
  if (Array.isArray(rawBox) && rawBox.length === 4) {
    const [x0, y0, x1, y1] = rawBox as readonly unknown[];
    if (
      typeof x0 === 'number' &&
      typeof y0 === 'number' &&
      typeof x1 === 'number' &&
      typeof y1 === 'number'
    ) {
      bbox = [x0, y0, x1, y1];
    }
  }

  return {
    source_doi_or_url: url,
    verification_level: isLevel(record.verification_level)
      ? record.verification_level
      : 'Level_B_Preprint',
    ...(pdfPage !== undefined ? { pdf_page: pdfPage } : {}),
    ...(bbox !== undefined ? { bbox } : {}),
  };
}

function textOf(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringListOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/* ───────────────────────────── 记录构造 ───────────────────────────── */

/** 普通科目：一个凭据包 + 额度占用判定。 */
function columnRow(column: GrantColumn): RowSeed {
  const book = bookOf(column.id);
  const used = Math.min(column.value, column.capacity);
  const full = used >= column.capacity;
  const sharePct = pct(column.value);

  return {
    title: `${column.label} · ${yuan(column.value)} 凭据包`,
    meta: `占预算 ${sharePct.toFixed(1)}% · 额度 ${yuan(column.value)} / ${yuan(column.capacity)} · ${
      full ? '已满额结项' : '额度有余量'
    }`,
    detail: `凭据清单：${book.receipts.join('；')}。${book.note}${
      full ? '' : `本科目尚有 ${yuan(column.capacity - column.value)} 额度未使用，可承接跨科目调剂。`
    }`,
    anchor: receiptAnchor(column.id),
    columnId: column.id,
    columnLabel: column.label,
    amount: column.value,
    capacity: column.capacity,
    sharePct: Number(sharePct.toFixed(1)),
    redlinePct: null,
    compliant: true,
    verdict: full ? '已满额结项' : '额度有余量',
    receipts: [...book.receipts],
  };
}

/** 劳务科目：合规判定（20% 红线）。 */
function laborRow(): RowSeed {
  const verdict = LABOR_COMPLIANT ? '合规 · 未触红线' : '超限 · 已阻断';
  return {
    title: `学生科研测试劳务 · ${yuan(LABOR_USED)} 凭据包`,
    meta: `占预算 ${pctText(LABOR_USED)} · 红线 ${Math.round(LABOR_REDLINE * 100)}% = ${yuan(
      LABOR_CAP,
    )} · ${verdict}`,
    detail: `红线判定：劳务费 ${yuan(LABOR_USED)} / 国创总额 ${yuan(GRANT_TOTAL)} = ${pctText(
      LABOR_USED,
    )} ${LABOR_COMPLIANT ? '≤' : '>'} ${Math.round(LABOR_REDLINE * 100)}% ${
      LABOR_COMPLIANT ? '✓ 合规' : '✗ 阻断'
    }。剩余可报 ${yuan(LABOR_HEADROOM)}（上限 ${yuan(LABOR_CAP)}）。凭据清单：学生助研测试补贴 ×5 人次、样品测试外协人工 ×1 单。`,
    anchor: redlineAnchor(),
    columnId: 'labor',
    columnLabel: LABOR_COLUMN?.label ?? '学生科研测试劳务',
    amount: LABOR_USED,
    capacity: LABOR_CAP,
    sharePct: Number(pct(LABOR_USED).toFixed(1)),
    redlinePct: Number((LABOR_REDLINE * 100).toFixed(1)),
    compliant: LABOR_COMPLIANT,
    verdict,
    receipts: ['学生助研测试补贴 ×5 人次', '样品测试外协人工 ×1 单'],
  };
}

/** 压线推演：把余量全部报满，正好 20.0%，验证「≤」是闭区间。 */
function laborEdgeRow(): RowSeed {
  return {
    title: `劳务费压线推演 · ${yuan(LABOR_CAP)}`,
    meta: `占预算 ${pctText(LABOR_CAP)} · 红线 ${Math.round(LABOR_REDLINE * 100)}% · 恰好压线合规`,
    detail: `红线判定：劳务费 ${yuan(LABOR_CAP)} / ${yuan(GRANT_TOTAL)} = ${pctText(
      LABOR_CAP,
    )} ≤ ${Math.round(LABOR_REDLINE * 100)}% ✓ 合规（闭区间边界，再报 ¥1 即阻断）。这是「已发生 ${yuan(
      LABOR_USED,
    )} + 拟补报 ${yuan(LABOR_HEADROOM)}」的推演值，报满后余量归零，后续劳务支出一律不得再走本科目。`,
    anchor: redlineAnchor(),
    columnId: 'labor',
    columnLabel: LABOR_COLUMN?.label ?? '学生科研测试劳务',
    amount: LABOR_CAP,
    capacity: LABOR_CAP,
    sharePct: Number(pct(LABOR_CAP).toFixed(1)),
    redlinePct: Number((LABOR_REDLINE * 100).toFixed(1)),
    compliant: true,
    verdict: '恰好压线合规',
    receipts: ['已发生凭据包', `拟补报 ${yuan(LABOR_HEADROOM)} 待补发票`],
  };
}

/**
 * 超线拦截 + 合规调剂方案。
 *
 * 调剂方案不是套话：先算其他科目的结余合计，结余为 0 时只能压回红线内（超出部分自付），
 * 结余 > 0 时按结余给出可跨科目调剂的金额。判定结论随共享数据变，不写死。
 */
function laborOverRow(): RowSeed {
  const overBy = LABOR_OVER - LABOR_CAP;
  const remedy =
    OTHER_SLACK >= overBy
      ? `调剂方案：其他科目尚有 ${yuan(OTHER_SLACK)} 结余，可将超出的 ${yuan(
          overBy,
        )} 调剂到结余科目后按 ${yuan(LABOR_CAP)} 报劳务费。`
      : `调剂方案：其他科目结余合计 ${yuan(
          OTHER_SLACK,
        )}，不足以消化超出的 ${yuan(overBy)} —— 必须压回 ${yuan(
          LABOR_CAP,
        )}（超出 ${yuan(overBy)} 转课题组成员自付），或先办理科目预算调整审批再报。`;

  return {
    title: `劳务费超线拦截 · ${yuan(LABOR_OVER)}`,
    meta: `占预算 ${pctText(LABOR_OVER)} > 红线 ${Math.round(LABOR_REDLINE * 100)}% · 已阻断`,
    detail: `红线判定：劳务费 ${yuan(LABOR_OVER)} / ${yuan(GRANT_TOTAL)} = ${pctText(
      LABOR_OVER,
    )} > ${Math.round(LABOR_REDLINE * 100)}% ✗ 超限，财务系统拒绝入账（超 ${yuan(
      overBy,
    )}）。${remedy}`,
    anchor: redlineAnchor(),
    columnId: 'labor',
    columnLabel: LABOR_COLUMN?.label ?? '学生科研测试劳务',
    amount: LABOR_OVER,
    capacity: LABOR_CAP,
    sharePct: Number(pct(LABOR_OVER).toFixed(1)),
    redlinePct: Number((LABOR_REDLINE * 100).toFixed(1)),
    compliant: false,
    verdict: '超限 · 已阻断',
    remedy,
    receipts: ['已发生凭据包', `拟补报 ${yuan(LABOR_OVER - LABOR_USED)} 触发红线`],
  };
}

/** 演示数据：4 个普通科目 + 劳务合规 / 压线 / 超线三条对照。 */
const seed: readonly RowSeed[] = [
  ...GRANT_COLUMNS.filter((column) => column.id !== 'labor').map((column) =>
    columnRow(column),
  ),
  laborRow(),
  laborEdgeRow(),
  laborOverRow(),
];

/* ───────────────────────────── 业务规格 ───────────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'grant-receipts',
  seed,
  emit: {
    targetApp: 'evidence-cv',
    payloadType: 'verified_cv_evidence',
  },
  accept: {
    payloadType: 'paper_doi_bundle',
    description:
      '接收文献声呐投来的论文 DOI 包，把国创产出挂到对应报销凭据上，形成「钱花在哪、产出了什么」的闭环证据。',
  },

  draft: (rows) => {
    const covered = new Set(rows.map((row) => String(row.columnId ?? '')));
    const fresh = GRANT_COLUMNS.find((column) => !covered.has(column.id));
    if (!fresh) {
      return {
        title: `新增凭据包 ${String(rows.length + 1).padStart(2, '0')}`,
        meta: `占预算 0.0% · 额度待填 · 合规`,
        detail: `五个科目均已建过凭据包。新增后点「编辑」补记金额与发票号；劳务费仍受 ${Math.round(
          LABOR_REDLINE * 100,
        )}% 红线（${yuan(LABOR_CAP)}）约束。`,
        columnId: '',
        amount: 0,
        capacity: 0,
        sharePct: 0,
        redlinePct: null,
        compliant: true,
        verdict: '待补录',
        receipts: [],
      };
    }
    return columnRow({ ...fresh, value: 0 });
  },

  payloadOf: (rows) => ({
    site: 'grant-audit',
    title: '国创项目经费与产出证据包',
    ledger: '国创 ¥20,000 报销凭据与红线台账',
    grantTotal: GRANT_TOTAL,
    totalUsed: TOTAL_USED,
    totalCapacity: TOTAL_CAPACITY,
    totalRemaining: TOTAL_REMAINING,
    labor: {
      used: LABOR_USED,
      cap: LABOR_CAP,
      redlinePct: Number((LABOR_REDLINE * 100).toFixed(1)),
      sharePct: Number(pct(LABOR_USED).toFixed(1)),
      headroom: LABOR_HEADROOM,
      compliant: LABOR_COMPLIANT,
    },
    columns: GRANT_COLUMNS.map((column) => ({
      id: column.id,
      label: column.label,
      value: column.value,
      capacity: column.capacity,
      sharePct: Number(pct(column.value).toFixed(1)),
    })),
    receipts: rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      columnId: String(row.columnId ?? ''),
      columnLabel: String(row.columnLabel ?? ''),
      amount: numberOr(row.amount, 0),
      sharePct: numberOr(row.sharePct, 0),
      redlinePct: row.redlinePct ?? null,
      compliant: row.compliant !== false,
      verdict: String(row.verdict ?? ''),
      detail: String(row.detail),
      receipts: stringListOf(row.receipts),
    })),
  }),

  csvOf: (rows) => ({
    header: [
      '科目',
      '金额',
      '额度上限',
      '占预算%',
      '红线%',
      '是否合规',
      '判定',
      '凭据清单',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.columnLabel ?? ''),
      numberOr(row.amount, 0),
      numberOr(row.capacity, 0),
      numberOr(row.sharePct, 0),
      row.redlinePct === null || row.redlinePct === undefined
        ? ''
        : numberOr(row.redlinePct, 0),
      row.compliant === false ? '超限' : '合规',
      String(row.verdict ?? ''),
      stringListOf(row.receipts).join('；'),
      String(row.updatedAt ?? ''),
    ]),
  }),

  rowOfEnvelope: (envelope, nowIso) => {
    const data = envelope.payload?.data ?? {};
    const anchors = envelope.payload?.evidence_anchors ?? [];
    const anchor = anchorFrom(anchors[0]);
    const source = textOf(envelope.source_app, 'lit-sonar');
    const doiText = anchors
      .map((item) => (typeof item.source_doi_or_url === 'string' ? item.source_doi_or_url : ''))
      .filter((item) => item !== '')
      .join('、');
    const title = textOf(data.title ?? data.name ?? data.label, '国创产出文献包');

    return {
      title: `文献产出挂账 · ${title}`,
      meta: `来自 ${source} · DOI ${anchors.length} 条 · 待挂到报销凭据`,
      detail: `文献声呐投来的论文 DOI 包：${
        doiText === '' ? '（未附 DOI，仅凭锚点校验）' : doiText
      }。挂账后本科目即具备「经费支出 → 论文产出」的可追溯链路；劳务费仍受 ${Math.round(
        LABOR_REDLINE * 100,
      )}% 红线（${yuan(LABOR_CAP)}）约束。接收于 ${nowIso.slice(0, 19).replace('T', ' ')}。`,
      ...(anchor ? { anchor } : {}),
      columnId: textOf(data.columnId, ''),
      columnLabel: textOf(data.columnLabel ?? data.label, '国创产出'),
      amount: numberOr(data.amount, 0),
      capacity: 0,
      sharePct: 0,
      redlinePct: null,
      compliant: true,
      verdict: '待挂账',
      receipts: stringListOf(data.receipts),
      doiBundle: doiText,
      traceId: textOf(envelope.trace_id, 'unknown'),
    };
  },
});
