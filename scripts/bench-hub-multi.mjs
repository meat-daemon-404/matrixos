/**
 * orbital-hub · 多仪器同屏真实压力测试（1 / 2 / 3 个线上微站 iframe）
 * =====================================================================
 * 这个脚本回答一个只能用真浏览器回答的问题：
 *   「同屏挂 1 / 2 / 3 个跨源线上微站时，帧率、JS 堆、长任务各是多少？」
 *
 * 为什么不用 hub 自己的探针读数当唯一依据：
 *   探针是**产品功能**（要驱动降级），它每秒结算一次、还会做防抖；
 *   作为**测量**它有两个偏差：① 只报窗口内最长任务，不报分布；
 *   ② breach 判定会改变被测对象本身（降级后 iframe 变少）。
 *   所以这里在页面里另挂一个独立采样器（只读、不改 DOM、不触发降级判定），
 *   与探针读数**并列**记录，两者互相印证。
 *
 * 测什么（对齐 docs/01-plan/05-risks.md §R-T03 的三个触发信号）：
 *   帧率      —— rAF 计数 / 窗口时长，取 p50 与均值
 *   内存      —— performance.memory.usedJSHeapSize（需 --enable-precise-memory-info）
 *   长任务    —— PerformanceObserver('longtask')，累计条数 + 最长值
 *   冷启动    —— 点胶囊 → iframe load 的耗时（体验问题的直接量化）
 *
 * 用法：
 *   node scripts/bench-hub-multi.mjs                       # 打线上
 *   node scripts/bench-hub-multi.mjs --url http://localhost:3000
 *   node scripts/bench-hub-multi.mjs --only 3              # 只测 3 个
 *   node scripts/bench-hub-multi.mjs --throttle 12         # 降级验证：CPU 减速 12 倍
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.tmp', 'hub-bench');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const URL_UNDER_TEST = argOf('url', 'https://mx-orbital.pages.dev');
const ONLY = argOf('only', '');
const THROTTLE = Number(argOf('throttle', '0'));
const SAMPLE_MS = Number(argOf('sample', '12000'));
const LABEL = argOf('label', THROTTLE > 0 ? 'throttled' : 'normal');
const counts = ONLY ? [Number(ONLY)] : [1, 2, 3];

/** 采样时长 + 每窗口步长（与探针的 1s 窗口对齐，便于比对） */
const WINDOW_MS = 1000;

const results = [];

function stats(values) {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, p50: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    min: Math.round(sorted[0] * 10) / 10,
    max: Math.round(sorted[sorted.length - 1] * 10) / 10,
    mean: Math.round(mean * 10) / 10,
    p50: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
  };
}

/**
 * 页面内独立采样器。
 *
 * 关键约束：**只读**。不写 DOM、不调用 requestAnimationFrame 以外的东西，
 * 这样它测到的帧率才是页面本身的帧率（探针在全屏入站时也会动，但这里不动）。
 * rAF 采样与探针共存会略微互相拖慢，但两者都是一帧一次的计数，成本可忽略。
 */
