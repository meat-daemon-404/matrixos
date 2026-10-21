/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：02 双创互补组队雷达
 * 轨道：轨道 2 · 星火 · 域名：spark.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=02 --force
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
  id: "02",
  name: "双创互补组队雷达",
  domain: "spark.matrixos.cc.cd",
  appId: "spark",
  dirName: "02-spark-teaming",
  orbitIndex: 2,
  orbitKey: "spark",
  orbitName: "轨道 2 · 星火",
  accent: "#8b5cf6",
  uiStyle: "技能极坐标互补盘",
  ledger: "大创/挑战杯组队契约与分工表",
  desc: "匹配跨院系（硬件+算法+商业）互补队友并自动生成大创申报书初稿。",
  source: "ScholarMatrix 拆解",
} as const;

/** 站内绝对 URL 助手：嵌入模式（iframe）与独立模式共用同一套路径。 */
export function sitePath(path: string): string {
  const base = 'https://' + SITE.domain;
  if (!path) return base;
  return base + (path.startsWith('/') ? path : '/' + path);
}
