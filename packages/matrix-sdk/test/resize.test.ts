/**
 * `layout.resize` 单测（零依赖 node:test，不碰真 DOM）。
 *
 * 覆盖四类必须证明的东西：
 *   1. **测量学** —— 矮内容站（08-lab-kanban 型）不能被视口高污染；
 *   2. **防自激** —— 阈值 / 静默窗 / 增长连击熔断三层各自生效，且总数收敛；
 *   3. **降级** —— 宿主不声明 `layout.resize` 时一条都不发；
 *   4. **origin 负样本** —— 伪造 origin 的 `layout.resize` 被桥丢弃（验收项 5）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  measureContentHeight,
  measureViewportHeight,
  createAutoResizeReporter,
  isLayoutResizePayload,
  RESIZE_THRESHOLD_PX,
  RESIZE_QUIET_MS,
  type LayoutResizePayload,
} from '../src/iframe/resize.ts';
import { createHostBridge, BRIDGE_CAPABILITIES, BRIDGE_MSG } from '../src/iframe/bridge.ts';
import { OriginAllowList } from '../src/security/origin.ts';
import type { BridgeMeta, HostBridge, MessageListener, WindowLike } from '../src/types.ts';
import type { ResizeElementLike } from '../src/iframe/resize.ts';

/* ────────────────────────────── 假 DOM ────────────────────────────── */

/**
 * 造一个「body 有若干子元素」的假文档。
 *
 * `children` 里每项给 `top/bottom`（相对视口）与可选 `scrollHeight`，
 * 就是 `measureContentHeight` 真正读的东西。
 */
interface FakeChild {
  readonly top?: number;
  readonly bottom?: number;
  readonly height?: number;
  readonly scrollHeight?: number;
  readonly clientHeight?: number;
}

interface FakeDocOptions {
  readonly docScrollHeight?: number;
  readonly docClientHeight?: number;
  readonly bodyScrollHeight?: number;
  readonly bodyHeight?: number;
  readonly children?: readonly FakeChild[];
}

function fakeDoc(opts: FakeDocOptions) {
  const bodyTop = 0;
  const children = (opts.children ?? []).map((c) => ({
    getBoundingClientRect: () => ({
      top: bodyTop + (c.top ?? 0),
      bottom: bodyTop + (c.bottom ?? 0),
      height: c.height,
    }),
    ...(c.scrollHeight === undefined ? {} : { scrollHeight: c.scrollHeight, clientHeight: c.clientHeight ?? 0 }),
  }));
  return {
    documentElement: { scrollHeight: opts.docScrollHeight ?? 0, clientHeight: opts.docClientHeight ?? 0 },
    body: {
      scrollHeight: opts.bodyScrollHeight ?? 0,
      getBoundingClientRect: () => ({ top: bodyTop, height: opts.bodyHeight ?? 0 }),
      children,
    },
  };
}

const noStyle = () => null;

/* ─────────────────────── 1. 测量学 ─────────────────────── */

test('测量：矮内容站不被视口高污染（08-lab-kanban 型）', () => {
  /*
   * 这是 Lead 实测出的陷阱：内容 433，但 body.scrollHeight = 626（=视口）。
   * 若实现里做 max(body.scrollHeight, 子元素底边) 就会得到 626。
   */
  const doc = fakeDoc({
    docScrollHeight: 626, // 被 html{height:100%} 压平
    docClientHeight: 626,
    bodyScrollHeight: 626, // 被视口撑到 626，虚高
    children: [{ bottom: 443, height: 443 }],
  });
  assert.equal(measureContentHeight(doc, noStyle), 443, '必须报 443，不能是 626');
});

test('测量：超框站报真实内容高（01-gpa 型）', () => {
  const doc = fakeDoc({
    docScrollHeight: 626,
    docClientHeight: 626,
    bodyScrollHeight: 965,
    children: [{ bottom: 965, height: 965 }],
  });
  assert.equal(measureContentHeight(doc, noStyle), 965);
});

test('测量：取最后一个子元素的底边（多子元素）', () => {
  const doc = fakeDoc({
    children: [
      { bottom: 100, height: 100 },
      { bottom: 443, height: 343 },
      { bottom: 200, height: 100 },
    ],
  });
  assert.equal(measureContentHeight(doc, noStyle), 443);
});

test('测量：跳过零高元素（已折叠的区块）', () => {
  const doc = fakeDoc({
    children: [
      { bottom: 300, height: 300 },
      { bottom: 0, height: 0 }, // 被 display:none 折叠
    ],
  });
  assert.equal(measureContentHeight(doc, noStyle), 300);
});

