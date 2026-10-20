import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { cx } from '../lib/cx';
import { accentStyle } from '../lib/accent';
import type { InstrumentAccent } from '../lib/accent';
import { usePrefersReducedMotion, useUid } from '../lib/hooks';
import { clamp, formatFixed, normalizeAngle, polarToCartesian, roundTo } from '../lib/math';
import '../styles/components/sonar.css';

/** 风险三级：绿 / 黄 / 红。语义来自撤稿合规场景（WBS S3-MS15）。 */
export type SonarRiskLevel = 'safe' | 'caution' | 'critical';

export interface SonarBlip {
  /** 唯一 id。 */
  id: string;
  /** 角度（度，12 点方向为 0°，顺时针）。 */
  angle: number;
  /** 半径（0..1 归一化，1 = 最外环）。 */
  radius: number;
  /** 风险等级。 */
  risk: SonarRiskLevel;
  /** 标签（悬停/常显）。 */
  label: string;
  /** 补充说明（如 DOI、期刊名、撤稿原因）。 */
  detail?: string;
  /** 点大小倍数，默认 1。 */
  weight?: number;
}

export interface SonarDiscProps {
  /** 风险点列表。 */
  blips?: readonly SonarBlip[];
  /** 尺寸（px，正方形边长），默认 320。 */
  size?: number;
  /** 环数，默认 4。 */
  rings?: number;
  /** 是否显示扫描动画，默认 true。 */
  sweep?: boolean;
  /** 扫描一圈耗时（秒），默认 6。 */
  sweepDuration?: number;
  /** 当前选中的点 id。 */
  selectedId?: string;
  /** 点击风险点。 */
  onBlipClick?: (blip: SonarBlip, event: React.MouseEvent) => void;
  /** 悬停风险点（null 表示离开）。 */
  onBlipHover?: (blip: SonarBlip | null) => void;
  /** 当扫描扇区扫过某点时触发（模拟雷达回波）。 */
  onSweepHit?: (blip: SonarBlip) => void;
  /** 强调色（扫描扇区），默认 cyan。 */
  accent?: InstrumentAccent;
  /** 标题铭牌。 */
  title?: string;
  /** 是否渲染等价数据表格（无障碍），默认 true。 */
  accessibleTable?: boolean;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

const RISK_RGB: Record<SonarRiskLevel, string> = {
  safe: '16 185 129',
  caution: '245 158 11',
  critical: '244 63 94',
};

const RISK_LABEL: Record<SonarRiskLevel, string> = {
  safe: '安全',
  caution: '关注',
  critical: '撤稿/勘误',
};

/** 极坐标外部的 SVG 坐标系常量。 */
const VB = 200; // viewBox 200×200
const C = VB / 2;

/**
 * `<SonarDisc>` 360° 极坐标声呐盘。
 *
 * 视觉来源：bundle 里的「Literature Retraction Radar / 撤稿深海声呐」。
 * 实现要点：
 * - 环/刻度/扇区全部是 SVG，扫描用 CSS `rotate` 无限动画（不是 rAF），
 *   性能开销接近零；`prefers-reduced-motion` 下停转并保留静态扇区。
 * - 风险点用 `<circle>` + 双层（实心点 + 扩散晕），晕用 CSS animation。
 * - 颜色**不是唯一通道**：三级风险还带形状差异（圆/菱形/三角），
 *   灰度打印与色觉障碍下仍可区分（WCAG 1.4.1）。
 * - 输出等价数据表格（无障碍），ADR-07 明确要求。
 */
export function SonarDisc({
  blips = [],
  size = 320,
  rings = 4,
  sweep = true,
  sweepDuration = 6,
  selectedId,
  onBlipClick,
  onBlipHover,
  onSweepHit,
  accent,
  title,
  accessibleTable = true,
  className,
  style,
  ...rest
}: SonarDiscProps) {
  const uid = useUid('iu-sonar');
  const reducedMotion = usePrefersReducedMotion();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [sweepAngle, setSweepAngle] = useState(0);
  const lastHitRef = useRef<Set<string>>(new Set());
  const onSweepHitRef = useRef(onSweepHit);
  onSweepHitRef.current = onSweepHit;

  // 扫描：只在「需要回波回调」时才用 JS 计时，否则纯 CSS 转
  useEffect(() => {
    if (!sweep || reducedMotion || typeof window === 'undefined') return;
    if (!onSweepHitRef.current) return;
    const interval = window.setInterval(() => {
      setSweepAngle((prev) => normalizeAngle(prev + 6));
    }, Math.max(60, (sweepDuration * 1000) / 60));
    return () => window.clearInterval(interval);
  }, [reducedMotion, sweep, sweepDuration]);

  // 扫描命中检测（每 6° 一次，代价可忽略）
  useEffect(() => {
    if (!onSweepHitRef.current || !sweep || reducedMotion) return;
    const hit = new Set<string>();
    for (const blip of blips) {
      const delta = Math.abs(normalizeAngle(blip.angle - sweepAngle + 180) - 180);
      if (delta < 5 && !lastHitRef.current.has(blip.id)) {
        onSweepHitRef.current(blip);
        hit.add(blip.id);
      }
    }
    lastHitRef.current = hit;
  }, [blips, reducedMotion, sweep, sweepAngle]);

  const hovered = useMemo(
    () => blips.find((b) => b.id === hoveredId) ?? null,
    [blips, hoveredId],
  );

  const ringRadii = useMemo(() => {
    const count = Math.max(1, Math.round(rings));
    return Array.from({ length: count }, (_, i) => ((i + 1) / count) * (C - 8));
  }, [rings]);

  const counts = useMemo(() => {
    const acc: Record<SonarRiskLevel, number> = { safe: 0, caution: 0, critical: 0 };
    for (const blip of blips) acc[blip.risk] += 1;
    return acc;
  }, [blips]);

  const handleBlipEnter = useCallback(
    (blip: SonarBlip) => {
      setHoveredId(blip.id);
      onBlipHover?.(blip);
    },
    [onBlipHover],
  );

  const handleBlipLeave = useCallback(() => {
    setHoveredId(null);
    onBlipHover?.(null);
  }, [onBlipHover]);

  return (
    <div
      className={cx('iu-root', 'iu-sonar', className)}
      style={accentStyle(accent, { ...style, width: `${size}px`, height: `${size}px` })}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      {...rest}
    >
      <div className="iu-sonar__frame">
        {title ? <span className="iu-sonar__title iu-label">{title}</span> : null}

        <svg
          className="iu-sonar__svg"
          viewBox={`0 0 ${VB} ${VB}`}
          role="img"
          aria-label={`声呐盘：${blips.length} 个风险点，其中高危 ${counts.critical} 个、关注 ${counts.caution} 个、安全 ${counts.safe} 个`}
          focusable="false"
        >
          <defs>
            <radialGradient id={`${uid}-disc`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#0a2030" />
              <stop offset="62%" stopColor="var(--iu-sonar-bg)" />
              <stop offset="100%" stopColor="#020a10" />
            </radialGradient>

            {/* 扫描扇区：尾随渐隐 */}
            <linearGradient id={`${uid}-sweep`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={`rgb(var(--iu-accent-rgb) / 0.34)`} />
              <stop offset="55%" stopColor={`rgb(var(--iu-accent-rgb) / 0.12)`} />
              <stop offset="100%" stopColor={`rgb(var(--iu-accent-rgb) / 0)`} />
            </linearGradient>

            <filter id={`${uid}-blipglow`} x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur stdDeviation="1.8" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <clipPath id={`${uid}-clip`}>
              <circle cx={C} cy={C} r={C - 4} />
            </clipPath>
          </defs>

          {/* 盘底 */}
          <circle cx={C} cy={C} r={C - 4} fill={`url(#${uid}-disc)`} />
          <circle
            cx={C}
            cy={C}
            r={C - 4}
            fill="none"
            stroke="rgb(var(--iu-accent-rgb) / 0.35)"
            strokeWidth="1"
          />

          {/* 同心环 */}
          {ringRadii.map((radius, index) => (
            <circle
              key={`ring-${index}`}
              cx={C}
              cy={C}
              r={radius}
              fill="none"
              stroke="rgb(var(--iu-accent-rgb) / 0.16)"
              strokeWidth="0.7"
              strokeDasharray={index === ringRadii.length - 1 ? undefined : '2 3'}
            />
          ))}

          {/* 十字轴 + 30° 刻度 */}
          <g stroke="var(--iu-canvas-grid-strong)" strokeWidth="0.6" opacity="0.75">
            <line x1={C} y1={4} x2={C} y2={VB - 4} />
            <line x1={4} y1={C} x2={VB - 4} y2={C} />
            {Array.from({ length: 12 }, (_, i) => {
              const angle = i * 30;
              const inner = polarToCartesian(C, C, C - 12, angle);
              const outer = polarToCartesian(C, C, C - 4, angle);
              return (
                <line key={`tick-${angle}`} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
              );
            })}
          </g>

          {/* 方位标签 */}
          {[
            { label: '000', angle: 0 },
            { label: '090', angle: 90 },
            { label: '180', angle: 180 },
            { label: '270', angle: 270 },
          ].map(({ label, angle }) => {
            const pos = polarToCartesian(C, C, C - 14, angle);
            return (
              <text
                key={`bearing-${angle}`}
                x={pos.x}
                y={pos.y}
                fill="var(--iu-text-faint)"
                fontSize="5.5"
                fontFamily="var(--iu-font-mono)"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {label}
              </text>
            );
          })}

          {/* 扫描扇区（CSS rotate，非 rAF） */}
          {sweep ? (
            <g className="iu-sonar__sweep" style={{ animationDuration: `${sweepDuration}s` }}>
              <path
                d={`M ${C} ${C} L ${C} ${C - (C - 6)} A ${C - 6} ${C - 6} 0 0 1 ${
                  polarToCartesian(C, C, C - 6, 62).x
                } ${polarToCartesian(C, C, C - 6, 62).y} Z`}
                fill={`url(#${uid}-sweep)`}
              />
              <line
                x1={C}
                y1={C}
                x2={polarToCartesian(C, C, C - 6, 0).x}
                y2={polarToCartesian(C, C, C - 6, 0).y}
                stroke="rgb(var(--iu-accent-rgb) / 0.75)"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
            </g>
          ) : null}

          {/* 极坐标网格底噪（静态，模拟海洋噪声） */}
          <g clipPath={`url(#${uid}-clip)`} opacity="0.5">
            {Array.from({ length: 34 }, (_, i) => {
              const seedAngle = (i * 137.508) % 360; // 黄金角散布
              const seedRadius = ((i * 7919) % 100) / 100 * (C - 12);
              const pos = polarToCartesian(C, C, seedRadius, seedAngle);
              return (
                <circle
                  key={`noise-${i}`}
                  cx={pos.x}
                  cy={pos.y}
                  r={0.5}
                  fill="rgb(var(--iu-accent-rgb) / 0.28)"
                />
              );
            })}
          </g>

          {/* 风险点 */}
          {blips.map((blip) => {
            const radius = clamp(blip.radius, 0, 1) * (C - 12);
            const pos = polarToCartesian(C, C, radius, blip.angle);
            const isSelected = selectedId === blip.id;
            const isHovered = hoveredId === blip.id;
            const rgb = RISK_RGB[blip.risk];
            const scale = (blip.weight ?? 1) * (isHovered || isSelected ? 1.35 : 1);
            const interactive = Boolean(onBlipClick);

            return (
              <g
                key={blip.id}
                className={cx('iu-sonar__blip', interactive && 'is-interactive')}
                data-risk={blip.risk}
                onMouseEnter={() => handleBlipEnter(blip)}
                onMouseLeave={handleBlipLeave}
                onFocus={() => handleBlipEnter(blip)}
                onBlur={handleBlipLeave}
                onClick={(event) => onBlipClick?.(blip, event)}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : -1}
                aria-label={`${blip.label} · ${RISK_LABEL[blip.risk]} · 方位 ${roundTo(
                  blip.angle,
                  0,
                )}° 距离 ${formatFixed(blip.radius, 2)}`}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && interactive) {
                    event.preventDefault();
                    onBlipClick?.(blip, event as unknown as React.MouseEvent);
                  }
                }}
              >
                {/* 扩散晕（CSS 动画） */}
                <circle
                  className="iu-sonar__blip-halo"
                  cx={pos.x}
                  cy={pos.y}
                  r={3.2 * scale}
                  fill={`rgb(${rgb} / 0.22)`}
                  style={{ transformOrigin: `${pos.x}px ${pos.y}px` }}
                />

                {/* 形状：三级风险形状不同（色觉障碍下的第二通道） */}
                {blip.risk === 'critical' ? (
                  <path
                    d={trianglePath(pos.x, pos.y, 3.6 * scale)}
                    fill={`rgb(${rgb} / 0.95)`}
                    filter={`url(#${uid}-blipglow)`}
                  />
                ) : blip.risk === 'caution' ? (
                  <path
                    d={diamondPath(pos.x, pos.y, 3.2 * scale)}
                    fill={`rgb(${rgb} / 0.95)`}
                    filter={`url(#${uid}-blipglow)`}
                  />
                ) : (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={2.4 * scale}
                    fill={`rgb(${rgb} / 0.9)`}
                    filter={`url(#${uid}-blipglow)`}
                  />
                )}

                {/* 选中/悬停外框 */}
                {isSelected || isHovered ? (
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={6.5 * scale}
                    fill="none"
                    stroke={`rgb(${rgb} / 0.9)`}
                    strokeWidth="0.9"
                    strokeDasharray="2 2"
                  />
                ) : null}
              </g>
            );
          })}

