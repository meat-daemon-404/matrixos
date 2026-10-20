#!/usr/bin/env node
/**
 * 口袋伴侣端本地 mock 后端（零依赖，Node 内置模块实现）。
 *
 * ⚠️ **这不是生产实现。** 生产实现是 `services/matrix-core` 的 `/v1/pocket/*`
 * （FastAPI + PostgreSQL，见 `services/matrix-core/app/api/routes/pocket.py`，
 * 已通过 191 个测试）。本文件的用途只有一个：本机没有微信开发者工具时，
 * 让小程序的 13 个端点有**可执行证据**——能真起服务、真发请求、真断言状态码与形状。
 *
 * 权威参照（形状一个字都不自造）：
 *   - apps/wechat-pocket/miniprogram/api/types.ts        响应体形状唯一来源
 *   - apps/wechat-pocket/miniprogram/api/index.ts        端点表 + TTL
 *   - apps/wechat-pocket/miniprogram/api/mock/data.ts    演示数据源（本文件复用）
 *   - services/matrix-core/app/api/routes/pocket.py      路径/请求体/错误码/WS 协议
 *   - services/matrix-core/app/schemas/pocket.py         camelCase 输出、内层 snake_case
 *   - services/matrix-core/app/core/errors.py            错误体 {code,message,trace_id}
 *   - specs/contracts/wormhole-envelope.schema.json      payload_type / verification_level / anchors
 *
 * 运行：
 *   node mock-server/server.cjs                  # 127.0.0.1:8787
 *   PORT=8791 node mock-server/server.cjs        # 换端口
 *   HOST=0.0.0.0 node mock-server/server.cjs     # 换监听地址
 *   MOCK_VERBOSE=1 node mock-server/server.cjs   # 逐行打印路由
 *
 * 数据存内存 Map，进程重启即清空（mock 明确接受）。
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

/* ================================================================== */
/* 0. 通用工具                                                        */
/* ================================================================== */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 与 core/request.ts 的 makeTraceId() 同形状：UUID v4。 */
function uuid() {
  return crypto.randomUUID();
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** matrix-core 里所有 "at" 都是 aware datetime 的 isoformat；这里统一 UTC + Z。 */
function isoNow() {
  return new Date().toISOString();
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/* ---- 日期工具（与 mock/data.ts 同一套"本地日历"口径） ------------- */

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T12:00:00`).getDay(); // 0=Sun, 3=Wed, 5=Fri
}

function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute || 0, 0, 0);
  return d.toISOString();
}

function dayOffsetAt(days, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute || 0, 0, 0);
  return d.toISOString();
}

/** 「周五 15:00」的下一次出现（照抄 mock/data.ts 的 nextFridayAt）。 */
function nextFridayAt(hour) {
  const d = new Date();
  const dow = d.getDay();
  let delta = (5 - dow + 7) % 7;
  if (delta === 0 && d.getHours() >= hour) delta = 7;
  d.setDate(d.getDate() + delta);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/* ================================================================== */
/* 1. 契约枚举与错误体                                                 */
/* ================================================================== */

const PAYLOAD_TYPES = [
  'paper_doi_bundle',
  'comparison_matrix_row',
  'curve_fit_parameters',
  'mentor_match_card',
  'verified_cv_evidence',
];

const VERIFICATION_LEVELS = ['Level_A_Verified', 'Level_B_Preprint', 'Retracted_Warning'];

const GOAL_KINDS = ['study', 'research', 'desktop'];
const QUEUE_ORIGINS = ['morning_card', 'checkin_goal', 'manual'];

const STAGE_ORDER = [
  'email_sent',
  'email_read',
  'interview_scheduled',
  'interview_passed',
  'joined',
];

// services/matrix-core/app/services/pocket.py 的 STAGE_LABELS
const STAGE_LABELS = {
  email_sent: '已发信',
  email_read: '已读',
  interview_scheduled: '待面试',
  interview_passed: '面试通过',
  joined: '已进组',
};

// app/models/pocket.py: TERM_TARGET_DAYS = 60
const TERM_TARGET_DAYS = 60;
const HEARTBEAT_SEC = 30;

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';

/** 错误码 → HTTP 状态（app/core/errors.py 的 DEFAULT_STATUS）。 */
const STATUS_BY_CODE = {
  'validation.failed': 422,
  'auth.unauthorized': 401,
  'auth.forbidden': 403,
  'resource.not_found': 404,
  'resource.conflict': 409,
  'request.rate_limited': 429,
  'internal.error': 500,
  'auth.invalid_credentials': 401,
  'auth.login_required': 401,
  'auth.invalid_grant': 400,
  'auth.token_invalid': 401,
  'auth.token_expired': 401,
  'auth.token_revoked': 401,
  'auth.refresh_reuse_detected': 401,
  'pocket.item_not_found': 404,
  'pocket.bad_transition': 409,
  'pocket.evidence_required': 422,
};

/** 契约错误：抛出即得到 {code,message,trace_id} 三键错误体（S1-06 口径）。 */
class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 400;
  }
}

function errorBody(code, message, traceId) {
  return { code, message, trace_id: traceId };
}

/* ================================================================== */
/* 2. 证据锚点校验（虫洞契约红线）                                     */
/* ================================================================== */

/**
 * 逐条对齐 specs/contracts/wormhole-envelope.schema.json 的 evidence_anchors：
 *   minItems=1；source_doi_or_url 必填非空白；verification_level 必填且在 3 档枚举内；
 *   pdf_page 整数 ≥1；bbox 恰 4 个数字；additionalProperties=false。
 */
function normalizeAnchor(raw, where) {
  if (!isObj(raw)) throw new ContractError('validation.failed', `${where}: evidence_anchor 必须是对象`);
  const keys = Object.keys(raw);
  const allowed = ['source_doi_or_url', 'verification_level', 'pdf_page', 'bbox'];
  for (const k of keys) {
    if (!allowed.includes(k)) {
      throw new ContractError('validation.failed', `${where}: 未知字段 ${k}`);
    }
  }
  if (!('source_doi_or_url' in raw)) {
    throw new ContractError('validation.failed', `${where}: 缺少 source_doi_or_url`);
  }
  if (typeof raw.source_doi_or_url !== 'string') {
    throw new ContractError('validation.failed', `${where}: source_doi_or_url 必须是字符串`);
  }
  if (!raw.source_doi_or_url.trim()) {
    throw new ContractError('validation.failed', `${where}: source_doi_or_url 不能为空白`);
  }
  if (!('verification_level' in raw)) {
    throw new ContractError('validation.failed', `${where}: 缺少 verification_level`);
  }
  if (!VERIFICATION_LEVELS.includes(raw.verification_level)) {
    throw new ContractError(
      'validation.failed',
      `${where}: verification_level 必须是 ${VERIFICATION_LEVELS.join('|')}，收到 ${JSON.stringify(raw.verification_level)}`,
    );
  }
  const out = { source_doi_or_url: raw.source_doi_or_url, verification_level: raw.verification_level };
  if ('pdf_page' in raw && raw.pdf_page !== null && raw.pdf_page !== undefined) {
    if (typeof raw.pdf_page !== 'number' || !Number.isInteger(raw.pdf_page) || raw.pdf_page < 1) {
      throw new ContractError('validation.failed', `${where}: pdf_page 必须是 ≥1 的整数`);
    }
    out.pdf_page = raw.pdf_page;
  }
  if ('bbox' in raw && raw.bbox !== null && raw.bbox !== undefined) {
    const b = raw.bbox;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((x) => typeof x === 'number')) {
      throw new ContractError('validation.failed', `${where}: bbox 必须是 4 个数字 [x0,y0,x1,y1]`);
    }
    out.bbox = b;
  }
  return out;
}

function normalizeAnchors(list, where, { requireAtLeastOne = true } = {}) {
  if (!Array.isArray(list)) {
    throw new ContractError('validation.failed', `${where}: evidence_anchors 必须是数组`);
  }
  if (requireAtLeastOne && list.length < 1) {
    throw new ContractError('validation.failed', `${where}: evidence_anchors 至少 1 条（契约红线 W1）`);
  }
  return list.map((a, i) => normalizeAnchor(a, `${where}[${i}]`));
}

function checkPayloadType(v, where) {
  if (!PAYLOAD_TYPES.includes(v)) {
    throw new ContractError(
      'validation.failed',
      `${where}: payload_type 必须是 ${PAYLOAD_TYPES.join('|')}，收到 ${JSON.stringify(v)}`,
    );
  }
  return v;
}

/* ================================================================== */
/* 3. 演示数据（复用 miniprogram/api/mock/data.ts，不另造一套）         */
/* ================================================================== */

/** MORNING_CARDS ← mock/data.ts（publishedAt 每次读取按"当天"重算，保持 mock 永远今天）。 */
function seedMorningCards() {
  return [
    {
      id: 'card-natphoton-2025-peai',
      index: 1,
      station: 'pat-hot.matrixos.edu',
      source: 'Nature Photonics',
      title: '钙钛矿 PEAI 准二维钝化突破',
      summary: '准二维钝化将界面非辐射复合压到 4.1%，器件 EQE 抬到 28.4%，与你大创的钝化课题同源。',
      heat: 98.4,
      metrics: [
        { label: 'EQE', value: '28.4%' },
        { label: 'Voc', value: '1.28 V' },
        { label: '稳定性', value: 'T95 > 1200h' },
      ],
      fitNote: '契合大创课题 · 钝化界面工程',
      payloadType: 'paper_doi_bundle',
      targetStation: 'matrix-cross.matrixos.edu',
      desktopAction: '自动唤醒 Matrix-Cross 并挂载该行对比参数',
      evidenceAnchors: [
        {
          source_doi_or_url: '10.1038/s41566-025-01688-2',
          pdf_page: 4,
          bbox: [72.5, 188.0, 410.2, 233.7],
          verification_level: 'Level_A_Verified',
        },
      ],
      publishedAt: todayAt(7, 40),
    },
    {
      id: 'card-arxiv-2610-0492',
      index: 2,
      station: 'pat-hot.matrixos.edu',
      source: 'arXiv:2610.0492',
      title: '双指数衰减拟合的非线性最小二乘改进',
      summary: '提出加权残差重标定，τ₁/τ₂ 相关系数从 0.78 降到 0.21，直接可用于你的 TRPL 数据。',
      heat: 94.1,
      metrics: [
        { label: 'R² 提升', value: '+0.011' },
        { label: 'τ₁ 偏差', value: '-3.2%' },
        { label: '代码', value: 'GitHub 已开源' },
      ],
      fitNote: '可直接替换 CurveLab 现有拟合核',
      payloadType: 'curve_fit_parameters',
      targetStation: 'curvelab.matrixos.edu',
      desktopAction: '在 CurveLab 载入该拟合核并预置参数',
      evidenceAnchors: [
        {
          source_doi_or_url: 'https://arxiv.org/abs/2610.0492',
          pdf_page: 7,
          bbox: [58.0, 96.4, 388.1, 142.9],
          verification_level: 'Level_B_Preprint',
        },
      ],
      publishedAt: todayAt(7, 52),
    },
    {
      id: 'card-advmater-2024-chiral',
      index: 3,
      station: 'pat-hot.matrixos.edu',
      source: 'Adv. Mater.',
      title: '手性分子界面钝化的自旋选择性',
      summary: '手性界面使开路电压损失降至 0.41 V，为你下一轮对比矩阵补上「界面偶极」这一维。',
      heat: 91.7,
      metrics: [
        { label: 'ΔVoc', value: '0.41 V' },
        { label: '自旋极化', value: '68%' },
        { label: '对标', value: 'Adv. Mater. 24' },
      ],
      fitNote: '补齐对比矩阵缺失的「界面偶极」列',
      payloadType: 'comparison_matrix_row',
      targetStation: 'matrix-cross.matrixos.edu',
      desktopAction: '向 Matrix-Cross 追加一行对比参量',
      evidenceAnchors: [
        {
          source_doi_or_url: '10.1002/adma.202407731',
          pdf_page: 6,
          bbox: [64.2, 210.5, 402.8, 258.0],
          verification_level: 'Level_A_Verified',
        },
      ],
      publishedAt: todayAt(7, 58),
    },
  ];
}

/** microGoals ← mock/data.ts mockGoals()（基线完成度：1/3，2/3 那版由打卡叠加）。 */
function seedMicroGoals() {
  return [
    {
      id: 'goal-paper-read',
      title: '精读 2 篇钙钛矿钝化顶刊',
      note: '早读时间 07:30–08:20，已读完第 1 篇',
      kind: 'study',
      target: '2 篇',
    },
    {
      id: 'goal-trpl-fit',
      title: '晚 20:00 电脑端 CurveLab 跑完衰减拟合',
      note: '晚自习开电脑即刻攻坚 · 已加入桌面队列',
      kind: 'desktop',
      target: '1 组',
    },
    {
      id: 'goal-mentor-mail',
      title: '给张教授回一封补充材料邮件',
      note: '附上复现实验的 R²=0.9884 曲线图',
      kind: 'research',
      target: '1 封',
    },
  ];
}

/** seedCheckins ← mock/data.ts mockCheckinDay() 的基线事实（昨天往前、周三断签）。 */
function seedCheckins(today) {
  const done = new Set();
  for (let i = 1; i <= 6; i += 1) {
    const day = addDays(today, -i);
    if (dayOfWeek(day) === 3) continue; // 周三是断签日
    done.add(day);
  }
  const byGoal = {};
  for (const day of done) byGoal[day] = { 'goal-mentor-mail': todayAt(7, 20) };
  return { done, byGoal };
}

/** seedQueue ← mock/data.ts mockQueueItems()（一条 claimed、一条 pending）。 */
function seedQueue() {
  const cards = seedMorningCards();
  const now = Date.now();
  return [
    {
      id: 'q-natphoton-mounted',
      origin: 'morning_card',
      originRef: cards[0].id,
      title: 'Nat. Phot. 25 · PEAI 准二维钝化',
      note: '已挂载到 Matrix-Cross 对比矩阵第 3 行',
      targetStation: 'matrix-cross.matrixos.edu',
      desktopAction: '自动唤醒 Matrix-Cross',
      payloadType: 'paper_doi_bundle',
      evidenceAnchors: cards[0].evidenceAnchors,
      status: 'claimed',
      claimedAt: new Date(now - 26 * 60 * 1000).toISOString(),
      createdAt: new Date(now - 31 * 60 * 1000).toISOString(),
      receiptId: 'rcpt_01H8Z9K2A',
    },
    {
      id: 'q-curvelab-prefit',
      origin: 'checkin_goal',
      originRef: 'goal-trpl-fit',
      title: 'CurveLab 预备拟合（τ₁/τ₂）',
      note: '晚自习开电脑即刻攻坚',
      targetStation: 'curvelab.matrixos.edu',
      desktopAction: '在 CurveLab 预置双指数初值 τ₁=14.2 / τ₂=89.5',
      payloadType: 'curve_fit_parameters',
      evidenceAnchors: cards[1].evidenceAnchors,
      status: 'pending',
      createdAt: new Date(now - 8 * 60 * 1000).toISOString(),
      receiptId: 'rcpt_01H8Z9K2B',
    },
  ];
}

/** seedReminders ← mock/data.ts mockMentorBoard()（张教授待面试 + 李研究员已读）。 */
function seedReminders() {
  return [
    {
      id: 'reminder-zhang-interview',
      mentorName: '张教授',
      mentorTitle: '博导 · 光电国家研究中心',
      lab: '光电国重 · 钙钛矿光电器件组',
      stage: 'interview_scheduled',
      startsAt: nextFridayAt(15),
      location: '光电楼 B402',
      readReceipt: true,
      readAt: todayAt(9, 12),
      acknowledged: false,
      matchScore: 94,
      evidenceAnchors: [
        {
          source_doi_or_url: '10.1038/s41566-025-01688-2',
          pdf_page: 1,
          bbox: [48.0, 62.0, 300.5, 88.4],
          verification_level: 'Level_A_Verified',
        },
      ],
      outline: [
        {
          page: 1,
          title: '30 秒自我介绍（电梯间版）',
          points: [
            '光电信息科学与工程 · 大三 · GPA 3.86（专业前 4.2%）',
            '国创「钙钛矿钝化界面工程」负责人，1 作论文在投',
            '能独立完成 TRPL 双指数拟合与 Nature 级矢量图',
          ],
        },
        {
          page: 2,
          title: '我的复现实验（可验真）',
          points: [
            '按 PEAI 准二维钝化方案复现，R² = 0.9884',
            'τ₁ = 14.2 ns / τ₂ = 89.5 ns，与原文偏差 < 5%',
            '代码与原始散点已在 3 个 GitHub 仓库开源（含 seed）',
          ],
        },
        {
          page: 3,
          title: '进组后的第一步',
          points: [
            '第一周：复现组内基线器件，产出可比对的 EQE 曲线',
            '第一月：把手性界面钝化那条线接入现有对比矩阵',
            '预期贡献：补齐「界面偶极」维度并沉淀为组内台账',
          ],
        },
      ],
    },
    {
      id: 'reminder-li-cold-email',
      mentorName: '李研究员',
      mentorTitle: '硕导 · 宽禁带半导体组',
      lab: '材料学院 · 宽禁带半导体',
      stage: 'email_read',
      startsAt: dayOffsetAt(2, 10, 30),
      location: '线上（腾讯会议）',
      readReceipt: true,
      readAt: dayOffsetAt(-1, 21, 4),
      acknowledged: true,
      matchScore: 82,
      evidenceAnchors: [
        {
          source_doi_or_url: '10.1002/adma.202407731',
          pdf_page: 3,
          bbox: [60.0, 150.0, 360.0, 190.0],
          verification_level: 'Level_A_Verified',
        },
      ],
      outline: null,
    },
  ];
}

/** AcademicCard ← mock/data.ts mockAcademicCard()；matrixUid 随身份而变。 */
function seedAcademicCard(matrixUid) {
  return {
    matrixUid,
    displayName: '孙同学',
    subtitle: '光电大三 · GPA 3.86 · 国创负责人',
    school: '华中光电科技大学',
    major: '光电信息科学与工程',
    grade: '2023 级（大三）',
    qrPayload: `https://card.matrixos.edu/c/${matrixUid}?src=wechat-pocket&v=1`,
    metrics: [
      { label: 'GPA', value: '3.86', hint: '专业前 4.2%' },
      { label: '综测加分', value: '+18.5', hint: '云衡已核算' },
      { label: '精读文献', value: '142', hint: '篇 · Level-A 37' },
      { label: '复现仓库', value: '3', hint: 'GitHub 已验真' },
    ],
    evidences: [
      {
        kind: 'doi',
        label: '一作论文（在投）',
        ref: '10.1038/s41566-025-01688-2',
        verification: 'Level_A_Verified',
        verifiedNote: 'DOI 可解析 · Crossref 命中 · 无撤稿记录',
      },
      {
        kind: 'github',
        label: 'TRPL 双指数拟合复现',
        ref: 'github.com/mx-lab/trpl-biexp-fit',
        verification: 'Level_A_Verified',
        verifiedNote: '含随机种子与 Dockerfile · 最近提交 3 天前',
      },
      {
        kind: 'github',
        label: '钙钛矿 EQE 数据清洗',
        ref: 'github.com/mx-lab/pvk-eqe-clean',
        verification: 'Level_A_Verified',
        verifiedNote: 'CI 通过 · 复现成功率 100%',
      },
      {
        kind: 'patent',
        label: '软件著作权（受理）',
        ref: '2026SR0318842',
        verification: 'Level_B_Preprint',
        verifiedNote: '受理号可查 · 证书待下发',
      },
      {
        kind: 'competition',
        label: '挑战杯 · 省一等奖',
        ref: 'TZB-2025-HB-0142',
        verification: 'Level_A_Verified',
        verifiedNote: '省赛公示名单可核',
      },
    ],
    verificationLevel: 'Level_A_Verified',
    updatedAt: isoNow(),
  };
}

