/**
 * panel-overflow 单测（零依赖 node:test）。
 *
 * 为什么这几条边界必须逐一钉死：面板溢出提示是**用户唯一能看见「内容被裁了」的
 * 地方**。它的判断错一个方向都是真事故 ——
 *   - 该显示却没显示 = 静默降级，正是 ADR-09 明令禁止的，也是本轮要修的那个
 *     「966px 永远不可达却没人知道」；
 *   - 不该显示却显示了 = 每个装得下的面板底部多一条黄条，属于制造噪音，
 *     团队会很快学会忽略它，于是真出问题时也没人看。
 * 所以「恰好装得下」「差 1px」「到上限」这三种贴边情形必须各有断言。
 *
 * `bridge-gap` 的两条分支也要分开测：`connected=false`（握手失败）与
 * `connected=true`（握上手了但微站不上报）指向完全不同的修复方向，
 * 文案一旦合并，排障时就得重新回读代码。
 *
 * 跑法：node --test src/lib/panel-overflow.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_BRIDGE_GRACE_MS,
  describePanelBridgeGap,
  describePanelNotice,
  describePanelOverflow,
} from './panel-overflow.ts';

/*
 * 上限用**协议侧的真常量**，不在测试里写死 3000。
 *
 * 为什么测试里可以 import、而 `panel-overflow.ts` 里不行：`panel-resize.ts`
 * 本身零站内 import（自包含），所以 `node --test` 的类型剥离能直接加载它；
 * `panel-overflow.ts` 一旦 import 它就变成非自包含，会被这条 loader 判红。
 * 详见 `panel-overflow.ts` 文件头「为什么本文件零 import」。
 *
 * 顺带的好处：这里引用真常量，协议上限哪天改了，测试自动跟着新值跑，
 * 不会出现「代码改了、测试还在断言旧数字」的假绿。
 */
import { MAX_IFRAME_HEIGHT_PX } from './panel-resize.ts';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 首帧事实：全零。
 *
 * 必须与 `use-panel-resize.ts` 的 `EMPTY_PANEL_RESIZE_STATE` 同形 —— SSR 与
 * CSR 首帧都拿这份值渲染，所以它必须得到「不可见」，否则两端文本会不一致
 * （仓库踩过的 React #418）。
 */
const ZERO_OVERFLOW = Object.freeze({
  scrollRange: 0,
  contentHeight: 0,
  availableHeight: 0,
  iframeHeight: 0,
  maxHeightPx: MAX_IFRAME_HEIGHT_PX,
  frozen: false,
});

/** 线上实测的那一组数字：面板 627，内容 1593（差 966 不可达）。 */
const LIVE_HUB_FACTS = Object.freeze({
  scrollRange: 966,
  contentHeight: 1593,
  availableHeight: 627,
  iframeHeight: 1593,
  maxHeightPx: MAX_IFRAME_HEIGHT_PX,
  frozen: false,
});

/* ------------------------------------------------------------------ */
/* 溢出：三条贴边边界                                                  */
/* ------------------------------------------------------------------ */

test('首帧全零事实 → 不可见（SSR/CSR 文本一致的前提）', () => {
  const notice = describePanelOverflow(ZERO_OVERFLOW);
  assert.equal(notice.visible, false);
  assert.equal(notice.kind, 'none');
  assert.equal(notice.text, '', '不可见态必须是空串，不能有占位文案');
  assert.equal(notice.action, '');
});

test('scrollRange = 0（恰好装得下）→ 不提示，且不撒谎说「可滚动」', () => {
  // 内容 <= 可用高时 decidePanelResize 给的 iframeHeight = 可用高，两者相等。
  const notice = describePanelOverflow({
    scrollRange: 0,
    contentHeight: 627,
    availableHeight: 627,
    iframeHeight: 627,
    maxHeightPx: MAX_IFRAME_HEIGHT_PX,
  });
  assert.equal(notice.visible, false, '没有东西被藏起来，就不该出现提示');
});

test('scrollRange 只差 1px（内容比可用高大 1px）→ 出现，且数字如实', () => {
  const notice = describePanelOverflow({
    scrollRange: 1,
    contentHeight: 628,
    availableHeight: 627,
    iframeHeight: 628,
  });
  assert.equal(notice.visible, true);
  assert.equal(notice.kind, 'overflow');
  assert.match(notice.text, /可滚动/);
  assert.match(notice.detail, /内容 628px/);
  assert.match(notice.detail, /面板 627px/);
  assert.match(notice.detail, /可滚动 1px/);
});

