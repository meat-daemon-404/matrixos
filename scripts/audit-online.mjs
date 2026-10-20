#!/usr/bin/env node
/**
 * 线上/本地体检 v2 —— 从「读 DOM 断言」升级为「**量盒子断言**」。
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么必须升级（v1 的已知方法论缺陷，2026-10-20）
 * ════════════════════════════════════════════════════════════════════════════
 * v1 只做 DOM 存在性判断（`!!document.querySelector('.instrument')`）和
 * innerText 长度，不做任何几何测量。后果是两个真缺陷被漏判、两个假结论被写进报告：
 *
 *   1. hub 面板高度塌陷（.instrument-rack 81px / .rack-grid 44px /
 *      .panel-body 0px / iframe 0px → 右侧视觉一片空白）。
 *      v1 之所以没发现：它压根没量高度。而它量到的「iframe 内正文 465 字符」
 *      是**假阳性** —— 跨源 iframe 即使外层盒子高 0，page.frames() 仍然能读到
 *      内部 DOM 与 innerText。内容在 DOM 里 ≠ 内容在屏幕上有高度。
 *
 *   2. `.iu-sr-only` 里的无障碍数据表（display:table，max-height:1px 对表格
 *      不是上限）把 CurveLab 文档撑到 4410px。v1 量到了 4410 这个数字，
 *      却没有把「有效内容高」量出来，于是只能猜「可能是 min-height:100vh」，
 *      并把 P1 归因错了元素。
 *
 * v2 的判据全部来自 getBoundingClientRect / scrollHeight / innerHeight：
 *
 *   · 微站 standalone：总高、**有效内容高**（含溢出裁剪推演）、空白占比、撑高元凶 top-5
 *   · 微站在 iframe 内：scrollHeight vs **iframe 盒子高**（ADR-08：iframe 内不滚）
 *   · hub：.instrument-rack / .rack-grid / .panel-body / iframe.panel-iframe 的 h
 *   · hub 的 P3 判据改用 hub 自己的 DOM 语汇（.star-orbit / canvas / 胶囊数），
 *     不再用 `.instrument` 这种 hub 不适配的选择器
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 用法
 * ════════════════════════════════════════════════════════════════════════════
 *   # 线上全量（默认：18 站 + hub 两上下文）
 *   node scripts/audit-online.mjs --sites=all --tag=online
 *
 *   # 线上抽查（默认抽查组：gpa / curvelab，与旧报告口径一致，便于回归对比）
 *   node scripts/audit-online.mjs --tag=online
 *
 *   # 本地静态产物复查（起一个内置静态服务器 serve 各站 out/，不碰线上）
 *   node scripts/audit-online.mjs --local-static --tag=local
 *
 *   # 换域名基底（模板里 {appId} 会被替换）
 *   node scripts/audit-online.mjs --base=https://mx-{appId}.pages.dev --hub=https://mx-orbital.pages.dev
 *
 * 产物：.tmp/audit/report.<tag>.json（机器可读，供回归对比）+ 截图。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, createReadStream, readdirSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ── 代理必须清掉：wrangler / Playwright 走本地代理会 TLS 失败 ─────────────── */
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[k];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const HUB_DIR = join(ROOT, 'apps', 'orbital-hub');
const OUT_DIR = join(ROOT, '.tmp', 'audit');
mkdirSync(OUT_DIR, { recursive: true });

/* ── 参数 ─────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes('--' + name);

const TAG = argOf('tag', 'online');
const BASE_TPL = argOf('base', 'https://mx-{appId}.pages.dev');
const HUB_URL_ARG = argOf('hub', null);
const LOCAL_STATIC = has('local-static');
const SITES_ARG = argOf('sites', 'gpa,curvelab');
const JSON_OUT = argOf('json', join(OUT_DIR, `report.${TAG}.json`));
const SHOTS = !has('no-screenshots');
const VIEWPORT = { width: 1600, height: 900 };

/** ADR-08 容差：iframe 内文档高不得超过 iframe 盒子高 + 4px（边框/亚像素舍入） */
const ADR08_TOLERANCE_PX = 4;
/** P1 判据：standalone 空白占比 < 20% */
const BLANK_RATIO_MAX = 0.2;
/** hub 面板 iframe 高度判据：> 0 且事实上能装下内容（> 80px 才算「不是塌陷」） */
const PANEL_MIN_H = 80;

