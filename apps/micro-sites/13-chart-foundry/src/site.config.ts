/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：13 Nature 级出版图表熔炉
 * 轨道：轨道 5 · 工坊 · 域名：chart-foundry.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=13 --force
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
  id: "13",
  name: "Nature 级出版图表熔炉",
  domain: "chart-foundry.matrixos.cc.cd",
  appId: "chart-foundry",
  dirName: "13-chart-foundry",
  orbitIndex: 5,
  orbitKey: "workshop",
  orbitName: "轨道 5 · 工坊",
  accent: "#10b981",
  uiStyle: "光学暗房调色台",
  ledger: "TikZ / Matplotlib 出版级绘图脚本库",
  desc: "一键将拟合数据转换为符合 Nature / IEEE 双栏字号与色盲友好规范的矢量图。",
  source: "ScholarMatrix 拆解",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
