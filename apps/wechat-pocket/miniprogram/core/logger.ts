/**
 * 口袋端日志与冷启动打点。
 *
 * 为什么自己写而不是直接用 console：小程序线上包会保留 `console.log`，
 * 口袋端对包体与冷启动都敏感，因此这里做两级控制——
 *   - `warn` / `error` 始终输出（排障必需）；
 *   - `info` / `debug` 仅在非 prod 环境输出。
 *
 * 冷启动打点用 `wx.getPerformance()`（若可用），否则退回 `Date.now()`。
 */

import { COLD_START_BUDGET_MS, getEnv } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';

const PREFIX = '[pocket]';

function enabled(level: Level): boolean {
  if (level === 'warn' || level === 'error') return true;
  return getEnv() !== 'prod';
}

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (!enabled(level)) return;
  const tag = `${PREFIX}[${scope}]`;
  if (extra === undefined) {
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](tag, message);
  } else {
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](tag, message, extra);
  }
}

export const log = {
  debug: (scope: string, message: string, extra?: unknown) => emit('debug', scope, message, extra),
  info: (scope: string, message: string, extra?: unknown) => emit('info', scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown) => emit('warn', scope, message, extra),
  error: (scope: string, message: string, extra?: unknown) => emit('error', scope, message, extra),
};

/** 高精度时间戳（毫秒）。 */
export function now(): number {
  try {
    const perf = wx.getPerformance && wx.getPerformance();
    if (perf && typeof perf.now === 'function') return perf.now();
  } catch (_e) {
    /* ignore */
  }
  return Date.now();
}

interface Mark {
  name: string;
  at: number;
}

const marks: Mark[] = [];
const appStartAt = now();

/**
 * 记录一个启动阶段点。`t0` 是模块加载时刻（≈ 小程序 JS 引擎开始执行本包）。
 * 因为工具链不同，这个值不等于"用户点开小程序"的那一刻，
 * 但作为**同一口径的相对耗时**足够用来做回归对比。
 */
export function mark(name: string): number {
  const at = now();
  const delta = at - appStartAt;
  marks.push({ name, at });
  log.info('boot', `${name} @ ${delta.toFixed(1)}ms`);
  return delta;
}

export function getBootMarks(): Array<{ name: string; ms: number }> {
  return marks.map((m) => ({ name: m.name, ms: Number((m.at - appStartAt).toFixed(1)) }));
}

/** 首屏可交互时调用：超预算则显式告警，便于 S2-21 验收时留痕。 */
export function reportFirstPaint(route: string): void {
  const delta = mark(`first-paint:${route}`);
  if (delta > COLD_START_BUDGET_MS) {
    log.warn(
      'perf',
      `冷启动首屏 ${delta.toFixed(0)}ms 超出 ${COLD_START_BUDGET_MS}ms 预算（route=${route}）`,
    );
    try {
      if (wx.reportEvent) {
        wx.reportEvent('pocket_cold_start_overrun', {
          route,
          ms: Math.round(delta),
        });
      }
    } catch (_e) {
      /* 开发者工具里 reportEvent 可能未实现 */
    }
  } else {
    log.info('perf', `冷启动首屏 ${delta.toFixed(0)}ms / 预算 ${COLD_START_BUDGET_MS}ms（route=${route}）`);
  }
}
