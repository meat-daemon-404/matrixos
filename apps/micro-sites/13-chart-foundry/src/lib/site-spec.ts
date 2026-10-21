/**
 * 13 · Nature 级出版图表熔炉 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：TikZ / Matplotlib 出版级绘图脚本库
 * 投送：comparison_matrix_row → review-lab（14 综述拓扑推演与写作舱）
 * 接收：curve_fit_parameters / comparison_matrix_row ← curvelab（11 CurveLab 拟合台）
 *
 * 为什么这么写：
 *   一条记录 = 一套出版规范下的可复跑绘图脚本。脚本里的尺寸、字号、DPI、配色
 *   **全部从共享的 CHART_STYLES 现算**（parseMm 把「89 mm（单栏）/ 183 mm（双栏）」
 *   解析成毫米数再换算英寸），不是手抄三段 Python。改共享数据，脚本跟着变 ——
 *   这正是「熔炉」的意义：规范是输入，脚本是输出。
 *
 *   投送出去的 comparison_matrix_row 是「图-数据-结论」三元组：
 *   综述写作舱拿它把图号绑定到段落，所以每条脚本都必须带 figureId 与结论占位。
 *
 * 锚点注意：虫洞信封契约的锚点层是 additionalProperties: false 的 snake_case
 * 四字段（source_doi_or_url / verification_level / 可选 pdf_page、bbox），
 * 多一个字段整个信封作废 —— 站内脚本页锚点用 Level_B_Preprint，绝不冒充 Level A。
 */

import {
  CHART_STYLES,
  createRowSpec,
  type ChartStyle,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

const LEDGER_NAME = 'TikZ / Matplotlib 出版级绘图脚本库';

/** 从「89 mm（单栏）/ 183 mm（双栏）」抽出毫米数；抽不到按 160 mm 双栏兜底。 */
function parseMm(columnWidth: string): { readonly singleMm: number; readonly doubleMm: number } {
  const found = [...columnWidth.matchAll(/(\d+(?:\.\d+)?)\s*mm/g)].map((m) => Number(m[1]));
  const single = found[0];
  const double = found[1] ?? found[0];
  if (single !== undefined && double !== undefined && Number.isFinite(single) && Number.isFinite(double)) {
    return { singleMm: single, doubleMm: double };
  }
  return { singleMm: 89, doubleMm: 160 };
}

/** 毫米 → 英寸（matplotlib figsize 的单位），保留两位。 */
function mmToInch(mm: number): string {
  return (Math.round((mm / 25.4) * 100) / 100).toFixed(2);
}

/** 从「5–7 pt」抽第一个字号作为 rcParams 基准；抽不到按 7 兜底。 */
function parseFontSizePt(fontSize: string): number {
  const m = /(\d+(?:\.\d+)?)/.exec(fontSize);
  const value = m ? Number(m[1]) : Number.NaN;
  return Number.isFinite(value) ? value : 7;
}

/** 可复跑的 Matplotlib 脚本：尺寸/字号/DPI/配色全部来自 style 字段。 */
function matplotlibOf(style: ChartStyle, figureId: string): string {
  const { singleMm, doubleMm } = parseMm(style.columnWidth);
  const pt = parseFontSizePt(style.fontSize);
  const palette = style.palette.map((color) => `'${color}'`).join(', ');
  return [
    `# ${style.name} 出版脚本（chart-foundry 生成）· ${figureId}`,
    'import matplotlib.pyplot as plt',
    '',
    `plt.rcParams.update({`,
    `    "font.size": ${pt},               # 规范字号 ${style.fontSize}`,
    `    "savefig.dpi": ${style.dpi},          # 规范分辨率`,
    `    "axes.prop_cycle": plt.cycler(color=[${palette}]),`,
    '})',
    '',
    `# 版心：${style.columnWidth} → figsize 按英寸换算`,
    `fig, ax = plt.subplots(figsize=(${mmToInch(singleMm)}, ${mmToInch(singleMm * 0.75)}))  # 单栏`,
    `# 跨栏图改用：figsize=(${mmToInch(doubleMm)}, ${mmToInch(doubleMm * 0.5)})`,
    'ax.plot([], [], label="数据由 curvelab 拟合参数投送补全")',
    'ax.set_xlabel("x")',
    'ax.set_ylabel("y")',
    `ax.legend(frameon=False)`,
    `fig.savefig("${figureId}.pdf", bbox_inches="tight")  # 矢量输出，色盲友好=${String(style.colorBlindSafe)}`,
  ].join('\n');
}

/** 站内脚本页锚点（Level B：站内自存档，未经第三方复核）。 */
function scriptAnchor(slug: string): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://chart-foundry.matrixos.cc.cd/scripts/${slug}`,
    verification_level: 'Level_B_Preprint',
  };
}

/**
 * 兜底规范：noUncheckedIndexedAccess 下 CHART_STYLES[0] 类型是 ChartStyle | undefined，
 * 用显式常量收口一次判空，后面所有调用点不用再各自 ?? 一遍。
 */
