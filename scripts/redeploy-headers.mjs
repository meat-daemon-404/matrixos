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
 *   node scripts/redeploy-headers.mjs --all --legacy-account   （回滚到旧账号时才用）
 *
 * ⚠️ 2026-10-21 账号迁移后，默认目标是**新账号**（走 wrangler OAuth）。
 *
 * 为什么必须显式清理旧 token（真实事故记录）：
 *   本文件原来会从 D:\tmp\matrixos-cloudflare.env 读旧账号的 API Token 并写进
 *   process.env.CLOUDFLARE_API_TOKEN。账号迁移后那条 token 只能操作旧账号，
 *   而 wrangler 又是通过环境变量优先于 OAuth 的 —— 结果是命令**成功退出、
 *   打印 ✓、URL 看起来也对**，但产物实际被写进了旧账号的项目里。
 *   线上新账号纹丝不动，而日志显示「部署成功」，属于最危险的一类静默错误。
 *   所以现在默认删除该变量，只有显式 --legacy-account 才恢复旧行为。
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

/** 当前生产账号（新账号）。 */
const PROD_ACCOUNT = 'e6bf8ab2cbb8475c1ba6d6570332c18d';
/** 旧账号（仅回滚用）。 */
const LEGACY_ACCOUNT = '002738a579821a06c4ee9241babe99f0';

const args = process.argv.slice(2);
const all = args.includes('--all');
const siteArg = args.find((a) => a.startsWith('--site='))?.slice(7);
const legacyAccount = args.includes('--legacy-account');
const dryRun = args.includes('--dry-run');

// 清代理
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
  delete process.env[k];
}

/* ── 账号选择：默认新账号，绝不让旧 token 静默生效 ── */
if (legacyAccount) {
  if (!existsSync(ENV_FILE)) {
    console.error(`✗ --legacy-account 需要 ${ENV_FILE}，文件不存在`);
    process.exit(1);
  }
  const txt = readFileSync(ENV_FILE, 'utf8');
  process.env.CLOUDFLARE_API_TOKEN = /CLOUDFLARE_API_TOKEN=(.+)/.exec(txt)?.[1]?.trim();
  process.env.CLOUDFLARE_ACCOUNT_ID = LEGACY_ACCOUNT;
  console.log(`⚠️  回滚模式：目标 = 旧账号 ${LEGACY_ACCOUNT.slice(0, 8)}…`);
} else {
  // 关键：清掉可能从父 shell / env 文件继承来的旧 token
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = PROD_ACCOUNT;
  console.log(`目标账号 = 新账号 ${PROD_ACCOUNT.slice(0, 8)}…（wrangler OAuth）`);
}

/** 共享生成器：scripts/lib/pages-headers.mjs（单一事实源） */

const sites = all
  ? readdirSync(MICRO, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
      .map((d) => d.name)
  : siteArg
    ? [siteArg]
    : [];

if (!sites.length) {
  console.error('用法: node scripts/redeploy-headers.mjs --all | --site=<dirName> [--legacy-account] [--dry-run]');
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
  const publicUrl = legacyAccount
    ? `https://${projectName}.pages.dev`
    : `https://${projectName}.matrixos.cc.cd`;

  writeFileSync(join(outDir, '_headers'), pagesHeaders(site), 'utf8');

  if (dryRun) {
    console.log(`· ${site.padEnd(24)} → ${publicUrl}   (dry-run)`);
    ok += 1;
    continue;
  }

  try {
    execFileSync(
      'npx',
      ['wrangler', 'pages', 'deploy', 'out', `--project-name=${projectName}`, '--branch=main', '--commit-dirty=true'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env: process.env, timeout: 600000 },
    );
    console.log(`✓ ${site.padEnd(24)} ${publicUrl}`);
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