/* ================================================================== */
/* 4. 内存存储（按 uid 分键；进程重启即清空）                           */
/* ================================================================== */

const db = {
  /** uid → state */
  users: new Map(),
  /** idempotencyKey → uid:itemId */
  idem: new Map(),
  /** code → uid */
  codes: new Map(),
  /** 首次播种时刻（只用于日志，不参与响应） */
  seeded: 0,
};

function userState(uid) {
  let st = db.users.get(uid);
  if (st) return st;

  const today = toDateStr(new Date());
  const ck = seedCheckins(today);
  st = {
    uid,
    goals: seedMicroGoals(),
    checkinDone: ck.done,
    checkinByGoal: ck.byGoal,
    morningDismissed: new Set(),
    pushedCards: new Set(),
    reminders: seedReminders(),
    queue: seedQueue(),
    seededToday: today,
    seededGoals: false,
  };
  db.users.set(uid, st);

  // 演示队列的幂等键也登记，保证"重放同一张卡"与演示条目一致时不重复
  for (const item of st.queue) {
    if (!item.idempotencyKey) continue;
    db.idem.set(item.idempotencyKey, `${uid}:${item.id}`);
  }
  return st;
}

function findItem(st, itemId) {
  return st.queue.find((i) => i.id === itemId) || null;
}

