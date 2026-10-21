/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：11 CurveLab 非线性拟合示波器
 * 轨道：轨道 5 · 工坊 · 域名：curvelab.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=11 --force
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
  id: "11",
  name: "CurveLab 非线性拟合示波器",
  domain: "curvelab.matrixos.cc.cd",
  appId: "curvelab",
  dirName: "11-curvelab-fit",
  orbitIndex: 5,
  orbitKey: "workshop",
  orbitName: "轨道 5 · 工坊",
  accent: "#10b981",
  uiStyle: "荧光示波器与阻尼旋钮",
  ledger: "实验原始数据集与 30+ 回归模型库",
  desc: "内置双指数衰减、洛伦兹峰拟合等 30+ 统计模型，实时显示置信带与 R²。",
  source: "ScholarMatrix 核心",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
