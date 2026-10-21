#!/usr/bin/env node
/**
 * 给新账号的 18 个微站绑定 `<projectName>.matrixos.cc.cd` 二级域名。
 *
 * 为什么必须走自定义域名而不是 pages.dev：
 *   `mx-<appId>.pages.dev` 已被【旧账号】的项目占用；新账号建同名项目时
 *   Cloudflare 会自动改名为 `mx-<appId>-<hash>.pages.dev`（例如 mx-curvelab-7r4）。
 *   所以新账号要用自己的域名作为稳定入口。
 *
 * 命令分工（踩过的坑）：
 *   - `cf` CLI（Cloudflare 官方 beta）输出 JSON，用于 list / domains / dns  → 好解析；
 *   - `npx wrangler pages deploy` 才有 --project-name                    → 用于上传产物。
 *   - `cf pages deploy` 不接受 --project-name，`wrangler pages project list` 输出表格不输出 JSON。
 *
 * 用法：
 *   node scripts/bind-microsite-domains.mjs --all
 *   node scripts/bind-microsite-domains.mjs --site=01-gpa-sandbox
 *   node scripts/bind-microsite-domains.mjs --all --dry-run
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { clearProxyEnv, assertCfReady } from './lib/cf-preflight.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const ZONE = process.env.MATRIXOS_ZONE ?? 'matrixos.cc.cd';
const DOMAIN_SUFFIX = process.env.MATRIXOS_SITE_SUFFIX ?? `.${ZONE}`;

const args = process.argv.slice(2);
const all = args.includes('--all');
const siteArg = args.find((a) => a.startsWith('--site='))?.slice(7);
const dryRun = args.includes('--dry-run');
const onlyHub = args.includes('--hub-only');

/* 本脚本全程依赖 cf CLI；先确认登录态与账号，否则后面每一步都会以
   `[9106] Authentication failed` 这种不含「过期/未登录」字样的错误收场。 */
clearProxyEnv();
assertCfReady({ quiet: true });

const PROJECT_PREFIX = process.env.MATRIXOS_PAGES_PREFIX ?? 'mx-';
const projectNameFor = (appId) => `${PROJECT_PREFIX}${appId}`;
const HUB_PROJECT = projectNameFor('orbital');

const NOISE = /node\.exe|^\s+at\s|DeprecationWarning|CategoryInfo|FullyQualifiedErrorId|所在位置|字符|RemoteException|^\s*\+\s|Assertion failed/;

function run(cmd, argv) {
  try {
    return execFileSync(cmd, argv, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', env: process.env, timeout: 600000,
    });
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    const err = new Error(msg);
    err.stdout = e.stdout || '';
    throw err;
  }
}

/** cf CLI 的 stdout 是纯 JSON；噪声在 stderr。抓第一个 JSON 结构。 */
function cfJson(argv) {
  const out = run('cf', argv);
  const clean = out.split('\n').filter((l) => !NOISE.test(l)).join('\n');
  const a = clean.indexOf('[');
  const o = clean.indexOf('{');
  const from = a === -1 ? o : (o === -1 ? a : Math.min(a, o));
  if (from === -1) return null;
  const end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));
  if (end <= from) return null;
  try { return JSON.parse(clean.slice(from, end + 1)); } catch { return null; }
}

function cfQuiet(argv) {
  try { return { ok: true, out: run('cf', argv) }; }
  catch (e) { return { ok: false, out: String(e.stdout || e.message || '') }; }
}

/* ── 组装目标 ── */
const targets = [];
if (all || onlyHub) targets.push({ label: 'orbital-hub', projectName: HUB_PROJECT, isHub: true });
if (!onlyHub) {
  const sites = all
    ? readdirSync(MICRO, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d\d-/.test(d.name)).map((d) => d.name)
    : siteArg ? [siteArg] : [];
  for (const site of sites) {
    const dir = join(MICRO, site);
    let appId = '';
    try {
      appId = /appId:\s*["']([^"']+)["']/.exec(readFileSync(join(dir, 'src', 'site.config.ts'), 'utf8'))?.[1] ?? '';
    } catch { /* ignore */ }
    if (appId) targets.push({ label: site, projectName: projectNameFor(appId), isHub: false });
  }
}
if (!targets.length) {
  console.error('用法: node scripts/bind-microsite-domains.mjs --all | --site=<dirName> | --hub-only');
  process.exit(1);
}