async function samplePage(page, durationMs) {
  return page.evaluate(
    async ({ durationMs, windowMs }) => {
      const windows = [];
      let frames = 0;
      let longestTask = 0;
      const tasks = [];
      let heapPeak = 0;
      let lastHeap = null;

      let observer = null;
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            tasks.push(Math.round(entry.duration * 10) / 10);
            if (entry.duration > longestTask) longestTask = entry.duration;
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        observer = null;
      }

      const readHeap = () => {
        const m = performance.memory;
        if (!m || typeof m.usedJSHeapSize !== 'number') return null;
        const mb = Math.round((m.usedJSHeapSize / 1048576) * 10) / 10;
        if (mb > heapPeak) heapPeak = mb;
        lastHeap = mb;
        return mb;
      };

      readHeap();

      await new Promise((resolve) => {
        const startedAt = performance.now();
        let windowStart = startedAt;
        let windowFrames = 0;
        const tick = (now) => {
          frames += 1;
          windowFrames += 1;
          const winElapsed = now - windowStart;
          if (winElapsed >= windowMs) {
            windows.push({
              fps: Math.round((windowFrames / winElapsed) * 1000 * 10) / 10,
              heapMB: readHeap(),
              longestTaskMs: Math.round(longestTask * 10) / 10,
            });
            windowStart = now;
            windowFrames = 0;
            longestTask = 0;
          }
          if (now - startedAt >= durationMs) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      observer?.disconnect();
      return {
        windows,
        frames,
        heapPeak,
        lastHeap,
        longTasks: tasks,
        // 页面自身的 iframe 实测数（与 hub 探针同口径：数真实 DOM）
        domIframes: document.querySelectorAll('iframe.panel-iframe').length,
        allIframes: document.querySelectorAll('iframe').length,
        snapshotPanels: document.querySelectorAll('.panel[data-mode="snapshot"]').length,
        livePanels: document.querySelectorAll('.panel[data-mode="live"]').length,
        failedPanels: document.querySelectorAll('.panel[data-mode="failed"]').length,
        strategy: document.querySelector('.hub-shell')?.getAttribute('data-strategy') ?? '',
        safeVisuals: document.querySelector('.hub-shell')?.getAttribute('data-safe-visuals') ?? '',
        probeText: document.querySelector('.probe-panel')?.innerText ?? '',
        rackText: document.querySelector('.instrument-rack')?.innerText?.slice(0, 400) ?? '',
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    },
    { durationMs, windowMs: WINDOW_MS },
  );
}

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--enable-precise-memory-info'],
});

console.log(`\n被测站点：${URL_UNDER_TEST}`);
console.log(`采样时长：${SAMPLE_MS}ms/档 · CPU 减速：${THROTTLE > 0 ? THROTTLE + 'x' : '无'}`);
console.log('─'.repeat(78));

try {
  for (const n of counts) {
    // 每档用**全新 context**：微站的静态资源缓存也会被清掉，
    // 这样测的是"首次加载"（跨源 + 无缓存），正是用户点开胶囊时的真实处境。
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const failedRequests = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140));
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 140)));
    page.on('response', (r) => {
      if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 90)}`);
    });

    let row = { n, ok: false, label: LABEL, url: URL_UNDER_TEST, throttle: THROTTLE };

    try {
      if (THROTTLE > 0) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      }

      await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1500);

      const capsules = page.locator('button[aria-label^="挂载"]');
      const total = await capsules.count();
      const mountStart = Date.now();

      const iframeLoads = [];
      for (let index = 0; index < n; index += 1) {
        await capsules
          .nth(index)
          .evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await page.waitForTimeout(150);
      }

      // 等 n 个 iframe 真的出现在 DOM 里
      await page
        .waitForFunction((expected) => document.querySelectorAll('iframe.panel-iframe').length >= expected, n, {
          timeout: 25000,
        })
        .catch(() => {});

      // 逐个等 load（跨源拿不到内部 DOM，但 load 事件能拿到）
      for (let index = 0; index < n; index += 1) {
        const t0 = Date.now();
        await page
          .waitForFunction(
            (expected) => {
              const frames = Array.from(document.querySelectorAll('iframe.panel-iframe'));
              return frames.length >= expected;
            },
            index + 1,
            { timeout: 25000 },
          )
          .catch(() => {});
        iframeLoads.push(Date.now() - t0);
      }

      // 等首帧稳定：跨源 iframe 的 load 之后再给一段渲染时间
      await page.waitForTimeout(3000);
      const coldStartMs = Date.now() - mountStart;

      const sample = await samplePage(page, SAMPLE_MS);
      const fpsStats = stats(sample.windows.map((w) => w.fps));
      const heapValues = sample.windows.map((w) => w.heapMB).filter((v) => typeof v === 'number');
      const taskValues = sample.windows.map((w) => w.longestTaskMs);
      const over100 = sample.longTasks.filter((d) => d > 100);

      row = {
        ...row,
        ok: true,
        capsules: total,
        mounted: n,
        coldStartMs,
        iframeLoadMs: iframeLoads,
        fps: fpsStats,
        fpsWindows: sample.windows.map((w) => w.fps),
        heapPeakMB: sample.heapPeak || (heapValues.length ? Math.max(...heapValues) : null),
        heapLastMB: sample.lastHeap,
        longTaskCount: sample.longTasks.length,
        longTaskOver100: over100.length,
        longTaskMaxMs: sample.longTasks.length ? Math.max(...sample.longTasks) : 0,
        longTaskWindowMaxMs: Math.max(...taskValues, 0),
        domIframes: sample.domIframes,
        snapshotPanels: sample.snapshotPanels,
        livePanels: sample.livePanels,
        failedPanels: sample.failedPanels,
        strategy: sample.strategy,
        safeVisuals: sample.safeVisuals,
        probeText: sample.probeText.replace(/\n+/g, ' | ').slice(0, 400),
        rackText: sample.rackText.replace(/\n+/g, ' | ').slice(0, 240),
        consoleErrors: consoleErrors.slice(0, 5),
        failedRequests: failedRequests.slice(0, 5),
      };

      await page.screenshot({ path: join(OUT, `${LABEL}-${n}iframe.png`), fullPage: false });

      const verdict =
        fpsStats.p50 >= 45 && (row.heapPeakMB ?? 0) <= 800 && row.longTaskWindowMaxMs <= 100
          ? 'ok'
          : 'over-budget';
      row.budgetVerdict = verdict;

      console.log(
        `\n[${n} iframe] 挂载 ${total} 个胶囊 · 冷启动 ${coldStartMs}ms · DOM iframe ${sample.domIframes}` +
          `\n  fps  p50 ${fpsStats.p50} / 均值 ${fpsStats.mean} / 最低 ${fpsStats.min}` +
          `\n  堆 峰值 ${row.heapPeakMB ?? 'n/a'}MB · 长任务 ${row.longTaskCount} 条（>100ms ${over100.length} 条，最长 ${row.longTaskMaxMs}ms）` +
          `\n  策略 ${sample.strategy || '?'} · 面板 live ${sample.livePanels} / snapshot ${sample.snapshotPanels} / failed ${sample.failedPanels}` +
          `\n  预算判定 ${verdict}`,
      );
      console.log(`  探针读数：${row.probeText}`);
    } catch (e) {
      row.error = e.message.split('\n')[0];
      console.log(`\n[${n} iframe] ✗ ${row.error}`);
    }

    results.push(row);
    await context.close();
  }
} finally {
  await browser.close();
}

const file = join(OUT, `bench-${LABEL}.json`);
writeFileSync(file, JSON.stringify({ url: URL_UNDER_TEST, throttle: THROTTLE, at: new Date().toISOString(), results }, null, 2));

console.log('\n' + '─'.repeat(78));
console.log('| iframe | fps p50 | fps min | 堆峰值 | 长任务>100ms | 冷启动 | DOM iframe | 策略 | 预算 |');
console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- | :--- |');
for (const r of results) {
  if (!r.ok) {
    console.log(`| ${r.n} | — | — | — | — | — | — | 失败：${r.error} | |`);
    continue;
  }
  console.log(
    `| ${r.n} | ${r.fps.p50} | ${r.fps.min} | ${r.heapPeakMB ?? 'n/a'}MB | ${r.longTaskOver100}（最长 ${r.longTaskMaxMs}ms） | ${r.coldStartMs}ms | ${r.domIframes} | ${r.strategy} | ${r.budgetVerdict} |`,
  );
}
console.log(`\nJSON：${file}`);
console.log(`截图：${OUT}`);
