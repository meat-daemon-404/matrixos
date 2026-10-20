/**
 * `@matrixos/sdk` · MatrixOS 开放插槽协议 SDK
 *
 * 18 个官方旗舰微站与第三方高校实验室微站的**唯一生态入口**（架构公理 A5）。
 *
 * ## 三分钟上手
 *
 * ```ts
 * import { getMatrixSDK } from '@matrixos/sdk';
 *
 * const sdk = getMatrixSDK({ appId: 'curvelab' });
 * const session = await sdk.initSSO();
 *
 * if (session.state !== 'authenticated') {
 *   // 降级提示必须显式可见（ADR-09）。hint.actions 是给用户的具体指引。
 *   showBanner(session.hint?.message, session.hint?.actions);
 * }
 * ```
 *
 * ## 六个核心 API
 *
 * | API | 作用 | 关键约束 |
 * | :--- | :--- | :--- |
 * | `initSSO(options)` | MatrixID 单点登录 | 双通道：非 iframe 走域级 Cookie，iframe 走 `mx_idt` 一次性交换 |
 * | `emitAsset(asset)` | 沉淀到云衡综测资产图谱 | 证据锚点非空（合规红线） |
 * | `onWormholeDrop(handler)` | 注册跨站拖拽接收器 | 只接收 manifest `accepts` 声明过的类型 |
 * | `sendWormhole(target, type, payload)` | 主动投送 | payload 走内存 + `postMessage`，**不经服务端** |
 * | `getManifest()` / `validateManifest(json)` | 插槽清单读写校验 | 契约冻结，`additionalProperties: false` |
 * | `assets.*` | `/v1/assets` CRUD + 搜索 | 自动 CSRF 注入、重试、超时、熔断 |
 *
 * ## 本包的设计约束
 *
 * - **零运行时依赖**：18 个微站 + 第三方站都会 import 它，不能带 zod/ajv 进它们的包体；
 * - **零 UI**：视觉组件在 `packages/instrument-ui`，本包只出协议与状态；
 * - **不修改 `@matrixos/twin-schema`**：镜像类型 + 契约一致性测试防漂移（见 `contracts/types.ts`）。
 *
 * @see specs/contracts/matrix-app-manifest.schema.json
 * @see specs/contracts/wormhole-envelope.schema.json
 * @see docs/01-plan/01-architecture.md
 * @see docs/01-plan/04-tech-decisions.md ADR-03 / ADR-08
 */

// ─────────────────────────────────────────────────────────────────────────────
// 根 API
// ─────────────────────────────────────────────────────────────────────────────

export { createMatrixSDK, getMatrixSDK, resetMatrixSDKSingleton, issueIdtForTenant } from './sdk.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type {
  // 契约（镜像自 specs/contracts/）
  MatrixAppManifest,
  MatrixAppManifestInput,
  OrbitStation,
  ManifestPayloadType,
  ManifestPermission,
  PayloadType,
  Permission,
  LiveMiniView,
  ManifestAuthor,
  MatrixAppAuthor,
  WormholeEnvelope,
  WormholeEnvelopeInput,
  WormholePayload,
  WormholePayloadType,
  EvidenceAnchor,
  VerificationLevel,
  AssetNode,
  AssetNodeInput,
  AssetType,
  // 运行环境
  RuntimeContext,
  RuntimeEnv,
  WindowLike,
  DocumentLike,
  MessageEventLike,
  MessageListener,
  StorageLike,
  FetchLike,
  ClockSource,
  // 鉴权
  MatrixUser,
  SSOTokenSet,
  SSOSession,
  SSOSessionState,
  SSODegradationHint,
  InitSSOOptions,
  SSOClient,
  // iframe 桥
  BridgeMessage,
  BridgeMeta,
  HostBridge,
  // 虫洞
  AppKey,
  WormholeReceipt,
  WormholeDropContext,
  WormholeDropHandler,
  SendWormholeOptions,
  OnWormholeDropOptions,
  WormholeDropRing,
  WormholeRingState,
  WormholeTarget,
  WormholeEnvelopeDraft,
  WormholeValidationResult,
  // 资产
  EmitAssetInput,
  AssetListQuery,
  AssetSearchQuery,
  AssetSearchHit,
  Paginated,
  AssetClient,
  // HTTP
  RetryPolicy,
  CircuitBreakerConfig,
  HttpClientOptions,
  MatrixRequestOptions,
  // 错误
  MatrixErrorCode,
  MatrixErrorBody,
  // 汇总
  MatrixSDKOptions,
  MatrixSDK,
  ManifestValidationResult,
  ManifestIssue,
  ManifestValidator,
} from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────────────────────

