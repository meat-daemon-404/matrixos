#!/usr/bin/env node
/**
 * 线上真浏览器验收 —— 18 个微站在生产环境真的点一遍按钮。
 *
 * 为什么需要它（与 scripts/verify-prod.mjs 的分工）：
 *   verify-prod.mjs 查的是 HTTP 状态码 / TLS / WAF / canonical / CSP，
 *   全是「文件有没有正确送达」。它看不到「按钮点了有没有反应」——
 *   而本仓已经真实发生过一次「18 站 HTTP 200 全绿、线上却是旧版产物」：
 *   台账能显示，就地编辑按钮根本不存在。这类缺陷只有真浏览器点一遍才暴露。
 *
 * 与 scripts/microsite-verify.mjs 的关系：
 *   同一套断言、同一套水合判定哲学，区别只是「打开的是 localhost 的 out/ 还是
 *   生产的 mx-<appId>.matrixos.cc.cd」。本地那支跑在构建锁里，这支跑在公网。
 *
 * 用法：
 *   node scripts/verify-online.mjs                # 18 站全量
 *   node scripts/verify-online.mjs 01 03 16       # 指定站点 id
 *   node scripts/verify-online.mjs --list         # 只列目标地址
 *
 * 退出码：全过 0；有失败 1。明细写 .tmp/microsite-verify/online-summary-<ts>.json。
 *
 * 两个判据上的坑（都踩过，别改回去）：
 *   1. **不能用条件渲染的 testid 判线上新旧**。`ledger-undo` 只在清空后出现、
 *      `ledger-edit-form` 只在点编辑后出现，SSR HTML 里本来就没有 —— 用它们
 *      判断「线上是不是新版」会得到 18/18 假红。
 *   2. **Cloudflare 的 challenge-platform 脚本会被记成失败请求**。
 *      `/cdn-cgi/challenge-platform/…` 被浏览器 ERR_ABORTED 是 CF 注入的，
 *      不是本站资源；不过滤会让每站假红。
 */
import { statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.tmp', 'microsite-verify');

/**
 * React 水合族错误码：这是概率性的调度时序抖动，不是产品缺陷。
 * 只有「失败原因**全部**是水合族」才整轮重试 —— 出现任何别的错一次都不放过。
 * 定性依据见 docs/02-engineering/08-microsite-workbench.md §8.12。
 */
const HYDRATION_FAMILY = /Minified React error #(418|423|425)\b/;
const MAX_ATTEMPTS = 3;

/** 第三方 bot-challenge 脚本：被浏览器中止不是本站的失败请求。 */
const isThirdPartyNoise = (url) => /challenge-platform|\/cdn-cgi\//.test(url);

function loadTargets(argv) {
  const roster = JSON.parse(readFileSync(join(ROOT, 'specs', 'microsites.json'), 'utf8'));
  const appIdOf = new Map(
    roster.map((entry) => [String(entry.id), String(entry.domain).replace(/\.matrixos\.cc\.cd$/, '')]),
  );
  const all = roster.map((entry) => String(entry.id));
  const ids = argv.filter((arg) => !arg.startsWith('--'));
  const wanted = ids.length > 0 ? ids : all;
  return wanted.map((id) => {
    const appId = appIdOf.get(id);
    if (!appId) throw new Error(`未知站点 id：${id}（花名册里有：${all.join(' ')}）`);
    // 部署域是 mx-<appId>；逻辑域 <appId> 没有 A 记录（见 06-cloudflare-deploy.md §2.1）
    return { id, appId, url: `https://mx-${appId}.matrixos.cc.cd/` };
  });
}

const argv = process.argv.slice(2);
const targets = loadTargets(argv);

if (argv.includes('--list')) {
  for (const target of targets) console.log(`${target.id}  ${target.url}`);
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('✗ 需要 playwright：pnpm add -D playwright && npx playwright install chromium');
  process.exit(1);
}

const browser = await chromium.launch();

async function attemptOnce(url) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 240)));
  page.on('requestfailed', (request) => {
    if (!isThirdPartyNoise(request.url())) {
      failed.push(`${request.url().slice(0, 110)} ${request.failure()?.errorText ?? ''}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !isThirdPartyNoise(response.url())) {
      failed.push(`${response.status()} ${response.url().slice(0, 110)}`);
    }
  });

  const steps = {};
  let error = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(1500);

    const readCount = async () =>
      Number((await page.locator('[data-testid="ledger-count"]').first().innerText()).replace(/\D/g, ''));
    const before = await readCount();
    steps.countBefore = before;

    await page.locator('[data-testid="ledger-save"]').first().click();
    await page.waitForFunction(
      (want) => {
        const node = document.querySelector('[data-testid="ledger-count"]');
        return node && Number(node.textContent.replace(/\D/g, '')) === want;
      },
      before + 1,
      { timeout: 10000 },
    );
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200);
    steps.savedPersists = (await readCount()) === before + 1;

    const marker = `线上验收-${Date.now().toString(36)}`;
    await page.locator('[data-testid="ledger-edit"]').first().click();
    await page.locator('[data-testid="ledger-edit-form"]').first().waitFor({ timeout: 10000 });
    await page.locator('[data-testid="ledger-edit-title"]').first().fill(marker);
    await page.locator('[data-testid="ledger-edit-save"]').first().click();
    await page.waitForTimeout(600);
    steps.editVisible = (await page.locator('body').innerText()).includes(marker);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200);
    steps.editPersisted = (await page.locator('body').innerText()).includes(marker);

    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    const csvButton = page.locator('button', { hasText: '导出 CSV' }).first();
    if ((await csvButton.count()) > 0) {
      await csvButton.click();
      const download = await downloadPromise;
      if (download) {
        const path = await download.path();
        steps.csvBytes = path ? statSync(path).size : 0;
      }
    }

    const afterEditCount = await readCount();
    await page.locator('[data-testid="ledger-clear"]').first().click();
    await page.waitForTimeout(500);
    steps.clearZero = (await readCount()) === 0;
    const undo = page.locator('[data-testid="ledger-undo"]').first();
    steps.undoPresent = (await undo.count()) > 0;
    if (steps.undoPresent) {
      await undo.click();
      await page.waitForTimeout(500);
      steps.undoRestored = (await readCount()) === afterEditCount;
    }

    await page.locator('[data-testid="wormhole-emit"]').first().click();
    await page.waitForTimeout(1200);
    const feedback = ((await page.locator('[data-testid="wormhole-feedback"]').first().innerText()) ?? '').trim();
    steps.emitFeedback = feedback.slice(0, 140);
    steps.emitFeedbackNonEmpty = feedback.length > 0;

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200);
    steps.mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
  } catch (caught) {
    error = String(caught).slice(0, 300);
  }
  await context.close();

  const issues = [];
  if (error) issues.push(`执行异常：${error}`);
  if (steps.savedPersists !== true) issues.push('新增后刷新计数未保持');
  if (steps.editVisible !== true) issues.push('就地编辑后页面未出现新标题');
  if (steps.editPersisted !== true) issues.push('就地编辑刷新后丢失');
  if ((steps.csvBytes ?? 0) <= 8) issues.push('CSV 导出没有真实下载');
  if (steps.clearZero !== true) issues.push('清空后计数未归零');
  if (steps.undoPresent !== true) issues.push('清空后没有撤销按钮');
  if (steps.undoRestored !== true) issues.push('撤销未恢复计数');
  if (steps.emitFeedbackNonEmpty !== true) issues.push('虫洞投送反馈为空');
  if (!(steps.mobileOverflow <= 1)) issues.push(`移动端横向溢出 ${steps.mobileOverflow}px`);
  for (const line of consoleErrors) issues.push(`console.error：${line}`);
  for (const line of pageErrors) issues.push(`未捕获异常：${line}`);
  for (const line of failed) issues.push(`失败请求：${line}`);

  const hydrationOnly = issues.length > 0 && issues.every((line) => HYDRATION_FAMILY.test(line));
  return { steps, issues, consoleErrors, pageErrors, failed, hydrationOnly };
}

const results = [];
for (const target of targets) {
  let last = null;
  let attempt = 0;
  for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await attemptOnce(target.url);
    if (last.issues.length === 0) break;
    if (!last.hydrationOnly) break;
    console.log(`   ⚠ ${target.id} 第 ${attempt} 轮命中 React 水合抖动，重试…`);
  }
  const ok = last.issues.length === 0;
  results.push({
    ...target,
    ok,
    attempt,
    hydrationRetries: ok ? attempt - 1 : 0,
    steps: last.steps,
    issues: last.issues,
  });
  console.log(`${ok ? '✓' : '✗'} ${target.id} ${target.url}`);
  console.log(`   ${JSON.stringify(last.steps)}`);
  for (const line of last.issues) console.log(`   ✗ ${line}`);
  if (ok && attempt > 1) console.log(`   ⚠ 水合抖动：第 ${attempt} 轮才稳定通过（重试 ${attempt - 1} 次）`);
}

await browser.close();

const okCount = results.filter((row) => row.ok).length;
const retried = results.filter((row) => row.hydrationRetries > 0).length;
console.log('');
console.log('─'.repeat(60));
console.log(
  `线上真浏览器验收：${okCount}/${results.length} 通过${retried ? `（其中 ${retried} 站经水合重试后通过）` : ''}`,
);
if (okCount < results.length) {
  for (const row of results.filter((item) => !item.ok)) console.log(`  ✗ ${row.id} ${row.issues[0]}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const summaryPath = join(OUT_DIR, `online-summary-${Date.now()}.json`);
writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8');
console.log(`明细：${summaryPath}`);
process.exit(okCount === results.length ? 0 : 1);
