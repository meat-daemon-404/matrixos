'use client';

/**
 * CopilotWaveDock · 底部声波脉冲坞
 * ==========================================================================
 * 两态（与 ui-library 的 CopilotWaveDock 同签名）：
 *   - 展开态（expanded）：底部横贯的声波带 + 查询输入
 *   - 坍缩态（!expanded）：右下角呼吸球（pulseSoft 2.8s，visual-system §6.1 唯一自定义动画）
 *
 * 坍缩时机：**全屏入站后自动坍缩**（架构 A4）。
 * "全屏入站"在本 hub 里有两条路径：① 点 [↗ 全屏独立打开] 开了新标签页；
 * ② 星轨 Semantic Zoom 推到 10x 把某个站推满屏。两者都会让坞让位，故统一由
 * `autoCollapseWhen` 控制，本组件只认 expanded 受控值。
 *
 * 性能：声波条是纯 CSS `animation: wavePulse`（transform: scaleY），
 * 条数固定 48 根一次性渲染，**没有任何 JS 逐帧**。动画延迟用 index 的确定性序列，
 * 不用随机数 —— 避免 SSR/CSR 不一致与每次渲染重排。
 */

import { useCallback, useState } from 'react';

export type WaveDockState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** 声波条数量。48 根在 1200px 宽的坞里约 25px/根，视觉足够密但不糊。 */
const WAVE_BAR_COUNT = 48;

/** 每根条的动画延迟（ms）：用正弦包络让"波峰"从中间向两侧扩散。 */
const WAVE_DELAYS: readonly number[] = Array.from({ length: WAVE_BAR_COUNT }, (_, index) => {
  const center = (WAVE_BAR_COUNT - 1) / 2;
  const distance = Math.abs(index - center) / center; // 0（中间）→ 1（两端）
  return Math.round(distance * 620);
});

/** 每根条的基础高度系数（正弦包络），让静止态就有"声波"形状而非等高柱 */
const WAVE_HEIGHT_FACTOR: readonly number[] = Array.from({ length: WAVE_BAR_COUNT }, (_, index) => {
  const center = (WAVE_BAR_COUNT - 1) / 2;
  const distance = Math.abs(index - center) / center;
  return Math.round((1 - distance * 0.62) * 100) / 100;
});

export interface CopilotWaveDockProps {
  /** 受控展开态；不传则内部态（与 instrument-ui 一致） */
  readonly expanded?: boolean;
  readonly defaultExpanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly state?: WaveDockState;
  readonly statusText?: string;
  readonly contextLabel?: string;
  readonly placeholder?: string;
  readonly onQuery?: (query: string) => void;
  /** 坍缩球上的未读徽标数（例如虫洞收据 / 探针告警） */
  readonly badgeCount?: number;
  /** 是否因为"全屏入站"而自动坍缩（用于 statusText 的措辞） */
  readonly autoCollapsed?: boolean;
}

export function CopilotWaveDock({
  expanded,
  defaultExpanded = true,
  onExpandedChange,
  state = 'idle',
  statusText,
  contextLabel,
  placeholder = 'How can I help you, scholar?',
  onQuery,
  badgeCount = 0,
  autoCollapsed = false,
}: CopilotWaveDockProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [draft, setDraft] = useState('');

  const isControlled = expanded !== undefined;
  const isExpanded = isControlled ? expanded : internalExpanded;

  const setExpanded = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalExpanded(next);
      onExpandedChange?.(next);
    },
    [isControlled, onExpandedChange],
  );

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const query = draft.trim();
      if (!query) return;
      onQuery?.(query);
      setDraft('');
    },
    [draft, onQuery],
  );

  const resolvedStatus =
    statusText ??
    (state === 'idle'
      ? contextLabel ?? 'DeepSeek V4.1 Flash 路由就绪'
      : state === 'thinking'
        ? '正在编排…'
        : state === 'speaking'
          ? '输出中…'
          : '监听中…');

  // ── 坍缩态：右下角呼吸球 ─────────────────────────────────────────────────
  if (!isExpanded) {
    return (
      <button
        type="button"
        className="wave-orb"
        onClick={() => setExpanded(true)}
        title={
          '展开 AI Copilot 声波坞' + (autoCollapsed ? '（已因全屏入站自动坍缩）' : '')
        }
        aria-label={'展开 AI Copilot 声波坞，当前状态：' + resolvedStatus}
      >
        <span aria-hidden="true">◉</span>
        {badgeCount > 0 ? (
          <span className="wave-orb-badge" aria-label={badgeCount + ' 条待处理'}>
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        ) : null}
      </button>
    );
  }

  // ── 展开态：底部声波带 ───────────────────────────────────────────────────
  return (
    <section
      className="wave-dock"
      data-state={state}
      aria-label="AI Copilot 声波脉冲坞"
      style={{ pointerEvents: 'auto' }}
    >
      <div className="wave-dock-label">
        <b>AI Copilot</b>
        <span className="wave-dock-status">{resolvedStatus}</span>
      </div>

      {/* 声波：纯 CSS 动画，零 JS 逐帧 */}
      <div className="wave-canvas" aria-hidden="true">
        {WAVE_DELAYS.map((delay, index) => (
          <span
            key={index}
            className="wave-bar"
            style={
              {
                ['--wave-delay' as string]: delay + 'ms',
                ['--wave-duration' as string]: 1.2 + (WAVE_HEIGHT_FACTOR[index] ?? 1) * 0.9 + 's',
                height: 100 * (WAVE_HEIGHT_FACTOR[index] ?? 1) + '%',
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      <form className="wave-dock-query" onSubmit={handleSubmit}>
        <input
          className="wave-dock-input"
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          aria-label="向全局 Copilot 提问"
        />
        <button type="submit" className="wave-dock-send" title="发送" aria-label="发送">
          ↵
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setExpanded(false)}
          title="坍缩为右下角呼吸球"
          aria-label="坍缩为呼吸球"
        >
          ▾
        </button>
      </form>
    </section>
  );
}