test('测量：跳过 position:fixed 的浮层', () => {
  const doc = fakeDoc({
    children: [
      { bottom: 500, height: 500 },
      { bottom: 5000, height: 5000 }, // 固定浮层，不该计入
    ],
  });
  const readStyle = (el: ResizeElementLike) =>
    el === doc.body.children[1] ? { position: 'fixed' } : { position: 'static' };
  assert.equal(measureContentHeight(doc, readStyle), 500);
});

test('测量：子元素自身溢出时把溢出量算进去', () => {
  /*
   * 一个 height:600 但内部内容 900 的容器：rect.bottom=600，scrollHeight=900。
   * 真正的底边在 900。这里用「元素顶(0) + scrollHeight(900)」而不是拿 scrollHeight 当高度
   * ——后者对 height:100% 的包裹层会等于视口高。
   */
  const doc = fakeDoc({
    children: [{ top: 0, bottom: 600, height: 600, scrollHeight: 900, clientHeight: 600 }],
  });
  assert.equal(measureContentHeight(doc, noStyle), 900);
});

test('测量：完全没有可量子元素时才退回 scrollHeight', () => {
  const doc = fakeDoc({ docScrollHeight: 777, docClientHeight: 626, children: [] });
  assert.equal(measureContentHeight(doc, noStyle), 777);
});

test('测量：测不出来返回 0（调用方据此跳过上报，不能发 0 给 hub）', () => {
  assert.equal(measureContentHeight(null, noStyle), 0);
  assert.equal(measureContentHeight(fakeDoc({ children: [{ bottom: 0, height: 0 }] }), noStyle), 0);
});

test('测量：视口高读 documentElement.clientHeight', () => {
  assert.equal(measureViewportHeight({ documentElement: { clientHeight: 626 }, body: {} }), 626);
  assert.equal(measureViewportHeight(null), 0);
});

/* ─────────────────────── 2. 假桥 / 假调度 ─────────────────────── */

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly cb: () => void;
}

function makeScheduler(startMs = 1_700_000_000_000) {
  let now = startMs;
  const timers: FakeTimer[] = [];
  let seq = 0;
  return {
    now: () => now,
    setTimeout: (cb: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, cb });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      const index = timers.findIndex((t) => t.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    /** 推进虚拟时间并触发到期定时器。 */
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        due.cb();
      }
    },
  };
}

/** 最小假桥：记录发出的消息，可控制「对端声明了哪些能力」。 */
function makeFakeBridge(peerCaps: readonly string[]): HostBridge & {
  readonly sent: Array<{ readonly type: string; readonly payload: unknown }>;
  emit(type: string, payload: unknown): void;
} {
  type Handler = (payload: unknown, meta: BridgeMeta) => void;
  const sent: Array<{ readonly type: string; readonly payload: unknown }> = [];
  let handlers = new Map<string, Set<Handler>>();
  return {
    role: 'tenant',
    connected: true,
    protocolVersion: 1,
    embedded: true,
    peerCapabilities: peerCaps,
    sent,
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
      return () => {
        handlers.get(event)?.delete(handler);
      };
    },
    post(type: string, payload?: unknown) {
      sent.push({ type, payload });
    },
    request() {
      return Promise.reject(new Error('not used'));
    },
    handshake() {
      return Promise.resolve();
    },
    close() {
      handlers = new Map();
    },
    /** 测试用：模拟对端发来一条消息。 */
    emit(type: string, payload: unknown) {
      for (const handler of handlers.get(type) ?? []) {
        handler(payload, { origin: 'x', source: 'host', message: { ch: 'matrixos/bridge', v: 1, type } });
      }
    },
  };
}

/** 造一个可变的假文档，供「内容变化 → 再测量」测试。 */
function mutableDoc(initialHeight: number) {
  const state = { height: initialHeight, viewport: 626 };
  return {
    state,
    doc: {
      get documentElement() {
        return { scrollHeight: state.viewport, clientHeight: state.viewport };
      },
      get body() {
        return {
          scrollHeight: Math.max(state.height, state.viewport),
          getBoundingClientRect: () => ({ top: 0, height: state.viewport }),
          children: [
            {
              getBoundingClientRect: () => ({ top: 0, bottom: state.height, height: state.height }),
            },
          ],
        };
      },
    },
  };
}

/** 取第 n 条已上报的载荷（已收窄成 LayoutResizePayload，测试里省掉重复断言）。 */
function sentPayload(bridge: ReturnType<typeof makeFakeBridge>, index: number): LayoutResizePayload {
  const entry = bridge.sent[index];
  assert.ok(entry !== undefined, `第 ${index} 条消息不存在（共 ${bridge.sent.length} 条）`);
  return entry.payload as LayoutResizePayload;
}

