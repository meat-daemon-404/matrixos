/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：08 太空任务式进组跟进台账
 * 轨道：轨道 4 · 星门 · 域名：lab-kanban.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=08 --force
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
  id: "08",
  name: "太空任务式进组跟进台账",
  domain: "lab-kanban.matrixos.cc.cd",
  appId: "lab-kanban",
  dirName: "08-lab-kanban",
  orbitIndex: 4,
  orbitKey: "xingmen",
  orbitName: "轨道 4 · 星门",
  accent: "#06b6d4",
  uiStyle: "航天任务控制看板",
  ledger: "已发信→已读→待面试→已进组状态机",
  desc: "全周期追踪套磁与暑研面试节点，支持一键同步至手机端强提醒。",
  source: "星门 实机原型",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
