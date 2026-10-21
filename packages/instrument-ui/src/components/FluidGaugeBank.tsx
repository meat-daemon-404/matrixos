import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { cx } from '../lib/cx';
import { accentStyle } from '../lib/accent';
import type { InstrumentAccent } from '../lib/accent';
import { usePrefersReducedMotion, useUid } from '../lib/hooks';
import { clamp, formatFixed, formatCompact, normalize, roundTo } from '../lib/math';
import '../styles/components/fluid-gauge.css';

/** 单根液位柱（大创经费五科目之一）。 */
export interface GaugeColumn {
  /** 唯一 id。 */
  id: string;
  /** 柱名，如「劳务费」「硬件设备」。 */
  label: string;
  /** 当前用量。 */
  value: number;
  /** 上限（预算额）。 */
  capacity: number;
  /**
   * 红线阈值（0..1），含义由 `redlineBasis` 决定：
   * - 缺省 / `'capacity'`：占**本柱 capacity** 的比例。例如「本科目预算用到 85% 就预警」。
   * - `'total'`：占**全项目总额**（`FluidGaugeBankProps.totalBudget`）的比例。
   *   用于「劳务费 ≤ 项目总额 20%」这类跨科目硬限位 —— 此时 capacity 只是本柱的
   *   显示上限，红线换算成 `redline × 总额` 的金额，柱顶即红线。
   */
  redline?: number;
  /**
   * 红线阈值的分母基准，缺省 `'capacity'`。
   *
   * 为什么需要这个字段：高校财务的红线是**项目总额**的比例（劳务费 ≤ 20%），
   * 而柱子的 capacity 是**本柱**的额度，两者不是一回事。把 redline 一律当
   * 「占 capacity 的比例」会把 2500/20000 = 12.5% 的合规状态误判成 62.5% 超限。
   */
  redlineBasis?: 'capacity' | 'total';
  /** 单位，如 `¥`。 */
  unit?: string;
  /** 已冻结（不可再报销）。 */
  locked?: boolean;
  /** 强调色。 */
  accent?: InstrumentAccent;
  /** 科目备注。 */
  hint?: string;
}

