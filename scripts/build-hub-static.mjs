/**
 * orbital-hub 静态导出构建。
 *
 * 与微站的区别：
 *   hub 有一个 `/placeholder` 动态路由（用 searchParams），
 *   在 output:'export' 下不能有动态路由，除非给它 generateStaticParams。
 *
 * 处置策略：
 *   hub 只用于「微站未部署时占位」。现在 18 个微站已全部部署到
 *   *.pages.dev，运行时设 NEXT_PUBLIC_MICROSITE_PLACEHOLDER=false，
 *   占位页根本不会被访问。
 *
 *   因此导出前把 /placeholder 临时移走，导出后恢复。
 *   这样 hub 整体变成纯静态，可以正常部署到 Pages。
 *
 * 用法：
 *   node scripts/build-hub-static.mjs                 本地/harness 构建（允许环境变量覆盖地址）
 *   node scripts/build-hub-static.mjs --production    生产构建（**强制**生产地址，忽略环境值）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, readFileSync, renameSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB = join(ROOT, 'apps', 'orbital-hub');
const CFG = join(HUB, 'next.config.ts');
const PH_DIR = join(HUB, 'src', 'app', 'placeholder');
const PH_BAK = join(HUB, 'src', 'app', '__placeholder.disabled');

/**
 * `--production`：生产构建。
 * 强制忽略 `NEXT_PUBLIC_MICROSITE_LOCAL_MODE` 等环境覆盖值。
 *
 * 为什么必须存在（2026-10-21 真实事故）：
 * 并行会话的 shell 里残留 `NEXT_PUBLIC_MICROSITE_LOCAL_MODE=true`（本地联调所致），
 * 它重建 hub 时该值被 Next 的 DefinePlugin 静态替换进产物 → 线上 iframe src 变成
 * `http://127.0.0.1:3010`，用户浏览器连不到 → 内嵌态白屏、握手不通、SSO 永远 offline。
 * 部署前的正确做法：`node scripts/build-hub-static.mjs --production`。
 */
const PRODUCTION_BUILD = process.argv.includes('--production');

/**
 * 生产环境的微站地址模板。
 *
 * 为什么不再用 `https://mx-{appId}.pages.dev`（2026-10-21 迁移后）：
 *   `mx-<appId>.pages.dev` 这套子域名仍属于【旧账号】的 Pages 项目。
 *   本项目已整体迁到专用新账号，新账号里同名项目会被 Cloudflare 自动改名成
 *   `mx-<appId>-<hash>.pages.dev`（例如 mx-curvelab-7r4），那个 hash 不可预测、
 *   也不该写进产物。所以微站的稳定入口改用自有根域下的二级域名：
 *   `https://mx-{appId}.matrixos.cc.cd`。
 * 可用 MATRIXOS_MICROSITE_TEMPLATE 覆盖（本地 harness / 灰度时用）。
 */
const PROD_MICROSITE_TEMPLATE =
  process.env.MATRIXOS_MICROSITE_TEMPLATE ?? 'https://mx-{appId}.matrixos.cc.cd';

const origCfg = readFileSync(CFG);

