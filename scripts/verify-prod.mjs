#!/usr/bin/env node
/**
 * 生产环境全量验证：19 个站点（18 微站 + hub）在新账号下的可达性与安全头。
 *
 * 为什么放进仓库：验证脚本原先散落在 D:\tmp（仓库外），换机器 / 新会话就没了，
 * 而「迁移后是否真的都通」这件事必须可重复复核。
 *
 * 用法：
 *   node scripts/verify-prod.mjs
 *   node scripts/verify-prod.mjs --json        # 机器可读输出
 *
 * 判据（任一不符即退出码 1）：
 *   1. 每站 HTTP 200
 *   2. 每站带 Strict-Transport-Security 且含 includeSubDomains 与 preload
 *   3. 每站 TLS 握手最低版本 >= 1.2（用 node https 的 minVersion 反证）
 *   4. WAF 命中：敏感路径 / CMS 后台 / 危险方法 应被拦（403 或 405）
 *   5. apex 不应出现 Cloudflare 的 error 1014
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MICRO = join(ROOT, 'apps', 'micro-sites');
const ZONE = process.env.MATRIXOS_ZONE ?? 'matrixos.cc.cd';
const HUB_URL = `https://${ZONE}/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const jsonOut = process.argv.includes('--json');

/* 代理必须清掉，否则 curl / node 都会走本地代理 */
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
  delete process.env[k];
}

/*
 * curl 可执行名按平台选。
 *
 * Windows 自带 curl.exe；Linux/macOS 是 curl。原实现写死 'curl.exe'，
 * 导致本脚本在 CI（ubuntu-latest）上**根本跑不起来** —— 而它的定位正是
 * 「部署后自动门禁」，必须跨平台。
 *
 * 另：Windows 上 curl 的 -o NUL 与 Linux 的 -o /dev/null 也不同，一并处理。
 */
const IS_WIN = process.platform === 'win32';
const CURL = IS_WIN ? 'curl.exe' : 'curl';
const NULL_DEVICE = IS_WIN ? 'NUL' : '/dev/null';