export interface FluidGaugeBankProps {
  /** 液位柱列表（3~6 根最合适）。 */
  columns?: readonly GaugeColumn[];
  /** 是否播放液面波动动画，默认 true。 */
  animate?: boolean;
  /** 悬停某柱。 */
  onColumnHover?: (column: GaugeColumn | null) => void;
  /** 点击某柱（跳转明细）。 */
  onColumnClick?: (column: GaugeColumn, event: React.MouseEvent) => void;
  /** 是否在超标时触发阻断动效（闪烁 + 锁定标识），默认 true。 */
  blockOnBreach?: boolean;
  /** 数值格式化（默认按单位自动）。 */
  formatValue?: (value: number, column: GaugeColumn) => string;
  /** 强调色，默认 cyan。 */
  accent?: InstrumentAccent;
  /** 柱高（px），默认 200。 */
  height?: number;
  /**
   * 全项目总额（总览分母，也是 `redlineBasis: 'total'` 的换算基准）。
   * 缺省 = Σ 各柱 capacity。
   *
   * 为什么需要单独传：各科目 capacity 之和常常 ≠ 项目总额（劳务费柱的 capacity
   * 是「红线金额」而非「本科目预算」时尤其如此），拿 Σcapacity 当分母会让
   * 总览显示 93.0% 这种「看起来没花完、其实正好花完」的假读数。
   */
  totalBudget?: number;
  /** 是否渲染等价数据表格（无障碍），默认 true。 */
  accessibleTable?: boolean;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

/**
 * `<FluidGaugeBank>` 多柱流体液位压差计。
 *
 * 视觉来源：bundle UI_02 的「Remanent Plot」多柱图 + 03 站「五柱流体压差计」。
 *
 * 业务语义（WBS S3-MS03 的硬验收）：大创五科目经费里「劳务费 ≤ 20%」是硬红线，
 * 超标**必须阻断**并给出合规调剂方案。因此本组件把「红线」做成一等公民：
 *   - 红线刻度线始终可见（不是只在超标时才出现）
 *   - 液面越过红线 → 整柱转 rose + 危险纹 + 「★ 超限阻断」标识
 *   - `blockOnBreach` 时额外挂一个 `aria-live` 断言，屏幕阅读器能听到阻断
 *
 * 动效策略：
 * - 液面高度用 CSS 变量 + `transition: height`，不做 JS 逐帧；
 * - 液面「波动」用一条倾斜的 SVG 波 + CSS `translateX` 无限动画（合成层）；
 * - `prefers-reduced-motion` 下停止波动，液面直接静态。
 */
export function FluidGaugeBank({
  columns = [],
  animate = true,
  onColumnHover,
  onColumnClick,
  blockOnBreach = true,
  formatValue,
  accent,
  height = 200,
  totalBudget,
  accessibleTable = true,
  className,
  style,
  ...rest
}: FluidGaugeBankProps) {
  const uid = useUid('iu-gauge');
  const reducedMotion = usePrefersReducedMotion();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  /** 总览分母：显式 totalBudget 优先，否则退化为各柱 capacity 之和。 */
  const basisTotal = useMemo(() => {
    if (totalBudget !== undefined && Number.isFinite(totalBudget) && totalBudget > 0) {
      return totalBudget;
    }
    let capacity = 0;
    for (const column of columns) capacity += column.capacity;
    return capacity;
  }, [columns, totalBudget]);

  /**
   * 红线的**金额**（不是比例）。跨科目硬限位（`redlineBasis: 'total'`）按项目总额
   * 折算，本柱限位按本柱 capacity 折算 —— 两者都归一到「多少钱」，比较才不会串味。
   */
  const redlineAmountOf = useCallback(
    (column: GaugeColumn): number | null => {
      if (column.redline === undefined) return null;
      return column.redlineBasis === 'total'
        ? column.redline * basisTotal
        : column.redline * column.capacity;
    },
    [basisTotal],
  );

  /** 已用金额相对「红线分母基准」的比例（用于算超出几个百分点）。 */
  const basisFractionOf = useCallback(
    (column: GaugeColumn): number => {
      const denominator =
        column.redlineBasis === 'total' ? basisTotal : column.capacity;
      if (!Number.isFinite(denominator) || denominator <= 0) return 0;
      return column.value / denominator;
    },
    [basisTotal],
  );

  const isBreachedOf = useCallback(
    (column: GaugeColumn): boolean => {
      const redlineAmount = redlineAmountOf(column);
      if (redlineAmount === null) return false;
      // 绝对金额比较，容差按红线金额的相对量级给，避免浮点尾数把「压线」判成超限
      return column.value - redlineAmount > 1e-9 * Math.max(1, Math.abs(redlineAmount));
    },
    [redlineAmountOf],
  );

  const breached = useMemo(
    () => columns.filter((column) => isBreachedOf(column)),
    [columns, isBreachedOf],
  );

  const totals = useMemo(() => {
    let value = 0;
    for (const column of columns) value += column.value;
    return { value, capacity: basisTotal, fraction: normalize(value, 0, basisTotal) };
  }, [columns, basisTotal]);

  const handleEnter = useCallback(
    (column: GaugeColumn) => {
      setHoveredId(column.id);
      onColumnHover?.(column);
    },
    [onColumnHover],
  );

  const handleLeave = useCallback(() => {
    setHoveredId(null);
    onColumnHover?.(null);
  }, [onColumnHover]);

  const display = useCallback(
    (value: number, column: GaugeColumn): string => {
      if (formatValue) return formatValue(value, column);
      const unit = column.unit ?? '¥';
      return `${unit}${formatCompact(value)}`;
    },
    [formatValue],
  );

  return (
    <div
      className={cx(
        'iu-root',
        'iu-gauge',
        breached.length > 0 && 'is-breached',
        animate && !reducedMotion && 'is-animated',
        className,
      )}
      style={accentStyle(accent, { ...style, ['--iu-gauge-height' as string]: `${height}px` })}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-breached={breached.length > 0 ? 'true' : 'false'}
      {...rest}
    >
      <div className="iu-gauge__frame">
        {/* 顶部铭牌与总览 */}
        <div className="iu-gauge__header">
          <div className="iu-gauge__header-left">
            <span className="iu-label">FLUID DIFFERENTIAL GAUGE</span>
            <span className="iu-gauge__title">经费液位压差计</span>
          </div>
          <div className="iu-gauge__header-right">
            <span className="iu-gauge__total-label iu-label">已用 / 总额</span>
            <span className="iu-readout iu-gauge__total-value">
              {formatFixed(totals.fraction * 100, 1)}%
            </span>
            <span className="iu-gauge__total-sub iu-num">
              ¥{formatCompact(totals.value)} / ¥{formatCompact(totals.capacity)}
            </span>
          </div>
        </div>

        {/* 柱区 */}
        <div
          className="iu-gauge__columns"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` }}
        >
          {columns.map((column) => {
            const fraction = clamp(normalize(column.value, 0, column.capacity), 0, 1.08);
            const redline = column.redline;
            const redlineAmount = redlineAmountOf(column);
            const isBreached = isBreachedOf(column);
            // 红线刻度在柱体上的位置：按「红线金额 / 本柱上限」换算成 0..1 的相对高度。
            // 跨科目限位时红线金额可能超过本柱 capacity（如劳务 4000 vs 上限 4000 恰好贴顶），
            // 此时夹到柱顶 —— 刻度依然可见，不会跑到柱体外面。
            const redlineMark =
              redlineAmount === null || column.capacity <= 0
                ? null
                : clamp(redlineAmount / column.capacity, 0, 1);
            const isHovered = hoveredId === column.id;
            const isLocked = column.locked || (isBreached && blockOnBreach);
            const interactive = Boolean(onColumnClick);
            const columnAccent = column.accent;

            return (
              <div
                key={column.id}
                className={cx(
                  'iu-gauge__column',
                  isBreached && 'is-over',
                  isLocked && 'is-locked',
                  interactive && 'is-interactive',
                )}
                style={
                  {
                    '--iu-gauge-fill': `${Math.min(fraction, 1) * 100}%`,
                    '--iu-gauge-redline': `${(redlineMark ?? 1) * 100}%`,
                    '--iu-gauge-overflow': `${Math.max(0, fraction - 1) * 100}%`,
                    ...(columnAccent
                      ? {
                          '--iu-accent': `var(--iu-${columnAccent})`,
                          '--iu-accent-bright': `var(--iu-${columnAccent}-bright)`,
                          '--iu-accent-rgb': `var(--iu-${columnAccent}-rgb)`,
                        }
                      : {}),
                  } as CSSProperties
                }
                data-hovered={isHovered ? 'true' : 'false'}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : -1}
                aria-label={`${column.label}：${display(column.value, column)} / ${display(
                  column.capacity,
                  column,
                )}${
                  redline === undefined
                    ? ''
                    : column.redlineBasis === 'total'
                      ? `，红线为项目总额的 ${roundTo(redline * 100, 0)}%（${display(
                          redlineAmount ?? 0,
                          column,
                        )}）`
                      : `，红线 ${roundTo(redline * 100, 0)}%`
                }${isBreached ? '，已超红线并阻断' : ''}`}
                onMouseEnter={() => handleEnter(column)}
                onMouseLeave={handleLeave}
                onFocus={() => handleEnter(column)}
                onBlur={handleLeave}
                onClick={(event) => onColumnClick?.(column, event)}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && interactive) {
                    event.preventDefault();
                    onColumnClick?.(column, event as unknown as React.MouseEvent);
                  }
                }}
              >
                {/* 柱体 */}
                <div className="iu-gauge__tube">
                  {/* 刻度（每 25%） */}
                  <div className="iu-gauge__ticks" aria-hidden="true">
                    {[0, 25, 50, 75, 100].map((tick) => (
                      <span
                        key={tick}
                        className="iu-gauge__tick"
                        style={{ bottom: `${tick}%` }}
                        data-major={tick === 0 || tick === 100 ? 'true' : 'false'}
                      />
                    ))}
                  </div>

                  {/* 液面 */}
                  <div className="iu-gauge__fluid" aria-hidden="true">
                    <span className="iu-gauge__fluid-body" />
                    <span className="iu-gauge__fluid-surface" />
                  </div>

                  {/* 红线 */}
                  {redline !== undefined ? (
                    <div
                      className="iu-gauge__redline"
                      aria-hidden="true"
                      data-breached={isBreached ? 'true' : 'false'}
                      data-basis={column.redlineBasis ?? 'capacity'}
                    >
                      <span className="iu-gauge__redline-label">
                        {column.redlineBasis === 'total'
                          ? `红线 项目${roundTo(redline * 100, 0)}% · ${display(
                              redlineAmount ?? 0,
                              column,
                            )}`
                          : `红线 ${roundTo(redline * 100, 0)}%`}
                      </span>
                    </div>
                  ) : null}

                  {/* 危险纹（超限时） */}
                  {isBreached && blockOnBreach ? (
                    <div className="iu-gauge__hazard" aria-hidden="true" />
                  ) : null}

                  {/* 锁定标识 */}
                  {isLocked ? (
                    <span className="iu-gauge__lock" aria-hidden="true" title="已阻断">
                      ⏻
                    </span>
                  ) : null}

                  {/* 气泡（装饰） */}
                  {animate && !reducedMotion ? (
                    <div className="iu-gauge__bubbles" aria-hidden="true">
                      <span className="iu-gauge__bubble" />
                      <span className="iu-gauge__bubble" />
                      <span className="iu-gauge__bubble" />
                    </div>
                  ) : null}
                </div>

                {/* 柱底读数 */}
                <div className="iu-gauge__meta">
                  <span className="iu-gauge__column-label">{column.label}</span>
                  <span className={cx('iu-readout', 'iu-gauge__column-value')}>
                    {display(column.value, column)}
                  </span>
                  <span className="iu-gauge__column-cap iu-num">
                    / {display(column.capacity, column)}
                  </span>
                  <span className="iu-gauge__column-pct iu-num">
                    {formatFixed(fraction * 100, 1)}%
                  </span>
                  {column.hint ? <span className="iu-gauge__column-hint">{column.hint}</span> : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* 阻断横幅：超标时出现，aria-live 让屏幕阅读器也听得到 */}
        {breached.length > 0 && blockOnBreach ? (
          <div className="iu-gauge__block-banner" role="alert">
            <span className="iu-gauge__block-icon" aria-hidden="true">
              ⛔
            </span>
            <span className="iu-gauge__block-text">
              超限阻断：{breached.map((c) => c.label).join('、')} 已越过红线，报销将被拒绝。
              请按下表调剂至合规区间。
            </span>
            <span className="iu-gauge__block-detail">
              {breached
                .map((c) => {
                  const overPoints = (basisFractionOf(c) - (c.redline ?? 1)) * 100;
                  const redlineAmount = redlineAmountOf(c);
                  const amountNote =
                    c.redlineBasis === 'total' && redlineAmount !== null
                      ? `（红线金额 ${display(redlineAmount, c)}）`
                      : '';
                  return `${c.label} 超出 ${formatFixed(overPoints, 1)} 个百分点${amountNote}`;
                })
                .join(' · ')}
            </span>
          </div>
        ) : null}

        {/* 合规刻度表（小字，常在） */}
        <div className="iu-gauge__footer">
          <span className="iu-gauge__legend">
            <span className="iu-gauge__legend-swatch is-safe" />合规区间
          </span>
          <span className="iu-gauge__legend">
            <span className="iu-gauge__legend-swatch is-over" />超红线
          </span>
          <span className="iu-gauge__footer-note">
            红线为硬限位，越线即阻断；液位 = 已报销 / 预算
          </span>
        </div>
      </div>

      {accessibleTable ? (
        <table className="iu-sr-only">
          <caption>经费液位压差计数据表</caption>
          <thead>
            <tr>
              <th scope="col">科目</th>
              <th scope="col">已用</th>
              <th scope="col">预算</th>
              <th scope="col">使用率</th>
              <th scope="col">红线</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => {
              const fraction = normalize(column.value, 0, column.capacity);
              const isBreached = isBreachedOf(column);
              const redlineAmount = redlineAmountOf(column);
              return (
                <tr key={column.id}>
                  <td>{column.label}</td>
                  <td>{formatFixed(column.value, 0)}</td>
                  <td>{formatFixed(column.capacity, 0)}</td>
                  <td>{formatFixed(fraction * 100, 1)}%</td>
                  <td>
                    {column.redline !== undefined
                      ? column.redlineBasis === 'total'
                        ? `项目总额 ${formatFixed(column.redline * 100, 0)}% = ${formatFixed(
                            redlineAmount ?? 0,
                            0,
                          )}`
                        : `${formatFixed(column.redline * 100, 0)}%`
                      : '—'}
                  </td>
                  <td>{isBreached ? '超限阻断' : column.locked ? '已冻结' : '合规'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      <span className="iu-sr-only" aria-hidden="true">
        {uid}
      </span>
    </div>
  );
}
