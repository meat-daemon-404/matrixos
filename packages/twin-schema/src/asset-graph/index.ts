/**
 * `DigitalTwinAssetGraph` —— 全域唯一学术资产事实源的类型与校验器
 *
 * 权威来源：`docs/01-plan/01-architecture.md` §6（表结构在 §6.2，写入路径在 §6.3，
 * 端侧隐私边界在 §6.4），以及 `src/enums.ts` 中的 `ASSET_TYPE` / `ASSET_RELATION` /
 * `EMBEDDING_DIMENSIONS`。
 *
 * ## 三张表
 *
 * ```
 * asset_node（主表）  ← 一个资产：一篇论文、一条拟合结果、一版简历……
 *      ↑ from_asset_id / to_asset_id
 * asset_edge（边）    ← 「A 由 B 推导」「A 引用 B」「A 为 B 提供证据」
 *      ↑ asset_id
 * asset_chunk（分片） ← 向量检索用，embedding 固定 1024 维
 * ```
 *
 * ## 为什么是图而不是宽表
 *
 * 17 号站（证据简历）要回答：「这条简历经历，能追溯到哪篇论文的哪个 PDF 坐标、
 * 由哪个拟合结果支撑」。这是**多跳溯源**——宽表要 join 五次以上且容易断链，
 * `asset_edge` 让溯源变成一次图遍历。这就是「DigitalTwin」+「AssetGraph」两个词的
 * 工程落地含义（架构 §6.2 原文）。
 *
 * ## 🔴 三条不可退让的约束
 *
 * 1. `asset_node.evidence_anchors` **minItems: 1** —— 与虫洞信封同构、同一条红线；
 * 2. `asset_node.verification_level` **必填**，3 档封闭；
 * 3. `asset_chunk.embedding` **恰好 1024 维** —— 换模型若维度变了，
 *    必须新增列做双写过渡，**不许**直接改现有列（ADR-04）。
 *
 * @see docs/01-plan/01-architecture.md §6.2
 * @see docs/01-plan/04-tech-decisions.md ADR-04
 */

import { z } from 'zod';

import {
  EMBEDDING_DIMENSIONS,
  MICROSITE_KEY_PATTERN,
  assetRelationSchema,
  assetTypeSchema,
  verificationLevelSchema,
} from '../enums.js';
import { dateTimeSchema, evidenceAnchorSchema, freeObjectSchema, uuidSchema } from '../contracts/primitives.js';

/**
 * 端侧隐私仓指针。
 *
 * 未发表实验原始数据（如 TRPL 原始散点）**永不出设备**（TIER 04 零外泄承诺），
 * 服务端只存这个指针。其他站展示时须标注「原始数据在设备 X，
 * 请在该设备打开 CurveLab 查看」——这是诚实的能力边界，不假装可跨设备访问
 * （架构 §6.4）。
 */
export const localRefSchema = z.strictObject({
  /** 设备标识。 */
  device_id: z.string().min(1),
  /** 该设备 IndexedDB 内的键。 */
  local_key: z.string().min(1),
});

/** 端侧隐私仓指针。 */
export type LocalRef = z.infer<typeof localRefSchema>;

/**
 * 资产节点（`asset_node` 主表）。
 *
 * 字段与架构 §6.2 的 DDL 一一对应，仅两处补充：
 *  - `local_ref`（§6.4 明确要求放在 `payload` 里，本包提为节点级可选字段，
 *    便于 17/18 号站不解析 payload 就能判断「要不要提示换设备」）；
 *  - `trace_id` 可为空——手工录入的历史资产没有虫洞来源。
 */
