/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：14 综述拓扑推演与写作舱
 * 轨道：轨道 5 · 工坊 · 域名：review-lab.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=14 --force
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
  id: "14",
  name: "综述拓扑推演与写作舱",
  domain: "review-lab.matrixos.cc.cd",
  appId: "review-lab",
  dirName: "14-review-architect",
  orbitIndex: 5,
  orbitKey: "workshop",
  orbitName: "轨道 5 · 工坊",
  accent: "#10b981",
  uiStyle: "章节逻辑流建筑台",
  ledger: "文献综述大纲与段落证据绑定库",
  desc: "将对比矩阵中的多篇文献按技术流派自动聚类，生成带精准引文的综述初稿。",
  source: "ScholarMatrix 拆解",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
