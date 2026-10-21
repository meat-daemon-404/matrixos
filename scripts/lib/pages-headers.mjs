#!/usr/bin/env node
/**
 * 生成 Cloudflare Pages 的 `_headers` 文件内容，并导出「宿主来源」唯一事实源。
 *
 * 为什么单独抽出这个模块：
 *   `build-static-site.mjs`（构建后写）与 `redeploy-headers.mjs`（只改头重部署）
 *   都需要同一份内容。之前两处各写一遍，改 CSP 时漏改一处就会线上挂掉
 *   —— 实际发生过：第一次 CSP 白名单只写了 orbital.pages.dev，
 *   而实际 hub 域名是 mx-orbital.pages.dev，线上 iframe 全被拦。
 *
 * ## 2026-10-21 扩展：宿主来源成了「两处消费、必须同源」的事
 *
 * 同一份「谁可以嵌我」的清单现在被**两种完全不同的语法**消费：
 *
 *   1. `Content-Security-Policy: frame-ancestors`（浏览器执行）—— 用 `'self'`
 *      与完整 origin，通配写 `https://*.x`；
 *   2. SDK 的 `allowedOrigins`（微站自己执行）—— 语法见
 *      `packages/matrix-sdk/src/security/origin.ts`：通配必须写成 `*.x`
 *      （**不能**带 `https://` 前缀，否则会被当成「主机名里含星号的精确
 *      origin」，永远不匹配）。
 *
 * 这两种语法**不能互抄**：把 CSP 的 `https://*.x` 直接丢给 SDK，它会被
 * `parseOrigin()` 解析成一个名为 `*.x` 的主机，于是白名单「看起来配了」但
 * 一条都不放行 —— 正是本轮线上 MatrixID 恒 offline 的同类故障模式。
 *
 * 所以这里把清单存成**结构化条目**（一个 csp 写法 + 一个 sdk 写法），
 * 两种渲染都从同一份派生。改一处，两边同时生效。
 */

/**
 * 宿主来源清单（唯一事实源）。
 *
 * `csp`：写进 `frame-ancestors` 的形式。
 * `sdk`：写进 SDK `allowedOrigins` 的形式（OriginAllowList 语法）。
 *
 * 两类都要覆盖：
 *   1. 线上 hub（生产域名 + 预览子域通配）
 *   2. 自主域名 / 历史命名 / 未来自定义域名
 *   3. 本地开发
 *
 * ⚠️ 改 Pages 项目名前缀时必须同步改这里，否则 iframe 被 CSP 拦、或微站
 *    握不上手（SDK 白名单不认）。验证方式：
 *    `curl -sI https://mx-<appId>.pages.dev | grep -i content-security`
 */
const HUB_ORIGINS = [
  // ── 生产：自有域名（2026-10-21 账号迁移后）────────────────────────────
  { csp: 'https://matrixos.cc.cd', sdk: 'https://matrixos.cc.cd' },
  { csp: 'https://www.matrixos.cc.cd', sdk: 'https://www.matrixos.cc.cd' },
  // 微站与 hub 的预览部署都在 mx-<appId>.matrixos.cc.cd 下
  { csp: 'https://*.matrixos.cc.cd', sdk: '*.matrixos.cc.cd' },

  // ── 新账号 hub 的 pages.dev 入口 ───────────────────────────────────
  // 新账号建同名项目时 Cloudflare 会自动改名加 hash（mx-orbital-c6y），
  // hash 不可预测，所以必须显式列出，不做任何 `*.pages.dev` 泛匹配。
  { csp: 'https://mx-orbital-c6y.pages.dev', sdk: 'https://mx-orbital-c6y.pages.dev' },
  // hub 的预览部署：每次 commit 一个 <hash>.mx-orbital-c6y.pages.dev
  { csp: 'https://*.mx-orbital-c6y.pages.dev', sdk: '*.mx-orbital-c6y.pages.dev' },

  // ── 旧账号域名（回滚兼容）──────────────────────────────────────────
  // 旧项目保留未删，仍可访问，仅用于回滚验证；不是生产入口。
  { csp: 'https://mx-orbital.pages.dev', sdk: 'https://mx-orbital.pages.dev' },
  { csp: 'https://*.mx-orbital.pages.dev', sdk: '*.mx-orbital.pages.dev' },

  /*
   * ── 已删除的条目（2026-10-21 安全清理）─────────────────────────────
   *
   * 以下三条曾被当作「历史/兼容」留着，实测都不属于本项目，已移除：
   *
   *   https://orbital.pages.dev
   *     第三方站点（title="Orbital Trails"，HTTP 200）。
   *     本项目从未部署在裸 `orbital` 项目名上 —— 它只是当年第一次写
   *     CSP 白名单时写错的域名（见本文件顶部「实际发生过」那段）。
   *     把它列进白名单，等于允许一个陌生站点给微站投递伪造的
   *     `mx_idt` / 虫洞信封，并让它被当作合法宿主。
   *
   *   https://orbital-hub.pages.dev
   *     不属于本项目（实测 302），且从未在矩阵里使用过。
   *
   *   https://orbital.matrixos.edu
   *     已废弃的愿景域名，实测 NXDOMAIN。放开一个解析不到的主机没有收益，
   *     反而在将来该域被他人注册时成为现实风险。
   *
   * 教训：CSP `frame-ancestors` 与 SDK `allowedOrigins` 是**信任声明**，
   *      不是 URL 注释。任何一条都要能回答「这个 origin 现在真的属于我吗」。
   *      验证方式：`curl -s https://<host>/ | grep <本站特征词>`，或用
   *      `npm run verify:prod` 的 canonical 项交叉确认归属。
   */

  // ── 本地开发 ───────────────────────────────────────────────────────
  { csp: 'http://localhost:3000', sdk: 'http://localhost:3000' },
  { csp: 'http://127.0.0.1:3000', sdk: 'http://127.0.0.1:3000' },
];

/**
 * CSP `frame-ancestors` 的取值。
 *
 * `'self'` 只出现在 CSP 里：它表示「同源页面可以嵌我」，而 SDK 白名单是
 * 「哪些宿主 origin 可以跟我说话」，两者语义不同，不能合并成一条。
 */
const FRAME_ANCESTORS = ["'self'", ...HUB_ORIGINS.map((entry) => entry.csp)].join(' ');

/**
 * 注入微站的宿主 origin 清单（逗号分隔），由构建脚本写进
 * `NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS`，微站 `sdk-facade` 构造 SDK 时消费。
 *
 * 为什么走**构建期注入**而不是运行时去问：
 *   微站是静态站，没有后端路由可以回答「我信谁」；把清单编进产物，
 *   就等于把「谁能嵌我」这件事固化在部署单元里，与 `_headers` 天然一致。
 */
const HUB_ORIGINS_FOR_SDK = HUB_ORIGINS.map((entry) => entry.sdk).join(',');

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

export { FRAME_ANCESTORS, HUB_ORIGINS, HUB_ORIGINS_FOR_SDK };
