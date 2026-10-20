/**
 * `DispatchContract` 校验器测试。
 *
 * 除了常规的必填/枚举负例，本文件重点锁定一条**容易写错的方向**：
 * dispatch 契约的 `intent`、`workflow[]`、`input_payload` 都**没有**
 * `additionalProperties: false`，所以它们必须接受额外字段。
 * 若哪天有人「顺手」把它们改成 strict，这里的用例会立刻红。
 */
import { describe, expect, it } from 'vitest';

import { dispatchContractSchema, dispatchStepSchema, topologicalSortSteps } from '../src/index.js';
import { UUID_B, validDispatch } from './fixtures.js';

describe('DispatchContract · 合法路径', () => {
  it('接受一份完整契约', () => {
    expect(dispatchContractSchema.safeParse(validDispatch()).success).toBe(true);
  });

  it('省掉可选的 $schema 仍合法', () => {
    const contract = { ...validDispatch(), $schema: 'https://matrixos.edu/contracts/dispatch-contract.schema.json' };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(true);
  });

  it('7 站 station_id 全部合法', () => {
    const stations = ['study', 'spark', 'pat_hot', 'xingmen', 'workshop', 'cloud_balance', 'pre_job'];
    for (const station_id of stations) {
      expect(dispatchContractSchema.safeParse({ ...validDispatch(), station_id }).success, station_id).toBe(true);
    }
  });

  it('4 种 step status 全部合法', () => {
    for (const status of ['pending', 'running', 'success', 'failed']) {
      const step = { step_id: 1, service_name: 's', model_tier: 'flash', status };
      expect(dispatchStepSchema.safeParse(step).success, status).toBe(true);
    }
  });

  it('3 档 model_tier 全部合法', () => {
    for (const model_tier of ['flash', 'pro', 'local']) {
      const step = { step_id: 1, service_name: 's', model_tier, status: 'pending' };
      expect(dispatchStepSchema.safeParse(step).success, model_tier).toBe(true);
    }
  });

  it('intent 只带必填 action → 合法（discipline 可选）', () => {
    const contract = { ...validDispatch(), intent: { action: 'find_mentor' } };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(true);
  });

  it('workflow 为空数组 → 合法（契约未加 minItems）', () => {
    const contract = { ...validDispatch(), workflow: [] };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(true);
  });

  it('步骤可省掉可选的 depends_on / input_payload', () => {
    const contract = {
      ...validDispatch(),
      workflow: [{ step_id: 1, service_name: 'copilot-router', model_tier: 'flash', status: 'pending' }],
    };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(true);
  });
});

describe('DispatchContract · 与契约一致的结构性负例', () => {
  it('缺顶层必填字段 → 逐个删除都失败', () => {
    const required = ['trace_id', 'user_id', 'intent', 'station_id', 'workflow'];
    for (const key of required) {
      const contract = validDispatch();
      delete (contract as Record<string, unknown>)[key];
      expect(dispatchContractSchema.safeParse(contract).success, key).toBe(false);
    }
  });

  it('顶层多一个未声明字段 → 失败（顶层是 additionalProperties: false）', () => {
    const contract = { ...validDispatch(), priority: 'high' };
    const result = dispatchContractSchema.safeParse(contract);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unrecognized');
  });

  it('station_id 为契约外的站 → 失败', () => {
    const contract = { ...validDispatch(), station_id: 'unknown_station' };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(false);
  });

  it('station_id 误用微站 key（curvelab）→ 失败（7 站枚举 ≠ 微站 key）', () => {
    const contract = { ...validDispatch(), station_id: 'curvelab' };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(false);
  });

  it('step_id 为 0 → 失败（minimum: 1）', () => {
    const contract = validDispatch();
    contract.workflow[0]!.step_id = 0;
    expect(dispatchContractSchema.safeParse(contract).success).toBe(false);
  });

  it('step_id 为小数 1.5 → 失败（type: integer）', () => {
    const contract = validDispatch();
    contract.workflow[0]!.step_id = 1.5;
    expect(dispatchContractSchema.safeParse(contract).success).toBe(false);
  });

  it('model_tier 非法 → 失败', () => {
    const contract = validDispatch();
    (contract.workflow[0] as Record<string, unknown>)['model_tier'] = 'ultra';
    expect(dispatchContractSchema.safeParse(contract).success).toBe(false);
  });

  it('status 非法 → 失败', () => {
    const contract = validDispatch();
    (contract.workflow[0] as Record<string, unknown>)['status'] = 'cancelled';
    expect(dispatchContractSchema.safeParse(contract).success).toBe(false);
  });

  it('步骤缺 service_name → 失败', () => {
    const contract = validDispatch();
    delete (contract.workflow[0] as Record<string, unknown>)['service_name'];
    expect(dispatchContractSchema.safeParse(contract).success).toBe(false);
  });

  it('intent 缺 action → 失败', () => {
    const contract = { ...validDispatch(), intent: { discipline: '物理' } };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(false);
  });

  it('trace_id 非 uuid → 失败', () => {
    expect(dispatchContractSchema.safeParse({ ...validDispatch(), trace_id: 'abc' }).success).toBe(false);
  });
});

