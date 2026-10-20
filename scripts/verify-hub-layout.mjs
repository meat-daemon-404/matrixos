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

/*
 * 预置「已看过引导」标记，让首访引导不要弹出。
 *
 * 引导层是 `position:fixed; inset:0; z-index:200`，虽然它用 box-shadow 挖洞
 * 不挡视线，但会盖住交互层 —— 而本脚本靠 dispatchEvent 点胶囊，
 * 叠了引导层时点击能否穿透取决于 pointer-events，是没必要的干扰变量。
 * 本脚本验的是面板布局，不是引导（引导有 verify-onboarding.mjs 专测）。
 */
await page.addInitScript(() => {
  // 值必须是 'done'：readOnboarded() 严格比较 === 'done'。
  // 写成 '1' 会被判为未看过，引导照弹（这个错值我自己踩过一次）。
  localStorage.setItem('matrixos:hub:onboarded:v1', 'done');
});

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
    // 面板要连 mode 一起读：非 live 面板按设计不建 iframe（性能红线 R-T03），
    // 只数 iframe 会把「快照降级生效」误判成「面板塌陷」。
    const panels = Array.from(document.querySelectorAll('.panel')).map((el) => ({
      mode: el.getAttribute('data-mode'),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    }));
    return {
      rack: h('.instrument-rack'),
      grid: h('.rack-grid'),
      panel: h('.panel'),
      panelBody: h('.panel-body'),
      iframes,
      panels,
    };
  });
  console.log(`\n【${label}】`);
  console.log(`  .instrument-rack=${m.rack}  .rack-grid=${m.grid}  .panel=${m.panel}  .panel-body=${m.panelBody}`);
  for (const f of m.iframes) console.log(`  iframe ${f.w}x${f.h}  ${f.src}`);
  for (const p of m.panels) console.log(`  panel ${p.w}x${p.h}  mode=${p.mode}`);
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

/*
 * 2 台时**只断言有面板撑开**，不断言「两个 iframe」。
 *
 * 原断言是 `two.iframes.length >= 2`，线上稳定红。查下来不是布局坏了，
 * 是断言写错了：性能红线 R-T03 规定未激活面板**不创建 iframe**，
 * liveBudget 会只留最新一台 `mode=live`，其余降级为 `mode=snapshot` 静态图。
 * 实测 2 台时：panel[0] mode=snapshot hasIframe=false，panel[1] mode=live
 * hasIframe=true iframeH=627 —— 两台面板都是 519x670 正常撑开。
 *
 * 所以正确的判据是「面板都占到了高度、且至少一台是 live」，
 * 而不是「iframe 数量等于面板数量」。用 iframe 数量当健康指标，
 * 会把「性能优化生效」误判成「布局塌陷」。
 */
check('2 台时两个面板都有高度', two.panels.length >= 2 && two.panels.every((p) => p.h > 150),
  JSON.stringify(two.panels.map((p) => ({ h: p.h, mode: p.mode }))));
check('2 台时至少一台 live（有 iframe）', two.iframes.length >= 1,
  JSON.stringify(two.panels.map((p) => p.mode)));

check('3 台时 rack 仍撑满', three.rack > 400, `rack=${three.rack}`);
check('无失败请求', fails.length === 0, fails.slice(0, 3).join(' | '));

console.log(`\n${bad === 0 ? '✓ P0 修复已在线上生效' : `✗ ${bad} 项不达标`}`);
console.log(`截图：${OUT}`);
process.exit(bad === 0 ? 0 : 1);
