#!/usr/bin/env node
/**
 * 契约漂移锁：`specs/contracts/*.schema.json` 的规范化哈希必须与锁文件一致。
 *
 * 为什么需要它（Issue #4 / S1-04）：
 *   `packages/matrix-sdk/src/contracts/schemas.ts` 内嵌了冻结契约的逐字副本，
 *   `types.ts:19` 与 `schemas.ts:9` 都声称由 `test/contracts.conformance.test.ts`
 *   做深度相等断言——但**该测试文件此前在 main 上并不存在**。
 *   结果是：改了 `specs/contracts/` 而没同步内嵌副本，什么都不会变红。
 *   这正是「契约漂移要等上线才发现」的那个洞。
 *
 * 两道防线，各管一类漂移：
 *
 *   1. 语义漂移（内嵌副本 ≠ 冻结契约）
 *      → `packages/matrix-sdk/test/contracts.conformance.test.ts`
 *        直接 import 内嵌副本与 JSON 原文做深度相等断言，随 `pnpm test` 跑。
 *
 *   2. 契约本体被改动（冻结 ≠ 锁）
 *      → 本脚本。契约是**已冻结**的：任何字段增删改都必须显式重新生成锁，
 *        并在 PR 里走 `type:spec` 评审。没有这一步，本检查红。
 *
 * 检查 2 不能由检查 1 代替：把 schema 与副本同时改掉时，检查 1 依然全绿；
 * 只有「冻结件哈希」能察觉契约本身被动了。
 *
 * 用法：
 *   node scripts/check-contract-drift.mjs              校验（CI / pre-commit）
 *   node scripts/check-contract-drift.mjs --repair     重新生成锁（改完契约后跑）
 *   node scripts/check-contract-drift.mjs --verbose    列出每份契约的哈希与镜像状态
 *
 * 无第三方依赖。锁文件：specs/contracts/.drift-lock.json
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'specs', 'contracts');
const LOCK = join(CONTRACTS, '.drift-lock.json');
const MIRROR = join(ROOT, 'packages', 'matrix-sdk', 'src', 'contracts', 'schemas.ts');

const REPAIR = process.argv.includes('--repair');
const VERBOSE = process.argv.includes('--verbose');

/** 递归键排序后序列化——哈希与键顺序无关，只对内容敏感。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** 找出 schemas.ts 里 `export const X = {...}` 的镜像名，用于报告覆盖情况。 */
function mirroredNames() {
  if (!existsSync(MIRROR)) return new Set();
  const src = readFileSync(MIRROR, 'utf8');
  const set = new Set();
  for (const m of src.matchAll(/'([a-z-]+)':\s*\w+_SCHEMA\b/g)) set.add(m[1]);
  return set;
}

const files = readdirSync(CONTRACTS).filter((f) => f.endsWith('.schema.json')).sort();
if (files.length === 0) {
  console.error('  ✗ specs/contracts/ 下没有 *.schema.json');
  process.exit(1);
}

const current = {};
for (const f of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(CONTRACTS, f), 'utf8'));
  } catch (e) {
    console.error(`  ✗ ${f}: JSON 解析失败 —— ${e.message}`);
    process.exit(1);
  }
  current[f] = { hash: sha(canonical(doc)), title: doc.title || f };
}

if (REPAIR) {
  const payload = {
    '_comment': 'specs/contracts/*.schema.json 的规范化哈希锁。改契约 = 合规红线流程：'
      + '开 type:spec Issue → PR 同步内嵌副本（packages/matrix-sdk/src/contracts/schemas.ts）'
      + '→ 跑 `node scripts/check-contract-drift.mjs --repair` 重新生成此文件。'
      + '校验入口：node scripts/check-contract-drift.mjs（已接入 pnpm check / pre-commit）',
    '_canonical': 'sha256 over 递归键排序后的 JSON（与键顺序无关，仅对内容敏感）',
    '_generated_by:': 'scripts/check-contract-drift.mjs --repair',
    contracts: current,
  };
  writeFileSync(LOCK, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`  ✓ 锁已重新生成：${relative(ROOT, LOCK)}（${files.length} 份契约）`);
  if (VERBOSE) for (const [f, v] of Object.entries(current)) console.log(`      ${f}  ${v.hash.slice(0, 16)}…`);
  process.exit(0);
}

if (!existsSync(LOCK)) {
  console.error('  ✗ 锁文件不存在：specs/contracts/.drift-lock.json');
  console.error('    改完契约后跑：node scripts/check-contract-drift.mjs --repair');
  process.exit(1);
}

let lock;
try {
  lock = JSON.parse(readFileSync(LOCK, 'utf8'));
} catch (e) {
  console.error(`  ✗ 锁文件解析失败 —— ${e.message}`);
  process.exit(1);
}

const locked = lock.contracts || {};
const drifted = [];
const added = [];
const removed = [];

for (const [f, v] of Object.entries(current)) {
  if (!(f in locked)) added.push(f);
  else if (locked[f].hash !== v.hash) drifted.push(f);
}
for (const f of Object.keys(locked)) if (!(f in current)) removed.push(f);

const mirror = mirroredNames();
const mirroredCount = files.filter((f) => mirror.has(f.replace(/\.schema\.json$/, ''))).length;

console.log(`  契约 ${files.length} 份，其中内嵌进 SDK 副本的 ${mirroredCount} 份`);

if (added.length) for (const f of added) console.log(`  ✗ 新增契约未入锁：${f}`);
if (removed.length) for (const f of removed) console.log(`  ✗ 契约被删除但仍留在锁里：${f}`);
if (drifted.length) {
  for (const f of drifted) {
    console.log(`  ✗ 契约内容与锁不一致：${f}`);
    console.log(`      锁内 ${locked[f].hash.slice(0, 16)}…  当前 ${current[f].hash.slice(0, 16)}…`);
  }
}

const bad = added.length + removed.length + drifted.length;
if (bad) {
  console.log('');
  console.log(`  ✗ 契约漂移检查未通过（${bad} 处）。`);
  console.log('    这些 schema 是**已冻结**的跨微站硬约束。要改必须：');
  console.log('      1) 开 Issue 打 type:spec，说明影响哪些微站（见 CONTRIBUTING 第六节）');
  console.log('      2) 同一 PR 同步 packages/matrix-sdk/src/contracts/schemas.ts 内嵌副本');
  console.log('         与 packages/twin-schema 的 zod 校验器（语义子集，需人工判断，不能机械复制）');
  console.log('      3) node scripts/check-contract-drift.mjs --repair   // 重新入锁');
  console.log('      4) breaking change 另按 CONTRIBUTING 第六节登记迁移窗口');
  process.exit(1);
}

if (VERBOSE) {
  for (const [f, v] of Object.entries(current)) {
    const m = mirror.has(f.replace(/\.schema\.json$/, '')) ? '已镜像' : '未镜像（仅服务端消费）';
    console.log(`      ${f}  ${v.hash.slice(0, 16)}…  ${m}`);
  }
}
console.log(`  ✓ ${files.length} 份冻结契约与锁一致，无漂移`);