test('线上实测 627 / 1593：差 966px 必须被说出来', () => {
  const notice = describePanelOverflow(LIVE_HUB_FACTS);
  assert.equal(notice.visible, true);
  assert.equal(notice.kind, 'overflow');
  assert.match(notice.detail, /可滚动 966px/);
  // 出口必须给「全屏」：那是唯一能看全 1593px 的路径。
  assert.match(notice.action, /全屏/);
  assert.doesNotMatch(notice.text, /上限/, '没到协议上限时不该说「已到上限」');
});

test('超过上限（内容 > 协议上限）→ 明说「只能全屏看」', () => {
  // 收侧 clamp：iframeHeight 停在协议上限，内容仍比它高。
  const notice = describePanelOverflow({
    scrollRange: 1200,
    contentHeight: MAX_IFRAME_HEIGHT_PX + 1200,
    availableHeight: 627,
    iframeHeight: MAX_IFRAME_HEIGHT_PX,
    maxHeightPx: MAX_IFRAME_HEIGHT_PX,
    frozen: true,
  });
  assert.equal(notice.visible, true);
  assert.match(notice.text, /上限/, '到上限时必须显式声明，不能让用户以为滚到底就完了');
  assert.match(
    notice.detail,
    new RegExp(String(MAX_IFRAME_HEIGHT_PX) + 'px'),
    '上限值必须写进 detail，排障时要知道撞的是哪个数',
  );
  assert.match(notice.detail, /只能全屏/, '撞上限那部分连 hub 侧滚动都到不了，必须说清楚');
  assert.match(notice.detail, /熔断/, 'frozen 是排障关键信息，必须进 detail');
});

test('熔断（frozen）但没撞上限 → 说熔断，绝不能说「已到上限」', () => {
  // iframe 停在半路 1200px（被熔断），内容 1593 仍比它高。
  const notice = describePanelOverflow({
    scrollRange: 573,
    contentHeight: 1593,
    availableHeight: 627,
    iframeHeight: 1200,
    maxHeightPx: MAX_IFRAME_HEIGHT_PX,
    frozen: true,
  });
  assert.match(notice.text, /可滚动/);
  assert.doesNotMatch(notice.text, /上限/, '只涨到 1200 不是撞上限，混为一谈会误导排障');
  assert.doesNotMatch(notice.detail, /只能全屏/, '熔断时剩下的量靠 hub 滚动仍可达，别说死');
  assert.match(notice.detail, /熔断/);
  assert.match(notice.detail, /1200px/, '熔断停在哪个高度必须写出来');
});

test('上限可覆盖（调用方从 panel-resize 传入，测试可造任意上限）', () => {
  const notice = describePanelOverflow({
    scrollRange: 100,
    contentHeight: 900,
    availableHeight: 700,
    iframeHeight: 800,
    maxHeightPx: 800,
  });
  assert.match(notice.detail, /上限 800px/);
});

test('上限是脏值 → 不做「撞上限」判断，绝不拿 NaN 比出假结论', () => {
  for (const bad of [0, -1, Number.NaN]) {
    const notice = describePanelOverflow({
      scrollRange: 100,
      contentHeight: 900,
      availableHeight: 700,
      iframeHeight: 800,
      maxHeightPx: bad,
    });
    assert.equal(notice.visible, true, '溢出本身仍要说');
    assert.doesNotMatch(notice.text, /上限/, `maxHeightPx=${String(bad)} 时不该断言「已到上限」`);
  }
});

test('脏输入不炸：NaN / Infinity / 负数一律按 0 处理', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const notice = describePanelOverflow({
      scrollRange: bad,
      contentHeight: 100,
      availableHeight: 50,
      maxHeightPx: MAX_IFRAME_HEIGHT_PX,
    });
    assert.equal(notice.visible, false, `scrollRange=${String(bad)} 应视为「没有溢出」`);
  }
  // scrollRange 正常、但高度字段是脏的：仍然要提示，只是不报那些数字。
  const partial = describePanelOverflow({
    scrollRange: 100,
    contentHeight: Number.NaN,
    availableHeight: Number.NaN,
    iframeHeight: Number.NaN,
    maxHeightPx: MAX_IFRAME_HEIGHT_PX,
  });
  assert.equal(partial.visible, true);
  assert.match(partial.detail, /可滚动 100px/);
  assert.doesNotMatch(partial.detail, /NaN/, '坏数值不能变成 "内容 NaNpx"');
});

test('小数被取整（CSS 像素整数化，避免提示里出现 966.4px 这种噪音）', () => {
  const notice = describePanelOverflow({
    scrollRange: 966.4,
    contentHeight: 1593.6,
    availableHeight: 627,
    iframeHeight: 1594,
    maxHeightPx: MAX_IFRAME_HEIGHT_PX,
  });
  assert.match(notice.detail, /可滚动 966px/);
  assert.match(notice.detail, /内容 1594px/);
});

/* ------------------------------------------------------------------ */
/* 桥：宽限期内静默，超时才说；两种故障分开                            */
/* ------------------------------------------------------------------ */