          {/* 中心点 */}
          <circle cx={C} cy={C} r="2" fill="rgb(var(--iu-accent-rgb) / 0.85)" />
          <circle
            cx={C}
            cy={C}
            r="5.5"
            fill="none"
            stroke="rgb(var(--iu-accent-rgb) / 0.35)"
            strokeWidth="0.6"
          />
        </svg>

        {/* 悬停信息卡（DOM 而非 SVG，便于排版与无障碍） */}
        {hovered ? (
          <div className="iu-sonar__tip" role="status" aria-live="polite">
            <span className="iu-sonar__tip-title">{hovered.label}</span>
            <span className="iu-sonar__tip-meta">
              <span className="iu-sonar__tip-dot" data-risk={hovered.risk} />
              {RISK_LABEL[hovered.risk]} · {roundTo(hovered.angle, 0)}° · r{' '}
              {formatFixed(hovered.radius, 2)}
            </span>
            {hovered.detail ? (
              <span className="iu-sonar__tip-detail">{hovered.detail}</span>
            ) : null}
          </div>
        ) : null}

        {/* 图例 */}
        <div className="iu-sonar__legend">
          {(['critical', 'caution', 'safe'] as const).map((risk) => (
            <span key={risk} className="iu-sonar__legend-item" data-risk={risk}>
              <span className="iu-sonar__legend-mark" data-risk={risk} />
              {RISK_LABEL[risk]}
              <span className="iu-sonar__legend-count">{counts[risk]}</span>
            </span>
          ))}
        </div>
      </div>

