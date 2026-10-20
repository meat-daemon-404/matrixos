import type { CSSProperties } from 'react';

/**
 * 品牌六色 + 语义别名。
 *
 * 只暴露 6 个色相是有意的：视觉体系文档 §2.2 明确「不建第二套并行 token」，
 * 且实测风险色（rose）在原设计中权重严重失衡（V7），组件库通过 `accent` +
 * 语义 tone 两层来重新分配风险信号的视觉权重。
 */
export type InstrumentAccent = 'indigo' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet';

/** 语义 tone：把「用什么色」和「表达什么含义」解耦。 */
export type InstrumentTone = 'neutral' | 'info' | 'positive' | 'warning' | 'danger';

/** 尺寸档位。 */
export type InstrumentSize = 'sm' | 'md' | 'lg';

export const ACCENTS: readonly InstrumentAccent[] = [
  'indigo',
  'cyan',
  'emerald',
  'amber',
  'rose',
  'violet',
] as const;

export const TONE_TO_ACCENT: Readonly<Record<InstrumentTone, InstrumentAccent | null>> = {
  neutral: null,
  info: 'cyan',
  positive: 'emerald',
  warning: 'amber',
  danger: 'rose',
};

/**
 * 生成驱动 accent 的内联样式。
 *
 * 组件内部所有颜色都取自 `--iu-accent*`，因此换 accent 只需覆写这 4 个变量，
 * 不必为每个色相写一套 CSS 规则 —— 这是「品牌六色 × 10 组件」不爆炸的关键。
 */
export function accentStyle(
  accent: InstrumentAccent | undefined,
  style?: CSSProperties,
): CSSProperties {
  if (!accent) return style ?? {};
  return {
    '--iu-accent': `var(--iu-${accent})`,
    '--iu-accent-bright': `var(--iu-${accent}-bright)`,
    '--iu-accent-text': `var(--iu-${accent}-text, var(--iu-${accent}-bright))`,
    '--iu-accent-rgb': `var(--iu-${accent}-rgb)`,
    ...style,
  } as CSSProperties;
}

/** 语义 tone 的 accent 解析（neutral 返回 undefined，表示用默认仪器色）。 */
export function toneAccent(tone: InstrumentTone | undefined): InstrumentAccent | undefined {
  if (!tone) return undefined;
  const accent = TONE_TO_ACCENT[tone];
  return accent ?? undefined;
}

/**
 * 合并 accent 与 tone：显式 accent 优先，其次 tone，最后 undefined（默认 cyan）。
 */
export function resolveAccent(
  accent: InstrumentAccent | undefined,
  tone: InstrumentTone | undefined,
): InstrumentAccent | undefined {
  return accent ?? toneAccent(tone);
}
