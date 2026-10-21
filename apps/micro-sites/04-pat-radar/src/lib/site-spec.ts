/**
 * 04 · PAT-HOT 学科脉冲雷达 —— 业务规格（本站唯一手写的业务代码）
 *
 * 台账：订阅学科关键词与早报历史库
 * 投送：paper_doi_bundle → lit-sonar（五源跨库引文声呐）
 * 接收：paper_doi_bundle ← lit-sonar
 *
 * 一条记录 = 一个订阅方向：订阅的关键词是什么、这个方向今天早上推送了哪几篇、
 * 峰值热度多少、早报历史里留下了哪条摘要、以哪篇论文的 DOI 作为证据锚点。
 *
 * 为什么记录里要带 DOI：早报只说「某方向有 3 篇新文」是没法核验的。
 * 带上 DOI 之后，下游（文献声呐）能直接顺着锚点去补引文树，
 * 「开山鼻祖」这条线索才不会断在摘要里。
 *
 * 数值全部从共享的 PAT_HOT_ITEMS 现算（热度峰值 / 均值 / 命中篇数 / DOI 数），
 * 不手抄：雷达瀑布流上显示 98.4 而台账写 98.5，答辩时就要现场解释。
 */

import {
  PAT_HOT_ITEMS,
  createRowSpec,
  type PatHotItem,
  type RowSeed,
  type WormholeEvidenceAnchor,
} from '@matrixos/microsite-data';

/* ───────────────────────────── 展示格式（确定性） ─────────────────────────────
 * 不用 toLocaleString：Node 与浏览器的 ICU 数据可能不同版本，服务端预渲染与
 * 客户端首帧文本一旦不一致就是 React #418 水合报错。手写千分位最稳。
 */
