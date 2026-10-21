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
