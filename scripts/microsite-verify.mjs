/**
 * 微站「完工」验收器。
 *
 * 一个命令跑完一个站的硬门禁：
 *   1. 静态导出构建（复用 scripts/build-static-site.mjs，含 next.config 备份/恢复）
 *   2. 本地静态服务 + Playwright 真浏览器打开
 *   3. 控制台错误 / pageerror / 失败请求（严格 0）
 *   4. 完工契约：primary-tool、ledger-count/save/export/clear、wormhole-emit
 *   5. 台账持久化：保存 → 刷新 → 计数保持；清空 → 刷新 → 归零
 *   6. 导出：点击导出能真的产生下载文件
 *   7. 移动端 390×844：无横向溢出
 *   8. 桌面 / 移动双截图落到 .tmp/microsite-verify/
 *
 * 用法：
 *   node scripts/microsite-verify.mjs --site=09-matrix-cross
 *   node scripts/microsite-verify.mjs --site=09-matrix-cross --skip-build   # 复用已有 out/
 *   node scripts/microsite-verify.mjs --all --skip-build
 *   node scripts/microsite-verify.mjs --site=09-matrix-cross --keep-open    # 调试：跑完不退出（10 分钟后自动退）
 *
 * 退出码：0 = 全绿；1 = 有站点失败。
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readdirSync, mkdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const OUT_ROOT = join(ROOT, '.tmp', 'microsite-verify');
const PLAIN_BUILD = join(ROOT, 'scripts', 'build-static-site.mjs');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const targetAll = flag('--all');
const targetSite = value('site');

/* ───────────────────────────── 静态服务器 ───────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function startStaticServer(outDir) {
  const root = resolve(outDir);
  const server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let rel = urlPath === '/' ? '/index.html' : urlPath;
      let filePath = normalize(join(root, rel));
      if (!filePath.startsWith(root + sep) && filePath !== root) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = join(filePath, 'index.html');
      }
      if (!existsSync(filePath)) {
        // 静态导出的 404 页；同时兼容无扩展名路由
        const htmlFallback = join(root, rel.replace(/\/$/, '') + '.html');
        if (existsSync(htmlFallback)) filePath = htmlFallback;
        else if (existsSync(join(root, '404.html'))) {
          res.writeHead(404, { 'content-type': MIME['.html'] });
          res.end(readFileSync(join(root, '404.html')));
          return;
        } else {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
          return;
        }
      }
      const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(readFileSync(filePath));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error));
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

/* ───────────────────────────── 通用工具 ───────────────────────────── */

