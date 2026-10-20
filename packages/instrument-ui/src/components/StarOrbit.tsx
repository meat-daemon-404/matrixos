import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { cx } from '../lib/cx';
import { accentStyle, resolveAccent } from '../lib/accent';
import type { InstrumentAccent } from '../lib/accent';
import { usePrefersReducedMotion, useUid } from '../lib/hooks';
import { clamp, ellipsePoint, formatFixed, normalize, roundTo } from '../lib/math';
import '../styles/components/star-orbit.css';

/** 微站胶囊的实况状态。 */
export type OrbitStationState = 'active' | 'live' | 'idle' | 'offline';

/** 实况微缩态：语义缩放 7x+ 时在胶囊里画的小图。 */
export interface OrbitStationPreview {
  kind: 'sparkline' | 'radar' | 'bars' | 'matrix';
  /** 数据（长度按 kind 解释：sparkline/bars 逐点，radar 取模 5）。 */
  data?: number[];
}

export interface StarOrbitStation {
  /** 唯一 id。 */
  id: string;
  /** 站名，如「CurveLab 非线性拟合示波器」。 */
  name: string;
  /** 所属轨道 1..orbitCount。 */
  orbit: number;
  /** 微站编号（01..18）。 */
  stationId?: string;
  /** 域名，如 curvelab.matrixos.edu。 */
  domain?: string;
  /** 仪器形态名（语义缩放到 5x 才显示）。 */
  uiStyle?: string;
  /** 强调色。 */
  accent?: InstrumentAccent;
  /** 实况状态。 */
  state?: OrbitStationState;
  /** 该站初始角度（度）。不传则同轨道内自动均分。 */
  angle?: number;
  /** 实况微缩态数据。 */
  preview?: OrbitStationPreview;
}

export interface StarOrbitProps {
  /** 微站胶囊列表（18 个）。 */
  stations: readonly StarOrbitStation[];
  /** 轨道数，默认 7。 */
  orbitCount?: number;
  /** 缩放（受控），1.0..10.0。 */
  zoom?: number;
  /** 缩放（非受控初始值），默认 1。 */
  defaultZoom?: number;
  /** 缩放变化。 */
  onZoomChange?: (zoom: number) => void;
  /** 当前选中的胶囊 id。 */
  selectedId?: string;
  /** 点击胶囊。第二个参数是原生事件（hub 需要拿坐标做虫洞锚点）。 */
  onCapsuleClick?: (station: StarOrbitStation, event: React.MouseEvent) => void;
  /** 悬停胶囊。 */
  onCapsuleHover?: (station: StarOrbitStation | null) => void;
  /** 轨道自转速度（秒/圈），0 = 不转。默认 0（静态，省电）。 */
  rotationSpeed?: number;
  /** 显示轨道编号标签，默认 true。 */
  showOrbitLabels?: boolean;
  /** 高度（px），默认 560。 */
  height?: number;
  /** 是否显示中央引力核，默认 true。 */
  showCore?: boolean;
  /** 中央核的内容（如搜索框占位）。 */
  coreContent?: React.ReactNode;
  /** 是否在角落显示缩放控制器，默认 true。 */
  showZoomControls?: boolean;
  /** 是否渲染等价数据表格（无障碍），默认 true。 */
  accessibleTable?: boolean;
  /** 交互提示文案。 */
  hintText?: string;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

/** 语义缩放的 5 个档位（档位之间用 CSS 变量做连续过渡）。 */
export const SEMANTIC_ZOOM_TIERS = [
  { min: 1, label: 'spark', description: '只显光点' },
  { min: 2.5, label: 'name', description: '显站名' },
  { min: 5, label: 'style', description: '显仪器形态' },
  { min: 7, label: 'live', description: '显实况微缩态' },
  { min: 9, label: 'detail', description: '显域名与编号' },
] as const;

const ZOOM_MIN = 1;
const ZOOM_MAX = 10;

const STATE_LABEL: Record<OrbitStationState, string> = {
  active: '已挂载',
  live: '实况',
  idle: '待机',
  offline: '离线',
};

/**
 * `<StarOrbit>` 2.5D 星轨引力场。
 *
 * 几何：7 条同心**椭圆**（不是圆），ry/rx ≈ 0.42，模拟俯视倾角 —— 这是
 * 渲染图 UI_01/UI_04 里「星轨」的核心形状特征：轨道在垂直方向被压扁，
 * 越靠外圈的压扁越不明显（透视）。
 *
 * 语义缩放（1.0x → 10.0x，原设计承诺但 0 处实现，见视觉体系 §6.4）：
 * - 缩放值写进 CSS 变量 `--iu-zoom`，**所有**视觉变化（胶囊尺寸、字号、
 *   显隐层级、轨道间距）都由 CSS 通过 `calc()` 派生 —— 没有一处 JS 逐帧计算；
 * - 档位显隐用 `data-zoom-tier` 属性 + CSS `[data-zoom-tier="live"]` 规则；
 * - 交互：滚轮 / 双指捏合 / 键盘 +/- / 角落按钮，全部收敛到同一个 setZoom。
 *
 * 性能：轨道自转走 CSS `rotate` 无限动画，胶囊本身**反向旋转**抵消，
 * 保证文字永远正立 —— 这比 JS 每帧算 18 个坐标便宜一个数量级。
 */
export function StarOrbit({
  stations,
  orbitCount = 7,
  zoom,
  defaultZoom = 1,
  onZoomChange,
  selectedId,
  onCapsuleClick,
  onCapsuleHover,
  rotationSpeed = 0,
  showOrbitLabels = true,
  height = 560,
  showCore = true,
  coreContent,
  showZoomControls = true,
  accessibleTable = true,
  hintText = '滚轮 / 双指缩放 · 点击胶囊挂载微站',
  className,
  style,
  ...rest
}: StarOrbitProps) {
  const uid = useUid('iu-orbit');
  const reducedMotion = usePrefersReducedMotion();
  const [internalZoom, setInternalZoom] = useState(() => clamp(defaultZoom, ZOOM_MIN, ZOOM_MAX));
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);