/* ── 站点花名册（appId ← site.config.ts，不猜） ───────────────────────────── */
function roster() {
  const dirs = existsSync(MICRO) ? readdirSync(MICRO) : [];
  return dirs
    .filter((d) => /^\d\d-/.test(d))
    .map((dir) => {
      let appId = '';
      try {
        appId = /appId:\s*["']([^"']+)["']/.exec(readFileSync(join(MICRO, dir, 'src', 'site.config.ts'), 'utf8'))?.[1] ?? '';
      } catch { /* ignore */ }
      return { dir, appId };
    })
    .filter((s) => s.appId);
}

const ALL = roster();
const byAppId = new Map(ALL.map((s) => [s.appId, s]));

const requested = SITES_ARG === 'all'
  ? ALL.map((s) => s.appId)
  : SITES_ARG.split(',').map((s) => s.trim()).filter(Boolean);

const sites = requested
  .map((appId) => byAppId.get(appId) ?? { appId, dir: null })
  .filter((s) => s.appId);

const baseUrlFor = (appId) => BASE_TPL.replace(/\{appId\}/g, appId).replace(/\{id\}/g, appId);

/* ── 本地静态服务器（--local-static：serve 各站 out/，绝不动线上） ─────────── */
let staticServer = null;
let staticPort = 0;

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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const parts = url.pathname.split('/').filter(Boolean);
        // /<appId>/... → apps/micro-sites/<dir>/out/...
        let filePath = null;
        if (parts.length === 0) {
          filePath = join(OUT_DIR, 'index.html');
        } else {
          const site = byAppId.get(decodeURIComponent(parts[0]));
          if (site) {
            const rest = parts.slice(1).map((p) => decodeURIComponent(p));
            filePath = join(MICRO, site.dir, 'out', ...rest);
          }
        }
        if (!filePath) { res.writeHead(404); res.end('no route'); return; }
        const safe = normalize(filePath);
        if (!safe.startsWith(normalize(ROOT))) { res.writeHead(403); res.end('forbidden'); return; }
        let target = safe;
        if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
        if (!existsSync(target)) {
          // trailingSlash 目录形式的兜底：/<appId>/ → index.html
          const alt = join(safe, 'index.html');
          if (existsSync(alt)) target = alt;
        }
        if (!existsSync(target)) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
          'content-type': MIME[extname(target)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        createReadStream(target).pipe(res);
      } catch (e) {
        res.writeHead(500); res.end(String(e.message));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      staticPort = server.address().port;
      staticServer = server;
      resolve(staticPort);
    });
  });
}

/* ── 浏览器内注入的测量函数 ──────────────────────────────────────────────── */

/**
 * 量一页的盒子。这是 v2 的核心：
 *   totalHeight   = documentElement.scrollHeight（页面总高）
 *   contentBottom = 「真的被画出来」的内容底边（文档坐标）
 *                   —— 逐元素取 rect.bottom，做两件事的剔除：
 *                      a. position:fixed 的元素（锚在视口，不构成文档内容）
 *                      b. 被祖先 overflow 裁剪掉的部分（min 到祖先底边）
 *   blankRatio    = (total - contentBottom) / total
 *   unclipped     = 不裁剪地取所有元素底边 → 用来点名「撑高元凶」
 */
