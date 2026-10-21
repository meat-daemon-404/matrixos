/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：05 五源跨库引文声呐站
 * 轨道：轨道 3 · 情报 · 域名：lit-sonar.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=05 --force
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
  id: "05",
  name: "五源跨库引文声呐站",
  domain: "lit-sonar.matrixos.cc.cd",
  appId: "lit-sonar",
  dirName: "05-lit-sonar",
  orbitIndex: 3,
  orbitKey: "pat_hot",
  orbitName: "轨道 3 · 情报",
  accent: "#f59e0b",
  uiStyle: "引力透镜拓扑图",
  ledger: "课题组专题文献收藏夹与引文树",
  desc: "聚合 OpenAlex/arXiv/PubMed/Crossref，可视化呈现开山鼻祖与最新演进。",
  source: "ScholarMatrix 拆解",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
