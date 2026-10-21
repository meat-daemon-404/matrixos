/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：01 学分绩点动态配重台
 * 轨道：轨道 1 · 学阶 · 域名：gpa.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=01 --force
 */
/**
 * 本地 shim：仅在 @matrixos/instrument-ui 尚未发布/未安装时被 next.config.ts 别名到这里。
 * 故意**不导出**任何组件 —— instrument-facade 解析不到就会回退到本地实现。
 */
export const __matrixosShim = true;

/** 与真实库同形的候选导出名探测用表；留空表示"什么都还没提供"。 */
export const __availableComponents: readonly string[] = [];
