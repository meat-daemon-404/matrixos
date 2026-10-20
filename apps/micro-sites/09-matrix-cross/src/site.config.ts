/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：09 Matrix-Cross 跨论文对比矩阵
 * 轨道：轨道 5 · 工坊 · 域名：matrix-cross.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=09 --force
 */
export interface SiteIdentity {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly appId: string;
  readonly dirName: string;
  readonly orbitIndex: number;
  readonly orbitKey: string;
  readonly orbitName: string;
  readonly accent: string;
  readonly uiStyle: string;
  readonly ledger: string;
  readonly desc: string;
  readonly source: string;
}

/**
 * 该站的身份卡。字段全部来自 specs/microsites.json（唯一事实源），
 * 不要在这里手改——要改就改花名册，然后重跑生成器。
 */
export const SITE: SiteIdentity = {
  id: "09",
  name: "Matrix-Cross 跨论文对比矩阵",
  domain: "matrix-cross.matrixos.edu",
  appId: "matrix-cross",
  dirName: "09-matrix-cross",
  orbitIndex: 5,
  orbitKey: "workshop",
  orbitName: "轨道 5 · 工坊",
  accent: "#10b981",
  uiStyle: "激光溯源对比网格",
  ledger: "多篇顶刊核心实验参量横向对比表",
  desc: "自动抽取多篇 PDF 的材料、方法与性能指标，悬停单元格激射 PDF 原文坐标。",
  source: "ScholarMatrix 核心",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
