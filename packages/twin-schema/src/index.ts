/**
 * `@matrixos/twin-schema` —— MatrixOS 全息数字孪生数据契约的唯一出口
 *
 * ## 这个包是什么
 *
 * MatrixOS 有 18 个官方微站 + N 个第三方站。它们之间流动的每一种结构化数据，
 * 都必须先在这里定义一次，然后所有站引用同一份定义——**不允许任何站自己抄一份**。
 * 这正是架构公理 A2「单一身份与资产底座」在类型层的落地。
 *
 * ## 三层内容
 *
 * | 层 | 内容 | 事实源 |
 * | :--- | :--- | :--- |
 * | 枚举 | 7 站、5 类载荷、3 档证据、12 类资产、5 种关系…… | `./enums.ts`（全包唯一允许写字面量的地方） |
 * | 契约 | `WormholeEnvelope` / `DispatchContract` / `MatrixAppManifest` | `specs/contracts/*.schema.json`（**已冻结，不得修改**） |
 * | 图谱 | `AssetNode` / `AssetEdge` / `AssetChunk` | `docs/01-plan/01-architecture.md` §6.2 |
 *
 * ## 两个入口怎么选
 *
 * - 需要**运行时校验**（拦截非法报文）→ 从本入口或子入口引 `*Schema`；
 * - 只需要**类型**（构建期零运行时依赖，如 18 个微站的 UI）→ 用 `import type`，
 *   打包器会把本包整个擦除。
 *
 * 如果某站既不想带 zod、又不想抄类型，正确做法是像 `packages/matrix-sdk` 那样
 * 维护**结构化镜像 + 契约一致性测试**（见该包 `src/contracts/types.ts` 的说明），
 * 而不是复制粘贴后各自漂移。
 *
 * ## 三条红线（改代码前务必读）
 *
 * 1. `payload.evidence_anchors` **minItems: 1**，且每条强制
 *    `source_doi_or_url` + `verification_level`；
 * 2. `asset_chunk.embedding` **恰好 1024 维**，换模型走双写过渡（ADR-04）；
 * 3. 枚举一律从 `./enums.ts` 取，**禁止**在别处写死字面量。
 *
 * @packageDocumentation
 */

// 枚举层：唯一事实源
export * from './enums.js';

// 契约层：三份冻结 schema 的 zod 校验器 + 类型
export * from './contracts/index.js';

// 图谱层：DigitalTwinAssetGraph
export * from './asset-graph/index.js';
