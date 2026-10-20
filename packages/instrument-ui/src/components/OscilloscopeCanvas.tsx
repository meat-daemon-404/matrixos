import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { cx } from '../lib/cx';
import { accentStyle } from '../lib/accent';
import type { InstrumentAccent } from '../lib/accent';
import { useDevicePixelRatio, useElementSize, usePrefersReducedMotion, useUid } from '../lib/hooks';
import {
  clamp,
  downsample,
  formatFixed,
  linearMap,
  niceDomain,
  niceTicks,
} from '../lib/math';
import {
  confidenceHalfWidth,
  linearRegression,
  makeDemoSeries,
  meanAndSxx,
  residuals,
} from '../lib/stats';
import type { LinearFit } from '../lib/stats';
import '../styles/components/oscilloscope.css';

export interface ScatterPoint {
  x: number;
  y: number;
}

/** 拟合模型标识。`none` 表示只画散点（无拟合）。 */
export type FitModelKind = 'linear' | 'exp' | 'lorentz' | 'none';

export interface OscilloscopeCanvasProps {
  /** 散点数据。与 `demo` 二选一。 */
  points?: readonly ScatterPoint[];
  /** 造数开关（demo 用）：不传 points 时按此参数生成确定性数据。 */
  demo?: { count?: number; noise?: number; seed?: number; model?: 'linear' | 'exp' | 'lorentz' } | null;

  /**
   * 外部预先算好的拟合结果（推荐：CurveLab 在 Web Worker 里算完再传进来）。
   * 不传时组件会用内置最小二乘对 points 现算（仅为降级/演示，不用于生产）。
   */
  fit?: LinearFit | null;
  /** 拟合模型类型，仅影响图例文案；计算始终由 `fit` 或内置最小二乘提供。 */
  model?: FitModelKind;
  /** 模型可读名，如「双指数衰减 biexponential」。 */
  modelLabel?: string;

  /** 画 95% 置信带，默认 true。 */
  showConfidence?: boolean;
  /** 置信水平，默认 0.95。 */
  confidenceLevel?: number;
  /** 画残差子图，默认 true。 */
  showResiduals?: boolean;
  /** 残差子图占总高度比例，默认 0.26。 */
  residualRatio?: number;
  /** 画网格，默认 true。 */
  showGrid?: boolean;
  /** 画荧光余晖（无限循环的轻微呼吸），默认 true；reduced-motion 下强制关闭。 */
  phosphor?: boolean;

  /** X/Y 轴标签。 */
  xLabel?: string;
  yLabel?: string;
  /** 标题（左上角仪器铭牌）。 */
  title?: string;

  /** 强调色，默认 cyan。 */
  accent?: InstrumentAccent;
  /** 高度，默认 320。 */
  height?: number;
  /** 是否渲染等价数据表格（无障碍），默认 true。 */
  accessibleTable?: boolean;

