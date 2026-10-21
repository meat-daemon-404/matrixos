/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：01 学分绩点动态配重台
 * 轨道：轨道 1 · 学阶 · 域名：gpa.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=01 --force
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
  id: "01",
  name: "学分绩点动态配重台",
  domain: "gpa.matrixos.cc.cd",
  appId: "gpa",
  dirName: "01-gpa-sandbox",
  orbitIndex: 1,
  orbitKey: "study",
  orbitName: "轨道 1 · 学阶",
  accent: "#6366f1",
  uiStyle: "精密推子配重仪",
  ledger: "学期目标绩点与选课博弈方案库",
  desc: "拖动推子模拟不同选修课成绩对保研/出国核心 GPA 的边际贡献。",
  source: "ScholarMatrix 拆解",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