/* ── 一次性拉取新账号项目（含真实 pages.dev 子域）── */
/* `cf pages list` 每页固定 10 条，且 per-page 只接受 10（传 20/50 → 8000024）。
   必须按 page 翻页，否则后 9 个站点会被误判为「项目不存在」。 */
function listAllProjects() {
  const acc = [];
  for (let page = 1; page <= 30; page++) {
    const chunk = cfJson(['pages', 'list', '--page', String(page)]) ?? [];
    if (!chunk.length) break;
    acc.push(...chunk);
    if (chunk.length < 10) break;
  }
  return acc;
}
const projects = listAllProjects();
/** 新账号的 subdomain 字段已含 `.pages.dev`，统一剥掉后缀再拼，避免 `.pages.dev.pages.dev`。 */
const bareSub = (s) => String(s || '').replace(/\.pages\.dev$/i, '');
const subOf = Object.fromEntries(projects.map((p) => [p.name, bareSub(p.subdomain)]));
const existingDns = new Set((cfJson(['dns', 'records', 'list', '--zone', ZONE, '--per-page', '100']) ?? []).map((r) => r.name));

console.log(`账号项目 ${projects.length} 个 · 域名后缀 ${DOMAIN_SUFFIX} · 目标 ${targets.length} 个${dryRun ? ' · DRY RUN' : ''}`);

const results = [];
for (const t of targets) {
  const pagesSub = subOf[t.projectName];
  if (!pagesSub) {
    console.error(`✗ ${t.label}: 项目 ${t.projectName} 不在新账号，先跑 deploy-new-account.mjs`);
    results.push({ ...t, ok: false, error: 'project missing' });
    continue;
  }
  const hostname = t.isHub ? ZONE : `${t.projectName}${DOMAIN_SUFFIX}`;
  console.log(`\n▶ ${t.label}  ${hostname}  →  ${pagesSub}.pages.dev`);
  if (dryRun) { results.push({ ...t, ok: true, dryRun: true, hostname }); continue; }

  /* 1) Pages 认领域名 */
  const dom = cfQuiet(['pages', 'domains', 'create', t.projectName, '--name', hostname]);
  if (dom.ok) console.log('  ✓ Pages 已认领域名');
  else if (/already|exists|duplicate/i.test(dom.out)) console.log('  · Pages 已认领（跳过）');
  else console.log(`  ! Pages 认领: ${String(dom.out).trim().split('\n')[0].slice(0, 140)}`);

  /* 2) DNS CNAME（hub 用 apex，已单独维护） */
  if (!t.isHub) {
    if (existingDns.has(hostname)) {
      console.log('  · DNS 记录已存在（跳过）');
    } else {
      const bodyFile = join(tmpdir(), `dns-${t.projectName}.json`);
      writeFileSync(bodyFile, JSON.stringify({
        type: 'CNAME', name: hostname, content: `${pagesSub}.pages.dev`,
        ttl: 1, proxied: true, comment: `MatrixOS ${t.label} -> new-account Pages`,
      }));
      const dns = cfQuiet(['dns', 'records', 'create', '--zone', ZONE, '--body', `@${bodyFile}`]);
      if (dns.ok) console.log('  ✓ DNS CNAME 已建（橙云）');
      else if (/already|exists|duplicate|81058/i.test(dns.out)) console.log('  · DNS 记录已存在（跳过）');
      else console.log(`  ! DNS: ${String(dns.out).trim().split('\n')[0].slice(0, 140)}`);
    }
  }
  results.push({ ...t, ok: true, hostname });
}

console.log('\n' + '─'.repeat(64));
const okCount = results.filter((r) => r.ok).length;
console.log(`成功 ${okCount}，失败 ${results.length - okCount}`);
for (const r of results) {
  console.log(r.ok ? `  ✓ ${r.label.padEnd(24)} https://${r.hostname}` : `  ✗ ${r.label.padEnd(24)} ${r.error}`);
}
process.exit(results.some((r) => !r.ok) ? 1 : 0);