  /** 悬停到某点时触发（null 表示离开）。 */
  onPointHover?: (point: ScatterPoint | null) => void;
  /** 实时重绘的性能探针：每次绘制完成后回调（毫秒）。 */
  onDraw?: (info: { ms: number; pointCount: number }) => void;

  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

const N = {
  padTop: 14,
  padRight: 14,
  padBottom: 26,
  padLeft: 46,
  residualGap: 14,
  residualPadBottom: 18,
} as const;

/**
 * `<OscilloscopeCanvas>` 荧光示波器。
 *
 * 视觉来源：视觉体系文档 §2.6 的 Canvas 硬编码色板（`#040814` 底、
 * `rgba(30,41,59,.75)` 网格、`#475569` 轴、`#22d3ee` 拟合曲线、`#f59e0b` 散点、
 * `rgba(6,182,212,.14)` 置信带）—— 逐条照抄，不从渲染图取色。
 *
 * 性能策略（对齐 WBS S3-02「1 万点实时重绘 ≥ 30fps」）：
 * - 降采样：超过 `MAX_DRAW_POINTS`(4000) 自动均匀抽稀。屏幕物理像素就那么点，
 *   画 1 万个点与画 4000 个点在视觉上无差别，但 fillRect 调用量差 2.5×。
 * - 批量绘制：散点用一个 path，一次 fill（不是每点一次 beginPath）。
 * - 只在依赖变化时重绘，**没有** requestAnimationFrame 常驻循环。
 *   荧光呼吸用的是 CSS filter 动画，不占主线程。
 * - DPR 封顶 2，避免 4K/Retina 上画布面积 4× 导致带宽爆炸。
 *
 * 无障碍（ADR-07 明确指出 Canvas 对屏幕阅读器不友好）：
 * 默认渲染一张视觉隐藏的等价数据表格，`role="img"` + `aria-label` 描述统计摘要；
 * 表格可通过 `accessibleTable={false}` 关闭（调用方自备时）。
 */
export function OscilloscopeCanvas({
  points,
  demo = null,
  fit,
  model = 'linear',
  modelLabel,
  showConfidence = true,
  confidenceLevel = 0.95,
  showResiduals = true,
  residualRatio = 0.26,
  showGrid = true,
  phosphor = true,
  xLabel,
  yLabel,
  title,
  accent,
  height = 320,
  accessibleTable = true,
  onPointHover,
  onDraw,
  className,
  style,
  ...rest
}: OscilloscopeCanvasProps) {
  const uid = useUid('iu-scope');
  const reducedMotion = usePrefersReducedMotion();
  const dpr = useDevicePixelRatio(2);
  const [wrapRef, size] = useElementSize<HTMLDivElement>({ width: 640, height });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [activePoint, setActivePoint] = useState<ScatterPoint | null>(null);

  // ---- 数据 ---------------------------------------------------------------
  const data = useMemo<readonly ScatterPoint[]>(() => {
    if (points && points.length > 0) {
      return points.filter(
        (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
      );
    }
    if (demo) {
      return makeDemoSeries({
        count: demo.count ?? 220,
        noise: demo.noise ?? 1.1,
        seed: demo.seed ?? 20261020,
        model: demo.model ?? 'linear',
      });
    }
    return [];
  }, [demo, points]);

  const computedFit = useMemo<LinearFit | null>(() => {
    if (fit) return fit;
    if (data.length < 2) return null;
    return linearRegression(data.map((p) => [p.x, p.y] as const));
  }, [data, fit]);

  const stats = useMemo(() => {
    const xs = data.map((p) => p.x);
    const { meanX, sxx } = meanAndSxx(xs);
    return { meanX, sxx };
  }, [data]);

  // ---- 绘制 ---------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();

    const cssW = Math.max(120, size.width);
    const cssH = Math.max(120, size.height || height);
    const dprClamped = clamp(dpr, 1, 2);

    // 只在尺寸真的变了才改 canvas 尺寸（改尺寸会清空画布 + 重置状态）
    const targetW = Math.round(cssW * dprClamped);
    const targetH = Math.round(cssH * dprClamped);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    ctx.setTransform(dprClamped, 0, 0, dprClamped, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // 读取主题色（跟随 accent 变量，而不是硬编码十六进制）
    const styles = typeof window !== 'undefined' ? getComputedStyle(wrap) : null;
    const readVar = (name: string, fallback: string): string => {
      const value = styles?.getPropertyValue(name).trim();
      return value && value.length > 0 ? value : fallback;
    };
    const accentColor = readVar('--iu-accent', '#06b6d4');
    const accentBright = readVar('--iu-accent-bright', '#22d3ee');
    const accentRgb = readVar('--iu-accent-rgb', '6 182 212');

    const bg = readVar('--iu-canvas-bg', '#040814');
    const gridColor = readVar('--iu-canvas-grid', 'rgba(30, 41, 59, 0.75)');
    const gridStrong = readVar('--iu-canvas-grid-strong', '#334155');
    const axisColor = readVar('--iu-canvas-axis', '#475569');
    const labelColor = readVar('--iu-canvas-label', '#94a3b8');
    const scatterColor = readVar('--iu-canvas-scatter', '#f59e0b');
    const curveColor = readVar('--iu-canvas-curve', '#22d3ee');

    const mainH = showResiduals && computedFit
      ? Math.max(80, cssH * (1 - clamp(residualRatio, 0.15, 0.5)) - N.residualGap)
      : cssH;
    const plotLeft = N.padLeft;
    const plotTop = N.padTop;
    const plotWidth = Math.max(10, cssW - N.padLeft - N.padRight);
    const plotHeight = Math.max(10, mainH - N.padTop - N.padBottom);

    // 背景
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // 数据域
    const xsRaw = data.map((p) => p.x);
    const ysRaw = data.map((p) => p.y);
    const [x0, x1] = niceDomain(
      xsRaw.length ? Math.min(...xsRaw) : 0,
      xsRaw.length ? Math.max(...xsRaw) : 1,
    );
    let y0 = ysRaw.length ? Math.min(...ysRaw) : 0;
    let y1 = ysRaw.length ? Math.max(...ysRaw) : 1;
    if (computedFit && showConfidence) {
      // 置信带会把 y 范围撑开，域必须把它算进去，否则带会被裁掉
      for (const p of data) {
        const half = confidenceHalfWidth(
          computedFit,
          p.x,
          stats.meanX,
          stats.sxx,
          confidenceLevel,
        );
        const predicted = computedFit.predict(p.x);
        y0 = Math.min(y0, predicted - half);
        y1 = Math.max(y1, predicted + half);
      }
    }
    const [y0n, y1n] = niceDomain(y0, y1);

    const sx = (x: number) => plotLeft + linearMap(x, x0, x1, 0, plotWidth);
    const sy = (y: number) => plotTop + linearMap(y, y0n, y1n, plotHeight, 0);

    // 网格 + 刻度
    const xTicks = niceTicks(x0, x1, 6);
    const yTicks = niceTicks(y0n, y1n, 5);

    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = `500 10px ${readVar('--iu-font-mono', 'ui-monospace, monospace')}`;
    ctx.textBaseline = 'middle';

    if (showGrid) {
      for (const tick of xTicks) {
        const x = sx(tick);
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotTop + plotHeight);
        ctx.stroke();
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'center';
        ctx.fillText(formatFixed(tick, tickScale(xTicks)), x, plotTop + plotHeight + 11);
      }
      for (const tick of yTicks) {
        const y = sy(tick);
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotLeft + plotWidth, y);
        ctx.stroke();
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatFixed(tick, tickScale(yTicks)), plotLeft - 7, y);
      }
    }

