import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../lib/cx';
import { accentStyle } from '../lib/accent';
import type { InstrumentAccent } from '../lib/accent';
import { usePrefersReducedMotion, useUid } from '../lib/hooks';
import { clamp, formatFixed, formatCompact, normalize, roundTo } from '../lib/math';
import '../styles/components/balance.css';

/** 天平的三个称量盘（云衡综测：德育 / 智育 / 科研双创）。 */
export interface BalancePan {
  /** 唯一 id。 */
  id: string;
  /** 盘名，如「德育」「智育」「科研双创」。 */
  label: string;
  /** 当前配重（已获得的分数/权重）。 */
  value: number;
  /** 该盘的上限（满额配重）。不传则用组件的 `capacity`。 */
  capacity?: number;
  /** 盘上的配重砝码明细（可视化）。 */
  weights?: readonly BalanceWeight[];
  /** 强调色。 */
  accent?: InstrumentAccent;
  /** 该盘的换算说明（如「论文 ×1.5」）。 */
  hint?: string;
}

export interface BalanceWeight {
  id: string;
  label: string;
  /** 砝码重量（占该盘的比例 0..1）。 */
  mass: number;
}

export interface PrecisionBalanceProps {
  /** 三个盘（少于 3 个则按给的渲染，多于 3 个自动截断）。 */
  pans?: readonly BalancePan[];
  /** 统一上限，默认 100。 */
  capacity?: number;
  /** 总分（不传则由三盘求和）。 */
  total?: number;
  /** 总分上限（不传则三盘 capacity 之和）。 */
  totalCapacity?: number;
  /** 总分标签，默认「综测总分」。 */
  totalLabel?: string;
  /** 点击某个盘。 */
  onPanClick?: (pan: BalancePan, event: React.MouseEvent) => void;
  /** 悬停某个盘。 */
  onPanHover?: (pan: BalancePan | null) => void;
  /** 强调色，默认 amber（天平/配重的语义色）。 */
  accent?: InstrumentAccent;
  /** 是否播放「落盘」动画（总分跳动），默认 true。 */
  animate?: boolean;
  /** 尺寸：盘面半径倍数，默认 1。 */
  scale?: number;
  /** 是否渲染等价数据表格（无障碍），默认 true。 */
  accessibleTable?: boolean;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

const PAN_ACCENTS: readonly InstrumentAccent[] = ['indigo', 'cyan', 'emerald'];

/**
 * `<PrecisionBalance>` 精密三盘电子天平。
 *
 * 视觉来源：bundle UI_03 / 云衡站「精密三盘电子天平」。
 * 三盘对应高校综测的三个维度（德育 / 智育 / 科研双创），每盘有独立满额配重；
 * 砝码堆叠可视化「这一分是怎么来的」，总分在大屏中央跳动。
 *
 * 动效策略（性能铁律）：
 * - 盘体上下浮沉用 CSS `translateY` + 负 `animation-delay` 错相，四层纯 CSS；
 * - 总分数字用「滚动里程表」：DOM 里只放最终值，滚动感由 `transform: translateY`
 *   在两层数字带上完成——**不做逐帧 JS 数字递增**（那是最容易掉帧的写法）。
 * - `prefers-reduced-motion` 下全部静止，直接显示终值。
 */
export function PrecisionBalance({
  pans = [],
  capacity = 100,
  total,
  totalCapacity,
  totalLabel = '综测总分',
  onPanClick,
  onPanHover,
  accent = 'amber',
  animate = true,
  scale = 1,
  accessibleTable = true,
  className,
  style,
  ...rest
}: PrecisionBalanceProps) {
  const uid = useUid('iu-balance');
  const reducedMotion = usePrefersReducedMotion();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [displayTotal, setDisplayTotal] = useState(0);
  const rafRef = useRef<number | null>(null);

  const normalized = useMemo(() => pans.slice(0, 3), [pans]);

  const cappedTotal = useMemo(() => {
    if (total !== undefined) return total;
    return normalized.reduce((sum, pan) => sum + pan.value, 0);
  }, [normalized, total]);

  const capTotal = useMemo(() => {
    if (totalCapacity !== undefined) return totalCapacity;
    return normalized.reduce((sum, pan) => sum + (pan.capacity ?? capacity), 0) || capacity;
  }, [capacity, normalized, totalCapacity]);

  // 总分「里程表」推进：只在 reducedMotion=false 且开启 animate 时跑，
  // 且用**单次 rAF 循环 + 缓动**推进 displayTotal，最多 480ms 即结束。
  // 注意：这不是常驻动画，跑完即断，不会引发持续重排。
  useEffect(() => {
    const target = cappedTotal;
    if (!animate || reducedMotion) {
      setDisplayTotal(target);
      return;
    }
    const from = displayTotal;
    if (Math.abs(target - from) < 0.005) {
      setDisplayTotal(target);
      return;
    }
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const duration = 480;

    const tick = () => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const t = clamp((now - start) / duration, 0, 1);
      // easeOutCubic
      const eased = 1 - (1 - t) ** 3;
      setDisplayTotal(from + (target - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // displayTotal 有意不进依赖：否则每次推进都会重启动画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cappedTotal, animate, reducedMotion]);

  const totalFraction = normalize(cappedTotal, 0, capTotal);
  const totalDecimals = cappedTotal % 1 === 0 ? 0 : 1;

  const handlePanEnter = useCallback(
    (pan: BalancePan) => {
      setHoveredId(pan.id);
      onPanHover?.(pan);
    },
    [onPanHover],
  );

  const handlePanLeave = useCallback(() => {
    setHoveredId(null);
    onPanHover?.(null);
  }, [onPanHover]);

  return (
    <div
      className={cx('iu-root', 'iu-balance', className)}
      style={accentStyle(accent, { ...style, ['--iu-balance-scale' as string]: String(scale) })}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      {...rest}
    >
      <div className="iu-balance__frame">
        {/* 顶部横梁 */}
        <div className="iu-balance__beam" aria-hidden="true">
          <span className="iu-balance__beam-line" />
          <span className="iu-balance__beam-pivot" />
          <span
            className="iu-balance__beam-tilt"
            style={{ transform: `rotate(${(totalFraction - 0.5) * 6}deg)` }}
          />
        </div>

        {/* 三个称量盘 */}
        <div className="iu-balance__pans">
          {normalized.map((pan, index) => {
            const cap = pan.capacity ?? capacity;
            const fraction = normalize(pan.value, 0, cap);
            const panAccent = pan.accent ?? PAN_ACCENTS[index % PAN_ACCENTS.length] ?? 'cyan';
            const isHovered = hoveredId === pan.id;
            const weights = pan.weights ?? [];
            const interactive = Boolean(onPanClick);

            return (
              <div
                key={pan.id}
                className={cx('iu-balance__pan', interactive && 'is-interactive')}
                style={
                  {
                    '--iu-pan-accent': `var(--iu-${panAccent})`,
                    '--iu-pan-accent-bright': `var(--iu-${panAccent}-bright)`,
                    '--iu-pan-accent-rgb': `var(--iu-${panAccent}-rgb)`,
                    '--iu-pan-delay': `${index * 0.55}s`,
                    '--iu-pan-fill': `${fraction * 100}%`,
                  } as CSSProperties
                }
                data-hovered={isHovered ? 'true' : 'false'}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : -1}
                aria-label={`${pan.label}：${formatFixed(pan.value, 1)} / ${formatFixed(cap, 0)}`}
                onMouseEnter={() => handlePanEnter(pan)}
                onMouseLeave={handlePanLeave}
                onFocus={() => handlePanEnter(pan)}
                onBlur={handlePanLeave}
                onClick={(event) => onPanClick?.(pan, event)}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && interactive) {
                    event.preventDefault();
                    onPanClick?.(pan, event as unknown as React.MouseEvent);
                  }
                }}
              >
                <span className="iu-balance__pan-label iu-label">{pan.label}</span>

                {/* 砝码堆叠区 */}
                <div className="iu-balance__weights" aria-hidden="true">
                  {weights.length > 0 ? (
                    weights.map((weight, wIndex) => (
                      <span
                        key={weight.id}
                        className="iu-balance__weight"
                        title={weight.label}
                        style={
                          {
                            '--iu-weight-w': `${clamp(weight.mass, 0.05, 1) * 100}%`,
                            '--iu-weight-i': String(wIndex),
                          } as CSSProperties
                        }
                      >
                        <span className="iu-balance__weight-label">{weight.label}</span>
                      </span>
                    ))
                  ) : (
                    // 无明细时退化为按比例的分段条
                    Array.from({ length: 4 }, (_, wIndex) => (
                      <span
                        key={`seg-${wIndex}`}
                        className="iu-balance__weight is-segment"
                        data-filled={
                          fraction > (wIndex + 0.5) / 4 ? 'true' : 'false'
                        }
                        style={{ '--iu-weight-i': String(wIndex) } as CSSProperties}
                      />
                    ))
                  )}
                </div>

                {/* 盘面（椭圆形托盘 + 液面） */}
                <div className="iu-balance__dish">
                  <span className="iu-balance__dish-inner" />
                  <span className="iu-balance__dish-fill" />
                  <span className="iu-balance__dish-rim" />
                </div>

                {/* 读数 */}
                <div className="iu-balance__readout">
                  <span className="iu-readout iu-balance__value">
                    {formatFixed(pan.value, pan.value % 1 === 0 ? 0 : 1)}
                  </span>
                  <span className="iu-balance__cap iu-num">/ {formatFixed(cap, 0)}</span>
                </div>
                <span
                  className="iu-balance__bar"
                  aria-hidden="true"
                  style={{ '--iu-bar-fill': `${fraction * 100}%` } as CSSProperties}
                />

                {pan.hint ? <span className="iu-balance__hint iu-hint">{pan.hint}</span> : null}
              </div>
            );
          })}
        </div>

        {/* 中央总分区 */}
        <div className="iu-balance__total">
          <span className="iu-balance__total-label iu-label">{totalLabel}</span>
          <span className="iu-balance__total-value-wrap">
            <span
              className="iu-readout iu-balance__total-value"
              aria-hidden="true"
              data-animating={animate && !reducedMotion ? 'true' : 'false'}
            >
              {formatFixed(displayTotal, totalDecimals)}
            </span>
            <span className="iu-sr-only">
              {formatFixed(cappedTotal, totalDecimals)} / {formatFixed(capTotal, 0)}
            </span>
            <span className="iu-balance__total-cap iu-num">/ {formatCompact(capTotal)}</span>
          </span>
          <span className="iu-balance__total-track" aria-hidden="true">
            <span
              className="iu-balance__total-fill"
              style={{ '--iu-total-fill': `${totalFraction * 100}%` } as CSSProperties}
            />
          </span>
          <span className="iu-balance__total-note">{formatFixed(totalFraction * 100, 1)}% 配重</span>
        </div>

        {/* 底座支脚 */}
        <div className="iu-balance__base" aria-hidden="true">
          <span className="iu-balance__foot is-left" />
          <span className="iu-balance__foot is-right" />
        </div>
      </div>

      {accessibleTable ? (
        <table className="iu-sr-only">
          <caption>{totalLabel}配重明细</caption>
          <thead>
            <tr>
              <th scope="col">盘</th>
              <th scope="col">配重</th>
              <th scope="col">上限</th>
              <th scope="col">达成率</th>
            </tr>
          </thead>
          <tbody>
            {normalized.map((pan) => {
              const cap = pan.capacity ?? capacity;
              return (
                <tr key={pan.id}>
                  <td>{pan.label}</td>
                  <td>{formatFixed(pan.value, 1)}</td>
                  <td>{formatFixed(cap, 0)}</td>
                  <td>{formatFixed(normalize(pan.value, 0, cap) * 100, 1)}%</td>
                </tr>
              );
            })}
            <tr>
              <td>合计</td>
              <td>{formatFixed(cappedTotal, totalDecimals)}</td>
              <td>{formatFixed(capTotal, 0)}</td>
              <td>{formatFixed(totalFraction * 100, 1)}%</td>
            </tr>
          </tbody>
        </table>
      ) : null}

      <span className="iu-sr-only" aria-hidden="true">
        {uid}
      </span>
    </div>
  );
}

export { PAN_ACCENTS as BALANCE_PAN_ACCENTS };