function pendingCount(st) {
  return st.queue.filter((i) => i.status === 'pending').length;
}

/* ================================================================== */
/* 5. 鉴权                                                            */
/* ================================================================== */

const TOKEN_RE = /^mock-token-/;

/**
 * token 约定 `mock-token-<uid>`，不验签（mock），但必须解析出 uid 以隔离数据。
 * 非法/缺失 → 401 auth.login_required（matrix-core 缺 token）或 auth.token_invalid（形状不对）。
 */
function uidFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  if (!TOKEN_RE.test(token)) return null;
  const uid = token.slice('mock-token-'.length);
  return uid ? uid : null;
}

function extractBearer(authorization) {
  if (typeof authorization !== 'string') return null;
  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1] || null;
}

function requireIdentity(req) {
  const token = extractBearer(req.headers.authorization);
  if (!token) throw new ContractError('auth.login_required', '缺少访问令牌（Authorization: Bearer <token>）');
  const uid = uidFromToken(token);
  if (!uid) throw new ContractError('auth.token_invalid', 'access token 非法（mock 约定形如 mock-token-<uid>）');
  return { uid, token, state: userState(uid) };
}

/* ================================================================== */
/* 6. 视图构造（字段名照抄 types.ts：外层 camelCase，锚点内 snake_case） */
/* ================================================================== */

function cloneAnchors(list) {
  return (list || []).map((a) => {
    const out = { source_doi_or_url: a.source_doi_or_url, verification_level: a.verification_level };
    if (a.pdf_page !== undefined && a.pdf_page !== null) out.pdf_page = a.pdf_page;
    if (a.bbox) out.bbox = a.bbox.slice();
    return out;
  });
}

function cardView(st, card) {
  const v = Object.assign({}, card);
  v.evidenceAnchors = cloneAnchors(card.evidenceAnchors);
  v.dismissed = st.morningDismissed.has(card.id);
  v.pushed = st.pushedCards.has(card.id);
  return v;
}

/**
 * GET /v1/pocket/morning → MorningBriefing。
 * origin：早报卡 id 是演示语料里的固定值 ⇒ 永远 'mock'（matrix-core 无资产时也回落 mock）。
 */
