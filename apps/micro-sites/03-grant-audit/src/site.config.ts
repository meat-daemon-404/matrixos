/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：03 大创五科目经费液位仪
 * 轨道：轨道 2 · 星火 · 域名：grant-audit.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=03 --force
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
  id: "03",
  name: "大创五科目经费液位仪",
  domain: "grant-audit.matrixos.edu",
  appId: "grant-audit",
  dirName: "03-grant-audit",
  orbitIndex: 2,
  orbitKey: "spark",
  orbitName: "轨道 2 · 星火",
  accent: "#8b5cf6",
  uiStyle: "五柱流体压差计",
  ledger: "国创 ¥20,000 报销凭据与红线台账",
  desc: "内置劳务费 ≤20% 硬件限位阀，实时监控算力、软著、差旅报销进度。",
  source: "MatrixOS 原创",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