const staticCfg = `/**
 * orbital-hub 静态导出配置 —— 由 scripts/build-hub-static.mjs 临时写入。
 *
 * 与原配置的差异：
 *   1. output: 'export'（部署到 Cloudflare Pages 静态托管）
 *   2. 去掉 headers()（export 不支持；CSP 改由 out/_headers 承担）
 *   3. trailingSlash: true（目录形式 URL）
 *   4. images.unoptimized（静态托管无图片优化服务）
 *
 * workspace 包的 shim 别名逻辑保留，与原配置一致。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import type { NextConfig } from 'next';

const WORKSPACE_PACKAGES = ['@matrixos/sdk', '@matrixos/instrument-ui'] as const;

const SHIM_BY_SPECIFIER: Record<string, string> = {
  '@matrixos/sdk': 'src/lib/shims/matrix-sdk.shim.ts',
  '@matrixos/instrument-ui': 'src/lib/shims/instrument-ui.shim.tsx',
  '@matrixos/instrument-ui/styles.css': 'src/lib/shims/instrument-ui.styles.css',
  '@matrixos/instrument-ui/tokens.css': 'src/lib/shims/instrument-ui.styles.css',
};

const pkgRoot = process.cwd();
const localRequire = createRequire(path.join(pkgRoot, 'package.json'));

function canResolve(spec: string): boolean {
  try {
    localRequire.resolve(spec);
    return true;
  } catch {
    return false;
  }
}

const missing = Object.keys(SHIM_BY_SPECIFIER).filter((s) => !canResolve(s));
const resolved = WORKSPACE_PACKAGES.filter((p) => !missing.includes(p));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: resolved,
  poweredByHeader: false,
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = config.resolve.alias ?? {};
    const alias = config.resolve.alias as Record<string, string>;
    for (const spec of missing) {
      const rel = SHIM_BY_SPECIFIER[spec];
      if (rel) alias[spec + '$'] = path.join(pkgRoot, rel);
    }
    return config;
  },
};

export default nextConfig;
`;

