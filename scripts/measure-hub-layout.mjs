/**
 * 量 hub 的面板实际高度 —— 排查"iframe 加载了但看不到内容"。
 * 用法：node scripts/measure-hub-layout.mjs [--url ...]
 */
import { chromium } from 'playwright';

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const URL_UNDER_TEST = argOf('url', 'https://mx-orbital.pages.dev');
const COUNT = Number(argOf('count', '1'));

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(1200);

if (COUNT > 0) {
  const caps = page.locator('button[aria-label^="挂载"]');
  for (let i = 0; i < COUNT; i += 1) {
    await caps.nth(i).evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(4000);
}

const metrics = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      display: cs.display,
      flex: cs.flex,
      flexBasis: cs.flexBasis,
      minH: cs.minHeight,
      height: cs.height,
      overflow: cs.overflow,
    };
  };
  return {
    shell: box('.hub-shell'),
    main: box('.hub-main'),
    orbit: box('.star-orbit'),
    wrapper: box('.hub-main > div'),
    rack: box('.instrument-rack'),
    toolbar: box('.rack-toolbar'),
    grid: box('.rack-grid'),
    panel: box('.panel'),
    panelHead: box('.panel-head'),
    panelBody: box('.panel-body'),
    iframe: box('iframe.panel-iframe'),
  };
});

console.log(`\n被测 ${URL_UNDER_TEST} · 挂载 ${COUNT} 台`);
console.log(JSON.stringify(metrics, null, 2));

await browser.close();
