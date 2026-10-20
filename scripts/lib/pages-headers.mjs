#!/usr/bin/env node
/**
 * 生成 Cloudflare Pages 的 `_headers` 文件内容。
 *
 * 为什么单独抽出这个模块：
 *   `build-static-site.mjs`（构建后写）与 `redeploy-headers.mjs`（只改头重部署）
 *   都需要同一份内容。之前两处各写一遍，改 CSP 时漏改一处就会线上挂掉
 *   —— 实际发生过：第一次 CSP 白名单只写了 orbital.pages.dev，
 *   而实际 hub 域名是 mx-orbital.pages.dev，线上 iframe 全被拦。
 *
 * 单一事实源在这里，两个脚本都 import 它。
 */

/**
 * frame-ancestors 白名单。
 *
 * 覆盖三类来源：
 *   1. 线上 hub（生产域名 + 预览子域通配）
 *   2. 未来自定义域名
 *   3. 本地开发
 *
 * ⚠️ 改 Pages 项目名前缀时必须同步改这里，否则 iframe 全被 CSP 拦。
 *    验证方式：`curl -sI https://mx-<appId>.pages.dev | grep -i content-security`
 */
const FRAME_ANCESTORS = [
  "'self'",
  // 线上 hub 生产域名
  'https://mx-orbital.pages.dev',
  // hub 的预览部署：每次 commit 一个 <hash>.mx-orbital.pages.dev
  'https://*.mx-orbital.pages.dev',
  // 历史/备用命名，保留以防改名
  'https://orbital.pages.dev',
  'https://orbital-hub.pages.dev',
  // 未来自定义域名
  'https://orbital.matrixos.edu',
  // 本地开发
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].join(' ');

/**
 * 生成某站点的 _headers。
 *
 * 安全头取舍说明：
 *
 * - **Content-Security-Policy: frame-ancestors** — 核心。只允许 hub 嵌入，
 *   防止第三方站点把我们套进钓鱼 iframe。
 *
 * - **不用 X-Frame-Options** — 它会与 frame-ancestors 冲突（现代浏览器
 *   优先 CSP，旧浏览器读 XFO）。而且 XFO 的 ALLOW-FROM 已被废弃，
 *   无法表达「多域名白名单」。所以只用 CSP，不设 XFO。
 *   （旧浏览器上没有 iframe 保护，但那些浏览器也基本不兼容本项目的前端。）
 *
 * - **Strict-Transport-Security** — Pages 默认强制 HTTPS 且已配 308 跳转，
 *   但 HSTS 能让浏览器记住「只走 HTTPS」，防降级攻击。
 *   注意：`preload` 一旦提交就难以撤销，这里**不加** preload，只设 1 年。
 *
 * - **Permissions-Policy** — 显式关闭本项目用不到的浏览器能力
 *   （摄像头、麦克风、地理位置、支付）。微站不需要这些，
 *   关掉可缩小攻击面。
 *
 * - **Cross-Origin-Opener-Policy: same-origin-allow-popups** — 隔离
 *   顶层窗口，但允许弹窗（SSO 跳转需要）。不用 `same-origin` 是因为
 *   那会切断 OAuth 回调窗口的 opener 引用。
 *
 * @param {string} station 站点标识（目录名或 appId），写进注释便于排查
 */
export function pagesHeaders(station) {
  return `# Cloudflare Pages headers · 自动生成
# 站点：${station}
# 生成器：scripts/lib/pages-headers.mjs
# 改动请改生成器，不要直接改本文件（会被覆盖）

/*
  Content-Security-Policy: frame-ancestors ${FRAME_ANCESTORS}
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin-allow-popups

# 静态资源长缓存：文件名带内容 hash，内容变了 URL 就变，可以永久缓存
/_next/static/*
  Cache-Control: public, max-age=31536000, immutable

# 图标与字体：中等缓存（可更新但不必频繁校验）
/*.svg
  Cache-Control: public, max-age=86400
/*.woff2
  Cache-Control: public, max-age=31536000, immutable

# HTML：不缓存，确保部署后立刻生效
/*.html
  Cache-Control: public, max-age=0, must-revalidate
`;
}

export { FRAME_ANCESTORS };