try {
  // 1. 临时移走 placeholder 路由（动态路由，export 不支持）
  const hadPlaceholder = existsSync(PH_DIR);
  if (hadPlaceholder) {
    renameSync(PH_DIR, PH_BAK);
    console.log('  （已临时移走 /placeholder 路由）');
  }

  // 2. 写入静态导出配置
  writeFileSync(CFG, staticCfg, 'utf8');

  // 3. 清理并构建
  rmSync(join(HUB, '.next'), { recursive: true, force: true });
  rmSync(join(HUB, 'out'), { recursive: true, force: true });
  rmSync(join(HUB, 'tsconfig.tsbuildinfo'), { force: true });

  const binField = (() => {
    try {
      const pkg = JSON.parse(readFileSync(join(HUB, 'node_modules', 'next', 'package.json'), 'utf8'));
      const b = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.next;
      return b ? join(HUB, 'node_modules', 'next', b) : null;
    } catch {
      return null;
    }
  })();

  console.log('▶ 构建 orbital-hub（静态导出）');
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
    if (attempt > 1) {
      console.log(`  （第 ${attempt} 次尝试）`);
      rmSync(join(HUB, '.next'), { recursive: true, force: true });
      rmSync(join(HUB, 'out'), { recursive: true, force: true });
    }
    try {
      execFileSync(binField ? process.execPath : 'npx', binField ? [binField, 'build'] : ['next', 'build'], {
        cwd: HUB,
        stdio: 'inherit',
        shell: !binField && process.platform === 'win32',
        env: {
          ...process.env,
          // NODE_ENV 必须强制为 production（本地 harness 也可能在 dev shell 里跑）。
          NODE_ENV: 'production',
          NEXT_TELEMETRY_DISABLED: '1',
          /*
           * 下面三项允许调用方**覆盖**（不设时就是生产取值）。
           *
           * 为什么需要这个能力：本地双端口 harness 要验「跨源握手」，就必须让
           * hub 的 iframe 指向本地构建的微站而不是线上 pages.dev。
           * 做成显式环境变量，比「脚本去改源码再改回来」安全得多 ——
           * 后者一旦中途失败，错误地址会留在产物里，而 git 看不出占位符被替换过。
           *
           * ⚠️ 但这个「允许覆盖」曾造成一次真实线上事故（2026-10-21）：
           *   并行会话的 shell 里有 `NEXT_PUBLIC_MICROSITE_LOCAL_MODE=true`
           *   （本地联调留下的），它重建 hub 时该值被 Next 的 DefinePlugin
           *   **静态替换进产物** → 线上 `mx-orbital.pages.dev` 的 iframe src 变成
           *   `http://127.0.0.1:3010`，用户浏览器根本连不到 → 内嵌态永远白屏、
           *   bridge 握手永不完成、SSO 永远 offline。
           *
           * 所以新增 `--production` 旗标：**显式请求生产构建时，强制忽略环境值**。
           * 部署流程（deploy-hub.mjs）应带该旗标；本地 harness 不带，保留覆盖能力。
           */
          NEXT_PUBLIC_MICROSITE_LOCAL_MODE: PRODUCTION_BUILD
            ? 'false'
            : (process.env.NEXT_PUBLIC_MICROSITE_LOCAL_MODE ?? 'false'),
          NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE: PRODUCTION_BUILD
            ? PROD_MICROSITE_TEMPLATE
            : (process.env.NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE ?? PROD_MICROSITE_TEMPLATE),
          NEXT_PUBLIC_MICROSITE_PLACEHOLDER: PRODUCTION_BUILD
            ? 'false'
            : (process.env.NEXT_PUBLIC_MICROSITE_PLACEHOLDER ?? 'false'),
        },
        timeout: 900000,
      });
      ok = existsSync(join(HUB, 'out', 'index.html'));
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }

  if (!ok) {
    // 与微站一样，Next 有时漏掉根 index.html，用 fixup 补齐
    const fixup = join(ROOT, 'scripts', 'fixup-static-export.mjs');
    // fixup 脚本按微站目录结构写的，这里手动补
    const src = join(HUB, '.next', 'server', 'app', 'index.html');
    if (existsSync(src)) {
      cpSync(src, join(HUB, 'out', 'index.html'));
      console.log('  （手动补齐 index.html）');
      ok = true;
    }
  }

  if (!ok) throw new Error('out/index.html 未生成');

  // 4. 生成 Pages 的 _headers
  //
  // ⚠️ 与微站的安全头**不同源**（已知漏网点，2026-10-20）：
  //   微站的 _headers 由 scripts/lib/pages-headers.mjs 生成，含 CSP frame-ancestors +
  //   HSTS + Permissions-Policy + COOP；而 hub 这一份是手写的，原先只有 3 条，
  //   **缺 HSTS 与 Permissions-Policy** → 线上 mx-orbital.pages.dev 实测两者皆无。
  //
  //   这里对齐同一套安全头，但**刻意不给 hub 加 CSP frame-ancestors**：
  //   hub 是顶层页，不需要限制「谁能嵌它」；加了反而挡住未来 hub 被别的容器嵌入。
  //   （微站的 frame-ancestors 是为了防第三方把微站套进钓鱼 iframe，hub 无此诉求。）
  //
  //   注：更彻底的做法是在 pages-headers.mjs 里导出一个「同安全头、无 CSP」的变体
  //   供本文件调用（单一事实源）。该文件归属另一条线，本次不改，仅在此对齐取值；
  //   两处取值若将来漂移，用本注释提醒同步。
  const headers = `# Cloudflare Pages headers · 自动生成（scripts/build-hub-static.mjs）
#
# 安全头取值与 scripts/lib/pages-headers.mjs 保持一致（差异仅：hub 不设 CSP frame-ancestors）
/*
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin-allow-popups

/_next/static/*
  Cache-Control: public, max-age=31536000, immutable
`;
  writeFileSync(join(HUB, 'out', '_headers'), headers, 'utf8');
  writeFileSync(join(HUB, 'out', '_redirects'), '/* /index.html 200\n', 'utf8');

  console.log('✓ orbital-hub → out/');
} finally {
  // 恢复原配置与 placeholder
  writeFileSync(CFG, origCfg);
  if (existsSync(PH_BAK)) {
    renameSync(PH_BAK, PH_DIR);
    console.log('  （已恢复 /placeholder 路由）');
  }
  console.log('✓ next.config.ts 与 placeholder 已恢复');
}
