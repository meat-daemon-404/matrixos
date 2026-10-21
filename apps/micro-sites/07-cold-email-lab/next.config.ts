/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：07 证据内嵌式套磁信推演器
 * 轨道：轨道 4 · 星门 · 域名：cold-email.matrixos.cc.cd
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=07 --force
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import type { NextConfig } from 'next';

/**
 * workspace 包在脚手架阶段可能尚未落地（由 BE/FE 并行开发）。
 * 这里在配置加载时探测一次：**不可 resolve 就把 specifier（含子路径）别名到本地 shim**，
 * 于是「源码里 import 已写好」与「pnpm dev 立刻能跑」同时成立。
 * 包一旦就位，别名自动失效，本文件与业务源码都不用改。
 *
 * 两个包的最终形态已与 owner 对齐：
 *  - 均源码直出（exports["."] → ./src/index.ts），因此 transpilePackages 是**必需**的；
 *  - instrument-ui 还需显式 import 一次 '@matrixos/instrument-ui/styles.css'。
 */
const WORKSPACE_PACKAGES = ["@matrixos/sdk", "@matrixos/instrument-ui"] as const;

/** 包 specifier → 本地 shim 相对路径。子路径必须单独列出，否则会被前缀别名吃掉。 */
const SHIM_BY_SPECIFIER: Record<string, string> = {
  ["@matrixos/sdk"]: 'src/lib/shims/matrix-sdk.shim.ts',
  ["@matrixos/instrument-ui"]: 'src/lib/shims/instrument-ui.shim.tsx',
  ["@matrixos/instrument-ui" + '/styles.css']: 'src/lib/shims/instrument-ui.styles.css',
  ["@matrixos/instrument-ui" + '/tokens.css']: 'src/lib/shims/instrument-ui.styles.css',
};

// process.cwd() 在 `pnpm --filter <pkg> dev` / turbo run dev 下等于本包根目录
const pkgRoot = process.cwd();
const localRequire = createRequire(path.join(pkgRoot, 'package.json'));

function canResolve(specifier: string): boolean {
  try {
    localRequire.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** 逐个 specifier 打探；缺失的记下来供 webpack 别名使用。 */
function detectMissingSpecifiers(): string[] {
  const missing: string[] = [];
  for (const spec of Object.keys(SHIM_BY_SPECIFIER)) {
    if (!canResolve(spec)) missing.push(spec);
  }
  const missingPkgs = WORKSPACE_PACKAGES.filter((pkg) => !canResolve(pkg));
  if (missingPkgs.length > 0) {
    console.warn(
      '[matrixos] 以下 workspace 包尚未就位，已启用本地 shim（界面会显式标注未就位，' +
        '不会伪造登录态或虫洞投递）：' +
        missingPkgs.join(', '),
    );
  } else {
    for (const spec of missing) {
      if (missingPkgs.every((pkg) => !spec.startsWith(pkg))) {
        console.warn('[matrixos] ' + spec + ' 无法解析，已走本地 shim（包入口/子路径 exports 可能有问题）。');
      }
    }
  }
  return missing;
}

const missingSpecifiers = detectMissingSpecifiers();
const resolvedPackages = WORKSPACE_PACKAGES.filter((pkg) => !missingSpecifiers.includes(pkg));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 源码直出的 workspace 包必须由 Next 参与编译（owner 明确要求）
  transpilePackages: [...resolvedPackages],
  poweredByHeader: false,
  /**
   * 微站必须能被 orbital-hub 以 iframe 嵌入（架构 A4 / ADR-08）。
   * 不要设 X-Frame-Options: DENY；用 CSP frame-ancestors 精确放行主控台。
   *
   * 白名单**不在这里手写**：直接取 scripts/lib/pages-headers.mjs 的 FRAME_ANCESTORS，
   * 与 Cloudflare Pages 的 _headers 同源。曾经这里写死 'https://orbital.matrixos.edu'
   * （NXDOMAIN 愿景域），而 _headers 里早已换成真实宿主 —— 两份清单漂移，
   * 静态导出产物（无 next 运行时，headers() 不生效）与线上行为不一致。
   */
  async headers() {
    const frameAncestors = "'self' https://matrixos.cc.cd https://www.matrixos.cc.cd https://*.matrixos.cc.cd https://mx-orbital-c6y.pages.dev https://*.mx-orbital-c6y.pages.dev https://mx-orbital.pages.dev https://*.mx-orbital.pages.dev http://localhost:3000 http://127.0.0.1:3000";
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: 'frame-ancestors ' + frameAncestors },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = config.resolve.alias ?? {};
    const alias = config.resolve.alias as Record<string, string>;
    for (const spec of missingSpecifiers) {
      const shimRel = SHIM_BY_SPECIFIER[spec];
      // 用 `spec$` 精确匹配：既让裸 specifier 命中，又不让 styles.css 子路径串到 .tsx 上
      if (shimRel) alias[spec + '$'] = path.join(pkgRoot, shimRel);
    }
    return config;
  },
};

export default nextConfig;