function listSites() {
  return readdirSync(MICRO, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
    .map((d) => d.name);
}

/**
 * 站点级构建锁。
 *
 * 为什么需要：`next build` 在同一个站点目录里并发跑会互相删/写 `.next/`，
 * 表现为随机 ENOENT（`.nft.json` / `pages-manifest.json`）或 CSS 404 —— 全是假红，
 * 单跑立刻绿。多个 teammate / 多个验收进程同时跑同一站时要挡一下。
 *
 * 实现：站点目录下 `.verify-build.lock` 目录做原子互斥（mkdir 失败 = 已被占）。
 * **必须带陈旧锁回收**，否则一次 Ctrl-C / kill 就会留下永久锁，之后每次构建都要
 * 白等满超时——这比没有锁更糟（实测被这个坑到过一次：报「另一构建进程正在持有锁」，
 * 而那个 pid 早已不存在）。
 *
 * 陈旧判定（任一成立即回收）：
 *   1. 锁目录里有 `owner.json` 且其中的 pid 已不存在（进程没了 = 锁是遗物）
 *   2. 锁的 mtime 超过 staleMs（构建 6 分钟上限 + 余量），且 owner 不可解析
 */
const LOCK_STALE_MS = 10 * 60 * 1000;

function isLockStale(lockDir) {
  const ownerFile = join(lockDir, 'owner.json');
  try {
    const st = statSync(lockDir);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return '锁超过 10 分钟未释放';
  } catch {
    return '锁目录已消失';
  }
  if (!existsSync(ownerFile)) return '锁缺少 owner.json（可能是上次异常退出）';
  try {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
    const pid = Number(owner.pid);
    if (!Number.isFinite(pid) || pid <= 0) return 'owner.pid 不可解析';
    try {
      // 信号 0：只探测进程是否存在，不真的发信号
      process.kill(pid, 0);
      return null; // 进程还活着 → 锁是有效的
    } catch (error) {
      if (error && error.code === 'ESRCH') return `持有锁的进程 ${pid} 已不存在`;
      return null; // EPERM 等 = 进程存在但无权限探测，保守地认为锁有效
    }
  } catch {
    return 'owner.json 损坏';
  }
}

async function withBuildLock(site, fn, { waitMs = 8 * 60 * 1000, pollMs = 1500 } = {}) {
  const lockDir = join(MICRO, site, '.verify-build.lock');
  const started = Date.now();
  let reclaimed = 0;
  for (;;) {
    try {
      mkdirSync(lockDir);
      // 写入持有者信息，供后续判断陈旧锁用
      try {
        writeFileSync(
          join(lockDir, 'owner.json'),
          JSON.stringify({ pid: process.pid, site, at: new Date().toISOString() }),
          'utf8',
        );
      } catch {
        /* owner 写不进去不影响互斥本身 */
      }
      break;
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;

      // 先看是不是遗物锁；是就回收掉再抢一次
      const staleReason = isLockStale(lockDir);
      if (staleReason !== null || reclaimed > 3) {
        if (reclaimed <= 3) {
          try {
            rmSync(lockDir, { recursive: true, force: true });
            reclaimed += 1;
            console.log(`  （回收陈旧构建锁：${staleReason ?? '强制重置'}）`);
            continue;
          } catch {
            /* 回收失败就继续按等待处理 */
          }
        }
      }

      if (Date.now() - started > waitMs) {
        throw new Error(
          `等待站点构建锁超时（${Math.round(waitMs / 1000)}s）：${site} 仍被占用。` +
            '若确认没有其他构建在跑，删掉 ' +
            lockDir +
            ' 后重试',
        );
      }
      await new Promise((done) => setTimeout(done, pollMs));
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* 清锁失败不影响结果 */
    }
  }
}

function buildSite(site) {
  execFileSync(process.execPath, [PLAIN_BUILD, `--site=${site}`], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    timeout: 6 * 60 * 1000,
  });
}

async function textOf(page, selector) {
  const node = page.locator(selector).first();
  if ((await node.count()) === 0) return null;
  return (await node.textContent())?.trim() ?? null;
}

