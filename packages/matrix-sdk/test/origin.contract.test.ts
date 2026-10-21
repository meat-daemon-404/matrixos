/**
 * OriginAllowList 契约测试。
 *
 * 为什么单独建文件：
 *   `security/origin.ts` 是 MatrixOS 的**信任边界**——它决定哪些 origin
 *   可以给微站投递 `mx_idt` 与虫洞信封。此前它没有任何直接测试，
 *   只在 `resize.test.ts` 里被当作夹具顺带用过；而历史上恰恰因为
 *   「白名单写错域名」出过两次事故：
 *
 *     1. CSP frame-ancestors 只写了 `orbital.pages.dev`（写错的域名），
 *        实际 hub 是 `mx-orbital.pages.dev` → 线上 iframe 全被拦。
 *     2. 清理时发现 `orbital.pages.dev` 其实是**第三方站点**
 *        （title="Orbital Trails"），却长期挂在信任白名单里。
 *
 *   这两次的共同点是「靠人读代码看不出错」，所以需要机器断言。
 *
 * 本文件锁定的契约：
 *   - 官方默认值的语义（只声明官方域，不声明当前部署域名）
 *   - 通配 `*.<suffix>` 不匹配 apex、不匹配 `evil-<suffix>`、不匹配后缀欺骗
 *   - 非法条目不产生「意外放行」
 *   - 显式白名单会关掉 loopback 自动放行
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OriginAllowList,
  DEFAULT_ALLOWED_ORIGINS,
  parseOrigin,
} from '../src/security/origin.ts';

/* ── 默认值语义 ── */

test('默认白名单只声明官方域，不含任何具体部署域名', () => {
  assert.deepEqual([...DEFAULT_ALLOWED_ORIGINS], ['*.matrixos.edu', 'matrixos.edu']);
});

test('默认白名单不包含已废弃的具体主机名', () => {
  /*
   * 历史包袱：默认值曾显式列出 'https://orbital.matrixos.edu'。
   * 该主机实测 NXDOMAIN，且已被 '*.matrixos.edu' 完整覆盖，属纯冗余。
   * 断言它不再出现，避免有人「照着旧代码加回去」。
   */
  for (const entry of DEFAULT_ALLOWED_ORIGINS) {
    assert.ok(
      !entry.includes('orbital.matrixos.edu'),
      `默认白名单不应含已废弃主机，实际含: ${entry}`,
    );
  }
});

test('默认白名单覆盖官方域的子域与 apex', () => {
  const allow = new OriginAllowList(DEFAULT_ALLOWED_ORIGINS);
  assert.equal(allow.allows('https://gpa.matrixos.edu'), true, '一级子域应放行');
  assert.equal(allow.allows('https://orbital.matrixos.edu'), true, '子域应放行（由通配覆盖）');
  assert.equal(allow.allows('https://a.b.matrixos.edu'), true, '多级子域应放行');
  assert.equal(allow.allows('https://matrixos.edu'), true, 'apex 应放行（显式列出）');
});

test('默认白名单不放行非官方域', () => {
  const allow = new OriginAllowList(DEFAULT_ALLOWED_ORIGINS);
  assert.equal(allow.allows('https://evil.com'), false);
  assert.equal(allow.allows('https://matrixos.edu.evil.com'), false, '后缀欺骗必须拒');
  assert.equal(allow.allows('https://evil-matrixos.edu'), false, '前缀粘连必须拒');
});

/* ── 通配语义 ── */

test('通配 *.a.com 不匹配 apex a.com', () => {
  const allow = new OriginAllowList(['*.a.com'], { allowLoopback: false });
  assert.equal(allow.allows('https://sub.a.com'), true);
  assert.equal(allow.allows('https://a.com'), false, '通配不应匹配 apex');
});

test('通配拒绝过宽条目与带路径条目', () => {
  // '*.edu' 只剩一个点前的空串 → 应被拒（避免放行所有 .edu）
  const wide = new OriginAllowList(['*.edu'], { allowLoopback: false });
  assert.equal(wide.isEmpty, true, '*.edu 属过宽条目，应被忽略');

  // 带路径不是合法 origin 写法
  const withPath = new OriginAllowList(['*.a.com/path'], { allowLoopback: false });
  assert.equal(withPath.isEmpty, true, '带路径的条目应被忽略');

  // 危险的通配写法：'*a.com' 会匹配 evil-a.com
  const dangerous = new OriginAllowList(['*a.com'], { allowLoopback: false });
  assert.equal(dangerous.allows('https://evil-a.com'), false, '*a.com 这种写法不得放行');
});

/* ── loopback 策略 ── */

test('loopback 默认按生产处理：不放行（fail-closed）', () => {
  /*
   * 实现见 defaultLoopbackPolicy()：拿不到 NODE_ENV 时**按生产处理**，
   * 即不放行 loopback。这是刻意的 fail-closed —— 忘记配置的后果是
   * 「本地连不上」，而不是「线上意外放行 localhost」。
   */
  const prev = process.env.NODE_ENV;
  try {
    delete process.env.NODE_ENV;
    const inProd = new OriginAllowList(['https://a.com']);
    assert.equal(inProd.allows('http://localhost:3000'), false, '无 NODE_ENV 时应按生产、不放行 loopback');

    process.env.NODE_ENV = 'production';
    const prod = new OriginAllowList(['https://a.com']);
    assert.equal(prod.allows('http://localhost:3000'), false, 'production 下不应放行 loopback');

    process.env.NODE_ENV = 'development';
    const dev = new OriginAllowList(['https://a.com']);
    assert.equal(dev.allows('http://localhost:3000'), true, 'development 下应放行 loopback（本地联调需要）');

    const forced = new OriginAllowList(['https://a.com'], { allowLoopback: false });
    assert.equal(forced.allows('http://localhost:3000'), false, '显式 false 应覆盖环境判断');
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

/* ── parseOrigin ── */

test('parseOrigin 拒绝非法值而不是当成放行', () => {
  for (const bad of ['', '   ', 'not-a-url', 'null', 'javascript:alert(1)']) {
    assert.equal(parseOrigin(bad), null, `${JSON.stringify(bad)} 应解析失败`);
  }
});

test('parseOrigin 正确归一化主机名大小写', () => {
  const p = parseOrigin('https://GPA.MatrixOS.edu');
  assert.ok(p);
  assert.equal(p.hostname, 'gpa.matrixos.edu');
  assert.equal(p.port, '');
});

/* ── 与生产拓扑的交叉验证 ── */

test('当前生产域名不在 SDK 默认白名单里（必须由使用方显式传入）', () => {
  /*
   * 这是刻意的 fail-closed 设计：SDK 默认只认官方域 matrixos.edu（愿景域），
   * 不硬编码 matrixos.cc.cd。使用方若忘记传 allowedOrigins，
   * 结果是**不放行**（握手失败），而不是「意外放行陌生 origin」。
   *
   * 18 个微站都由 scripts/build-static-site.mjs 注入
   * NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS 并显式传给 SDK，见 sdk-facade.ts。
   */
  const allow = new OriginAllowList(DEFAULT_ALLOWED_ORIGINS);
  assert.equal(allow.allows('https://matrixos.cc.cd'), false);
  assert.equal(allow.allows('https://mx-gpa.matrixos.cc.cd'), false);
});
