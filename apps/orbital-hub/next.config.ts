/**
 * orbital-hub · 双态合体总控台
 *
 * workspace 包（@matrixos/sdk / @matrixos/instrument-ui）由其他同学并行开发，
 * 这里在配置加载时探测一次：**不可 resolve 就把 specifier（含子路径）别名到本地 shim**，
 * 于是「源码 import 已按最终形态写好」与「pnpm dev 立刻能跑」同时成立。
 * 包一旦就位，别名自动失效，源码一行都不用改。
 *
 * 与两个 package owner 对齐的形态（2026-10-20）：
 *  - 均源码直出（exports["."] → ./src/index.ts）→ transpilePackages 是必需的；
 *  - instrument-ui 需显式 import 一次 '@matrixos/instrument-ui/styles.css'。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import type { NextConfig } from 'next';

const WORKSPACE_PACKAGES = ['@matrixos/sdk', '@matrixos/instrument-ui'] as const;

/** 包 specifier → 本地 shim。子路径必须单列，否则会被前缀别名吃掉。 */
const SHIM_BY_SPECIFIER: Record<string, string> = {
  '@matrixos/sdk': 'src/lib/shims/matrix-sdk.shim.ts',
  '@matrixos/instrument-ui': 'src/lib/shims/instrument-ui.shim.tsx',
  '@matrixos/instrument-ui/styles.css': 'src/lib/shims/instrument-ui.styles.css',
  '@matrixos/instrument-ui/tokens.css': 'src/lib/shims/instrument-ui.styles.css',
};

// process.cwd() 在 `pnpm --filter @matrixos/orbital-hub dev` / turbo run dev 下等于本包根目录
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

function detectMissingSpecifiers(): string[] {
  const missing = Object.keys(SHIM_BY_SPECIFIER).filter((spec) => !canResolve(spec));
  const missingPkgs = WORKSPACE_PACKAGES.filter((pkg) => missing.includes(pkg));
  if (missingPkgs.length > 0) {
    console.warn(
      '[matrixos] 以下 workspace 包尚未就位，已启用内置实现（界面会显式标注来源，' +
        '不伪造登录态或虫洞投递）：' +
        missingPkgs.join(', '),
    );
  }
  return missing;
}

const missingSpecifiers = detectMissingSpecifiers();
const resolvedPackages = WORKSPACE_PACKAGES.filter((pkg) => !missingSpecifiers.includes(pkg));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 源码直出的 workspace 包必须由 Next 参与编译
  transpilePackages: [...resolvedPackages],
  poweredByHeader: false,
  // 总控台被 iframe 嵌入没有意义（它是宿主），但允许被校方门户以 frame 引用做展示
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
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
      // spec$ 精确匹配：裸 specifier 命中，styles.css 子路径不会串到 .tsx 上
      if (shimRel) alias[spec + '$'] = path.join(pkgRoot, shimRel);
    }
    return config;
  },
};

export default nextConfig;
