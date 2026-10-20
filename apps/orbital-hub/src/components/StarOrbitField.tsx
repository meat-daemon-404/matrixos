'use client';

/**
 * StarOrbitField · 左 32% · 2.5D 星轨引力场
 * ==========================================================================
 * 7 条轨道 / 18 个微站胶囊 / Semantic Zoom 1.0x → 10.0x。
 *
 * 与 ui-library 的 `StarOrbit` **同签名**（见 src/lib/instrument-adapter.tsx），
 * 库就位后由适配器自动替换，hub 侧不动。
 *
 * 性能设计（R-T03 是最高风险，这里是主战场）：
 *  1. 轨道自转 = CSS `animation: orbitSpin` + `transform: rotate()`，走合成器线程，
 *     **零 JS 逐帧**。JS 只在 zoom 跨档时改一次 data-tier（离散 4 档，不是每帧）。
 *  2. 胶囊位置在挂载时算一次（buildOrbitLayout），用 left/top 百分比静态定位；
 *     悬停/选中只改 transform 与颜色，不触发 reflow。
 *  3. 语义缩放：zoom → 亚线性 visual scale（不是直接 scale），由 CSS 变量 --visual-scale
 *     驱动整片星域的 scale；档位切换只切 data-tier 属性。
 *  4. 星尘底用纯 CSS radial-gradient 点阵，无 Canvas、无图片请求。
 *
 * 无障碍（visual-system §十 V5 指出原设计 aria/role/tabindex 全为 0）：
 *  胶囊是真 <button>，键盘可达；星域整体 role="group" 带 aria-label。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ORBITS, STATIONS, type MicrositeStation } from '../lib/microsites.generated';
import {
  ORBIT_SQUASH,
  ORBIT_TILT_DEG,
  ZOOM_MAX,
  ZOOM_MIN,
  buildOrbitLayout,
  clampZoom,
  semanticTier,
  SEMANTIC_TIER_LABEL,
  visualScaleForZoom,
  type SemanticTier,
} from '../lib/orbit-layout';

export type CapsuleState = 'active' | 'live' | 'idle' | 'offline';

export interface StarOrbitFieldProps {
  /** 已挂载的微站 id 集合（用于胶囊高亮"已挂载"） */
  readonly mountedIds: readonly string[];
  /** 当前选中的微站 id */
  readonly selectedId: string | null;
  /** 受控 zoom（1.0 ~ 10.0） */
  readonly zoom: number;
  readonly onZoomChange: (zoom: number) => void;
  /** 与 instrument-ui StarOrbit 同签名：第二参带原生事件，供虫洞锚点取坐标 */
  readonly onCapsuleClick: (station: MicrositeStation, event: React.MouseEvent) => void;
  /** 维护中的站（ADR-09 L3：星轨胶囊置灰并标注） */
  readonly maintenanceIds?: readonly string[];
}

/** 语义缩放档位 → 胶囊基础 scale（叠在 --visual-scale 之上做微调） */
const CAPSULE_SCALE_BY_TIER: Readonly<Record<SemanticTier, number>> = {
  1: 0.82,
  2: 0.94,
  3: 1,
  4: 1.04,
};

/** 实况微缩条的高度序列（确定性，避免 SSR/CSR 不一致） */
const SPARK_HEIGHTS = [3, 7, 5, 9, 4];

