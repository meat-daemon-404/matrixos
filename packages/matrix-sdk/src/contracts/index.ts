/**
 * MatrixOS SDK · 契约层公共出口
 */

export { MATRIX_APP_MANIFEST_SCHEMA, WORMHOLE_ENVELOPE_SCHEMA, FROZEN_SCHEMAS } from './schemas.ts';
export type { JsonSchemaDocument, JsonSchemaNode, FrozenSchemaName } from './schemas.ts';

export { validateAgainstSchema, formatIssues, toFieldPath, deepEqual } from './validate.ts';
export type { ValidationIssue } from './validate.ts';

export {
  ORBIT_STATIONS,
  MANIFEST_PAYLOAD_TYPES,
  MANIFEST_PERMISSIONS,
  VERIFICATION_LEVELS,
} from './types.ts';

export type {
  MatrixAppManifest,
  MatrixAppManifestInput,
  OrbitStation,
  ManifestPayloadType,
  ManifestPermission,
  LiveMiniView,
  ManifestAuthor,
  WormholeEnvelope,
  WormholeEnvelopeInput,
  WormholePayload,
  WormholePayloadType,
  EvidenceAnchor,
  VerificationLevel,
  AssetNode,
  AssetNodeInput,
  AssetType,
} from './types.ts';
