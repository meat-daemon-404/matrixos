#!/usr/bin/env node
/**
 * 为 18 个微站补齐生产环境 metadata（canonical / OG / robots）。
 *
 * 背景（2026-10-20 线上体检发现）：
 *   - 线上 HTML 里**没有** <link rel="canonical">，也没有 og:url / og:image
 *   - `metadataBase` 指向 `https://<appId>.matrixos.edu`，
 *     但该域名不在用户 Cloudflare 账号里（当前部署在 *.pages.dev）
 *
 *   后果：
 *     1. 搜索引擎可能把 pages.dev 预览域名和正式域名当成两份内容
 *     2. 分享到微信/飞书时没有结构化预览卡
 *     3. metadataBase 指向不存在的域名，OG 图片等相对路径会解析失败
 *
 * 做法：
 *   在 layout.tsx 的 metadata 里显式加：
 *     - alternates.canonical → 生产 URL
 *     - openGraph（title/description/url/siteName/locale/type）
 *     - twitter card
 *     - robots
 *
 *   生产 URL 通过环境变量 MATRIXOS_PUBLIC_BASE 控制，默认 pages.dev 形态：
 *     https://mx-<appId>.pages.dev
 *   将来绑自定义域名时改这一个变量即可。
 *
 * 用法：
 *   node scripts/upgrade-metadata.mjs            # 全部 18 站
 *   node scripts/upgrade-metadata.mjs --dry-run  # 只看会改什么
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const DRY = process.argv.includes('--dry-run');

const sites = readdirSync(MICRO, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
  .map((d) => d.name);

let changed = 0;
let skipped = 0;

for (const site of sites) {
  const dir = join(MICRO, site);
  const layoutPath = join(dir, 'src', 'app', 'layout.tsx');
  const cfgPath = join(dir, 'src', 'site.config.ts');

  let layout;
  let cfg;
  try {
    layout = readFileSync(layoutPath, 'utf8');
    cfg = readFileSync(cfgPath, 'utf8');
  } catch {
    console.error(`✗ ${site}: 读不到 layout.tsx 或 site.config.ts`);
    continue;
  }

  // 已经升级过就跳过（幂等）
  if (layout.includes('MATRIXOS_METADATA_V2')) {
    skipped += 1;
    continue;
  }

  const appId = /appId:\s*["']([^"']+)["']/.exec(cfg)?.[1];
  if (!appId) {
    console.error(`✗ ${site}: 读不到 appId`);
    continue;
  }

  // 生产 URL：可用环境变量覆盖（绑自定义域名时用）
  const publicBase = process.env.MATRIXOS_PUBLIC_BASE ?? `https://mx-${appId}.pages.dev`;

  /**
   * 把 metadata 对象替换为增强版。
   *
   * 用「找到 export const metadata 起始 → 配对的 };」定位范围，
   * 而不是正则跨行匹配整个对象（后者在嵌套对象下不可靠）。
   */
  const startMarker = 'export const metadata: Metadata = {';
  const startIdx = layout.indexOf(startMarker);
  if (startIdx === -1) {
    console.error(`✗ ${site}: 找不到 metadata 定义`);
    continue;
  }

  // 从 { 开始做括号配对
  const braceStart = layout.indexOf('{', startIdx);
  let depth = 0;
  let endIdx = -1;
  for (let i = braceStart; i < layout.length; i += 1) {
    if (layout[i] === '{') depth += 1;
    else if (layout[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }
  if (endIdx === -1) {
    console.error(`✗ ${site}: metadata 括号未闭合`);
    continue;
  }

  const oldBlock = layout.slice(startIdx, endIdx);

  // 保留原 metadata 里的非标准字段（applicationName / other）
  const keepOther = /other:\s*\{[\s\S]*?\}/.exec(oldBlock)?.[0] ?? '';

  const newBlock = `// MATRIXOS_METADATA_V2 —— 由 scripts/upgrade-metadata.mjs 生成
// 生产 URL 通过 MATRIXOS_PUBLIC_BASE 控制（绑自定义域名时改这一个）
const PUBLIC_URL = '${publicBase}';

export const metadata: Metadata = {
  // 注意：metadataBase 必须是**真实可解析**的域名。
  // 原值指向 <appId>.matrixos.edu（该域名未注册），
  // 会让 OG 图片等相对路径解析失败。
  metadataBase: new URL(PUBLIC_URL),
  title: {
    default: SITE.name + ' · MatrixOS',
    template: '%s · ' + SITE.name + ' · MatrixOS',
  },
  description: SITE.desc,
  applicationName: 'MatrixOS',
  keywords: [SITE.orbitName, SITE.uiStyle, SITE.source, '科研工作台', 'MatrixOS'],
  authors: [{ name: 'MatrixOS Team' }],
  // 声明规范 URL，避免 pages.dev 与未来自定义域名被视为重复内容
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: PUBLIC_URL,
    siteName: 'MatrixOS · 智轨星云',
    title: SITE.name + ' · MatrixOS',
    description: SITE.desc,
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE.name + ' · MatrixOS',
    description: SITE.desc,
  },
  robots: {
    index: true,
    follow: true,
  },${
    keepOther
      ? `
  ${keepOther},`
      : ''
  }
};`;

  const next = layout.slice(0, startIdx) + newBlock + layout.slice(endIdx);

  if (DRY) {
    console.log(`\n=== ${site} (${appId}) → ${publicBase}`);
    console.log(newBlock.split('\n').slice(0, 12).map((l) => '  ' + l).join('\n'));
    console.log('  ...');
  } else {
    writeFileSync(layoutPath, next, 'utf8');
    console.log(`✓ ${site.padEnd(24)} ${publicBase}`);
  }
  changed += 1;
}

console.log(`\n${DRY ? '将修改' : '已修改'} ${changed} 个，跳过 ${skipped} 个（已升级）`);
