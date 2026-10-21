#!/usr/bin/env node
/**
 * 宿主来源三处一致性断言（`host-origins` 门禁）。
 *
 * ## 这道门禁为什么必须存在
 *
 * 2026-10-21 线上事故：总控台里每个微站都显示 `MatrixID · offline`，
 * `layout.resize`（iframe 高度自适应）从未生效，18 站里 14 站有内容永远不可达。
 * 根因不是某一个组件写错，而是**同一个事实被三处独立维护、两处没跟上**：
 *
 *   1. `Content-Security-Policy: frame-ancestors`（谁能嵌我）—— 已含 `*.pages.dev`；
 *   2. SDK `DEFAULT_ALLOWED_ORIGINS`（我信谁的跨源消息）—— 只有 `*.matrixos.edu`，
 *      而真实部署全在 `*.pages.dev` → 握手消息双向被丢弃；
 *   3. 微站 `initSSO()` —— 只读一次 `connected` 就永久放弃，即使前两条都对也等不到。
 *
 * 三处任一处不对，症状都是**同一个**：界面看起来正常，只是 MatrixID 永远 offline、
 * 面板内容被裁。这种「静默不工作」比报错危险得多 —— 所以把它变成可断言的。
 *
 * ## 本脚本断言什么（都是机械可判定的，不是散文）
 *
 *   A. `pages-headers.mjs` 的 CSP 与 SDK 清单**同源派生**（同一个 HUB_ORIGINS 数组）；
 *   B. SDK 清单里每一项都能被 SDK 真实的 `OriginAllowList` 解析并放行对应 origin
 *      —— 这条防的是语法错：把 CSP 的 `https://*.x` 直接抄进 SDK 会被解析成
 *      名为 `*.x` 的主机，白名单「看着配了」却一条都不放行；
 *   C. 线上真实宿主 origin（`https://mx-orbital.pages.dev`）确实被放行；
 *   D. 反向负样本：`https://evil.com` 与**微站自己的** origin 不被放行
 *      —— 白名单放宽到「谁都能连」同样是缺陷；
 *   E. 构建脚本确实把清单注入进了 `NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS`；
 *   F. 微站 facade 真的消费了该变量（否则注入了也没人读）；
 *   G. `initSSO` 不再「一次判负、永不重试」—— 源码里存在对 `bridge.connected`
 *      的订阅（或等价的重试结构）。这条只能松判定，但能抓住「整段被删掉」。
 *
 * 用法：
 *   node scripts/check-host-origins.mjs
 *   node scripts/check-host-origins.mjs --verbose
 *
 * 退出码：0 全通过 / 1 有失败项。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

const failures = [];
const warnings = [];
let checks = 0;

function pass(msg) {
  checks += 1;
  console.log(`  ${C.g}✓${C.x} ${msg}`);
}

function fail(msg, detail) {
  checks += 1;
  failures.push(msg);
  console.log(`  ${C.r}✗${C.x} ${msg}`);
  if (detail) console.log(`     ${C.d}${detail}${C.x}`);
}

function warn(msg) {
  warnings.push(msg);
  console.log(`  ${C.y}!${C.x} ${msg}`);
}

function rel(p) {
  return p.replace(ROOT + '\\', '').replace(ROOT + '/', '');
}

console.log('宿主来源一致性断言（CSP / SDK 白名单 / 构建注入 / facade 消费）');
console.log('─'.repeat(72));

/* ─────────── 读唯一事实源 ─────────── */

const HEADERS_LIB = join(ROOT, 'scripts', 'lib', 'pages-headers.mjs');
if (!existsSync(HEADERS_LIB)) {
  console.error(`✗ 缺少 ${rel(HEADERS_LIB)}`);
  process.exit(1);
}

let headerMod;
try {
  headerMod = await import(pathToFileUrl(HEADERS_LIB));
} catch (e) {
  console.error(`✗ 无法 import ${rel(HEADERS_LIB)}：${String(e.message).split('\n')[0]}`);
  process.exit(1);
}

const { FRAME_ANCESTORS, HUB_ORIGINS_FOR_SDK, pagesHeaders } = headerMod;

