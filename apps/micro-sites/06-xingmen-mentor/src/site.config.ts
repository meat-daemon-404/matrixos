/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：06 星门 · 导师五维星象仪
 * 轨道：轨道 4 · 星门 · 域名：mentor.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=06 --force
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
  id: "06",
  name: "星门 · 导师五维星象仪",
  domain: "mentor.matrixos.cc.cd",
  appId: "mentor",
  dirName: "06-xingmen-mentor",
  orbitIndex: 4,
  orbitKey: "xingmen",
  orbitName: "轨道 4 · 星门",
  accent: "#06b6d4",
  uiStyle: "天文星象五维雷达",
  ledger: "目标博导/硕导全景学术画像库",
  desc: "量化分析导师近 3 年活跃度、H-index 斜率、经费充足度与本科生友好度。",
  source: "星门 实机原型",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
