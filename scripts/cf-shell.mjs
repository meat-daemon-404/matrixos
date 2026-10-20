/**
 * 以「带 CDP 调试端口」的方式托管一个**有界面**的 Chromium。
 *
 * 与 cf-login.mjs 的区别：
 *   cf-login.mjs 用 launchPersistentContext，进程内持有浏览器句柄，
 *   脚本一退出浏览器就关。适合「开个窗让用户自己点」。
 *
 *   本脚本直接 spawn chrome.exe --remote-debugging-port=9222，
 *   浏览器独立存活，任何后续脚本都能通过 connectOverCDP 接管它。
 *   这样 AI 可以分多步操作（截图 → 点击 → 再截图），不会因单次调用结束而丢失窗口。
 *
 * 用法：
 *   node scripts/cf-shell.mjs            # 启动（若已在跑则复用）
 *   node scripts/cf-shell.mjs --status   # 只看状态
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER_DATA_DIR = join(ROOT, '.tmp', 'cf-profile');
const PORT = 9222;
const START_URL = 'https://dash.cloudflare.com/login';

mkdirSync(USER_DATA_DIR, { recursive: true });

const exe = chromium.executablePath();

async function probe() {
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 3000 });
    const ctx = b.contexts()[0];
    const pages = ctx ? ctx.pages() : [];
    const url = pages.length ? pages[0].url() : '(no page)';
    await b.close();
    return { alive: true, url };
  } catch (e) {
    return { alive: false, error: e.message.split('\n')[0] };
  }
}

if (process.argv.includes('--status')) {
  const s = await probe();
  console.log(s.alive ? `浏览器在运行 · 当前页 ${s.url}` : `浏览器未运行 · ${s.error}`);
  process.exit(s.alive ? 0 : 1);
}

const before = await probe();
if (before.alive) {
  console.log(`浏览器已在运行（复用）· 当前页 ${before.url}`);
  process.exit(0);
}

console.log(`启动 Chromium（CDP 端口 ${PORT}）...`);

const child = spawn(
  exe,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--disable-blink-features=AutomationControlled',
    START_URL,
  ],
  { detached: true, stdio: 'ignore' },
);
child.unref();

// 等端口就绪
let ok = false;
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await probe();
  if (s.alive) {
    ok = true;
    console.log(`✓ 就绪 · 当前页 ${s.url}`);
    break;
  }
}

if (!ok) {
  console.error('✗ 启动超时');
  process.exit(1);
}
