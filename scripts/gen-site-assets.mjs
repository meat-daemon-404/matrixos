/**
 * 给 18 个微站补齐 `src/app/icon.svg` 与 `src/app/layout.tsx` 的 metadata。
 *
 * 背景：线上体检发现每站都有 1 个 404（浏览器默认请求 /favicon.ico 落空）。
 * Next.js App Router 约定的 `src/app/icon.svg` 会自动产出 `<link rel="icon">`，
 * 是这个问题的最小正解——不需要 public/、不需要改 next.config。
 *
 * 身份信息从各站自己的 `src/site.config.ts` 读（它已经是花名册的落地副本），
 * 图形与 metadata 模板来自 scripts/site-icons.mjs（与 gen-site.mjs 共用）。
 *
 * 用法：
 *   node scripts/gen-site-assets.mjs            # 落盘
 *   node scripts/gen-site-assets.mjs --dry-run  # 只看会改哪些文件
 *   node scripts/gen-site-assets.mjs --check    # 只校验是否已全部就位（CI/收尾用）
 *
 * 退出码：0 全部就位 / 1 有站点缺失或不一致
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ICON_IDS, patchLayoutMetadata, renderIconSvg } from './site-icons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO_ROOT = join(ROOT, 'apps', 'micro-sites');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const CHECK_ONLY = argv.includes('--check');

/** 从 site.config.ts 里抠出需要的字段（该文件是 `as const` 字面量，结构稳定）。 */
function readSiteConfig(dir) {
  const file = join(dir, 'src', 'site.config.ts');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  const pick = (key) => {
    const m = new RegExp(key + ':\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(raw);
    return m ? JSON.parse('"' + m[1] + '"') : null;
  };
  const site = {
    id: pick('id'),
    name: pick('name'),
    domain: pick('domain'),
    appId: pick('appId'),
    uiStyle: pick('uiStyle'),
    accent: pick('accent'),
  };
  const missing = Object.entries(site)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(relative(ROOT, file) + ' 缺少字段：' + missing.join(', '));
  return site;
}

const siteDirs = readdirSync(MICRO_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d\d-/.test(e.name))
  .map((e) => join(MICRO_ROOT, e.name))
  .sort();

if (siteDirs.length !== 18) {
  console.error('✗ 期望 18 个微站目录，实际 ' + siteDirs.length + ' 个');
  process.exit(1);
}

let iconsWritten = 0;
let iconsUnchanged = 0;
let layoutsPatched = 0;
let layoutsUnchanged = 0;
const problems = [];

console.log('\n微站图标与 metadata' + (DRY_RUN ? '（dry-run）' : CHECK_ONLY ? '（检查模式）' : ''));
console.log('─'.repeat(64));

for (const dir of siteDirs) {
  const slug = dir.slice(MICRO_ROOT.length + 1);

  let site;
  try {
    site = readSiteConfig(dir);
  } catch (e) {
    problems.push(slug + '：' + e.message);
    continue;
  }
  if (!site) {
    problems.push(slug + '：找不到 src/site.config.ts');
    continue;
  }

  // ── 1. icon.svg ────────────────────────────────────────────────────────────
  const iconPath = join(dir, 'src', 'app', 'icon.svg');
  const iconNext = renderIconSvg(site);
  const iconPrev = existsSync(iconPath) ? readFileSync(iconPath, 'utf8') : null;
  const iconChanged = iconPrev !== iconNext;

  if (iconChanged) {
    iconsWritten += 1;
    if (!DRY_RUN && !CHECK_ONLY) {
      mkdirSync(dirname(iconPath), { recursive: true });
      writeFileSync(iconPath, iconNext, 'utf8');
    }
  } else {
    iconsUnchanged += 1;
  }

  // ── 2. layout.tsx metadata ─────────────────────────────────────────────────
  const layoutPath = join(dir, 'src', 'app', 'layout.tsx');
  let layoutChanged = false;
  if (!existsSync(layoutPath)) {
    problems.push(slug + '：找不到 src/app/layout.tsx');
  } else {
    const layoutPrev = readFileSync(layoutPath, 'utf8');
    const { source: layoutNext, changed, error } = patchLayoutMetadata(layoutPrev);
    if (error) {
      problems.push(slug + '：' + error);
    } else {
      layoutChanged = changed;
      if (changed) {
        layoutsPatched += 1;
        if (!DRY_RUN && !CHECK_ONLY) writeFileSync(layoutPath, layoutNext, 'utf8');
      } else {
        layoutsUnchanged += 1;
      }
    }
  }

  const iconState = iconChanged ? '图标 写入' : '图标 已就位';
  const layoutState = layoutChanged ? 'metadata 更新' : 'metadata 已就位';
  console.log('  ' + slug.padEnd(24) + ' ' + site.id + '  ' + iconState + ' · ' + layoutState);
}

console.log('─'.repeat(64));
console.log(
  '  图标：写入 ' + iconsWritten + ' / 已就位 ' + iconsUnchanged +
    '　metadata：更新 ' + layoutsPatched + ' / 已就位 ' + layoutsUnchanged,
);

if (problems.length) {
  console.error('\n✗ ' + problems.length + ' 处问题：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

// 花名册若加了新站而 GLYPHS 没跟上，renderIconSvg 会抛错；
// 这里再反向确认一遍：定义数 === 站点数。
if (ICON_IDS.length !== siteDirs.length) {
  console.error(
    `\n✗ 图标定义 ${ICON_IDS.length} 条，站点 ${siteDirs.length} 个（scripts/site-icons.mjs 的 GLYPHS 与花名册不同步）`,
  );
  process.exit(1);
}

if (CHECK_ONLY && (iconsWritten > 0 || layoutsPatched > 0)) {
  console.error('\n✗ 仍有站点未就位（图标 ' + iconsWritten + ' / metadata ' + layoutsPatched + '）');
  process.exit(1);
}

if (DRY_RUN) {
  console.log('\n· dry-run 结束，未落盘。去掉 --dry-run 执行写入\n');
} else if (CHECK_ONLY) {
  console.log('\n✓ 18 个微站的 icon.svg 与 metadata 均已就位\n');
} else {
  console.log('\n✓ 18 个微站的 icon.svg 与 metadata 已写入\n');
}