/* ─────────────────────── 3. 防自激 ─────────────────────── */

test('防自激：相同高度不重复上报（阈值）', () => {
  const bridge = makeFakeBridge(['layout.resize']);
  const { doc, state } = mutableDoc(955);
  const scheduler = makeScheduler();
  const reporter = createAutoResizeReporter({
    bridge,
    appId: 'test',
    doc,
    win: { parent: {} }, // 假装在 iframe 里
    scheduler,
    createObserver: null,
  });

  return reporter.start().then(() => {
    assert.equal(bridge.sent.length, 1, '首次必须发 1 条');
    assert.equal(bridge.sent[0]?.type, BRIDGE_MSG.RESIZE);
    const first = sentPayload(bridge, 0);
    assert.equal(first.height, 955);
    assert.equal(first.viewport, 626);
    assert.equal(first.appId, 'test');

    // 同高度反复 check：一次都不该再发
    for (let i = 0; i < 10; i += 1) {
      scheduler.advance(RESIZE_QUIET_MS + 10);
      reporter.flush();
    }
    assert.equal(bridge.sent.length, 1, `同高度重复上报（实际 ${bridge.sent.length} 条）`);
    assert.ok(reporter.stats.skippedThreshold >= 1, '应记录阈值跳过');
    void state;
  });
});

test('防自激：变化小于阈值不发，大于阈值发一次', () => {
  const bridge = makeFakeBridge(['layout.resize']);
  const { doc, state } = mutableDoc(955);
  const scheduler = makeScheduler();
  const reporter = createAutoResizeReporter({
    bridge,
    appId: 'test',
    doc,
    win: { parent: {} },
    scheduler,
    createObserver: null,
  });

  return reporter.start().then(() => {
    assert.equal(bridge.sent.length, 1);

    // 差 1px（< 阈值 2px）：不发
    state.height = 956;
    scheduler.advance(RESIZE_QUIET_MS + 10);
    reporter.flush();
    assert.equal(bridge.sent.length, 1, '1px 抖动不该触发上报');

    // 差 6px：发
    state.height = 961;
    scheduler.advance(RESIZE_QUIET_MS + 10);
    reporter.flush();
    assert.equal(bridge.sent.length, 2, '真实变化应上报');
    assert.equal(sentPayload(bridge, 1).height, 961);
  });
});

test('防自激：静默窗内不测量（切断改高→回调→再发的同步环）', () => {
  const bridge = makeFakeBridge(['layout.resize']);
  const { doc, state } = mutableDoc(500);
  const scheduler = makeScheduler();
  const reporter = createAutoResizeReporter({
    bridge,
    appId: 'test',
    doc,
    win: { parent: {} },
    scheduler,
    createObserver: null,
  });

  return reporter.start().then(() => {
    assert.equal(bridge.sent.length, 1);
    // 刚发完就变化：静默窗内 check 应被吃掉
    state.height = 900;
    reporter.check();
    scheduler.advance(10); // debounce 还没到
    assert.equal(bridge.sent.length, 1, '静默窗内不该发');
  });
});

test('防自激：视口耦合型发散被增长连击熔断冻结（有限步停住）', () => {
  const bridge = makeFakeBridge(['layout.resize']);
  /*
   * 模拟最坏情况：内容高**永远比上次多 100**（视口耦合型）。
   * 没有熔断的话这就是无限循环。要求：有限步内停住。
   */
  const state = { height: 500, viewport: 500 };
  const doc = {
    get documentElement() {
      return { scrollHeight: state.viewport, clientHeight: state.viewport };
    },
    get body() {
      return {
        scrollHeight: state.height,
        getBoundingClientRect: () => ({ top: 0, height: state.viewport }),
        children: [{ getBoundingClientRect: () => ({ top: 0, bottom: state.height, height: state.height }) }],
      };
    },
  };
  const scheduler = makeScheduler();
  const reporter = createAutoResizeReporter({
    bridge,
    appId: 'test',
    doc,
    win: { parent: {} },
    scheduler,
    createObserver: null,
    maxGrowthStreak: 4,
  });

  return reporter.start().then(() => {
    // 每次「hub 撑高」后内容又变高 100px，循环推 40 轮
    for (let i = 0; i < 40; i += 1) {
      state.height += 100;
      state.viewport = state.height;
      scheduler.advance(RESIZE_QUIET_MS + 10);
      reporter.flush();
    }
    // 首次 1 条 + 增长连击上限内若干条，绝不能是 40
    assert.ok(bridge.sent.length <= 6, `发散必须被熔断，实际上报 ${bridge.sent.length} 条`);
    assert.equal(reporter.stats.frozen, true, '应标记 frozen');
  });
});