export function StarOrbitField({
  mountedIds,
  selectedId,
  zoom,
  onZoomChange,
  onCapsuleClick,
  maintenanceIds = [],
}: StarOrbitFieldProps) {
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const [tier, setTier] = useState<SemanticTier>(() => semanticTier(zoom));

  // 布局只算一次（18 站 × 7 轨是静态数据，不该每次渲染重算）
  const { rings, capsules } = useMemo(() => buildOrbitLayout(STATIONS, ORBITS), []);

  // zoom 变了只更新档位（离散），并把 visual scale 写进 CSS 变量
  useEffect(() => {
    const node = fieldRef.current;
    if (node) {
      node.style.setProperty('--visual-scale', String(visualScaleForZoom(zoom)));
    }
    const nextTier = semanticTier(zoom);
    setTier((prev) => (prev === nextTier ? prev : nextTier));
  }, [zoom]);

  /**
   * 滚轮变焦。故意**不用 passive: false 之外的 hack**：
   * 这里需要 preventDefault 阻止页面滚动，所以必须显式 passive: false。
   * 用 rAF 节流合并同一帧内的多次 wheel（触控板一次滑动会发几十个事件）。
   */
  const wheelAccum = useRef(0);
  const wheelRaf = useRef(0);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      wheelAccum.current += -event.deltaY * 0.006;
      if (wheelRaf.current !== 0) return;
      wheelRaf.current = window.requestAnimationFrame(() => {
        wheelRaf.current = 0;
        const delta = wheelAccum.current;
        wheelAccum.current = 0;
        if (delta === 0) return;
        onZoomChange(clampZoom(zoom + delta * (1 + zoom * 0.12)));
      });
    },
    [onZoomChange, zoom],
  );

  useEffect(() => {
    return () => {
      if (wheelRaf.current !== 0) window.cancelAnimationFrame(wheelRaf.current);
    };
  }, []);

  const mountedSet = useMemo(() => new Set(mountedIds), [mountedIds]);
  const maintenanceSet = useMemo(() => new Set(maintenanceIds), [maintenanceIds]);
  const zoomPct = ((zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100;

  return (
    <section
      className="star-orbit"
      data-tier={tier}
      role="group"
      aria-label={'2.5D 星轨引力场：7 条轨道 · ' + capsules.length + ' 个微站胶囊'}
      onWheel={handleWheel}
    >
      <div className="star-orbit-field" ref={fieldRef}>
        {/* ── 轨道环 ─────────────────────────────────────────────────────── */}
        {rings.map((ring) => {
          const active = capsules.some(
            (capsule) => capsule.orbitIndex === ring.index && capsule.station.id === selectedId,
          );
          return (
            <div
              key={ring.index}
              className="orbit-ring"
              data-active={active ? 'true' : 'false'}
              style={
                {
                  // 直径 = 半径百分比 × 2（相对容器宽高）
                  width: ring.radiusPct * 2 + '%',
                  height: ring.radiusPct * 2 + '%',
                  // 轻微倾斜：给整个平面一个俯视角，避免正中对称的死板
                  transform:
                    'translate(-50%, -50%) rotate(' +
                    ORBIT_TILT_DEG +
                    'deg) scaleY(' +
                    ORBIT_SQUASH +
                    ')',
                  ['--ring-color' as string]: ring.accent + '55',
                  ['--ring-glow' as string]: ring.accent + '40',
                  ['--sweep-duration' as string]: ring.rotationSeconds + 's',
                  ['--sweep-direction' as string]: ring.direction === 1 ? 'normal' : 'reverse',
                } as React.CSSProperties
              }
              aria-hidden="true"
            >
              {/* 环上扫掠光点：让静态圆环"活"起来，纯 CSS 动画 */}
              <div className="orbit-ring-sweep">
                <span className="orbit-ring-sweep-dot" />
              </div>
            </div>
          );
        })}

        {/* ── 轨道名标注（tier 3+ 才显示，由 CSS 的 data-tier 规则控制 opacity，
            这里不要写 inline opacity，否则会盖掉样式表里的分档规则） ────────── */}
        {rings.map((ring) => (
          <div
            key={'label-' + ring.index}
            className="orbit-label"
            style={{
              left: '50%',
              top: 50 - ring.radiusPct * ORBIT_SQUASH - 2.3 + '%',
              color: ring.accent,
            }}
            aria-hidden="true"
          >
            {ring.label} · {ring.stations.length} 站
          </div>
        ))}

        {/* ── 引力源 ─────────────────────────────────────────────────────── */}
        <div className="orbit-core" aria-hidden="true">
          <div className="orbit-core-label">
            ORBITAL
            <small>{capsules.length} 站</small>
          </div>
        </div>

        {/* ── 微站胶囊 ───────────────────────────────────────────────────── */}
        {capsules.map((capsule) => {
          const station = capsule.station;
          const isMounted = mountedSet.has(station.id);
          const isSelected = selectedId === station.id;
          const isMaintenance = maintenanceSet.has(station.id);
          const state: CapsuleState = isMaintenance
            ? 'offline'
            : isSelected
              ? 'active'
              : isMounted
                ? 'live'
                : 'idle';

          return (
            <div
              key={station.id}
              className="capsule-anchor"
              style={{ left: capsule.leftPct + '%', top: capsule.topPct + '%' }}
            >
              <button
                type="button"
                className="capsule"
                data-selected={isSelected ? 'true' : 'false'}
                data-mounted={isMounted ? 'true' : 'false'}
                data-health={isMaintenance ? 'maintenance' : 'normal'}
                data-state={state}
                disabled={isMaintenance}
                title={
                  isMaintenance
                    ? station.name + ' · 维护中（' + station.domain + '）'
                    : station.name + ' · ' + station.uiStyle + ' · ' + station.domain
                }
                aria-label={
                  '挂载 ' + station.name + '（' + station.orbitName + ' · ' + station.domain + '）'
                }
                aria-pressed={isMounted}
                style={
                  {
                    ['--capsule-accent' as string]: station.accent,
                    ['--capsule-base-scale' as string]: String(CAPSULE_SCALE_BY_TIER[tier]),
                  } as React.CSSProperties
                }
                onClick={(event) => onCapsuleClick(station, event)}
              >
                <span className="capsule-dot" aria-hidden="true" />
                <span className="capsule-text">
                  <span className="capsule-id mono">{station.id}</span>
                  <span className="capsule-name">{station.name}</span>
                  <span className="capsule-style">{station.uiStyle}</span>
                </span>
                <span className="capsule-spark" aria-hidden="true">
                  {SPARK_HEIGHTS.map((height, index) => (
                    <span key={index} style={{ height: height + 'px' }} />
                  ))}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      {/* ── 叠层：左上档位提示 ────────────────────────────────────────────── */}
      <div className="orbit-overlay-tl">
        <span className="orbit-badge">
          Semantic Zoom <b>{zoom.toFixed(1)}x</b>
        </span>
        <span className="orbit-badge">
          {SEMANTIC_TIER_LABEL[tier]} · 档 {tier}/4
        </span>
      </div>

      {/* ── 叠层：左下变焦滑块 ────────────────────────────────────────────── */}
      <div className="orbit-overlay-bl">
        <label
          className="orbit-badge"
          style={{ ['--zoom-pct' as string]: zoomPct + '%' } as React.CSSProperties}
        >
          <span className="mono">1.0x</span>
          <input
            className="zoom-slider"
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.1}
            value={zoom}
            aria-label="语义变焦（1.0x 到 10.0x）"
            onChange={(event) => onZoomChange(clampZoom(Number(event.target.value)))}
          />
          <span className="mono">10.0x</span>
        </label>
      </div>
    </section>
  );
}