const measurePageFn = function measurePage() {
  const doc = document.documentElement;
  const scrollY = window.scrollY;

  const desc = (el) => {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) s += '#' + cur.id;
      const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (cls.length) s += '.' + cls.join('.');
      parts.unshift(s);
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const CLIP_RE = /(hidden|clip|auto|scroll)/;
  const isClipper = (el) => {
    if (el === document.body || el === doc) return false;
    const cs = getComputedStyle(el);
    return CLIP_RE.test(cs.overflowY) || CLIP_RE.test(cs.overflowX);
  };
  const isPainted = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  };

  const paintedBottomOf = (el) => {
    let bottom = el.getBoundingClientRect().bottom + scrollY;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (!isClipper(p)) continue;
      const pb = p.getBoundingClientRect().bottom + scrollY;
      if (pb < bottom) bottom = pb;
    }
    return bottom;
  };

  let contentBottom = 0;
  let unclippedBottom = 0;
  const offenders = [];

  const walk = (el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && isPainted(el)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        const rawBottom = r.bottom + scrollY;
        if (rawBottom > unclippedBottom) unclippedBottom = rawBottom;
        if (rawBottom > contentBottom) {
          const pb = paintedBottomOf(el);
          if (pb > contentBottom) contentBottom = pb;
        }
        // 只把「明显超出可见内容、且自身尺寸可观」的元素当元凶候选
        if (rawBottom > doc.scrollHeight * 0.5 && (r.height > 120 || r.width > 400)) {
          offenders.push({
            selector: desc(el),
            bottom: Math.round(rawBottom),
            h: Math.round(r.height),
            w: Math.round(r.width),
            display: cs.display,
            position: cs.position,
            overflow: cs.overflow,
            maxHeight: cs.maxHeight,
            clippedTo: Math.round(paintedBottomOf(el)),
          });
        }
      }
    }
    for (const c of el.children) walk(c);
  };
  if (document.body) walk(document.body);

  offenders.sort((a, b) => b.bottom - a.bottom);

  const total = doc.scrollHeight;
  const blankPx = Math.max(0, total - Math.round(contentBottom));

  return {
    totalHeight: total,
    bodyScrollHeight: document.body ? document.body.scrollHeight : 0,
    innerHeight: window.innerHeight,
    clientHeight: doc.clientHeight,
    contentBottom: Math.round(contentBottom),
    unclippedBottom: Math.round(unclippedBottom),
    blankPx,
    blankRatio: total > 0 ? blankPx / total : 0,
    scrollable: total > window.innerHeight + 1,
    siteRootH: document.querySelector('.site-root') ? Math.round(document.querySelector('.site-root').getBoundingClientRect().height) : null,
    offenders: offenders.slice(0, 5),
    dom: {
      title: document.title,
      bodyTextLen: (document.body ? document.body.innerText || '' : '').length,
      bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : null,
      embedded: document.body ? document.body.dataset.embedded ?? null : null,
      srOnlyNodes: document.querySelectorAll('.iu-sr-only').length,
      svgCount: document.querySelectorAll('svg').length,
      canvasCount: document.querySelectorAll('canvas').length,
      textSample: (document.body ? document.body.innerText || '' : '').replace(/\s+/g, ' ').slice(0, 80),
    },
  };
};

/** hub 专用盒子测量（P3/P4 判据的语汇全部来自 hub 自己的 DOM） */
const measureHubFn = function measureHub() {
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
      minHeight: cs.minHeight,
      overflow: cs.overflow,
    };
  };
  const panels = [...document.querySelectorAll('.panel')].map((el) => {
    const r = el.getBoundingClientRect();
    const body = el.querySelector('.panel-body');
    const fr = el.querySelector('iframe.panel-iframe');
    return {
      h: Math.round(r.height),
      mode: el.getAttribute('data-mode'),
      bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
      iframeH: fr ? Math.round(fr.getBoundingClientRect().height) : null,
      iframeSrc: fr ? fr.getAttribute('src') : null,
      iframePending: fr ? fr.getAttribute('data-pending') : null,
    };
  });
  return {
    shell: box('.hub-shell'),
    main: box('.hub-main'),
    orbit: box('.star-orbit'),
    rack: box('.instrument-rack'),
    toolbar: box('.rack-toolbar'),
    grid: box('.rack-grid'),
    panelBody: box('.panel-body'),
    iframe: box('iframe.panel-iframe'),
    panels,
    // ── P3 正确判据：hub 的语汇（星轨 / canvas / 胶囊），不是 .instrument ──
    p3: {
      hasStarOrbit: !!document.querySelector('.star-orbit'),
      orbitRings: document.querySelectorAll('.orbit-ring').length,
      canvasCount: document.querySelectorAll('canvas').length,
      capsuleCount: document.querySelectorAll('button[aria-label^="挂载"]').length,
      capsuleChipCount: document.querySelectorAll('.capsule').length,
      orbitH: document.querySelector('.star-orbit') ? Math.round(document.querySelector('.star-orbit').getBoundingClientRect().height) : 0,
      // 明确记录旧脚本用的选择器为何不适配，避免下次再误报
      legacySelectors: {
        '.instrument': !!document.querySelector('.instrument'),
        '[role=slider].legacy-expect': !!document.querySelector('[role=slider]'),
        'canvas (legacy assert)': document.querySelectorAll('canvas').length,
      },
    },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
};

