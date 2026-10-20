/**
 * 虫洞子入口。
 *
 * 只导出虫洞相关面：信封 schema、证据锚点、合规辅助函数。
 * 微站只需要虫洞时从 `@matrixos/twin-schema/wormhole` 引，不会把
 * dispatch / manifest / asset-graph 一起拽进包体（`sideEffects: false`）。
 */
export {
  wormholeEnvelopeSchema,
  wormholePayloadSchema,
  parseWormholeEnvelope,
  WORMHOLE_ENVELOPE_SCHEMA_ID,
  type WormholeEnvelope,
  type WormholePayload,
  type WormholeEnvelopeDraft,
} from '../contracts/wormhole-envelope.js';

export {
  evidenceAnchorSchema,
  payloadTypes,
  verificationLevels,
  worstVerificationLevel,
  VERIFICATION_SEVERITY,
  payloadTypeSchema,
  verificationLevelSchema,
  type EvidenceAnchor,
} from '../contracts/primitives.js';
