/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：15 撤稿深海声呐与伦理合规仪
 * 轨道：轨道 5 · 工坊 · 域名：retract-radar.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=15 --force
 */
'use client';

import type { ComponentType, ReactNode } from 'react';
import * as InstrumentUI from "@matrixos/instrument-ui";

/**
 * instrument-ui 适配层
 * ==========================================================================
 * 骨架阶段该库可能尚未发布。这里只取一个最稳定的容器组件（面板/边框），
 * 拿不到就用本地同款样式顶替 —— 视觉 token 一致，所以两种实现看起来一样。
 * 组件库里任何新组件要进微站，都从这里暴露，不要在页面里直接 import 包。
 */
export interface BezelProps {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly accent?: string;
}

const rawUi = InstrumentUI as unknown as Record<string, unknown>;

/** 依次尝试库里的候选组件名，命中即用。 */
function resolveComponent(candidates: readonly string[]): ComponentType<BezelProps> | null {
  for (const name of candidates) {
    const candidate = rawUi[name];
    if (candidate) return candidate as ComponentType<BezelProps>;
  }
  return null;
}

const LibraryBezel = resolveComponent(['InstrumentBezel', 'Bezel', 'InstrumentPanel']);

function LocalBezel({ children, className, accent }: BezelProps) {
  const style = accent ? ({ ['--site-accent' as string]: accent } as Record<string, string>) : undefined;
  return (
    <section className={['instrument-bezel', className].filter(Boolean).join(' ')} style={style}>
      {children}
    </section>
  );
}

/**
 * 面板容器：优先 instrument-ui，缺失时用本地实现。
 * `source` 供页面显示当前走的是哪条路（诚实标注，便于联调时一眼看出）。
 */
export function Bezel(props: BezelProps) {
  if (LibraryBezel) return <LibraryBezel {...props} />;
  return <LocalBezel {...props} />;
}

export const bezelSource: 'instrument-ui' | 'local' = LibraryBezel ? 'instrument-ui' : 'local';
