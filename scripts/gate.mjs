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

// ───────────────────── 4. 生产构建（CSS / 打包管线）─────────────────────
// 为什么需要这一步：
// typecheck 只看类型，抓不到 CSS 语法、打包器配置、静态生成期错误。
// 实际踩过：instrument-ui 的 base.css 块注释里写了 "aria-" + 星号 + "/role"，
// 其中星号紧跟斜杠构成了块注释终止符，提前结束了注释，让后续中文被当成
// 选择器，cssnano 压缩时抛 "Unexpected '/'"，导致 next build 失败——
// 而当时 typecheck 是 25/25 全绿的。
//
// 默认跳过（慢，1-2 分钟），用 --full 显式开启。
if (!QUICK && process.argv.includes('--full')) {
  section('生产构建（turbo build）');
  const r = run('build', 'npx', ['turbo', 'run', 'build', '--continue'], {
    shell: process.platform === 'win32',
  });
  const text = r.out;
  const m = text.match(/Tasks:\s+(\d+) successful,\s+(\d+) total/);
  if (m) {
    const [, ok, total] = m;
    if (ok === total) pass(`build ${ok}/${total} 通过`);
    else {
      fail(`build ${ok}/${total}（${total - ok} 个失败）`);
      const errs = text.split('\n').filter((l) => /error|Error:/.test(l)).slice(0, 10);
      if (errs.length) console.log(errs.join('\n'));
    }
  } else if (r.ok) {
    pass('build 完成');
  } else {
    fail('build 未通过');
    console.log(text.split('\n').slice(-20).join('\n'));
  }
} else {
  console.log(`\n${C.d}（默认跳过生产构建；用 --full 开启，能抓到 CSS/打包管线错误）${C.x}`);
}

// ───────────────────── 5. Python 语法 ─────────────────────
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
