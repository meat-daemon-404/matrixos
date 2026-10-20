/**
 * `DispatchContract` —— 中台调度 Agent 的统一数据交换协议（契约已冻结）
 *
 * 唯一事实源：`specs/contracts/dispatch-contract.schema.json`（**不得修改该文件**）。
 *
 * ## 这个类型解决什么问题
 *
 * 学生在中台说一句「帮我找钙钛矿钝化方向的导师，并生成套磁初稿」。
 * 路由器把自然语言解析成 `intent`，再由调度器展开成一张 DAG 工作流（`workflow[]`），
 * 按 `step_id` 推进、按 `depends_on` 拓扑排序，逐步派发给各微站。
 * 本契约就是「一次意图 → 一张 DAG → 每一步的状态」的载体。
 *
 * ## ⚠️ 与虫洞契约最关键的一处差异：这里**没有** `additionalProperties: false`
 *
 * 冻结的 dispatch schema 里，只有**顶层**写了 `"additionalProperties": false`；
 * 而 `intent`、`intent.parameters`、`workflow[]` 各步骤、`input_payload`
 * **都没有**该声明（JSON Schema 默认允许额外属性）。
 *
 * 因此本模块的实现刻意**不**对这几处使用 `z.strictObject`：
 * - 顶层 → `z.strictObject`（对应 `additionalProperties: false`）
 * - `intent` / `workflow[]` / `input_payload` → 保留额外键（`z.looseObject`）
 *
 * 若把这几处也写成 strict，会让**当前合法的**报文被误判为非法——
 * 这是「比契约更严格」的典型事故，比放宽更危险，因为它在生产里表现为随机 400。
 * 已由 `test/dispatch-contract.test.ts` 的「额外字段」用例锁定现状。
 */

import { z } from 'zod';

import {
  CONTRACT_SCHEMA_IDS,
  dispatchStatusSchema,
  modelTierSchema,
  orbitStationSchema,
} from '../enums.js';
import { freeObjectSchema } from './primitives.js';

/**
 * 意图解析结果。
 *
 * 契约只 `required: ["action"]`，其余可选；且**未**声明 `additionalProperties: false`，
 * 故用 `z.looseObject` 保留 `intent` 上的扩展键（如未来加的 `confidence`）。
 */
export const dispatchIntentSchema = z.looseObject({
  /** 动作，如 `find_mentor` / `draft_cold_email`。契约未封闭其取值。 */
  action: z.string().min(1),
  /** 学科域，如 `物理` / `光电` / `生物医药` / `计算工程` / `人文法学`。 */
  discipline: z.string().optional(),
  /** 自由参数字典。 */
  parameters: freeObjectSchema.optional(),
});

/**
 * 单个 DAG 步骤。
 *
 * 注意 `step_id` 用 `z.int()`：JSON Schema 的 `"type": "integer"` 不接受 `1.5`，
 * 而 zod 的普通 `z.number()` 会放过它。`minimum: 1` 同样照搬。
 */
export const dispatchStepSchema = z.looseObject({
  /** 步骤序号，从 1 开始。 */
  step_id: z.int().min(1),
  /** 承接该步骤的服务名，如 `copilot-router` / `openalex-pat-worker`。 */
  service_name: z.string().min(1),
  /** 模型分级（契约 3 档：flash / pro / local）。 */
  model_tier: modelTierSchema,
  /** 依赖的前序 `step_id` 列表，后端据此拓扑排序。 */
  depends_on: z.array(z.int()).optional(),
  /** 该步骤的输入载荷。 */
  input_payload: freeObjectSchema.optional(),
  status: dispatchStatusSchema,
});

/**
 * 调度契约本体。
 *
 * 顶层 `additionalProperties: false` → `z.strictObject`。
 */
export const dispatchContractSchema = z.strictObject({
  $schema: z.string().optional(),
  /** 全链路追踪 ID，与虫洞信封的 `trace_id` 同源。 */
  trace_id: z.uuid(),
  /** MatrixID。 */
  user_id: z.string().min(1),
  /** 7 站生涯闭环节点（与 manifest 的 `orbit_station` 同一枚举）。 */
  station_id: orbitStationSchema,
  intent: dispatchIntentSchema,
  /** DAG 执行计划，按 `step_id` 推进。空数组合法（契约未加 minItems）。 */
  workflow: z.array(dispatchStepSchema),
});

/** 调度契约。 */
export type DispatchContract = z.infer<typeof dispatchContractSchema>;
/** 单步 DAG 节点。 */
export type DispatchStep = z.infer<typeof dispatchStepSchema>;
/** 意图解析结果。 */
export type DispatchIntent = z.infer<typeof dispatchIntentSchema>;

/** 契约 `$id`。 */
export const DISPATCH_CONTRACT_SCHEMA_ID = CONTRACT_SCHEMA_IDS.dispatchContract;

/**
 * 按 `depends_on` 做拓扑排序，返回一份**可直接派发**的步骤序列。
 *
 * 架构 §6.2 提到「后端按 depends_on 拓扑排序」，本包把它下沉成共享工具，
 * 避免 18 个微站各自实现一份（并各自对环依赖处理不一致）。
 *
 * - 同层步骤按 `step_id` 升序，保证结果**确定**（可复现、可测试）；
 * - 存在环依赖、或依赖了不存在的 `step_id` 时抛错，而不是静默丢步骤。
 *
 * @throws {Error} 当 `depends_on` 含环或引用了未在 `workflow` 中出现的 `step_id`。
 *
 * @example
 * topologicalSortSteps([
 *   { step_id: 2, depends_on: [1], ... },
 *   { step_id: 1, ... },
 * ]).map((s) => s.step_id); // [1, 2]
 */
export function topologicalSortSteps(steps: readonly DispatchStep[]): DispatchStep[] {
  const byId = new Map<number, DispatchStep>();
  for (const step of steps) {
    if (byId.has(step.step_id)) {
      throw new Error(`duplicate step_id: ${step.step_id}`);
    }
    byId.set(step.step_id, step);
  }

  const indegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const step of steps) {
    const deps = step.depends_on ?? [];
    for (const dep of deps) {
      if (!byId.has(dep)) {
        throw new Error(`step ${step.step_id} depends_on unknown step_id ${dep}`);
      }
    }
    indegree.set(step.step_id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(step.step_id);
      dependents.set(dep, list);
    }
  }

  const ready = steps
    .filter((step) => (indegree.get(step.step_id) ?? 0) === 0)
    .map((step) => step.step_id)
    .sort((a, b) => a - b);

  const ordered: DispatchStep[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as number;
    const step = byId.get(id);
    if (step) ordered.push(step);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort((a, b) => a - b);
      }
    }
  }

  if (ordered.length !== steps.length) {
    const stuck = steps.filter((step) => !ordered.includes(step)).map((step) => step.step_id);
    throw new Error(`cyclic depends_on detected among step_id: ${stuck.join(', ')}`);
  }
  return ordered;
}
