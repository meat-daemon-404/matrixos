/**
 * MatrixOS 全息数字孪生 —— 封闭枚举唯一事实源
 *
 * 本文件是全包唯一允许出现字符串字面量枚举值的地方。
 * 其余模块一律 `import { X } from './enums.js'`，禁止就地写死枚举。
 *
 * 权威来源（按优先级）：
 *  1. `specs/contracts/*.schema.json`（已冻结，不得修改）
 *  2. `docs/01-plan/01-architecture.md` §5 / §6（表结构与虫洞工程规则）
 *  3. `docs/01-plan/04-tech-decisions.md`（ADR-04 向量库参数）
 *
 * 每个常量都同时导出「as const 常量数组（运行时可用）」与「联合类型（编译期）」。
 * 运行时枚举全部走 `z.enum(CONST)`，保证 zod 校验与常量数组永不漂移。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 契约元数据
// ---------------------------------------------------------------------------

/**
 * 三份冻结契约的 `$id`。
 * 用于 envelope 的 `$schema` 字段、以及 CI 里的契约漂移比对。
 */
export const CONTRACT_SCHEMA_IDS = {
  wormholeEnvelope: 'https://matrixos.edu/contracts/wormhole-envelope.schema.json',
  dispatchContract: 'https://matrixos.edu/contracts/dispatch-contract.schema.json',
  matrixAppManifest: 'https://matrixos.edu/contracts/matrix-app-manifest.schema.json',
} as const;

export type ContractSchemaId = (typeof CONTRACT_SCHEMA_IDS)[keyof typeof CONTRACT_SCHEMA_IDS];

/** 契约协议版本（manifest_version 的封闭值，见 matrix-app-manifest.schema.json） */
export const MANIFEST_PROTOCOL_VERSION = '1.0' as const;
export type ManifestProtocolVersion = typeof MANIFEST_PROTOCOL_VERSION;

// ---------------------------------------------------------------------------
// 虫洞载荷类型（wormhole-envelope.schema.json · payload_type · 封闭 5 值）
// ---------------------------------------------------------------------------

/**
 * 虫洞可投送的 5 类结构化载荷。
 *
 * 🔴 封闭枚举：架构 §5.1 明确「不得擅自扩展」。新增类型必须走 ADR-10 版本化流程
 *    （发布 `wormhole-envelope.v2.schema.json`），不能靠多发一个字段蒙混。
 */
export const PAYLOAD_TYPE = [
  'paper_doi_bundle',
  'comparison_matrix_row',
  'curve_fit_parameters',
  'mentor_match_card',
  'verified_cv_evidence',
] as const;

export type PayloadType = (typeof PAYLOAD_TYPE)[number];
export const payloadTypeSchema = z.enum(PAYLOAD_TYPE);

// ---------------------------------------------------------------------------
// 证据可信等级（wormhole-envelope.schema.json · evidence_anchors[].verification_level）
// ---------------------------------------------------------------------------

/**
 * 证据可信三档。这是合规红线的一部分：每条证据锚点必须显式声明等级，
 * 且 `Retracted_Warning` 必须在 UI 上可见（不得降级为静默通过）。
 *
 * - `Level_A_Verified`   有 DOI + PDF 坐标 + 人工/AI 双验
 * - `Level_B_Preprint`   仅预印本，或无可定位坐标
 * - `Retracted_Warning`  命中撤稿/勘误库
 */
export const VERIFICATION_LEVEL = [
  'Level_A_Verified',
  'Level_B_Preprint',
  'Retracted_Warning',
] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVEL)[number];
export const verificationLevelSchema = z.enum(VERIFICATION_LEVEL);

// ---------------------------------------------------------------------------
// 生涯闭环 7 站（dispatch-contract · station_id / manifest · orbit_station）
// ---------------------------------------------------------------------------

/**
 * 7 站生涯闭环节点。
 *
 * ⚠️ 注意：这是**轨道层级**，不是 18 个微站的 id。
 *    同名概念在 `asset_node.station_id` 里表示的是**微站 key**（如 `'curvelab'`），
 *    两者定义域完全不同，见 `MicrositeKey` 与 README「已知坑」。
 */
export const ORBIT_STATION = [
  'study',
  'spark',
  'pat_hot',
  'xingmen',
  'workshop',
  'cloud_balance',
  'pre_job',
] as const;

export type OrbitStation = (typeof ORBIT_STATION)[number];
export const orbitStationSchema = z.enum(ORBIT_STATION);

