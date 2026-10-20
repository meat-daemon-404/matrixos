/**
 * MatrixOS SDK · 契约类型的运行时中立镜像
 *
 * ## 为什么这里有一份「副本」
 *
 * `specs/contracts/*.schema.json` 是唯一契约源（架构 §2、A2）。`@matrixos/twin-schema`
 * 负责把它们转译成 TS 类型 + 运行时校验器。
 *
 * 但 `@matrixos/sdk` 被 18 个微站 + 第三方站 import，**不能**在 S1 阶段硬依赖
 * `@matrixos/twin-schema`：
 *   1. 该包尚未发布，任何解析路径问题会连带炸掉 18 个站的构建；
 *   2. 会让 SDK 从「零运行时依赖」变成「带一个校验器依赖链」，
 *      18 个微站打包体积与冲突面全部上升。
 *
 * 因此 SDK 采用**结构化镜像 + 契约一致性测试**：
 *   - 本文件是冻结契约的镜像类型（字段级一一对应）；
 *   - `src/contracts/schemas.ts` 内嵌契约 JSON 原文，校验器**由 schema 驱动**，
 *     不是手写第二套规则；
 *   - `test/contracts.conformance.test.ts` 直接读 `specs/contracts/*.schema.json`，
 *     与内嵌副本做深度相等断言。**契约一改，SDK 测试立刻红**，不会静默漂移。
 *
 * TS 是结构化类型，所以消费方把 `@matrixos/twin-schema` 的 `WormholeEnvelope`
 * 交给 `sendWormhole()` 依然类型兼容——两边结构等价即可。
 * 待 twin-schema 稳定（S2）后，本文件可整体替换为 re-export，调用方无感。
 *
 * @see specs/contracts/matrix-app-manifest.schema.json
 * @see specs/contracts/wormhole-envelope.schema.json
 * @see docs/01-plan/01-architecture.md §5（虫洞契约）、§6.2（asset_node）
 */

// ─────────────────────────────────────────────────────────────────────────────
// manifest：星轨插槽清单
// ─────────────────────────────────────────────────────────────────────────────

/** 7 站生涯闭环节点。与 `matrix-app-manifest` / `dispatch-contract` 的枚举一致。 */
export type OrbitStation = 'study' | 'spark' | 'pat_hot' | 'xingmen' | 'workshop' | 'cloud_balance' | 'pre_job';

/** 虫洞 payload 的 5 类封闭枚举。**不得擅自扩展**（架构 §5.1）。 */
export type ManifestPayloadType =
  | 'paper_doi_bundle'
  | 'comparison_matrix_row'
  | 'curve_fit_parameters'
  | 'mentor_match_card'
  | 'verified_cv_evidence';

/** 第三方站可申请的 MatrixID 授权范围。 */
export type ManifestPermission =
  | 'matrix_id:read'
  | 'profile:read'
  | 'assets:read'
  | 'assets:write'
  | 'wormhole:send'
  | 'wormhole:receive';

export interface LiveMiniView {
  readonly endpoint: string;
  readonly refresh_seconds?: number;
  readonly display_field?: string;
}

export interface ManifestAuthor {
  readonly lab_name?: string;
  readonly university?: string;
  readonly contact_email?: string;
}

/**
 * 第三方课题组微站接入星轨的标准插槽声明。
 * 对应 `specs/contracts/matrix-app-manifest.schema.json`。
 */
export interface MatrixAppManifest {
  readonly manifest_version: '1.0';
  /** 全局唯一微站标识，用作子域名前缀。`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` */
  readonly app_id: string;
  /** 微站中文名称（≤40 字），显示在星轨胶囊上。 */
  readonly name: string;
  /** 独立子域名入口，如 `https://bioscan.matrixos.edu`。 */
  readonly entry_url: string;
  readonly orbit_station: OrbitStation;
  readonly icon?: string;
  /** `^#[0-9a-fA-F]{6}$` */
  readonly accent_color?: string;
  /** 可接收的虫洞 payload_type；空数组表示不接收投送。 */
  readonly accepts: readonly ManifestPayloadType[];
  /** 可向外投送的 payload_type；空数组表示纯接收端。 */
  readonly emits: readonly ManifestPayloadType[];
  readonly live_mini_view?: LiveMiniView;
  readonly permissions?: readonly ManifestPermission[];
  readonly author?: ManifestAuthor;
}

/** 构造期的宽松入参：`manifest_version` 与 `app_id` 可由 SDK 补齐。 */
export type MatrixAppManifestInput = Omit<MatrixAppManifest, 'manifest_version'> & {
  readonly manifest_version?: '1.0';
};

// ─────────────────────────────────────────────────────────────────────────────
// wormhole：跨站投送信封
// ─────────────────────────────────────────────────────────────────────────────

export type WormholePayloadType = ManifestPayloadType;

