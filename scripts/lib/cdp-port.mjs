/**
 * CDP 端口的**唯一事实源**，以及「这个端口上跑的到底是谁」的判定。
 *
 * 为什么需要这个文件（一次真实事故）：
 *   最初的 cf-shell.mjs / cdp.mjs 都把端口硬编码成 9222，探测方式只有
 *   「connectOverCDP 能不能连上」。但 9222 是 ZCode 桌面客户端的调试端口 ——
 *   用户装了 zcode-beautify 插件（`cli.js serve --port 9222 --api-port 9223`）
 *   专门连它注入壁纸和主题。
 *
 *   于是探测到「连得上」→ 误判成「我的浏览器已在运行（复用）」→ 实际接管的是
 *   **用户正在用的 ZCode 窗口**，接着 goto 把 ZCode 主窗口导去了 localhost:3000。
 *   用户当场发现「你为什么是在 Zcode 上打开」。
 *
 * 教训：只验「端口通」不够，必须验「端口上是不是我起的那个浏览器」。
 *   本文件用两个独立信号确认身份：
 *     1. /json/version 的 Browser 字段 + 是否有 Electron 特征
 *     2. 进程命令行里是否带 `--user-data-dir=<我自己的 profile 目录>`
 *   两者任一不符就判定「这个端口不是我的」，拒绝连接并报错退出。
 *
 * 端口选择：默认 9229（避开 9222 ZCode / 9223 zcode-beautify api / 9333 常见调试），
 * 可用环境变量 MATRIXOS_CDP_PORT 覆盖。
 */

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 我的专属 profile 目录 —— 用它反查「端口上的 chrome 是不是我起的」。 */
export const CDP_PROFILE_DIR = join(ROOT, '.tmp', 'cf-profile');

/** 我的专属调试端口。刻意不用 9222（ZCode 的）。 */
export const CDP_PORT = Number(process.env.MATRIXOS_CDP_PORT ?? 9229);

export const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;

/** 已知会被别的软件占用的端口，撞上就直说，不要自己去连。 */
const KNOWN_FOREIGN_PORTS = new Map([
  [9222, 'ZCode 桌面客户端（zcode-beautify 插件用它注入主题）'],
  [9223, 'zcode-beautify 插件的 API 端口'],
  [9333, '常见 Chrome 手动调试端口'],
]);

export function describeForeignPort(port) {
  return KNOWN_FOREIGN_PORTS.get(port) ?? null;
}

async function fetchJson(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 问端口「你是谁」，并判断是不是我起的浏览器。
 * @returns {Promise<{alive: boolean, mine: boolean, version?: any, reason: string}>}
 */
export async function probeCdpIdentity(port = CDP_PORT) {
  if (port !== CDP_PORT && describeForeignPort(port)) {
    return {
      alive: false,
      mine: false,
      reason: `端口 ${port} 属于${describeForeignPort(port)}，拒绝连接`,
    };
  }

  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  if (!version) {
    return { alive: false, mine: false, reason: '端口无响应（没有 CDP 服务在监听）' };
  }

  const browser = String(version.Browser ?? '');
  // 「HeadlessChrome/...」或「Chrome/...」才是 Chromium 系浏览器；
  // Electron 应用（ZCode / VSCode / 各种客户端）会报成
  // 「Chrome/xxx」但也一样，所以光看 Browser 字段不够，还要看进程命令行。
  const looksElectron = /Electron/i.test(browser);

  if (looksElectron) {
    return { alive: true, mine: false, version, reason: `端口上是 Electron 应用（${browser}），不是浏览器` };
  }

  // 关键判据：找到监听该端口的进程，**沿父进程链向上walk**，
  // 看有没有哪个祖先 chrome.exe 的 --user-data-dir 指向我的 profile。
  //
  // 为什么必须 walk：Chromium 的 network service 是独立子进程，监听 socket
  // 常常由它持有，而它命令行里不一定带 --user-data-dir。只查直接持有者会
  // 误判成「别人的浏览器」（实测就踩过一次，把刚起好的浏览器判成外人）。
  const ownedByMe = await ownsProfileViaProcessTree(port);

  if (!ownedByMe) {
    return {
      alive: true,
      mine: false,
      version,
      reason: `端口上是别人的浏览器（进程链上没有任何 --user-data-dir 指向 ${CDP_PROFILE_DIR}）`,
    };
  }
  return { alive: true, mine: true, version, reason: 'ok' };
}

/**
 * 从「监听端口的进程」沿 ParentProcessId 向上走最多 6 层，
 * 检查是否有进程的 CommandLine 带 `--user-data-dir=<CDP_PROFILE_DIR>`。
 */
async function ownsProfileViaProcessTree(port) {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $owner = (Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess
    if (-not $owner) { return }
    $cursor = [int]$owner
    for ($i = 0; $i -lt 6; $i++) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor"
      if (-not $p) { break }
      if ($p.CommandLine) { Write-Output $p.CommandLine }
      $next = [int]$p.ParentProcessId
      if ($next -le 4) { break }
      $cursor = $next
    }
  `;
  let out = '';
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
  } catch {
    return false;
  }
  const normalized = out.replace(/\\/g, '/').toLowerCase();
  const wantDir = CDP_PROFILE_DIR.replace(/\\/g, '/').toLowerCase();
  return normalized.includes(`--user-data-dir=${wantDir}`);
}