function pathToFileUrl(p) {
  // 兼容 Windows 盘符路径 → file:// URL
  const normalized = p.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

/* ─────────── A. CSP 与 SDK 清单同源 ─────────── */

console.log('\nA. 单一事实源（CSP 与 SDK 清单由同一数组派生）');

if (typeof FRAME_ANCESTORS !== 'string' || FRAME_ANCESTORS.length === 0) {
  fail('FRAME_ANCESTORS 未导出或为空');
} else if (typeof HUB_ORIGINS_FOR_SDK !== 'string' || HUB_ORIGINS_FOR_SDK.length === 0) {
  fail('HUB_ORIGINS_FOR_SDK 未导出或为空');
} else {
  pass('两个导出都存在且非空');

  // CSP 里的每个 host 都要在 SDK 清单里有对应项（去掉 https:// 与通配差异后比对主机）
  const cspHosts = FRAME_ANCESTORS.split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "'self'")
    .map((s) => {
      try {
        return new URL(s.replace('*.', 'wildcard.')).hostname.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const sdkHosts = HUB_ORIGINS_FOR_SDK.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        const withoutScheme = s.includes('://') ? s : `https://${s}`;
        return new URL(withoutScheme.replace('*.', 'wildcard.')).hostname.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const missingInSdk = cspHosts.filter((h) => !sdkHosts.includes(h));
  if (missingInSdk.length === 0) {
    pass(`CSP 的 ${cspHosts.length} 个宿主主机全部出现在 SDK 清单中`);
  } else {
    fail(
      `CSP 有 ${missingInSdk.length} 个宿主主机没进 SDK 清单（能嵌我但我不信它 → 握手必断）`,
      missingInSdk.join(', '),
    );
  }

  const extraInSdk = sdkHosts.filter((h) => !cspHosts.includes(h));
  if (extraInSdk.length === 0) {
    pass('SDK 清单没有 CSP 之外的额外宿主');
  } else {
    // 这不算硬失败：SDK 白名单包含非嵌入来源（如 API 域）是允许的，
    // 但会让「谁能嵌我」与「我信谁」产生差异，值得提示。
    warn(`SDK 清单有 ${extraInSdk.length} 个 CSP 之外的主机（不一定是错，但要确认是有意的）：${extraInSdk.join(', ')}`);
    checks += 1;
  }
}

/* ─────────── A2. _headers 里真的写了这份 CSP ─────────── */

try {
  const sample = pagesHeaders('00-selftest');
  if (sample.includes(FRAME_ANCESTORS)) {
    pass('pagesHeaders() 产出的 _headers 含完整 frame-ancestors');
  } else {
    fail('pagesHeaders() 产出的 _headers 不含 FRAME_ANCESTORS（生成器与常量脱节）');
  }
} catch (e) {
  fail(`pagesHeaders() 调用失败：${String(e.message).split('\n')[0]}`);
}

/* ─────────── B/C/D. 用 SDK 真实实现验证语法与语义 ─────────── */

console.log('\nB/C/D. 用 SDK 真实的 OriginAllowList 验证（不靠人工读代码）');

const SDK_ORIGIN = join(ROOT, 'packages', 'matrix-sdk', 'dist', 'security', 'origin.js');
let OriginAllowList = null;

if (!existsSync(SDK_ORIGIN)) {
  warn(`SDK 尚未构建（缺 ${rel(SDK_ORIGIN)}），跳过 B/C/D；先跑 pnpm --filter @matrixos/sdk build`);
  checks += 1;
} else {
  try {
    const mod = await import(pathToFileUrl(SDK_ORIGIN));
    OriginAllowList = mod.OriginAllowList;
  } catch (e) {
    fail(`无法加载 SDK 的 OriginAllowList：${String(e.message).split('\n')[0]}`);
  }
}

if (OriginAllowList && typeof HUB_ORIGINS_FOR_SDK === 'string') {
  const patterns = HUB_ORIGINS_FOR_SDK.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let list;
  try {
    list = new OriginAllowList(patterns, { allowLoopback: false });
  } catch (e) {
    fail(`OriginAllowList 构造失败：${String(e.message).split('\n')[0]}`);
  }

  if (list) {
    /* B. 没有任何一项被解析成空（语法错会静默变空） */
    if (list.isEmpty && patterns.length > 0) {
      fail('清单非空但 OriginAllowList 判定为空 —— 语法全部无效（通配必须写 *.host，不能带协议前缀）');
    } else {
      pass(`清单 ${patterns.length} 项，OriginAllowList 可解析（非空）`);
    }

    /* C. 线上真实宿主必须放行（2026-10-21 账号迁移后的生产域名） */
    const mustAllow = [
      'https://matrixos.cc.cd',
      'https://mx-orbital-c6y.pages.dev',   // 新账号 hub 真实主机
      'https://mx-orbital.pages.dev',       // 旧账号，回滚兼容
      'http://localhost:3000',
    ];
    const deniedMust = mustAllow.filter((o) => !list.allows(o));
    if (deniedMust.length === 0) {
      pass(`线上/本地宿主全部放行：${mustAllow.join(', ')}`);
    } else {
      fail(`以下宿主本应放行却被拒（会导致 MatrixID offline / resize 失效）：`, deniedMust.join(', '));
    }

    /* C2. 预览子域通配 */
    if (list.allows('https://abc123def.mx-orbital.pages.dev')) {
      pass('hub 预览部署子域（<hash>.mx-orbital.pages.dev）被放行');
    } else {
      fail('hub 预览部署子域未被放行（每次 commit 的预览部署将无法嵌入微站）');
    }

    /* D. 负样本：绝不能放行 */
    const mustDeny = [
      'https://evil.com',
      'https://mx-orbital.pages.dev.evil.com',
      'https://evil-mx-orbital.pages.dev',
      // 微站自己是 tenant，不该在自己的「宿主白名单」里
      'https://mx-gpa.pages.dev',
      /*
       * 以下三条是 2026-10-21 安全清理移除的条目，必须保持被拒：
       *   - orbital.pages.dev     实测是第三方站点（title="Orbital Trails"），
       *                           本项目从未部署在该项目名下
       *   - orbital-hub.pages.dev 不属于本项目（实测 302）
       *   - orbital.matrixos.edu  已废弃愿景域名，实测 NXDOMAIN
       * 把它们留在信任白名单里，等于允许陌生站点向微站投递伪造的
       * mx_idt / 虫洞信封。放进负样本，防止将来又被「顺手加回来」。
       */
      'https://orbital.pages.dev',
      'https://orbital-hub.pages.dev',
      'https://orbital.matrixos.edu',
    ];
    const wronglyAllowed = mustDeny.filter((o) => list.allows(o));
    if (wronglyAllowed.length === 0) {
      pass(`负样本全部被拒（${mustDeny.length} 条，含近似域名、本站 origin、已清理的第三方域名）`);
    } else {
      fail('白名单过宽，以下本应被拒却放行了：', wronglyAllowed.join(', '));
    }

    if (VERBOSE) {
      console.log(`\n  ${C.d}完整判定表：${C.x}`);
      for (const p of [...mustAllow, 'https://abc123def.mx-orbital.pages.dev', ...mustDeny]) {
        console.log(`    ${list.allows(p) ? 'ALLOW' : 'DENY '}  ${p}`);
      }
    }
  }
}

/* ─────────── E. 构建脚本注入 ─────────── */

console.log('\nE. 构建期注入');

const BUILD_STATIC = join(ROOT, 'scripts', 'build-static-site.mjs');
if (!existsSync(BUILD_STATIC)) {
  fail(`缺少 ${rel(BUILD_STATIC)}`);
} else {
  const src = readFileSync(BUILD_STATIC, 'utf8');
  if (!src.includes('NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS')) {
    fail('build-static-site.mjs 未注入 NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS（微站产物将拿不到宿主清单）');
  } else if (!src.includes('HUB_ORIGINS_FOR_SDK')) {
    fail('build-static-site.mjs 注入了变量名，但不是从 pages-headers 的单一事实源取值（会与 CSP 漂移）');
  } else {
    pass('build-static-site.mjs 从单一事实源注入 NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS');
  }
}

/* ─────────── F/G. 微站 facade 消费 + 握手不一次判负 ─────────── */

console.log('\nF/G. 微站 façade');

const FACADE_TEMPLATE = join(ROOT, 'apps', 'micro-sites', 'shared', 'templates', 'sdk-facade.ts');
if (!existsSync(FACADE_TEMPLATE)) {
  fail(`缺少 ${rel(FACADE_TEMPLATE)}`);
} else {
  const src = readFileSync(FACADE_TEMPLATE, 'utf8');

  if (!src.includes('NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS')) {
    fail('sdk-facade 模板未读取 NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS（注入了但没人用）');
  } else {
    pass('sdk-facade 模板读取宿主清单');
  }

  if (!/allowedOrigins\s*:/.test(src)) {
    fail('sdk-facade 模板没有把 allowedOrigins 传给 SDK 构造（会退回只信任 *.matrixos.edu 的默认值）');
  } else {
    pass('sdk-facade 模板向 SDK 显式传 allowedOrigins');
  }

  /*
   * G 的判定刻意宽松但不可绕过：
   * 只要求源码里存在「订阅宿主桥连接」的痕迹。写法可以变（.on('bridge.connected')
   * 或等价的 getter 轮询），但整段被删掉就会命中失败 —— 那正是导致
   * 「一次判负、永不重试」的形态。
   */
  const subscribesToBridge =
    /bridge\.connected/.test(src) || /on\(\s*['"]bridge\.connected['"]/.test(src);
  if (subscribesToBridge) {
    pass('sdk-facade 存在对宿主桥连接的等待/订阅（不再一次判负）');
  } else {
    fail('sdk-facade 未见任何对 bridge.connected 的订阅或等待 —— 会退回「一次判负、永不重试」');
  }
}

/* ─────────── 汇总 ─────────── */

console.log('\n' + '─'.repeat(72));
if (failures.length === 0) {
  console.log(`${C.g}✓ 宿主来源一致性 ${checks} 项全部通过${C.x}${warnings.length ? `（${warnings.length} 条提示）` : ''}`);
  process.exit(0);
}
console.log(`${C.r}✗ ${failures.length} 项失败${C.x}（共 ${checks} 项）`);
for (const f of failures) console.log(`  - ${f}`);
console.log(`\n${C.d}提示：修完跑 \`node scripts/build-static-site.mjs --all\` 重建产物，再部署。${C.x}`);
process.exit(1);