/**
 * 证据锚点。**合规红线**：`source_doi_or_url` 与 `verification_level` 必填，
 * 且整个 `evidence_anchors` 数组 `minItems: 1`（架构 W1）。
 */
export interface EvidenceAnchor {
  readonly source_doi_or_url: string;
  readonly pdf_page?: number;
  /** PDF 原文坐标 `[x0, y0, x1, y1]`，恰好 4 个数。 */
  readonly bbox?: readonly number[];
  readonly verification_level: VerificationLevel;
}

/**
 * 证据等级（3 档，不可缺档）：
 *  - `Level_A_Verified`   有 DOI + PDF 坐标 + 人工/AI 双验
 *  - `Level_B_Preprint`   仅预印本或无可定位坐标
 *  - `Retracted_Warning`  命中撤稿/勘误库
 */
export type VerificationLevel = 'Level_A_Verified' | 'Level_B_Preprint' | 'Retracted_Warning';

export interface WormholePayload {
  /** 自由 object。大载荷时只放 `asset_ref` 引用（架构 §5.4）。 */
  readonly data: Record<string, unknown>;
  /** 至少 1 条。即使只传引用，意图与证据也必须当场携带。 */
  readonly evidence_anchors: readonly EvidenceAnchor[];
}

/**
 * 跨微站虫洞投送信封。对应 `specs/contracts/wormhole-envelope.schema.json`。
 *
 * `additionalProperties: false`——想加字段必须走 ADR-10 的版本化流程。
 */
export interface WormholeEnvelope {
  readonly $schema?: string;
  /** 全链路追踪 ID，一次投送一个 trace。 */
  readonly trace_id: string;
  /** 全域唯一 MatrixID 用户标识。 */
  readonly matrix_uid: string;
  /** 源站，如 `curvelab.matrixos.edu`。 */
  readonly source_app: string;
  /** 目标站，如 `mentor.matrixos.edu`。 */
  readonly target_app: string;
  readonly payload_type: WormholePayloadType;
  readonly payload: WormholePayload;
  readonly created_at?: string;
}

export type WormholeEnvelopeInput = Omit<WormholeEnvelope, 'trace_id' | 'matrix_uid' | 'source_app' | 'target_app'> & {
  readonly trace_id?: string;
  readonly matrix_uid?: string;
  readonly source_app?: string;
  readonly target_app?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// asset_node：资产图谱节点（架构 §6.2 的表结构）
// ─────────────────────────────────────────────────────────────────────────────

/** 产生该资产的微站类型。与 `asset_node.asset_type` 对齐。 */
export type AssetType =
  | 'paper'
  | 'dataset'
  | 'fit_result'
  | 'figure'
  | 'review_draft'
  | 'mentor_card'
  | 'cv_version'
  | 'score_record'
  | 'grant_record';

/**
 * 资产节点。字段取自架构 §6.2 的 `asset_node` 表。
 * 服务端新增的派生字段（如 `_links`）不应出现在此类型里。
 */
export interface AssetNode {
  readonly asset_id: string;
  readonly matrix_uid: string;
  /** 产生该资产的微站 `station_id`（如 `curvelab`）。 */
  readonly station_id: string;
  readonly asset_type: AssetType;
  readonly title?: string;
  readonly payload: Record<string, unknown>;
  /** 与 Wormhole envelope 同构。 */
  readonly evidence_anchors: readonly EvidenceAnchor[];
  readonly verification_level: VerificationLevel;
  /** 溯源到某次虫洞投送。 */
  readonly trace_id?: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  /** 端侧隐私仓指针——正文永不出设备（架构 §6.4）。 */
  readonly local_ref?: { readonly device_id: string; readonly local_key: string };
}

export type AssetNodeInput = Omit<AssetNode, 'asset_id' | 'version' | 'created_at' | 'updated_at'> & {
  readonly asset_id?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 枚举常量（与冻结 schema 的 enum 保持逐字一致，供运行时校验与 UI 复用）
// ─────────────────────────────────────────────────────────────────────────────

export const ORBIT_STATIONS: readonly OrbitStation[] = [
  'study',
  'spark',
  'pat_hot',
  'xingmen',
  'workshop',
  'cloud_balance',
  'pre_job',
] as const;

export const MANIFEST_PAYLOAD_TYPES: readonly ManifestPayloadType[] = [
  'paper_doi_bundle',
  'comparison_matrix_row',
  'curve_fit_parameters',
  'mentor_match_card',
  'verified_cv_evidence',
] as const;

export const MANIFEST_PERMISSIONS: readonly ManifestPermission[] = [
  'matrix_id:read',
  'profile:read',
  'assets:read',
  'assets:write',
  'wormhole:send',
  'wormhole:receive',
] as const;

export const VERIFICATION_LEVELS: readonly VerificationLevel[] = [
  'Level_A_Verified',
  'Level_B_Preprint',
  'Retracted_Warning',
] as const;
