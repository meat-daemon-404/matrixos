/**
 * 本地 shim：仅在 @matrixos/sdk 尚未发布/未安装时被 next.config.ts 别名到这里。
 *
 * 它**不实现任何真实能力**：不登录、不签发 mx_idt、不投递虫洞。
 * 只负责让 hub 能编译能跑，并把「未就位」这个事实通过 __matrixosShim 暴露给 facade，
 * 由 UI 显式标注 —— 绝不伪造登录态或投递成功。
 */

export const __matrixosShim = true;

export const SDK_SHIM_REASON =
  'workspace 包 @matrixos/sdk 尚未就位：hub 侧的 SSO / mx_idt 交换 / 虫洞收据均未接通。';

export interface ShimSSOResult {
  readonly matrix_uid: string | null;
  readonly display_name: string | null;
  readonly embedded: boolean;
  readonly detail: string;
}

/** 返回未登录态，不抛错 —— 让 hub 走"未就位"分支而不是崩掉。 */
export async function initSSO(options?: { embedded?: boolean }): Promise<ShimSSOResult> {
  return {
    matrix_uid: null,
    display_name: null,
    embedded: options?.embedded ?? false,
    detail: SDK_SHIM_REASON,
  };
}

/** 无操作订阅器，返回取消函数（保持与真实 SDK 同形）。 */
export function onWormholeDrop(_handler: (envelope: unknown) => void): () => void {
  return () => {};
}

/** 无操作投送：真实实现会先本地 ajv 校验 envelope 再 POST /v1/wormhole/receipt。 */
export function sendWormhole(
  _targetApp: string,
  _payloadType: string,
  _payload: unknown,
): { ok: false; reason: string } {
  return { ok: false, reason: SDK_SHIM_REASON };
}
