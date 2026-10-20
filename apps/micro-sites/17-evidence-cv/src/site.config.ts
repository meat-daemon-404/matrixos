/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：17 区块链级学术证据简历工坊
 * 轨道：轨道 7 · 预职 · 域名：evidence-cv.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=17 --force
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
  id: "17",
  name: "区块链级学术证据简历工坊",
  domain: "evidence-cv.matrixos.edu",
  appId: "evidence-cv",
  dirName: "17-evidence-cv",
  orbitIndex: 7,
  orbitKey: "pre_job",
  orbitName: "轨道 7 · 预职",
  accent: "#f43f5e",
  uiStyle: "绿标验真数字徽章台",
  ledger: "多版本保研/求职证据级简历库",
  desc: "简历中每一条科研经历均嵌入可点击验真的 DOI 锚点、拟合图与代码仓库哈希。",
  source: "预职 WorkBuddy 原型",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