const DEFAULT_STYLE: ChartStyle = CHART_STYLES[0] ?? {
  id: 'nature',
  name: 'Nature 双栏',
  journal: 'Nature / Nature Photonics',
  columnWidth: '89 mm（单栏）/ 183 mm（双栏）',
  fontSize: '5–7 pt',
  dpi: 300,
  colorBlindSafe: true,
  palette: ['#0C2C4D', '#1B7C8C', '#57B8A8', '#E8A33D', '#C94C4C'],
};

function styleSeed(style: ChartStyle, index: number): RowSeed {
  const figureId = `fig-${String(index + 1).padStart(2, '0')}-${style.id}`;
  const { singleMm, doubleMm } = parseMm(style.columnWidth);
  const anchor = scriptAnchor(figureId);
  return {
    title: `${style.name} · 出版脚本`,
    meta: `${style.journal} · ${style.dpi} dpi · 色盲友好 ${style.colorBlindSafe ? '是' : '否'}`,
    detail: [
      `版心：${style.columnWidth}（单栏 ${singleMm} mm = ${mmToInch(singleMm)} in，双栏 ${doubleMm} mm = ${mmToInch(doubleMm)} in）· 字号 ${style.fontSize}`,
      `调色板：${style.palette.join(' / ')}`,
      `脚本：${figureId}.py（matplotlib，rcParams 内联规范），出图后按「图-数据-结论」投给综述写作舱`,
      '数据输入：等 CurveLab 投来 curve_fit_parameters 再画真实曲线 —— 没有拟合参数就只出空坐标系，绝不画假数据。',
    ].join('；'),
    anchor,
    styleId: style.id,
    styleName: style.name,
    journal: style.journal,
    columnWidth: style.columnWidth,
    fontSize: style.fontSize,
    dpi: style.dpi,
    colorBlindSafe: style.colorBlindSafe,
    palette: [...style.palette],
    figureId,
    conclusion: '待绑定数据',
    script: matplotlibOf(style, figureId),
  } satisfies RowSeed;
}

const seed: readonly RowSeed[] = CHART_STYLES.map((style, index) => styleSeed(style, index));

