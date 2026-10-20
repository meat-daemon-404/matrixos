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

import { MATRIX_APP_MANIFEST_SCHEMA } from './schemas.ts';
import { validateAgainstSchema } from './validate.ts';
import type { ManifestValidationResult, MatrixAppManifest } from '../types.ts';

/** 兼容 `wormhole/index.ts` 的调用点：只做 schema 结构校验（不做语义规则）。 */
export function validateManifestSchema(json: unknown): ManifestValidationResult {
  const issues = validateAgainstSchema(json, MATRIX_APP_MANIFEST_SCHEMA);
  return {
    valid: issues.length === 0,
    manifest: issues.length === 0 ? (json as MatrixAppManifest) : null,
    errors: issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      keyword: issue.keyword,
      severity: 'error' as const,
    })),
  };
}
