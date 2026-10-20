/**
 * 契约原子类型（三份冻结 schema 共用的底层构件）
 *
 * 本文件只放「被两份以上契约引用」的原语，避免在 wormhole / dispatch / manifest
 * 三个模块里各写一遍同一套规则——那正是契约漂移的起点。
 *
 * ## 与 JSON Schema 的对应关系
 *
 * 所有 `additionalProperties: false` 一律映射为 `z.strictObject`（多一个字段就拒绝），
 * 这是本包最容易写错、也最容易「悄悄放宽」的地方，改动前请先看 `test/schema-parity.test.ts`。
 *
 * ## 本包在契约之上做的严格化（均不改变合法数据的通过性）
 *
 * | 严格化 | 理由 |
 * | :--- | :--- |
 * | 标识类字段 `min(1)` | 契约只写 `"type": "string"`，但 `""` 能通过 `required` 检查却毫无意义；空 trace_id 会让全链路追踪断链 |
 * | 数值 `.finite()` | JSON 无法编码 `Infinity` / `NaN`，兜住从 JS 侧传入的脏值 |
 * | `bbox` 用 tuple 而非 `number[]` | 契约是 `minItems: 4, maxItems: 4`，tuple 让「四个数」在编译期就成立 |
 *
 * @see specs/contracts/wormhole-envelope.schema.json
 * @see specs/contracts/dispatch-contract.schema.json
 * @see specs/contracts/matrix-app-manifest.schema.json
 */
import { z } from 'zod';

import {
  PAYLOAD_TYPE,
  VERIFICATION_LEVEL,
  payloadTypeSchema,
  verificationLevelSchema,
} from '../enums.js';

/** 契约里 `format: "uuid"` 的统一写法（RFC 4122，大小写不敏感）。 */
export const uuidSchema = z.uuid();

/**
 * 契约里 `format: "date-time"` 的统一写法。
 *
 * `offset: true` 是必须的：RFC 3339 允许 `+08:00` 偏移，而默认配置只认 `Z`。
 * 本项目全部服务器在 `Asia/Shanghai`，服务端一旦回 `2026-10-20T11:54:10+08:00`
 * 就会被默认配置误判为非法——这是最容易踩的一个坑。
 */
export const dateTimeSchema = z.iso.datetime({ offset: true });

/** 契约里 `format: "uri"`。注意：这是 URI 不是 HTTP URL，`urn:` / `ftp:` 同样合法。 */
export const uriSchema = z.url();

/** 契约里 `format: "email"`。 */
export const emailSchema = z.email();

/** JSON Schema 的 `{"type": "object"}`，无字段约束，且**保留**任意键。 */
export const freeObjectSchema = z.looseObject({});

/**
 * 单一证据锚点的可信等级（3 档封闭枚举，唯一事实源在 `enums.ts`）。
 * 这里 re-export 只是为了让契约模块的 import 面收在一处。
 */
export { payloadTypeSchema, verificationLevelSchema };

/** 虫洞可投送的 5 类载荷（as const 数组，运行时可用）。 */
export const payloadTypes = PAYLOAD_TYPE;

/** 证据可信三档（as const 数组，运行时可用）。 */
export const verificationLevels = VERIFICATION_LEVEL;

/** 单条证据锚点的 TS 类型。 */
export type EvidenceAnchor = z.infer<typeof evidenceAnchorSchema>;

/**
 * 证据锚点 —— **合规红线所在，不许弱化**。
 *
 * 三条不可退让的约束（对应架构 §5.3 的 W1 规则）：
 *  1. `source_doi_or_url` 必填且非空字符串；
 *  2. `verification_level` 必填，且只能是 3 档之一；
 *  3. 外层 `evidence_anchors` 数组 `minItems: 1`（在 `wormholePayloadSchema` 里强制）。
 *
 * 任何「先投送空壳、后续再补证据」的路径都必须被这层挡住。
 *
 * @see docs/01-plan/01-architecture.md §5.3 W1
 */
export const evidenceAnchorSchema = z.strictObject({
  /** DOI（如 `10.1021/jacs.4c0112`）或原文 URL。 */
  source_doi_or_url: z.string().min(1).max(2048),
  /** PDF 页码，从 1 开始。 */
  pdf_page: z.int().min(1).optional(),
  /** PDF 原文坐标 `[x0, y0, x1, y1]`，恰好 4 个数。 */
  bbox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).optional(),
  /** 证据可信等级，三档封闭。 */
  verification_level: verificationLevelSchema,
});

/**
 * 证据可信度排序：数值越大越「弱」。
 *
 * 用于 `worstVerificationLevel()`——一个资产携带多条锚点时，
 * 其对外可见的可信等级必须取**最弱的那条**，否则「用一条 A 级锚点洗白一条撤稿锚点」。
 */
export const VERIFICATION_SEVERITY = {
  Level_A_Verified: 0,
  Level_B_Preprint: 1,
  Retracted_Warning: 2,
} as const satisfies Record<(typeof VERIFICATION_LEVEL)[number], number>;

/**
 * 取一组锚点里最弱的可信等级。
 *
 * 空数组返回 `undefined`（调用方应先用 `minItems: 1` 拒绝，而不是在这里兜底）。
 *
 * @example
 * worstVerificationLevel([
 *   { source_doi_or_url: '10.1/a', verification_level: 'Level_A_Verified' },
 *   { source_doi_or_url: '10.1/b', verification_level: 'Retracted_Warning' },
 * ]); // 'Retracted_Warning'
 */
export function worstVerificationLevel(
  anchors: readonly EvidenceAnchor[],
): EvidenceAnchor['verification_level'] | undefined {
  let worst: EvidenceAnchor['verification_level'] | undefined;
  for (const anchor of anchors) {
    if (worst === undefined || VERIFICATION_SEVERITY[anchor.verification_level] > VERIFICATION_SEVERITY[worst]) {
      worst = anchor.verification_level;
    }
  }
  return worst;
}