// ---------------------------------------------------------------------------
// 模型分级（dispatch-contract · workflow[].model_tier）
// ---------------------------------------------------------------------------

/**
 * 模型分级 3 档。
 *
 * ⚠️ 规格缺口 R2 / TD-09：蓝图给出 4 个 TIER，契约只有 3 档，映射关系至今未定义
 *    （见 `docs/00-analysis/03-gap-analysis.md` §6.3 第 4 条）。
 *    本包按契约现状实现 3 档，不擅自补第 4 档。映射落地前，调用方自行约定。
 */
export const MODEL_TIER = ['flash', 'pro', 'local'] as const;

export type ModelTier = (typeof MODEL_TIER)[number];
export const modelTierSchema = z.enum(MODEL_TIER);

// ---------------------------------------------------------------------------
// DAG 步骤状态（dispatch-contract · workflow[].status）
// ---------------------------------------------------------------------------

export const DISPATCH_STATUS = ['pending', 'running', 'success', 'failed'] as const;

export type DispatchStepStatus = (typeof DISPATCH_STATUS)[number];
export const dispatchStatusSchema = z.enum(DISPATCH_STATUS);

// ---------------------------------------------------------------------------
// MatrixID 授权范围（matrix-app-manifest.schema.json · permissions[]）
// ---------------------------------------------------------------------------

/**
 * 第三方微站可申请的 6 个授权 scope。
 * 与架构 §4.5 的 `station:<site_key>:<verb>` 是**两套**粒度：
 * 这里的 6 个是「能力族」，JWT 里的 scope 是「单站窄 scope」，不要混用。
 */
export const PERMISSION = [
  'matrix_id:read',
  'profile:read',
  'assets:read',
  'assets:write',
  'wormhole:send',
  'wormhole:receive',
] as const;

export type Permission = (typeof PERMISSION)[number];
export const permissionSchema = z.enum(PERMISSION);

// ---------------------------------------------------------------------------
// 资产节点类型（docs/01-plan/01-architecture.md §6.2 · asset_node.asset_type）
// ---------------------------------------------------------------------------

/**
 * `asset_node.asset_type` 的封闭枚举。
 *
 * 来源拆解（架构 §6.2 的 DDL 注释给出 9 个，本包补 3 个）：
 *
 * | 值                | 来源                                  | 说明 |
 * | :---------------- | :------------------------------------ | :--- |
 * | `paper`           | 架构 §6.2 原列                        | 论文元数据 + DOI + PDF 坐标 |
 * | `dataset`         | 架构 §6.2 原列                        | 实验数据集（原始数据可能只在端侧 IDB） |
 * | `fit_result`      | 架构 §6.2 原列                        | 拟合结果（R²、τ 参数） |
 * | `figure`          | 架构 §6.2 原列                        | 出版级图表 |
 * | `review_draft`    | 架构 §6.2 原列                        | 综述草稿与段落证据绑定 |
 * | `mentor_card`     | 架构 §6.2 原列                        | 导师五维画像卡片 |
 * | `cv_version`      | 架构 §6.2 原列                        | 一版完整简历（聚合体） |
 * | `score_record`    | 架构 §6.2 原列                        | 综测加分记录 |
 * | `grant_record`    | 架构 §6.2 原列                        | 经费报销凭据 |
 * | `comparison_row`  | 本包补（Task 要求 / 09 站产物）       | 跨论文对比矩阵的一行 |
 * | `cv_entry`        | 本包补（Task 要求 / 17 站产物）       | 简历中的**单条**可溯源经历 |
 * | `receipt`         | 本包补（Task 要求 / 虫洞收据）        | Wormhole 投送收据（不含 payload 正文） |
 *
 * 📌 `cv_version` 与 `cv_entry` 的关系（架构未明说，本包如此裁定，待评审确认）：
 *    `cv_version` 是**版本聚合体**（「我的 2026 秋招简历 v3」），
 *    `cv_entry` 是**单条节点**（「这条经历由哪篇论文的哪个 bbox 支撑」）。
 *    17 站的多跳溯源需要后者，简历导出需要前者，两者不可互相替代。
 */
export const ASSET_TYPE = [
  'paper',
  'dataset',
  'fit_result',
  'figure',
  'review_draft',
  'comparison_row',
  'mentor_card',
  'cv_version',
  'cv_entry',
  'score_record',
  'grant_record',
  'receipt',
] as const;