function buildBriefing(st) {
  const cards = seedMorningCards().map((c) => cardView(st, c));
  return {
    body: {
      briefingDate: toDateStr(new Date()),
      generatedAt: todayAt(8, 0),
      keywords: ['钙钛矿钝化', 'TRPL 拟合', '手性界面'],
      cards,
      desktopQueueCount: pendingCount(st),
    },
    origin: 'mock',
  };
}

function weekFlags(st, day) {
  const out = [];
  for (let i = 6; i >= 0; i -= 1) out.push(st.checkinDone.has(addDays(day, -i)));
  return out;
}

/** streak 语义照抄 services/pocket.py 的 _streak：今天没打则从昨天往数，不归零。 */
function streakOf(st, day) {
  let cursor;
  if (st.checkinDone.has(day)) cursor = day;
  else if (st.checkinDone.has(addDays(day, -1))) cursor = addDays(day, -1);
  else return 0;
  let n = 0;
  while (st.checkinDone.has(cursor)) {
    n += 1;
    cursor = addDays(cursor, -1);
  }
  return n;
}

/** GET /v1/pocket/checkin?day= → CheckinDay（首次读取播种，与 mock/data.ts 一致）。 */
function buildCheckinDay(st, day) {
  const overlay = st.checkinByGoal[day] || {};
  const goals = st.goals.map((g) => {
    const doneAt = overlay[g.id];
    const v = {
      id: g.id,
      title: g.title,
      kind: g.kind,
      done: Boolean(doneAt),
    };
    if (g.note !== undefined && g.note !== null) v.note = g.note;
    if (g.target !== undefined && g.target !== null) v.target = g.target;
    if (doneAt) v.doneAt = doneAt;
    return v;
  });
  return {
    date: day,
    goals,
    streak: streakOf(st, day),
    week: weekFlags(st, day),
    termDays: st.checkinDone.size,
    termTarget: TERM_TARGET_DAYS,
  };
}

function reminderView(r) {
  const v = {
    id: r.id,
    mentorName: r.mentorName,
    mentorTitle: r.mentorTitle,
    lab: r.lab,
    stage: r.stage,
    stageLabel: STAGE_LABELS[r.stage] || r.stage,
    startsAt: r.startsAt,
    location: r.location,
    readReceipt: Boolean(r.readReceipt),
    acknowledged: Boolean(r.acknowledged),
    matchScore: r.matchScore,
    evidenceAnchors: cloneAnchors(r.evidenceAnchors),
  };
  if (r.readAt) v.readAt = r.readAt;
  if (r.outline && r.outline.length) {
    v.outline = r.outline.map((p) => ({ page: p.page, title: p.title, points: p.points.slice() }));
  }
  return v;
}

/** GET /v1/pocket/mentor → MentorBoard（mock 的提醒永远是演示数据）。 */
function buildMentorBoard(st) {
  const reminders = st.reminders.map(reminderView);
  const upcoming = reminders
    .filter((r) => r.startsAt && !r.acknowledged)
    .map((r) => r.startsAt)
    .sort();
  return {
    body: {
      reminders,
      nextEventAt: upcoming[0] || '',
      syncedAt: isoNow(),
    },
    origin: 'mock',
  };
}

/** GET /v1/pocket/card → AcademicCard。名片永远来自演示语料 ⇒ origin 'mock'。 */
function buildCard(st) {
  return { body: seedAcademicCard(st.uid), origin: 'mock' };
}

function itemView(item) {
  const v = {
    id: item.id,
    origin: item.origin,
    originRef: item.originRef,
    title: item.title,
    note: item.note,
    targetStation: item.targetStation,
    desktopAction: item.desktopAction,
    payloadType: item.payloadType,
    evidenceAnchors: cloneAnchors(item.evidenceAnchors),
    status: item.status,
    createdAt: item.createdAt,
  };
  if (item.claimedAt) v.claimedAt = item.claimedAt;
  if (item.receiptId) v.receiptId = item.receiptId;
  return v;
}

/** GET /v1/pocket/queue → QueueSnapshot（createdAt 新→旧，同 matrix-core 的 desc 排序）。 */
function buildQueueSnapshot(st) {
  const items = st.queue
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .map(itemView);
  return {
    items,
    pendingCount: items.filter((i) => i.status === 'pending').length,
    desktopOnline: hub.isOnline(st.uid),
    syncedAt: isoNow(),
  };
}

/* ================================================================== */
/* 7. WS StreamHub（按 uid 分键；鉴权前不下发任何用户数据）             */
/* ================================================================== */

class StreamHub {
  constructor() {
    /** uid → Set<socket> */
    this.byUid = new Map();
  }

  register(uid, socket) {
    let bucket = this.byUid.get(uid);
    if (!bucket) {
      bucket = new Set();
      this.byUid.set(uid, bucket);
    }
    bucket.add(socket);
  }

  unregister(uid, socket) {
    const bucket = this.byUid.get(uid);
    if (!bucket) return;
    bucket.delete(socket);
    if (!bucket.size) this.byUid.delete(uid);
  }

  isOnline(uid) {
    return this.byUid.has(uid);
  }

  /** 尽力投递：单连接失败不影响其它连接（同 matrix-core 的 StreamHub.broadcast）。 */
  broadcast(uid, message) {
    const bucket = this.byUid.get(uid);
    if (!bucket) return 0;
    let sent = 0;
    for (const socket of Array.from(bucket)) {
      try {
        wsSendText(socket, JSON.stringify(message));
        sent += 1;
      } catch (_e) {
        this.unregister(uid, socket);
        try {
          socket.destroy();
        } catch (_e2) {
          /* ignore */
        }
      }
    }
    return sent;
  }
}

const hub = new StreamHub();

/* ================================================================== */
/* 8. RFC6455 帧编解码（零依赖手写；掩码与 126/127 扩展长度都处理）      */
/* ================================================================== */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 10 * 1024 * 1024;

function wsAcceptKey(secWebSocketKey) {
  return crypto.createHash('sha1').update(secWebSocketKey + WS_MAGIC, 'binary').digest('base64');
}

/** 服务端→客户端：不掩码，文本/二进制分帧按原文，控制帧带 payload。 */
function wsEncodeFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payloadBuf]);
}

function wsSendText(socket, text) {
  socket.write(wsEncodeFrame(0x1, Buffer.from(String(text), 'utf8')));
}

function wsSendBinary(socket, buf) {
  socket.write(wsEncodeFrame(0x2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf)));
}

function wsSendPing(socket, payloadBuf) {
  socket.write(wsEncodeFrame(0x9, payloadBuf || Buffer.alloc(0)));
}

function wsSendPong(socket, payloadBuf) {
  socket.write(wsEncodeFrame(0xa, payloadBuf || Buffer.alloc(0)));
}

function wsSendClose(socket, code) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code || 1000, 0);
  socket.write(wsEncodeFrame(0x8, body));
}

function unmask(payload, maskKey) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ maskKey[i & 3];
  return out;
}

/**
 * 从缓冲里切一帧。返回 null 表示数据不够（调用方等下一次 data）。
 * 帧结构：byte0 FIN|RSV|opcode，byte1 MASK|len7，[ext len]，[mask 4B]，payload。
 */
function wsParseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) === 0x80;
  const rsv = b0 & 0x70;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off);
    if (big > BigInt(MAX_FRAME_BYTES)) {
      const err = new Error(`WS 帧过长：${big}`);
      err.wsCode = 1009;
      throw err;
    }
    len = Number(big);
    off += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    maskKey = buf.slice(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;

  let payload = buf.slice(off, off + len);
  if (masked) payload = unmask(payload, maskKey);
  if (rsv !== 0) {
    const err = new Error('WS 保留了未协商的 RSV 位');
    err.wsCode = 1002;
    throw err;
  }
  return { size: off + len, fin, opcode, masked, payload };
}

