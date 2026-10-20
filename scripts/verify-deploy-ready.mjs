#!/usr/bin/env node
/**
 * 部署前 / 部署后的**一键全链验收**。
 *
 * 为什么需要它：
 *   本轮做了 8 条线的修复（P1 空白 / P4 塌陷 / ADR-08 不滚 / 紧凑布局 /
 *   layout.resize / metadata / preflight / 审计脚本），验收点分散在 6 个脚本里。
 *   部署前后各跑一次，能一次看清「哪些达标、哪些没达标、哪些是并行会话的在制干扰」。
 *
 * 用法：
 *   node scripts/verify-deploy-ready.mjs            # 部署前体检（构建/配置/产物/源码）
 *   node scripts/verify-deploy-ready.mjs --online   # 部署后线上复验（需要网络）
 *
 * 退出码：0 可部署 / 1 有阻塞项
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ONLINE = process.argv.includes('--online');
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };
const bar = '─'.repeat(66);

let blocked = 0;
let warned = 0;

function section(title) {
  console.log(`\n${C.d}${bar}${C.x}\n▶ ${title}`);
}
function ok(msg) { console.log(`  ${C.g}✓${C.x} ${msg}`); }
function bad(msg) { blocked += 1; console.log(`  ${C.r}✗${C.x} ${msg}`); }
function warn(msg) { warned += 1; console.log(`  ${C.y}!${C.x} ${msg}`); }

function run(label, cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}${e.message || ''}` };
  }
}

const MICRO = join(ROOT, 'apps', 'micro-sites');
const sites = readdirSync(MICRO, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name)).map((d) => d.name).sort();

// ═══════════════════════════════════════════════════════
// 1. 配置未残留（构建中断的最低成本事故）
// ═══════════════════════════════════════════════════════
section('1. next.config.ts 未被留在 export 模式 / 无 deploybak 残留');
{
  const polluted = [];
  const bak = [];
  for (const s of sites) {
    const cfg = join(MICRO, s, 'next.config.ts');
    if (existsSync(cfg) && /output:\s*['"]export['"]/.test(readFileSync(cfg, 'utf8'))) polluted.push(s);
    if (existsSync(join(MICRO, s, 'next.config.ts.deploybak'))) bak.push(s);
  }
  if (polluted.length) bad(`被留在 export 模式的站（会丢 CSP）：${polluted.join(', ')}`);
  else ok('18 站 next.config.ts 均未处于 export 模式');
  if (bak.length) warn(`deploybak 残留（构建进行中？）：${bak.join(', ')}`);
  else ok('无 deploybak 残留');
}

// ═══════════════════════════════════════════════════════
// 2. 产物完整性
// ═══════════════════════════════════════════════════════
section('2. 产物完整性（out/index.html + out/_headers CSP）');
{
  const noHtml = [];
  const noCsp = [];
  for (const s of sites) {
    if (!existsSync(join(MICRO, s, 'out', 'index.html'))) noHtml.push(s);
    const h = join(MICRO, s, 'out', '_headers');
    if (!existsSync(h) || !/frame-ancestors/.test(readFileSync(h, 'utf8'))) noCsp.push(s);
  }
  if (noHtml.length) bad(`缺 out/index.html（部署会失败）：${noHtml.join(', ')}`);
  else ok('18 站 out/index.html 齐全');
  if (noCsp.length) bad(`out/_headers 缺 CSP frame-ancestors：${noCsp.join(', ')}`);
  else ok('18 站 out/_headers 均含 CSP frame-ancestors');
}

// ═══════════════════════════════════════════════════════
// 3. 本轮修复是否都在产物里（源码有 ≠ 产物有）
// ═══════════════════════════════════════════════════════
section('3. 本轮修复是否已进入产物（重建过才有）');
{
  const checks = [
    { name: 'P1 · .iu-sr-only 压制', re: /max-height:1px/ },
    { name: 'E线 · ADR-08 双层 overflow（html:has）', re: /html:has\(body/ },
    { name: 'G线 · 紧凑布局（meta-grid/footer 隐藏）', re: /meta-grid[^{]*\{[^}]*display:none/ },
  ];
  for (const chk of checks) {
    const hit = [];
    const missing = [];
    for (const s of sites) {
      const cssDir = join(MICRO, s, 'out', '_next', 'static', 'css');
      if (!existsSync(cssDir)) { missing.push(s); continue; }
      let found = false;
      for (const f of readdirSync(cssDir)) {
        if (!f.endsWith('.css')) continue;
        if (chk.re.test(readFileSync(join(cssDir, f), 'utf8'))) { found = true; break; }
      }
      if (found) hit.push(s); else missing.push(s);
    }
    if (missing.length) warn(`${chk.name}：${hit.length}/${sites.length} 站产物含（缺：${missing.join(', ')}）`);
    else ok(`${chk.name}：${sites.length}/${sites.length} 站产物含`);
  }
}

// ═══════════════════════════════════════════════════════
// 4. 源码侧修复是否在位（不依赖产物）
// ═══════════════════════════════════════════════════════
section('4. 源码侧修复在位性');
{
  let sr = 0, eh = 0, mg = 0, sf = 0;
  for (const s of sites) {
    const css = join(MICRO, s, 'src', 'app', 'globals.css');
    if (!existsSync(css)) continue;
    const c = readFileSync(css, 'utf8');
    if (/max-height: 1px/.test(c)) sr += 1;
    if (/html:has\(body/.test(c)) eh += 1;
    if (/meta-grid \{ display: none/.test(c)) mg += 1;
    if (/site-footer \{ display: none/.test(c)) sf += 1;
  }
  const checks = [
    ['P1 .iu-sr-only 压制', sr],
    ['E线 html:has 双层', eh],
    ['G线 meta-grid 隐藏', mg],
    ['G线 site-footer 隐藏', sf],
  ];
  for (const [name, n] of checks) {
    if (n === 18) ok(`${name}：18/18`);
    else bad(`${name}：${n}/18（源码不一致）`);
  }
  // 生成器模板同源（防 pnpm gen:site --force 冲掉）
  const gen = readFileSync(join(ROOT, 'scripts', 'gen-site.mjs'), 'utf8');
  const genChecks = [
    ['模板含 meta-grid 隐藏', /meta-grid \{ display: none/],
    ['模板含 site-footer 隐藏', /site-footer \{ display: none/],
    ['模板含 html:has 双层', /html:has\(body/],
    ['模板含 .iu-sr-only 压制', /max-height: 1px/],
  ];
  for (const [name, re] of genChecks) {
    if (re.test(gen)) ok(`gen-site.mjs ${name}`);
    else warn(`gen-site.mjs 缺 ${name}（pnpm gen:site --force 会冲掉对应修复）`);
  }
}

// ═══════════════════════════════════════════════════════
// 5. layout.resize 协议在位（H 线）
// ═══════════════════════════════════════════════════════
section('5. layout.resize 协议（iframe 高度自适应）');
{
  const files = [
    ['SDK 发送侧 resize.ts', 'packages/matrix-sdk/src/iframe/resize.ts'],
    ['SDK 单测 resize.test.ts', 'packages/matrix-sdk/test/resize.test.ts'],
    ['hub 决策 panel-resize.ts', 'apps/orbital-hub/src/lib/panel-resize.ts'],
    ['hub 接线 use-panel-resize.ts', 'apps/orbital-hub/src/lib/use-panel-resize.ts'],
  ];
  for (const [name, rel] of files) {
    if (existsSync(join(ROOT, rel))) ok(`${name} 存在`);
    else bad(`${name} 缺失`);
  }
  const panel = join(ROOT, 'apps/orbital-hub', 'src', 'components', 'InstrumentPanel.tsx');
  if (existsSync(panel) && /usePanelResize/.test(readFileSync(panel, 'utf8'))) ok('InstrumentPanel 已接线 usePanelResize');
  else bad('InstrumentPanel 未接线 usePanelResize');
  // Bridge 两个 bug 是否已修
  const bridge = readFileSync(join(ROOT, 'packages', 'matrix-sdk', 'src', 'iframe', 'bridge.ts'), 'utf8');
  if (/tenantWindow/.test(bridge)) ok('Bridge bug A（host 发不到 iframe）已修：tenantWindow');
  else bad('Bridge bug A 未修');
  const types = readFileSync(join(ROOT, 'packages', 'matrix-sdk', 'src', 'types.ts'), 'utf8');
  if (/referrer/.test(types)) ok('Bridge bug B（tenant 解析不出 host origin）已修：referrer');
  else bad('Bridge bug B 未修');
}

// ═══════════════════════════════════════════════════════
// 6. 编码 / 契约 / 文档
// ═══════════════════════════════════════════════════════
section('6. 契约 / 编码 / 文档断链');
{
  const v = run('validate', process.execPath, [join(ROOT, 'scripts', 'validate-specs.mjs')]);
  if (v.ok) ok('validate-specs 通过'); else bad('validate-specs 未通过');
  const d = run('links', process.execPath, [join(ROOT, 'scripts', 'check-doc-links.mjs')]);
  if (d.ok) ok('文档无断链'); else bad('文档有断链');
}

// ═══════════════════════════════════════════════════════
// 7. （--online）线上复验
// ═══════════════════════════════════════════════════════
if (ONLINE) {
  section('7. 线上复验（ADR-08 / P1 / P4）');
  console.log(`  ${C.d}跑 node scripts/audit-online.mjs 获取完整线上数字${C.x}`);
  const a = run('audit', process.execPath, [join(ROOT, 'scripts', 'audit-online.mjs')]);
  if (a.ok) {
    const tail = a.out.split('\n').filter((l) => /P1 |P4 |ADR-08|失败|✓|✗/.test(l)).slice(-12);
    console.log(tail.map((l) => '  ' + l).join('\n'));
    ok('线上审计完成（详见上方 / .tmp/audit/）');
  } else {
    bad('线上审计失败（网络或脚本问题）');
  }
}

// ═══════════════════════════════════════════════════════
console.log(`\n${C.d}${bar}${C.x}`);
if (blocked === 0) {
  console.log(`${C.g}✓ 可部署${C.x}${warned ? `（${warned} 条警告，多为并行会话在制产物，可在部署前重建）` : ''}`);
  process.exit(0);
}
console.log(`${C.r}✗ 有 ${blocked} 项阻塞、${warned} 项警告 —— 不要部署${C.x}`);
process.exit(1);