test('防自激：稳定场景总上报次数收敛到 1', () => {
  const bridge = makeFakeBridge(['layout.resize']);
  const { doc } = mutableDoc(955);
  const scheduler = makeScheduler();
  const reporter = createAutoResizeReporter({
    bridge,
    appId: 'test',
    doc,
    win: { parent: {} },
    scheduler,
    createObserver: null,
  });

  return reporter.start().then(() => {
    // 模拟「hub 撑高后 ResizeObserver 连发 20 次回调」
    for (let i = 0; i < 20; i += 1) {
      reporter.check();
      scheduler.advance(50);
    }
    assert.equal(reporter.stats.reports, 1, `稳定场景必须只报 1 次（实际 ${reporter.stats.reports}）`);
  });
});

/* ─────────────────────── 4. 降级 ─────────────────────── */

test('降级：宿主未声明 layout.resize 时一条都不发', () => {
  const bridge = makeFakeBridge(['sso.idt-issue']); // 老宿主：没有 layout.resize
  const { doc } = mutableDoc(955);
  const scheduler = makeScheduler();
  const reporter = createAutoResizeReporter({
    bridge,
    appId: 'test',
    doc,
    win: { parent: {} },
    scheduler,
    createObserver: null,
    handshakeAttempts: 1,
    handshakeTimeoutMs: 10,
  });

  return reporter.start().then(() => {
    assert.equal(bridge.sent.length, 0, '不支持就不该发');
    assert.equal(reporter.stats.degraded, true);
    assert.equal(reporter.stats.supported, false);
  });
});

test('降级：不在 iframe 内（顶层打开）时完全 no-op', () => {
  const bridge = makeFakeBridge(['layout.resize']);
  const { doc } = mutableDoc(955);
  const scheduler = makeScheduler();
  const reporter = createAutoResizeReporter({
    bridge,
    appId: 'test',
    doc,
    win: { parent: null }, // 顶层：parent 为空
    scheduler,
    createObserver: null,
  });

  return reporter.start().then(() => {
    assert.equal(bridge.sent.length, 0);
    assert.equal(reporter.stats.degraded, true);
  });
});

/* ─────────────────────── 5. 载荷校验 ─────────────────────── */

test('载荷：isLayoutResizePayload 拒绝非法值', () => {
  assert.equal(isLayoutResizePayload({ height: 955, viewport: 626 }), true);
  assert.equal(isLayoutResizePayload({ height: 955, viewport: 626, appId: 'gpa' }), true);
  // height 非法
  assert.equal(isLayoutResizePayload({ height: 0, viewport: 626 }), false);
  assert.equal(isLayoutResizePayload({ height: -1, viewport: 626 }), false);
  assert.equal(isLayoutResizePayload({ height: Number.NaN, viewport: 626 }), false);
  assert.equal(isLayoutResizePayload({ height: '955', viewport: 626 }), false);
  assert.equal(isLayoutResizePayload({ viewport: 626 }), false);
  // viewport 非法
  assert.equal(isLayoutResizePayload({ height: 955 }), false);
  // appId 类型非法
  assert.equal(isLayoutResizePayload({ height: 955, viewport: 626, appId: 1 }), false);
  // 非对象
  assert.equal(isLayoutResizePayload(null), false);
  assert.equal(isLayoutResizePayload('x'), false);
});

/* ─────────────────── 6. origin 负样本（验收项 5） ─────────────────── */

/**
 * 造一个假 window，用来驱动真实的 `createHostBridge`。
 * `emitMessage` 模拟外部调用 `window.dispatchEvent(new MessageEvent(...))`。
 */
function makeFakeWin(origin: string): WindowLike & { emit(data: unknown, eventOrigin: string): void } {
  const listeners = new Set<MessageListener>();
  return {
    location: { href: `${origin}/host`, origin, host: 'host', hostname: 'host', protocol: 'https:', search: '' },
    parent: null,
    top: null,
    opener: null,
    postMessage() {},
    addEventListener(type: 'message', listener: MessageListener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type: 'message', listener: MessageListener) {
      if (type === 'message') listeners.delete(listener);
    },
    sessionStorage: null,
    localStorage: null,
    navigator: null,
    setTimeout: () => 0,
    clearTimeout: () => {},
    /** 测试用：模拟收到一条消息。 */
    emit(data: unknown, eventOrigin: string) {
      for (const listener of [...listeners]) listener({ data, origin: eventOrigin, source: null });
    },
  };
}

