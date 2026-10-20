#!/usr/bin/env node
/**
 * 把 SiteInstrument 接入到一个微站。
 *
 * 用法：
 *   node scripts/wire-instrument.mjs --site=11-curvelab-fit
 *   node scripts/wire-instrument.mjs --all
 *
 * 做的事（幂等，可重复跑）：
 *   1. 若站点没有 src/components/site-instrument.tsx，从 canonical 源复制
 *   2. 在 package.json 加 @matrixos/microsite-data 依赖
 *   3. 把 site-shell.tsx 里的占位仪器块替换为 <SiteInstrument siteId={SITE.id} />
 *   4. 补 import
 *
 * 为什么用脚本而不是手改 11 次：18 个站点的 shell 结构完全一致，
 * 手改容易漏、也容易改出差异。脚本保证一致。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');

// canonical 源：从第一个接通的站复制
const CANONICAL = join(MICRO, '11-curvelab-fit', 'src', 'components', 'site-instrument.tsx');

const args = process.argv.slice(2);
const all = args.includes('--all');
const siteArg = args.find((a) => a.startsWith('--site='));
const sites = all
  ? readdirSync(MICRO, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
      .map((d) => d.name)
  : siteArg
    ? [siteArg.split('=')[1]]
    : [];

if (sites.length === 0) {
  console.error('用法: node scripts/wire-instrument.mjs --all | --site=<dirName>');
  process.exit(1);
}

if (!existsSync(CANONICAL)) {
  console.error(`✗ canonical 源不存在: ${CANONICAL}`);
  process.exit(1);
}

/** 已实现仪器的站点（与 shared 包的 IMPLEMENTED_SITES 保持一致） */
const IMPLEMENTED = new Set([
  '01-gpa-sandbox',
  '03-grant-audit',
  '04-pat-radar',
  '06-xingmen-mentor',
  '08-lab-kanban',
  '09-matrix-cross',
  '11-curvelab-fit',
  '12-repro-check',
  '15-retract-radar',
  '16-yunheng-scale',
  '17-evidence-cv',
]);

let wired = 0;
let skipped = 0;
let failed = 0;

for (const site of sites) {
  const dir = join(MICRO, site);
  if (!existsSync(dir)) {
    console.error(`✗ 站点不存在: ${site}`);
    failed++;
    continue;
  }

  // 未实现的站点保持骨架不动
  if (!IMPLEMENTED.has(site)) {
    console.log(`- ${site}  跳过（仪器未实现，保持骨架）`);
    skipped++;
    continue;
  }

  try {
    // 1. 复制 site-instrument.tsx
    const target = join(dir, 'src', 'components', 'site-instrument.tsx');
    if (site !== '11-curvelab-fit') {
      copyFileSync(CANONICAL, target);
    }

    // 2. package.json 加依赖
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!pkg.dependencies['@matrixos/microsite-data']) {
      pkg.dependencies['@matrixos/microsite-data'] = 'workspace:*';
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    }

    // 3. 改 site-shell.tsx
    const shellPath = join(dir, 'src', 'components', 'site-shell.tsx');
    let shell = readFileSync(shellPath, 'utf8');

    // 3a. 补 import
    if (!shell.includes("from './site-instrument'")) {
      shell = shell.replace(
        "import { Bezel, bezelSource } from '../lib/instrument-facade';",
        "import { Bezel, bezelSource } from '../lib/instrument-facade';\nimport { SiteInstrument } from './site-instrument';",
      );
    }

    // 3b. 替换占位块（可能已经换过，幂等）
    const placeholderRe =
      /<Bezel className="instrument-slot">[\s\S]*?(<div className="status-row">)/;
    if (!shell.includes('<SiteInstrument siteId={SITE.id} />')) {
      if (placeholderRe.test(shell)) {
        shell = shell.replace(placeholderRe, '<Bezel className="instrument-slot">\n        <SiteInstrument siteId={SITE.id} />\n        $1');
      } else {
        throw new Error('未找到预期的占位仪器块，需人工确认');
      }
    }

    // 3c. 清掉不再使用的 GAUGE_HEIGHTS
    if (shell.includes('GAUGE_HEIGHTS')) {
      shell = shell.replace(/\n\s*\/\*\* 占位仪器的柱状高度[^\n]*\*\/\n\s*const GAUGE_HEIGHTS[^;]+;\n/, '\n');
    }

    writeFileSync(shellPath, shell, 'utf8');

    console.log(`✓ ${site}`);
    wired++;
  } catch (e) {
    console.error(`✗ ${site}  ${e.message}`);
    failed++;
  }
}

console.log(`\n接入 ${wired} 个，跳过 ${skipped} 个，失败 ${failed} 个`);
if (failed > 0) process.exit(1);