export {
  MatrixError,
  AuthExpiredError,
  OriginRejectedError,
  IdtExchangeError,
  CircuitOpenError,
  UnsupportedPayloadError,
  redactSecrets,
} from './errors.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 契约常量与校验
// ─────────────────────────────────────────────────────────────────────────────

export {
  ORBIT_STATIONS,
  MANIFEST_PAYLOAD_TYPES,
  MANIFEST_PERMISSIONS,
  VERIFICATION_LEVELS,
} from './contracts/types.ts';

export {
  MATRIX_APP_MANIFEST_SCHEMA,
  WORMHOLE_ENVELOPE_SCHEMA,
  FROZEN_SCHEMAS,
} from './contracts/schemas.ts';

export type { JsonSchemaDocument, JsonSchemaNode, FrozenSchemaName } from './contracts/schemas.ts';

export { validateAgainstSchema, toFieldPath, deepEqual } from './contracts/validate.ts';
export type { ValidationIssue } from './contracts/validate.ts';

// ─────────────────────────────────────────────────────────────────────────────
// manifest
// ─────────────────────────────────────────────────────────────────────────────

export { validateManifest, formatManifestIssues, validateManifestSemantics } from './manifest/validate.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 虫洞（P2P）
// ─────────────────────────────────────────────────────────────────────────────

export {
  WormholeTransport,
  registerWormholeReceiver,
  createWormholeDropRing,
  isLargePayload,
  toAssetRef,
  estimatePayloadBytes,
  digestOf,
  LARGE_PAYLOAD_THRESHOLD_BYTES,
} from './wormhole/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 鉴权
// ─────────────────────────────────────────────────────────────────────────────

export { IdtExchanger, parseExchangeResponse } from './auth/idt.ts';
export type { IdtExchangeOptions } from './auth/idt.ts';
export { SSOClientImpl, isAuthenticated } from './auth/sso.ts';
export type { SSOClientInit } from './auth/sso.ts';

// ─────────────────────────────────────────────────────────────────────────────
// iframe 桥
// ─────────────────────────────────────────────────────────────────────────────

export { createHostBridge, BRIDGE_CAPABILITIES, BRIDGE_CHANNEL, BRIDGE_PROTOCOL_VERSION, BRIDGE_MSG, describeOriginRejection } from './iframe/bridge.ts';
export type { BridgeCapability, HostBridgeOptions } from './iframe/bridge.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 安全
// ─────────────────────────────────────────────────────────────────────────────

export {
  OriginAllowList,
  DEFAULT_ALLOWED_ORIGINS,
  parseOrigin,
  normalizeAppKey,
  toAppHost,
  isSameApp,
} from './security/origin.ts';
export type { ParsedOrigin } from './security/origin.ts';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

export { MatrixHttpClient, CircuitBreaker } from './http/client.ts';
export type { MatrixHttpClientInit, RequestTrace } from './http/client.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 资产
// ─────────────────────────────────────────────────────────────────────────────

export { AssetClientImpl, inferVerificationLevel } from './assets/client.ts';
export type { AssetClientInit } from './assets/client.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 运行时
// ─────────────────────────────────────────────────────────────────────────────

export {
  createRuntimeEnv,
  detectRuntimeContext,
  resolveSessionStorage,
  MemoryStorage,
  readCookie,
} from './runtime/env.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 版本
// ─────────────────────────────────────────────────────────────────────────────

/** SDK 版本。与 `package.json` 的 `version` 保持同步（有测试断言）。 */
export const SDK_VERSION = '0.1.0';

/** 实现所对齐的契约版本（`manifest_version: "1.0"`）。 */
export const CONTRACT_VERSION = '1.0';
