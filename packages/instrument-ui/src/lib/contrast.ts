/**
 * WCAG 2.1 对比度工具。
 *
 * 存在理由：视觉体系文档 §2.5 给出了一张实测表，但没有**可执行的守卫**。
 * 组件库把公式落成代码后，demo 页会实时展示每个前景/背景组合的比值，
 * 任何新增色值只要不达 4.5:1 就会在页面上标红 —— 让 V6 的回归无处藏身。
 */

export type HexColor = string;

/** #rgb / #rrggbb / #rrggbbaa → [r, g, b]（0-255）。非法输入返回 null。 */
export function hexToRgb(hex: HexColor): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    const [r, g, b] = [h[0], h[1], h[2]];
    h = `${r ?? '0'}${r ?? '0'}${g ?? '0'}${g ?? '0'}${b ?? '0'}${b ?? '0'}`;
  }
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** sRGB 相对亮度（WCAG 2.1 定义，非感知亮度）。 */
export function relativeLuminance(hex: HexColor): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 两色对比度比值（1 ~ 21）。参数顺序无关。 */
export function contrastRatio(a: HexColor, b: HexColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type WcagLevel = 'AAA' | 'AA' | 'AA-large' | 'FAIL';

/**
 * 判定等级。`large` 指 ≥ 18.66px 粗体或 ≥ 24px 常规（WCAG 1.4.3）。
 * 组件库的策略是**一律按正文标准判定**（4.5:1），大字号只是放宽展示而非豁免。
 */
export function wcagLevel(ratio: number): WcagLevel {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA-large';
  return 'FAIL';
}

/** 在一组候选底色中取最差比值 —— 组件会出现在所有表面上，必须按最坏情况验收。 */
export function worstContrast(foreground: HexColor, backgrounds: readonly HexColor[]): number {
  if (backgrounds.length === 0) return contrastRatio(foreground, '#000000');
  return Math.min(...backgrounds.map((bg) => contrastRatio(foreground, bg)));
}

/** 背景显式给定时的可读前景选择（Canvas 轴标签、图例用）。 */
export function pickReadable(
  background: HexColor,
  candidates: readonly HexColor[],
): { color: HexColor; ratio: number } {
  let best: { color: HexColor; ratio: number } = {
    color: candidates[0] ?? '#ffffff',
    ratio: 0,
  };
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, background);
    if (ratio > best.ratio) best = { color: candidate, ratio };
  }
  return best;
}

/** 组件库固定使用的四种表面（与 tokens.css 一致）。 */
export const SURFACES = {
  obsidian: '#050814',
  panel: '#0b1124',
  panelEnd: '#070b18',
  raised: '#0f172a',
  sunken: '#020617',
} as const;

export const SURFACE_LIST: readonly HexColor[] = [
  SURFACES.obsidian,
  SURFACES.panel,
  SURFACES.panelEnd,
  SURFACES.raised,
  SURFACES.sunken,
];
