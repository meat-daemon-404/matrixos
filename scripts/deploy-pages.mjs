#!/usr/bin/env node
/**
 * 批量部署 18 个微站 + orbital-hub 到 Cloudflare Pages。
 *
 * 用官方 wrangler CLI（而不是自己实现 Pages Upload API）：
 *   Pages 的 Direct Upload 是两步协议（拿 upload_url+jwt，再 multipart 上传，
 *   字段名是文件内容哈希）。自己实现容易在 manifest 格式上踩坑，
 *   而 wrangler 是官方工具、行为稳定。
 *
 * 前置：
 *   1. node scripts/build-static-site.mjs --all   （各站 out/ 就绪）
 *   2. 凭据：环境变量或 D:\tmp\matrixos-cloudflare.env（仓库外）
 *
 * ⚠️ 必须清除代理环境变量：
 *   本机 HTTP_PROXY/HTTPS_PROXY 指向 127.0.0.1:7897，wrangler 会走它，
 *   导致 TLS 握手失败或连不上 Cloudflare API。脚本内部自动清除。
 *
 * 用法：
 *   node scripts/deploy-pages.mjs --all
 *   node scripts/deploy-pages.mjs --site=11-curvelab-fit
 *   node scripts/deploy-pages.mjs --all --dry-run
 *   node scripts/deploy-pages.mjs --all --skip-existing   已部署过的跳过
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const ENV_FILE = 'D:\\tmp\\matrixos-cloudflare.env';

const args = process.argv.slice(2);
const all = args.includes('--all');
const siteArg = args.find((a) => a.startsWith('--site='))?.slice(7);
const dryRun = args.includes('--dry-run');

/* ── 项目名策略 ── */
/**
 * Pages 项目名前缀。
 *
 * 为什么需要前缀：
 * 用户账号里已有 `pat-hot`（2026-10-12 创建的原型站）和 `scholarmatrix`、
 * `xingmen-mentor` 等历史项目。MatrixOS 的 04 站 appId 恰好也叫 `pat-hot`，
 * 若直接部署会**覆盖用户的既有原型**——这是不可接受的。
 *
 * 所以统一加 `mx-` 前缀：mx-pat-hot、mx-curvelab …
 * 既不冲突，也一眼能看出属于 MatrixOS。
 */
const PROJECT_PREFIX = process.env.MATRIXOS_PAGES_PREFIX ?? 'mx-';

function projectNameFor(appId) {
  return `${PROJECT_PREFIX}${appId}`;
}

/* ── 清理代理（关键） ── */
for (const k of [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]) {
  delete process.env[k];
}

/* ── 凭据 ── */
function loadCreds() {
  let token = process.env.CLOUDFLARE_API_TOKEN;
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    if (!existsSync(ENV_FILE)) {
      console.error(`✗ 无凭据：环境变量未设置，且 ${ENV_FILE} 不存在`);
      process.exit(1);
    }
    const txt = readFileSync(ENV_FILE, 'utf8');
    token = token || /CLOUDFLARE_API_TOKEN=(.+)/.exec(txt)?.[1]?.trim();
    account = account || /CLOUDFLARE_ACCOUNT_ID=(.+)/.exec(txt)?.[1]?.trim();
  }
  if (!token || !account) {
    console.error('✗ 凭据解析失败');
    process.exit(1);
  }
  process.env.CLOUDFLARE_API_TOKEN = token;
  process.env.CLOUDFLARE_ACCOUNT_ID = account;
  return { token, account };
}

const { account } = loadCreds();

function wrangler(wrArgs, cwd) {
  return execFileSync('npx', ['wrangler', ...wrArgs], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env,
    timeout: 900000,
  });
}

/** 确保 Pages 项目存在。wrangler 的 create 对已存在项目会报错，故先探测。 */
function ensureProject(appId, cwd) {
  try {
    wrangler(['pages', 'project', 'list'], cwd);
  } catch {
    /* list 失败不致命 */
  }
  try {
    const out = wrangler(['pages', 'project', 'list'], cwd);
    if (new RegExp(`\\b${appId}\\b`).test(out)) return 'exists';
  } catch {
    /* ignore */
  }
  wrangler(['pages', 'project', 'create', appId, '--production-branch=main'], cwd);
  return 'created';
}

/* ── 站点列表 ── */
const sites = all
  ? readdirSync(MICRO, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
      .map((d) => d.name)
  : siteArg
    ? [siteArg]
    : [];

if (!sites.length) {
  console.error('用法: node scripts/deploy-pages.mjs --all | --site=<dirName>');
  process.exit(1);
}

console.log(`账户 ${account.slice(0, 8)}… · ${sites.length} 个站点${dryRun ? ' · DRY RUN' : ''}`);

let ok = 0;
let fail = 0;
const deployed = [];

for (const site of sites) {
  const dir = join(MICRO, site);
  const outDir = join(dir, 'out');

  let appId = '';
  try {
    const cfg = readFileSync(join(dir, 'src', 'site.config.ts'), 'utf8');
    appId = /appId:\s*["']([^"']+)["']/.exec(cfg)?.[1] ?? '';
  } catch {
    /* ignore */
  }

  if (!appId) {
    console.error(`✗ ${site}: 读不到 appId`);
    fail += 1;
    continue;
  }
  if (!existsSync(join(outDir, 'index.html'))) {
    console.error(`✗ ${site}: out/index.html 不存在，先跑 build-static-site.mjs`);
    fail += 1;
    continue;
  }

  const projectName = projectNameFor(appId);
  const url = `https://${projectName}.pages.dev`;
  console.log(`\n▶ ${site}  →  ${url}`);

  if (dryRun) {
    console.log('  (dry-run)');
    deployed.push({ site, appId, projectName: projectNameFor(appId), url: `https://${projectNameFor(appId)}.pages.dev` });
    ok += 1;
    continue;
  }

  try {
    const state = ensureProject(projectName, dir);
    if (state === 'created') console.log('  （新建项目）');

    const out = wrangler(
      ['pages', 'deploy', 'out', `--project-name=${projectName}`, '--branch=main', '--commit-dirty=true'],
      dir,
    );
    // 从输出里抠出预览 URL（形如 https://<hash>.<appId>.pages.dev）
    const previewMatch = out.match(/https:\/\/[a-z0-9]+\.([a-z0-9-]+)\.pages\.dev/);
    const previewUrl = previewMatch ? previewMatch[0] : null;
    console.log(`  ✓ 已部署${previewUrl ? ' · ' + previewUrl : ''}`);
    deployed.push({ site, appId, projectName, url, ok: true });
    ok += 1;
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    const first = msg.split('\n').find((l) => /ERROR|Error|✗/.test(l)) ?? msg.split('\n')[0];
    console.error(`  ✗ ${String(first).trim().slice(0, 180)}`);
    deployed.push({ site, appId, projectName, error: String(first).slice(0, 180) });
    fail += 1;
  }
}

console.log('\n' + '─'.repeat(62));
console.log(`成功 ${ok}，失败 ${fail}`);
if (deployed.some((d) => d.url && d.ok !== false)) {
  console.log('\n已部署：');
  for (const d of deployed) if (d.url && !d.error) console.log(`  ${d.site.padEnd(24)} ${(d.projectName ?? "").padEnd(22)} ${d.url}`);
}
process.exit(fail > 0 ? 1 : 0);
