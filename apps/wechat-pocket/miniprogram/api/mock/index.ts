/**
 * Mock 路由层 —— 服务端 `/v1/*` 未实现时的本地替代实现。
 *
 * 设计原则：
 *   1. **同形状**：返回的数据结构与 `api/types.ts` 完全一致，页面代码零改动。
 *   2. **有状态**：写操作（打卡、推队列、已读回执）会改内存态，
 *      并叠加 storage 的本地补丁，让「重新进入小程序」也能看到自己的操作。
 *   3. **可辨识**：每个响应都标 `mock: true`，页面渲染「演示数据」角标（ADR-09 禁止静默降级）。
 *   4. **零依赖**：不引入 faker/msw 之类，包体对冷启动敏感。
 *
 * 服务端落地后删除本目录即可，`core/request.ts` 的回落逻辑会自动失效。
 */

import type {
  AcademicCard,
  CheckinDay,
  MicroGoal,
  MentorBoard,
  MorningBriefing,
  PushResult,
  QueueItem,
  QueueSnapshot,
} from '../types';
import { STORAGE_KEYS, readJSON, writeJSON } from '../../core/storage';
import { log } from '../../core/logger';
import {
  mockAcademicCard,
  mockCheckinDay,
  mockMentorBoard,
  mockMorningBriefing,
  mockQueueItems,
  toDateStr,
} from './data';

