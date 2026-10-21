#!/usr/bin/env node
/**
 * 部署 orbital-hub 到 Cloudflare Pages。
 *
 * 为什么需要单独一个脚本：
 * `scripts/deploy-pages.mjs` 的注释写着「批量部署 18 个微站 + orbital-hub」，
 * 但代码实际只遍历 apps/micro-sites/，**没有部署 hub**（注释与实现不符）。
 * 本轮踩到：18 站修复已上线，但 hub 产物是旧的（结论：H 线 layout.resize
 * 与 SSO 握手的 hub 侧修复没生效），排查很久才发现是 hub 从未被部署。
 *
 * 复用 deploy-pages.mjs 的两个关键做法：
 *   1. **清掉代理环境变量** —— 本机 HTTP_PROXY 指向 127.0.0.1:7897，
 *      wrangler 会走它，而 Cloudflare 的 auth 校验经代理会失败
 *      （报「auth token has expired... could not be reached」，实为网络问题）。
 *   2. **默认走新账号的 wrangler OAuth**。
 *
 * ⚠️ 2026-10-21 账号迁移后，凭据策略已反转：
 *   本文件原来会从 D:\tmp\matrixos-cloudflare.env 读**旧账号**的 API Token
 *   并写进 process.env.CLOUDFLARE_API_TOKEN。wrangler 的环境变量优先于 OAuth，
 *   于是命令会「成功退出、打印 ✓」，但产物实际写进旧账号，
 *   新账号线上纹丝不动 —— 静默写错账号，最危险的一类错误。
 *   现在默认清除该变量；确需回滚旧账号时显式加 --legacy-account。
 *
 * 用法：node scripts/deploy-hub.mjs [--dry-run] [--legacy-account]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB = join(ROOT, 'apps', 'orbital-hub');
const ENV_FILE = 'D:\\tmp\\matrixos-cloudflare.env';
const PROJECT = 'mx-orbital';
const DRY = process.argv.includes('--dry-run');
const LEGACY = process.argv.includes('--legacy-account');

/** 当前生产账号（新账号）。 */
const PROD_ACCOUNT = 'e6bf8ab2cbb8475c1ba6d6570332c18d';
/** 旧账号（仅回滚用）。 */
const LEGACY_ACCOUNT = '002738a579821a06c4ee9241babe99f0';

/* ── 清理代理（关键） ── */
for (const k of [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]) {
  delete process.env[k];
}

/* ── 凭据：默认新账号 OAuth，绝不静默用旧 token ── */
if (LEGACY) {
  if (!existsSync(ENV_FILE)) {
    console.error(`✗ --legacy-account 需要 ${ENV_FILE}，文件不存在`);
    process.exit(1);
  }
  const txt = readFileSync(ENV_FILE, 'utf8');
  const token = /CLOUDFLARE_API_TOKEN=(.+)/.exec(txt)?.[1]?.trim();
  if (!token) {
    console.error('✗ 凭据解析失败');
    process.exit(1);
  }
  process.env.CLOUDFLARE_API_TOKEN = token;
  process.env.CLOUDFLARE_ACCOUNT_ID = LEGACY_ACCOUNT;
  console.log(`⚠️  回滚模式：目标 = 旧账号 ${LEGACY_ACCOUNT.slice(0, 8)}…`);
} else {
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = PROD_ACCOUNT;
  console.log(`目标账号 = 新账号 ${PROD_ACCOUNT.slice(0, 8)}…（wrangler OAuth）`);
}

/* ── 产物前置检查 ── */
const outIndex = join(HUB, 'out', 'index.html');
if (!existsSync(outIndex)) {
  console.error('✗ apps/orbital-hub/out/index.html 不存在 —— 先跑 node scripts/build-hub-static.mjs --production');
  process.exit(1);
}

/**
 * 关键自检：产物里**不得**含 local-mode 的 localhost 地址。
 *
 * 2026-10-21 真实事故：hub 产物被构建进 `http://127.0.0.1:3010`（`.env.example`
 * 的 LOCAL_MODE=true 被 Next DefinePlugin 静态替换），线上 iframe src 指向
 * 用户浏览器连不到的本地端口 → 内嵌态白屏 / 握手不通 / SSO 永远 offline。
 *
 * 若这里报错，正确修法是**用 --production 重建**：
 *   node scripts/build-hub-static.mjs --production
 */