/** 用 curl 取状态码 + 响应头 */
function curlHead(url, extraArgs = []) {
  try {
    const out = execFileSync(CURL, [
      '-sS', '-o', NULL_DEVICE, '-D', '-', '--max-time', '30', '-A', UA, ...extraArgs, url,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(out);
    const hsts = /^strict-transport-security:\s*(.+)$/im.exec(out);
    return { status: statusMatch ? Number(statusMatch[1]) : 0, hsts: hsts ? hsts[1].trim() : null, raw: out };
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(out);
    return { status: statusMatch ? Number(statusMatch[1]) : 0, hsts: null, raw: out, error: String(e.message).split('\n')[0] };
  }
}

function curlBody(url) {
  try {
    return execFileSync(CURL, ['-sS', '--max-time', '30', '-A', UA, url],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return `${e.stdout || ''}`;
  }
}

/**
 * 反证 TLS 下限：把 min 与 max **同时**钉死到某个版本。
 *
 * ⚠️ 只设 minVersion 是错的判据 —— `minVersion:'TLSv1.1'` 的含义是「至少 1.1」，
 *    服务器会正常升到 1.2 完成握手，于是被误判成「1.1 仍可用」。
 *    必须 min=max 才是在问「这个版本本身能不能单独协商」。
 * 期望：1.0/1.1 失败（下层已禁），1.2 成功。
 */
function tlsProbe(hostname, version) {
  return new Promise((resolve) => {
    const req = httpsRequest({
      hostname, port: 443, path: '/', method: 'HEAD',
      minVersion: version, maxVersion: version, timeout: 15000,
      headers: { 'User-Agent': UA },
    }, (res) => {
      const proto = typeof res.socket.getProtocol === 'function' ? res.socket.getProtocol() : null;
      res.resume();
      resolve({ ok: true, proto });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
    req.end();
  });
}

async function tlsFloorOk(hostname) {
  const [v10, v11, v12] = await Promise.all([
    tlsProbe(hostname, 'TLSv1'),
    tlsProbe(hostname, 'TLSv1.1'),
    tlsProbe(hostname, 'TLSv1.2'),
  ]);
  return {
    tls10Accepted: v10.ok,
    tls11Accepted: v11.ok,
    tls12Accepted: v12.ok,
    tls11Reason: v11.reason,
    ok: !v10.ok && !v11.ok && v12.ok,
  };
}

/* ── 目标清单 ── */
const targets = [{ label: 'orbital-hub', url: HUB_URL }];
for (const d of readdirSync(MICRO, { withFileTypes: true })) {
  if (!d.isDirectory() || !/^\d\d-/.test(d.name)) continue;
  const cfg = join(MICRO, d.name, 'src', 'site.config.ts');
  if (!existsSync(cfg)) continue;
  const appId = /appId:\s*["']([^"']+)["']/.exec(readFileSync(cfg, 'utf8'))?.[1];
  if (appId) targets.push({ label: d.name, url: `https://mx-${appId}.${ZONE}/` });
}

/* ── 1+2 可达性 & HSTS ── */
const results = [];
for (const t of targets) {
  const h = curlHead(t.url);
  const hstsOk = !!h.hsts && /includeSubDomains/i.test(h.hsts) && /preload/i.test(h.hsts);
  results.push({ ...t, status: h.status, hsts: h.hsts, hstsOk, ok: h.status === 200 && hstsOk });
}

/* ── 3 TLS 下限（只抽检 hub + 第一个微站，避免 19×2 次握手太慢）── */
const tlsChecks = [];
for (const t of [targets[0], targets[1]].filter(Boolean)) {
  const host = new URL(t.url).hostname;
  const r = await tlsFloorOk(host);
  tlsChecks.push({ host, ...r, ok: !r.tls11Accepted && r.tls12Accepted });
}

/* ── 4 WAF 命中 ── */
const wafProbes = [
  { label: '敏感路径 .env', path: '/.env', expect: [403] },
  { label: 'git 配置', path: '/.git/config', expect: [403] },
  { label: 'CMS 后台', path: '/wp-admin/index.php', expect: [403] },
  { label: 'cgi-bin', path: '/cgi-bin/x', expect: [403] },
  { label: 'TRACE 方法', path: '/', method: 'TRACE', expect: [403, 405] },
];
const wafResults = [];
for (const p of wafProbes) {
  const extra = p.method ? ['-X', p.method] : [];
  const h = curlHead(`https://${ZONE}${p.path}`, extra);
  wafResults.push({ ...p, status: h.status, ok: p.expect.includes(h.status) });
}

/* ── 5 apex 不应 1014 ── */
const apexBody = curlBody(HUB_URL);
const apex = {
  has1014: /error code:\s*1014/i.test(apexBody),
  looksLikeHub: /MatrixOS/i.test(apexBody),
  bodyLen: apexBody.length,
};
apex.ok = !apex.has1014 && apex.looksLikeHub;

/*
 * ── 6 canonical / og:url 是否仍指向生产域名 ──
 *
 * 为什么要查：`layout.tsx` 里的 SITE_ORIGIN 是 `scripts/site-icons.mjs` 的**生成产物**。
 * 2026-10-21 迁移时踩过：改生成器不会更新已存在的 18 份，线上 canonical 仍指旧账号域名。
 * 这类回归不会让页面 500，爬虫才会发现 —— 必须显式断言。
 *
 * 判据：每站 canonical 与 og:url 都等于该站自己的生产 URL。
 */
function extractMeta(html) {
  const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(html)?.[1] ?? null;
  const ogUrl = /<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i.exec(html)?.[1] ?? null;
  return { canonical, ogUrl };
}

const metaChecks = [];
for (const t of targets) {
  const html = curlBody(t.url);
  const { canonical, ogUrl } = extractMeta(html);
  const norm = (u) => (u ? u.replace(/\/+$/, '') : null);
  const expect = norm(t.url);
  metaChecks.push({
    label: t.label,
    canonical,
    ogUrl,
    ok: norm(canonical) === expect && norm(ogUrl) === expect,
  });
}

/*
 * ── 7 微站 CSP frame-ancestors 必须放行 hub ──
 *
 * 为什么要查：微站被 hub 内嵌，CSP frame-ancestors 少一条 hub 来源，
 * iframe 会直接被浏览器拦掉（表现为内嵌区白屏，非 HTTP 错误，HTTP 层看不出来）。
 * hub 来源随域名迁移而变，所以这里断言「含 apex 域名」而不是写死完整列表。
 */
const cspChecks = [];
for (const t of targets.slice(1)) {          // 第 0 个是 hub 自己，顶层页不设 frame-ancestors
  const h = curlHead(t.url, ['-H', 'Accept: text/html']);
  const csp = /^content-security-policy:\s*(.+)$/im.exec(h.raw)?.[1]?.trim() ?? null;
  const fa = csp ? (/frame-ancestors\s+([^;]+)/i.exec(csp)?.[1]?.trim() ?? null) : null;
  cspChecks.push({
    label: t.label,
    hasCsp: !!csp,
    hasFrameAncestors: !!fa,
    allowsHub: !!fa && fa.includes(ZONE),
    ok: !!fa && fa.includes(ZONE),
  });
}

/*
 * ── 8 信任白名单里不许出现「不属于本项目」的 host ──
 *
 * 背景（2026-10-21 真实发现）：CSP `frame-ancestors` 与 SDK `allowedOrigins`
 * 里曾长期挂着 `https://orbital.pages.dev`，实测那是一个**第三方站点**
 * （title="Orbital Trails"）。它只是当年第一次写 CSP 时**写错的域名**，
 * 后来被当成「历史兼容」一直留着。
 *
 * 危害：白名单是**信任声明**。把陌生 origin 列进去 = 允许它向微站 iframe
 * 投递伪造的 mx_idt / 虫洞信封，并被当作合法宿主。
 *
 * 判据：白名单里每一条 pages.dev 主机，都必须能在本项目的 Pages 项目名单里
 * 找到对应项（或属于我方自有域名）。这样任何「顺手加一条」都会被抓到。
 */
const TRUSTED_HOST_SUFFIXES = [ZONE];
/** 已知第三方的 host：出现即失败。加新条目时先从线上真实内容确认归属。 */
const KNOWN_THIRD_PARTY = [
  'orbital.pages.dev',        // 实测 title="Orbital Trails"，非本项目
  'orbital-hub.pages.dev',    // 不属于本项目（302）
  'orbital.matrixos.edu',     // 已废弃愿景域名，实测 NXDOMAIN
];

const trustChecks = [];
for (const c of cspChecks) {
  const h = curlHead(targets.find((t) => t.label === c.label).url, ['-H', 'Accept: text/html']);
  const csp = /^content-security-policy:\s*(.+)$/im.exec(h.raw)?.[1]?.trim() ?? null;
  const fa = csp ? (/frame-ancestors\s+([^;]+)/i.exec(csp)?.[1]?.trim() ?? null) : null;
  if (!fa) { trustChecks.push({ label: c.label, offenders: [], ok: false, reason: '无 frame-ancestors' }); continue; }

  const hosts = fa.split(/\s+/).filter((x) => x.startsWith('http'));
  const offenders = hosts.filter((origin) => {
    const host = origin.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/^\*\./, '');
    if (KNOWN_THIRD_PARTY.includes(host)) return true;
    // 自有域名后缀直接放行；其余（pages.dev 等共享域）必须显式匹配已知项目
    if (TRUSTED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return false;
    // loopback 放行（本地开发）
    if (/^(localhost|127\.0\.0\.1)$/.test(host)) return false;
    // 共享域上的主机名必须是本项目已知的（mx-* 前缀）
    return !/^mx-[a-z0-9-]+/.test(host);
  });
  trustChecks.push({ label: c.label, offenders, ok: offenders.length === 0 });
}
const trustPass = trustChecks.filter((t) => t.ok).length;

/* ── 汇总 ── */
const pass = results.filter((r) => r.ok).length;
const metaPass = metaChecks.filter((m) => m.ok).length;
const cspPass = cspChecks.filter((c) => c.ok).length;
const allOk =
  pass === results.length &&
  tlsChecks.every((t) => t.ok) &&
  wafResults.every((w) => w.ok) &&
  apex.ok &&
  metaPass === metaChecks.length &&
  cspPass === cspChecks.length &&
  trustPass === trustChecks.length;

if (jsonOut) {
  console.log(JSON.stringify({
    sites: results, tls: tlsChecks, waf: wafResults, apex,
    meta: metaChecks, csp: cspChecks, trust: trustChecks, allOk,
  }, null, 2));
} else {
  console.log(`生产验证 · zone ${ZONE} · ${targets.length} 个目标\n`);
  console.log('站点'.padEnd(26) + 'HTTP'.padEnd(8) + 'HSTS(includes+preload)');
  console.log('─'.repeat(78));
  for (const r of results) {
    console.log(`${r.label.padEnd(26)}${String(r.status).padEnd(8)}${r.hstsOk ? 'OK' : 'MISSING  <<<'}`);
  }
  console.log('─'.repeat(78));
  console.log(`可达 + HSTS：${pass}/${results.length}`);

  console.log('\nTLS 下限（1.0/1.1 应失败、1.2 应成功）');
  for (const t of tlsChecks) {
    console.log(`  ${t.host.padEnd(30)} 1.0=${t.tls10Accepted ? 'ACCEPTED <<<' : 'rejected'}  1.1=${t.tls11Accepted ? 'ACCEPTED <<<' : 'rejected'}  1.2=${t.tls12Accepted ? 'ok' : 'FAILED <<<'}  ${t.ok ? 'OK' : 'FAIL'}`);
  }

  console.log('\nWAF 命中');
  for (const w of wafResults) {
    console.log(`  ${w.label.padEnd(20)} ${String(w.status).padEnd(6)} ${w.ok ? 'OK' : `EXPECT ${w.expect.join('/')} <<<`}`);
  }

  console.log('\napex 1014 检查');
  console.log(`  含 error 1014: ${apex.has1014 ? 'YES <<<' : 'no'}   bodyLen=${apex.bodyLen}   ${apex.ok ? 'OK' : 'FAIL'}`);

  console.log(`\ncanonical / og:url（应等于各站自己的生产 URL）  ${metaPass}/${metaChecks.length}`);
  for (const m of metaChecks) {
    if (m.ok) continue;
    console.log(`  ${m.label.padEnd(24)} canonical=${m.canonical ?? '(缺)'}  og:url=${m.ogUrl ?? '(缺)'}  <<<`);
  }
  if (metaPass === metaChecks.length) console.log('  全部正确');

  console.log(`\n微站 CSP frame-ancestors 放行 hub  ${cspPass}/${cspChecks.length}`);
  for (const c of cspChecks) {
    if (c.ok) continue;
    const why = !c.hasCsp ? '无 CSP 头' : !c.hasFrameAncestors ? '无 frame-ancestors 指令' : `未放行 ${ZONE}`;
    console.log(`  ${c.label.padEnd(24)} ${why}  <<<`);
  }
  if (cspPass === cspChecks.length) console.log('  全部放行');

  console.log(`\n信任白名单无第三方域名  ${trustPass}/${trustChecks.length}`);
  for (const x of trustChecks) {
    if (x.ok) continue;
    const why = x.reason ?? `第三方/未知 host: ${x.offenders.join(', ')}`;
    console.log(`  ${x.label.padEnd(24)} ${why}  <<<`);
  }
  if (trustPass === trustChecks.length) console.log('  全部为本项目域名');

  console.log(`\n${allOk ? '✓ 全部通过' : '✗ 存在未通过项'}`);
}

process.exit(allOk ? 0 : 1);
