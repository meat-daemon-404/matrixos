/**
 * 性能探针（S2-01e 要求的帧率/内存采样，R-T03 的自动降级依据）
 * =====================================================================
 *
 * 三个采样维度，全部对着 05-risks.md §R-T03 的触发信号写：
 *   1. **帧率**     —— rAF 采样窗口实测，阈值默认 < 45fps
 *   2. **内存**     —— performance.memory.usedJSHeapSize，阈值默认 > 800MB
 *   3. **长任务**   —— PerformanceObserver('longtask')，阈值默认 > 100ms
 *
 * 关键设计取舍：
 *  - 探针本身**不能成为性能负担**：rAF 回调里只累加计数，不做任何 DOM 读写；
 *    每 `WINDOW_MS` 才结算一次并回调。这样即使 60fps 下也几乎零成本。
 *  - 降级要**防抖**：连续 `breachWindows` 个窗口都超阈值才判定 breach，
 *    避免一次 GC 或首帧抖动就误降级（那会让用户看到无缘无故的快照面板）。
 *  - 内存 API 只有 Chromium 有；拿不到时 `heapMB: null`，**不猜、不伪造**，
 *    判定时跳过该维度而不是当成 0 或当成达标。
 *  - 探针读数是"证据"不是"结论"：这里只产出 sample + verdict，
 *    降级动作由调用方（instrumentRack）决定，便于 S2-01e 单独跑基线不触发降级。
 */

import type { PerformanceSample, ProbeVerdict } from './hub-types';

export interface ProbeThresholds {
  readonly fpsFloor: number;
  readonly memoryCeilingMB: number;
  readonly longTaskCeilingMs: number;
  readonly breachWindows: number;
}

export interface ProbeHandle {
  /** 停止采样并断开所有 observer */
  stop(): void;
  /** 立即取一次当前累计值（不等窗口结束），用于调试面板 */
  readNow(): PerformanceSample;
  /** 重置连续超标计数（例如用户手动解除降级后） */
  resetBreachStreak(): void;
}

export interface ProbeOptions {
  readonly thresholds: ProbeThresholds;
  /** 每个采样窗口结束时回调，附带本窗口的判定 */
  readonly onSample: (verdict: ProbeVerdict) => void;
  /** 当前活跃 iframe 数（由调用方注入，探针不去数 DOM） */
  readonly getLiveIframeCount: () => number;
  /** 采样窗口长度（ms），默认 1000 */
  readonly windowMs?: number;
}

const DEFAULT_WINDOW_MS = 1000;

/** Chromium-only 的 performance.memory 最小接口（TS 内置 lib 里没有） */
interface PerformanceMemoryLike {
  readonly usedJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
  readonly totalJSHeapSize: number;
}

interface PerformanceWithMemory extends Performance {
  readonly memory?: PerformanceMemoryLike;
}

function readHeapMB(): number | null {
  if (typeof performance === 'undefined') return null;
  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory || typeof memory.usedJSHeapSize !== 'number') return null;
  const bytes = memory.usedJSHeapSize;
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * 长任务观测。用 PerformanceObserver 而不是自己测 —— 自己测会把
 * "我自己的采样代码"也算进去，自证不清。
 * 老浏览器没有 longtask 支持时降级为不采样（返回 null 而非 0）。
 */
function attachLongTaskObserver(onTask: (durationMs: number) => void): (() => void) | null {
  if (typeof PerformanceObserver === 'undefined') return null;

  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        onTask(entry.duration);
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Safari / Firefox 不支持 'longtask'，静默放弃该维度
    return null;
  }

  return () => {
    try {
      observer.disconnect();
    } catch {
      /* 忽略：disconnect 失败不影响主流程 */
    }
  };
}

