/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：15 撤稿深海声呐与伦理合规仪
 * 轨道：轨道 5 · 工坊 · 域名：retract-radar.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=15 --force
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
  id: "15",
  name: "撤稿深海声呐与伦理合规仪",
  domain: "retract-radar.matrixos.edu",
  appId: "retract-radar",
  dirName: "15-retract-radar",
  orbitIndex: 5,
  orbitKey: "workshop",
  orbitName: "轨道 5 · 工坊",
  accent: "#10b981",
  uiStyle: "360° 极坐标声呐盘",
  ledger: "论文引文合规体检报告与伦理声明",
  desc: "对接 Crossref 与 PubPeer 排查撤稿与勘误引文，自动生成顶刊 AI 使用披露声明。",
  source: "ScholarMatrix 拆解",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
