/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：04 PAT-HOT 学科脉冲雷达
 * 轨道：轨道 3 · 情报 · 域名：pat-hot.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=04 --force
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
  id: "04",
  name: "PAT-HOT 学科脉冲雷达",
  domain: "pat-hot.matrixos.cc.cd",
  appId: "pat-hot",
  dirName: "04-pat-radar",
  orbitIndex: 3,
  orbitKey: "pat_hot",
  orbitName: "轨道 3 · 情报",
  accent: "#f59e0b",
  uiStyle: "24h 频谱瀑布流",
  ledger: "订阅学科关键词与早报历史库",
  desc: "监听 arXiv / Nature Photonics 24h 前沿动态，每日 08:00 推送三卡早报。",
  source: "PAT-HOT 实机原型",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
