#!/usr/bin/env node
/**
 * 把 18 个微站 + orbital-hub 部署到 **新账号** e6bf8ab2cbb8475c1ba6d6570332c18d。
 *
 * 与 scripts/deploy-pages.mjs 的区别：
 *   - 不读 D:\tmp\matrixos-cloudflare.env（那是旧账号 token，对新账号 403）；
 *   - 走 wrangler 的 OAuth 登录态（新账号已 cf/wrangler login）；
 *   - 不注入 CLOUDFLARE_API_TOKEN，避免把旧账号 token 带进来。
 *
 * 用法：
 *   node scripts/deploy-new-account.mjs --all
 *   node scripts/deploy-new-account.mjs --site=11-curvelab-fit
 *   node scripts/deploy-new-account.mjs --all --dry-run
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const HUB = join(ROOT, 'apps', 'orbital-hub');

const args = process.argv.slice(2);
const all = args.includes('--all');
const siteArg = args.find((a) => a.startsWith('--site='))?.slice(7);
const dryRun = args.includes('--dry-run');
const onlyHub = args.includes('--hub-only');

const PROJECT_PREFIX = process.env.MATRIXOS_PAGES_PREFIX ?? 'mx-';
const projectNameFor = (appId) => `${PROJECT_PREFIX}${appId}`;

/* 代理必须清掉（wrangler 走本地代理会 TLS 失败） */
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
  delete process.env[k];
}
/* 关键：清掉旧账号 token，强制 wrangler 用 OAuth 登录态 */
delete process.env.CLOUDFLARE_API_TOKEN;
delete process.env.CF_API_TOKEN;

const NEW_ACCOUNT = 'e6bf8ab2cbb8475c1ba6d6570332c18d';

function wrangler(wrArgs, cwd) {
  return execFileSync('npx', ['wrangler', ...wrArgs], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: NEW_ACCOUNT },
    timeout: 900000,
  });
}

function ensureProject(name, cwd) {
  try {
    const out = wrangler(['pages', 'project', 'list'], cwd);
    if (new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`, 'm').test(out)) return 'exists';
  } catch { /* ignore */ }
  try {
    wrangler(['pages', 'project', 'create', name, '--production-branch=main'], cwd);
    return 'created';
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    if (/already exists|8000002/i.test(msg)) return 'exists';
    throw e;
  }
}

function deployOne({ label, dir, outDir, projectName }) {
  if (!existsSync(join(outDir, 'index.html'))) {
    console.error(`✗ ${label}: ${join(outDir, 'index.html')} 不存在（先构建）`);
    return { label, projectName, ok: false, error: 'no out/index.html' };
  }
  console.log(`\n▶ ${label}  →  https://${projectName}.pages.dev`);
  if (dryRun) {
    console.log('  (dry-run)');
    return { label, projectName, ok: true, dryRun: true };
  }
  try {
    const st = ensureProject(projectName, dir);
    if (st === 'created') console.log('  （已在目标账号新建项目）');
    const out = wrangler(
      ['pages', 'deploy', outDir, `--project-name=${projectName}`, '--branch=main', '--commit-dirty=true'],
      dir,
    );
    const m = out.match(/https:\/\/[a-z0-9]+\.([a-z0-9-]+)\.pages\.dev/);
    console.log(`  ✓ 已部署${m ? ' · ' + m[0] : ''}`);
    return { label, projectName, ok: true, preview: m ? m[0] : null };
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    const first = msg.split('\n').find((l) => /ERROR|Error|✗/.test(l)) ?? msg.split('\n')[0];
    console.error(`  ✗ ${String(first).trim().slice(0, 200)}`);
    return { label, projectName, ok: false, error: String(first).slice(0, 200) };
  }
}

/* ── 组装任务 ── */
const targets = [];

if (all || onlyHub) {
  targets.push({ label: 'orbital-hub', dir: HUB, outDir: join(HUB, 'out'), projectName: projectNameFor('orbital') });
}

if (!onlyHub) {
  const sites = all
    ? readdirSync(MICRO, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
        .map((d) => d.name)
    : siteArg
      ? [siteArg]
      : [];
  for (const site of sites) {
    const dir = join(MICRO, site);
    let appId = '';
    try {
      const cfg = readFileSync(join(dir, 'src', 'site.config.ts'), 'utf8');
      appId = /appId:\s*["']([^"']+)["']/.exec(cfg)?.[1] ?? '';
    } catch { /* ignore */ }
    if (!appId) { console.error(`✗ ${site}: 读不到 appId`); continue; }
    targets.push({ label: site, dir, outDir: join(dir, 'out'), projectName: projectNameFor(appId) });
  }
}

if (!targets.length) {
  console.error('用法: node scripts/deploy-new-account.mjs --all | --site=<dirName> | --hub-only');
  process.exit(1);
}

console.log(`目标账号 ${NEW_ACCOUNT.slice(0, 8)}… · ${targets.length} 个目标${dryRun ? ' · DRY RUN' : ''}`);

const results = [];
for (const t of targets) results.push(deployOne(t));

const ok = results.filter((r) => r.ok).length;
const fail = results.length - ok;
console.log('\n' + '─'.repeat(64));
console.log(`成功 ${ok}，失败 ${fail}`);
for (const r of results) {
  if (r.ok) console.log(`  ✓ ${r.label.padEnd(24)} https://${r.projectName}.pages.dev`);
  else console.log(`  ✗ ${r.label.padEnd(24)} ${r.error}`);
}
process.exit(fail > 0 ? 1 : 0);
