/**
 * 虫洞信封本地校验（架构 §5.3 的三条强制规则，在 hub 层的实现）
 * =====================================================================
 *
 * 为什么不把这活留给服务端：
 * 矩阵核心只存收据（哈希 + 元数据），**不存 payload 正文**（W2）。所以
 * "这条数据能不能投"必须在客户端当场判定，服务端没有正文可校验。
 *
 * 三条规则的落点：
 *   W1 evidence_anchors.length >= 1 且每条含 source_doi_or_url + verification_level
 *      → 校验失败时环体变红并给出**具体哪一条不合格**，而不是笼统的"数据非法"。
 *   W2 数据不过服务端 → 本文件只处理"形状与证据"，不碰网络、不落盘。
 *   W3 只投给声明过的目标 → `canDispatch` 读目标站的 manifest accepts 列表。
 *
 * schema 来源：specs/contracts/wormhole-envelope.schema.json（已冻结，封闭枚举，
 * additionalProperties: false）。这里**镜像**它的约束而不是运行时读 JSON ——
 * 浏览器端读不到 specs/ 目录，且契约变更必须走 ADR-10 版本化流程，镜像漂移由
 * scripts/validate-specs.mjs 在 CI 侧守住字段语义。
 */

import type { PayloadType } from './microsites.generated';
import type { WormholeEnvelopeDraft } from './hub-types';

/** 与契约完全一致的 5 类 payload_type（封闭枚举，不得扩展） */
export const PAYLOAD_TYPES: readonly PayloadType[] = [
  'paper_doi_bundle',
  'comparison_matrix_row',
  'curve_fit_parameters',
  'mentor_match_card',
  'verified_cv_evidence',
];

/** 与契约完全一致的 3 档核验级别 */
export const VERIFICATION_LEVELS = [
  'Level_A_Verified',
  'Level_B_Preprint',
  'Retracted_Warning',
] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** payload_type 的中文短名，用于 UI（避免用户看到下划线枚举） */
export const PAYLOAD_TYPE_LABEL: Readonly<Record<PayloadType, string>> = {
  paper_doi_bundle: '论文 DOI 束',
  comparison_matrix_row: '对比矩阵行',
  curve_fit_parameters: '拟合参量',
  mentor_match_card: '导师匹配卡',
  verified_cv_evidence: '验真简历证据',
};

/** 核验级别对应的语义色（用于证据锚点徽标） */
export const VERIFICATION_TONE: Readonly<
  Record<VerificationLevel, 'ok' | 'warn' | 'danger'>
> = {
  Level_A_Verified: 'ok',
  Level_B_Preprint: 'warn',
  Retracted_Warning: 'danger',
};

export interface ValidationIssue {
  /** 违规的字段路径，如 'payload.evidence_anchors[0].source_doi_or_url' */
  readonly path: string;
  /** 规则编号，便于在 UI 上直说"违反了哪条" */
  readonly rule: 'W1' | 'W2' | 'W3' | 'schema';
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 宽松的 UUID v4 形状检查（jsdom / 老浏览器没有 crypto.randomUUID 时也能校验） */
function looksLikeUuid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * 校验虫洞信封。
 *
 * 注意：**不做** payload_type 与目标站 accepts 的匹配检查 —— 那是 `canDispatch` 的职责，
 * 因为"信封本身合法"与"这封信能投给这家"是两个独立的判断。
 */
export function validateEnvelope(envelope: WormholeEnvelopeDraft): ValidationResult {
  const issues: ValidationIssue[] = [];

  // ── 顶层必填（契约 required: trace_id, matrix_uid, source_app, target_app, payload_type, payload）
  if (!looksLikeUuid(envelope.trace_id)) {
    issues.push({ path: 'trace_id', rule: 'schema', message: 'trace_id 必须是 UUID' });
  }
  if (!isNonEmptyString(envelope.matrix_uid)) {
    issues.push({ path: 'matrix_uid', rule: 'schema', message: 'matrix_uid 不能为空' });
  }
  if (!isNonEmptyString(envelope.source_app)) {
    issues.push({ path: 'source_app', rule: 'schema', message: 'source_app 不能为空' });
  }
  if (!isNonEmptyString(envelope.target_app)) {
    issues.push({ path: 'target_app', rule: 'schema', message: 'target_app 不能为空' });
  }
  if (!PAYLOAD_TYPES.includes(envelope.payload_type)) {
    issues.push({
      path: 'payload_type',
      rule: 'schema',
      message: 'payload_type 不在契约的 5 类封闭枚举内：' + String(envelope.payload_type),
    });
  }

  // ── W1 证据不可为空（合规红线）
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object') {
    issues.push({ path: 'payload', rule: 'W1', message: '缺少 payload' });
    return { ok: false, issues };
  }

  if (!payload.data || typeof payload.data !== 'object') {
    issues.push({ path: 'payload.data', rule: 'schema', message: 'payload.data 必须是对象' });
  }

  const anchors = payload.evidence_anchors;
  if (!Array.isArray(anchors) || anchors.length === 0) {
    issues.push({
      path: 'payload.evidence_anchors',
      rule: 'W1',
      message: '证据锚点为空。契约要求 minItems: 1 —— 没有证据的数据不允许投送。',
    });
  } else {
    anchors.forEach((anchor, index) => {
      const prefix = 'payload.evidence_anchors[' + index + ']';
      if (!isNonEmptyString(anchor.source_doi_or_url)) {
        issues.push({
          path: prefix + '.source_doi_or_url',
          rule: 'W1',
          message: '第 ' + (index + 1) + ' 条证据缺少 source_doi_or_url（DOI 或原文 URL）',
        });
      }
      if (!VERIFICATION_LEVELS.includes(anchor.verification_level)) {
        issues.push({
          path: prefix + '.verification_level',
          rule: 'W1',
          message: '第 ' + (index + 1) + ' 条证据的 verification_level 不合法',
        });
      }
      if (anchor.pdf_page !== undefined && (!Number.isInteger(anchor.pdf_page) || anchor.pdf_page < 1)) {
        issues.push({
          path: prefix + '.pdf_page',
          rule: 'schema',
          message: '第 ' + (index + 1) + ' 条证据的 pdf_page 必须是 ≥1 的整数',
        });
      }
      if (anchor.bbox !== undefined && (!Array.isArray(anchor.bbox) || anchor.bbox.length !== 4)) {
        issues.push({
          path: prefix + '.bbox',
          rule: 'schema',
          message: '第 ' + (index + 1) + ' 条证据的 bbox 必须是 4 个数字',
        });
      }
    });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * W3：只投给声明过的目标。
 *
 * @param payloadType 本次要投的类型
 * @param accepts     目标站 manifest 里声明的 accepts 列表
 */
export function canDispatch(
  payloadType: PayloadType,
  accepts: readonly PayloadType[],
): boolean {
  return accepts.includes(payloadType);
}

/**
 * 生成一个 v4 UUID。
 * 优先 crypto.randomUUID（安全上下文 + 现代浏览器）；
 * 退路是 crypto.getRandomValues 手拼 —— 不用 Math.random，
 * 因为 trace_id 会被落进审计日志，弱随机会有碰撞与可预测性问题。
 */
export function createTraceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // RFC 4122 v4 的两个标志位
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  }

  // 极端退路：不假装是合格 UUID，直接抛错让调用方知道环境不对
  throw new Error('当前环境缺少 crypto，无法生成合法的 trace_id');
}
