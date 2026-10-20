import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../lib/cx';
import { accentStyle } from '../lib/accent';
import type { InstrumentAccent, InstrumentSize } from '../lib/accent';
import { useDialDrag } from '../lib/useDialDrag';
import { useUid } from '../lib/hooks';
import {
  clamp,
  decimalsOf,
  formatFixed,
  niceTicks,
  normalize,
  polarToCartesian,
  roundTo,
  snapToStep,
} from '../lib/math';
import '../styles/components/damped-knob.css';

export interface DampedKnobProps {
  /** 受控值。不传则非受控（用 defaultValue）。 */
  value?: number;
  /** 非受控初始值。 */
  defaultValue?: number;
  /** 最小值，默认 0。 */
  min?: number;
  /** 最大值，默认 100。 */
  max?: number;
  /** 步进，默认 1。小于 1 时自动按步进取小数位显示。 */
  step?: number;
  /** 数值变化（拖动过程中高频触发，已按 step 吸附）。 */
  onChange?: (value: number) => void;
  /** 拖动结束 / 键盘调整结束（用于触发昂贵重算，如重拟合）。 */
  onCommit?: (value: number) => void;

  /** 旋钮标签（同时作为可访问名称的一部分）。 */
  label?: string;
  /** 单位后缀，如 `ns`、`%`。 */
  unit?: string;
  /** 自定义读数格式化。 */
  formatValue?: (value: number) => string;

  /** 尺寸档位，默认 md（56px 盘面）。 */
  size?: InstrumentSize;
  /** 强调色，默认跟随 --iu-accent（cyam 仪器色）。 */
  accent?: InstrumentAccent;
  /** 禁用。 */
  disabled?: boolean;

  /** 盘面转角行程（度），默认 270。 */
  sweep?: number;
  /** 刻度数量（0 = 不画刻度）。 */
  tickCount?: number;
  /** 是否允许点击读数直接输入精确值，默认 true。 */
  editable?: boolean;

  /** 读数下方的补充说明（如 τ₁ / 拟合参量名）。 */
  hint?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** 透传给根节点的 data-* 测试钩子等。 */
  'data-testid'?: string;
}

const SIZE_PX: Record<InstrumentSize, number> = { sm: 44, md: 56, lg: 76 };

/**
 * `<DampedKnob>` 精密阻尼旋钮。
 *
 * 交互模型：
 * - **拖动**：垂直位移为主通道（向上增大），叠加指针绕圈的角度增量实现
 *   「无限旋转」——绕过屏幕边缘还能继续加，这是精密仪器旋钮的手感核心。
 * - **键盘**：方向键 ±step，Shift+方向键 ±10×step，PageUp/PageDown ±10×step，
 *   Home/End 到极值。全部走 `role="slider"` 语义，屏幕阅读器可读数值。
 * - **精确输入**：点击读数变为输入框，回车提交（避免拖动难以命中 0.01 的精度）。
 *
 * 性能：拖动期间只重算数值，指针的视觉转角由 CSS `transform: rotate()` 承担，
 * 不写任何布局属性；`will-change: transform` 只在拖动时挂上，结束即摘除。
 */