/** 客户端帧必须掩码（RFC6455 §5.1）；未掩码 ⇒ 协议错误。 */
function assertClientMasked(frame) {
  if (frame.opcode >= 0x3 && frame.opcode <= 0x7) {
    const err = new Error('WS 使用了未协商的扩展数据帧');
    err.wsCode = 1003;
    throw err;
  }
  if (frame.opcode === 0x1 || frame.opcode === 0x2) {
    if (!frame.masked) {
      const err = new Error('WS 客户端帧必须掩码');
      err.wsCode = 1002;
      throw err;
    }
  }
}

/* ================================================================== */
/* 9. 业务写路径                                                       */
/* ================================================================== */

/** matrix-core _derive_idempotency_key：uid|origin|cardId|targetStation|sha256(title\nnote)[:16] → sha256[:48] */
function deriveIdempotencyKey(uid, req) {
  const base = [
    uid,
    req.origin,
    req.cardId || '',
    req.targetStation,
    sha256Hex(`${req.title}\n${req.note}`).slice(0, 16),
  ].join('|');
  return sha256Hex(base).slice(0, 48);
}

function morningCardById(cardId) {
  return seedMorningCards().find((c) => c.id === cardId) || null;
}

/**
 * POST /v1/pocket/queue/push → PushResult。
 * 返回 { body, status, dedup }；dedup 走 200，新建走 201（matrix-core 用状态码表达有无新建）。
 */
function pushQueue(st, body) {
  const req = body || {};
  if (!nonEmptyStr(req.title)) throw new ContractError('validation.failed', 'title: 不能为空');
  if (String(req.title).length > 500) throw new ContractError('validation.failed', 'title: 最长 500 字符');
  if (req.note !== undefined && req.note !== null && String(req.note).length > 2000) {
    throw new ContractError('validation.failed', 'note: 最长 2000 字符');
  }
  if (!nonEmptyStr(req.targetStation)) {
    throw new ContractError('validation.failed', 'targetStation: 不能为空');
  }
  const origin = req.origin || 'morning_card';
  if (!QUEUE_ORIGINS.includes(origin)) {
    throw new ContractError(
      'validation.failed',
      `origin 必须是 ${QUEUE_ORIGINS.join('|')}，收到 ${JSON.stringify(origin)}`,
    );
  }
  const payloadType = checkPayloadType(req.payloadType, 'payloadType');
  const anchors = normalizeAnchors(req.evidenceAnchors, 'evidenceAnchors');

  // cardId 存在时，载荷类型与锚点必须来自那张早报卡（不接受前端自造载荷）
  if (nonEmptyStr(req.cardId)) {
    const src = morningCardById(req.cardId);
    if (!src) throw new ContractError('resource.not_found', `早报卡不存在：${req.cardId}`);
    if (src.payloadType !== payloadType) {
      throw new ContractError(
        'validation.failed',
        `payloadType 与早报卡不一致：卡 ${req.cardId} 是 ${src.payloadType}`,
      );
    }
    const same =
      anchors.length === src.evidenceAnchors.length &&
      anchors.every((a, i) => a.source_doi_or_url === src.evidenceAnchors[i].source_doi_or_url);
    if (!same) {
      throw new ContractError('validation.failed', `evidenceAnchors 与早报卡 ${req.cardId} 的锚点不一致`);
    }
  }

  const key = nonEmptyStr(req.idempotencyKey)
    ? String(req.idempotencyKey).slice(0, 128)
    : deriveIdempotencyKey(st.uid, {
        origin,
        cardId: req.cardId || '',
        targetStation: req.targetStation,
        title: req.title,
        note: req.note || '',
      });

  const hit = db.idem.get(key);
  if (hit && hit.startsWith(`${st.uid}:`)) {
    const existing = findItem(st, hit.slice(st.uid.length + 1));
    if (existing) {
      return {
        body: {
          item: itemView(existing),
          receiptId: existing.receiptId || '',
          desktopNotified: hub.isOnline(st.uid),
          idempotencyKey: key,
        },
        status: 200,
        dedup: true,
      };
    }
  }

  const item = {
    id: `q-${crypto.randomBytes(8).toString('hex')}`,
    origin,
    originRef: req.cardId || '',
    title: req.title,
    note: req.note || '',
    targetStation: req.targetStation,
    desktopAction: req.desktopAction || '',
    payloadType,
    evidenceAnchors: anchors,
    status: 'pending',
    createdAt: isoNow(),
    receiptId: `rcpt_${sha256Hex(`${st.uid}|${key}`).slice(0, 16)}`,
    idempotencyKey: key,
  };
  st.queue.push(item);
  db.idem.set(key, `${st.uid}:${item.id}`);
  if (nonEmptyStr(req.cardId)) st.pushedCards.add(req.cardId);

  return {
    body: {
      item: itemView(item),
      receiptId: item.receiptId,
      desktopNotified: hub.isOnline(st.uid),
      idempotencyKey: key,
    },
    status: 201,
    dedup: false,
  };
}

/** POST /v1/pocket/queue/claim：pending→claimed；重复认领幂等；done 后认领 409。 */
function claimItem(st, itemId) {
  const item = findItem(st, itemId);
  if (!item) throw new ContractError('pocket.item_not_found', '待办不存在');
  if (item.status === 'done') {
    throw new ContractError('pocket.bad_transition', '条目已完成，不能再认领');
  }
  if (item.status === 'claimed') {
    return { item, claimedAt: item.claimedAt || isoNow(), changed: false };
  }
  item.status = 'claimed';
  item.claimedAt = isoNow();
  return { item, claimedAt: item.claimedAt, changed: true };
}

/**
 * POST /v1/pocket/queue/done：只允许 claimed→done（pending 直跳 409）。
 * doneAt 只作为返回值传递——types.ts 的 QueueItem 刻意没有 doneAt 字段。
 */
function markDone(st, itemId) {
  const item = findItem(st, itemId);
  if (!item) throw new ContractError('pocket.item_not_found', '待办不存在');
  if (item.status === 'done') {
    return { item, doneAt: item.doneAt || isoNow(), changed: false };
  }
  if (item.status !== 'claimed') {
    throw new ContractError(
      'pocket.bad_transition',
      `只能从 claimed 完成，当前状态是 ${item.status}`,
    );
  }
  item.status = 'done';
  item.doneAt = isoNow();
  return { item, doneAt: item.doneAt, changed: true };
}

/** POST /v1/pocket/mentor/stage?reminderId=&stage= ：只允许前进一步。 */
function advanceStage(st, reminderId, stage) {
  const row = st.reminders.find((r) => r.id === reminderId);
  if (!row) throw new ContractError('pocket.item_not_found', '提醒不存在');
  if (!STAGE_ORDER.includes(stage)) {
    throw new ContractError('validation.failed', `未知阶段：${stage}`);
  }
  const current = STAGE_ORDER.includes(row.stage) ? STAGE_ORDER.indexOf(row.stage) : 0;
  const target = STAGE_ORDER.indexOf(stage);
  if (target !== current + 1) {
    const next = current + 1 < STAGE_ORDER.length ? STAGE_ORDER[current + 1] : '（终态）';
    throw new ContractError(
      'pocket.bad_transition',
      `阶段只能前进一步：${row.stage} → ${next}，收到 ${stage}`,
    );
  }
  row.stage = stage;
  if (stage === 'email_read') {
    row.readReceipt = true;
    row.readAt = isoNow();
  }
  return row;
}

/** POST /v1/pocket/checkin / DELETE 同一路径：完全对称可逆。 */
function setCheckin(st, goalId, day, done) {
  const goal = st.goals.find((g) => g.id === goalId);
  if (!goal) throw new ContractError('resource.not_found', '目标不存在');
  if (!st.checkinByGoal[day]) st.checkinByGoal[day] = {};
  const bucket = st.checkinByGoal[day];
  if (done) {
    if (!bucket[goalId]) {
      bucket[goalId] = isoNow();
      st.checkinDone.add(day);
    }
  } else if (bucket[goalId]) {
    delete bucket[goalId];
    if (!Object.keys(bucket).length) {
      delete st.checkinByGoal[day];
      st.checkinDone.delete(day);
    }
  }
  return buildCheckinDay(st, day);
}