  const isControlled = zoom !== undefined;
  const currentZoom = clamp(isControlled ? (zoom as number) : internalZoom, ZOOM_MIN, ZOOM_MAX);
  const changeCount = useRef(0);

  const setZoom = useCallback(
    (next: number) => {
      const clamped = clamp(next, ZOOM_MIN, ZOOM_MAX);
      if (!isControlled) setInternalZoom(clamped);
      onZoomChange?.(clamped);
      changeCount.current += 1;
    },
    [isControlled, onZoomChange],
  );

  // 当前档位（CSS 用它做显隐）
  const tier = useMemo(() => {
    let current: (typeof SEMANTIC_ZOOM_TIERS)[number]['label'] = 'spark';
    for (const item of SEMANTIC_ZOOM_TIERS) {
      if (currentZoom >= item.min) current = item.label;
    }
    return current;
  }, [currentZoom]);

  // 轨道：内圈小、外圈大；ry 比例随半径增大而收敛（透视）
  const orbits = useMemo(() => {
    const count = clamp(Math.round(orbitCount), 1, 12);
    return Array.from({ length: count }, (_, index) => {
      const t = count === 1 ? 1 : (index + 1) / count;
      const rx = 16 + t * 34; // 百分比（相对容器短边）
      const squash = 0.34 + t * 0.12; // 内圈更扁
      return { index: index + 1, t, rx, ry: rx * squash };
    });
  }, [orbitCount]);

  // 把站点按轨道分组，同轨道均分角度
  const grouped = useMemo(() => {
    const map = new Map<number, StarOrbitStation[]>();
    for (const station of stations) {
      const orbitIndex = clamp(Math.round(station.orbit), 1, Math.max(1, Math.round(orbitCount)));
      const list = map.get(orbitIndex) ?? [];
      list.push(station);
      map.set(orbitIndex, list);
    }
    return map;
  }, [orbitCount, stations]);