export const assetNodeSchema = z.strictObject({
  /** `asset_id`（uuid PK）。 */
  asset_id: uuidSchema,
  /** 归属人 MatrixID。 */
  matrix_uid: z.string().min(1),
  /**
   * 产生该资产的微站 key（如 `curvelab`）。
   *
   * ⚠️ 用**文法校验**而非封闭枚举：第 19+ 站由 manifest 的 `app_id` 动态注册，
   * 第三方 key 无法在编译期穷举（架构 A5）。官方 18 站走同一条正则。
   * 注意这与 `orbit_station` 的 7 站枚举是**两套**定义域，见 README「已知坑」。
   */
  station_id: z.string().regex(MICROSITE_KEY_PATTERN, 'station_id 必须是合法微站 key'),
  asset_type: assetTypeSchema,
  title: z.string().optional(),
  /** 结构化内容，受 twin-schema 校验（写入路径见架构 §6.3）。 */
  payload: freeObjectSchema,
  /** 与 Wormhole envelope 同构。**至少 1 条，合规红线。** */
  evidence_anchors: z.array(evidenceAnchorSchema).min(1),
  /** 节点整体可信等级。多条锚点时取**最弱**一条（见 `worstVerificationLevel`）。 */
  verification_level: verificationLevelSchema,
  /** 溯源到某次虫洞投送；手工录入的历史资产为空。 */
  trace_id: uuidSchema.optional(),
  /** 版本号，从 1 开始递增。 */
  version: z.int().min(1),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  /** 端侧隐私指针——正文永不出设备（架构 §6.4）。 */
  local_ref: localRefSchema.optional(),
});

/** 资产节点。 */
export type AssetNode = z.infer<typeof assetNodeSchema>;

/**
 * 写入期资产节点入参：主键与时间戳由 `matrix-core` 生成。
 *
 * `verification_level` **不在可省字段里**——即使服务端能自己算，
 * 也要求调用方显式声明，避免「默认 A 级」这种静默合规漏洞。
 */
export type AssetNodeInput = Omit<
  AssetNode,
  'asset_id' | 'version' | 'created_at' | 'updated_at'
> & {
  readonly asset_id?: string;
  readonly version?: number;
  readonly created_at?: string;
  readonly updated_at?: string;
};

/**
 * 资产图谱边（`asset_edge`）。
 *
 * 关系语义（架构 §6.2 + `enums.ts` 的 `ASSET_RELATION`）：
 *  - `derived_from`：A 由 B 推导（fit_result ← dataset）
 *  - `cites`：A 引用 B（review_draft → paper）
 *  - `evidences`：A 为 B 提供证据（fit_result → cv_entry）
 *  - `supersedes`：A 取代 B（版本演进）
 *  - `relates_to`：弱关联，无方向语义
 */
export const assetEdgeSchema = z.strictObject({
  edge_id: uuidSchema,
  /** 边的起点。 */
  from_asset_id: uuidSchema,
  /** 边的终点。 */
  to_asset_id: uuidSchema,
  relation: assetRelationSchema,
  /** 边权，`real` 列。省略时视作 1。 */
  weight: z.number().finite().optional(),
});

/** 资产图谱边。 */
export type AssetEdge = z.infer<typeof assetEdgeSchema>;

/** 写入期边入参（`edge_id` 由服务端生成）。 */
export type AssetEdgeInput = Omit<AssetEdge, 'edge_id'> & { readonly edge_id?: string };

/**
 * 资产向量分片（`asset_chunk`）。
 *
 * `embedding` 固定 **1024** 维（ADR-04）。用 `.length(1024)` 而非普通数组校验：
 * 普通数组只校验元素类型，少几个维度照样通过，直到写进 pgvector 才炸。
 * 这里在应用层就挡掉，错误信息也更可读。
 */
export const assetChunkSchema = z.strictObject({
  chunk_id: uuidSchema,
  /** 所属资产。 */
  asset_id: uuidSchema,
  /** 分片序号，从 0 开始。 */
  chunk_index: z.int().min(0),
  /** 分片正文。 */
  content: z.string(),
  /** 向量，**恰好 1024 维**（ADR-04）。 */
  embedding: z.array(z.number().finite()).length(EMBEDDING_DIMENSIONS),
});