test('宽限期内（刚 load 的几百毫秒）→ 不提示，避免狼来了', () => {
  const notice = describePanelBridgeGap({
    connected: false,
    hasReport: false,
    elapsedMs: PANEL_BRIDGE_GRACE_MS - 1,
  });
  assert.equal(notice.visible, false, '子站建桥要时间，立刻报警会让提示变得不可信');
});

test('到宽限期（恰好等于阈值）→ 开始提示', () => {
  const notice = describePanelBridgeGap({
    connected: false,
    hasReport: false,
    elapsedMs: PANEL_BRIDGE_GRACE_MS,
  });
  assert.equal(notice.visible, true);
  assert.equal(notice.kind, 'bridge-gap');
  assert.match(notice.text, /未接通/);
});

test('握手失败 vs 握手成功但不上报：文案必须能区分', () => {
  const notConnected = describePanelBridgeGap({ connected: false, hasReport: false, elapsedMs: 9000 });
  const noReport = describePanelBridgeGap({ connected: true, hasReport: false, elapsedMs: 9000 });
  assert.match(notConnected.detail, /未完成握手/);
  assert.match(noReport.detail, /已连通/);
  assert.notEqual(notConnected.text, noReport.text, '两种故障的修法不同，标题也必须不同');
  // 两种都不许伪造「已连上」：未握手那条的文案里不能出现「已连通」。
  assert.doesNotMatch(notConnected.text + notConnected.detail, /宿主桥已连通/);
});

test('已有上报 → 不谈 bridge-gap（那不是故障态）', () => {
  const notice = describePanelBridgeGap({ connected: true, hasReport: true, elapsedMs: 60_000 });
  assert.equal(notice.visible, false);
});

test('elapsedMs 是脏值（负数 / NaN）→ 不提示，绝不猜一个等待时长', () => {
  for (const bad of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    const notice = describePanelBridgeGap({ connected: false, hasReport: false, elapsedMs: bad });
    assert.equal(notice.visible, false, `elapsedMs=${String(bad)} 不该产出提示`);
  }
});

test('graceMs 可覆盖（供组件按环境收紧/放宽）', () => {
  const notice = describePanelBridgeGap({
    connected: false,
    hasReport: false,
    elapsedMs: 2000,
    graceMs: 1000,
  });
  assert.equal(notice.visible, true);
});

/* ------------------------------------------------------------------ */
/* 总入口：优先级                                                      */
/* ------------------------------------------------------------------ */

test('总入口：有实测溢出时以实报为准，不被 bridge-gap 顶掉', () => {
  const notice = describePanelNotice({
    overflow: LIVE_HUB_FACTS,
    // 防御性输入：同时给了「没上报」的桥事实（正常流程下不会同时成立）。
    bridge: { connected: false, hasReport: false, elapsedMs: 30_000 },
  });
  assert.equal(notice.kind, 'overflow', '有真实数字就该报数字，它比「没上报」信息量大');
  assert.match(notice.detail, /可滚动 966px/);
});

test('总入口：bridge 为 null（非 live / 未就绪）时只谈溢出', () => {
  assert.equal(describePanelNotice({ overflow: ZERO_OVERFLOW, bridge: null }).visible, false);
  assert.equal(
    describePanelNotice({ overflow: ZERO_OVERFLOW }).visible,
    false,
    'bridge 省略与 null 等价：都不该凭空报警',
  );
  const overflowing = describePanelNotice({ overflow: LIVE_HUB_FACTS, bridge: null });
  assert.equal(overflowing.kind, 'overflow');
});

test('总入口：装得下 + 桥没连上 → 落到 bridge-gap（这才是线上 966 不可达的那一态）', () => {
  // 没有任何上报 ⇒ scrollRange 恒为 0 ⇒ 只能靠桥的状态把「裁切」说出来。
  const notice = describePanelNotice({
    overflow: ZERO_OVERFLOW,
    bridge: { connected: false, hasReport: false, elapsedMs: 8000 },
  });
  assert.equal(notice.kind, 'bridge-gap');
  assert.equal(notice.visible, true);
});

test('detail 永远非空（title 是排障唯一入口，不能是空串）', () => {
  const samples = [
    describePanelOverflow(LIVE_HUB_FACTS),
    describePanelBridgeGap({ connected: false, hasReport: false, elapsedMs: 6000 }),
    describePanelBridgeGap({ connected: true, hasReport: false, elapsedMs: 6000 }),
  ];
  for (const notice of samples) {
    assert.equal(notice.visible, true);
    assert.ok(notice.detail.length > 0, '可见态的 detail 不能为空');
    assert.ok(notice.text.length > 0, '可见态的 text 不能为空');
    assert.ok(notice.action.length > 0, '可见态必须给出「全屏」出口');
  }
});