test('origin 负样本：伪造 origin 的 layout.resize 被桥丢弃（验收项 5）', () => {
  const allowed = new OriginAllowList(['https://gpa.matrixos.edu'], { allowLoopback: false });
  const win = makeFakeWin('https://orbital.matrixos.edu');

  const bridge = createHostBridge({
    env: {
      hasDOM: true,
      win,
      doc: { cookie: '' },
      inIframe: false,
      origin: 'https://orbital.matrixos.edu',
      href: 'https://orbital.matrixos.edu/',
      fetchImpl: null,
      now: () => Date.now(),
      randomUUID: () => 'x',
    },
    allowedOrigins: allowed,
    role: 'host',
    tenantOrigin: 'https://gpa.matrixos.edu',
    capabilities: BRIDGE_CAPABILITIES,
  });

  const received = [];
  bridge.on(BRIDGE_MSG.RESIZE, (payload) => received.push(payload));

  const goodPayload = { height: 955, viewport: 626, appId: 'gpa' };

  // ① 合法 origin：应被接受
  win.emit(
    { ch: 'matrixos/bridge', v: 1, type: BRIDGE_MSG.RESIZE, payload: goodPayload },
    'https://gpa.matrixos.edu',
  );
  assert.equal(received.length, 1, '合法 origin 的消息必须被接受');

  // ② 伪造 origin（不在白名单）：必须被静默丢弃
  win.emit(
    { ch: 'matrixos/bridge', v: 1, type: BRIDGE_MSG.RESIZE, payload: { height: 9999, viewport: 626 } },
    'https://evil.example.com',
  );
  assert.equal(received.length, 1, '伪造 origin 的消息必须被丢弃');

  // ③ 同源但拼错的近似域名（evil-gpa.matrixos.edu 不能命中 gpa.matrixos.edu）
  win.emit(
    { ch: 'matrixos/bridge', v: 1, type: BRIDGE_MSG.RESIZE, payload: { height: 9999, viewport: 626 } },
    'https://evil-gpa.matrixos.edu',
  );
  assert.equal(received.length, 1, '近似域名不能被放行');

  // ④ origin 为空 / 'null'（sandbox iframe / data: URL）：必须被丢弃
  win.emit({ ch: 'matrixos/bridge', v: 1, type: BRIDGE_MSG.RESIZE, payload: goodPayload }, 'null');
  win.emit({ ch: 'matrixos/bridge', v: 1, type: BRIDGE_MSG.RESIZE, payload: goodPayload }, '');
  assert.equal(received.length, 1, "origin 'null' / 空串必须被丢弃");

  bridge.close();
});

test('origin 负样本：协议版本不匹配的 layout.resize 被丢弃', () => {
  const allowed = new OriginAllowList(['https://gpa.matrixos.edu'], { allowLoopback: false });
  const win = makeFakeWin('https://orbital.matrixos.edu');
  const bridge = createHostBridge({
    env: {
      hasDOM: true,
      win,
      doc: { cookie: '' },
      inIframe: false,
      origin: 'https://orbital.matrixos.edu',
      href: 'https://orbital.matrixos.edu/',
      fetchImpl: null,
      now: () => Date.now(),
      randomUUID: () => 'x',
    },
    allowedOrigins: allowed,
    role: 'host',
    tenantOrigin: 'https://gpa.matrixos.edu',
    capabilities: BRIDGE_CAPABILITIES,
  });
  const received = [];
  bridge.on(BRIDGE_MSG.RESIZE, (payload) => received.push(payload));

  win.emit({ ch: 'matrixos/bridge', v: 2, type: BRIDGE_MSG.RESIZE, payload: { height: 955, viewport: 626 } }, 'https://gpa.matrixos.edu');
  assert.equal(received.length, 0, '协议主版本不匹配必须丢弃');

  win.emit({ ch: 'other-channel', v: 1, type: BRIDGE_MSG.RESIZE, payload: { height: 955, viewport: 626 } }, 'https://gpa.matrixos.edu');
  assert.equal(received.length, 0, '非 bridge 通道的消息必须丢弃');

  bridge.close();
});

/* ─────────────────── 7. 能力协商 ─────────────────── */

test('能力协商：BRIDGE_CAPABILITIES 含 layout.resize 与 layout.compact（两件不同的事）', () => {
  assert.ok(BRIDGE_CAPABILITIES.includes('layout.resize'));
  assert.ok(BRIDGE_CAPABILITIES.includes('layout.compact'));
});
