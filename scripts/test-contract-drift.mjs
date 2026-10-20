#!/usr/bin/env node
/**
 * 契约漂移护栏的红→绿自检（可复现证据，Issue #4 验收物）。
 *
 * 票 #4 的验收句是：「故意改一个 schema 字段不同步生成物，CI 必须红；补齐后转绿。
 * 录制两次结果作为证据」。这个脚本把那句话变成**每次都能重跑的断言**，
 * 而不是某一次贴上去的日志——日志会腐烂，能跑的测试不会。
 *
 * 覆盖三类场景（缺一类都算护栏有洞）：
 *   A. 改冻结契约本体、不同步任何生成物   → 漂移锁红 + 一致性测试红
 *   B. 契约没动、只有 SDK 内嵌副本漂了      → 漂移锁绿 + 一致性测试红
 *   C. 恢复原样                            → 两边都绿
 *   D. 现状记录：旧 validate-specs [4/5] 对同一处弱化仍是绿（假绿，见 Issue #31）
 *
 * 安全性：改前做**字节快照**，finally 无条件按字节恢复（不走 git checkout，
 * 免得误丢别人的改动）；注入点出现次数必须恰好为 1，否则立刻中止且不动文件。
 * 中文文件绝不经过 PowerShell 文本管道（CONTRIBUTING 编码红线）。
 *
 * 用法：node scripts/test-contract-drift.mjs
 * 退出码：0 = 所有断言符合预期；1 = 有护栏失守
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = join(ROOT, 'specs', 'contracts', 'wormhole-envelope.schema.json');
const MIRROR = join(ROOT, 'packages', 'matrix-sdk', 'src', 'contracts', 'schemas.ts');

/** 注入点：合规红线字段 `evidence_anchors.minItems`（1 = 至少一条证据锚点）。 */
const INJECT = {
  [CONTRACT]: { from: '"minItems": 1', to: '"minItems": 0' },
  [MIRROR]: { from: 'minItems: 1,', to: 'minItems: 0,' },
};

const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const drift = () => run(['scripts/check-contract-drift.mjs']);
const conform = () => run(['--test', 'packages/matrix-sdk/test/contracts.conformance.test.ts']);
const legacy = () => run(['scripts/validate-specs.mjs']);

const snapshot = new Map();
for (const f of [CONTRACT, MIRROR]) snapshot.set(f, Buffer.from(readFileSync(f)));

const restore = () => {
  for (const [f, buf] of snapshot) {
    if (!readFileSync(f).equals(buf)) writeFileSync(f, buf);
  }
};
const isClean = () => [...snapshot].every(([f, buf]) => readFileSync(f).equals(buf));

function inject(file) {
  const { from, to } = INJECT[file];
  const src = readFileSync(file, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`${relative(ROOT, file)} 注入点 "${from}" 出现 ${n} 次（要求恰好 1），已中止且未改动文件`);
  writeFileSync(file, src.replace(from, to), 'utf8');
}

let failures = 0;
const results = [];
const expect = (label, wantRed, r) => {
  const gotRed = r.code !== 0;
  const ok = gotRed === wantRed;
  if (!ok) failures++;
  const detail = r.out.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-3).join('\n    ');
  results.push(`${ok ? '✓' : '✗'} [期望${wantRed ? '红' : '绿'}] ${label}  实际 exit=${r.code}`);
  results.push(`      ${detail.split('\n').join('\n      ')}`);
};

console.log('\n契约漂移护栏自检');
console.log('─'.repeat(56));

try {
  restore(); // 起点强制干净

  console.log('\n▶ 基线（未注入）');
  expect('漂移锁', false, drift());
  expect('一致性测试', false, conform());

  console.log('\n▶ 情形 A：改冻结契约本体（evidence_anchors.minItems 1→0），不同步生成物');
  console.log('   —— 这正是 CONTRIBUTING 第六节禁止的弱化，也是 #4 验收句的场景');
  inject(CONTRACT);
  expect('漂移锁必须红', true, drift());
  expect('一致性测试必须红（副本还是 1）', true, conform());
  // 记录现状而非修它：#31 单独跟踪这个假绿
  expect('旧 validate-specs [4/5] 仍绿（已知假绿 → Issue #31）', false, legacy());

  console.log('\n▶ 情形 B：契约不动，只有 SDK 内嵌副本漂了');
  restore();
  inject(MIRROR);
  expect('漂移锁保持绿（schema 文件本身没改）', false, drift());
  expect('一致性测试必须红（副本≠契约）', true, conform());

  console.log('\n▶ 情形 C：全部恢复');
  restore();
  expect('漂移锁回绿', false, drift());
  expect('一致性测试回绿', false, conform());
  expect('旧 validate-specs 回绿', false, legacy());
} catch (e) {
  failures++;
  results.push(`✗ 自检异常中止：${e.message}`);
} finally {
  restore();
  const clean = isClean();
  if (!clean) {
    failures++;
    results.push('✗ 严重：注入未被完全恢复，请检查 ' + [CONTRACT, MIRROR].map((f) => relative(ROOT, f)).join(' / '));
  } else {
    results.push('✓ 注入已按字节完全恢复，工作区无残留');
  }
}

console.log('\n' + results.join('\n'));
console.log('\n' + '─'.repeat(56));
if (failures) {
  console.error(`✗ 护栏自检 ${failures} 项不符合预期`);
  process.exit(1);
}
console.log('✓ 护栏自检全部符合预期（红→绿可逆，注入已清理）');
