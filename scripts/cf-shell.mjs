/**
 * 以「带 CDP 调试端口」的方式托管一个**有界面**的 Chromium。
 *
 * ⚠️ 端口选择（一次真实事故换来的规矩）：
 *   最初这里硬编码 9222，而 9222 是 **ZCode 桌面客户端**的调试端口 ——
 *   用户装了 zcode-beautify 插件（`cli.js serve --port 9222`）专门连它注入
 *   壁纸和 Material You 主题。脚本探测到「端口连得上」就误判成「我的浏览器
 *   已在运行（复用）」，实际接管了用户正在用的 ZCode 窗口，后续 goto 直接把
 *   ZCode 主界面导去了 localhost。用户当场发现并质问。
 *
 *   现在的规矩：
 *     · 默认端口 9229，绝不复用 9222 / 9223 / 9333
 *     · 探测不只看「连得上」，还要验「端口上的进程 --user-data-dir 是不是我这
 *       个 profile」（见 scripts/lib/cdp-port.mjs）
 *     · 身份不符直接报错退出，绝不去连别人的窗口
 *
 * 与 cf-login.mjs 的区别：
 *   cf-login.mjs 用 launchPersistentContext，进程内持有浏览器句柄，
 *   脚本一退出浏览器就关。适合「开个窗让用户自己点」。
 *
 *   本脚本直接 spawn chrome.exe --remote-debugging-port，浏览器独立存活，
 *   任何后续脚本都能接管它。这样 AI 可以分多步操作（截图 → 点击 → 再截图），
 *   不会因单次调用结束而丢失窗口。
 *
 * 用法：
 *   node scripts/cf-shell.mjs            # 启动（若已在跑则复用）
 *   node scripts/cf-shell.mjs --status   # 只看状态
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { CDP_PORT, CDP_PROFILE_DIR, probeCdpIdentity } from './lib/cdp-port.mjs';

// 启动页用本地 dev server，不去碰 Cloudflare 登录页 ——
// 那是上一次一次性任务留下的硬编码，留着会让每次启动都落到无关页面。
const START_URL = process.env.MATRIXOS_CDP_START_URL ?? 'http://localhost:3000';

mkdirSync(CDP_PROFILE_DIR, { recursive: true });

const exe = chromium.executablePath();

const status = await probeCdpIdentity(CDP_PORT);

if (process.argv.includes('--status')) {
  if (status.mine) {
    console.log(`✓ 我的浏览器在运行 · 端口 ${CDP_PORT} · ${status.version?.Browser ?? ''}`);
  } else {
    console.log(`✗ 端口 ${CDP_PORT} 上没有我的浏览器：${status.reason}`);
  }
  process.exit(status.mine ? 0 : 1);
}

if (status.mine) {
  console.log(`浏览器已在运行（复用）· 端口 ${CDP_PORT} · ${status.version?.Browser ?? ''}`);
  process.exit(0);
}

if (status.alive && !status.mine) {
  // 端口被别人的程序占着：绝不接管，直接失败并说明是什么。
  console.error(`✗ 端口 ${CDP_PORT} 被占用，且不是我的浏览器：${status.reason}`);
  console.error('  换个端口：设置 MATRIXOS_CDP_PORT 后重跑。');
  process.exit(1);
}

console.log(`启动 Chromium（CDP 端口 ${CDP_PORT}）...`);

const child = spawn(
  exe,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CDP_PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--disable-blink-features=AutomationControlled',
    START_URL,
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();

let ok = false;
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await probeCdpIdentity(CDP_PORT);
  if (s.mine) {
    ok = true;
    console.log(`✓ 就绪 · 端口 ${CDP_PORT} · ${s.version?.Browser ?? ''}`);
    break;
  }
}

if (!ok) {
  console.error(`✗ 启动超时（端口 ${CDP_PORT} 未出现我的浏览器）`);
  process.exit(1);
}
