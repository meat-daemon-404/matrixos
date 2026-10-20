#!/usr/bin/env node
/**
 * 构建后配置/产物断言 —— 确认没有站点被留在「静态导出模式」。
 *
 * ── 为什么需要（2026-10-20 真实事故，发生了两次） ────────────────────────────
 * `scripts/build-static-site.mjs` 对每个站做「备份 next.config.ts →
 * 覆盖成 output:'export' 模板 → next build → finally 恢复」。
 * 这套流程只在**进程正常走完 finally** 时安全。
 *
 * 实测事故：构建进程在 03-grant-audit / 08-lab-kanban 的 `Collecting build traces`
 * 阶段被中断（**不是构建失败** —— 日志里没有任何错误，是进程被杀），finally 没跑 →
 *   该站 next.config.ts 被留在 output:'export' 模板（**静默丢掉 CSP frame-ancestors**）
 *   + 残留 next.config.ts.deploybak
 *
 * 这类污染是**静默**的：dev server 与 typecheck 照常能跑，只是安全边界没了；
 * 而 `.deploybak` 若被 gitignore，git status 也看不出来。所以必须显式断言。
 *
 * 用法：
 *   node scripts/assert-config-restored.mjs            # 只断言，有问题退出码 1
 *   node scripts/assert-config-restored.mjs --repair   # 先用 .deploybak 自动恢复，再断言
 *
 * 建议接进 gate.mjs：构建/部署之后跑一次，防止把「裸奔的 next.config.ts」提交上去。
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const HUB = join(ROOT, 'apps', 'orbital-hub');

const problems = [];
const rows = [];
const repaired = [];
const DO_REPAIR = process.argv.includes('--repair');

const siteDirs = existsSync(MICRO)
  ? readdirSync(MICRO, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
    .map((d) => d.name)
  : [];

/**
 * 自动修复：构建进程被中途杀掉时，build-static-site 的 finally 没跑，
 * 会把某站 next.config.ts 留在 output:'export' 模板（静默丢掉 CSP）。
 * 这里用同目录的 .deploybak 恢复。
 */
