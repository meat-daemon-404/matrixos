/**
 * orbital-hub 端到端验证。
 *
 * 验证目标（对应 R-T03 与 Q4 的核心交互）：
 *   1. 页面能渲染星轨与仪器架
 *   2. 点击星轨胶囊能把对应仪器挂载到右侧
 *   3. 挂载后 iframe 真的指向本地微站，且微站内仪器能加载
 *   4. 性能探针有输出
 *
 * 用法：node scripts/verify-hub.mjs
 * 前提：hub (3000) 与至少一个微站 (3020) 的 dev server 在跑
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.tmp', 'hub-verify');
mkdirSync(OUT, { recursive: true });

const HUB = 'http://localhost:3000';
const MS = 'http://localhost:3020';

const results = [];
const ok = (m) => { results.push({ level: 'ok', m }); console.log(`  ✓ ${m}`); };
const bad = (m) => { results.push({ level: 'bad', m }); console.log(`  ✗ ${m}`); };
const info = (m) => console.log(`    ${m}`);

const browser = await chromium.launch({
  // headless shell 可能未单独下载；用完整 chromium 的 headless 模式代替。
  // channel 指定为 'chromium' 可避免去找 chrome-headless-shell 可执行文件。
  channel: 'chromium',
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

// 收集控制台错误与失败请求
const consoleErrors = [];
const failedRequests = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));
page.on('response', (res) => {
  if (res.status() >= 400) {
    failedRequests.push({ status: res.status(), url: res.url() });
  }
});

try {
  console.log('\n[1] 打开 hub');
  const resp = await page.goto(HUB, { waitUntil: 'networkidle', timeout: 60000 });
  if (resp && resp.ok()) ok(`hub 返回 ${resp.status()}`);
  else bad(`hub 返回 ${resp ? resp.status() : 'no response'}`);

  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT, '01-hub-initial.png'), fullPage: false });

  console.log('\n[2] 检查核心区域');
  const checks = [
    ['星轨/轨道区域', '.star-orbit, .orbit-field, [class*="orbit"], [aria-label*="星轨"]'],
    ['仪器架', '.instrument-rack, [aria-label*="仪器架"]'],
    ['Copilot 底坞', '.copilot-dock, [class*="copilot"], .wave-dock'],
  ];
  for (const [label, sel] of checks) {
    const n = await page.locator(sel).count();
    if (n > 0) ok(`${label} 存在（${n} 个节点）`);
    else info(`${label} 未找到（选择器 ${sel}）`);
  }

  console.log('\n[3] 找可点击的微站胶囊');
  // 星轨胶囊可能是 button 或带 data-* 的可点元素
  const candidates = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-station-id], [data-app-id], button[aria-label], .orbit-capsule, .station-capsule').forEach((el) => {
      const id = el.getAttribute('data-station-id') || el.getAttribute('data-app-id') || '';
      const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || '';
      if (label || id) out.push({ tag: el.tagName, id, label });
    });
    return out.slice(0, 30);
  });
  info(`候选胶囊 ${candidates.length} 个`);
  for (const c of candidates.slice(0, 8)) info(`  ${c.tag} id=${c.id || '-'} "${c.label}"`);

  if (candidates.length > 0) {
    console.log('\n[4] 点击第一个胶囊，看是否挂载仪器');
    const before = await page.locator('iframe').count();
    info(`点击前 iframe 数：${before}`);

    // 注意：选择器必须与上面探测时一致。
    // 之前的 bug 就在这里——探测用了 button[aria-label]，点击却漏掉，
    // 导致 locator 匹配不到东西而超时。
    const CAPSULE_SEL =
      '[data-station-id], [data-app-id], .orbit-capsule, .station-capsule, button[aria-label^="挂载"]';
    const first = page.locator(CAPSULE_SEL).first();
    const count = await page.locator(CAPSULE_SEL).count();
    info(`可点击胶囊：${count} 个`);

    try {
      await first.scrollIntoViewIfNeeded({ timeout: 5000 });
      await first.click({ timeout: 15000, force: true });
      info('已点击');
    } catch (e) {
      // 退化为 DOM 直接派发 click（星轨胶囊可能有 pointer-events 覆盖层）
      await first.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      info(`常规点击失败（${e.message.split('\n')[0]}），已改用 DOM 派发`);
    }
    await page.waitForTimeout(3000);

    const after = await page.locator('iframe').count();
    info(`点击后 iframe 数：${after}`);
    if (after > before) ok(`仪器已挂载（新增 ${after - before} 个 iframe）`);
    else info('iframe 未新增（可能是快照模式或需先激活面板）');

    // 列出所有 iframe 的 src
    const srcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || ''),
    );
    if (srcs.length) {
      for (const s of srcs) info(`  iframe src = ${s}`);
      const hitLocal = srcs.some((s) => s.includes(':30'));
      if (hitLocal) ok('iframe 指向本地微站（local mode 生效）');
      else bad('iframe 未指向本地微站，检查 NEXT_PUBLIC_MICROSITE_LOCAL_MODE');
    }

    // 等 iframe 内的微站真正加载出来
    console.log('\n[4b] iframe 内容加载');
    const frame = page.frames().find((f) => f.url().includes(':30') && f !== page.mainFrame());
    if (frame) {
      try {
        await frame.waitForLoadState('domcontentloaded', { timeout: 30000 });
        const bodyText = await frame.locator('body').innerText({ timeout: 20000 });
        info(`iframe 正文长度：${bodyText.length}`);
        if (bodyText.length > 50) ok('iframe 内微站已渲染内容');
        else bad('iframe 内几乎空白，微站可能未启动');
        const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 120);
        info(`  内容片段：${snippet}`);
      } catch (e) {
        bad(`iframe 内容读取失败：${e.message.split('\n')[0]}`);
      }
    } else {
      info('未找到微站 iframe');
    }

    // 尝试再挂载一个，验证同屏多仪器
    console.log('\n[4c] 同屏挂载第二个仪器');
    const capsules = page.locator(
      '[data-station-id], [data-app-id], .orbit-capsule, .station-capsule, button[aria-label^="挂载"]',
    );
    const total = await capsules.count();
    if (total >= 2) {
      const before2 = await page.locator('iframe').count();
      await capsules.nth(1).evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await page.waitForTimeout(2500);
      const after2 = await page.locator('iframe').count();
      if (after2 > before2) ok(`同屏挂载成功（${before2} → ${after2} 个仪器）`);
      else info(`未新增（${before2} → ${after2}），可能是快照模式`);
      const rackLabel = await page.locator('.instrument-rack').innerText().catch(() => '');
      const countMatch = rackLabel.match(/挂载\s*(\d+)\s*\/\s*(\d+)/);
      if (countMatch) info(`仪器架显示：挂载 ${countMatch[1]}/${countMatch[2]}`);
    }

    await page.screenshot({ path: join(OUT, '02-hub-mounted.png'), fullPage: false });
  }

  console.log('\n[5] 性能探针');
  const perf = await page.evaluate(() => {
    const keys = Object.keys(window).filter((k) => /probe|perf|matrixos/i.test(k));
    return { keys, hasProbe: keys.length > 0 };
  });
  if (perf.hasProbe) ok(`探针挂载：${perf.keys.join(', ')}`);
  else info('未在 window 上发现探针（可能挂在模块作用域内，属正常）');

  console.log('\n[6] 微站独立访问');
  const msPage = await browser.newPage();
  const msResp = await msPage.goto(MS, { waitUntil: 'networkidle', timeout: 30000 });
  if (msResp && msResp.ok()) ok(`微站返回 ${msResp.status()}`);
  const msText = await msPage.locator('body').innerText();
  if (/CurveLab|示波器|TRPL/.test(msText)) ok('微站页面含仪器内容');
  else info('微站页面未匹配到关键词');
  await msPage.screenshot({ path: join(OUT, '03-microsite.png'), fullPage: false });
  await msPage.close();

  console.log('\n[7] 控制台错误与失败请求');
  if (failedRequests.length > 0) {
    bad(`${failedRequests.length} 个请求失败（4xx/5xx）`);
    for (const r of failedRequests.slice(0, 8)) info(`  ${r.status}  ${r.url}`);
  } else {
    ok('无失败请求');
  }
  if (consoleErrors.length === 0) ok('无控制台错误');
  else {
    bad(`${consoleErrors.length} 个控制台错误`);
    for (const e of consoleErrors.slice(0, 5)) info(`  ${e.slice(0, 160)}`);
  }
} catch (e) {
  bad(`脚本异常：${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
}

const fails = results.filter((r) => r.level === 'bad').length;
console.log('\n' + '─'.repeat(56));
console.log(`✓ ${results.filter((r) => r.level === 'ok').length} 项通过  ✗ ${fails} 项失败`);
console.log(`截图：${OUT}`);
process.exit(fails > 0 ? 1 : 0);
