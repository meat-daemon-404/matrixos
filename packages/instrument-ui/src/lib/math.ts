/**
 * 数值与几何工具。全部为纯函数，无副作用，可在测试与 Canvas 绘制中复用。
 * 严格模式约定：任何接受索引/元组的地方都做 `?? fallback` 处理（noUncheckedIndexedAccess）。
 */

/** 把 v 夹在 [min, max] 内；min > max 时自动交换。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(lo, value));
}

/** 归一化到 0..1（区间退化时返回 0）。 */
export function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

/** 线性映射（**不裁剪**）；区间退化时返回 outMin。Canvas 比例尺用。 */
export function linearMap(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

/** 线性映射并裁剪到输出区间；区间退化时返回 outMin。 */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return outMin + normalize(value, inMin, inMax) * (outMax - outMin);
}

/** 线性插值。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 保留 decimals 位小数。 */
export function roundTo(value: number, decimals: number): number {
  const f = 10 ** clamp(Math.round(decimals), 0, 12);
  return Math.round(value * f) / f;
}

/** 由 step 推断应显示几位小数（0.05 → 2，1 → 0）。 */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const exp = text.indexOf('e-');
  if (exp >= 0) return Number(text.slice(exp + 2));
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** 吸附到步进网格（以 min 为原点，避免 min 非 0 时出现半格偏差）。 */
export function snapToStep(value: number, step: number, origin = 0): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  return origin + Math.round((value - origin) / step) * step;
}

/** 定点格式化，避免 0.1+0.2 一类浮点噪声进入显示层。 */
export function formatFixed(value: number, decimals: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toFixed(clamp(Math.round(decimals), 0, 12));
}

/** 带正负号的定点格式化（旋钮读数的常见形态）。 */
export function formatSigned(value: number, decimals: number): string {
  const text = formatFixed(value, decimals);
  return value > 0 ? `+${text}` : text;
}

/** 紧凑大数字（综测总分、经费总额等的显示）。 */
export function formatCompact(value: number, decimals = 1): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e8) return `${sign}${roundTo(abs / 1e8, decimals)}亿`;
  if (abs >= 1e4) return `${sign}${roundTo(abs / 1e4, decimals)}万`;
  return `${sign}${roundTo(abs, 0)}`;
}

/** 极坐标 → 直角坐标。角度以「12 点方向为 0°、顺时针为正」计。 */
export function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/** 椭圆上的点（2.5D 星轨用；ry 通常是 rx 的 0.42~0.48 倍）。 */
export function ellipsePoint(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + rx * Math.cos(rad), y: cy + ry * Math.sin(rad) };
}

/** SVG 圆弧 path（仪表弧、声呐外环用）。角度同 polarToCartesian。 */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const span = Math.abs(endAngle - startAngle);
  if (span >= 359.999) {
    // 整圆无法用单段 A 指令表达，拆成两段半圆
    const mid = startAngle + 180;
    return [
      describeArcSegment(cx, cy, radius, startAngle, mid, false),
      describeArcSegment(cx, cy, radius, mid, startAngle > endAngle ? mid - 180 : mid + 180, false),
    ].join(' ');
  }
  return describeArcSegment(cx, cy, radius, startAngle, endAngle, endAngle < startAngle);
}

function describeArcSegment(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  sweep: boolean,
): string {
  const start = polarToCartesian(cx, cy, radius, startAngle);
  const end = polarToCartesian(cx, cy, radius, endAngle);
  const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  const sweepFlag = sweep ? 0 : 1;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} ${sweepFlag} ${end.x} ${end.y}`;
}

/** 生成「好看」的刻度值：1/2/5 × 10^n 步长。 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max || count < 2) {
    return [min];
  }
  const span = max - min;
  const rawStep = span / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
  const residual = rawStep / magnitude;
  const niceResidual = residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1;
  const step = niceResidual * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  // 上限保护：防止极端区间（如 1e-9 ~ 1e9）产生数万个刻度
  for (let i = 0; i < 200; i += 1) {
    const v = start + i * step;
    if (v > max + step * 1e-6) break;
    ticks.push(roundTo(v, 10));
  }
  return ticks.length > 0 ? ticks : [min, max];
}

/** 把区间扩到「好看」的边界。 */
export function niceDomain(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const ticks = niceTicks(min, max, 4);
  const first = ticks[0] ?? min;
  const last = ticks[ticks.length - 1] ?? max;
  return [Math.min(first, min), Math.max(last, max)];
}

/** 角度归一化到 [0, 360)。 */
export function normalizeAngle(deg: number): number {
  const mod = deg % 360;
  return mod < 0 ? mod + 360 : mod;
}

/** 数组均匀分成 n 份的取整（星轨胶囊分布用）。 */
export function distributeEvenly(count: number, index: number): number {
  return count <= 0 ? 0 : (360 / count) * index;
}

/** 均匀降采样（Canvas 万点重绘的第一道闸）。 */
export function downsample<T>(items: readonly T[], maxCount: number): readonly T[] {
  if (maxCount <= 0 || items.length <= maxCount) return items;
  const stride = items.length / maxCount;
  const out: T[] = [];
  for (let i = 0; i < maxCount; i += 1) {
    const item = items[Math.floor(i * stride)];
    if (item !== undefined) out.push(item);
  }
  return out;
}

/** 判断是否为有限数值（数据的脏值过滤）。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