export function DampedKnob({
  value,
  defaultValue = 0,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  onCommit,
  label,
  unit,
  formatValue,
  size = 'md',
  accent,
  disabled = false,
  sweep = 270,
  tickCount = 11,
  editable = true,
  hint,
  className,
  style,
  ...rest
}: DampedKnobProps) {
  const uid = useUid('iu-knob');
  const [internal, setInternal] = useState(() => clamp(defaultValue, min, max));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isControlled = value !== undefined;
  const current = clamp(isControlled ? (value as number) : internal, min, max);
  const decimals = useMemo(() => decimalsOf(step), [step]);

  const emit = useCallback(
    (next: number) => {
      const snapped = clamp(snapToStep(next, step, min), min, max);
      if (!isControlled) setInternal(snapped);
      onChange?.(snapped);
      return snapped;
    },
    [isControlled, max, min, onChange, step],
  );

  const handlers = useDialDrag({
    min,
    max,
    value: current,
    step,
    sensitivity: 0.55,
    onChange: emit,
    onDragEnd: () => onCommit?.(current),
    disabled,
  });

  const fraction = normalize(current, min, max);
  // 指针角度：-sweep/2 → +sweep/2
  const needleAngle = (fraction - 0.5) * sweep;
  const px = SIZE_PX[size];
  const viewBox = 100;
  const center = viewBox / 2;

  const ticks = useMemo(() => {
    if (tickCount <= 0) return [];
    const values = niceTicks(min, max, Math.max(2, tickCount));
    const source = values.length >= 2 ? values : [min, max];
    return source.map((tickValue) => ({
      value: tickValue,
      angle: (normalize(tickValue, min, max) - 0.5) * sweep,
    }));
  }, [min, max, sweep, tickCount]);

  const text = formatValue
    ? formatValue(current)
    : `${formatFixed(current, decimals)}${unit ? ` ${unit}` : ''}`;

  const commitDraft = useCallback(() => {
    const parsed = Number.parseFloat(draft.replace(/[^0-9+\-.]/g, ''));
    if (Number.isFinite(parsed)) {
      const next = emit(parsed);
      onCommit?.(next);
    }
    setEditing(false);
  }, [draft, emit, onCommit]);

  const ariaValueText = `${formatFixed(current, decimals)}${unit ? ` ${unit}` : ''}`;

  return (
    <div
      className={cx('iu-root', 'iu-knob', disabled && 'iu-knob--disabled', className)}
      style={accentStyle(accent, { ...style, ['--iu-knob-size' as string]: `${px}px` })}
      data-size={size}
      data-dragging={handlers.dragging ? 'true' : 'false'}
      {...rest}
    >
      {label ? (
        <span className="iu-label iu-knob__label" id={`${uid}-label`}>
          {label}
        </span>
      ) : null}

      <div
        className="iu-knob__dial iu-focus"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={roundTo(current, decimals)}
        aria-valuetext={ariaValueText}
        aria-disabled={disabled || undefined}
        aria-label={label ?? '数值旋钮'}
        aria-describedby={label ? undefined : undefined}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerCancel}
        onLostPointerCapture={handlers.onLostPointerCapture}
        onKeyDown={handlers.onKeyDown}
        onFocus={handlers.onFocus}
        onBlur={handlers.onBlur}
        onDoubleClick={() => {
          if (!editable || disabled) return;
          setDraft(formatFixed(current, decimals));
          setEditing(true);
          requestAnimationFrame(() => inputRef.current?.select());
        }}
        data-iu-dragging={handlers.dragging ? 'true' : 'false'}
      >
        <svg
          className="iu-knob__svg"
          viewBox={`0 0 ${viewBox} ${viewBox}`}
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            {/* 金属倒角：左上受光、右下背光 */}
            <linearGradient id={`${uid}-metal`} x1="18%" y1="0%" x2="82%" y2="100%">
              <stop offset="0%" stopColor="#2a3550" />
              <stop offset="38%" stopColor="#151d33" />
              <stop offset="100%" stopColor="#070b18" />
            </linearGradient>
            {/* 盘面：中心略亮的径向渐变，模拟磨砂金属 */}
            <radialGradient id={`${uid}-face`} cx="38%" cy="30%" r="78%">
              <stop offset="0%" stopColor="#1b2440" />
              <stop offset="55%" stopColor="#0d1425" />
              <stop offset="100%" stopColor="#050a14" />
            </radialGradient>
            {/* 顶部高光弧 */}
            <linearGradient id={`${uid}-sheen`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.16" />
              <stop offset="55%" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
            <filter id={`${uid}-glow`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* 外框 */}
          <circle cx={center} cy={center} r="47" fill={`url(#${uid}-metal)`} />
          <circle
            cx={center}
            cy={center}
            r="47"
            fill="none"
            stroke="rgb(255 255 255 / 0.07)"
            strokeWidth="1"
          />

          {/* 刻度环 */}
          {ticks.map((tick, index) => {
            const outer = polarToCartesian(center, center, 44.5, tick.angle);
            const inner = polarToCartesian(center, center, 38.5, tick.angle);
            const major = index === 0 || index === ticks.length - 1 || index === (ticks.length - 1) / 2;
            return (
              <line
                key={`tick-${tick.value}`}
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
                stroke={major ? 'var(--iu-text-muted)' : 'var(--iu-text-faint)'}
                strokeWidth={major ? 1.4 : 0.9}
                strokeLinecap="round"
                opacity={major ? 0.95 : 0.6}
              />
            );
          })}

          {/* 已走过行程的强调弧 */}
          <circle
            cx={center}
            cy={center}
            r="43"
            fill="none"
            stroke="var(--iu-accent)"
            strokeOpacity="0.85"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray={`${(Math.abs(fraction) * sweep * Math.PI * 43) / 180} 999`}
            transform={`rotate(${-sweep / 2} ${center} ${center})`}
            filter={`url(#${uid}-glow)`}
            className="iu-knob__arc"
          />

          {/* 盘面 */}
          <circle cx={center} cy={center} r="34" fill={`url(#${uid}-face)`} />
          <circle
            cx={center}
            cy={center}
            r="34"
            fill="none"
            stroke="rgb(255 255 255 / 0.06)"
            strokeWidth="1"
          />

          {/* 指针：只改 transform，不动几何 */}
          <g
            className="iu-knob__needle"
            style={{
              transform: `rotate(${needleAngle}deg)`,
              transformOrigin: `${center}px ${center}px`,
            }}
            data-dragging={handlers.dragging ? 'true' : 'false'}
          >
            <line
              x1={center}
              y1={center - 12}
              x2={center}
              y2={center - 27}
              stroke="var(--iu-accent-bright)"
              strokeWidth="2.6"
              strokeLinecap="round"
              filter={`url(#${uid}-glow)`}
            />
            {/* 表面高光 */}
            <path
              d={`M ${center - 24} ${center - 12} A 30 30 0 0 1 ${center + 24} ${center - 12} L ${center + 20} ${center - 6} A 25 25 0 0 0 ${center - 20} ${center - 6} Z`}
              fill={`url(#${uid}-sheen)`}
            />
          </g>

          {/* 中心轴帽 */}
          <circle cx={center} cy={center} r="6.5" fill={`url(#${uid}-metal)`} />
          <circle cx={center} cy={center} r="6.5" fill="none" stroke="rgb(0 0 0 / 0.5)" strokeWidth="1" />
          <circle cx={center} cy={center} r="2.2" fill="var(--iu-accent)" opacity="0.9" />
        </svg>
      </div>

      {/* 读数 */}
      <div className="iu-knob__readout">
        {editing && editable ? (
          <input
            ref={inputRef}
            className="iu-readout iu-knob__input"
            value={draft}
            inputMode="decimal"
            aria-label={`${label ?? '数值'}：输入精确值`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className="iu-readout iu-knob__value"
            aria-hidden="true"
            title={editable ? '双击输入精确值' : undefined}
          >
            {text}
          </span>
        )}
        {unit && formatValue ? <span className="iu-knob__unit">{unit}</span> : null}
      </div>

      {hint ? <span className="iu-hint iu-knob__hint">{hint}</span> : null}
    </div>
  );
}

export { SIZE_PX as DAMPED_KNOB_SIZE_PX };
