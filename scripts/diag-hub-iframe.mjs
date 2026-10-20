/**
 * iframe 加载体验诊断：点击胶囊后到底发生了什么。
 *
 * 逐帧记录（每 250ms 一次）：
 *   - 面板的 data-mode / 骨架屏是否存在 / iframe 是否存在 / iframe data-pending
 *   - iframe 的 load 是否已发生
 *   - 面板区域截图（关键时刻）
 *
 * 用法：node scripts/diag-hub-iframe.mjs [--url ...]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.tmp', 'hub-iframe-diag');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URL_UNDER_TEST = argOf('url', 'https://mx-orbital.pages.dev');
const WATCH_MS = Number(argOf('watch', '20000'));

const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});

await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1200);

const capsule = page.locator('button[aria-label^="挂载"]').first();
const capsuleLabel = await capsule.getAttribute('aria-label');
console.log(`点击胶囊：${capsuleLabel}`);

const t0 = Date.now();
await capsule.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

/** 面板区快照（只截右栏，避免每帧整页） */
const rack = page.locator('.instrument-rack');
const panel = page.locator('.panel').first();

const timeline = [];
let shots = 0;
const shotAt = [0, 400, 900, 1500, 2500, 4000, 6000, 9000, 13000, 18000];

const snapshotState = async (t) =>
  page.evaluate(() => {
    const p = document.querySelector('.panel');
    const frame = document.querySelector('iframe.panel-iframe');
    return {
      mode: p?.getAttribute('data-mode') ?? null,
      badge: p?.querySelector('.panel-badge')?.textContent ?? null,
      skeleton: Boolean(p?.querySelector('.panel-skeleton')),
      skeletonText: p?.querySelector('.panel-skeleton')?.textContent?.trim().slice(0, 60) ?? null,
      iframe: Boolean(frame),
      pending: frame?.getAttribute('data-pending') ?? null,
      iframeSrc: frame?.getAttribute('src') ?? null,
      frameCount: document.querySelectorAll('iframe.panel-iframe').length,
      // 面板可视面积（0 = 完全不可见，说明被骨架/白屏盖住）
      panelBox: (() => {
        const b = p?.querySelector('.panel-body')?.getBoundingClientRect();
        return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null;
      })(),
    };
  });

for (const at of shotAt) {
  const wait = at - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  const state = await snapshotState();
  timeline.push({ t: Date.now() - t0, ...state });
  await rack.screenshot({ path: join(OUT, `t${String(at).padStart(5, '0')}.png`) });
  shots += 1;
  console.log(
    `  t=${String(Date.now() - t0).padStart(6)}ms  mode=${state.mode} badge=${state.badge} skeleton=${state.skeleton ? 'Y' : 'n'} iframe=${state.iframe ? 'Y' : 'n'} pending=${state.pending}`,
  );
  if (at >= WATCH_MS) break;
}

// 跨源读不到内部 DOM，但可以用 load 事件与资源时序间接判断
const iframeInfo = await page.evaluate(() => {
  const frame = document.querySelector('iframe.panel-iframe');
  if (!frame) return null;
  const entries = performance
    .getEntriesByType('resource')
    .filter((e) => e.name.startsWith(frame.src.replace(/\/$/, '')))
    .map((e) => ({ name: e.name.slice(0, 90), duration: Math.round(e.duration), start: Math.round(e.startTime) }));
  return { src: frame.src, entries: entries.slice(0, 12) };
});

console.log('\niframe 资源时序：');
if (iframeInfo) {
  console.log('  src = ' + iframeInfo.src);
  if (iframeInfo.entries.length === 0) console.log('  （跨源，resource timing 不可见）');
  for (const e of iframeInfo.entries) console.log(`  +${e.start}ms ${e.duration}ms  ${e.name}`);
}

const frames = page.frames().filter((f) => f !== page.mainFrame());
console.log(`\nframe 数：${frames.length}`);
for (const f of frames) {
  try {
    const text = await f.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 90));
    console.log(`  ${f.url().slice(0, 70)} → 正文 ${text.length ? text : '(空)'}`);
  } catch (e) {
    console.log(`  ${f.url().slice(0, 70)} → 读取失败 ${e.message.split('\n')[0].slice(0, 60)}`);
  }
}

if (errors.length) {
  console.log('\n控制台错误：');
  for (const e of errors.slice(0, 6)) console.log('  ' + e);
}

console.log(`\n截图 ${shots} 张 → ${OUT}`);
await browser.close();