async function countOf(page) {
  const text = await textOf(page, '[data-testid="ledger-count"]');
  if (text === null) return null;
  const match = text.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

async function waitForCount(page, expected, timeout = 5000) {
  await page.waitForFunction(
    (want) => {
      const el = document.querySelector('[data-testid="ledger-count"]');
      if (!el) return false;
      const m = (el.textContent || '').match(/-?\d+/);
      return m ? Number(m[0]) === want : false;
    },
    expected,
    { timeout },
  );
}

/* ───────────────────────────── 单站验收 ───────────────────────────── */

async function verifySite(browser, site, options) {
  const dir = join(MICRO, site);
  const outDir = join(dir, 'out');
  const issues = [];
  const warnings = [];
  const evidence = {};

  /**
   * 锁必须覆盖「构建 **+ 验证**」整段，而不只是构建那几十秒。
   *
   * 为什么：验证要读 `out/` 里的 HTML/CSS/chunk，而并发验收（或并行会话）会在别的
   * 进程里 `next build`，把同一个 `out/` 目录整个删掉重建。表现是验证跑到一半
   * CSS 变 404、页面白屏、`index.html` 消失 —— 报出来全是「站点缺陷」，实际是
   * 产物被半路换掉了。实测一次批量里 01 等了 361s、13 拿到半成品 CSS 404、
   * 15 直接白屏（正文 9 字符），三个站三种症状，同一个根因。
   */
  return withBuildLock(site, () => verifyUnderLock(browser, site, options, dir, outDir, issues, warnings, evidence));
}

async function verifyUnderLock(browser, site, options, dir, outDir, issues, warnings, evidence) {
  if (!options.skipBuild) {
    try {
      // 站点级互斥：并发跑同站 next build 会互相删写 .next/，产生一族假红
      // （随机 ENOENT / CSS 404 / React #418）。加锁后并发验收也稳定。
      buildSite(site);
    } catch (error) {
      const tail = String(error.stdout ?? '') + String(error.stderr ?? '');
      issues.push(`静态导出构建失败：${tail.split('\n').filter(Boolean).slice(-6).join(' | ')}`);
      return { site, ok: false, issues, warnings, evidence };
    }
  }
  if (!existsSync(join(outDir, 'index.html'))) {
    issues.push('out/index.html 不存在（先构建或去掉 --skip-build）');
    return { site, ok: false, issues, warnings, evidence };
  }

  /* ── 产物完整性前置检查 ──
   * 只查 index.html 会把「构建被中断留下的半成品」当成品验证：
   * 缺 icon.svg → 页面起一个 404（被记成「控制台错误」），
   * 缺 index.txt → 移动端断言可能读到旧产物。
   * 这属于构建残留、不是产品缺陷，必须单独报清楚，否则会被误判成站点 bug。 */
  const REQUIRED_OUTPUTS = ['index.html', 'icon.svg', 'index.txt', '_headers'];
  const missingOutputs = REQUIRED_OUTPUTS.filter((name) => !existsSync(join(outDir, name)));
  if (missingOutputs.length > 0) {
    issues.push(
      `out/ 产物不完整（缺 ${missingOutputs.join(' / ')}）—— 这是构建残留，不是产品缺陷；` +
        '请重跑不带 --skip-build 的验收',
    );
    return { site, ok: false, issues, warnings, evidence };
  }

  const { server, url } = await startStaticServer(outDir);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`HTTP ${response.status()} ${response.url()}`);
  });

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1200);

    /* ── 页面非空 ── */
    const bodyText = (await page.evaluate(() => document.body.innerText || '')).trim();
    evidence.bodyLength = bodyText.length;
    if (bodyText.length < 300) issues.push(`页面正文过短（${bodyText.length} 字符），疑似白屏或未渲染`);

    /* ── 完工契约 DOM ── */
    const contract = {
      'primary-tool': '[data-testid="primary-tool"]',
      'ledger-count': '[data-testid="ledger-count"]',
      'ledger-save': '[data-testid="ledger-save"]',
      'ledger-export-json': '[data-testid="ledger-export-json"]',
      'ledger-clear': '[data-testid="ledger-clear"]',
      'wormhole-emit': '[data-testid="wormhole-emit"]',
    };
    for (const [name, selector] of Object.entries(contract)) {
      if ((await page.locator(selector).count()) === 0) issues.push(`缺少完工契约元素：${name}（${selector}）`);
    }

    /* ── 台账持久化：保存 → 刷新 → 计数保持 ── */
    if ((await page.locator('[data-testid="ledger-save"]').count()) > 0) {
      const before = (await countOf(page)) ?? 0;
      evidence.ledgerCountBefore = before;
      await page.locator('[data-testid="ledger-save"]').first().click();
      try {
        await waitForCount(page, before + 1);
        evidence.ledgerSaved = true;
      } catch {
        const actual = await countOf(page);
        issues.push(`点击 ledger-save 后台账计数未增加（期望 ${before + 1}，实际 ${actual}）`);
        evidence.ledgerSaved = false;
      }

      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(900);
      const afterReload = (await countOf(page)) ?? 0;
      evidence.ledgerCountAfterReload = afterReload;
      if (evidence.ledgerSaved && afterReload !== before + 1) {
        issues.push(`刷新后台账计数未保持（期望 ${before + 1}，实际 ${afterReload}）`);
      }

      /* ── 就地编辑：改标题 → 保存 → 刷新后内容仍在 ──
       * 这是「台账能装用户自己的内容」的核心验证。只验表单出现等于没验，
       * 必须真的写进去、并且**刷新后还在**（落盘才算数）。
       *
       * 注意诊断精度：若保存后页面已不可访问（构建残留导致 404/白屏），
       * 「内容丢失」是误导性结论 —— 要把这两种情况分开报，否则会去修一个不存在的 bug。 */
      if ((await page.locator('[data-testid="ledger-edit"]').count()) > 0) {
        const marker = `验收标记-${Date.now().toString(36)}`;
        await page.locator('[data-testid="ledger-edit"]').first().click();
        const formOpen = (await page.locator('[data-testid="ledger-edit-form"]').count()) > 0;
        if (!formOpen) {
          issues.push('点击 ledger-edit 后未出现 ledger-edit-form 就地编辑表单');
        } else {
          const titleInput = page.locator('[data-testid="ledger-edit-title"]').first();
          await titleInput.fill(marker);
          await page.locator('[data-testid="ledger-edit-save"]').first().click();
          await page.waitForTimeout(500);

          const afterSaveText = await page.evaluate(() => document.body.innerText || '');
          evidence.editVisible = afterSaveText.includes(marker);
          if (!evidence.editVisible) issues.push('保存就地编辑后，页面上看不到新标题');

          await page.reload({ waitUntil: 'load' });
          await page.waitForTimeout(900);
          // 先确认页面还活着：白屏/404 时不能断言「内容丢失」
          const reloadBodyLength = (await page.evaluate(() => (document.body.innerText || '').trim().length));
          if (reloadBodyLength < 300) {
            issues.push(
              `刷新后页面正文只有 ${reloadBodyLength} 字符（疑似产物 404/白屏）——` +
                '就地编辑是否落盘无法判定，请先修复产物完整性再跑',
            );
          } else {
            const afterReloadText = await page.evaluate(() => document.body.innerText || '');
            evidence.editPersisted = afterReloadText.includes(marker);
            if (!evidence.editPersisted) {
              issues.push('刷新后就地编辑的内容丢失（未真正落盘）');
            }
          }
        }
      }

      /* ── 导出：必须真的产生下载 ── */
      if ((await page.locator('[data-testid="ledger-export-json"]').count()) > 0) {
        const downloadPromise = page.waitForEvent('download', { timeout: 4000 }).catch(() => null);
        await page.locator('[data-testid="ledger-export-json"]').first().click();
        const download = await downloadPromise;
        evidence.exportDownloaded = Boolean(download);
        if (!download) {
          issues.push('点击 ledger-export-json 未触发下载');
        } else {
          const savePath = join(OUT_ROOT, `${site}-export.json`);
          await download.saveAs(savePath);
          const size = statSync(savePath).size;
          evidence.exportBytes = size;
          if (size < 8) issues.push(`导出的 JSON 文件过小（${size} B）`);
        }
      }

      /* ── 清空 → 撤销 → 清空 → 刷新归零 ──
       * 撤销是「误点不丢数据」的真实保障，必须验证它真的把数据放回来，
       * 而不只是按钮出现了（只验按钮存在 = 验了个空壳）。 */
      if ((await page.locator('[data-testid="ledger-clear"]').count()) > 0) {
        const beforeClear = (await countOf(page)) ?? 0;
        await page.locator('[data-testid="ledger-clear"]').first().click();
        try {
          await waitForCount(page, 0);
        } catch {
          const actual = await countOf(page);
          issues.push(`点击 ledger-clear 后台账计数未归零（实际 ${actual}）`);
        }

        // 撤销：清空后应出现「撤销」按钮，点它必须把条数恢复回来
        if (beforeClear > 0) {
          if ((await page.locator('[data-testid="ledger-undo"]').count()) === 0) {
            issues.push('清空有数据的台账后未出现 data-testid="ledger-undo" 撤销入口');
          } else {
            await page.locator('[data-testid="ledger-undo"]').first().click();
            try {
              await waitForCount(page, beforeClear);
              evidence.undoRestored = true;
            } catch {
              const actual = await countOf(page);
              issues.push(`点击 ledger-undo 后计数未恢复到 ${beforeClear}（实际 ${actual}）`);
              evidence.undoRestored = false;
            }
            // 再清空一次，回到「归零 + 刷新仍归零」的主断言
            await page.locator('[data-testid="ledger-clear"]').first().click();
            try {
              await waitForCount(page, 0);
            } catch {
              const actual = await countOf(page);
              issues.push(`撤销后再次清空，计数未归零（实际 ${actual}）`);
            }
          }
        }

        await page.reload({ waitUntil: 'load' });
        await page.waitForTimeout(900);
        const afterClearReload = (await countOf(page)) ?? -1;
        evidence.ledgerCountAfterClear = afterClearReload;
        if (afterClearReload !== 0) issues.push(`清空后刷新计数未为 0（实际 ${afterClearReload}）`);
      }
    }

    /* ── 虫洞投送：点击后必须有可见反馈 ── */
    if ((await page.locator('[data-testid="wormhole-emit"]').count()) > 0) {
      const emitButton = page.locator('[data-testid="wormhole-emit"]').first();
      await emitButton.click();
      await page.waitForTimeout(400);
      const feedback = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="wormhole-feedback"]');
        return el ? (el.textContent || '').trim() : '';
      });
      evidence.wormholeFeedback = feedback;
      if (!feedback) issues.push('点击 wormhole-emit 后缺少 data-testid="wormhole-feedback" 可见反馈');
    }

    /* ── 控制台 / 网络 ── */
    evidence.consoleErrors = consoleErrors;
    evidence.pageErrors = pageErrors;
    evidence.failedRequests = failedRequests;
    // 构建脚本注入的 CSP frame-ancestors 在本地 127.0.0.1 服务下不限制页面自身加载
    if (consoleErrors.length) issues.push(`控制台错误 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`);
    if (pageErrors.length) issues.push(`未捕获异常 ${pageErrors.length} 条：${pageErrors.slice(0, 3).join(' | ')}`);
    if (failedRequests.length) issues.push(`失败请求 ${failedRequests.length} 条：${failedRequests.slice(0, 3).join(' | ')}`);

    /* ── 桌面截图 ── */
    mkdirSync(OUT_ROOT, { recursive: true });
    await page.screenshot({ path: join(OUT_ROOT, `${site}-desktop.png`), fullPage: true });

    /* ── 移动端 390×844 ── */
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        innerWidth: window.innerWidth,
        offenders: Array.from(document.querySelectorAll('body *'))
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.right > window.innerWidth + 1;
          })
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}`),
      };
    });
    evidence.mobile = overflow;
    if (overflow.scrollWidth > overflow.innerWidth + 1) {
      issues.push(
        `移动端 390px 横向溢出：scrollWidth=${overflow.scrollWidth} > innerWidth=${overflow.innerWidth}（可疑元素：${overflow.offenders.join(', ') || '无' }）`,
      );
    }
    await page.screenshot({ path: join(OUT_ROOT, `${site}-mobile.png`), fullPage: true });
  } catch (error) {
    issues.push(`验收过程异常：${String(error && error.message ? error.message : error).split('\n')[0]}`);
  } finally {
    await context.close();
    await new Promise((done) => server.close(done));
  }

  // 无 console 错误时，正文长度/截图已足够作为证据
  evidence.screenshots = {
    desktop: `.tmp/microsite-verify/${site}-desktop.png`,
    mobile: `.tmp/microsite-verify/${site}-mobile.png`,
  };
  return { site, ok: issues.length === 0, issues, warnings, evidence };
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

const sites = targetAll ? listSites() : targetSite ? [targetSite] : [];
if (!sites.length) {
  console.error('用法: node scripts/microsite-verify.mjs --site=<dirName> | --all [--skip-build]');
  process.exit(1);
}
for (const site of sites) {
  if (!existsSync(join(MICRO, site))) {
    console.error(`✗ 不存在的站点目录：${site}`);
    process.exit(1);
  }
}

mkdirSync(OUT_ROOT, { recursive: true });
const results = [];
const browser = await chromium.launch({ channel: 'chromium' });
try {
  for (const site of sites) {
    process.stdout.write(`\n━━━ ${site} ━━━\n`);
    const result = await verifySite(browser, site, { skipBuild: flag('--skip-build') });
    results.push(result);
    if (result.ok) {
      console.log(`✓ ${site} 通过`);
    } else {
      console.log(`✗ ${site} 未通过：`);
      for (const issue of result.issues) console.log(`   - ${issue}`);
    }
    if (result.evidence.screenshots) {
      console.log(`   截图：${result.evidence.screenshots.desktop} · ${result.evidence.screenshots.mobile}`);
    }
  }
} finally {
  await browser.close();
}

const summaryPath = join(OUT_ROOT, `summary-${Date.now()}.json`);
const summary = { generatedAt: new Date().toISOString(), results };
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\n结果已写入 ${summaryPath}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log(`失败站点：${failed.map((r) => r.site).join(', ')}`);
  process.exit(1);
}
process.exit(0);
