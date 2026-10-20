/**
 * 契约一致性护栏：SDK 内嵌副本 ↔ 冻结契约 JSON，逐字深度相等。
 *
 * 这个文件被 `src/contracts/schemas.ts:9` 与 `src/contracts/types.ts:19`
 * 两处注释引用为「防漂移机制」，但**此前它并不存在**——于是改 `specs/contracts/`
 * 不同步内嵌副本，什么都不会红（Issue #4 / S1-04 的验收对象）。
 *
 * 分工（两道防线别混）：
 *   - 本文件管**语义漂移**：冻结契约动了，SDK 内嵌副本没跟上 → 这里红。
 *   - `scripts/check-contract-drift.mjs` 管**契约本体被改动**：schema 内容与哈希锁
 *     不一致 → 那边红。两份同时改掉时这里仍然绿，所以要两道。
 *   - `packages/twin-schema` 的 zod 校验器是契约的**语义子集**（顶层 strictObject、
 *     嵌套 looseObject 是刻意的，见 contracts/dispatch-contract.ts 注释），
 *     不能做机械 deep-equal，那部分只能在契约评审里靠人工判断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FROZEN_SCHEMAS } from '../src/contracts/schemas.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTRACTS = join(ROOT, 'specs', 'contracts');

/**
 * 只被服务端消费的契约（没有内嵌到 SDK 的逐字副本）。
 * 新增契约时必须在这里显式登记，否则本测试报错——
 * 逼着加契约的人做一次「要不要内嵌」的决定，而不是默默漏掉。
 */
const SERVER_ONLY_CONTRACTS = ['dispatch-contract', 'morning-brief'];

/** 深度相等：对象键顺序无关；数组按下标严格比（enum 顺序有语义）。 */
function deepEqualIgnoreKeyOrder(a: unknown, b: unknown, path = '$'): string[] {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${path}: 一方是数组另一方不是`];
    const out: string[] = [];
    if (a.length !== b.length) {
      out.push(`${path}: 数组长度 ${a.length} vs ${b.length}`);
      return out;
    }
    for (let i = 0; i < a.length; i++) out.push(...deepEqualIgnoreKeyOrder(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const out: string[] = [];
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      const p = `${path}.${k}`;
      if (!(k in ao)) out.push(`${p}: 仅存在于冻结契约`);
      else if (!(k in bo)) out.push(`${p}: 仅存在于 SDK 内嵌副本`);
      else out.push(...deepEqualIgnoreKeyOrder(ao[k], bo[k], p));
    }
    return out;
  }
  return Object.is(a, b) ? [] : [`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
}

const files = readdirSync(CONTRACTS).filter((f) => f.endsWith('.schema.json')).sort();
const slugs = files.map((f) => f.replace(/\.schema\.json$/, ''));
const known = new Set([...Object.keys(FROZEN_SCHEMAS), ...SERVER_ONLY_CONTRACTS]);

test('specs/contracts 里的每份契约都被显式归类（内嵌或注明仅服务端）', () => {
  const orphans = slugs.filter((s) => !known.has(s));
  assert.deepEqual(orphans, [], `未归类的新契约：${orphans.join(', ')} —— 要么加进 FROZEN_SCHEMAS，要么登记进 SERVER_ONLY_CONTRACTS`);

  const missing = Object.keys(FROZEN_SCHEMAS).filter((s) => !slugs.includes(s));
  assert.deepEqual(missing, [], `FROZEN_SCHEMAS 引用了不存在的契约文件：${missing.join(', ')}`);
});

for (const [slug, mirror] of Object.entries(FROZEN_SCHEMAS)) {
  test(`${slug}: SDK 内嵌副本与冻结契约逐字等价`, () => {
    const file = join(CONTRACTS, `${slug}.schema.json`);
    const frozen = JSON.parse(readFileSync(file, 'utf8'));
    const diffs = deepEqualIgnoreKeyOrder(frozen, mirror);
    assert.deepEqual(diffs, [], `${slug} 漂移 ${diffs.length} 处:\n  ${diffs.slice(0, 20).join('\n  ')}`);
  });
}

test('内嵌副本至少覆盖 2 份契约（防止有人清空 FROZEN_SCHEMAS 让本测试空跑变绿）', () => {
  assert.ok(Object.keys(FROZEN_SCHEMAS).length >= 2, 'FROZEN_SCHEMAS 条目数低于 2，一致性测试已失去意义');
});
