/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：10 PDF 公式与参量狙击镜
 * 轨道：轨道 5 · 工坊 · 域名：pdf-sniper.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=10 --force
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
  id: "10",
  name: "PDF 公式与参量狙击镜",
  domain: "pdf-sniper.matrixos.cc.cd",
  appId: "pdf-sniper",
  dirName: "10-pdf-sniper",
  orbitIndex: 5,
  orbitKey: "workshop",
  orbitName: "轨道 5 · 工坊",
  accent: "#10b981",
  uiStyle: "双栏光学瞄准阅读器",
  ledger: "高亮批注、公式符号表与难例卡片",
  desc: "点击文内复杂偏微分方程，右侧自动展开物理量纲解释与 Python 求解代码。",
  source: "ScholarMatrix 拆解",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