/** 资产向量分片。 */
export type AssetChunk = z.infer<typeof assetChunkSchema>;

/** 写入期分片入参（`chunk_id` 由服务端生成）。 */
export type AssetChunkInput = Omit<AssetChunk, 'chunk_id'> & { readonly chunk_id?: string };

// ---------------------------------------------------------------------------
// 大载荷阈值（架构 §5.4）
// ---------------------------------------------------------------------------

/**
 * 虫洞直传的体积上限：**64 KB**（架构 §5.4 明确数值）。
 *
 * 超过此值应改为「`data` 内只放 `asset_ref` 引用」，让虫洞消息体积恒定。
 */
export const WORMHOLE_INLINE_PAYLOAD_LIMIT_BYTES = 64 * 1024;

/**
 * 估算一段 payload 序列化后的字节数（UTF-8）。
 *
 * 用 `TextEncoder` 而非 `Buffer`：本包同时被浏览器端与 Node 端引用，
 * `TextEncoder` 两边都有，`Buffer` 只在 Node 有。
 */
export function estimatePayloadBytes(payload: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(payload) ?? '';
  } catch {
    // 循环引用或含 BigInt 等不可序列化值：交给校验层报错，这里按「超大」处理。
    return Number.POSITIVE_INFINITY;
  }
  return new TextEncoder().encode(json).length;
}

/**
 * 判断载荷是否超过 64 KB 直传阈值（架构 §5.4 要求下沉到本包的共享判定）。
 *
 * @example
 * if (isLargePayload(envelope.payload.data)) { ...改为放 asset_ref... }
 */
export function isLargePayload(
  payload: unknown,
  limitBytes: number = WORMHOLE_INLINE_PAYLOAD_LIMIT_BYTES,
): boolean {
  return estimatePayloadBytes(payload) > limitBytes;
}

/**
 * 把一份大载荷改写成 `payload.data` 的引用形态（架构 §5.4，**不改契约**）。
 *
 * 冻结契约里 `payload_type` 是封闭枚举、`payload` 是 `additionalProperties: false`，
 * 所以既不能新增 `asset_pointer` 类型，也不能加自定义字段。
 * 唯一合法路径是：`data` 是自由 object，往**里面**放 `asset_ref`。
 *
 * 附带好处：即使只传引用，`evidence_anchors` 仍强制非空——
 * 「意图与证据当场携带」的红线不因载荷变大而失效。
 *
 * @param assetRef 已在 `matrix-core` 落库的 `asset_id`
 * @param assetVersion 该资产的版本号
 * @param summary 人类可读摘要，显示在目标站的落点卡片上
 * @param resultCount 原始条目数（如 30 篇文献），用于 UI 提示「已送达 30 条」
 *
 * @example
 * toAssetRef({ assetRef: 'ast_01H8Z9K2', assetVersion: 3, summary: '30 篇钙钛矿钝化文献', resultCount: 30 });
 * // { asset_ref: 'ast_01H8Z9K2', asset_version: 3, summary: '...', result_count: 30 }
 */
export function toAssetRef(args: {
  readonly assetRef: string;
  readonly assetVersion: number;
  readonly summary: string;
  readonly resultCount?: number;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    asset_ref: args.assetRef,
    asset_version: args.assetVersion,
    summary: args.summary,
  };
  if (args.resultCount !== undefined) {
    data['result_count'] = args.resultCount;
  }
  return data;
}

/** 判断一份 `payload.data` 是否是 `toAssetRef()` 产出的引用形态。 */
export function isAssetRefPayload(data: unknown): data is {
  asset_ref: string;
  asset_version: number;
  summary: string;
  result_count?: number;
} {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const rec = data as Record<string, unknown>;
  return typeof rec['asset_ref'] === 'string' && rec['asset_ref'].length > 0;
}