/* ── 单页审计 ─────────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function auditOne(ctx, url, label, opts = {}) {
  const { shot = true, fullPage = false } = opts;
  const page = await ctx.newPage();
  const failures = [];
  const consoleErrors = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push({ status: r.status(), url: r.url().slice(0, 160), type: r.request().resourceType() });
  });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));

  const rec = { label, url, ok: false };
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1200);
    rec.http = resp ? resp.status() : null;
    rec.headers = resp ? {
      'content-type': resp.headers()['content-type'] ?? null,
      'cache-control': resp.headers()['cache-control'] ?? null,
      'content-security-policy': resp.headers()['content-security-policy'] ?? null,
    } : null;

    if (shot) {
      try { await page.screenshot({ path: join(OUT_DIR, `${TAG}-${label}.png`), fullPage }); } catch { /* ignore */ }
    }

    rec.measure = await page.evaluate(measurePageFn);
    rec.failures = failures;
    rec.consoleErrors = consoleErrors;
    rec.ok = true;
    printPage(rec);
  } catch (e) {
    rec.error = String(e.message).split('\n')[0];
    console.log(`\n【${label}】✗ ${rec.error}`);
  } finally {
    await page.close();
  }
  return rec;
}

function printPage(rec) {
  const m = rec.measure;
  console.log(`\n【${rec.label}】${rec.url}`);
  console.log(`  HTTP ${rec.http} · ${m.dom.title}`);
  console.log(`  正文 ${m.dom.bodyTextLen} 字符 · svg ${m.dom.svgCount} · canvas ${m.dom.canvasCount} · 背景 ${m.dom.bodyBg}`);
  console.log(
    `  盒子：总高 ${m.totalHeight}px / 有效内容高 ${m.contentBottom}px / 空白 ${m.blankPx}px = **${(m.blankRatio * 100).toFixed(1)}%** ` +
    `· 视口 ${m.innerHeight} · 可滚 ${m.scrollable ? '是' : '否'} · .site-root h=${m.siteRootH} · embedded=${m.dom.embedded}`,
  );
  if (m.offenders.length) {
    console.log(`  撑高元凶 top-${m.offenders.length}（未裁剪底边 vs 裁剪后）：`);
    for (const o of m.offenders) {
      console.log(`      ${o.selector.slice(0, 110)}  bottom ${o.bottom} · clipped ${o.clippedTo} · h ${o.h} · display ${o.display} · overflow ${o.overflow} · max-h ${o.maxHeight}`);
    }
  }
  if (rec.failures.length) {
    console.log(`  ✗ 失败请求 ${rec.failures.length}：`);
    for (const f of rec.failures.slice(0, 6)) console.log(`      ${f.status} [${f.type}] ${f.url}`);
  }
  if (rec.consoleErrors.length) {
    console.log(`  ✗ 控制台错误 ${rec.consoleErrors.length}：`);
    for (const e of rec.consoleErrors.slice(0, 4)) console.log(`      ${e}`);
  }
}

