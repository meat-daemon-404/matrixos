/**
 * `WormholeEnvelope` —— 跨微站虫洞投送信封（契约已冻结）
 *
 * 唯一事实源：`specs/contracts/wormhole-envelope.schema.json`（**不得修改该文件**）。
 *
 * ## 这个类型解决什么问题
 *
 * 学生把 CurveLab 里的一条拟合结果、或 Lit-Sonar 里的一行对比矩阵，直接拖到
 * Mentor 站或 Evidence-CV 站。拖拽的瞬间，浏览器 `postMessage` 里流动的就是这个信封——
 * 目标是「零文件导入导出，结构化参量与证据锚点零丢失」。
 *
 * ## 三条合规红线（架构 §5.1 / §5.3 W1）
 *
 * 1. `payload.evidence_anchors` **至少 1 条**（`minItems: 1`）；
 * 2. 每条锚点**必须**含 `source_doi_or_url` 与 `verification_level`；
 * 3. `payload_type` 是**封闭 5 值**，不得擅自扩展（新增走 ADR-10 版本化）。
 *
 * 🔴 第 1、2 条不允许以任何理由放宽：即使只投送一个 `asset_ref` 引用（架构 §5.4
 *    的大载荷策略），证据也必须**当场**携带，不能「先投空壳、事后再补」。
 *
 * ## `additionalProperties: false` 的落地
 *
 * 顶层与 `payload`、`evidence_anchors[]` 三层都是 `false`，故全部用 `z.strictObject`。
 * 多传一个字段即校验失败——想加字段只能走契约版本化，而不是偷偷塞进去。
 *
 * @see docs/01-plan/01-architecture.md §5（虫洞协议）、§5.3（强制规则 W1–W3）、§5.4（大载荷）
 */
import { z } from 'zod';

import { CONTRACT_SCHEMA_IDS, payloadTypeSchema } from '../enums.js';
import { evidenceAnchorSchema, freeObjectSchema } from './primitives.js';

/**
 * 载荷正文与证据锚点。
 *
 * - `data` 是**自由 object**（契约未约束内部字段）。大载荷时只放 `asset_ref` 引用，
 *   目标站再按需调 `/v1/assets/{asset_ref}` 拉全量——这条策略让虫洞消息体积恒定。
 * - `evidence_anchors` 的 `minItems: 1` 是红线，见文件头。
 */
export const wormholePayloadSchema = z.strictObject({
  /** 结构化正文。大载荷时退化为 `{ asset_ref, asset_version, summary }`。 */
  data: freeObjectSchema,
  /** 至少 1 条证据锚点。**合规红线，不许弱化。** */
  evidence_anchors: z.array(evidenceAnchorSchema).min(1),
});

/**
 * 虫洞信封本体（契约 `required: [trace_id, matrix_uid, source_app, target_app, payload_type, payload]`）。
 *
 * 三层 `additionalProperties: false` 全部映射为 `z.strictObject`。
 */
export const wormholeEnvelopeSchema = z.strictObject({
  /** 可选自描述。便于消费方按 `$id` 直接取到契约原文。 */
  $schema: z.string().optional(),
  /** 全链路追踪 ID，一次投送一个 trace。 */
  trace_id: z.uuid(),
  /** 全域唯一 MatrixID 用户标识。 */
  matrix_uid: z.string().min(1),
  /** 源站，如 `curvelab.matrixos.edu`。 */
  source_app: z.string().min(1),
  /** 目标站，如 `mentor.matrixos.edu`。须已在 manifest `accepts[]` 中声明（W3）。 */
  target_app: z.string().min(1),
  payload_type: payloadTypeSchema,
  payload: wormholePayloadSchema,
  /** 生成时刻。`offset: true` 以接受 `+08:00` 形式的 RFC 3339。 */
  created_at: z.iso.datetime({ offset: true }).optional(),
});

/** 虫洞信封（由 zod 推导，与冻结契约字段级同构）。 */
export type WormholeEnvelope = z.infer<typeof wormholeEnvelopeSchema>;
/** 载荷正文 + 证据锚点。 */
export type WormholePayload = z.infer<typeof wormholePayloadSchema>;

/**
 * 构造信封时可省略的字段。
 *
 * 只对**服务端/路由层本来就会补齐或注入**的字段放宽，其余字段仍必须由调用方给出。
 * 注意 `payload` 与 `payload_type` 不在其中——它们是投送方必须当场声明的意图与证据。
 */
export type WormholeEnvelopeDraft = Omit<WormholeEnvelope, 'trace_id'> & {
  trace_id?: string;
};

/** 契约 `$id`，供 `$schema` 字段与漂移比对使用。 */
export const WORMHOLE_ENVELOPE_SCHEMA_ID = CONTRACT_SCHEMA_IDS.wormholeEnvelope;

/**
 * 校验虫洞信封。
 *
 * 与 `wormholeEnvelopeSchema.safeParse` 等价，只是把结果收敛成判别式联合，
 * 方便在 `if (!r.ok)` 里直接读 `r.issues`。**不吞异常、不给默认值、不做修补**：
 * 校验失败必须是硬失败，由调用方把环体变红（架构 §5.2）。
 */
export function parseWormholeEnvelope(input: unknown):
  | { readonly ok: true; readonly envelope: WormholeEnvelope }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const result = wormholeEnvelopeSchema.safeParse(input);
  if (result.success) return { ok: true, envelope: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
  };
}
