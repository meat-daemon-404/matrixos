/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：16 云衡 · 数字天平综测核算器
 * 轨道：轨道 6 · 云衡 · 域名：yunheng.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=16 --force
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
  id: "16",
  name: "云衡 · 数字天平综测核算器",
  domain: "yunheng.matrixos.cc.cd",
  appId: "yunheng",
  dirName: "16-yunheng-scale",
  orbitIndex: 6,
  orbitKey: "cloud_balance",
  orbitName: "轨道 6 · 云衡",
  accent: "#22d3ee",
  uiStyle: "精密三盘电子天平",
  ledger: "学年综测加分项与证明材料 PDF 包",
  desc: "自动汇总科研论文、软著与竞赛记录，按高校综测细则满额配重并导出申报表。",
  source: "预职 & ScholarMatrix",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
