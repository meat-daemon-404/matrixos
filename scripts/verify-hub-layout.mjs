/**
 * 线上 P0 验证：点开胶囊后，仪器面板必须有真实高度。
 *
 * 教训（2026-10-20）：跨源 iframe 即使外层宽高为 0，page.frames() 仍能读到
 * 内部 DOM——「iframe 内容正常」是假阳性。必须量外层盒子 + 看截图。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const OUT = 'D:/MatrixOS/.tmp/p0-verify';
mkdirSync(OUT, { recursive: true });

const HUB = process.argv[2] ?? 'https://mx-orbital.pages.dev';

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const fails = [];
page.on('response', (r) => { if (r.status() >= 400) fails.push(`${r.status()} ${r.url().slice(0, 90)}`); });

console.log(`打开 ${HUB}`);
await page.goto(HUB, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(2500);

async function measure(label) {
  const m = await page.evaluate(() => {
    const h = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().height) : null;
    };
    const iframes = Array.from(document.querySelectorAll('iframe.panel-iframe')).map((f) => ({
      src: (f.getAttribute('src') || '').slice(0, 60),
      w: Math.round(f.getBoundingClientRect().width),
      h: Math.round(f.getBoundingClientRect().height),
    }));
    return {
      rack: h('.instrument-rack'),
      grid: h('.rack-grid'),
      panel: h('.panel'),
      panelBody: h('.panel-body'),
      iframes,
    };
  });
  console.log(`\n【${label}】`);
  console.log(`  .instrument-rack=${m.rack}  .rack-grid=${m.grid}  .panel=${m.panel}  .panel-body=${m.panelBody}`);
  for (const f of m.iframes) console.log(`  iframe ${f.w}x${f.h}  ${f.src}`);
  return m;
}

const empty = await measure('空态（0 台）');
await page.screenshot({ path: `${OUT}/01-empty.png` });

const caps = page.locator('button[aria-label^="挂载"]');
const n = await caps.count();
console.log(`\n胶囊数：${n}`);

// 挂 1 台
await caps.nth(10).evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(6000);
const one = await measure('挂 1 台');
await page.screenshot({ path: `${OUT}/02-one.png` });

// 挂 2 台
await caps.nth(0).evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(5000);
const two = await measure('挂 2 台');
await page.screenshot({ path: `${OUT}/03-two.png` });

// 挂 3 台
await caps.nth(5).evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
await page.waitForTimeout(5000);
const three = await measure('挂 3 台');
await page.screenshot({ path: `${OUT}/04-three.png` });

await browser.close();

// ── 判定 ──
let bad = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) bad++;
};
console.log('\n═══ P0 判定 ═══');
check('rack 高度 > 400', one.rack > 400, `rack=${one.rack}`);
check('panel-body 高度 > 200', one.panelBody > 200, `body=${one.panelBody}`);
check('iframe 高度 > 200', one.iframes.length > 0 && one.iframes.every((f) => f.h > 200),
  JSON.stringify(one.iframes.map((f) => f.h)));
check('2 台时两个 iframe 都有高度', two.iframes.length >= 2 && two.iframes.every((f) => f.h > 150),
  JSON.stringify(two.iframes.map((f) => f.h)));
check('3 台时 rack 仍撑满', three.rack > 400, `rack=${three.rack}`);
check('无失败请求', fails.length === 0, fails.slice(0, 3).join(' | '));

console.log(`\n${bad === 0 ? '✓ P0 修复已在线上生效' : `✗ ${bad} 项不达标`}`);
console.log(`截图：${OUT}`);
process.exit(bad === 0 ? 0 : 1);
