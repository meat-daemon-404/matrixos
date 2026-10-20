/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：18 生涯多重宇宙期望决策树
 * 轨道：轨道 7 · 预职 · 域名：prejob.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=18 --force
 */
/**
 * 本地 shim：仅在 @matrixos/sdk 尚未发布/未安装时被 next.config.ts 别名到这里。
 * 它**不实现任何真实能力**（不登录、不投递），只让骨架能编译能跑，
 * 并把「未就位」这个事实通过 __matrixosShim 标记暴露给 facade。
 */
export const __matrixosShim = true;

export const SDK_SHIM_REASON =
  'workspace 包 ' + "@matrixos/sdk" + ' 尚未就位：本 shim 不提供 SSO、不提供虫洞投递。';
