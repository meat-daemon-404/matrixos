/**
 * 把完工层（canonical 模板）分发到 18 个微站。
 *
 * 为什么要有这个脚本：
 *   18 个微站结构同构，完工层（SDK 适配、站点外壳、完工台、页面装配、shim）
 *   必须**逐字节一致**，否则集成验收会因各站实现漂移而崩。
 *   所以这一层只在 `apps/micro-sites/shared/templates/` 维护一份，
 *   由本脚本复制到每站，并在文件头写上「由谁分发、改哪里」。
 *
 * 不做什么：
 *   - 不写 `src/lib/site-spec.ts`（那是每站手写的业务数据，脚本只报告缺失，不覆盖）
 *   - 不碰 `src/components/site-instrument.tsx`（由 scripts/wire-instrument.mjs 管）
 *   - 不碰 `globals.css` / `next.config.ts` / `layout.tsx`
 *
 * 用法：
 *   node scripts/wire-workbench.mjs                # 全部分发
 *   node scripts/wire-workbench.mjs --site=01-gpa-sandbox
 *   node scripts/wire-workbench.mjs --check        # 只比对，不写盘（CI 用）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS, auditContracts, permissionsFor } from './lib/microsite-contracts.mjs';
import { TEMPLATE_FILES, templateHeader } from './lib/microsite-templates.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const TEMPLATES = join(MICRO, 'shared', 'templates');

/* ─────────────────────────── 站点花名册 ─────────────────────────── */

const roster = JSON.parse(readFileSync(join(ROOT, 'specs', 'microsites.json'), 'utf8'));
const dirs = readdirSync(MICRO)
  .filter((name) => /^\d\d-/.test(name))
  .sort();

const siteById = new Map(roster.map((site) => [String(site.id), site]));

const sites = dirs.map((dir) => {
  const id = dir.slice(0, 2);
  const meta = siteById.get(id);
  if (!meta) throw new Error(`specs/microsites.json 缺少站点 ${id}（目录 ${dir}）`);
  // appId 以站内 manifest 为准（花名册里没有这个字段，且 manifest 是契约权威）。
  const manifest = JSON.parse(readFileSync(join(MICRO, dir, 'matrix-app.manifest.json'), 'utf8'));
  return { dir, id, appId: manifest.app_id, ...meta };
});

const appIdToId = new Map(sites.map((site) => [site.appId, site.id]));

/* ───────────────────── 虫洞契约（accepts / emits / 投送目标） ───────────────────── */

// CONTRACTS 的唯一真身在 scripts/lib/microsite-contracts.mjs —— gen-site.mjs 生成
// matrix-app.manifest.json 时读的也是那一份。两处各持一份曾经漂移过：生成器里还是
// 骨架期默认值，跑一次 --force 就把已完工站点的 accepts/emits 打回空数组。

/* ─────────────────────────── 文件分发表 ─────────────────────────── */

const FILES = TEMPLATE_FILES;

function headerFor(site, file) {
  return templateHeader(site, file);
}

function buildContent(site, file) {
  const template = readFileSync(join(TEMPLATES, file.from), 'utf8');
  return headerFor(site, file) + template;
}

/* ─────────────────────────── manifest 更新 ─────────────────────────── */

function buildManifest(existing, contract) {
  return {
    ...existing,
    accepts: [...contract.accepts],
    emits: [...contract.emits],
    permissions: permissionsFor(contract),
  };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith('--site='))?.slice('--site='.length) ?? null;
const checkOnly = args.includes('--check');

const targets = only ? sites.filter((site) => site.dir === only) : sites;
if (targets.length === 0) {
  console.error(`没有匹配的站点：${only}`);
  process.exit(1);
}

const drift = [];
let written = 0;

for (const site of targets) {
  const contract = CONTRACTS[site.id];
  if (!contract) throw new Error(`CONTRACTS 缺少站点 ${site.id}`);

  for (const file of FILES) {
    const target = join(MICRO, site.dir, file.to);
    const content = buildContent(site, file);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current === content) continue;
    if (checkOnly) {
      drift.push(`${site.dir}/${file.to}`);
      continue;
    }
    writeFileSync(target, content, 'utf8');
    written += 1;
  }

  const manifestPath = join(MICRO, site.dir, 'matrix-app.manifest.json');
  const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const nextText = JSON.stringify(buildManifest(existing, contract), null, 2) + '\n';
  if (readFileSync(manifestPath, 'utf8') !== nextText) {
    if (checkOnly) drift.push(`${site.dir}/matrix-app.manifest.json`);
    else {
      writeFileSync(manifestPath, nextText, 'utf8');
      written += 1;
    }
  }

  // site-spec.ts 是每站手写业务数据，脚本只报告缺失，不生成。
  const specPath = join(MICRO, site.dir, 'src', 'lib', 'site-spec.ts');
  if (!existsSync(specPath)) {
    console.log(`  · ${site.dir} 缺少 src/lib/site-spec.ts（需手写业务规格）`);
  } else {
    // exportName 是 localStorage key 的一部分，写错会导致台账跨站串数据。
    const specText = readFileSync(specPath, 'utf8');
    const expected = `exportName: '${contract.exportName}'`;
    if (!specText.includes(expected)) {
      console.log(`  · ${site.dir} 的 site-spec.ts 缺少 ${expected}`);
    }
  }
}

/* ─────────────────── 契约自检（生态自洽，而不只是本站自洽） ───────────────────
 * 判据见 scripts/lib/microsite-contracts.mjs 的 auditContracts()：
 *  1. 每个站 emits 的类型，必须被它的投送目标站 accepts —— 否则 SDK 的 W3 校验会
 *     在真投送时抛 UnsupportedPayloadError。
 *  2. 每个站 accepts 的类型，必须至少有一个站 emits —— 否则这条接收契约永远收不到东西，
 *     等于写了条死契约。
 *  3. accepts / emits 只能取五值枚举。
 */
const problems = auditContracts(appIdToId);
if (problems.length > 0) {
  console.error('✗ 虫洞契约不自洽：');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

if (checkOnly) {
  if (drift.length > 0) {
    console.error(`✗ 有 ${drift.length} 个文件与模板不一致：`);
    for (const item of drift) console.error('  - ' + item);
    process.exit(1);
  }
  console.log(`✓ ${targets.length} 个站点的完工层与模板一致`);
} else {
  console.log(`✓ 分发完成：${targets.length} 个站点，写入 ${written} 个文件`);
}
console.log(`✓ 虫洞契约自检通过：${targets.length} 站的 emits 全部能被目标站的 accepts 消费`);
