/**
 * 10 · PDF 公式与参量狙击镜 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：高亮批注、公式符号表与难例卡片
 * 投送：comparison_matrix_row → review-lab（14 综述拓扑推演与写作舱）
 * 接收：paper_doi_bundle ← lit-sonar（05 五源跨库引文声呐）
 *
 * 一条记录 = **一个公式 / 参量卡片**，四件事同时挂在上面：
 *   1. 公式本体（LaTeX + 可直接读的纯文本 + Python 求解代码）；
 *   2. 物理量纲与符号表（「这个符号单位是什么」是本站的第一性问题）；
 *   3. PDF 定位（`pdf_page` + `bbox`，这是本站区别于其它台账站的核心特色：
 *      任何一条卡片都要能点回原文的某一页某一块区域）；
 *   4. 绑定摘录（PDF 原文里那句把公式讲清楚的话）。
 *
 * 为什么这么写：
 *   卡片数据全部由共享演示数据 `FORMULAS` / `PDF_SNIPPETS` / `PAPER_ROWS` 当场算出，
 *   一个数字都不手抄。手抄就会出现「瞄准镜右栏显示 R² = 0.9884、台账写 0.98」
 *   这类答辩事故。难度、符号数、坐标面积、摘录数值也全是派生量。
 *
 * 关于 bbox（必须说清楚，别让人以为是真解析出来的）：
 *   共享演示数据只给了「论文级」锚点（`PAPER_ROWS[].anchor.bbox` 是 Fig. 2b 那块图），
 *   没有逐公式的坐标。所以本站的公式 bbox 是**确定性排版推算**：
 *   页宽 / 页高 / 左边距取 A4 与 `PAPER_ROWS` 里那条真实锚点一致的 1 inch（72.5pt），
 *   y 起点 = 版心顶边 + 摘录段落占的行数 × 行距 + 段后间距，
 *   宽 = 公式纯文本长度 × 平均字宽（封顶版心宽），高 = 含 `\frac` 的展示式更高。
 *   页码是**真的**（来自 `PDF_SNIPPETS[].page`），bbox 是推算的，记录里用
 *   `bboxSource: 'layout_estimate'` 明写，绝不冒充 PDF 解析结果。
 *   接真实 PDF 解析（pdf.js getTextContent）时只换 `bboxOf()` 一个函数，接口不变。
 *
 * 锚点注意：
 *   共享数据里的锚点是 SDK 的 camelCase 形状
 *   （`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel`，还多带一个 `note`），
 *   而虫洞信封契约的锚点层是 `additionalProperties: false` 的 snake_case。
 *   本站的锚点是自己按契约拼的（DOI 来自 `PAPER_ROWS`，页码来自 `PDF_SNIPPETS`，
 *   坐标由 `bboxOf()` 算），从头到尾不出现 `note` 字段 —— 多一个字段，整个信封就过不了
 *   `specs/contracts/wormhole-envelope.schema.json`。
 */

import {
  FORMULAS,
  PAPER_ROWS,
  PDF_SNIPPETS,
  createRowSpec,
  type FormulaEntry,
  type PaperRow,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

/* ───────────────────────── 展示格式（确定性） ─────────────────────────
 * 不用 toLocaleString：Node 与浏览器的 ICU 版本可能不同，服务端预渲染与客户端首帧
 * 文本一旦不一致就是 React #418 水合报错。手写格式化最稳。
 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function fmtOne(value: number): string {
  return round1(value).toFixed(1);
}

/** 千分位（坐标面积用），手写不用 Intl。 */
function fmtInt(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const LEDGER_NAME = '高亮批注、公式符号表与难例卡片';

/* ───────────────────────── PDF 版心常量与坐标推算 ───────────────────────── */

/** A4 纸尺寸（pt）。PDF 内部坐标一律是 pt，不是 px。 */
const PAGE_WIDTH_PT = 595.28;
const PAGE_HEIGHT_PT = 841.89;
/** 左边距取 1 inch —— 与 `PAPER_ROWS` 里 Fig. 2b 锚点的 x0 = 72.5 完全一致。 */
const MARGIN_X_PT = 72.5;
const MARGIN_TOP_PT = 72;
/** 版心宽：595.28 - 72.5 × 2 = 450.28pt。 */
const CONTENT_WIDTH_PT = round1(PAGE_WIDTH_PT - MARGIN_X_PT * 2);
/** 10.5pt 正文 × 1.37 行距。 */
const BODY_LINE_PT = 14.4;
/** 版心宽 450.28pt ÷ 平均字宽 5.77pt。 */
const BODY_CHARS_PER_LINE = 78;
/** 摘录段与下方展示式之间的间距。 */
const FORMULA_GAP_PT = 12;
/** 单行展示式行高。 */
const FORMULA_LINE_PT = 20;
/** 含分式（\frac）的展示式是双层的，更高。 */
const FRACTION_LINE_PT = 34;
/** 10.5pt 数学字体的平均字宽。 */
const GLYPH_PT = 5.8;

type BBox = readonly [number, number, number, number];

/** 公式 bbox 的推算来源标记：明写「这是排版推算，不是 PDF 解析结果」。 */
const BBOX_SOURCE = 'layout_estimate' as const;

/**
 * 摘录段在页面上占几行（向上取整，至少一行）。
 * 纯函数：同一段文本永远给同一个行数。
 */
function bodyLinesOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / BODY_CHARS_PER_LINE));
}

