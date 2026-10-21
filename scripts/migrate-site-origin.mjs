#!/usr/bin/env node
/**
 * 把 18 个微站 `src/app/layout.tsx` 里的 SITE_ORIGIN 从旧账号域名
 * (`https://mx-<appId>.pages.dev`) 改成生产自有域名
 * (`https://mx-<appId>.matrixos.cc.cd`)。
 *
 * 为什么需要单独一个脚本：
 *   这些 layout.tsx 是 `scripts/site-icons.mjs` 生成的**产物**，改生成器只影响
 *   以后重新生成的文件；已存在的 18 份不会自动更新，而 canonical / og:url
 *   指错域名会让爬虫把「正式地址」记成旧账号那套（且新账号里同名 pages.dev
 *   已被 Cloudflare 改名加 hash，旧值根本解析不到正确内容）。
 *
 * 幂等：已经是新域名的跳过。
 *
 * 用法：node scripts/migrate-site-origin.mjs [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const dryRun = process.argv.includes('--dry-run');

const OLD = ".pages.dev';";
const NEW = ".matrixos.cc.cd';";
const ANCHOR = 'const SITE_ORIGIN = ';

const results = [];
for (const d of readdirSync(MICRO, { withFileTypes: true })) {
  if (!d.isDirectory() || !/^\d\d-/.test(d.name)) continue;
  const file = join(MICRO, d.name, 'src', 'app', 'layout.tsx');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { results.push({ name: d.name, state: 'no layout.tsx' }); continue; }

  const line = text.split('\n').find((l) => l.startsWith(ANCHOR));
  if (!line) { results.push({ name: d.name, state: 'no SITE_ORIGIN' }); continue; }
  if (line.includes('.matrixos.cc.cd')) { results.push({ name: d.name, state: 'already new' }); continue; }
  if (!line.endsWith(OLD)) { results.push({ name: d.name, state: `unexpected: ${line.trim().slice(0, 80)}` }); continue; }

  const patched = text.replace(ANCHOR + line.slice(ANCHOR.length), ANCHOR + line.slice(ANCHOR.length).replace(OLD, NEW));
  if (!dryRun) {
    writeFileSync(file, patched);
    // 回读验证
    const back = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(ANCHOR));
    if (!back.includes('.matrixos.cc.cd')) { results.push({ name: d.name, state: 'WRITE FAILED' }); continue; }
  }
  results.push({ name: d.name, state: 'migrated' });
}

for (const r of results) console.log(`  ${r.state.padEnd(12)} ${r.name}`);
const bad = results.filter((r) => /FAILED|unexpected/.test(r.state));
console.log(`\n迁移 ${results.filter((r) => r.state === 'migrated').length} / 已新 ${results.filter((r) => r.state === 'already new').length} / 异常 ${bad.length}`);
process.exit(bad.length ? 1 : 0);
