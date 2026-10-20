#!/usr/bin/env node
/**
 * 单一校验入口。GitHub Actions 因账户计费跑不起来（BLK-001），本地钩子是唯一强制门禁。
 *
 * 用法：
 *   node scripts/verify.mjs            # 全量校验（契约 + 漂移锁 + 文档链接 + 编码）
 *   node scripts/verify.mjs --staged   # 兼容旧入口，当前与全量一致
 *
 * 退出码：0 = 通过，1 = 有错误
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGED = process.argv.includes('--staged');

const bar = '─'.repeat(56);

console.log('\nMatrixOS 校验' + (STAGED ? '（暂存区模式）' : '（全量）'));
console.log(bar);

const steps = [
  ['契约与编码校验', 'validate-specs.mjs'],
  ['契约漂移锁（冻结 schema vs 哈希锁）', 'check-contract-drift.mjs'],
  ['文档内部链接检查', 'check-doc-links.mjs'],
];

let failed = 0;

for (const [label, script] of steps) {
  process.stdout.write(`\n▶ ${label}\n`);
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 只回显结果的最后几行，避免刷屏
    const lines = out.trimEnd().split(/\r?\n/);
    const tail = lines.slice(-4).join('\n');
    console.log(tail);
  } catch (e) {
    failed++;
    const out = (e.stdout || '') + (e.stderr || '');
    if (out) console.log(out.trimEnd());
    console.error(`✗ ${label} 未通过`);
  }
}

console.log('\n' + bar);
if (failed > 0) {
  console.log(`✗ ${failed}/${steps.length} 项校验未通过`);
  console.log('\n修复后再提交。若确认是误报，可用 git commit --no-verify 跳过钩子。');
  process.exit(1);
}
console.log(`✓ 全部 ${steps.length} 项校验通过`);
if (!STAGED) {
  console.log('\n提示：安装提交前自动校验钩子 → node scripts/install-hooks.mjs');
}
