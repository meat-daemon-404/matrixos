#!/usr/bin/env node
/**
 * 只更新已构建站点的 _headers 并重新部署（不重新构建）。
 *
 * 用途：改了 CSP frame-ancestors 白名单之类的托管层配置时，
 * 不需要重跑 Next 构建（那要 20 分钟），直接改 out/_headers 再部署即可。
 *
 * 用法：
 *   node scripts/redeploy-headers.mjs --all
 *   node scripts/redeploy-headers.mjs --site=11-curvelab-fit
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 共享生成器：单一事实源，避免本文件与 build-static-site.mjs 各写一份导致漏改
import { pagesHeaders } from './lib/pages-headers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const ENV_FILE = 'D:\\tmp\\matrixos-cloudflare.env';

// 清代理
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
  delete process.env[k];
}

// 凭据
if (!process.env.CLOUDFLARE_API_TOKEN && existsSync(ENV_FILE)) {
  const txt = readFileSync(ENV_FILE, 'utf8');
  process.env.CLOUDFLARE_API_TOKEN = /CLOUDFLARE_API_TOKEN=(.+)/.exec(txt)?.[1]?.trim();
  process.env.CLOUDFLARE_ACCOUNT_ID = /CLOUDFLARE_ACCOUNT_ID=(.+)/.exec(txt)?.[1]?.trim();
}

/** 共享生成器：scripts/lib/pages-headers.mjs（单一事实源） */

const args = process.argv.slice(2);
const all = args.includes('--all');
const siteArg = args.find((a) => a.startsWith('--site='))?.slice(7);

const sites = all
  ? readdirSync(MICRO, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
      .map((d) => d.name)
  : siteArg
    ? [siteArg]
    : [];

if (!sites.length) {
  console.error('用法: node scripts/redeploy-headers.mjs --all | --site=<dirName>');
  process.exit(1);
}

let ok = 0;
let fail = 0;

for (const site of sites) {
  const dir = join(MICRO, site);
  const outDir = join(dir, 'out');

  if (!existsSync(join(outDir, 'index.html'))) {
    console.error(`✗ ${site}: out 不完整，跳过`);
    fail += 1;
    continue;
  }

  const cfg = readFileSync(join(dir, 'src', 'site.config.ts'), 'utf8');
  const appId = /appId:\s*["']([^"']+)["']/.exec(cfg)?.[1];
  if (!appId) {
    console.error(`✗ ${site}: 读不到 appId`);
    fail += 1;
    continue;
  }
  const projectName = `mx-${appId}`;

  writeFileSync(join(outDir, '_headers'), pagesHeaders(site), 'utf8');

  try {
    execFileSync(
      'npx',
      ['wrangler', 'pages', 'deploy', 'out', `--project-name=${projectName}`, '--branch=main', '--commit-dirty=true'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env: process.env, timeout: 600000 },
    );
    console.log(`✓ ${site.padEnd(24)} https://${projectName}.pages.dev`);
    ok += 1;
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}`;
    const line = msg.split('\n').find((l) => /ERROR|Error/.test(l)) ?? msg.split('\n')[0];
    console.error(`✗ ${site}: ${String(line).trim().slice(0, 150)}`);
    fail += 1;
  }
}

console.log(`\n成功 ${ok}，失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);