/* ───────────────────────── 业务规格 ───────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'chart-scripts',
  seed,
  emit: {
    targetApp: 'review-lab',
    payloadType: 'comparison_matrix_row',
  },
  accept: {
    payloadType: 'curve_fit_parameters',
    description:
      '接收 CurveLab 投来的拟合参量（curve_fit_parameters）：绑定到对应脚本的记录上，把「待绑定数据」换成真实曲线参数；也接收对比矩阵行补全图号出处。',
  },

  /** 新增一条 = 为某套规范开一张新图，数据未绑定前不出结论。 */
  draft: (rows) => {
    const next = String(rows.length + 1).padStart(2, '0');
    const style = CHART_STYLES[rows.length % CHART_STYLES.length] ?? DEFAULT_STYLE;
    const figureId = `fig-${next}-${String(style?.id ?? 'draft')}`;
    const anchor = scriptAnchor(figureId);
    return {
      title: `新脚本 · ${String(style?.name ?? '未选规范')}（${figureId}）`,
      meta: `${String(style?.journal ?? '待填')} · ${String(style?.dpi ?? '—')} dpi · 待绑定数据`,
      detail: `新建 ${figureId}：脚本已按 ${String(style?.name ?? '所选')} 规范生成尺寸与配色，等 CurveLab 投来拟合参数后画真实曲线并补结论。`,
      anchor,
      styleId: String(style?.id ?? ''),
      styleName: String(style?.name ?? ''),
      journal: String(style?.journal ?? ''),
      columnWidth: String(style?.columnWidth ?? ''),
      fontSize: String(style?.fontSize ?? ''),
      dpi: Number(style?.dpi ?? 300),
      colorBlindSafe: style?.colorBlindSafe ?? true,
      palette: [...(style?.palette ?? [])],
      figureId,
      conclusion: '待绑定数据',
      script: matplotlibOf(style, figureId),
    } satisfies RowSeed;
  },

  /**
   * 投送载荷：comparison_matrix_row 的「图-数据-结论」三元组。
   * 综述写作舱按 figureId + sourceDoi 把图号绑到段落上，所以两者必须在行里。
   */
  payloadOf: (rows) => {
    const matrixRows = rows.map((row) => ({
      figureId: String(row.figureId ?? row.id),
      styleName: String(row.styleName ?? ''),
      journal: String(row.journal ?? ''),
      conclusion: String(row.conclusion ?? ''),
      sourceDoi: String(row.sourceDoi ?? row.anchor?.source_doi_or_url ?? ''),
      boundModel: String(row.boundModel ?? ''),
      boundR2: row.boundR2 === undefined ? null : Number(row.boundR2),
      palette: Array.isArray(row.palette) ? row.palette.map(String) : [],
    }));
    return {
      site: 'chart-foundry',
      ledger: LEDGER_NAME,
      target: 'review-lab',
      rule: '按「图-数据-结论」三元组投送；未绑定拟合参数的脚本 conclusion 保持「待绑定数据」，不编造结论',
      scriptCount: matrixRows.length,
      boundCount: matrixRows.filter((item) => item.boundModel !== '').length,
      rows: matrixRows,
    };
  },

  /**
   * 接收分流：
   *   curve_fit_parameters —— CurveLab 的拟合参数，绑定到同名数据集的脚本上；
   *   comparison_matrix_row —— 上游矩阵行（如 10 号站公式卡），补图号出处。
   */
  rowOfEnvelope: (envelope, nowIso) => {
    const data = (envelope.payload?.data ?? {}) as Record<string, unknown>;
    const anchors: readonly WormholeEvidenceAnchor[] = Array.isArray(
      envelope.payload?.evidence_anchors,
    )
      ? (envelope.payload.evidence_anchors as readonly WormholeEvidenceAnchor[])
      : [];
    const firstAnchor = anchors[0];
    const sourceApp = String(envelope.source_app ?? 'curvelab');
    const traceShort = String(envelope.trace_id ?? 'unknown').slice(0, 8);
    const type = String(envelope.payload_type ?? 'curve_fit_parameters');
    const style = DEFAULT_STYLE;
    const base = {
      anchor: firstAnchor ?? scriptAnchor(`inbox-${traceShort}`),
      styleId: String(style?.id ?? ''),
      styleName: String(style?.name ?? ''),
      journal: String(style?.journal ?? ''),
      columnWidth: String(style?.columnWidth ?? ''),
      fontSize: String(style?.fontSize ?? ''),
      dpi: Number(style?.dpi ?? 300),
      colorBlindSafe: style?.colorBlindSafe ?? true,
      palette: [...(style?.palette ?? [])],
      receivedFrom: sourceApp,
      traceId: String(envelope.trace_id ?? 'unknown'),
    };

    if (type === 'curve_fit_parameters') {
      const focused = (data.focused ?? data) as Record<string, unknown>;
      const datasetId = String(focused.datasetId ?? `ext-${traceShort}`);
      const figureId = `fig-bound-${datasetId}`;
      const modelLabel = String(focused.modelLabel ?? '未标模型');
      const r2 = focused.r2 === undefined ? null : Number(focused.r2);
      return {
        ...base,
        title: `待出图 · ${datasetId}（${modelLabel}）`,
        meta: `来自 ${sourceApp} · curve_fit_parameters · R²=${r2 === null ? '—' : String(r2)} · 待绑定`,
        detail: [
          `CurveLab 投来 ${datasetId} 的最优拟合（${modelLabel}${r2 === null ? '' : `，R²=${r2.toFixed(4)}` }），按 ${String(style?.name ?? '默认')} 规范出图`,
          `参数：${JSON.stringify((focused.params ?? {}) as Record<string, unknown>).slice(0, 160)}`,
          `结论占位：绑定成功后把 conclusion 从「待绑定数据」改为「${modelLabel} 拟合，R²=${r2 === null ? '—' : r2.toFixed(4)}」`,
          `接收于 ${nowIso.slice(0, 19).replace('T', ' ')}；trace ${traceShort}`,
        ].join('；'),
        figureId,
        conclusion: '待绑定数据',
        boundModel: modelLabel,
        boundR2: r2,
        sourceDoi: base.anchor.source_doi_or_url,
        script: matplotlibOf(style, figureId),
      } satisfies RowSeed;
    }

    const incoming = Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : [];
    const firstRow = incoming[0] ?? {};
    return {
      ...base,
      title: `矩阵行补件 · ${String(firstRow.venue ?? data.title ?? '上游图号')}`,
      meta: `来自 ${sourceApp} · ${type} · ${String(incoming.length)} 行 · 待对图号`,
      detail: [
        `收到上游矩阵行 ${String(incoming.length)} 条，用其 venue / strategy 对到本站脚本的图号上`,
        `下一步：对上的行把 sourceDoi 换成原文 DOI，出图后投给综述写作舱；trace ${traceShort}`,
        `接收于 ${nowIso.slice(0, 19).replace('T', ' ')}`,
      ].join('；'),
      figureId: `fig-inbox-${traceShort}`,
      conclusion: '待对图号',
      sourceDoi: String(firstRow.sourceDoi ?? base.anchor.source_doi_or_url),
      script: matplotlibOf(style, `fig-inbox-${traceShort}`),
    } satisfies RowSeed;
  },

  csvOf: (rows) => ({
    header: [
      '图号',
      '出版规范',
      '期刊',
      '版心',
      '字号',
      'DPI',
      '色盲友好',
      '结论',
      '绑定模型',
      '绑定 R²',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.figureId ?? row.id),
      String(row.styleName ?? ''),
      String(row.journal ?? ''),
      String(row.columnWidth ?? ''),
      String(row.fontSize ?? ''),
      Number(row.dpi ?? 0),
      row.colorBlindSafe === false ? '否' : '是',
      String(row.conclusion ?? ''),
      String(row.boundModel ?? ''),
      row.boundR2 === undefined || row.boundR2 === null ? '' : Number(row.boundR2),
      String(row.updatedAt ?? ''),
    ]),
  }),
});
