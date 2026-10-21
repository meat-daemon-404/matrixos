/**
 * ⚠️ 由 scripts/wire-workbench.mjs 从 apps/micro-sites/shared/templates/ 分发，请勿直接修改本文件。
 * 模板：apps/micro-sites/shared/templates/matrix-sdk.shim.ts
 * 作用：SDK 未就位时的编译占位（不提供任何真实能力）
 * 站点：05 五源跨库引文声呐站
 * 轨道：轨道 3 · 情报 · 域名：lit-sonar.matrixos.edu
 * 改法：改模板 → 跑 `node scripts/wire-workbench.mjs` 重新分发（18 站会一起更新）。
 */
/**
 * 本地 shim：仅在 @matrixos/sdk 尚未发布/未安装时被 next.config.ts 别名到这里。
 * 它**不实现任何真实能力**（不登录、不投递），只让骨架能编译能跑，
 * 并把「未就位」这个事实通过 __matrixosShim 标记暴露给 facade。
 *
 * 注意：facade 会先看 `__matrixosShim`，是 shim 就直接报「未就位」，
 * 不会走到下面这些抛错的桩函数。桩函数存在的意义只是**保持模块形状一致**，
 * 避免别处 import 时报「没有导出成员」。
 */
export const __matrixosShim = true;

export const SDK_SHIM_REASON =
  'workspace 包 @matrixos/sdk 尚未就位：本 shim 不提供 SSO、不提供虫洞投递。';

export function getMatrixSDK(): never {
  throw new Error(SDK_SHIM_REASON);
}

export function createMatrixSDK(): never {
  throw new Error(SDK_SHIM_REASON);
}

export function resetMatrixSDKSingleton(): void {
  /* shim 无单例可重置 */
}
