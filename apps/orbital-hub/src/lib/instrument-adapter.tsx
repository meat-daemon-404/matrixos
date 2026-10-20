'use client';

/**
 * instrument-ui 组件适配器
 * ==========================================================================
 * 三个仪器组件（StarOrbit / CopilotWaveDock / WormholeRing）正在由 ui-library 开发。
 * 这里的职责：**按最终签名**从库里解析组件；解析不到就用同签名的内置实现。
 *
 * 为什么这样做而不是直接 import：
 *  1. 库的源码直出，但组件名在落地前可能微调 —— 解析器覆盖常见别名；
 *  2. 从"内置实现"切到"库实现"是自动的：库一就位，解析命中，内置实现不再被打包
 *     （tree-shaking 会把它摇掉，因为模块顶层取到的引用是库组件）；
 *  3. 签名严格对齐 owner 给的最终版，替换时 hub 侧一行不用改。
 *
 * 签名锁定来源：ui-library 2026-10-20 的回复（StarOrbit / CopilotWaveDock / WormholeRing）。
 */

import type { ComponentType } from 'react';
import * as InstrumentUI from '@matrixos/instrument-ui';

/** 与 instrument-ui 对齐的强调色枚举（六色，值为 Tailwind 500 档）。 */
export type InstrumentAccent = 'indigo' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet';

export const ACCENT_HEX: Readonly<Record<InstrumentAccent, string>> = {
  indigo: '#6366f1',
  cyan: '#06b6d4',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
  violet: '#8b5cf6',
};

/** 轨道强调色 → 六色枚举（轨道色来自花名册轨道的语义分配）。 */
export function accentFromHex(hex: string): InstrumentAccent {
  const found = (Object.keys(ACCENT_HEX) as InstrumentAccent[]).find(
    (key) => ACCENT_HEX[key].toLowerCase() === hex.toLowerCase(),
  );
  return found ?? 'cyan';
}

const rawUi = InstrumentUI as unknown as Record<string, unknown>;

/** 依次尝试候选导出名，命中即返回。 */
export function resolveInstrumentComponent<P>(
  candidates: readonly string[],
): ComponentType<P> | null {
  for (const name of candidates) {
    const candidate = rawUi[name];
    if (candidate) return candidate as ComponentType<P>;
  }
  return null;
}

/** 库整体是否就位（shim 会导出 __matrixosShim 标记）。 */
export const instrumentUiIsShim = rawUi.__matrixosShim === true;