/* ── hub 会话：点胶囊 → 量 hub 盒子 → 量 iframe 内部盒子 ─────────────────── */
async function auditHub(ctx, hubUrl, mountCount = 1, shot = true) {
  const page = await ctx.newPage();
  const failures = [];
  const consoleErrors = [];
  page.on('response', (r) => { if (r.status() >= 400) failures.push({ status: r.status(), url: r.url().slice(0, 160) }); });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));

  const rec = { label: 'hub', url: hubUrl, ok: false, mountCount, frames: [] };
  try {
    const resp = await page.goto(hubUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);
    rec.http = resp ? resp.status() : null;
    rec.headers = resp ? {
      'content-type': resp.headers()['content-type'] ?? null,
      'cache-control': resp.headers()['cache-control'] ?? null,
      'content-security-policy': resp.headers()['content-security-policy'] ?? null,
    } : null;

    // 点开 N 个胶囊。用真实 click（不是 dispatchEvent）—— dispatchEvent 不触发
    // 浏览器的命中测试，某些实现下会绕过 React 的事件委托边界。
    const caps = page.locator('button[aria-label^="挂载"]');
    const capCount = await caps.count();
    rec.capsuleCount = capCount;
    let clicked = 0;
    for (let i = 0; i < Math.min(mountCount, capCount); i += 1) {
      try {
        await caps.nth(i).click({ timeout: 5000 });
        clicked += 1;
      } catch {
        try { await caps.nth(i).evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); clicked += 1; } catch { /* ignore */ }
      }
      await sleep(150);
    }
    rec.clicked = clicked;
    // 等 iframe 真的出现并把首帧画出来
    try { await page.waitForSelector('iframe.panel-iframe', { timeout: 15000 }); } catch { /* 可能降级成快照 */ }
    await page.waitForTimeout(5000);

    rec.hub = await page.evaluate(measureHubFn);
    if (shot) {
      try { await page.screenshot({ path: join(OUT_DIR, `${TAG}-hub-mounted.png`), fullPage: false }); } catch { /* ignore */ }
    }

    printHub(rec);

    // ── iframe 内部：ADR-08 判据 ──────────────────────────────────────────
    // 关键修正：跨源 iframe 的 window.innerHeight 在 iframe 盒子高 0 时会读到 0。
    // v1 把这当成「读取时机问题」；真相是**它就是盒子塌陷的症状**。
    // 所以这里同时取三个视口侧数字，并显式声明用了哪个：
    //   innerHeightFrame  = iframe 内部 window.innerHeight
    //   clientHeightFrame = iframe 内部 documentElement.clientHeight
    //   frameBoxH         = 父页面里该 iframe 元素的 getBoundingClientRect().height
    const iframeBoxes = await page.evaluate(() =>
      [...document.querySelectorAll('iframe.panel-iframe')].map((el) => {
        const r = el.getBoundingClientRect();
        return { src: el.getAttribute('src'), h: Math.round(r.height), w: Math.round(r.width), pending: el.getAttribute('data-pending') };
      }),
    );
    rec.iframeBoxes = iframeBoxes;

    const frames = page.frames().filter((f) => {
      const u = f.url();
      if (!u || u === 'about:blank') return false;
      return !/mx-orbital|orbital-hub/.test(u);
    });
    for (const fr of frames) {
      const entry = { frameUrl: fr.url() };
      try {
        const inner = await fr.evaluate(() => ({
          scrollHeight: document.documentElement.scrollHeight,
          bodyScrollHeight: document.body ? document.body.scrollHeight : 0,
          innerHeight: window.innerHeight,
          clientHeight: document.documentElement.clientHeight,
          embedded: document.body ? document.body.dataset.embedded ?? null : null,
          siteRootH: document.querySelector('.site-root') ? Math.round(document.querySelector('.site-root').getBoundingClientRect().height) : null,
          textLen: (document.body ? document.body.innerText || '' : '').length,
          textSample: (document.body ? document.body.innerText || '' : '').replace(/\s+/g, ' ').slice(0, 60),
        }));
        const box = iframeBoxes.find((b) => b.src && fr.url().startsWith(b.src.replace(/\/$/, ''))) ?? iframeBoxes[0] ?? null;
        entry.frameBoxH = box ? box.h : null;
        Object.assign(entry, inner);
        // 视口高判定：盒子高优先（盒子 0 是塌陷的证据，不是「读不到」）
        const viewportEffective = box && box.h > 0 ? box.h : (inner.innerHeight > 0 ? inner.innerHeight : 0);
        entry.viewportEffective = viewportEffective;
        entry.viewportSource = box && box.h > 0 ? 'iframe-element-box' : (inner.innerHeight > 0 ? 'window.innerHeight' : 'none(box=0)');
        entry.overflowPx = inner.scrollHeight - viewportEffective;
        entry.adr08Violated = inner.scrollHeight > viewportEffective + ADR08_TOLERANCE_PX;
        entry.adr08Tolerance = ADR08_TOLERANCE_PX;
        console.log(`\n  ── iframe 内部 ${fr.url()}`);
        console.log(`     iframe 盒子高 ${entry.frameBoxH}px（父页面量得） · window.innerHeight ${inner.innerHeight} · clientHeight ${inner.clientHeight}`);
        console.log(`     文档 scrollHeight ${inner.scrollHeight} · 视口采用 ${viewportEffective}（来源 ${entry.viewportSource}）`);
        console.log(`     ADR-08：${entry.adr08Violated ? '✗ 违反（内部可滚 ' + entry.overflowPx + 'px）' : '✓ 满足（≤ viewport+' + ADR08_TOLERANCE_PX + '）'}`);
        console.log(`     embedded=${inner.embedded} · .site-root h=${inner.siteRootH} · 正文 ${inner.textLen} 字符：${inner.textSample}`);
      } catch (e) {
        entry.error = String(e.message).split('\n')[0];
        console.log(`\n  ── iframe ${fr.url()} 读取失败：${entry.error}`);
      }
      rec.frames.push(entry);
    }

    // ── v1 的假阳性复现：DOM 断言说「内容正常」，盒子断言说「高度 0」 ─────
    rec.falsePositiveDemo = {
      domAssertionIframeTextLen: rec.frames[0] ? rec.frames[0].textLen : null,
      boxAssertionIframeH: rec.hub.iframe ? rec.hub.iframe.h : null,
      boxAssertionPanelBodyH: rec.hub.panelBody ? rec.hub.panelBody.h : null,
      verdict: rec.frames[0] && rec.hub.iframe
        ? (rec.frames[0].textLen > 0 && rec.hub.iframe.h === 0
          ? 'v1 假阳性成立：DOM 有内容，盒子高 0 → 屏幕一片空白'
          : 'DOM 有内容且盒子高 >0 → 真渲染')
        : 'n/a',
    };

    rec.failures = failures;
    rec.consoleErrors = consoleErrors;
    rec.ok = true;
  } catch (e) {
    rec.error = String(e.message).split('\n')[0];
    console.log(`\n【hub】✗ ${rec.error}`);
  } finally {
    await page.close();
  }
  return rec;
}