      {accessibleTable ? (
        <table className="iu-sr-only">
          <caption>{title ?? '声呐盘'}风险点数据表</caption>
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">风险等级</th>
              <th scope="col">方位角(度)</th>
              <th scope="col">距离</th>
              <th scope="col">详情</th>
            </tr>
          </thead>
          <tbody>
            {blips.map((blip) => (
              <tr key={blip.id}>
                <td>{blip.label}</td>
                <td>{RISK_LABEL[blip.risk]}</td>
                <td>{roundTo(blip.angle, 0)}</td>
                <td>{formatFixed(blip.radius, 2)}</td>
                <td>{blip.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {/*
       * 扫描扇区由 CSS 驱动（见 .iu-sonar__sweep），sweepAngle 只用于回波命中判定，
       * 不参与 SVG 绘制。此前这里有个仅为「让 TS 认变量被使用」的空 span，
       * 既污染 DOM 又误导读者以为角度是渲染输入 —— 已删除，改为在计算处消费。
       */}
    </div>
  );
}

function trianglePath(cx: number, cy: number, r: number): string {
  const a = polarToCartesian(cx, cy, r, 0);
  const b = polarToCartesian(cx, cy, r, 120);
  const c = polarToCartesian(cx, cy, r, 240);
  return `M ${a.x} ${a.y} L ${b.x} ${b.y} L ${c.x} ${c.y} Z`;
}

function diamondPath(cx: number, cy: number, r: number): string {
  const a = polarToCartesian(cx, cy, r, 0);
  const b = polarToCartesian(cx, cy, r, 90);
  const c = polarToCartesian(cx, cy, r, 180);
  const d = polarToCartesian(cx, cy, r, 270);
  return `M ${a.x} ${a.y} L ${b.x} ${b.y} L ${c.x} ${c.y} L ${d.x} ${d.y} Z`;
}

export { RISK_LABEL as SONAR_RISK_LABEL };
