/**
 * 三份冻结契约的 zod 校验器与类型。
 *
 * 每份契约单一模块，唯一事实源是 `specs/contracts/*.schema.json`。
 * 共用原语集中在 `./primitives.ts`，避免三处各写一遍导致漂移。
 */
export * from './primitives.js';
export * from './wormhole-envelope.js';
export * from './dispatch-contract.js';
export * from './matrix-app-manifest.js';
