/**
 * 静态导出专用配置模板 —— 由 scripts/build-static-site.mjs 复制到各微站。
 *
 * ⚠️ 本文件本身不参与构建，只是模板源。真正的 next.config.ts 会在
 *    构建期间被临时替换为本文件内容，构建结束后逐字节恢复。
 *
 * 为什么要去掉 headers()：
 *   Next.js 的 `output: 'export'`（静态导出）不支持 `headers()`，
 *   有它会直接报错。微站原本的 headers() 是用来设
 *   `Content-Security-Policy: frame-ancestors`（限制谁能 iframe 嵌入）——
 *   静态托管到 Cloudflare Pages 后，这条改由 Pages 的 `_headers` 文件承担，
 *   见 scripts/build-static-site.mjs 里生成的 _headers。
 *
 * 为什么保留 shim 别名逻辑：
 *   hub/微站的 next.config 原本会探测 @matrixos/sdk 等 workspace 包是否可
 *   resolve，不可则别名到本地 shim。部署构建必须保留同样行为，否则
 *   包缺失时构建会失败而不是优雅降级。
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

function canResolve(specifier: string): boolean {
  try {
    localRequire.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

const missing: string[] = Object.keys(SHIM_BY_SPECIFIER).filter((spec) => !canResolve(spec));
const resolved: string[] = WORKSPACE_PACKAGES.filter((pkg) => !missing.includes(pkg));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: resolved,
  poweredByHeader: false,
  output: 'export',
  // 静态托管：目录形式 URL（/foo/ -> /foo/index.html），Pages 直接认
  trailingSlash: true,
  images: { unoptimized: true },
  /**
   * 后端 API 基址注入（`env` 字段保证被 Next 静态内联）。
   *
   * 为什么必须用 `next.config` 的 `env` 而不是只靠 `process.env.NEXT_PUBLIC_*`：
   * 微站源码里的 `process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL` 经 webpack
   * 处理后变成 `<process shim>.env.NEXT_PUBLIC_...`（实测产物里是 `nt.env.…`），
   * **不再是编译期字面量**，于是 Next 的 DefinePlugin 不替换，浏览器读到 undefined。
   *
   * `env` 字段是 Next 官方保证的静态内联入口，写成
   * `env: { NEXT_PUBLIC_XXX: '值' }` 后，源码里的 `process.env.NEXT_PUBLIC_XXX`
   * 会被替换成该字面量。
   *
   * 未注入时字段为空对象 —— 行为与之前完全一致（SDK 用它自己的默认值）。
   */
  env: {
    ...(process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL
      ? { NEXT_PUBLIC_MATRIXOS_API_BASE_URL: process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL }
      : {}),
  },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = config.resolve.alias ?? {};
    const alias = config.resolve.alias as Record<string, string>;
    for (const spec of missing) {
      const shimRel = SHIM_BY_SPECIFIER[spec];
      if (shimRel) alias[spec + '$'] = path.join(pkgRoot, shimRel);
    }
    return config;
  },
};

export default nextConfig;
