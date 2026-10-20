/**
 * 原生 CDP 客户端 —— 不依赖 Playwright 的 connectOverCDP。
 *
 * 为什么需要它：
 *   Playwright 1.64 连 Chrome 156 的 CDP 时，WebSocket 能连上但
 *   `Target.setAutoAttach` 握手超时（版本兼容问题）。
 *   本文件用 Node 内置 WebSocket 直接说 CDP 协议，绕开 Playwright。
 *
 * 用法：
 *   node scripts/cdp.mjs list                      列出所有页面
 *   node scripts/cdp.mjs shot [--label=xxx]        截图当前页
 *   node scripts/cdp.mjs goto <url>                导航
 *   node scripts/cdp.mjs eval "<js>"               执行 JS
 *   node scripts/cdp.mjs click <selector>          点击元素
 *   node scripts/cdp.mjs text                      取页面可见文本
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, '.tmp', 'cf-shots');
const CDP_HTTP = 'http://127.0.0.1:9222';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'list';
const getArg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

/* ─────────────────────── CDP 基础 ─────────────────────── */

async function listTargets() {
  const r = await fetch(`${CDP_HTTP}/json/list`);
  return r.json();
}

/** 建一个指向具体 page target 的 CDP 连接。 */
async function connectPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(t);
      reject(new Error(`WebSocket 错误: ${e.message ?? 'unknown'}`));
    });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, timeoutMs);
    });

  return { ws, send, events, close: () => ws.close() };
}

/** 挑一个合适的 page target（优先非 devtools 的、有 url 的）。 */
function pickPage(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('没有可用的 page target');
  // 优先 dash.cloudflare.com
  return (
    pages.find((p) => p.url.includes('cloudflare.com')) ??
    pages.find((p) => !p.url.startsWith('devtools://')) ??
    pages[0]
  );
}

/* ─────────────────────── 命令实现 ─────────────────────── */

async function doList() {
  const targets = await listTargets();
  for (const t of targets) {
    console.log(`[${t.type}] ${t.url}`);
    console.log(`   title: ${t.title}`);
  }
}

async function withPage(fn) {
  const targets = await listTargets();
  const target = pickPage(targets);
  const conn = await connectPage(target.webSocketDebuggerUrl);
  try {
    await conn.send('Page.enable');
    await conn.send('Runtime.enable');
    return await fn(conn, target);
  } finally {
    conn.close();
  }
}

async function doShot() {
  const label = getArg('label') ?? 'shot';
  return withPage(async (conn, target) => {
    // 后台标签页不会渲染，captureScreenshot 会一直挂着。
    // 先把这个 target 拉到前台（Page.bringToFront），再等一帧。
    try {
      await conn.send('Page.bringToFront', {}, 5000);
    } catch {
      /* 某些 target 不支持，忽略 */
    }
    try {
      await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 5000);
    } catch {
      /* 忽略 */
    }
    await new Promise((r) => setTimeout(r, 800));

    const { data } = await conn.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    }, 20000);
    mkdirSync(SHOTS, { recursive: true });
    const path = join(SHOTS, `${Date.now()}-${label}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    console.log(`标题：${target.title}`);
    console.log(`URL ：${target.url}`);
    console.log(`截图：${path}`);
  });
}

async function doGoto(url) {
  return withPage(async (conn) => {
    await conn.send('Page.navigate', { url });
    // 等 load
    await new Promise((r) => setTimeout(r, 3000));
    const { result } = await conn.send('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title})',
      returnByValue: true,
    });
    console.log(result.value);
  });
}

async function doEval(expr) {
  return withPage(async (conn) => {
    const { result, exceptionDetails } = await conn.send('Runtime.evaluate', {
      expression: `(async () => { return (${expr}); })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      console.error('异常：', exceptionDetails.text, exceptionDetails.exception?.description ?? '');
      process.exitCode = 1;
      return;
    }
    console.log(typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2));
  });
}

async function doClick(sel) {
  return withPage(async (conn) => {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return JSON.stringify({ok:false, reason:'找不到元素 ${sel}'});
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return JSON.stringify({ok:false, reason:'元素不可见'});
      el.scrollIntoView({block:'center'});
      el.click();
      return JSON.stringify({ok:true, tag: el.tagName, text:(el.textContent||'').trim().slice(0,80)});
    })()`;
    const { result } = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(result.value);
    await new Promise((r) => setTimeout(r, 2000));
  });
}

async function doText() {
  return withPage(async (conn) => {
    const { result } = await conn.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\\n{2,}/g,'\\n').slice(0, 4000)
      })`,
      returnByValue: true,
    });
    console.log(result.value);
  });
}

/* ─────────────────────── 分发 ─────────────────────── */

try {
  switch (cmd) {
    case 'list':
      await doList();
      break;
    case 'shot':
      await doShot();
      break;
    case 'goto':
      await doGoto(argv[1]);
      break;
    case 'eval':
      await doEval(argv[1]);
      break;
    case 'click':
      await doClick(argv[1]);
      break;
    case 'text':
      await doText();
      break;
    default:
      console.error(`未知命令：${cmd}`);
      process.exit(1);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