function printHub(rec) {
  const h = rec.hub;
  console.log(`\n【03-hub】${rec.url}`);
  console.log(`  HTTP ${rec.http} · 视口 ${h.viewport.w}×${h.viewport.h} · 胶囊 ${rec.capsuleCount} 个 · 已点 ${rec.clicked}`);
  console.log(
    `  P3 判据（hub 语汇）：.star-orbit ${h.p3.hasStarOrbit ? '✓' : '✗'} h=${h.p3.orbitH} · 轨道环 ${h.p3.orbitRings} · ` +
    `canvas ${h.p3.canvasCount} · 胶囊(DOM) ${h.p3.capsuleChipCount}`,
  );
  console.log(
    `     旧脚本选择器对照：.instrument ${h.p3.legacySelectors['.instrument'] ? '✓' : '✗'} · ` +
    `[role=slider] ${h.p3.legacySelectors['[role=slider].legacy-expect'] ? '✓' : '✗'} ← 不适配 hub，故 v1 误报`,
  );
  const boxLine = (name, b) => (b ? `${name} h=${b.h}px w=${b.w}px${b.flex ? ' flex=' + b.flex : ''}` : `${name} —`);
  console.log(`  盒子链：${boxLine('.hub-shell', h.shell)} · ${boxLine('.hub-main', h.main)} · ${boxLine('.star-orbit', h.orbit)}`);
  console.log(`          ${boxLine('.instrument-rack', h.rack)} · ${boxLine('.rack-grid', h.grid)} · ${boxLine('.panel-body', h.panelBody)} · ${boxLine('iframe.panel-iframe', h.iframe)}`);
  console.log(`  面板 ${h.panels.length} 个：${h.panels.map((p) => `[${p.mode}] h=${p.h} bodyH=${p.bodyH} iframeH=${p.iframeH}`).join(' | ')}`);
}