  const positioned = useMemo(() => {
    const result: { station: StarOrbitStation; orbit: number; angle: number; t: number }[] = [];
    for (const orbit of orbits) {
      const list = grouped.get(orbit.index) ?? [];
      list.forEach((station, index) => {
        // 同一轨道上的站错开起始相位，避免全部压在 12 点方向
        const offset = (orbit.index * 37) % 360;
        const angle = station.angle ?? offset + (360 / Math.max(1, list.length)) * index;
        result.push({ station, orbit: orbit.index, angle, t: orbit.t });
      });
    }
    return result;
  }, [grouped, orbits]);

  const hoveredStation = useMemo(
    () => stations.find((s) => s.id === hoveredId) ?? null,
    [hoveredId, stations],
  );

  // ---- 交互 ---------------------------------------------------------------
  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      // 只在容器内劫持滚轮，且必须 preventDefault 避免页面跟着滚
      event.preventDefault();
      const delta = -event.deltaY * 0.0022;
      setZoom(currentZoom * (1 + delta));
    },
    [currentZoom, setZoom],
  );

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (pinchRef.current.size < 2) {
      pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!pinchRef.current.has(event.pointerId)) return;
      pinchRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = Array.from(pinchRef.current.values());
      if (points.length !== 2) return;
      const a = points[0];
      const b = points[1];
      if (!a || !b) return;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const start = pinchStartRef.current;
      if (!start) {
        pinchStartRef.current = { distance, zoom: currentZoom };
        return;
      }
      if (start.distance <= 0) return;
      const ratio = distance / start.distance;
      setZoom(start.zoom * ratio);
    },
    [currentZoom, setZoom],
  );

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    pinchRef.current.delete(event.pointerId);
    if (pinchRef.current.size < 2) pinchStartRef.current = null;
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case '+':
        case '=':
          event.preventDefault();
          setZoom(currentZoom * 1.25);
          break;
        case '-':
        case '_':
          event.preventDefault();
          setZoom(currentZoom / 1.25);
          break;
        case '0':
          event.preventDefault();
          setZoom(1);
          break;
        case '9':
          event.preventDefault();
          setZoom(ZOOM_MAX);
          break;
        default:
          break;
      }
    },
    [currentZoom, setZoom],
  );

  const handleEnter = useCallback(
    (station: StarOrbitStation) => {
      setHoveredId(station.id);
      onCapsuleHover?.(station);
    },
    [onCapsuleHover],
  );

  const handleLeave = useCallback(() => {
    setHoveredId(null);
    onCapsuleHover?.(null);
  }, [onCapsuleHover]);

  const liveCount = stations.filter((s) => s.state === 'live' || s.state === 'active').length;

  return (
    <div
      className={cx('iu-root', 'iu-orbit', className)}
      style={accentStyle(undefined, {
        ...style,
        height: `${height}px`,
        // 缩放写进变量：CSS 里所有派生尺寸都读它，JS 不再参与布局
        ['--iu-zoom' as string]: String(roundTo(currentZoom, 3)),
        ['--iu-zoom-t' as string]: String(roundTo(normalize(currentZoom, ZOOM_MIN, ZOOM_MAX), 4)),
      })}
      data-zoom-tier={tier}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      {...rest}
    >
      <div
        className="iu-orbit__stage"
        ref={wrapRef}
        role="group"
        aria-label={`星轨导航：${orbitCount} 条轨道，${stations.length} 个微站，当前缩放 ${formatFixed(
          currentZoom,
          1,
        )} 倍`}
        tabIndex={0}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        {/* 星空底噪（静态，纯 CSS 径向渐变，不用 canvas） */}
        <div className="iu-orbit__starfield" aria-hidden="true" />

        {/* 轨道 SVG：椭圆 + 刻度 */}
        <svg className="iu-orbit__rings" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <radialGradient id={`${uid}-core`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgb(var(--iu-accent-rgb) / 0.55)" />
              <stop offset="55%" stopColor="rgb(var(--iu-accent-rgb) / 0.14)" />
              <stop offset="100%" stopColor="rgb(var(--iu-accent-rgb) / 0)" />
            </radialGradient>
          </defs>

          {orbits.map((orbit, index) => (
            <ellipse
              key={`orbit-${orbit.index}`}
              cx="50"
              cy="50"
              rx={orbit.rx}
              ry={orbit.ry}
              fill="none"
              stroke={`rgb(var(--iu-accent-rgb) / ${0.1 + orbit.t * 0.12})`}
              strokeWidth="0.12"
              strokeDasharray={index % 2 === 0 ? undefined : '0.5 0.9'}
              className={cx('iu-orbit__ring', rotationSpeed > 0 && !reducedMotion && 'is-spinning')}
              style={
                {
                  transformOrigin: '50px 50px',
                  animationDuration: `${Math.max(12, rotationSpeed * (1 + index * 0.22))}s`,
                  '--iu-ring-index': String(index),
                } as CSSProperties
              }
            />
          ))}
        </svg>

        {/* 中央引力核 */}
        {showCore ? (
          <div
            className="iu-orbit__core"
            aria-hidden={coreContent ? undefined : true}
          >
            <span className="iu-orbit__core-halo" />
            <span className="iu-orbit__core-ring is-outer" />
            <span className="iu-orbit__core-ring is-inner" />
            <span className="iu-orbit__core-orb" />
            {coreContent ? (
              <span className="iu-orbit__core-content">{coreContent}</span>
            ) : (
              <span className="iu-orbit__core-label">
                <span className="iu-orbit__core-title">MatrixOS</span>
                <span className="iu-orbit__core-sub iu-num">{liveCount} ONLINE</span>
              </span>
            )}
          </div>
        ) : null}

        {/* 轨道编号标签 */}
        {showOrbitLabels
          ? orbits.map((orbit) => (
              <span
                key={`label-${orbit.index}`}
                className="iu-orbit__ring-label iu-label"
                style={
                  {
                    left: `calc(50% + ${orbit.rx}% * 0.72)`,
                    top: `calc(50% - ${orbit.ry}% * 0.72)`,
                  } as CSSProperties
                }
                aria-hidden="true"
              >
                O{orbit.index}
              </span>
            ))
          : null}

        {/* 微站胶囊：绝对定位，位置由内联 left/top 给（一次算好，不随缩放变） */}
        {positioned.map(({ station, angle, t }) => {
          const orbit = orbits.find((o) => o.index === station.orbit) ?? orbits[0];
          if (!orbit) return null;
          const point = ellipsePoint(50, 50, orbit.rx, orbit.ry, angle);
          const isSelected = selectedId === station.id;
          const isHovered = hoveredId === station.id;
          const stationAccent = resolveAccent(station.accent, undefined);
          const interactive = Boolean(onCapsuleClick);

          return (
            <div
              key={station.id}
              className={cx(
                'iu-orbit__capsule',
                isSelected && 'is-selected',
                isHovered && 'is-hovered',
                station.state === 'live' && 'is-live',
                station.state === 'offline' && 'is-offline',
                interactive && 'is-interactive',
              )}
              style={
                {
                  left: `${point.x}%`,
                  top: `${point.y}%`,
                  ...(stationAccent
                    ? {
                        '--iu-accent': `var(--iu-${stationAccent})`,
                        '--iu-accent-bright': `var(--iu-${stationAccent}-bright)`,
                        '--iu-accent-text': `var(--iu-${stationAccent}-text, var(--iu-${stationAccent}-bright))`,
                        '--iu-accent-rgb': `var(--iu-${stationAccent}-rgb)`,
                      }
                    : {}),
                  '--iu-capsule-depth': String(roundTo(t, 3)),
                } as CSSProperties
              }
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : -1}
              aria-current={isSelected ? 'true' : undefined}
              aria-label={`${station.stationId ? `${station.stationId} ` : ''}${station.name}${
                station.domain ? ` · ${station.domain}` : ''
              } · ${STATE_LABEL[station.state ?? 'idle']}`}
              onClick={(event) => onCapsuleClick?.(station, event)}
              onMouseEnter={() => handleEnter(station)}
              onMouseLeave={handleLeave}
              onFocus={() => handleEnter(station)}
              onBlur={handleLeave}
              onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ') && interactive) {
                  event.preventDefault();
                  onCapsuleClick?.(station, event as unknown as React.MouseEvent);
                }
              }}
            >
              {/* 光点（1x 时唯一可见的东西） */}
              <span className="iu-orbit__dot" aria-hidden="true">
                <span className="iu-orbit__dot-core" />
                {station.state === 'live' ? <span className="iu-orbit__dot-ping" /> : null}
              </span>

              {/* 文字层（2.5x+ 可见） */}
              <span className="iu-orbit__body">
                <span className="iu-orbit__headline">
                  {station.stationId ? (
                    <span className="iu-orbit__id iu-num">{station.stationId}</span>
                  ) : null}
                  <span className="iu-orbit__name">{station.name}</span>
                </span>

                {station.uiStyle ? (
                  <span className="iu-orbit__style">{station.uiStyle}</span>
                ) : null}

                {/* 实况微缩态（7x+） */}
                {station.preview ? (
                  <span className="iu-orbit__preview" aria-hidden="true">
                    <PreviewMicro preview={station.preview} />
                  </span>
                ) : (
                  <span className="iu-orbit__bars" aria-hidden="true">
                    {/* 无 preview 时用状态条代替，保持信息密度 */}
                    {[0.72, 0.44, 0.9].map((w, i) => (
                      <span
                        key={i}
                        className="iu-orbit__bar"
                        style={{ width: `${w * 100}%` }}
                      />
                    ))}
                  </span>
                )}

                {station.domain ? (
                  <span className="iu-orbit__domain iu-num">{station.domain}</span>
                ) : null}
              </span>

              {/* 状态灯 */}
              <span
                className="iu-orbit__state"
                data-state={station.state ?? 'idle'}
                aria-hidden="true"
                title={STATE_LABEL[station.state ?? 'idle']}
              />
            </div>
          );
        })}

        {/* 悬停详情卡 */}
        {hoveredStation ? (
          <div className="iu-orbit__tip" role="status" aria-live="polite">
            <span className="iu-orbit__tip-title">
              {hoveredStation.stationId ? `${hoveredStation.stationId} · ` : ''}
              {hoveredStation.name}
            </span>
            {hoveredStation.uiStyle ? (
              <span className="iu-orbit__tip-row">
                <span className="iu-label">形态</span>
                <span className="iu-orbit__tip-value">{hoveredStation.uiStyle}</span>
              </span>
            ) : null}
            {hoveredStation.domain ? (
              <span className="iu-orbit__tip-row">
                <span className="iu-label">域名</span>
                <span className="iu-orbit__tip-value iu-num">{hoveredStation.domain}</span>
              </span>
            ) : null}
            <span className="iu-orbit__tip-row">
              <span className="iu-label">轨道</span>
              <span className="iu-orbit__tip-value iu-num">O{hoveredStation.orbit}</span>
            </span>
            <span className="iu-orbit__tip-row">
              <span className="iu-label">状态</span>
              <span className="iu-orbit__tip-value">
                {STATE_LABEL[hoveredStation.state ?? 'idle']}
              </span>
            </span>
          </div>
        ) : null}

        {/* 缩放控制器 */}
        {showZoomControls ? (
          <div className="iu-orbit__zoom">
            <button
              type="button"
              className="iu-orbit__zoom-btn iu-focus"
              onClick={() => setZoom(currentZoom / 1.25)}
              disabled={currentZoom <= ZOOM_MIN + 1e-6}
              aria-label="缩小"
            >
              −
            </button>
            <span className="iu-orbit__zoom-value iu-num" aria-live="polite">
              {formatFixed(currentZoom, 1)}×
            </span>
            <button
              type="button"
              className="iu-orbit__zoom-btn iu-focus"
              onClick={() => setZoom(currentZoom * 1.25)}
              disabled={currentZoom >= ZOOM_MAX - 1e-6}
              aria-label="放大"
            >
              +
            </button>
            <span className="iu-orbit__zoom-scale" aria-hidden="true">
              {SEMANTIC_ZOOM_TIERS.map((item) => (
                <span
                  key={item.label}
                  className={cx('iu-orbit__zoom-tick', currentZoom >= item.min && 'is-on')}
                  title={item.description}
                />
              ))}
            </span>
          </div>
        ) : null}

        {/* 提示 */}
        <span className="iu-orbit__hint">{hintText}</span>
      </div>

      {accessibleTable ? (
        <table className="iu-sr-only">
          <caption>星轨导航微站列表</caption>
          <thead>
            <tr>
              <th scope="col">编号</th>
              <th scope="col">名称</th>
              <th scope="col">轨道</th>
              <th scope="col">域名</th>
              <th scope="col">仪器形态</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((station) => (
              <tr key={station.id}>
                <td>{station.stationId ?? '—'}</td>
                <td>{station.name}</td>
                <td>{station.orbit}</td>
                <td>{station.domain ?? '—'}</td>
                <td>{station.uiStyle ?? '—'}</td>
                <td>{STATE_LABEL[station.state ?? 'idle']}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/** 实况微缩图：四种极简形态，全部内联 SVG（无外部图标依赖）。 */
function PreviewMicro({ preview }: { preview: OrbitStationPreview }): React.ReactNode {
  const data = preview.data ?? [];

  if (preview.kind === 'sparkline') {
    const points = data.length >= 2 ? data : [0.3, 0.7, 0.4, 0.9, 0.6, 0.85];
    const max = Math.max(...points, 1e-6);
    const min = Math.min(...points);
    const span = max - min || 1;
    const path = points
      .map((value, index) => {
        const x = (index / Math.max(1, points.length - 1)) * 52;
        const y = 14 - ((value - min) / span) * 12;
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
    return (
      <svg viewBox="0 0 52 16" preserveAspectRatio="none" focusable="false">
        <path d={path} fill="none" stroke="var(--iu-accent-bright)" strokeWidth="1.1" />
      </svg>
    );
  }

  if (preview.kind === 'bars') {
    const bars = data.length > 0 ? data : [0.4, 0.75, 0.55, 0.9, 0.35];
    return (
      <svg viewBox="0 0 52 16" preserveAspectRatio="none" focusable="false">
        {bars.slice(0, 8).map((value, index) => {
          const w = 52 / Math.min(8, bars.length) - 1.5;
          const h = clamp(value, 0, 1) * 14;
          return (
            <rect
              key={index}
              x={index * (w + 1.5)}
              y={14 - h}
              width={w}
              height={h}
              fill="var(--iu-accent)"
              opacity={0.55 + index * 0.05}
            />
          );
        })}
      </svg>
    );
  }

  if (preview.kind === 'radar') {
    const values = data.length >= 5 ? data : [0.8, 0.5, 0.9, 0.65, 0.75];
    const cx = 26;
    const cy = 8;
    const radius = 7;
    const points = values.slice(0, 5).map((value, index) => {
      const angle = (index / 5) * Math.PI * 2 - Math.PI / 2;
      const r = clamp(value, 0.05, 1) * radius;
      return `${(cx + Math.cos(angle) * r).toFixed(1)},${(cy + Math.sin(angle) * r * 0.85).toFixed(1)}`;
    });
    return (
      <svg viewBox="0 0 52 16" preserveAspectRatio="none" focusable="false">
        <polygon
          points={points.join(' ')}
          fill="var(--iu-accent)"
          fillOpacity="0.28"
          stroke="var(--iu-accent-bright)"
          strokeWidth="0.8"
        />
      </svg>
    );
  }

  // matrix
  const cells = data.length >= 6 ? data : [0.9, 0.3, 0.6, 0.45, 0.85, 0.2, 0.7, 0.5];
  return (
    <svg viewBox="0 0 52 16" preserveAspectRatio="none" focusable="false">
      {cells.slice(0, 12).map((value, index) => {
        const cols = 6;
        const w = 52 / cols - 1;
        const x = (index % cols) * (w + 1);
        const y = Math.floor(index / cols) * 8;
        return (
          <rect
            key={index}
            x={x}
            y={y}
            width={w}
            height={6}
            fill="var(--iu-accent)"
            opacity={clamp(value, 0.1, 1)}
          />
        );
      })}
    </svg>
  );
}

export { STATE_LABEL as ORBIT_STATE_LABEL };
