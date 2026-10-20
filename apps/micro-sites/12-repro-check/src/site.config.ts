/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：12 顶刊代码复现核验舱
 * 轨道：轨道 5 · 工坊 · 域名：repro-check.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=12 --force
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
  id: "12",
  name: "顶刊代码复现核验舱",
  domain: "repro-check.matrixos.edu",
  appId: "repro-check",
  dirName: "12-repro-check",
  orbitIndex: 5,
  orbitKey: "workshop",
  orbitName: "轨道 5 · 工坊",
  accent: "#10b981",
  uiStyle: "飞行前机械检查单",
  ledger: "依赖环境、随机种子与超参复现清单",
  desc: "自动扫描论文关联 GitHub 仓库，生成 Docker 环境配置与复现避坑指南。",
  source: "ScholarMatrix 拆解",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