/**
 * 公式展示式在原文里的坐标框 [x0, y0, x1, y1]（pt，左上原点）。
 *
 * 推算规则（全部由真实数据驱动，没有魔法数以外的假设）：
 *   - 公式紧跟在摘录段下方：y0 = 版心顶边 + 摘录占行 × 行距 + 段后间距；
 *   - 宽 = 纯文本长度 × 平均字宽，封顶版心宽、下限 96pt（短公式也要能点中）；
 *   - 高 = 含 `\frac` 的公式 34pt，其余 20pt。
 */
function bboxOf(text: string, formula: FormulaEntry): BBox {
  const lines = bodyLinesOf(text);
  const y0 = round1(MARGIN_TOP_PT + lines * BODY_LINE_PT + FORMULA_GAP_PT);
  const width = Math.min(CONTENT_WIDTH_PT, Math.max(96, formula.plain.length * GLYPH_PT));
  const height = formula.latex.includes('\\frac') ? FRACTION_LINE_PT : FORMULA_LINE_PT;
  return [MARGIN_X_PT, y0, round1(MARGIN_X_PT + width), round1(y0 + height)];
}

/** 坐标框面积（pt²）：`bbox` 的真实用法是「这个公式占了原文多大一块」。 */
function areaOf(bbox: BBox): number {
  return Math.round((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
}

/* ───────────────────────── 源论文（DOI 与证据等级） ───────────────────────── */

const SNIPPET_PAGES: readonly number[] = PDF_SNIPPETS.map((snippet) => snippet.page);

/**
 * 被狙击的那篇 PDF：取「页码能对上摘录」的那篇论文。
 * 演示数据里 `PDF_SNIPPETS` 的三段原文（TRPL / EQE / R²）都出自
 * `PAPER_ROWS` 第一篇 Nat. Photon. 2025 的 Fig. 2b，所以按页码匹配是可靠的。
 */
const SOURCE_PAPER: PaperRow | undefined =
  PAPER_ROWS.find((paper) => {
    const page = paper.anchor.pdfPage;
    return typeof page === 'number' && SNIPPET_PAGES.includes(page);
  }) ?? PAPER_ROWS[0];

const SOURCE_DOI = SOURCE_PAPER?.anchor.sourceDoiOrUrl ?? 'https://pdf-sniper.matrixos.edu/';
/** 论文本身的验证等级是共享数据里的既成事实，不在这里改判。 */
const SOURCE_LEVEL = SOURCE_PAPER?.anchor.verificationLevel ?? 'Level_B_Preprint';
const SOURCE_VENUE = SOURCE_PAPER?.venue ?? '待绑定期刊';

/* ───────────────────────── 锚点（snake_case，绝无 note） ───────────────────────── */

/**
 * 公式卡的证据锚点：DOI + 验证等级（来自论文）+ 页码（来自摘录）+ 坐标（排版推算）。
 * `pdf_page` / `bbox` 只在有值时出现 —— 契约层不接受 `undefined` 占位。
 */
function cardAnchor(snippetPage: number, bbox: BBox): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: SOURCE_DOI,
    verification_level: SOURCE_LEVEL,
    pdf_page: snippetPage,
    bbox,
  };
}

