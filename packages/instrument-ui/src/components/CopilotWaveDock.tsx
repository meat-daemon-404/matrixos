import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../lib/cx';
import { accentStyle } from '../lib/accent';
import type { InstrumentAccent } from '../lib/accent';
import { usePrefersReducedMotion } from '../lib/hooks';
import { clamp } from '../lib/math';
import '../styles/components/copilot-dock.css';

/** Copilot 的四态。 */
export type CopilotState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface CopilotWaveDockProps {
  /** 状态（受控）。 */
  state?: CopilotState;
  /** 展开（受控）。不传则内部态。 */
  expanded?: boolean;
  /** 非受控初始展开态，默认 true。 */
  defaultExpanded?: boolean;
  /** 展开态变化。 */
  onExpandedChange?: (expanded: boolean) => void;

  /** 状态文案（展开条左侧）。 */
  statusText?: string;
  /** 上下文标签（如「当前在 CurveLab」）。 */
  contextLabel?: string;
  /** 输入框占位文案。 */
  placeholder?: string;
  /** 提交查询（回车或点发送）。 */
  onQuery?: (query: string) => void;
  /** 点击坍缩后的能量球。 */
  onOrbClick?: () => void;

  /**
   * 声波数据。
   * - `'breathing'`（默认）：呼吸光带，不需要数据；
   * - 数字数组：真实波形（长度会被重采样到 48 柱）。
   */
  waveform?: number[] | 'breathing';

  /** 强调色，默认 indigo（主行动色）。 */
  accent?: InstrumentAccent;
  /** 坍缩时能量球的位置，默认 'bottom-right'。 */
  orbPosition?: 'bottom-right' | 'bottom-left';
  /** 是否固定定位（hub 用 fixed，微站内嵌用 static）。 */
  fixed?: boolean;
  /** 自定义左侧图标。 */
  icon?: ReactNode;
  /** 无障碍描述。 */
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

const STATE_TEXT: Record<CopilotState, string> = {
  idle: 'AI Copilot · 待命',
  listening: '正在聆听…',
  thinking: '正在推演…',
  speaking: '正在回答…',
};

const WAVE_BARS = 48;

/**
 * `<CopilotWaveDock>` 底部声波脉冲坞。
 *
 * 视觉来源：bundle UI_01 底部的「AI Copilot / Active Inference」声波条。
 *
 * 动效策略（这是最容易写崩性能的组件，特意做了取舍）：
 * - 48 根波形柱的动画**全部是 CSS keyframes**，用 `animation-delay` 按索引错相，
 *   而不是 JS 每帧改 48 个 style —— 后者在低端设备上必然掉帧。
 * - 柱子只动 `transform: scaleY()` 与 `opacity`，都在合成层，不触发重排。
 * - 状态切换（idle→thinking）只换一个 `data-state` 属性，CSS 换 animation 名。
 * - 坍缩态的能量球复用原设计的 `pulse-orb`（2.8s），但把无限动画限制在
 *   直径 48px 的小圆上，影响面最小。
 * - `prefers-reduced-motion`：波形变成静态柱高，呼吸球停转，保留全部状态文案。
 */
export function CopilotWaveDock({
  state = 'idle',
  expanded,
  defaultExpanded = true,
  onExpandedChange,
  statusText,
  contextLabel,
  placeholder = '问点什么… 例如「把 τ₁ 拟合结果投到星门导师页」',
  onQuery,
  onOrbClick,
  waveform = 'breathing',
  accent = 'indigo',
  orbPosition = 'bottom-right',
  fixed = true,
  icon,
  ariaLabel,
  className,
  style,
  ...rest
}: CopilotWaveDockProps) {
  const uid = useId();
  const reducedMotion = usePrefersReducedMotion();
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isControlled = expanded !== undefined;
  const isExpanded = isControlled ? Boolean(expanded) : internalExpanded;

  const setExpanded = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalExpanded(next);
      onExpandedChange?.(next);
    },
    [isControlled, onExpandedChange],
  );

  // 波形数据：'breathing' → 所有柱同高；数组 → 重采样
  const bars = useMemo(() => {
    if (waveform === 'breathing') {
      return Array.from({ length: WAVE_BARS }, (_, i) => {
        // 中间高两边低的钟形包络，配合 CSS 呼吸动画
        const center = (WAVE_BARS - 1) / 2;
        const distance = Math.abs(i - center) / center;
        return clamp(1 - distance * 0.68, 0.18, 1);
      });
    }
    if (waveform.length === 0) return new Array(WAVE_BARS).fill(0.15) as number[];
    const out: number[] = [];
    for (let i = 0; i < WAVE_BARS; i += 1) {
      const idx = Math.floor((i / WAVE_BARS) * waveform.length);
      out.push(clamp(waveform[idx] ?? 0, 0, 1));
    }
    return out;
  }, [waveform]);

  const submit = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    onQuery?.(trimmed);
    setQuery('');
  }, [onQuery, query]);

  // Ctrl/Cmd + K 唤起（行业惯例，不劫持普通按键）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setExpanded(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      if (event.key === 'Escape' && isExpanded && focused) {
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focused, isExpanded, setExpanded]);

  const label = ariaLabel ?? `AI Copilot 语音/文本坞 · ${STATE_TEXT[state]}`;

  return (
    <div
      className={cx(
        'iu-root',
        'iu-dock',
        fixed ? 'is-fixed' : 'is-static',
        isExpanded ? 'is-expanded' : 'is-collapsed',
        `is-orb-${orbPosition}`,
        className,
      )}
      style={accentStyle(accent, style)}
      data-state={state}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      aria-label={label}
      {...rest}
    >
      {/* ---- 展开态：底部声波带 ---- */}
      <div
        className="iu-dock__bar"
        role="region"
        aria-label="Copilot 输入坞"
        aria-hidden={isExpanded ? undefined : true}
        inert={isExpanded ? undefined : ('' as unknown as boolean)}
      >
        <span className="iu-dock__glow" aria-hidden="true" />

        <div className="iu-dock__row">
          <span className="iu-dock__icon" aria-hidden="true">
            {icon ?? (
              <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
                <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="0.8" opacity="0.5" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
              </svg>
            )}
          </span>

          <div className="iu-dock__status">
            <span className="iu-dock__status-text">{statusText ?? STATE_TEXT[state]}</span>
            {contextLabel ? (
              <span className="iu-dock__context iu-num">{contextLabel}</span>
            ) : null}
          </div>

          {/* 声波：48 根 CSS 动画柱 */}
          <div className="iu-dock__wave" aria-hidden="true">
            {bars.map((height, index) => (
              <span
                key={index}
                className="iu-dock__wave-bar"
                style={
                  {
                    '--iu-bar-h': String(clamp(height, 0.08, 1)),
                    '--iu-bar-i': String(index),
                    height: `calc(var(--iu-dock-wave-h) * ${clamp(height, 0.08, 1)})`,
                  } as CSSProperties
                }
              />
            ))}
          </div>

          <form
            className="iu-dock__form"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label className="iu-sr-only" htmlFor={`${uid}-input`}>
              Copilot 查询
            </label>
            <input
              ref={inputRef}
              id={`${uid}-input`}
              className="iu-dock__input"
              type="text"
              value={query}
              placeholder={placeholder}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              autoComplete="off"
            />
            <button
              type="submit"
              className="iu-dock__send iu-focus"
              disabled={query.trim().length === 0}
              aria-label="发送查询"
            >
              ↵
            </button>
          </form>

          <button
            type="button"
            className="iu-dock__collapse iu-focus"
            onClick={() => setExpanded(false)}
            aria-label="坍缩为能量球"
            title="坍缩 (Esc)"
          >
            ⌄
          </button>
        </div>

        {/* 底部相位带：一条细的呼吸光带 */}
        <span className="iu-dock__phase" aria-hidden="true" />
      </div>

      {/* ---- 坍缩态：右下角能量球 ---- */}
      <button
        type="button"
        className="iu-dock__orb iu-focus pulse-orb"
        aria-label="展开 AI Copilot"
        aria-expanded={isExpanded}
        tabIndex={isExpanded ? -1 : 0}
        aria-hidden={isExpanded ? true : undefined}
        onClick={() => {
          setExpanded(true);
          onOrbClick?.();
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <span className="iu-dock__orb-ring" aria-hidden="true" />
        <span className="iu-dock__orb-core" aria-hidden="true" />
        <span className="iu-dock__orb-badge" aria-hidden="true" data-state={state} />
      </button>

      {/* 状态播报（屏幕阅读器） */}
      <span className="iu-sr-only" role="status" aria-live="polite">
        {STATE_TEXT[state]}
        {isExpanded ? '，输入坞已展开' : '，已坍缩为能量球'}
      </span>
    </div>
  );
}

export { STATE_TEXT as COPILOT_STATE_TEXT };