function fmtInt(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 98.4 → "98.4"，只保留一位小数，四舍五入走整数运算避免浮点尾巴。 */
function fmtHeat(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

const DOMAIN = 'pat-hot.matrixos.cc.cd';

/* ───────────────────────────── 订阅方向（业务划分） ───────────────────────────── */

interface SubscriptionPlan {
  readonly keyword: string;
  readonly direction: string;
  readonly cadence: string;
  readonly status: string;
  readonly note: string;
  /** 该方向命中的前沿条目，对应 PAT_HOT_ITEMS 的 id。 */
  readonly itemIds: readonly string[];
}

/**
 * 四个订阅方向对应 4 条真实前沿条目（DOI 均经 Crossref 核验）。
 *
 * 线索划分：p1 SnO₂ 界面钝化（器件路线）→ p2 CISS 空间成像 + p3 手性空穴传输
 * （同一「手性-自旋」主题的两条不同切口）→ p4 室温相干控制（方法与测量路线）。
 * 每条 seed 的命中篇数、峰值热度、DOI 数量都不同，覆盖真实业务场景。
 *
 * ⚠️ 关键词是**检索式**，必须与对应条目的真实标题/摘要用词相容 ——
 * 换数据时这里要同步改，否则会出现「订阅超表面全息却挂着相干控制论文」的错配。
 */
const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = [
  {
    keyword: '钙钛矿 AND (钝化 OR 界面) AND SnO2',
    direction: '钙钛矿光伏 · 界面钝化',
    cadence: '每日 07:30',
    status: '在订',
    note: '主攻方向。n–i–p 结构认证效率已到约 27%，界面钝化是当前最密集的改进路线，保持日更。',
    itemIds: ['p1'],
  },
  {
    keyword: '手性 AND (CISS OR 自旋) AND 钙钛矿',
    direction: '自旋电子学 · CISS 表征',
    cadence: '每周一 07:30',
    status: '在订',
    note: '与 p3 同一主题的不同切口：p2 给出 CISS 的空间不均匀性证据，p3 给出材料层面的手性-自旋极性对应。',
    itemIds: ['p2'],
  },
  {
    keyword: '(手性 OR chirality) AND (空穴传输 OR HTM)',
    direction: '自旋电子学 · 手性材料',
    cadence: '每周一 07:30',
    status: '在订',
    note: '关心「同手性薄膜空穴迁移率约为外消旋三倍」这类可复用的材料结论，能否迁移到课题组的器件上。',
    itemIds: ['p3'],
  },
  {
    keyword: '(相干控制 OR 相位整形) AND (双光子 OR 单分子)',
    direction: '超快光学 · 相干控制',
    cadence: '每三日 07:30',
    status: '观察中',
    note: '观察期方向：室温凝聚相的单分子相干控制与我们的泵浦-探测平台同源，但方法尚未在本组复现，先不入夹。',
    itemIds: ['p4'],
  },
];

/* ───────────────────────────── 证据锚点与文本工具 ───────────────────────────── */

/**
 * 早报条目的证据锚点 = 论文 DOI 的解析地址。
 *
 * 校验等级用 Level_B_Preprint 而不是 Level_A_Verified：早报是自动抓取的
 * 题录与摘要，没有做过「PDF 原文 + 第二来源」的双验，不能冒充已验真证据。
 * 等下游把 Level_A 的锚点回流上来，本站会原样保留，不擅自降级。
 */
function doiAnchor(item: PatHotItem): WormholeEvidenceAnchor {
  return {
    source_doi_or_url: `https://doi.org/${item.doi}`,
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
 * 虫洞信封的锚点层是 `additionalProperties: false`，多一个字段（历史数据里
 * 出现过 `note`）整个信封就过不了校验。这里只保留契约允许的四个字段，
 * 非法等级降级为 Level_B_Preprint，保证本站发出的信封永远合法。
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

function itemsOf(itemIds: readonly string[]): readonly PatHotItem[] {
  return itemIds
    .map((id) => PAT_HOT_ITEMS.find((item) => item.id === id))
    .filter((item): item is PatHotItem => Boolean(item));
}

/* ───────────────────────────── 一条订阅记录 ───────────────────────────── */

function subscriptionRow(plan: SubscriptionPlan): RowSeed {
  const items = itemsOf(plan.itemIds);
  const heats = items.map((item) => item.heat);
  const maxHeat = heats.length > 0 ? Math.max(...heats) : 0;
  const avgHeat =
    heats.length > 0 ? heats.reduce((sum, heat) => sum + heat, 0) / heats.length : 0;
  const topItem = items.reduce<PatHotItem | undefined>(
    (best, item) => (best === undefined || item.heat > best.heat ? item : best),
    undefined,
  );
  const tags = Array.from(new Set(items.flatMap((item) => item.tags)));
  const dois = items.map((item) => item.doi);

  const meta = [
    `命中 ${items.length} 篇`,
    `峰值热度 ${fmtHeat(maxHeat)}`,
    `均热 ${fmtHeat(avgHeat)}`,
    `DOI ${dois.length} 条`,
    plan.status,
  ].join(' · ');

  const digest =
    topItem === undefined
      ? '该方向今日无新文，早报仅保留订阅状态。'
      : `早报头条：${topItem.source}《${topItem.title}》热度 ${fmtHeat(topItem.heat)} —— ${
          topItem.summary
        }`;

  const detail = [
    `订阅方向 ${plan.direction}，推送频率 ${plan.cadence}`,
    digest,
    `标签 ${tags.join(' / ')}`,
    `证据锚点 ${dois.map((doi) => `doi:${doi}`).join('、')}`,
    plan.note,
  ].join('；');

  return {
    title: `${plan.direction} · ${plan.keyword}`,
    meta,
    detail,
    ...(topItem !== undefined ? { anchor: doiAnchor(topItem) } : {}),
    keyword: plan.keyword,
    direction: plan.direction,
    cadence: plan.cadence,
    status: plan.status,
    itemIds: [...plan.itemIds],
    itemCount: items.length,
    maxHeat: Number(fmtHeat(maxHeat)),
    avgHeat: Number(fmtHeat(avgHeat)),
    tags: [...tags],
    dois: [...dois],
    doiCount: dois.length,
    topItemTitle: topItem?.title ?? '',
    topVenue: topItem?.source ?? '',
    topHeat: topItem === undefined ? 0 : Number(fmtHeat(topItem.heat)),
    topSummary: topItem?.summary ?? '',
    digest,
    note: plan.note,
  };
}

/** 演示数据：四个订阅方向，覆盖全部 4 条前沿条目，全部由共享数据现算。 */
const seed: readonly RowSeed[] = SUBSCRIPTION_PLANS.map((plan) => subscriptionRow(plan));

/** 全库热度基线：早报库里最高的那一条，用于新订阅的参照。 */
const LIBRARY_MAX_HEAT = PAT_HOT_ITEMS.reduce(
  (best, item) => (item.heat > best ? item.heat : best),
  0,
);

/* ───────────────────────────── 业务规格 ───────────────────────────── */

export const siteSpec = createRowSpec({
  exportName: 'pat-subscriptions',
  seed,
  emit: {
    targetApp: 'lit-sonar',
    payloadType: 'paper_doi_bundle',
  },
  accept: {
    payloadType: 'paper_doi_bundle',
    description:
      '接收文献声呐回流的跨库引文包，补全早报里「开山鼻祖」的线索，落成本站一条待入夹的前沿条目。',
  },

  draft: (rows) => {
    const used = new Set(rows.map((row) => String(row.keyword ?? '')));
    const fresh = SUBSCRIPTION_PLANS.find((plan) => !used.has(plan.keyword));
    if (fresh) return subscriptionRow(fresh);

    const next = String(rows.length + 1).padStart(2, '0');
    return {
      title: `新订阅方向 ${next} · 关键词待填`,
      meta: `命中 0 篇 · 峰值热度 0.0 · DOI 0 条 · 待订阅`,
      detail: `点「编辑」补上检索式与推送频率。早报库当前最高热度 ${fmtHeat(
        LIBRARY_MAX_HEAT,
      )}，可作为筛选阈值的参照；新方向前两周建议只留摘要不入夹。`,
      keyword: '',
      direction: '待定',
      cadence: '每日 07:30',
      status: '待订阅',
      itemIds: [],
      itemCount: 0,
      maxHeat: 0,
      avgHeat: 0,
      tags: [],
      dois: [],
      doiCount: 0,
      topItemTitle: '',
      topVenue: '',
      topHeat: 0,
      topSummary: '',
      digest: '尚未收到早报。',
      note: '',
    };
  },

  payloadOf: (rows) => {
    const subscriptions = rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      keyword: String(row.keyword ?? ''),
      direction: String(row.direction ?? ''),
      cadence: String(row.cadence ?? ''),
      status: String(row.status ?? ''),
      itemCount: numberOr(row.itemCount, 0),
      maxHeat: numberOr(row.maxHeat, 0),
      avgHeat: numberOr(row.avgHeat, 0),
      tags: stringListOf(row.tags),
      dois: stringListOf(row.dois),
      digest: String(row.digest ?? ''),
    }));

    // DOI 包去重：lit-sonar 拿到的是一串可直接检索的 DOI，不是重复锚点。
    const doiBundle = Array.from(
      new Set(subscriptions.flatMap((item) => item.dois).filter((doi) => doi !== '')),
    );

    return {
      site: 'pat-hot',
      ledger: '订阅学科关键词与早报历史库',
      target: 'lit-sonar',
      subscriptionCount: subscriptions.length,
      doiCount: doiBundle.length,
      doiBundle,
      heatBaseline: Number(fmtHeat(LIBRARY_MAX_HEAT)),
      // 订阅方向随包带上，下游能判断这批 DOI 属于哪条学科线索而不必回查本站。
      directions: subscriptions.map((item) => ({
        direction: item.direction,
        keyword: item.keyword,
        status: item.status,
        doiCount: item.dois.length,
      })),
      subscriptions,
    };
  },

  csvOf: (rows) => ({
    header: [
      '订阅方向',
      '检索关键词',
      '推送频率',
      '状态',
      '命中篇数',
      '峰值热度',
      '均热',
      '标签',
      'DOI 列表',
      '早报头条',
      '最后修改',
    ],
    rows: rows.map((row) => [
      String(row.direction ?? ''),
      String(row.keyword ?? ''),
      String(row.cadence ?? ''),
      String(row.status ?? ''),
      numberOr(row.itemCount, 0),
      numberOr(row.maxHeat, 0),
      numberOr(row.avgHeat, 0),
      stringListOf(row.tags).join(' / '),
      stringListOf(row.dois).join(' '),
      String(row.topItemTitle ?? ''),
      String(row.updatedAt ?? ''),
    ]),
  }),

  rowOfEnvelope: (envelope, nowIso) => {
    const data = envelope.payload?.data ?? {};
    const anchors = envelope.payload?.evidence_anchors ?? [];
    const anchor = anchorFrom(anchors[0]);
    const source = textOf(envelope.source_app, 'lit-sonar');

    const rawDois = Array.isArray(data.doiBundle)
      ? data.doiBundle
      : Array.isArray(data.dois)
        ? data.dois
        : [];
    const dois = rawDois.map((doi) => String(doi)).filter((doi) => doi !== '');

    // 回流包的 DOI 也可以从锚点里取：有些上游只发锚点不发 doiBundle。
    const anchorDois = anchors
      .map((item) =>
        typeof item.source_doi_or_url === 'string'
          ? item.source_doi_or_url.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
          : '',
      )
      .filter((doi) => doi !== '');
    const mergedDois = Array.from(new Set([...dois, ...anchorDois]));

    const direction = textOf(data.direction ?? data.topic, '前沿回流 · 待归类');
    const title = textOf(data.title ?? data.name ?? data.label, '跨库引文包');
    const summary = textOf(
      data.summary ?? data.detail ?? data.description,
      '（未附文字摘要，仅凭锚点校验）',
    );

    return {
      title: `回流文献包 · ${direction}`,
      meta: `来自 ${source} · DOI ${mergedDois.length} 条 · 锚点 ${anchors.length} 条 · 待入夹`,
      detail: [
        `文献声呐回流的跨库引文包：${title}`,
        summary,
        mergedDois.length > 0
          ? `DOI：${mergedDois.slice(0, 3).join('、')}${mergedDois.length > 3 ? ' 等' : ''}`
          : 'DOI 列表为空，需回站内补检索',
        `早报库最高热度 ${fmtHeat(LIBRARY_MAX_HEAT)}；接收于 ${nowIso
          .slice(0, 19)
          .replace('T', ' ')}`,
      ].join('；'),
      ...(anchor ? { anchor } : {}),
      keyword: '',
      direction,
      cadence: '随回流',
      status: '待入夹',
      itemIds: [],
      itemCount: mergedDois.length,
      maxHeat: 0,
      avgHeat: 0,
      tags: stringListOf(data.tags),
      dois: mergedDois,
      doiCount: mergedDois.length,
      topItemTitle: title,
      topVenue: source,
      topHeat: 0,
      topSummary: summary,
      digest: summary,
      note: '由文献声呐回流，等待人工确认后并入对应订阅方向的早报历史。',
      receivedFrom: source,
      traceId: textOf(envelope.trace_id, 'unknown'),
    };
  },
});
