/**
 * 口袋端数据契约（TypeScript 侧）。
 *
 * 与 `specs/contracts/wormhole-envelope.schema.json` 对齐的部分：
 *   - `evidence_anchors[]` 的 `source_doi_or_url` + `verification_level` 必填
 *   - `payload_type` 5 类封闭枚举
 *   - `verification_level` 3 档枚举
 *
 * 这些类型是「服务端返回 → 页面渲染」之间的唯一形状。
 * 服务端未实现时，`api/mock/` 必须返回同形状的数据，页面代码一行不改。
 */

/* ------------------------------------------------------------------ */
/* 虫洞契约（与 specs/contracts 同构）                                 */
/* ------------------------------------------------------------------ */

export type PayloadType =
  | 'paper_doi_bundle'
  | 'comparison_matrix_row'
  | 'curve_fit_parameters'
  | 'mentor_match_card'
  | 'verified_cv_evidence';

export type VerificationLevel = 'Level_A_Verified' | 'Level_B_Preprint' | 'Retracted_Warning';

export interface EvidenceAnchor {
  source_doi_or_url: string;
  pdf_page?: number;
  bbox?: [number, number, number, number];
  verification_level: VerificationLevel;
}

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

/**
 * 数据新鲜度。页面据此渲染「演示数据」/「缓存」角标 —— 不允许静默降级
 * （ADR-09 强制要求：降级必须在 UI 上显式可见）。
 */
export type DataOrigin = 'live' | 'mock' | 'cache' | 'local';

/* ------------------------------------------------------------------ */
/* 1. 晨间三卡早报（PAT-HOT 08:00）                                    */
/* ------------------------------------------------------------------ */

export interface MorningCard {
  /** 卡片 id，稳定用于「已忽略」去重。 */
  id: string;
  /** 序号 1..3，用于「三卡」计数展示。 */
  index: number;
  /** 站点来源，如 `pat-hot.matrixos.edu` */
  station: string;
  /** 信源名，如 `Nature Photonics` */
  source: string;
  /** 标题 */
  title: string;
  /** 一句话结论（受卡片高度限制，服务端应控制在 40 字内） */
  summary: string;
  /** 热度 0-100 */
  heat: number;
  /** 关键指标，如 `EQE 28.4%`（≤ 3 条） */
  metrics: Array<{ label: string; value: string }>;
  /** 与本人大创/课题的契合说明 */
  fitNote: string;
  /** 推入桌面队列时携带的虫洞载荷类型 */
  payloadType: PayloadType;
  /** 推入桌面后要被唤醒的桌面微站域名 */
  targetStation: string;
  /** 桌面看到的动作文案 */
  desktopAction: string;
  /** 证据锚点（≥1，契约红线） */
  evidenceAnchors: EvidenceAnchor[];
  /** 首发时间 ISO8601 */
  publishedAt: string;
  /** 是否已被本人忽略 */
  dismissed?: boolean;
  /** 是否已推入桌面队列 */
  pushed?: boolean;
}

export interface MorningBriefing {
  /** 早报日期 `YYYY-MM-DD` */
  briefingDate: string;
  /** 合成时刻 ISO8601（08:00 批次） */
  generatedAt: string;
  /** 订阅关键词 */
  keywords: string[];
  cards: MorningCard[];
  /** 桌面待办队列当前条目数（底部常驻角标要用） */
  desktopQueueCount: number;
}

/* ------------------------------------------------------------------ */
/* 2. 学业微目标每日打卡                                               */
/* ------------------------------------------------------------------ */

export type GoalKind = 'study' | 'research' | 'desktop'; // desktop = 需要开电脑做的事

export interface MicroGoal {
  id: string;
  title: string;
  /** 补充说明，如「晚 20:00 电脑端 CurveLab 跑完衰减拟合」 */
  note?: string;
  kind: GoalKind;
  /** 目标态，如 `2 篇` / `1 组` */
  target?: string;
  done: boolean;
  /** 完成时刻 ISO8601 */
  doneAt?: string;
}

export interface CheckinDay {
  /** `YYYY-MM-DD` */
  date: string;
  goals: MicroGoal[];
  /** 连续打卡天数 */
  streak: number;
  /** 近 7 天是否打卡（旧→新），用于进度环/日历条 */
  week: boolean[];
  /** 学期累计打卡天数 */
  termDays: number;
  /** 学期目标天数 */
  termTarget: number;
}

/* ------------------------------------------------------------------ */
/* 3. 星门导师进组进度与面试提醒                                        */
/* ------------------------------------------------------------------ */

export type MentorStage =
  | 'email_sent'
  | 'email_read'
  | 'interview_scheduled'
  | 'interview_passed'
  | 'joined';