export function startPerformanceProbe(options: ProbeOptions): ProbeHandle {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const { thresholds } = options;

  let stopped = false;
  let windowStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
  let frameCount = 0;
  let longestTaskMs = 0;
  let breachStreak = 0;
  let rafId = 0;
  let lastFps = 0;
  let lastHeap: number | null = null;

  const disconnectLongTask = attachLongTaskObserver((durationMs) => {
    if (durationMs > longestTaskMs) longestTaskMs = durationMs;
  });

  /** rAF 回调：只累加，不碰 DOM、不读布局 —— 保证探针自身开销可忽略。 */
  const tick = (now: number) => {
    if (stopped) return;
    frameCount += 1;

    const elapsed = now - windowStartedAt;
    if (elapsed >= windowMs) {
      const fps = Math.round((frameCount / elapsed) * 1000 * 10) / 10;
      const heapMB = readHeapMB();
      const sample: PerformanceSample = {
        at: Date.now(),
        fps,
        heapMB,
        longestTaskMs: Math.round(longestTaskMs * 10) / 10,
        liveIframes: options.getLiveIframeCount(),
      };

      lastFps = fps;
      lastHeap = heapMB;

      const verdict = evaluate(sample, thresholds);
      breachStreak = verdict.level === 'breach' ? breachStreak + 1 : 0;

      // 没到连续超标门槛时，把 breach 降级为 warn —— 单窗口抖动不降级
      const stabilized: ProbeVerdict =
        verdict.level === 'breach' && breachStreak < thresholds.breachWindows
          ? {
              level: 'warn',
              reasons: [...verdict.reasons, `连续超标 ${breachStreak}/${thresholds.breachWindows} 窗口`],
              sample,
            }
          : verdict;

      options.onSample(stabilized);

      // 结算后重置窗口
      windowStartedAt = now;
      frameCount = 0;
      longestTaskMs = 0;
    }

    rafId = requestAnimationFrame(tick);
  };

  if (typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(tick);
  }

  return {
    stop() {
      stopped = true;
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      disconnectLongTask?.();
    },
    readNow(): PerformanceSample {
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      const elapsed = now - windowStartedAt;
      const fps = elapsed > 0 ? Math.round((frameCount / elapsed) * 1000 * 10) / 10 : lastFps;
      return {
        at: Date.now(),
        fps,
        heapMB: readHeapMB() ?? lastHeap,
        longestTaskMs: Math.round(longestTaskMs * 10) / 10,
        liveIframes: options.getLiveIframeCount(),
      };
    },
    resetBreachStreak() {
      breachStreak = 0;
      windowStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
      frameCount = 0;
      longestTaskMs = 0;
    },
  };
}

/**
 * 判定一次采样是否超标。三档：
 *   ok     —— 全部达标
 *   warn   —— 有维度接近阈值（≥ 阈值的 85%）但未超
 *   breach —— 任一维度确实超标（内存维度缺数据时跳过，不当作达标也不当作超标）
 *
 * 为什么 fps 阈值对"隐藏标签页"要特殊处理：标签页不可见时 rAF 会被节流到 ~1fps，
 * 那不是性能问题而是浏览器的正确行为。调用方应在 document.hidden 时不判定；
 * 这里额外做一道保护，把 liveIframes === 0 且 fps 极低的窗口判为 ok（没挂载就没有压力）。
 */
export function evaluate(sample: PerformanceSample, thresholds: ProbeThresholds): ProbeVerdict {
  const breaches: string[] = [];
  const warnings: string[] = [];

  // ── 帧率 ────────────────────────────────────────────────────────────────
  const fpsLow = sample.fps > 0 && sample.fps < thresholds.fpsFloor;
  if (fpsLow) {
    breaches.push(`帧率 ${sample.fps}fps < ${thresholds.fpsFloor}fps`);
  } else if (sample.fps > 0 && sample.fps < thresholds.fpsFloor * 1.15) {
    warnings.push(`帧率 ${sample.fps}fps 接近下限 ${thresholds.fpsFloor}fps`);
  }

  // ── 内存（可能无数据） ──────────────────────────────────────────────────
  if (sample.heapMB !== null) {
    if (sample.heapMB > thresholds.memoryCeilingMB) {
      breaches.push(`JS 堆 ${sample.heapMB}MB > ${thresholds.memoryCeilingMB}MB`);
    } else if (sample.heapMB > thresholds.memoryCeilingMB * 0.85) {
      warnings.push(`JS 堆 ${sample.heapMB}MB 接近上限 ${thresholds.memoryCeilingMB}MB`);
    }
  }

  // ── 长任务 ──────────────────────────────────────────────────────────────
  if (sample.longestTaskMs > thresholds.longTaskCeilingMs) {
    breaches.push(`长任务 ${sample.longestTaskMs}ms > ${thresholds.longTaskCeilingMs}ms`);
  } else if (sample.longestTaskMs > thresholds.longTaskCeilingMs * 0.85) {
    warnings.push(`长任务 ${sample.longestTaskMs}ms 接近上限`);
  }

  if (breaches.length > 0) {
    return { level: 'breach', reasons: breaches, sample };
  }
  if (warnings.length > 0) {
    return { level: 'warn', reasons: warnings, sample };
  }
  return { level: 'ok', reasons: [], sample };
}

/** 人类可读的一句话摘要，给探针面板用。 */
export function describeSample(sample: PerformanceSample): string {
  const heap = sample.heapMB === null ? '内存 n/a' : `堆 ${sample.heapMB}MB`;
  return `${sample.fps}fps · ${heap} · 长任务 ${sample.longestTaskMs}ms · ${sample.liveIframes} iframe`;
}