/* ── 主流程 ───────────────────────────────────────────────────────────────── */
let baseTpl = BASE_TPL;
let hubUrl = HUB_URL_ARG;

if (LOCAL_STATIC) {
  const port = await startStaticServer();
  baseTpl = `http://127.0.0.1:${port}/{appId}/`;
  hubUrl = hubUrl ?? `http://127.0.0.1:${port}/_hub/`;
  console.log(`▶ 本地静态复检模式：http://127.0.0.1:${port}/  （serve 各站 out/，不触线上）`);
  console.log(`  ⚠ hub 的 out/ 在构建时把微站地址固化成了 NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE，`);
  console.log(`    本地 serve 的 hub 内嵌的仍是**线上** microsite；iframe 上下文的真实验证放在部署后做。`);
} else {
  hubUrl = hubUrl ?? 'https://mx-orbital.pages.dev';
}

const browser = await chromium.launch({ channel: 'chromium' });
const ctx = await browser.newContext({ viewport: VIEWPORT });

const report = {
  tag: TAG,
  generatedAt: new Date().toISOString(),
  baseTemplate: baseTpl,
  hubUrl,
  localStatic: LOCAL_STATIC,
  viewport: VIEWPORT,
  criteria: {
    blankRatioMax: BLANK_RATIO_MAX,
    adr08TolerancePx: ADR08_TOLERANCE_PX,
    panelIframeMinH: PANEL_MIN_H,
  },
  sites: [],
  hub: null,
  verdict: {},
};

console.log('\n════════ 微站 standalone（盒子测量） ════════');
for (const site of sites) {
  const fullPage = true;
  const rec = await auditOne(ctx, baseUrlFor(site.appId), `${site.appId}-standalone`, {
    shot: SHOTS && sites.length <= 4 ? true : false,
    fullPage,
  });
  report.sites.push(rec);
}

if (shootHub()) {
  console.log('\n════════ hub（盒子测量 + iframe 上下文） ════════');
  report.hub = await auditHub(ctx, hubUrl, 1, SHOTS);
}

function shootHub() {
  return hubUrl !== null && !has('no-hub');
}

/* ── 判定汇总 ─────────────────────────────────────────────────────────────── */
const siteVerdicts = report.sites.map((r) => {
  if (!r.ok) return { label: r.label, error: r.error };
  const m = r.measure;
  return {
    label: r.label,
    url: r.url,
    http: r.http,
    totalHeight: m.totalHeight,
    contentBottom: m.contentBottom,
    blankPx: m.blankPx,
    blankRatio: Number(m.blankRatio.toFixed(4)),
    blankRatioPct: Number((m.blankRatio * 100).toFixed(1)),
    siteRootH: m.siteRootH,
    innerHeight: m.innerHeight,
    scrollable: m.scrollable,
    failureCount: r.failures.length,
    consoleErrorCount: r.consoleErrors.length,
    p1Pass: m.blankRatio < BLANK_RATIO_MAX,
    offenders: m.offenders,
  };
});