describe('DispatchContract · 契约未封闭处必须保持宽松', () => {
  it('intent 上额外的键 → 合法（契约未写 additionalProperties: false）', () => {
    const contract = {
      ...validDispatch(),
      intent: { action: 'find_mentor', confidence: 0.87, raw_utterance: '帮我找钙钛矿导师' },
    };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(true);
  });

  it('workflow 步骤上额外的键 → 合法（如 trace 扩展、cost 估算）', () => {
    const contract = validDispatch();
    const step = contract.workflow[0] as Record<string, unknown>;
    step['estimated_cost_usd'] = 0.002;
    step['retry_count'] = 0;
    expect(dispatchContractSchema.safeParse(contract).success).toBe(true);
  });

  it('input_payload 内任意嵌套结构 → 合法', () => {
    const contract = validDispatch();
    (contract.workflow[0] as Record<string, unknown>)['input_payload'] = {
      nested: { deeply: { anything: [1, 2, 3] } },
      nullable: null,
    };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(true);
  });

  it('intent.parameters 内任意结构 → 合法', () => {
    const contract = {
      ...validDispatch(),
      intent: { action: 'a', parameters: { keywords: ['x'], limit: 5, nested: { ok: true } } },
    };
    expect(dispatchContractSchema.safeParse(contract).success).toBe(true);
  });
});

describe('topologicalSortSteps · DAG 拓扑排序', () => {
  it('依赖乱序时按依赖关系排序', () => {
    const steps = [
      { step_id: 3, service_name: 'c', model_tier: 'local', status: 'pending', depends_on: [2] },
      { step_id: 1, service_name: 'a', model_tier: 'flash', status: 'pending' },
      { step_id: 2, service_name: 'b', model_tier: 'pro', status: 'pending', depends_on: [1] },
    ] as never;
    expect(topologicalSortSteps(steps).map((s) => s.step_id)).toEqual([1, 2, 3]);
  });

  it('无依赖时按 step_id 升序（结果确定）', () => {
    const steps = [
      { step_id: 2, service_name: 'b', model_tier: 'pro', status: 'pending' },
      { step_id: 1, service_name: 'a', model_tier: 'flash', status: 'pending' },
    ] as never;
    expect(topologicalSortSteps(steps).map((s) => s.step_id)).toEqual([1, 2]);
  });

  it('菱形依赖：1 → (2,3) → 4', () => {
    const steps = [
      { step_id: 4, service_name: 'd', model_tier: 'pro', status: 'pending', depends_on: [2, 3] },
      { step_id: 2, service_name: 'b', model_tier: 'pro', status: 'pending', depends_on: [1] },
      { step_id: 3, service_name: 'c', model_tier: 'pro', status: 'pending', depends_on: [1] },
      { step_id: 1, service_name: 'a', model_tier: 'flash', status: 'pending' },
    ] as never;
    const order = topologicalSortSteps(steps).map((s) => s.step_id);
    expect(order[0]).toBe(1);
    expect(order[3]).toBe(4);
    expect(order.slice(1, 3).sort()).toEqual([2, 3]);
  });

  it('空 workflow → 空结果', () => {
    expect(topologicalSortSteps([])).toEqual([]);
  });

  it('环依赖 → 抛错（不静默丢步骤）', () => {
    const steps = [
      { step_id: 1, service_name: 'a', model_tier: 'flash', status: 'pending', depends_on: [2] },
      { step_id: 2, service_name: 'b', model_tier: 'pro', status: 'pending', depends_on: [1] },
    ] as never;
    expect(() => topologicalSortSteps(steps)).toThrow(/cyclic/);
  });

  it('依赖不存在的 step_id → 抛错', () => {
    const steps = [
      { step_id: 1, service_name: 'a', model_tier: 'flash', status: 'pending', depends_on: [99] },
    ] as never;
    expect(() => topologicalSortSteps(steps)).toThrow(/unknown step_id/);
  });

  it('重复 step_id → 抛错', () => {
    const steps = [
      { step_id: 1, service_name: 'a', model_tier: 'flash', status: 'pending' },
      { step_id: 1, service_name: 'b', model_tier: 'pro', status: 'pending' },
    ] as never;
    expect(() => topologicalSortSteps(steps)).toThrow(/duplicate/);
  });

  it('真实契约里两步 DAG 能排出来', () => {
    expect(topologicalSortSteps(validDispatch().workflow as never).map((s) => s.step_id)).toEqual([1, 2]);
  });

  it('uuid 常量与 fixture 一致，确保样本没被改坏', () => {
    expect(validDispatch().trace_id).toBe(UUID_B);
  });
});
