#!/usr/bin/env node
/**
 * 健康门禁：一次跑完所有可本地验证的检查。
 *
 * 用法：
 *   node scripts/gate.mjs           # 全量
 *   node scripts/gate.mjs --quick   # 跳过 Python 语法扫描（快 3 倍）
 *
 * 检查项：
 *   1. 契约 / 编码 / 注入产物（validate-specs）
 *   2. 文档断链（check-doc-links）
 *   3. TypeScript 全仓 typecheck（turbo）
 *   4. Python 全量语法扫描
 *
 * 与 pre-commit 钩子的区别：钩子只跑 1+2（快），这个跑全套（慢但全）。
 * 建议在合并 PR 前、以及每次大批量并行开发收尾时跑。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };
const bar = '─'.repeat(62);

let failed = 0;
const failures = [];

function section(title) {
  console.log(`\n${C.d}${bar}${C.x}\n▶ ${title}`);
}

function pass(msg) {
  console.log(`  ${C.g}✓${C.x} ${msg}`);
}

function fail(msg) {
  failed++;
  failures.push(msg);
  console.log(`  ${C.r}✗${C.x} ${msg}`);
}

function run(label, cmd, args, opts = {}) {
  // 注意：不要对 python -c 用 shell，否则 cmd.exe 会把脚本里的 `;` 当命令分隔符。
  // 只在确实需要 shell 的调用（npx 等）里显式传 shell: true。
  try {
    const out = execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600000,
      ...opts,
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.message || ''}` };
  }
}

// ───────────────────── 1. 契约 / 编码 / 注入产物 ─────────────────────
section('契约 / 编码 / 注入产物');
{
  const r = run('validate', process.execPath, [join(ROOT, 'scripts', 'validate-specs.mjs')]);
  if (r.ok) pass('validate-specs 通过');
  else {
    fail('validate-specs 未通过');
    console.log(r.out.split('\n').filter((l) => l.includes('✗') || l.includes('- ')).slice(0, 12).join('\n'));
  }
}

// ───────────────────── 2. 文档断链 ─────────────────────
section('文档内部链接');
{
  const r = run('links', process.execPath, [join(ROOT, 'scripts', 'check-doc-links.mjs')]);
  if (r.ok) pass('无断链');
  else {
    fail('存在断链');
    console.log(r.out.split('\n').filter((l) => l.includes('->')).slice(0, 12).join('\n'));
  }
}

// ───────────────────── 3. TypeScript 全仓 ─────────────────────
section('TypeScript typecheck（turbo，全仓）');
{
  // npx 在 Windows 上是 .cmd，需要 shell
  const r = run('typecheck', 'npx', ['turbo', 'run', 'typecheck', '--continue'], {
    shell: process.platform === 'win32',
  });
  // turbo 的输出在 stderr 较多，合并判断
  const text = r.out;
  const m = text.match(/Tasks:\s+(\d+) successful,\s+(\d+) total/);
  if (m) {
    const [, ok, total] = m;
    if (ok === total) pass(`typecheck ${ok}/${total} 通过`);
    else {
      fail(`typecheck ${ok}/${total}（${total - ok} 个失败）`);
      const errs = text.split('\n').filter((l) => /error TS\d+/.test(l)).slice(0, 10);
      if (errs.length) console.log(errs.join('\n'));
    }
  } else if (r.ok) {
    pass('typecheck 完成');
  } else {
    fail('typecheck 未通过');
    console.log(text.split('\n').filter((l) => /error TS\d+/.test(l)).slice(0, 10).join('\n'));
  }
}

// ───────────────────── 4. Python 语法 ─────────────────────
if (QUICK) {
  console.log(`\n${C.d}（--quick：跳过 Python 语法扫描）${C.x}`);
} else {
  section('Python 语法扫描');
  const pyFiles = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (['__pycache__', '.venv', 'venv', 'node_modules', '.git'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.py')) {
        pyFiles.push(p);
      }
    }
  };
  walk(join(ROOT, 'services'));

  let bad = 0;
  for (const f of pyFiles) {
    const r = run('py', 'python', [
      '-c',
      'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())',
      f,
    ]);
    if (!r.ok) {
      bad++;
      fail(`语法错误: ${f.replace(ROOT + '/', '').replace(ROOT + '\\', '')}`);
    }
  }
  if (bad === 0) pass(`Python ${pyFiles.length} 个文件语法全部正确`);
}

// ───────────────────── 汇总 ─────────────────────
console.log(`\n${C.d}${bar}${C.x}`);
if (failed === 0) {
  console.log(`${C.g}✓ 门禁通过${C.x}`);
  process.exit(0);
}
console.log(`${C.r}✗ 门禁失败：${failed} 项${C.x}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