export interface MentorReminder {
  id: string;
  mentorName: string;
  mentorTitle: string;
  lab: string;
  /** 当前状态机阶段（对应 lab-kanban 的 `已发信→已读→待面试→已进组`） */
  stage: MentorStage;
  /** 状态机阶段的中文标签 */
  stageLabel: string;
  /** 面试/事件开始时刻 ISO8601 */
  startsAt: string;
  /** 地点 */
  location: string;
  /** 是否已读回执已确认 */
  readReceipt: boolean;
  /** 阅读时刻 ISO8601 */
  readAt?: string;
  /** 提醒是否已被本人确认（避免重复强提醒） */
  acknowledged: boolean;
  /** 3 页口头答辩提纲卡（进组提醒页副产物） */
  outline?: Array<{ page: number; title: string; points: string[] }>;
  /** 导师匹配度 0-100（来自 mentor.matrixos.edu 的五维星象仪） */
  matchScore: number;
  /** 证据锚点：导师代表作 */
  evidenceAnchors: EvidenceAnchor[];
}

export interface MentorBoard {
  reminders: MentorReminder[];
  /** 下一个关键节点（用于首屏倒计时） */
  nextEventAt: string;
  /** 已同步到 lab-kanban 的时刻 */
  syncedAt: string;
}

/* ------------------------------------------------------------------ */
/* 4. 全息数字孪生学术名片                                             */
/* ------------------------------------------------------------------ */

export interface CardMetric {
  label: string;
  value: string;
  /** 单位/注释 */
  hint?: string;
}

export interface CardEvidence {
  kind: 'doi' | 'github' | 'patent' | 'competition';
  label: string;
  /** DOI / repo / 证书号 */
  ref: string;
  /** 验真徽章等级 */
  verification: VerificationLevel;
  /** GitHub 仓库的 star / 最近提交等验真信息 */
  verifiedNote?: string;
}

export interface AcademicCard {
  matrixUid: string;
  displayName: string;
  subtitle: string;
  school: string;
  major: string;
  grade: string;
  /** 名片二维码要编码的落地 URL（含 matrix_uid + trace_id） */
  qrPayload: string;
  metrics: CardMetric[];
  evidences: CardEvidence[];
  /** 名片整体验真等级 = 最弱一环 */
  verificationLevel: VerificationLevel;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* 5. 桌面待办队列（分包页）                                           */
/* ------------------------------------------------------------------ */

export type QueueStatus = 'pending' | 'claimed' | 'done';

export interface QueueItem {
  id: string;
  /** 来源：哪张卡片/哪次操作推进来的 */
  origin: 'morning_card' | 'checkin_goal' | 'manual';
  /** 来源引用 id */
  originRef: string;
  title: string;
  note: string;
  /** 完成后要唤醒的桌面微站域名 */
  targetStation: string;
  /** 桌面动作文案 */
  desktopAction: string;
  payloadType: PayloadType;
  evidenceAnchors: EvidenceAnchor[];
  status: QueueStatus;
  /** 桌面端是否已认领（2s 内出现待办项 ⇒ 这里变 claimed） */
  claimedAt?: string;
  createdAt: string;
  /** 虫洞收据号（`POST /v1/wormhole/receipt` 返回），用于审计对账 */
  receiptId?: string;
}

export interface QueueSnapshot {
  items: QueueItem[];
  pendingCount: number;
  /** 桌面端在线状态（WebSocket 通道是否活着） */
  desktopOnline: boolean;
  /** 最近一次同步时刻 */
  syncedAt: string;
}

/** 推入桌面队列的响应。 */
export interface PushResult {
  item: QueueItem;
  /** 服务端下发的虫洞收据 */
  receiptId: string;
  /** 桌面端是否已在线的即时回执 */
  desktopNotified: boolean;
  /** 幂等键，重复推送会复用 */
  idempotencyKey: string;
}

/* ------------------------------------------------------------------ */
/* WebSocket 下行消息                                                  */
/* ------------------------------------------------------------------ */

export type WsServerMessage =
  | { type: 'hello'; serverTime: string; heartbeatSec: number }
  | { type: 'pong'; t: number }
  | { type: 'queue.claimed'; itemId: string; claimedAt: string; station: string }
  | { type: 'queue.done'; itemId: string; doneAt: string }
  | { type: 'queue.count'; pendingCount: number }
  | { type: 'mentor.read'; reminderId: string; readAt: string }
  | { type: 'mentor.stage'; reminderId: string; stage: MentorStage; stageLabel: string }
  | { type: 'briefing.ready'; briefingDate: string }
  | { type: 'resync'; reason: string };

export type WsClientMessage =
  | { type: 'auth'; token: string; deviceId: string }
  | { type: 'ping'; t: number }
  | { type: 'subscribe'; topics: string[] };