interface MockContext {
  method: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  latency: boolean;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* 本地补丁（用户操作叠加在 mock 基线之上）                             */
/* ------------------------------------------------------------------ */

interface LocalState {
  /** 已忽略的早报卡 id → 忽略日期 */
  dismissedCards: Record<string, string>;
  /** 已推入队列的早报卡 id */
  pushedCards: Record<string, string>;
  /** 打卡：date → goalId → doneAt */
  checkins: Record<string, Record<string, string>>;
  /** 已确认的提醒 id */
  acknowledgedReminders: Record<string, string>;
  /** 本地追加的队列条目（mock 模式下推入会立即出现在队列页） */
  queue: QueueItem[];
}

function readState(): LocalState {
  const s = readJSON<LocalState>(STORAGE_KEYS.queueLocal);
  if (s && typeof s === 'object') {
    return {
      dismissedCards: s.dismissedCards || {},
      pushedCards: s.pushedCards || {},
      checkins: s.checkins || {},
      acknowledgedReminders: s.acknowledgedReminders || {},
      queue: Array.isArray(s.queue) ? s.queue : [],
    };
  }
  return { dismissedCards: {}, pushedCards: {}, checkins: {}, acknowledgedReminders: {}, queue: [] };
}

function writeState(s: LocalState): void {
  writeJSON(STORAGE_KEYS.queueLocal, s, 0);
}

/* ------------------------------------------------------------------ */
/* 延迟模拟                                                            */
/* ------------------------------------------------------------------ */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** mock 延迟故意做小：口袋端冷启动预算是 800ms，mock 不该吃掉一半。 */
async function maybeDelay(ctx: MockContext, ms = 70): Promise<void> {
  if (!ctx.latency) return;
  await delay(ms);
}

/* ------------------------------------------------------------------ */
/* 各端点实现                                                          */
/* ------------------------------------------------------------------ */

function getMorning(_ctx: MockContext): MorningBriefing {
  const state = readState();
  const base = mockMorningBriefing();
  const dateKey = toDateStr(new Date());
  const cards = base.cards.map((c) => ({
    ...c,
    dismissed: state.dismissedCards[c.id] === dateKey,
    pushed: state.pushedCards[c.id] === dateKey,
  }));
  return {
    ...base,
    cards,
    desktopQueueCount: base.desktopQueueCount + state.queue.filter((q) => q.status === 'pending').length,
  };
}

function postDismiss(ctx: MockContext): { ok: true; cardId: string } {
  const body = (ctx.body || {}) as { cardId?: string };
  const cardId = body.cardId || '';
  const state = readState();
  state.dismissedCards[cardId] = toDateStr(new Date());
  writeState(state);
  return { ok: true, cardId };
}

function getCheckin(): CheckinDay {
  const state = readState();
  const base = mockCheckinDay();
  const overlay = state.checkins[base.date] || {};
  const goals: MicroGoal[] = base.goals.map((g) => {
    const doneAt = overlay[g.id];
    return doneAt ? { ...g, done: true, doneAt } : g;
  });
  const doneCount = goals.filter((g) => g.done).length;
  const week = base.week.slice();
  if (week.length) week[week.length - 1] = doneCount === goals.length;
  return { ...base, goals, week };
}

function postCheckin(ctx: MockContext): { ok: true; goalId: string; doneAt: string; allDone: boolean } {
  const body = (ctx.body || {}) as { goalId?: string; date?: string };
  const goalId = body.goalId || '';
  const date = body.date || toDateStr(new Date());
  const state = readState();
  if (!state.checkins[date]) state.checkins[date] = {};
  const doneAt = new Date().toISOString();
  state.checkins[date]![goalId] = doneAt;
  writeState(state);

  const day = getCheckin();
  const allDone = day.goals.length > 0 && day.goals.every((g) => g.done);
  return { ok: true, goalId, doneAt, allDone };
}

function getMentor(): MentorBoard {
  const state = readState();
  const base = mockMentorBoard();
  return {
    ...base,
    reminders: base.reminders.map((r) =>
      state.acknowledgedReminders[r.id] ? { ...r, acknowledged: true } : r,
    ),
  };
}

function postAckReminder(ctx: MockContext): { ok: true; reminderId: string } {
  const body = (ctx.body || {}) as { reminderId?: string };
  const reminderId = body.reminderId || '';
  const state = readState();
  state.acknowledgedReminders[reminderId] = new Date().toISOString();
  writeState(state);
  return { ok: true, reminderId };
}

function getCard(): AcademicCard {
  return mockAcademicCard();
}

function getQueue(): QueueSnapshot {
  const state = readState();
  const base = mockQueueItems();
  const local = state.queue;
  const merged = [...local, ...base].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return {
    items: merged,
    pendingCount: merged.filter((i) => i.status === 'pending').length,
    // mock 模式下无从得知桌面是否在线 —— 显式返回 false，UI 会显示「未连接」，不假装
    desktopOnline: false,
    syncedAt: new Date().toISOString(),
  };
}

/** 推入桌面队列 —— 本功能的核心写路径，mock 下真的写入本地队列。 */
function postPushToQueue(ctx: MockContext): PushResult {
  const body = (ctx.body || {}) as {
    cardId?: string;
    title?: string;
    note?: string;
    targetStation?: string;
    desktopAction?: string;
    payloadType?: QueueItem['payloadType'];
    evidenceAnchors?: QueueItem['evidenceAnchors'];
  };

  const state = readState();
  const idempotencyKey = `idem_${body.cardId || body.title || 'manual'}`;

  // 幂等：同 cardId 重复推入不产生重复条目
  const existing = state.queue.find((q) => q.originRef === body.cardId && body.cardId);
  if (existing) {
    return {
      item: existing,
      receiptId: existing.receiptId || `rcpt_mock_${existing.id}`,
      desktopNotified: false,
      idempotencyKey,
    };
  }

  const id = `q-local-${Date.now().toString(36)}`;
  const item: QueueItem = {
    id,
    origin: 'morning_card',
    originRef: body.cardId || id,
    title: body.title || '未命名待办',
    note: body.note || '',
    targetStation: body.targetStation || 'matrix-cross.matrixos.edu',
    desktopAction: body.desktopAction || '唤醒对应桌面微站',
    payloadType: body.payloadType || 'paper_doi_bundle',
    evidenceAnchors: body.evidenceAnchors || [],
    status: 'pending',
    createdAt: new Date().toISOString(),
    receiptId: `rcpt_mock_${Date.now().toString(36)}`,
  };

  state.queue.unshift(item);
  if (body.cardId) state.pushedCards[body.cardId] = toDateStr(new Date());
  writeState(state);

  return {
    item,
    receiptId: item.receiptId || '',
    desktopNotified: false,
    idempotencyKey,
  };
}

function deleteQueueItem(ctx: MockContext): { ok: true; id: string } {
  const id = String(ctx.query?.id || '');
  const state = readState();
  state.queue = state.queue.filter((q) => q.id !== id);
  writeState(state);
  return { ok: true, id };
}

/* ------------------------------------------------------------------ */
/* 路由分发                                                            */
/* ------------------------------------------------------------------ */

type Handler = (ctx: MockContext) => unknown;

interface RouteDef {
  method: string;
  /** 支持 `:param` 占位的简单模式。 */
  pattern: string;
  handler: Handler;
}

const ROUTES: RouteDef[] = [
  { method: 'GET', pattern: '/v1/pocket/morning', handler: (c) => getMorning(c) },
  { method: 'POST', pattern: '/v1/pocket/morning/dismiss', handler: (c) => postDismiss(c) },
  { method: 'GET', pattern: '/v1/pocket/checkin', handler: () => getCheckin() },
  { method: 'POST', pattern: '/v1/pocket/checkin', handler: (c) => postCheckin(c) },
  { method: 'GET', pattern: '/v1/pocket/mentor', handler: () => getMentor() },
  { method: 'POST', pattern: '/v1/pocket/mentor/ack', handler: (c) => postAckReminder(c) },
  { method: 'GET', pattern: '/v1/pocket/card', handler: () => getCard() },
  { method: 'GET', pattern: '/v1/pocket/queue', handler: () => getQueue() },
  { method: 'POST', pattern: '/v1/pocket/queue/push', handler: (c) => postPushToQueue(c) },
  { method: 'DELETE', pattern: '/v1/pocket/queue', handler: (c) => deleteQueueItem(c) },
];

function matchPattern(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  // 目前没有带参数的路由，保留扩展位
  return false;
}

/**
 * 尝试用 mock 实现响应某个请求。
 * 无匹配路由时返回 `null`，让上层继续抛原错误（不掩盖真实的服务端缺失）。
 */
export async function resolveMock<T>(path: string, ctx: MockContext): Promise<T | null> {
  const cleanPath = path.split('?')[0] || path;

  for (const route of ROUTES) {
    if (route.method !== ctx.method) continue;
    if (!matchPattern(route.pattern, cleanPath)) continue;

    await maybeDelay(ctx, route.method === 'GET' ? 60 : 90);
    const data = route.handler(ctx);
    log.info('mock', `${ctx.method} ${cleanPath} 命中（${ctx.reason}）`);
    return data as T;
  }

  log.warn('mock', `未实现 ${ctx.method} ${cleanPath}，无 mock 可回落`);
  return null;
}

/** 供开发者工具调试：清空本地 mock 状态。 */
export function resetMockState(): void {
  writeState({ dismissedCards: {}, pushedCards: {}, checkins: {}, acknowledgedReminders: {}, queue: [] });
}
