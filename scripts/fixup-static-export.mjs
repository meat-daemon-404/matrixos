#!/usr/bin/env node
/**
 * 静态导出后处理：修复 Next 15.5.28 在 output:'export' 下漏掉根路由 index.html 的 bug。
 *
 * 实测证据（2026-10-20，apps/micro-sites/11-curvelab-fit）：
 *   构建输出：  ✓ Exporting (4/4)   ← 声称全部导出
 *   .next/server/app/index.html   37260 字节  ← 完整首页确实生成了
 *   .next/server/app/_not-found.html 8222 字节
 *   out/404.html                  8222 字节  ← _not-found 成功导出
 *   out/index.html                缺失！      ← 根路由被跳过
 *
 * 同一目录下 _not-found 能导出而 index 不能，排除权限/路径问题，
 * 判定为 Next export 阶段对根路由的处理缺陷。
 *
 * 本脚本作为兜底：把 .next/server/app/ 下所有 *.html 按 Next 的布局规则
 * 复制到 out/，只在 out/ 里缺失时才补（不覆盖已有文件）。
 *
 * 用法（通常由 build-static-site.mjs 自动调用）：
 *   node scripts/fixup-static-export.mjs --site=11-curvelab-fit
 */

import { existsSync, readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');

const site = process.argv.find((a) => a.startsWith('--site='))?.slice(7);
if (!site) {
  console.error('用法: node scripts/fixup-static-export.mjs --site=<dirName>');
  process.exit(1);
}

const dir = join(MICRO, site);
const serverApp = join(dir, '.next', 'server', 'app');
const outDir = join(dir, 'out');

if (!existsSync(serverApp)) {
  console.error(`✗ 找不到 ${serverApp}`);
  process.exit(1);
}
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

/**
 * 把 .next/server/app 里的 html 映射到 out 的路径。
 *
 * Next 的导出布局规则（trailingSlash: true）：
 *   app/index.html           → out/index.html
 *   app/about.html           → out/about/index.html
 *   app/blog/post.html       → out/blog/post/index.html
 *   app/_not-found.html      → out/404.html
 *   app/(group)/x.html       → out/x/index.html   （route group 不进 URL）
 */
function targetFor(rel) {
  // 统一正斜杠
  const p = rel.replace(/\\/g, '/');
  if (p === 'index.html') return 'index.html';
  if (p === '_not-found.html') return '404.html';

  // 去掉 route group 目录：形如 (group)/xxx
  const parts = p.split('/').filter((seg) => !/^\(.+\)$/.test(seg));
  const joined = parts.join('/');

  if (joined === 'index.html') return 'index.html';
  if (joined.endsWith('/index.html')) return joined; // 已经是目录形式
  return joined.replace(/\.html$/, '/index.html');
}

/** 递归找出所有 html 文件（相对路径）。 */
function findHtml(base, cur = '', acc = []) {
  const abs = cur ? join(base, cur) : base;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = cur ? join(cur, entry.name) : entry.name;
    if (entry.isDirectory()) {
      // 跳过 Next 内部目录
      if (['chunks', 'node_modules'].includes(entry.name)) continue;
      findHtml(base, rel, acc);
    } else if (entry.name.endsWith('.html')) {
      acc.push(rel);
    }
  }
  return acc;
}

const htmls = findHtml(serverApp);
let copied = 0;
let skipped = 0;

for (const rel of htmls) {
  const src = join(serverApp, rel);
  const target = targetFor(rel);
  const dst = join(outDir, target);

  if (existsSync(dst)) {
    skipped += 1;
    continue;
  }

  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  const size = statSync(dst).size;
  console.log(`  + ${target}  (${size} B)`);
  copied += 1;
}

console.log(`\n补导 ${copied} 个，跳过 ${skipped} 个（out 里已存在）`);

// 结果校验
const mustHave = ['index.html'];
const missing = mustHave.filter((f) => !existsSync(join(outDir, f)));
if (missing.length) {
  console.error(`✗ 仍缺关键文件: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('✓ out/index.html 已就位');
