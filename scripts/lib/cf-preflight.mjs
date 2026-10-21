/**
 * Cloudflare 凭据前置检查 —— 依赖 `cf` CLI 或 `wrangler` 的脚本在动手之前先调用。
 *
 * 为什么需要：
 *   `cf` 的 OAuth token 是短期凭证（实测约 24 小时，且不会自动续期）。
 *   过期后 `cf` 的报错是 `[9106] Authentication failed (status: 400)`，
 *   这个措辞既不提「过期」也不提「未登录」，看到的人第一反应会去查网络、
 *   查权限、查账号 ID，实际只需重新 `cf auth login`。
 *
 *   另一个同族风险：若环境里残留 `CLOUDFLARE_API_TOKEN`，它会覆盖 OAuth，
 *   于是命令可能打到别的账号（甚至旧账号）——那类问题表现为「成功但写错地方」，
 *   比直接报错更难发现。
 *
 *   cf 与 wrangler 是两条互不相通的凭据链：
 *     cf       -> ~/.config/cloudflare/config/default.enc
 *     wrangler -> ~/.config/.wrangler/config/default.toml（有 refresh_token，可自动续）
 *   所以两个函数分别检查，别混用。
 *
 * @module
 */
import { execFileSync } from 'node:child_process';

const NOISE = /node\.exe|^\s+at\s|DeprecationWarning|CategoryInfo|FullyQualifiedErrorId|所在位置|字符|RemoteException|^\s*\+\s|Assertion failed/;

/** 当前生产账号（新账号）。 */
export const PROD_ACCOUNT = 'e6bf8ab2cbb8475c1ba6d6570332c18d';
/** 旧账号（仅回滚用）。 */
export const LEGACY_ACCOUNT = '002738a579821a06c4ee9241babe99f0';

/** 从 wrangler whoami 输出里取邮箱（去掉结尾标点）。 */
const EMAIL_RE = /associated with the email\s+([^\s.]+)/i;

/** 清掉代理环境变量（wrangler / cf 经本地代理会 TLS 失败）。 */
export function clearProxyEnv() {
  for (const k of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ]) {
    delete process.env[k];
  }
}

/** 环境变量优先级高于 OAuth，残留会把命令打到别的账号。 */
function rejectAmbientToken(tool) {
  if (!process.env.CLOUDFLARE_API_TOKEN) return;
  console.error(
    `✗ 检测到 CLOUDFLARE_API_TOKEN 环境变量，它会覆盖 ${tool} 的 OAuth 登录态。\n` +
    '  若它属于旧账号，命令会打到旧账号：表现是「命令成功、URL 也对，但线上没变」。\n' +
    '  修法：先清除该变量再重跑\n' +
    '    PowerShell: Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue\n' +
    '    bash:       unset CLOUDFLARE_API_TOKEN',
  );
  process.exit(1);
}

/**
 * 断言 `cf` CLI 已登录且可访问到期望账号。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.requireAccount] 必须能看到该账号（默认 PROD_ACCOUNT，传 null 跳过）
 * @param {boolean} [opts.quiet] 成功时不打印
 */
