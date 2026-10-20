'use client';

/**
 * PerformanceProbePanel · 性能探针可视化面板（S2-01e）
 * ==========================================================================
 * 这个面板的存在有两个目的：
 *  1. **让降级可解释**：用户看到"为什么我的面板变成快照了"，答案是这里的读数，不是玄学。
 *  2. **让 S2-01e 的基线报告能直接在浏览器里出数**：3 iframe 下的实时 fps/内存/长任务，
 *     不用另外装 profiling 工具。
 *
 * 阈值来源：docs/01-plan/05-risks.md §R-T03 的触发信号
 *   帧率 < 45fps / 内存 > 800MB / 长任务 > 100ms
 *
 * 显示原则：**区分"实测"与"预算"**。
 *   `活跃 iframe 1 / 3` 里，1 是实测（数真实 DOM），3 是挂载总数；
 *   `活名额 1` 是策略给出的预算。三者含义不同，混在一起会让人以为探针在自相矛盾。
 */

import { describeSample } from '../lib/performance-probe';
import type { ProbeVerdict } from '../lib/hub-types';

export interface PerformanceProbePanelProps {
  readonly verdict: ProbeVerdict | null;
  readonly strategyLabel: string;
  readonly thresholds: {
    readonly fpsFloor: number;
    readonly memoryCeilingMB: number;
    readonly longTaskCeilingMs: number;
  };
  /** 实测活跃 iframe 数（数真实 DOM，不是按挂载列表推算） */
  readonly liveIframes: number;
  /** 策略允许的活名额（由 degradation-policy 裁决） */
  readonly liveBudget: number;
  /** 当前降级原因（空数组 = 未降级） */
  readonly reasons?: readonly string[];
  readonly onReset?: () => void;
}

export function PerformanceProbePanel({
  verdict,
  strategyLabel,
  thresholds,
  liveIframes,
  liveBudget,
  reasons = [],
  onReset,
}: PerformanceProbePanelProps) {
  const sample = verdict?.sample ?? null;
  const degraded = reasons.length > 0;

  return (
    <aside className="probe-panel" aria-label="性能探针（S2-01e）">
      <div className="probe-head">
        <b>S2-01e</b>
        <span>性能探针</span>
        <span className="panel-head-spacer" />
        <span data-tone={degraded ? 'warn' : undefined}>{strategyLabel}</span>
      </div>

      <div className="probe-row">
        <span>帧率</span>
        <span>
          {sample ? sample.fps + ' fps' : '采样中…'}
          <span style={{ color: 'var(--color-text-faint)' }}> / ≥{thresholds.fpsFloor}</span>
        </span>
      </div>

      <div className="probe-row">
        <span>JS 堆</span>
        <span>
          {sample?.heapMB === null
            ? 'n/a（非 Chromium）'
            : sample
              ? sample.heapMB + ' MB'
              : '采样中…'}
          <span style={{ color: 'var(--color-text-faint)' }}> / &lt;{thresholds.memoryCeilingMB}</span>
        </span>
      </div>

      <div
        className="probe-row"
        data-breach={
          sample && sample.longestTaskMs > thresholds.longTaskCeilingMs ? 'true' : 'false'
        }
      >
        <span>最长任务</span>
        <span>
          {sample ? sample.longestTaskMs + ' ms' : '采样中…'}
          <span style={{ color: 'var(--color-text-faint)' }}> / ≤{thresholds.longTaskCeilingMs}</span>
        </span>
      </div>

      <div className="probe-row" title="活跃 iframe 数来自真实 DOM 查询；活名额是策略给出的预算">
        <span>iframe 实测 / 预算</span>
        <span>
          {liveIframes} / {liveBudget}
          <span style={{ color: 'var(--color-text-faint)' }}> 懒加载</span>
        </span>
      </div>

      {verdict ? (
        <div className="probe-verdict" data-level={verdict.level}>
          {verdict.level === 'ok'
            ? '✓ ' + describeSample(verdict.sample)
            : verdict.reasons.join('；')}
        </div>
      ) : (
        <div className="probe-verdict" data-level="ok">
          正在采集第 1 个采样窗口（1s）…
        </div>
      )}

      {degraded ? (
        <div className="probe-reasons" title="降级策略给出的原因（ADR-09：降级必须可见）">
          {reasons.map((reason, index) => (
            <span key={index}>· {reason}</span>
          ))}
        </div>
      ) : null}

      {onReset ? (
        <button type="button" className="btn" onClick={onReset} style={{ alignSelf: 'flex-start' }}>
          重置超标计数
        </button>
      ) : null}
    </aside>
  );
}