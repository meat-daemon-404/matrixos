#!/usr/bin/env node
/**
 * 部署前**产物内容自检** —— 检查「产物里到底构建进了什么值」。
 *
 * ── 为什么需要（2026-10-21 两个真实事故） ──────────────────────────────────
 *
 * 事故 1：**hub 产物被构建进 local-mode 的 localhost 地址**
 *   线上 `https://mx-orbital.pages.dev` 的 iframe src 曾是
 *   `http://127.0.0.1:3010`（用户浏览器根本连不到），导致：
 *     - hub 内嵌态微站永远连不上（白屏/超时）
 *     - bridge 握手永远不完成 → SSO 永远 offline
 *   成因：`apps/orbital-hub/.env.example` 有
 *   `NEXT_PUBLIC_MICROSITE_LOCAL_MODE=true`，本地联调时被复制/读取，
 *   Next 的 DefinePlugin 在**构建期**把它静态替换进产物。
 *
 * 事故 2：**微站产物缺 HUB_ORIGINS 注入，导致 OriginAllowList 拒绝 hub**
 *   微站靠构建期注入的 `NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS` 构造 SDK 的
 *   OriginAllowList；若该值为空，hub 发来的 `bridge.hello` 会被**静默丢弃**，
 *   表现为「SDK 已就位但 MatrixID 永远 offline」。
 *   成因：部分站的 out/ 是**注入修复之前**构建的（并行会话反复重建导致时序不一致），
 *   于是同一批产物里 01 站含注入值、08/11 站不含。
 *
 * ── 本脚本检查什么 ──────────────────────────────────────────────────────
 *   A. hub 产物：**不得**含 localhost/127.0.0.1 的微站地址；
 *      应含 `https://mx-{appId}.pages.dev` 模板。
 *   B. 18 微站产物：**必须**含 `mx-orbital.pages.dev`（HUB_ORIGINS 注入成功）。
 *   C. 18 微站产物：不得含 `http://localhost:` 作为宿主 origin。
 *
 * 用法：node scripts/assert-artifact-env.mjs
 * 退出码：0 干净 / 1 有污染
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const HUB_OUT = join(ROOT, 'apps', 'orbital-hub', 'out');

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

let blocked = 0;
const problems = [];

/** 递归收集目录下所有 .js（产物 chunk）。 */
function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function scan(dir) {
  return jsFiles(dir).map((f) => readFileSync(f, 'utf8')).join('\n');
}

console.log(`\n${C.d}${'─'.repeat(64)}${C.x}`);
console.log('▶ A. hub 产物：不得含 localhost 微站地址');
{
  if (!existsSync(HUB_OUT)) {
    console.log(`  ${C.y}!${C.x} hub out/ 不存在（未构建，跳过）`);
  } else {
    const text = scan(join(HUB_OUT, '_next'));
    const localHits = [...new Set(text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/g) || [])];
    const hasPagesTemplate = /https:\/\/mx-\{appId\}\.pages\.dev/.test(text) || /mx-.*\.pages\.dev/.test(text);
    if (localHits.length > 0) {
      blocked += 1;
      problems.push(`hub 产物含 localhost 地址：${localHits.slice(0, 3).join(', ')}`);
      console.log(`  ${C.r}✗${C.x} 含 localhost：${localHits.slice(0, 3).join(', ')}`);
      console.log(`    ${C.d}→ 生产构建应覆盖：NEXT_PUBLIC_MICROSITE_LOCAL_MODE=false（build-hub-static.mjs 支持）${C.x}`);
    } else {
      console.log(`  ${C.g}✓${C.x} 无 localhost 微站地址`);
    }
    if (hasPagesTemplate) console.log(`  ${C.g}✓${C.x} 含 pages.dev 地址模板`);
    else {
      blocked += 1;
      problems.push('hub 产物未含 pages.dev 地址模板');
      console.log(`  ${C.r}✗${C.x} 未含 pages.dev 地址模板`);
    }
  }
}

console.log(`\n${C.d}${'─'.repeat(64)}${C.x}`);
console.log('▶ B. 18 微站产物：必须含 HUB_ORIGINS 注入（mx-orbital.pages.dev）');
{
  const sites = readdirSync(MICRO, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name)).map((d) => d.name).sort();
  const missing = [];
  const noOut = [];
  for (const s of sites) {
    const outDir = join(MICRO, s, 'out');
    if (!existsSync(join(outDir, 'index.html'))) { noOut.push(s); continue; }
    const text = scan(join(outDir, '_next'));
    if (!/mx-orbital\.pages\.dev/.test(text)) missing.push(s);
  }
  if (noOut.length) console.log(`  ${C.y}!${C.x} 无产物（未构建）：${noOut.join(', ')}`);
  if (missing.length) {
    blocked += 1;
    problems.push(`${missing.length} 站产物缺 HUB_ORIGINS 注入：${missing.join(', ')}`);
    console.log(`  ${C.r}✗${C.x} 缺注入（${missing.length} 站）：${missing.join(', ')}`);
    console.log(`    ${C.d}→ 这些站的 bridge.hello 会被 OriginAllowList 静默丢弃 → SSO 永远 offline${C.x}`);
    console.log(`    ${C.d}→ 修法：node scripts/build-static-site.mjs --all 重建${C.x}`);
  } else if (sites.length - noOut.length > 0) {
    console.log(`  ${C.g}✓${C.x} ${sites.length - noOut.length} 站产物均含 mx-orbital.pages.dev`);
  }
}

console.log(`\n${C.d}${'─'.repeat(64)}${C.x}`);
console.log('▶ C. 18 微站产物：不得把 localhost 当宿主 origin');
{
  const sites = readdirSync(MICRO, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name)).map((d) => d.name).sort();
  const dirty = [];
  for (const s of sites) {
    const outDir = join(MICRO, s, 'out', '_next');
    if (!existsSync(outDir)) continue;
    const text = scan(outDir);
    if (/http:\/\/localhost:\d+/.test(text) && !/mx-orbital\.pages\.dev/.test(text)) dirty.push(s);
  }
  if (dirty.length) {
    console.log(`  ${C.y}!${C.x} 疑似 localhost-only（${dirty.length} 站）：${dirty.join(', ')}`);
  } else {
    console.log(`  ${C.g}✓${C.x} 无 localhost-only 产物`);
  }
}

console.log(`\n${C.d}${'─'.repeat(64)}${C.x}`);
if (blocked === 0) {
  console.log(`${C.g}✓ 产物环境注入检查通过${C.x}`);
  process.exit(0);
}
console.log(`${C.r}✗ ${blocked} 项阻塞${C.x}`);
problems.forEach((p) => console.log(`  · ${p}`));
process.exit(1);