export type AssetType = (typeof ASSET_TYPE)[number];
export const assetTypeSchema = z.enum(ASSET_TYPE);

// ---------------------------------------------------------------------------
// 资产图谱关系（architecture §6.2 · asset_edge.relation）
// ---------------------------------------------------------------------------

/**
 * 图谱边的 5 种关系。
 *
 * - `derived_from`  A 由 B 推导而来（如 fit_result ← dataset）
 * - `cites`         A 引用 B（如 review_draft → paper）
 * - `evidences`     A 为 B 提供证据（如 fit_result → cv_entry）
 * - `supersedes`    A 取代 B（版本演进）
 * - `relates_to`    弱关联（同主题，无方向语义）
 *
 * Task 要求至少含 `derived_from` / `cites` / `evidences`；
 * 架构 §6.2 额外给了 `supersedes` / `relates_to`，本包取架构的完整 5 值（超集）。
 */
export const ASSET_RELATION = [
  'derived_from',
  'cites',
  'evidences',
  'supersedes',
  'relates_to',
] as const;

export type AssetRelation = (typeof ASSET_RELATION)[number];
export const assetRelationSchema = z.enum(ASSET_RELATION);

// ---------------------------------------------------------------------------
// 官方 18 微站 key（architecture §7.1 域名表 / specs/microsites.json）
// ---------------------------------------------------------------------------

/**
 * 18 个官方微站的 **site_key**（子域名第一段）。
 *
 * 用途：`asset_node.station_id`、JWT scope `station:<site_key>:<verb>` 的 `<site_key>` 位。
 *
 * ⚠️ 这是**便捷联合类型**，不是运行时封闭枚举 —— 因为第 19+ 站由 manifest 的
 *    `app_id` 动态注册（架构 A5），第三方 key 无法在编译期穷举。
 *    因此 `assetNodeSchema.station_id` 用**文法校验**（与 manifest `app_id`
 *    同一条正则）而非封闭枚举，这样官方站与第三方站走同一条校验路径。
 *    本常量用于需要穷举官方站的场景（如星轨渲染、可达矩阵构建）。
 */
export const OFFICIAL_MICROSITE_KEY = [
  'gpa',
  'spark',
  'grant-audit',
  'pat-hot',
  'lit-sonar',
  'mentor',
  'cold-email',
  'lab-kanban',
  'matrix-cross',
  'pdf-sniper',
  'curvelab',
  'repro-check',
  'chart-foundry',
  'review-lab',
  'retract-radar',
  'yunheng',
  'evidence-cv',
  'prejob',
] as const;

export type OfficialMicrositeKey = (typeof OFFICIAL_MICROSITE_KEY)[number];

/**
 * 微站 key 文法：与 `matrix-app-manifest.schema.json` 的 `app_id` 完全一致。
 * 官方站与第三方站共用，保证 `asset_node.station_id` 不会出现无法挂载的孤儿值。
 */
export const MICROSITE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// 向量检索常量（ADR-04）
// ---------------------------------------------------------------------------

/**
 * embedding 维度。与 `asset_chunk.embedding vector(1024)` 列定义严格对应。
 *
 * 🔴 换 embedding 模型若维度变化，必须新增列而非改原列（ADR-04 明确要求双写过渡）。
 */
export const EMBEDDING_DIMENSIONS = 1024 as const;

/**
 * HNSW 索引参数。`m` 与 `ef_construction` 取自 ADR-04 的明确数值。
 *
 * ⚠️ `distanceMetric` **未**在 ADR-04 中定义，此处 `'cosine'` 是文本 embedding 的
 *    通行默认值，属本包假设，需 `matrix-core`（BE2）在建索引时确认后回填。
 *    pgvector 对应算子类：`vector_cosine_ops` / `vector_l2_ops` / `vector_ip_ops`。
 */
export const HNSW_INDEX_CONFIG = {
  m: 16,
  efConstruction: 64,
  distanceMetric: 'cosine',
} as const;

export type HnswDistanceMetric = 'cosine' | 'l2' | 'inner_product';

/** pgvector 算子类名，供迁移脚本直接引用。 */
export const PGVECTOR_OPS_CLASS = {
  cosine: 'vector_cosine_ops',
  l2: 'vector_l2_ops',
  inner_product: 'vector_ip_ops',
} as const satisfies Record<HnswDistanceMetric, string>;