function scanJs(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out.join('\n');
}
{
  const js = scanJs(join(HUB, 'out', '_next'));
  const localHits = [...new Set(js.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/g) || [])];
  if (localHits.length > 0) {
    console.error(`✗ hub 产物含 localhost 微站地址：${localHits.slice(0, 3).join(', ')}`);
    console.error('  这是 local-mode 被构建进产物的事故 —— 用 --production 重建：');
    console.error('  node scripts/build-hub-static.mjs --production');
    process.exit(1);
  }
  if (!/mx-\{appId\}\.pages\.dev|mx-[a-z-]+\.pages\.dev/.test(js)) {
    /*
     * 微站 URL 是**运行时**由 `NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE` 拼出来的
     * （`hub-config.ts` 读 env），不一定以字面量出现在产物里。
     * 所以这里不能硬要求 pages.dev 字面量，改为检查「产物里有没有 URL 模板机制」：
     *   - 有 `{appId}` / `{port}` 占位符（模板字符串被打进产物）
     *   - 或直接有具体域名（较老的构建方式）
     * 两者都没有才是真的地址注入异常。
     *
     * 教训：初始版本硬要求 pages.dev 字面量，导致「用 tunnel 地址构建的 hub」
     * 被误判为「地址注入异常」而拒绝部署 —— 断言写得比事实更严也会挡住正确的东西。
     */
    const hasTemplate =
      /\{appId\}|\{port\}/.test(js) || /https:\/\/[a-z0-9-]+\.matrixos\.(edu|cc\.cd)/.test(js);
    if (!hasTemplate) {
      console.error('✗ hub 产物既无 URL 模板占位符，也无具体域名 —— 地址注入异常，拒绝部署');
      process.exit(1);
    }
    console.log('✓ 产物 URL 自检通过（无 localhost，含 URL 模板占位符 · 运行时拼接）');
  } else {
    console.log('✓ 产物 URL 自检通过（无 localhost，含 pages.dev 模板）');
  }
}

const outHeaders = join(HUB, 'out', '_headers');
if (!existsSync(outHeaders)) {
  console.error('✗ out/_headers 不存在 —— 会丢安全头');
  process.exit(1);
}
const headers = readFileSync(outHeaders, 'utf8');
// 注意：只能匹配「以 # 开头之外的、形如 `  Header-Name: value` 的实际 header 行」。
// 早期版本用 /frame-ancestors/ 直接匹配整个文件，结果被**注释里的说明文字**命中
// （`build-hub-static.mjs` 生成的注释含「hub 不设 CSP frame-ancestors」），
// 误报成「误含 CSP」。这是「用正则扫描含注释的配置文本」的典型坑。
const headerLines = headers
  .split('\n')
  .filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'))
  .join('\n');

const problems = [];
if (!/Strict-Transport-Security:/.test(headerLines)) problems.push('缺 HSTS');
if (!/Permissions-Policy:/.test(headerLines)) problems.push('缺 Permissions-Policy');
if (/frame-ancestors/.test(headerLines)) problems.push('误含 CSP frame-ancestors（hub 是顶层页，不该有）');
if (problems.length) {
  console.error(`✗ out/_headers 不合规：${problems.join('、')}`);
  process.exit(1);
}
console.log('✓ 产物前置检查通过（index.html + _headers 含 HSTS/Permissions-Policy，无误加的 CSP）');

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: HUB,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env,
    timeout: 900000,
  });
}

if (DRY) {
  console.log(`(dry-run) 将部署 ${PROJECT} ← ${HUB}/out`);
  process.exit(0);
}

console.log(`\n▶ 部署 ${PROJECT} …`);
try {
  const out = wrangler(['pages', 'deploy', 'out', `--project-name=${PROJECT}`, '--branch=main', '--commit-dirty=true']);
  const preview = out.match(/https:\/\/[a-z0-9]+\.([a-z0-9-]+)\.pages\.dev/);
  console.log(`  ✓ 已部署${preview ? ' · ' + preview[0] : ''}`);
  console.log(`\n生产地址：${LEGACY
    ? `https://${PROJECT}.pages.dev`
    : `https://${process.env.MATRIXOS_ZONE ?? 'matrixos.cc.cd'}`}`);
  process.exit(0);
} catch (e) {
  const msg = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
  const first = msg.split('\n').find((l) => /ERROR|Error|✗/.test(l)) ?? msg.split('\n')[0];
  console.error(`  ✗ ${String(first).trim().slice(0, 240)}`);
  process.exit(1);
}