export function assertCfReady(opts = {}) {
  const requireAccount = opts.requireAccount === undefined ? PROD_ACCOUNT : opts.requireAccount;
  const quiet = opts.quiet ?? false;

  rejectAmbientToken('cf');

  let out;
  try {
    out = execFileSync('cf', ['auth', 'whoami'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', timeout: 120000,
    });
  } catch (e) {
    const raw = `${e.stdout || ''}${e.stderr || ''}`;
    const clean = raw.split('\n').filter((l) => !NOISE.test(l)).join('\n');
    console.error(`✗ cf auth whoami 失败：\n${clean.trim().slice(0, 400)}`);
    console.error('\n若提示 Authentication failed 或 Not logged in，重新登录：\n  cf auth login');
    process.exit(1);
  }

  const clean = out.split('\n').filter((l) => !NOISE.test(l)).join('\n');
  let info = null;
  const from = clean.indexOf('{');
  const to = clean.lastIndexOf('}');
  if (from !== -1 && to > from) {
    try { info = JSON.parse(clean.slice(from, to + 1)); } catch { /* 走下面的兜底 */ }
  }

  if (!info) {
    console.error('✗ 无法解析 cf auth whoami 的输出（CLI 版本可能变化）。原始输出：');
    console.error(clean.trim().slice(0, 400));
    process.exit(1);
  }

  if (info.authenticated !== true || info.tokenValid === false) {
    console.error(`✗ cf 未登录或凭据无效：${info.error ?? 'tokenValid=' + info.tokenValid}`);
    console.error('\n修法：\n  cf auth login');
    process.exit(1);
  }

  if (requireAccount) {
    const ids = (info.accounts ?? []).map((a) => a.id);
    if (!ids.includes(requireAccount)) {
      console.error(
        `✗ 当前 cf 登录态看不到目标账号 ${requireAccount}\n` +
        `  可见账号: ${ids.length ? ids.join(', ') : '(无)'}\n` +
        `  登录邮箱: ${info.email ?? '(未知)'}\n\n` +
        '  说明登录的是另一个 Cloudflare 账号。修法：\n' +
        '    cf auth login',
      );
      process.exit(1);
    }
  }

  /* cf 的 token 不自动续期，静默过期后的报错很难懂，所以主动报出来 */
  if (!quiet) {
    const exp = info.expiresAt ? new Date(info.expiresAt) : null;
    if (exp && !Number.isNaN(exp.getTime())) {
      const mins = Math.round((exp.getTime() - Date.now()) / 60000);
      const when = exp.toLocaleString('zh-CN', { hour12: false });
      if (mins <= 0) {
        console.error(`✗ cf 凭据已过期（${when}）。修法：\n  cf auth login`);
        process.exit(1);
      }
      if (mins < 120) {
        console.warn(`⚠  cf 凭据 ${mins} 分钟后过期（${when}）；长任务可能中途失效，必要时先 cf auth login`);
      }
    }
  }

  return { ok: true, email: info.email, expiresAt: info.expiresAt };
}

/**
 * 断言 `wrangler` 已用 OAuth 登录且能看到期望账号。
 *
 * @param {object} [opts]
 * @param {string|null} [opts.requireAccount] 必须能看到该账号（默认 PROD_ACCOUNT，传 null 跳过）
 * @param {boolean} [opts.quiet] 成功时不打印
 * @param {string} [opts.cwd] 运行目录（wrangler 需要能读到 package.json）
 */
export function assertWranglerReady(opts = {}) {
  const requireAccount = opts.requireAccount === undefined ? PROD_ACCOUNT : opts.requireAccount;
  const quiet = opts.quiet ?? false;
  const cwd = opts.cwd ?? process.cwd();

  rejectAmbientToken('wrangler');

  let out;
  try {
    out = execFileSync('npx', ['wrangler', 'whoami'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', timeout: 180000,
    });
  } catch (e) {
    const raw = `${e.stdout || ''}${e.stderr || ''}`;
    const clean = raw.split('\n').filter((l) => !NOISE.test(l)).join('\n');
    console.error(`✗ wrangler whoami 失败：\n${clean.trim().slice(0, 400)}`);
    console.error('\n修法：\n  npx wrangler login');
    process.exit(1);
  }

  const clean = out.split('\n').filter((l) => !NOISE.test(l)).join('\n');

  if (/Not logged in|not authenticated/i.test(clean)) {
    console.error('✗ wrangler 未登录。修法：\n  npx wrangler login');
    process.exit(1);
  }

  const email = EMAIL_RE.exec(clean)?.[1] ?? null;

  if (requireAccount && !clean.includes(requireAccount)) {
    console.error(
      `✗ 当前 wrangler 登录态看不到目标账号 ${requireAccount}\n` +
      `  登录邮箱: ${email ?? '(未能解析)'}\n\n` +
      '  说明登录的是另一个 Cloudflare 账号。修法：\n' +
      '    npx wrangler logout ; npx wrangler login',
    );
    process.exit(1);
  }

  if (!quiet) {
    console.log(`wrangler 登录态 OK${email ? '（' + email + '）' : ''}`);
  }

  return { ok: true, email };
}
