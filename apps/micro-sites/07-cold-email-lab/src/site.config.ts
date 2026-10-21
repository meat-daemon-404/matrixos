/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：07 证据内嵌式套磁信推演器
 * 轨道：轨道 4 · 星门 · 域名：cold-email.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=07 --force
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
  id: "07",
  name: "证据内嵌式套磁信推演器",
  domain: "cold-email.matrixos.cc.cd",
  appId: "cold-email",
  dirName: "07-cold-email-lab",
  orbitIndex: 4,
  orbitKey: "xingmen",
  orbitName: "轨道 4 · 星门",
  accent: "#06b6d4",
  uiStyle: "双栏红蓝对抗推演器",
  ledger: "多版本套磁信草稿与导师审阅评分",
  desc: "结合导师最新代表作与学生复现实验数据，生成高回复率个性化套磁信。",
  source: "星门 实机原型",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