    // 轴
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, plotTop);
    ctx.lineTo(plotLeft, plotTop + plotHeight);
    ctx.lineTo(plotLeft + plotWidth, plotTop + plotHeight);
    ctx.stroke();

    // 轴标签
    ctx.fillStyle = labelColor;
    ctx.font = `500 10px ${readVar('--iu-font-mono', 'ui-monospace, monospace')}`;
    if (xLabel) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(xLabel, plotLeft + plotWidth, mainH - 3);
    }
    if (yLabel) {
      ctx.save();
      ctx.translate(11, plotTop + 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }
    ctx.restore();

    if (data.length === 0) {
      ctx.fillStyle = labelColor;
      ctx.font = `500 11px ${readVar('--iu-font-mono', 'ui-monospace, monospace')}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO SIGNAL · 无数据', plotLeft + plotWidth / 2, plotTop + plotHeight / 2);
      return;
    }

    ctx.save();
    // 裁剪到绘图区，防止置信带/曲线溢出到轴外
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();

    // ---- 95% 置信带 -------------------------------------------------------
    if (showConfidence && computedFit) {
      const steps = 96;
      const upper: { x: number; y: number }[] = [];
      const lower: { x: number; y: number }[] = [];
      for (let i = 0; i <= steps; i += 1) {
        const x = x0 + ((x1 - x0) * i) / steps;
        const predicted = computedFit.predict(x);
        const half = confidenceHalfWidth(
          computedFit,
          x,
          stats.meanX,
          stats.sxx,
          confidenceLevel,
        );
        upper.push({ x: sx(x), y: sy(predicted + half) });
        lower.push({ x: sx(x), y: sy(predicted - half) });
      }

      ctx.beginPath();
      const firstUpper = upper[0];
      if (firstUpper) {
        ctx.moveTo(firstUpper.x, firstUpper.y);
        for (const p of upper) ctx.lineTo(p.x, p.y);
      }
      for (let i = lower.length - 1; i >= 0; i -= 1) {
        const p = lower[i];
        if (p) ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      const bandGradient = ctx.createLinearGradient(0, plotTop, 0, plotTop + plotHeight);
      bandGradient.addColorStop(0, `rgb(${accentRgb} / 0.2)`);
      bandGradient.addColorStop(1, `rgb(${accentRgb} / 0.06)`);
      ctx.fillStyle = bandGradient;
      ctx.fill();

      // 带的边界虚线（更精确地表达「这是一个区间」）
      ctx.strokeStyle = `rgb(${accentRgb} / 0.4)`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      if (firstUpper) {
        ctx.moveTo(firstUpper.x, firstUpper.y);
        for (const p of upper) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.beginPath();
      const firstLower = lower[0];
      if (firstLower) {
        ctx.moveTo(firstLower.x, firstLower.y);
        for (const p of lower) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- 散点（单 path 批量）---------------------------------------------
    const drawn = downsample(data, 4000);
    ctx.fillStyle = scatterColor;
    ctx.globalAlpha = 0.62;
    const dotSize = drawn.length > 1500 ? 1 : drawn.length > 500 ? 1.4 : 2;
    ctx.beginPath();
    for (const p of drawn) {
      const px = sx(p.x);
      const py = sy(p.y);
      // 用 rect 而不是 arc：1px 点用 arc 太贵，且 arc 在低 DPR 下会糊
      ctx.rect(px - dotSize / 2, py - dotSize / 2, dotSize, dotSize);
    }
    ctx.fill();
    ctx.globalAlpha = 1;

    // ---- 拟合曲线 --------------------------------------------------------
    if (computedFit) {
      const curve: { x: number; y: number }[] = [];
      const steps = Math.max(64, Math.min(240, Math.round(plotWidth / 3)));
      for (let i = 0; i <= steps; i += 1) {
        const x = x0 + ((x1 - x0) * i) / steps;
        curve.push({ x: sx(x), y: sy(computedFit.predict(x)) });
      }

      // 荧光：两遍描边（宽而淡 + 细而亮）模拟示波器辉光
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgb(${accentRgb} / 0.22)`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      const c0 = curve[0];
      if (c0) {
        ctx.moveTo(c0.x, c0.y);
        for (const p of curve) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      ctx.strokeStyle = curveColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      if (c0) {
        ctx.moveTo(c0.x, c0.y);
        for (const p of curve) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // ---- 悬停高亮点 -------------------------------------------------------
    if (activePoint) {
      const px = sx(activePoint.x);
      const py = sy(activePoint.y);
      ctx.save();
      ctx.strokeStyle = accentBright;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, py);
      ctx.lineTo(plotLeft + plotWidth, py);
      ctx.moveTo(px, plotTop);
      ctx.lineTo(px, plotTop + plotHeight);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = accentBright;
      ctx.fill();
      ctx.strokeStyle = bg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    // ---- 残差子图 --------------------------------------------------------
    if (showResiduals && computedFit) {
      const rTop = plotTop + plotHeight + N.padBottom + N.residualGap - 8;
      const rHeight = Math.max(28, cssH - rTop - N.residualPadBottom);
      const residualData = residuals(
        data.map((p) => [p.x, p.y] as const),
        computedFit,
      );
      const rValues = residualData.map((r) => r.r);
      const rMax = Math.max(1e-6, ...rValues.map((v) => Math.abs(v)));

      ctx.save();
      ctx.fillStyle = bg;
      ctx.fillRect(plotLeft, rTop, plotWidth, rHeight);

      // 零线
      const zeroY = rTop + rHeight / 2;
      ctx.strokeStyle = gridStrong;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotLeft, zeroY);
      ctx.lineTo(plotLeft + plotWidth, zeroY);
      ctx.stroke();

      const rSy = (value: number) =>
        zeroY - (value / rMax) * (rHeight / 2 - 2);

      // ±1σ 参考带
      if (computedFit.residualStdError > 0) {
        const sigmaY = (computedFit.residualStdError / rMax) * (rHeight / 2 - 2);
        ctx.fillStyle = `rgb(${accentRgb} / 0.08)`;
        ctx.fillRect(plotLeft, zeroY - sigmaY, plotWidth, sigmaY * 2);
        ctx.strokeStyle = `rgb(${accentRgb} / 0.3)`;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(plotLeft, zeroY - sigmaY);
        ctx.lineTo(plotLeft + plotWidth, zeroY - sigmaY);
        ctx.moveTo(plotLeft, zeroY + sigmaY);
        ctx.lineTo(plotLeft + plotWidth, zeroY + sigmaY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 残差棒
      const barW = Math.max(1, Math.min(3, plotWidth / Math.max(1, residualData.length) - 0.6));
      const resampledResiduals = downsample(residualData, 1200);
      ctx.fillStyle = `rgb(${accentRgb} / 0.55)`;
      for (const r of resampledResiduals) {
        const px = sx(r.x);
        const py = rSy(r.r);
        ctx.fillRect(px - barW / 2, Math.min(py, zeroY), barW, Math.max(0.8, Math.abs(py - zeroY)));
      }

      ctx.fillStyle = labelColor;
      ctx.font = `500 9px ${readVar('--iu-font-mono', 'ui-monospace, monospace')}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${formatFixed(rMax, 2)}`, plotLeft - 7, rTop + 4);
      ctx.fillText(`-${formatFixed(rMax, 2)}`, plotLeft - 7, rTop + rHeight - 4);
      ctx.fillText('resid', plotLeft - 7, zeroY);

      // 残差区边框
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(plotLeft + 0.5, rTop + 0.5, plotWidth - 1, rHeight - 1);
      ctx.restore();
    }

    // ---- 左上铭牌：R² ----------------------------------------------------
    if (computedFit && title) {
      ctx.save();
      ctx.font = `600 10px ${readVar('--iu-font-mono', 'ui-monospace, monospace')}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = labelColor;
      ctx.fillText(title, plotLeft + 6, plotTop + 5);
      ctx.restore();
    }

    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
    onDraw?.({ ms: ended - started, pointCount: data.length });
  }, [
    activePoint,
    computedFit,
    confidenceLevel,
    data,
    dpr,
    height,
    onDraw,
    residualRatio,
    showConfidence,
    showGrid,
    showResiduals,
    size.height,
    size.width,
    stats.meanX,
    stats.sxx,
    title,
    wrapRef,
    xLabel,
    yLabel,
  ]);

  // 依赖变化即重绘（没有常驻 rAF）
  useEffect(() => {
    draw();
  }, [draw]);

  // 尺寸变化重绘（ResizeObserver 已节流）
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [draw, wrapRef]);

  // 焦点/主题变化时重绘（accent 是 CSS 变量，不会触发 React 更新）
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handle = () => draw();
    mq.addEventListener?.('change', handle);
    return () => mq.removeEventListener?.('change', handle);
  }, [draw]);

  // ---- 悬停命中测试 -------------------------------------------------------
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (data.length === 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;

      const plotWidth = Math.max(10, rect.width - N.padLeft - N.padRight);
      const mainH =
        showResiduals && computedFit
          ? Math.max(80, rect.height * (1 - clamp(residualRatio, 0.15, 0.5)) - N.residualGap)
          : rect.height;
      const plotHeight = Math.max(10, mainH - N.padTop - N.padBottom);
      if (py > N.padTop + plotHeight + 8) {
        if (activePoint) {
          setActivePoint(null);
          onPointHover?.(null);
        }
        return;
      }

      const xsRaw = data.map((p) => p.x);
      const ysRaw = data.map((p) => p.y);
      const [x0, x1] = niceDomain(Math.min(...xsRaw), Math.max(...xsRaw));
      const [y0, y1] = niceDomain(Math.min(...ysRaw), Math.max(...ysRaw));

      const dataX = x0 + ((px - N.padLeft) / plotWidth) * (x1 - x0);
      const dataY = y1 - ((py - N.padTop) / plotHeight) * (y1 - y0);

      // 最近邻（像素域，避免 x/y 量纲不同导致的错配）
      let best: ScatterPoint | null = null;
      let bestDist = Infinity;
      const step = Math.max(1, Math.floor(data.length / 800));
      for (let i = 0; i < data.length; i += step) {
        const p = data[i];
        if (!p) continue;
        const dx = ((p.x - dataX) / (x1 - x0)) * plotWidth;
        const dy = ((p.y - dataY) / (y1 - y0)) * plotHeight;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      if (best && bestDist < 900) {
        setActivePoint(best);
        onPointHover?.(best);
      } else if (activePoint) {
        setActivePoint(null);
        onPointHover?.(null);
      }
    },
    [activePoint, computedFit, data, onPointHover, residualRatio, showResiduals],
  );

  const summary = useMemo(() => {
    if (data.length === 0) return '示波器：无数据';
    const r2 = computedFit ? computedFit.r2 : 0;
    return `示波器：${data.length} 个数据点，R² = ${formatFixed(r2, 4)}${
      showConfidence ? `，含 ${Math.round(confidenceLevel * 100)}% 置信带` : ''
    }`;
  }, [computedFit, confidenceLevel, data.length, showConfidence]);

  const tableRows = useMemo(() => downsample(data, 200), [data]);

  return (
    <div
      className={cx('iu-root', 'iu-scope', phosphor && !reducedMotion && 'is-phosphor', className)}
      style={accentStyle(accent, { ...style, height: `${height}px` })}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      {...rest}
    >
      <div className="iu-scope__frame">
        <div className="iu-scope__plate">
          <span className="iu-scope__plate-title">{title ?? 'CURVELAB · REGRESSION'}</span>
          <span className="iu-scope__plate-model">{modelLabel ?? model.toUpperCase()}</span>
        </div>

        <div className="iu-scope__stats" aria-hidden="true">
          <span className="iu-scope__stat">
            <span className="iu-label">R²</span>
            <span className="iu-readout iu-scope__stat-value">
              {computedFit ? formatFixed(computedFit.r2, 4) : '—'}
            </span>
          </span>
          <span className="iu-scope__stat">
            <span className="iu-label">N</span>
            <span className="iu-readout iu-scope__stat-value">{data.length}</span>
          </span>
          <span className="iu-scope__stat">
            <span className="iu-label">σ</span>
            <span className="iu-readout iu-scope__stat-value">
              {computedFit ? formatFixed(computedFit.residualStdError, 3) : '—'}
            </span>
          </span>
        </div>

        <div className="iu-scope__canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className="iu-scope__canvas iu-focus"
            tabIndex={0}
            role="img"
            aria-label={summary}
            aria-describedby={`${uid}-desc`}
            onPointerMove={handlePointerMove}
            onPointerLeave={() => {
              if (activePoint) {
                setActivePoint(null);
                onPointHover?.(null);
              }
            }}
          />

          {/* 扫描线（纯 CSS，reduced-motion 下关闭） */}
          <span className="iu-scope__scanline" aria-hidden="true" />

          {activePoint ? (
            <span
              className="iu-scope__tooltip"
              style={{
                left: `${clamp(
                  ((activePoint.x - (data[0]?.x ?? 0)) /
                    Math.max(1e-9, (data[data.length - 1]?.x ?? 1) - (data[0]?.x ?? 0))) *
                    100,
                  0,
                  100,
                )}%`,
              }}
              aria-hidden="true"
            >
              <span className="iu-num">
                x {formatFixed(activePoint.x, 3)} · y {formatFixed(activePoint.y, 3)}
              </span>
              {computedFit ? (
                <span className="iu-scope__tooltip-res">
                  r {formatSignedLocal(activePoint.y - computedFit.predict(activePoint.x))}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>

        <div className="iu-scope__legend" aria-hidden="true">
          <span className="iu-scope__legend-item">
            <span className="iu-scope__swatch is-scatter" />散点
          </span>
          <span className="iu-scope__legend-item">
            <span className="iu-scope__swatch is-curve" />拟合曲线
          </span>
          {showConfidence ? (
            <span className="iu-scope__legend-item">
              <span className="iu-scope__swatch is-band" />
              {Math.round(confidenceLevel * 100)}% 置信带
            </span>
          ) : null}
          {showResiduals ? (
            <span className="iu-scope__legend-item">
              <span className="iu-scope__swatch is-resid" />残差
            </span>
          ) : null}
        </div>
      </div>

      <p className="iu-sr-only" id={`${uid}-desc`}>
        {summary}
        {computedFit
          ? `；斜率 ${formatFixed(computedFit.slope, 4)}，截距 ${formatFixed(
              computedFit.intercept,
              4,
            )}`
          : ''}
        。下表为等价数据（前 {tableRows.length} 点）。
      </p>

      {accessibleTable ? (
        <table className="iu-sr-only">
          <caption>示波器等价数据表</caption>
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">x</th>
              <th scope="col">y</th>
              {computedFit ? <th scope="col">拟合残差</th> : null}
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row, index) => (
              <tr key={`row-${index}-${row.x}`}>
                <td>{index + 1}</td>
                <td>{formatFixed(row.x, 4)}</td>
                <td>{formatFixed(row.y, 4)}</td>
                {computedFit ? <td>{formatFixed(row.y - computedFit.predict(row.x), 4)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/** 刻度小数位：根据相邻刻度间距推断，避免 0.1 显示成 0。 */
function tickScale(ticks: readonly number[]): number {
  if (ticks.length < 2) return 1;
  const a = ticks[0] ?? 0;
  const b = ticks[1] ?? 1;
  const step = Math.abs(b - a);
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  return 3;
}

function formatSignedLocal(value: number): string {
  const text = formatFixed(value, 3);
  return value > 0 ? `+${text}` : text;
}
