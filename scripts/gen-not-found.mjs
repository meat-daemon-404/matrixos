#!/usr/bin/env node
/**
 * 为所有微站生成 src/app/not-found.tsx。
 *
 * 为什么需要：App Router 在 `output: 'export'`（静态导出）下，
 * 若项目没有显式 not-found.tsx，Next 15.5 自动生成的 `_not-found`
 * 会触发 `Invariant: no direct app page entry found for /_not-found`。
 * 见 docs/02-engineering/05-static-export-notes.md。
 *
 * 内容按站点定制（读 src/site.config.ts 的 SITE.name / domain），
 * 所以是脚本生成而不是简单复制同一份。
 *
 * 用法：node scripts/gen-not-found.mjs [--force]
 */

import { writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const force = process.argv.includes('--force');

const sites = readdirSync(MICRO, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
  .map((d) => d.name);

let created = 0;
let skipped = 0;

for (const site of sites) {
  const dir = join(MICRO, site);
  const cfgPath = join(dir, 'src', 'site.config.ts');
  const target = join(dir, 'src', 'app', 'not-found.tsx');

  if (!existsSync(cfgPath)) {
    console.error(`✗ ${site}：找不到 site.config.ts`);
    continue;
  }
  if (existsSync(target) && !force) {
    skipped += 1;
    continue;
  }

  // 从 site.config.ts 里抠出 name 与 domain（避免 import，纯文本解析更快）
  const cfg = readFileSync(cfgPath, 'utf8');
  const name = /name:\s*["']([^"']+)["']/.exec(cfg)?.[1] ?? site;
  const domain = /domain:\s*["']([^"']+)["']/.exec(cfg)?.[1] ?? '';

  const content = `/**
 * 404 页 —— 静态导出（Cloudflare Pages）必需。
 *
 * App Router 在 output:'export' 下，若缺本文件，Next 15.5 自动生成的
 * _not-found 会抛 "Invariant: no direct app page entry found for /_not-found"。
 * 见 docs/02-engineering/05-static-export-notes.md。
 *
 * 生成：scripts/gen-not-found.mjs（内容按站点定制，勿手改后忘记同步脚本）
 */
import Link from 'next/link';
import { SITE } from '../site.config';

export default function NotFound() {
  return (
    <main className="site-root" style={{ padding: '4rem 1.5rem', textAlign: 'center' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>404 · 该路径不存在</h1>
      <p className="mono" style={{ opacity: 0.6, marginBottom: '1.5rem' }}>
        {SITE.domain}
      </p>
      <p style={{ marginBottom: '2rem' }}>
        微站「{SITE.name}」没有这个页面。
      </p>
      <Link
        href="/"
        style={{
          display: 'inline-block',
          padding: '0.6rem 1.2rem',
          border: '1px solid currentColor',
          borderRadius: '0.5rem',
        }}
      >
        ← 返回首页
      </Link>
    </main>
  );
}
`;

  writeFileSync(target, content, 'utf8');
  console.log(`✓ ${site}  (${name})`);
  created += 1;
}

console.log(`\n生成 ${created} 个，跳过 ${skipped} 个（已存在）`);