/** 尚未绑定 PDF 的新卡：锚点退化到站内待定位清单页（Level B，绝不冒充已定位）。 */
function pendingAnchor(slug: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://pdf-sniper.matrixos.edu/cards/${slug}`,
    verification_level: 'Level_B_Preprint',
  };
}

/* ───────────────────────── 符号表（量纲拆解） ───────────────────────── */

/**
 * 符号表 = 量纲说明按中文分号拆开。
 * `dimension` 字段本身就是「符号 → 单位 / 含义」的逐条罗列，直接拆比正则解析公式可靠：
 *   f1 → ['A₁, A₂ 无量纲（归一化强度）', 'τ₁, τ₂ 单位 ns']
 *   f3 → ['J_sc 单位 A/m²', 'q = 1.602×10⁻¹⁹ C', 'Φ 为单位面积光子通量']
 */
function symbolsOf(formula: FormulaEntry): readonly string[] {
  const parts = formula.dimension
    .split(/[；;]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts : [formula.dimension];
}

/* ───────────────────────── 高亮批注：摘录里的数值 ───────────────────────── */

/** 从 PDF 原文摘录里抠出数值（14.2 / 89.5 / 0.9884 …）—— 这些才是要荧光笔标的。 */
function numbersOf(text: string): readonly string[] {
  const matched = text.match(/-?\d+(?:\.\d+)?/g);
  return matched === null ? [] : matched;
}

/* ───────────────────────── 难例判定（派生量，不手写标签） ───────────────────────── */

interface Difficulty {
  readonly score: number;
  readonly label: string;
  readonly reasons: readonly string[];
}

/**
 * 难度打分：只看公式结构与求解代码，不看主观感觉。
 * 含分式 / 求和 / 拟合量估计（\hat、\bar）/ 下标量纲 / 多行代码，各 +1。
 */
function difficultyOf(formula: FormulaEntry): Difficulty {
  const reasons: string[] = [];
  if (formula.latex.includes('\\frac')) reasons.push('含分式');
  if (formula.latex.includes('\\sum')) reasons.push('含求和');
  if (formula.latex.includes('\\hat') || formula.latex.includes('\\bar')) reasons.push('含拟合量估计');
  if (formula.latex.includes('_')) reasons.push('含下标量纲');
  if (formula.python.includes('\n')) reasons.push('求解代码多行');
  const score = reasons.length;
  const label = score >= 4 ? '难例' : score >= 2 ? '进阶' : '基础';
  return { score, label, reasons };
}

/* ───────────────────────── 公式编号与图号 ───────────────────────── */

function formulaNoOf(formulaId: string): number {
  const index = FORMULAS.findIndex((formula) => formula.id === formulaId);
  return index >= 0 ? index + 1 : 0;
}

function figureOf(formulaId: string): string {
  const no = formulaNoOf(formulaId);
  return no > 0 ? `Eq. (${no})` : 'Eq. (待编号)';
}

/* ───────────────────────── 公式 → 台账记录 ───────────────────────── */

function cardSeed(formula: FormulaEntry): RowSeed {
  const snippet = PDF_SNIPPETS.find((item) => item.formulaId === formula.id);
  const page = typeof snippet?.page === 'number' ? snippet.page : 1;
  const text = snippet?.text ?? '（本公式尚未绑定 PDF 原文摘录）';
  const bbox = bboxOf(text, formula);
  const area = areaOf(bbox);
  const symbols = symbolsOf(formula);
  const numbers = numbersOf(text);
  const difficulty = difficultyOf(formula);
  const figure = figureOf(formula.id);
  const pythonLines = formula.python.split('\n').length;

  const title = `${figure} · ${formula.plain}`;

  const meta = [
    `P.${page}`,
    `bbox [${bbox.join(', ')}]`,
    `${fmtInt(area)} pt²`,
    `符号 ${symbols.length} 条`,
    `难度 ${difficulty.label}（${difficulty.score}）`,
    `代码 ${pythonLines} 行`,
  ].join(' · ');

  const detail = [
    `量纲：${formula.dimension}`,
    `符号表：${symbols.map((symbol, index) => `${index + 1}. ${symbol}`).join(' / ')}`,
    `PDF 定位：P.${page} · bbox [${bbox.join(', ')}] · 坐标面积 ${fmtInt(area)} pt² · 来源 ${BBOX_SOURCE}`,
    `原文摘录：${text}`,
    numbers.length > 0
      ? `高亮批注：本页摘录含 ${numbers.length} 个数值（${numbers.join(' / ')}），荧光笔已标在这些数上`
      : '高亮批注：本页摘录是文字说明，没有独立数值，批注落在公式符号本身',
    `物理含义：${formula.explanation}`,
    `求解代码：${formula.python.split('\n')[0]} …（共 ${pythonLines} 行）`,
    `难例判定：${difficulty.label} —— ${difficulty.reasons.join('、')}`,
  ].join('；');

  return {
    title,
    meta,
    detail,
    anchor: cardAnchor(page, bbox),
    formulaId: formula.id,
    formulaNo: formulaNoOf(formula.id),
    figure,
    latex: formula.latex,
    plain: formula.plain,
    dimension: formula.dimension,
    explanation: formula.explanation,
    python: formula.python,
    pythonLines,
    symbols: [...symbols],
    symbolCount: symbols.length,
    snippetId: snippet?.id ?? '',
    snippetPage: page,
    snippetText: text,
    highlightNumbers: [...numbers],
    pdfPage: page,
    bbox: [...bbox],
    bboxArea: area,
    bboxSource: BBOX_SOURCE,
    difficultyScore: difficulty.score,
    difficultyLabel: difficulty.label,
    difficultyReasons: [...difficulty.reasons],
    sourceDoi: SOURCE_DOI,
    sourceVenue: SOURCE_VENUE,
    verificationLevel: SOURCE_LEVEL,
  } satisfies RowSeed;
}

const seed: readonly RowSeed[] = FORMULAS.map((formula) => cardSeed(formula));

const CARD_COUNT = seed.length;
const TOTAL_SYMBOLS = seed.reduce((total, card) => total + Number(card.symbolCount ?? 0), 0);
const HARD_CASES = seed.filter((card) => card.difficultyLabel === '难例').length;

/* ───────────────────────── 业务规格 ───────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'formula-cards',
  seed,
  emit: {
    targetApp: 'review-lab',
    payloadType: 'comparison_matrix_row',
  },
  accept: {
    payloadType: 'paper_doi_bundle',
    description:
      '接收文献声呐（lit-sonar）投来的论文包，落成一张「待狙击卡」：包里的 DOI 先登记进卡片，之后逐篇打开 PDF、框选公式区域，把页码与坐标补上，这张卡才算定位完成、才能作为对比矩阵的一行投送给综述舱。',
  },

  /** 新增一张 = 「待狙击卡」：还没有 PDF、没有页码、没有坐标，先占位。 */
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `待狙击卡 ${next} · 未绑定 PDF`,
      meta: ['P.—', 'bbox 未定位', '坐标面积 0 pt²', '符号 0 条', '难度 基础（0）', '代码 0 行'].join(' · '),
      detail: [
        '量纲：待框选公式后自动带出',
        '符号表：待从公式里拆解，一个符号都没有就先别投送',
        'PDF 定位：未绑定 —— 打开原文、框选公式区域后才会写入 pdf_page 与 bbox',
        '原文摘录：待绑定',
        '高亮批注：待绑定 PDF 后才有可标注的对象',
        '物理含义：待补',
        '求解代码：待补',
        '难例判定：待定 —— 没有公式结构就没有难度分',
      ].join('；'),
      anchor: pendingAnchor(`pending-${next}`),
      formulaId: `draft-${next}`,
      formulaNo: 0,
      figure: 'Eq. (待编号)',
      latex: '',
      plain: '待框选',
      dimension: '',
      explanation: '',
      python: '',
      pythonLines: 0,
      symbols: [],
      symbolCount: 0,
      snippetId: '',
      snippetPage: 0,
      snippetText: '',
      highlightNumbers: [],
      pdfPage: 0,
      bbox: [],
      bboxArea: 0,
      bboxSource: 'unbound' as const,
      difficultyScore: 0,
      difficultyLabel: '基础',
      difficultyReasons: [],
      sourceDoi: '',
      sourceVenue: '待绑定期刊',
      verificationLevel: 'Level_B_Preprint',
    } satisfies RowSeed;
  },

  /** 收到论文包：落成一张「待狙击卡」，把 DOI 清单留在记录里等逐篇定位。 */
  rowOfEnvelope: (envelope) => {
    const data = envelope.payload.data;
    const anchors: readonly WormholeEvidenceAnchor[] = Array.isArray(envelope.payload.evidence_anchors)
      ? envelope.payload.evidence_anchors
      : [];
    const firstAnchor = anchors[0];
    const anchor = firstAnchor ?? pendingAnchor(`inbox-${String(envelope.trace_id).slice(0, 8)}`);

    const rawDois = Array.isArray(data.doiBundle)
      ? data.doiBundle
      : Array.isArray(data.dois)
        ? data.dois
        : [];
    const dois = rawDois.map((doi) => String(doi)).filter((doi) => doi !== '');
    const sourceApp = String(envelope.source_app ?? 'lit-sonar');
    const traceShort = String(envelope.trace_id).slice(0, 8);
    const collectionCount = Number(data.collectionCount ?? 0);

    return {
      title: `待狙击 · 论文包 ${String(dois.length).padStart(2, '0')} 篇`,
      meta: [
        'P.—',
        `来源 ${sourceApp}`,
        `DOI ${dois.length} 个`,
        collectionCount > 0 ? `收藏夹 ${collectionCount} 个` : '单篇投送',
        `锚点 ${anchors.length} 条`,
      ].join(' · '),
      detail: [
        `接收 ${String(envelope.payload_type ?? 'paper_doi_bundle')} · 来源 ${sourceApp} · trace ${traceShort}`,
        dois.length > 0
          ? `待狙击 DOI：${dois.slice(0, 3).join('、')}${dois.length > 3 ? ' 等' : ''}`
          : '论文包未携带 DOI，需回站内补检索',
        '下一步：逐篇打开 PDF → 框选公式区域 → 自动写入 pdf_page 与 bbox → 补量纲与符号表',
        `证据锚点取自投来信封（${anchors.length} 条），未定位前锚点只能是 Level B`,
      ].join('；'),
      anchor,
      formulaId: `ext-${traceShort}`,
      formulaNo: 0,
      figure: 'Eq. (待编号)',
      latex: '',
      plain: '待框选',
      dimension: '',
      explanation: '',
      python: '',
      pythonLines: 0,
      symbols: [],
      symbolCount: 0,
      snippetId: '',
      snippetPage: 0,
      snippetText: '',
      highlightNumbers: [],
      pdfPage: typeof anchor.pdf_page === 'number' ? anchor.pdf_page : 0,
      bbox: Array.isArray(anchor.bbox) ? [...anchor.bbox] : [],
      bboxArea:
        Array.isArray(anchor.bbox) && anchor.bbox.length === 4
          ? areaOf(anchor.bbox as BBox)
          : 0,
      bboxSource: Array.isArray(anchor.bbox) && anchor.bbox.length === 4 ? 'from_envelope' : 'unbound',
      difficultyScore: 0,
      difficultyLabel: '基础',
      difficultyReasons: [],
      sourceDoi: dois[0] ?? '',
      sourceVenue: '待绑定期刊',
      verificationLevel: anchor.verification_level,
      receivedFrom: sourceApp,
      traceId: String(envelope.trace_id),
      doiBundle: dois,
    } satisfies RowSeed;
  },

  /**
   * 投送载荷：`comparison_matrix_row` 是「一行」。
   * 14 综述舱读的是扁平字段 `doi` + `figure`（见 14 站 rowOfEnvelope），
   * 所以这两个字段必须放在顶层，不能只塞进 `card` 里。
   */
  payloadOf: (rows) => {
    const cards = rows.map((row) => ({
      id: String(row.id),
      formulaId: String(row.formulaId ?? ''),
      formulaNo: Number(row.formulaNo ?? 0),
      figure: String(row.figure ?? ''),
      plain: String(row.plain ?? ''),
      latex: String(row.latex ?? ''),
      dimension: String(row.dimension ?? ''),
      symbols: Array.isArray(row.symbols) ? row.symbols.map((item) => String(item)) : [],
      symbolCount: Number(row.symbolCount ?? 0),
      snippetPage: Number(row.snippetPage ?? 0),
      snippetText: String(row.snippetText ?? ''),
      highlightNumbers: Array.isArray(row.highlightNumbers)
        ? row.highlightNumbers.map((item) => String(item))
        : [],
      pdfPage: Number(row.pdfPage ?? 0),
      bbox: Array.isArray(row.bbox) ? row.bbox.map((item) => Number(item)) : [],
      bboxArea: Number(row.bboxArea ?? 0),
      bboxSource: String(row.bboxSource ?? ''),
      difficultyScore: Number(row.difficultyScore ?? 0),
      difficultyLabel: String(row.difficultyLabel ?? ''),
      sourceDoi: String(row.sourceDoi ?? ''),
      verificationLevel: String(row.verificationLevel ?? ''),
    }));

    // 焦点卡 = 难度分最高的那张（同分取页码靠前的）。综述舱优先要难例。
    const focused = cards.reduce<(typeof cards)[number] | undefined>((best, card) => {
      if (best === undefined) return card;
      if (card.difficultyScore > best.difficultyScore) return card;
      if (card.difficultyScore === best.difficultyScore && card.pdfPage < best.pdfPage) return card;
      return best;
    }, undefined);

    return {
      site: 'pdf-sniper',
      ledger: LEDGER_NAME,
      target: 'review-lab',
      bundle_kind: 'formula_card_row',
      cardCount: cards.length,
      formulaCount: FORMULAS.length,
      snippetCount: PDF_SNIPPETS.length,
      hardCaseCount: cards.filter((card) => card.difficultyLabel === '难例').length,
      locatedCount: cards.filter((card) => card.pdfPage > 0 && card.bbox.length === 4).length,
      // ↓ 14 综述舱直接消费的两个扁平字段
      doi: focused?.sourceDoi ?? '',
      figure: focused?.figure ?? 'Eq. (待编号)',
      pdf_page: focused?.pdfPage ?? 0,
      bbox: focused?.bbox ?? [],
      card: focused ?? null,
      cards,
    };
  },

  csvOf: (rows) => ({
    header: [
      '公式编号',
      '纯文本',
      'LaTeX',
      '量纲',
      '符号数',
      'PDF 页码',
      'PDF 坐标',
      '坐标面积(pt²)',
      '坐标来源',
      '摘录数值',
      '难度',
      '难度依据',
      '原文摘录',
      'DOI',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.figure ?? ''),
      String(row.plain ?? ''),
      String(row.latex ?? ''),
      String(row.dimension ?? ''),
      Number(row.symbolCount ?? 0),
      Number(row.pdfPage ?? 0) > 0 ? `P.${String(row.pdfPage)}` : '—',
      Array.isArray(row.bbox) && row.bbox.length === 4
        ? `[${row.bbox.map((item) => String(item)).join(', ')}]`
        : '—',
      Number(row.bboxArea ?? 0),
      String(row.bboxSource ?? ''),
      Array.isArray(row.highlightNumbers) && row.highlightNumbers.length > 0
        ? row.highlightNumbers.map((item) => String(item)).join(' / ')
        : '—',
      String(row.difficultyLabel ?? ''),
      Array.isArray(row.difficultyReasons) && row.difficultyReasons.length > 0
        ? row.difficultyReasons.map((item) => String(item)).join('、')
        : '—',
      String(row.snippetText ?? ''),
      String(row.sourceDoi ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),
});

/** 全站口径值：README 与答辩口径都从这里引用，避免两处写不一样的数字。 */
export const PDF_SNIPER_STATS = {
  ledger: LEDGER_NAME,
  cards: CARD_COUNT,
  formulas: FORMULAS.length,
  snippets: PDF_SNIPPETS.length,
  symbols: TOTAL_SYMBOLS,
  hardCases: HARD_CASES,
  sourceDoi: SOURCE_DOI,
  sourceVenue: SOURCE_VENUE,
  sourceLevel: SOURCE_LEVEL,
  pageWidthPt: PAGE_WIDTH_PT,
  pageHeightPt: PAGE_HEIGHT_PT,
  contentWidthPt: CONTENT_WIDTH_PT,
} as const;