/* ---- auth 两条（无鉴权头） ---------------------------------------- */

function wechatExchange(body) {
  const req = body || {};
  const deviceId = nonEmptyStr(req.device_id) ? req.device_id : nonEmptyStr(req.deviceId) ? req.deviceId : '';
  const client = nonEmptyStr(req.client) ? req.client : 'wechat-pocket';
  let uid = null;

  // 真实微信 code：同一 code 复用 ⇒ 同一 uid（确定性派生，同 matrix-core 的一次性 code 语义靠拢）
  if (nonEmptyStr(req.code)) {
    const hit = db.codes.get(req.code);
    if (hit) {
      uid = hit;
    } else {
      uid = deviceId
        ? `mxu_${sha256Hex(deviceId).slice(0, 8)}`
        : `mxu_${crypto.randomBytes(4).toString('hex')}`;
      db.codes.set(req.code, uid);
    }
  }

  // 本地开发糖：code 直接写 uid:<x> / mock-token-<x>，让自测能指名要两个用户
  if (!uid && nonEmptyStr(req.code) && /^uid:/.test(req.code)) uid = req.code.slice(4);
  if (!uid && nonEmptyStr(req.code) && TOKEN_RE.test(req.code)) uid = uidFromToken(req.code);
  if (!uid) throw new ContractError('auth.invalid_credentials', 'code 无效或已过期');

  const scope = Array.isArray(req.requested_scope) && req.requested_scope.length
    ? req.requested_scope.filter(nonEmptyStr)
    : ['station:pocket:read', 'station:pocket:write'];

  userState(uid);
  const refreshToken = `mxrt_${uid}_${crypto.randomBytes(8).toString('hex')}`;
  db.users.get(uid).refreshTokens = new Set([refreshToken]);

  return {
    access_token: `mock-token-${uid}`,
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: refreshToken,
    refresh_expires_in: 30 * 24 * 60 * 60,
    matrix_uid: uid,
    client,
    scope,
    device_id: deviceId,
  };
}

function authRefresh(body) {
  const req = body || {};
  const raw = nonEmptyStr(req.refresh_token) ? req.refresh_token : nonEmptyStr(req.refreshToken) ? req.refreshToken : '';
  if (!raw) throw new ContractError('auth.invalid_grant', '缺少 refresh_token');
  const m = /^mxrt_(.+?)_[0-9a-f]{16}$/.exec(raw);
  if (!m) throw new ContractError('auth.token_invalid', 'refresh token 格式非法');
  const uid = m[1];
  const st = db.users.get(uid);
  if (!st || !st.refreshTokens || !st.refreshTokens.has(raw)) {
    // 一次性：重放（含已轮转掉的旧值）触发整族失效，客户端据此重走 wx.login
    if (st && st.refreshTokens) st.refreshTokens.clear();
    throw new ContractError('auth.refresh_reuse_detected', 'refresh token 已被使用或已失效，需要重新登录');
  }
  st.refreshTokens.delete(raw);
  const nextRt = `mxrt_${uid}_${crypto.randomBytes(8).toString('hex')}`;
  st.refreshTokens.add(nextRt);
  return {
    access_token: `mock-token-${uid}`,
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: nextRt,
    refresh_expires_in: 30 * 24 * 60 * 60,
    matrix_uid: uid,
    scope: ['station:pocket:read', 'station:pocket:write'],
  };
}

/* ================================================================== */
/* 10. 路由表（路径与 matrix-core 完全一致）                            */
/* ================================================================== */

/**
 * 每条 handler(ctx) 返回：
 *   { body } | { body, origin } | { body, status } | 抛 ContractError
 * 注：桌面端两条（mentor/stage、queue/claim、queue/done）也在本 mock 里实现，
 *     这样双端协同的状态机与 WS 广播能在同一进程里被自测覆盖。
 */