report.verdict = {
  p1_blank: {
    criterion: `standalone 空白占比 < ${(BLANK_RATIO_MAX * 100).toFixed(0)}%`,
    sites: siteVerdicts,
    allPass: siteVerdicts.every((v) => v.p1Pass === true),
  },
  p3_hub_selectors: report.hub
    ? {
      criterion: 'hub 用自身语汇判定（.star-orbit / canvas / 胶囊），不用 .instrument',
      hasStarOrbit: report.hub.hub?.p3.hasStarOrbit ?? null,
      canvasCount: report.hub.hub?.p3.canvasCount ?? null,
      capsuleCount: report.hub.capsuleCount ?? null,
      v1FalseReportExplained: !(report.hub.hub?.p3.legacySelectors['.instrument'] ?? false),
    }
    : null,
  p4_panel_iframe_height: report.hub
    ? {
      criterion: `点开胶囊后 iframe.panel-iframe h > ${PANEL_MIN_H}px（旧值 0）`,
      rackH: report.hub.hub?.rack?.h ?? null,
      gridH: report.hub.hub?.grid?.h ?? null,
      panelBodyH: report.hub.hub?.panelBody?.h ?? null,
      iframeH: report.hub.hub?.iframe?.h ?? null,
      pass: (report.hub.hub?.iframe?.h ?? 0) > PANEL_MIN_H,
      falsePositiveDemo: report.hub.falsePositiveDemo,
    }
    : null,
  adr08_iframe_no_scroll: report.hub
    ? {
      criterion: `iframe 内 scrollHeight <= 视口高 + ${ADR08_TOLERANCE_PX}px`,
      frames: report.hub.frames.map((f) => ({
        frameUrl: f.frameUrl,
        scrollHeight: f.scrollHeight ?? null,
        frameBoxH: f.frameBoxH ?? null,
        innerHeightInsideIframe: f.innerHeight ?? null,
        viewportEffective: f.viewportEffective ?? null,
        viewportSource: f.viewportSource ?? null,
        overflowPx: f.overflowPx ?? null,
        violated: f.adr08Violated ?? null,
      })),
      allCompliant: report.hub.frames.length > 0 && report.hub.frames.every((f) => f.adr08Violated === false),
    }
    : null,
  p2_404: {
    criterion: '每站失败请求（≥400）计数',
    perSite: report.sites.map((r) => ({ label: r.label, failures: (r.failures ?? []).map((f) => `${f.status} ${f.url}`) })),
    totalFailures: report.sites.reduce((n, r) => n + (r.failures?.length ?? 0), 0),
  },
};

writeFileSync(JSON_OUT, JSON.stringify(report, null, 2), 'utf8');

console.log('\n════════ 判定汇总 ════════');
for (const v of report.verdict.p1_blank.sites) {
  if (v.error) { console.log(`  P1 ${v.label}: ✗ ${v.error}`); continue; }
  console.log(`  P1 ${v.label.padEnd(22)} 总高 ${String(v.totalHeight).padStart(6)} · 内容 ${String(v.contentBottom).padStart(6)} · 空白 ${String(v.blankRatioPct).padStart(5)}%  ${v.p1Pass ? '✓' : '✗'}`);
}
console.log(`  P1 总判定：${report.verdict.p1_blank.allPass ? '✓ 全部通过' : '✗ 未通过'}`);
if (report.verdict.p4_panel_iframe_height) {
  const p4 = report.verdict.p4_panel_iframe_height;
  console.log(`  P4 iframe 高度：rack ${p4.rackH} · grid ${p4.gridH} · panel-body ${p4.panelBodyH} · iframe ${p4.iframeH} · ${p4.pass ? '✓' : '✗'}`);
  console.log(`     假阳性复现：${p4.falsePositiveDemo?.verdict ?? 'n/a'}`);
}
if (report.verdict.adr08_iframe_no_scroll) {
  const a = report.verdict.adr08_iframe_no_scroll;
  for (const f of a.frames) {
    console.log(`  ADR-08 ${String(f.frameUrl).slice(0, 46)}：scrollH ${f.scrollHeight} vs 视口 ${f.viewportEffective}（${f.viewportSource}）→ ${f.violated ? '✗ 违反 ' + f.overflowPx + 'px' : '✓ 合规'}`);
  }
  console.log(`  ADR-08 总判定：${a.allCompliant ? '✓ 全部合规' : '✗ 存在违反'}`);
}
console.log(`  P2 失败请求合计：${report.verdict.p2_404.totalFailures}`);
console.log(`\nJSON → ${JSON_OUT}`);

await browser.close();
if (staticServer) await new Promise((r) => staticServer.close(r));
process.exit(0);