function repairPolluted() {
  for (const site of siteDirs) {
    const cfg = join(MICRO, site, 'next.config.ts');
    const bak = join(MICRO, site, 'next.config.ts.deploybak');
    if (!existsSync(cfg) || !existsSync(bak)) continue;
    if (!/output:\s*['"]export['"]/.test(readFileSync(cfg, 'utf8'))) continue;
    writeFileSync(cfg, readFileSync(bak));
    rmSync(bak, { force: true });
    const now = readFileSync(cfg, 'utf8');
    repaired.push({
      site,
      frameAncestors: /frame-ancestors/.test(now),
      stillExport: /output:\s*['"]export['"]/.test(now),
    });
  }
}

function checkConfig(label, cfgPath, mustHaveFrameAncestors) {
  if (!existsSync(cfgPath)) {
    problems.push(`${label}: next.config.ts 不存在（${cfgPath}）`);
    rows.push({ label, exists: false });
    return;
  }
  const src = readFileSync(cfgPath, 'utf8');
  const hasExport = /output:\s*['"]export['"]/.test(src);
  const hasFrameAncestors = /frame-ancestors/.test(src);
  rows.push({ label, exists: true, hasExport, hasFrameAncestors });

  if (hasExport) {
    problems.push(`${label}: next.config.ts 仍是 output:'export' 模板 → finally 未恢复（静默污染）`);
  }
  if (mustHaveFrameAncestors && !hasFrameAncestors) {
    problems.push(`${label}: next.config.ts 丢失 frame-ancestors → CSP 安全边界被删`);
  }
}

if (DO_REPAIR) repairPolluted();

/* 1. 18 个微站：原配置必须有 frame-ancestors（CSP 由 headers() 下发） */
for (const site of siteDirs) {
  checkConfig(site, join(MICRO, site, 'next.config.ts'), true);
}

/* 2. 备份残留：build-static-site 成功恢复时会删掉 .deploybak */
const residue = [];
for (const site of siteDirs) {
  const bak = join(MICRO, site, 'next.config.ts.deploybak');
  if (existsSync(bak)) residue.push(bak.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
}
if (residue.length) {
  problems.push(`残留 ${residue.length} 个 next.config.ts.deploybak：${residue.join(', ')}`);
}

/* 3. 产物完整性：每个站 out/index.html 必须在 */
const missingOut = siteDirs.filter((s) => !existsSync(join(MICRO, s, 'out', 'index.html')));
if (missingOut.length) problems.push(`out/index.html 缺失的站（部署会直接失败）：${missingOut.join(', ')}`);

/* 4. 微站 out/_headers 必须带 frame-ancestors（静态托管层的 CSP） */
const missingHeadersCsp = [];
for (const site of siteDirs) {
  const h = join(MICRO, site, 'out', '_headers');
  if (!existsSync(h)) { missingHeadersCsp.push(site + '(无_headers)'); continue; }
  if (!/frame-ancestors/.test(readFileSync(h, 'utf8'))) missingHeadersCsp.push(site + '(无frame-ancestors)');
}
if (missingHeadersCsp.length) problems.push(`out/_headers 缺 CSP frame-ancestors：${missingHeadersCsp.join(', ')}`);

/* 5. hub：配置 + placeholder + 产物 + 安全头对齐 */
checkConfig('orbital-hub', join(HUB, 'next.config.ts'), false);
if (existsSync(join(HUB, 'src', 'app', '__placeholder.disabled'))) {
  problems.push('orbital-hub: __placeholder.disabled 残留 → build-hub-static 的 finally 未恢复');
}
if (!existsSync(join(HUB, 'out', 'index.html'))) problems.push('orbital-hub: out/index.html 缺失');

const hubHeadersPath = join(HUB, 'out', '_headers');
if (existsSync(hubHeadersPath)) {
  /**
   * 只认「真正的 HTTP 头行」（形如 `  Header-Name: value`）。
   * 实测踩坑：初版直接对整个文件做 /frame-ancestors/ 匹配，结果命中了我自己写在
   * 注释里的那句「hub 不设 CSP frame-ancestors」，把「正确地没加」判成「误加」。
   * 注释里出现关键词是常态，断言必须只看指令行。
   */
  const headerDirectives = readFileSync(hubHeadersPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\s+[A-Za-z][A-Za-z0-9-]*:\s/.test(l))
    .join('\n');

  if (!/Strict-Transport-Security/i.test(headerDirectives)) {
    problems.push('orbital-hub: out/_headers 缺 Strict-Transport-Security（与微站安全头不同源）');
  }
  if (!/Permissions-Policy/i.test(headerDirectives)) {
    problems.push('orbital-hub: out/_headers 缺 Permissions-Policy');
  }
  if (/frame-ancestors/i.test(headerDirectives)) {
    problems.push('orbital-hub: out/_headers 误加 frame-ancestors（hub 是顶层页，不应限制自己被嵌）');
  }
}

/* ── 报告 ── */
console.log('══ 构建后配置/产物断言 ══\n');
if (DO_REPAIR && repaired.length) {
  console.log(`🔧 --repair：已从 .deploybak 恢复 ${repaired.length} 个被污染的站`);
  for (const r of repaired) {
    console.log(`   · ${r.site}  frame-ancestors=${r.frameAncestors ? '✓' : '✗'} 残留export=${r.stillExport ? '✗' : '✓'}`);
  }
  console.log('');
}
console.log('站'.padEnd(24) + 'output:export'.padEnd(16) + 'frame-ancestors');
for (const r of rows) {
  if (!r.exists) { console.log(r.label.padEnd(24) + '(缺失)'); continue; }
  console.log(r.label.padEnd(24) + (r.hasExport ? '✗ EXPORT!' : '✓ ok').padEnd(16) + (r.hasFrameAncestors ? '✓' : '✗'));
}

console.log('');
if (problems.length) {
  console.log(`✗ 断言失败 ${problems.length} 项：`);
  for (const p of problems) console.log('   · ' + p);
  process.exit(1);
}
console.log(`✓ 断言全部通过：${siteDirs.length} 个微站 + hub，无 export 残留 / 无 deploybak / 无 placeholder 残留 / 产物齐全 / CSP 与安全头完整`);
process.exit(0);
