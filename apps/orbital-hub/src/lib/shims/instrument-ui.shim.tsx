/**
 * 本地 shim：仅在 @matrixos/instrument-ui 尚未发布/未安装时被 next.config.ts 别名到这里。
 *
 * 故意**不导出** StarOrbit / CopilotWaveDock / WormholeRing ——
 * 于是 hub 的组件解析器（instrument-adapter.tsx）解析不到，就会回退到内置实现。
 * 这样"库就位"与"库未就位"两条路走同一套调用点，源码不用改。
 */

export const __matrixosShim = true;

export const INSTRUMENT_UI_SHIM_REASON =
  'workspace 包 @matrixos/instrument-ui 尚未就位：hub 使用内置同签名实现（视觉 token 一致）。';

/** 候选组件名探测表：留空 = 库里什么都还没提供。 */
export const __availableComponents: readonly string[] = [];