const ROUTES = [
  {
    method: 'GET',
    pattern: /^\/v1\/pocket\/morning$/,
    auth: true,
    name: 'morning.get',
    handler: (ctx) => {
      const out = buildBriefing(ctx.state);
      return { body: out.body, origin: out.origin };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/pocket\/morning\/dismiss$/,
    auth: true,
    name: 'morning.dismiss',
    handler: (ctx) => {
      const cardId = ctx.body && ctx.body.cardId;
      if (!nonEmptyStr(cardId)) throw new ContractError('validation.failed', 'cardId: 不能为空');
      ctx.state.morningDismissed.add(cardId); // 幂等：Set 天然去重
      return { body: { ok: true } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/pocket\/checkin$/,
    auth: true,
    name: 'checkin.get',
    handler: (ctx) => {
      const day = parseDayQuery(ctx.query.day);
      return { body: buildCheckinDay(ctx.state, day) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/pocket\/checkin$/,
    auth: true,
    name: 'checkin.set',
    handler: (ctx) => {
      const b = ctx.body || {};
      if (!nonEmptyStr(b.goalId)) throw new ContractError('validation.failed', 'goalId: 不能为空');
      const day = parseDayField(b.date);
      if (typeof b.done !== 'boolean') throw new ContractError('validation.failed', 'done: 必须是布尔');
      return { body: setCheckin(ctx.state, b.goalId, day, b.done) };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/pocket\/checkin$/,
    auth: true,
    name: 'checkin.unset',
    handler: (ctx) => {
      const goalId = ctx.query.goalId;
      if (!nonEmptyStr(goalId)) throw new ContractError('validation.failed', 'goalId: 查询参数不能为空');
      const day = parseDayQuery(ctx.query.date);
      return { body: setCheckin(ctx.state, goalId, day, false) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/pocket\/mentor$/,
    auth: true,
    name: 'mentor.get',
    handler: (ctx) => {
      const out = buildMentorBoard(ctx.state);
      return { body: out.body, origin: out.origin };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/pocket\/mentor\/ack$/,
    auth: true,
    name: 'mentor.ack',
    handler: (ctx) => {
      const b = ctx.body || {};
      if (!nonEmptyStr(b.reminderId)) throw new ContractError('validation.failed', 'reminderId: 不能为空');
      const row = ctx.state.reminders.find((r) => r.id === b.reminderId);
      if (!row) throw new ContractError('pocket.item_not_found', '提醒不存在');
      row.acknowledged = true;
      return { body: reminderView(row) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/pocket\/mentor\/stage$/,
    auth: true,
    name: 'mentor.stage',
    handler: (ctx) => {
      const reminderId = ctx.query.reminderId;
      const stage = ctx.query.stage;
      if (!nonEmptyStr(reminderId)) throw new ContractError('validation.failed', 'reminderId: 查询参数不能为空');
      if (!nonEmptyStr(stage)) throw new ContractError('validation.failed', 'stage: 查询参数不能为空');
      const row = advanceStage(ctx.state, reminderId, stage);
      hub.broadcast(ctx.uid, {
        type: 'mentor.stage',
        reminderId: row.id,
        stage: row.stage,
        stageLabel: STAGE_LABELS[row.stage] || row.stage,
      });
      return { body: reminderView(row) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/pocket\/card$/,
    auth: true,
    name: 'card.get',
    handler: (ctx) => {
      const out = buildCard(ctx.state);
      return { body: out.body, origin: out.origin };
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/pocket\/queue$/,
    auth: true,
    name: 'queue.get',
    handler: (ctx) => ({ body: buildQueueSnapshot(ctx.state) }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/pocket\/queue\/push$/,
    auth: true,
    name: 'queue.push',
    handler: (ctx) => {
      const out = pushQueue(ctx.state, ctx.body);
      if (!out.dedup) {
        // 2s 规则的服务端半边：先落库再广播（顺序刻意，反了就是时序竞速）
        const count = pendingCount(ctx.state);
        hub.broadcast(ctx.uid, { type: 'queue.count', pendingCount: count });
      }
      return { body: out.body, status: out.status };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/pocket\/queue\/claim$/,
    auth: true,
    name: 'queue.claim',
    handler: (ctx) => {
      const b = ctx.body || {};
      if (!nonEmptyStr(b.itemId)) throw new ContractError('validation.failed', 'itemId: 不能为空');
      const out = claimItem(ctx.state, b.itemId);
      hub.broadcast(ctx.uid, {
        type: 'queue.claimed',
        itemId: out.item.id,
        claimedAt: out.claimedAt,
        station: out.item.targetStation,
      });
      return { body: { item: itemView(out.item), claimedAt: out.claimedAt } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/pocket\/queue\/done$/,
    auth: true,
    name: 'queue.done',
    handler: (ctx) => {
      const b = ctx.body || {};
      if (!nonEmptyStr(b.itemId)) throw new ContractError('validation.failed', 'itemId: 不能为空');
      const out = markDone(ctx.state, b.itemId);
      hub.broadcast(ctx.uid, { type: 'queue.done', itemId: out.item.id, doneAt: out.doneAt });
      hub.broadcast(ctx.uid, { type: 'queue.count', pendingCount: pendingCount(ctx.state) });
      return { body: { item: itemView(out.item), doneAt: out.doneAt } };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/pocket\/queue$/,
    auth: true,
    name: 'queue.remove',
    handler: (ctx) => {
      const id = ctx.query.id;
      if (!nonEmptyStr(id)) throw new ContractError('validation.failed', 'id: 查询参数不能为空');
      const item = findItem(ctx.state, id);
      if (!item) throw new ContractError('pocket.item_not_found', '待办不存在');
      ctx.state.queue = ctx.state.queue.filter((i) => i.id !== id);
      if (item.idempotencyKey) db.idem.delete(item.idempotencyKey);
      if (item.origin === 'morning_card' && item.originRef) ctx.state.pushedCards.delete(item.originRef);
      hub.broadcast(ctx.uid, { type: 'queue.count', pendingCount: pendingCount(ctx.state) });
      return { body: { ok: true } };
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/wechat\/exchange$/,
    auth: false,
    name: 'auth.wechat.exchange',
    handler: (ctx) => ({ body: wechatExchange(ctx.body) }),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/refresh$/,
    auth: false,
    name: 'auth.refresh',
    handler: (ctx) => ({ body: authRefresh(ctx.body) }),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    auth: false,
    name: 'health',
    handler: () => ({
      body: {
        status: 'ok',
        service: 'wechat-pocket-mock',
        data_origin: 'mock',
        users: db.users.size,
        sockets: hub.byUid.size,
        time: isoNow(),
      },
    }),
  },
];

function parseDayQuery(value) {
  if (value === undefined || value === null || value === '') return toDateStr(new Date());
  if (!ISO_RE.test(String(value))) throw new ContractError('validation.failed', 'date 必须是 YYYY-MM-DD');
  return String(value);
}

function parseDayField(value) {
  if (!nonEmptyStr(value) || !ISO_RE.test(value)) {
    throw new ContractError('validation.failed', 'date 必须是 YYYY-MM-DD');
  }
  return value;
}

function matchRoute(method, pathname) {
  let pathExists = false;
  for (const route of ROUTES) {
    if (!route.pattern.test(pathname)) continue;
    pathExists = true;
    if (route.method === method) return route;
  }
  if (pathExists) return { methodMismatch: true };
  return null;
}

/* ================================================================== */
/* 11. HTTP 服务                                                       */
/* ================================================================== */

const verbose = process.env.MOCK_VERBOSE === '1';

function readBody(req, res, done) {
  const chunks = [];
  let total = 0;
  const limit = 2 * 1024 * 1024;
  req.on('data', (c) => {
    total += c.length;
    if (total > limit) {
      done(new ContractError('validation.failed', '请求体过大'));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!raw.length) return done(null, {});
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      return done(new ContractError('validation.failed', `请求体不是合法 JSON：${e.message}`));
    }
    if (parsed === null || typeof parsed !== 'object') {
      return done(new ContractError('validation.failed', '请求体必须是 JSON 对象'));
    }
    done(null, parsed);
  });
  req.on('error', (e) => done(new ContractError('internal.error', `读取请求体失败：${e.message}`)));
}

function applyHeaders(res, extra) {
  const h = res.getHeaders();
  res.setHeader('x-trace-id', extra.traceId);
  res.setHeader('x-matrix-data-origin', extra.origin || 'mock');
  if (!h['cache-control']) res.setHeader('cache-control', 'no-store');
  if (!h['www-authenticate'] && extra.wwwAuth) res.setHeader('www-authenticate', extra.wwwAuth);
}

function sendJson(res, status, payload, extra) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  applyHeaders(res, extra);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(buf);
  if (verbose) console.log(`${status} ${extra.route || '-'} → ${String(buf).slice(0, 160)}`);
}

function sendError(res, err, traceId, routeName) {
  const e = err instanceof ContractError ? err : new ContractError('internal.error', String(err && err.message));
  const extra = { traceId, origin: 'mock', route: routeName };
  if (e.status === 401) extra.wwwAuth = 'Bearer error="invalid_token"';
  sendJson(res, e.status, errorBody(e.code, e.message, traceId), extra);
}

function traceIdOf(req) {
  // 与 app/core/tracing.py 同规则：只沿用严格 UUID 形状的入站头，否则新生成
  const fromWs = req.headers['x-trace-id'];
  if (typeof fromWs === 'string' && UUID_RE.test(fromWs)) return fromWs;
  const tp = req.headers.traceparent;
  if (typeof tp === 'string') {
    const parts = tp.split('-');
    if (parts.length === 4 && /^[0-9a-fA-F]{32}$/.test(parts[1])) {
      const h = parts[1];
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toLowerCase();
    }
  }
  return uuid();
}

function httpHandler(req, res) {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, 'http://localhost');
  } catch (e) {
    sendError(res, new ContractError('validation.failed', '无法解析请求 URL'), uuid(), 'bad-url');
    return;
  }
  const pathname = parsedUrl.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  const traceId = traceIdOf(req);
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  const route = matchRoute(req.method, pathname);
  if (!route) {
    sendError(
      res,
      new ContractError('resource.not_found', `未实现 ${req.method} ${pathname}`),
      traceId,
      'not-found',
    );
    return;
  }
  if (route.methodMismatch) {
    sendError(
      res,
      new ContractError('validation.failed', `${pathname} 不支持 ${req.method}`),
      traceId,
      'method-mismatch',
    );
    return;
  }

  const run = (body) => {
    let identity = null;
    try {
      if (route.auth) identity = requireIdentity(req);
    } catch (err) {
      sendError(res, err, traceId, route.name);
      return;
    }
    const ctx = {
      req,
      query,
      body,
      uid: identity ? identity.uid : null,
      state: identity ? identity.state : null,
    };
    let out;
    try {
      out = route.handler(ctx);
    } catch (err) {
      sendError(res, err, traceId, route.name);
      return;
    }
    const extra = { traceId, origin: out.origin || 'mock', route: route.name };
    sendJson(res, out.status || 200, out.body, extra);
  };

  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') {
    // DELETE 用查询参数（core/request.ts 的 http.del(path,{query}) 就是这个约定）
    run({});
    return;
  }
  readBody(req, res, (err, body) => {
    if (err) sendError(res, err, traceId, route.name);
    else run(body);
  });
}

/* ================================================================== */
/* 12. WS /v1/pocket/stream（原生 http upgrade + 手写 RFC6455）          */
/* ================================================================== */

const WS_PATH = '/v1/pocket/stream';

function wsQuery(req) {
  try {
    return Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries());
  } catch (e) {
    return {};
  }
}

function onUpgrade(req, socket) {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    socket.destroy();
    return;
  }
  if (pathname !== WS_PATH) {
    socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (req.headers.upgrade === undefined || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    return;
  }
  if (typeof key !== 'string' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nsec-websocket-key 缺失\r\nconnection: close\r\n\r\n');
    return;
  }
  if (version !== undefined && String(version) !== '13') {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nconnection: close\r\n\r\n');
    return;
  }

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    'x-matrix-data-origin: mock',
  ];
  const protocols = req.headers['sec-websocket-protocol'];
  if (typeof protocols === 'string' && protocols.trim()) {
    const first = protocols.split(',')[0].trim();
    if (first) headers.push(`Sec-WebSocket-Protocol: ${first}`);
  }
  const trace = traceIdOf(req);
  headers.push(`x-trace-id: ${trace}`);
  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  socket.setNoDelay(true);

  const conn = {
    socket,
    uid: null,
    deviceId: null,
    buf: Buffer.alloc(0),
    fragments: [],
    fragOpcode: 0,
    open: true,
    timer: null,
  };

  const close = (code) => {
    if (!conn.open) return;
    conn.open = false;
    if (conn.uid) hub.unregister(conn.uid, socket);
    if (conn.timer) clearInterval(conn.timer);
    try {
      wsSendClose(socket, code);
    } catch (e) {
      /* ignore */
    }
    try {
      socket.end();
    } catch (e) {
      /* ignore */
    }
  };

  const handleAppMessage = (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      close(1007); // 非文本预期内容
      return;
    }
    if (!isObj(msg) || typeof msg.type !== 'string') {
      close(1007);
      return;
    }
    switch (msg.type) {
      case 'auth': {
        const uid = uidFromToken(msg.token);
        if (!uid) {
          // 4401：客户端据此区分「凭证问题要重登」与「网络问题要重连」（同 matrix-core）
          close(4401);
          return;
        }
        if (conn.uid) hub.unregister(conn.uid, socket);
        conn.uid = uid;
        conn.deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : null;
        userState(uid);
        hub.register(uid, socket);
        // 连上即要求全量对账：这条连接刚注册，之前的事件与它无关
        wsSendText(socket, JSON.stringify({ type: 'resync', reason: 'authenticated' }));
        break;
      }
      case 'ping':
        wsSendText(socket, JSON.stringify({ type: 'pong', t: msg.t === undefined ? 0 : msg.t }));
        break;
      case 'subscribe':
        // 按身份分键已足够细；topics 收下但不建第二级索引（同 matrix-core 的扩展点）
        break;
      default:
        // 未知类型不关闭连接：mock 要比生产宽容一点，方便手工试协议
        break;
    }
  };

  const pump = () => {
    for (;;) {
      let frame;
      try {
        frame = wsParseFrame(conn.buf);
      } catch (err) {
        close(err.wsCode || 1002);
        return;
      }
      if (!frame) return;
      conn.buf = conn.buf.slice(frame.size);
      try {
        assertClientMasked(frame);
      } catch (err) {
        close(err.wsCode || 1002);
        return;
      }

      if (frame.opcode === 0x8) {
        // 对端关闭：回一条 close 再收。合法码：1000..1015 与 3000..4999；其余归 1000。
        let code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
        const valid = (code >= 1000 && code <= 1011 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
        if (!valid) code = 1000;
        close(code);
        return;
      }
      if (frame.opcode === 0x9) {
        wsSendPong(socket, frame.payload);
        continue;
      }
      if (frame.opcode === 0xa) {
        continue; // 心跳 pong：mock 不判超时
      }
      if (frame.opcode === 0x0) {
        if (!conn.fragOpcode) {
          close(1002);
          return;
        }
        conn.fragments.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(conn.fragments);
          conn.fragments = [];
          const opcode = conn.fragOpcode;
          conn.fragOpcode = 0;
          if (opcode === 0x1) handleAppMessage(full.toString('utf8'));
          else wsSendBinary(socket, full);
        }
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (!frame.fin) {
          conn.fragOpcode = frame.opcode;
          conn.fragments = [frame.payload];
          continue;
        }
        if (frame.opcode === 0x1) handleAppMessage(frame.payload.toString('utf8'));
        else wsSendBinary(socket, frame.payload);
        continue;
      }
      close(1003);
      return;
    }
  };

  socket.on('data', (chunk) => {
    conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
    pump();
  });
  socket.on('error', () => {
    if (conn.uid) hub.unregister(conn.uid, socket);
    conn.open = false;
    if (conn.timer) clearInterval(conn.timer);
  });
  socket.on('close', () => {
    if (conn.uid) hub.unregister(conn.uid, socket);
    conn.open = false;
    if (conn.timer) clearInterval(conn.timer);
  });

  // 连上立即 hello（未鉴权连接只有 hello，收不到任何用户数据）
  wsSendText(
    socket,
    JSON.stringify({ type: 'hello', serverTime: isoNow(), heartbeatSec: HEARTBEAT_SEC }),
  );

  // 服务端主动 ping：证明 RFC6455 控制帧双向都通了（types.ts 没定义服务端 ping，故不入契约）
  conn.timer = setInterval(() => {
    if (!conn.open) return;
    try {
      wsSendPing(socket, Buffer.from(String(Date.now()), 'utf8'));
    } catch (e) {
      close(1001);
    }
  }, HEARTBEAT_SEC * 1000);
  if (conn.timer.unref) conn.timer.unref();
}

/* ================================================================== */
/* 13. 装配                                                            */
/* ================================================================== */

function createServer() {
  const server = http.createServer(httpHandler);
  server.on('upgrade', (req, socket) => {
    try {
      onUpgrade(req, socket);
    } catch (e) {
      try {
        socket.destroy();
      } catch (_e2) {
        /* ignore */
      }
    }
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolve({ port: addr && typeof addr === 'object' ? addr.port : port, host: addr.address });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** 供 selftest 同进程复用；子进程直接跑 main()。 */
async function startMockServer(opts) {
  const o = opts || {};
  const port = o.port === undefined ? Number(process.env.PORT || DEFAULT_PORT) : o.port;
  const host = o.host || process.env.HOST || DEFAULT_HOST;
  const server = createServer();
  const actual = await listen(server, port, host);
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual.port}`;
  return {
    server,
    port: actual.port,
    host: actual.address,
    url,
    wsUrl: url.replace(/^http/, 'ws'),
    close: () =>
      new Promise((resolve) => {
        hub.byUid.clear();
        server.closeAllConnections ? server.closeAllConnections() : null;
        server.close(() => resolve());
      }),
  };
}

async function main() {
  try {
    const srv = await startMockServer({});
    console.log(`[mock-server] listening on ${srv.url}  (pid ${process.pid})`);
    console.log(`[mock-server] WS   ${srv.wsUrl}/v1/pocket/stream`);
    console.log('[mock-server] ⚠ mock 而非生产实现；生产是 services/matrix-core 的 /v1/pocket/*');
    console.log('[mock-server] 鉴权头：Authorization: Bearer mock-token-<uid>（如 mock-token-alice）');
    console.log('[mock-server] Ctrl-C 退出；数据只在内存，重启即清空');
    process.on('SIGINT', () => {
      console.log('\n[mock-server] SIGINT → 关闭');
      srv.close().then(() => process.exit(0));
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(
        `[mock-server] 端口 ${process.env.PORT || DEFAULT_PORT} 已被占用；用 PORT=<n> 换一个，` +
          '或先释放（本机 8787 常被其它开发进程占用）',
      );
    } else {
      console.error('[mock-server] 启动失败：', err && err.message ? err.message : err);
    }
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  createServer,
  startMockServer,
  hub,
  db,
  // 便于单测内部逻辑（selftest 主要走 HTTP，这些只是补充）
  _internals: {
    wsAcceptKey,
    wsEncodeFrame,
    wsParseFrame,
    deriveIdempotencyKey,
    normalizeAnchors,
    checkPayloadType,
    buildCheckinDay,
    streakOf,
    advanceStage,
    pushQueue,
    claimItem,
    markDone,
    STAGE_ORDER,
    STAGE_LABELS,
    PAYLOAD_TYPES,
    VERIFICATION_LEVELS,
    TERM_TARGET_DAYS,
  },
};
