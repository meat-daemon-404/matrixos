/**
 * queue-client 单测（零依赖 node:test + 假 transport）。
 *
 * 之所以能用假 transport 把整套逻辑测干净：queue-client.ts 刻意不碰
 * 全局 fetch / WebSocket / setTimeout，全部从 deps 注入。**如果没有这个
 * 依赖反转，重连退避、4401 停重连、claim 失败回滚这些分支就只能靠真机联调
 * 碰运气**——而那正是本仓库反复吃过亏的地方（"typecheck 过 = 差不多能跑"）。
 *
 * 跑法：node --test src/lib/queue-client.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backoffDelayMs,
  canTransition,
  createQueueClient,
  toView,
} from './queue-client.ts';

/* ------------------------------------------------------------------ */
/* 假基础设施                                                          */
/* ------------------------------------------------------------------ */

function makeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  /** 待办定时器，按触发时刻排序。 */
  const timers = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (cb, ms) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, cb });
      return id;
    },
    clearTimeout: (handle) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    /** 推进虚拟时间并触发到期定时器（按时间顺序，可跨多个定时器）。 */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        timers.splice(timers.indexOf(due), 1);
        due.cb();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    },
    pending: () => timers.length,
  };
}

class FakeSocket {
  static instances = [];
  static last() {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }
  static reset() {
    FakeSocket.instances = [];
  }

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code) {
    this.readyState = 3;
    this.lastCloseCode = code ?? 1000;
  }

  /* --- 测试驱动用的模拟器 --- */
  fireOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  fireMessage(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  fireClose(code) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** 找到某类型的最后一条出站消息。 */
  sentOfType(type) {
    return [...this.sent].reverse().find((m) => m.type === type) || null;
  }
}

function snapshotOf(items) {
  return {
    items,
    pendingCount: items.filter((i) => i.status === 'pending').length,
    desktopOnline: true,
    syncedAt: new Date(1_700_000_000_000).toISOString(),
  };
}

function itemOf(id, status = 'pending') {
  return {
    id,
    origin: 'morning_card',
    originRef: 'c1',
    title: `待办 ${id}`,
    note: '',
    targetStation: 'matrix-cross.matrixos.edu',
    desktopAction: '处理',
    payloadType: 'paper_doi_bundle',
    evidenceAnchors: [
      { source_doi_or_url: 'https://doi.org/10.1/x', verification_level: 'Level_A_Verified' },
    ],
    status,
    createdAt: new Date(1_700_000_000_000).toISOString(),
  };
}

/** 组装一套可编排的假环境。`routes` 决定每个 (method,path) 的响应。 */
function makeHarness(routes) {
  FakeSocket.reset();
  const clock = makeClock();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = init?.method || 'GET';
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : null });
    const handler = routes[`${method} ${path}`] || routes[`${method} *`] || (() => snapshotOf([]));
    const out = await handler();
    if (out && out.__fail) {
      return { ok: false, status: out.status || 500, text: async () => out.__fail, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
  const client = createQueueClient({
    apiBase: 'https://api.matrixos.edu',
    fetch: fetchImpl,
    WebSocket: (url) => new FakeSocket(url),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    getToken: () => 'mx_at_test',
    random: () => 0, // jitter 归零，退避序列可精确断言
    deviceId: 'desktop-ut',
  });
  return { client, clock, calls, fetchImpl };
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

/* ------------------------------------------------------------------ */
/* 纯函数                                                             */
/* ------------------------------------------------------------------ */

test('backoffDelayMs 指数增长并在 30s 封顶（无 jitter 时精确）', () => {
  const r = () => 0;
  assert.equal(backoffDelayMs(1, { random: r }), 1000);
  assert.equal(backoffDelayMs(2, { random: r }), 2000);
  assert.equal(backoffDelayMs(3, { random: r }), 4000);
  assert.equal(backoffDelayMs(6, { random: r }), 30000);
  assert.equal(backoffDelayMs(99, { random: r }), 30000, '必须封顶，不能无限增长打爆后端');
});

test('backoffDelayMs 的 jitter 只加不减，且不超过 +30%', () => {
  const max = backoffDelayMs(3, { random: () => 1 });
  const min = backoffDelayMs(3, { random: () => 0 });
  assert.equal(min, 4000);
  assert.equal(max, 5200, '4000 × 1.3');
  assert.ok(max >= min, 'jitter 必须是加性的，否则会出现比上次更快重试');
});

test('backoffDelayMs 对脏输入不炸', () => {
  const r = () => 0;
  assert.equal(backoffDelayMs(0, { random: r }), 1000, 'attempt<1 时夹到第 1 次');
  assert.equal(backoffDelayMs(-5, { random: r }), 1000);
  assert.ok(Number.isFinite(backoffDelayMs(3, { random: () => Number.NaN })));
});

test('canTransition 只承认前向流动，重放视为幂等', () => {
  assert.equal(canTransition('pending', 'claimed'), true);
  assert.equal(canTransition('claimed', 'done'), true);
  assert.equal(canTransition('pending', 'done'), false, '跳过认领必须被拦');
  assert.equal(canTransition('done', 'claimed'), false, '不得倒退');
  assert.equal(canTransition('claimed', 'claimed'), true, '幂等重放（重连后重发）');
});

test('toView 的 pendingCount 由 items 现算，不信快照里的数', () => {
  const v = toView({ ...snapshotOf([itemOf('a'), itemOf('b', 'done')]), pendingCount: 99 });
  assert.equal(v.pendingCount, 1, '快照自带的计数不可信，UI 用本地现算值');
  assert.equal(toView(null).items.length, 0);
});

/* ------------------------------------------------------------------ */
/* 连接与协议                                                          */
/* ------------------------------------------------------------------ */

test('start() 会拉全量并建立 WS', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([itemOf('a')]) });
  h.client.start();
  await flush();
  assert.equal(h.client.view().items.length, 1);
  assert.equal(h.client.view().origin, 'live');
  assert.equal(FakeSocket.instances.length, 1);
  assert.match(FakeSocket.last().url, /^wss:\/\/api\.matrixos\.edu\/v1\/pocket\/stream$/);
  h.client.stop();
});

test('hello → 发 auth + subscribe；resync → 触发全量拉取', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([]) });
  h.client.start();
  await flush();
  const pulls0 = h.calls.filter((c) => c.method === 'GET').length;

  const sock = FakeSocket.last();
  sock.fireOpen();
  sock.fireMessage({ type: 'hello', serverTime: 'x', heartbeatSec: 30 });
  await flush();
  assert.deepEqual(sock.sentOfType('auth'), { type: 'auth', token: 'mx_at_test', deviceId: 'desktop-ut' });
  assert.equal(sock.sentOfType('subscribe').topics.includes('queue'), true);

  sock.fireMessage({ type: 'resync', reason: 'authenticated' });
  await flush();
  assert.ok(
    h.calls.filter((c) => c.method === 'GET').length > pulls0,
    'resync 必须触发一次全量拉取（这是唯一的同步点）',
  );
  h.client.stop();
});

test('pong 不影响状态；未知消息类型被忽略（前向兼容）', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([]) });
  h.client.start();
  await flush();
  const sock = FakeSocket.last();
  sock.fireOpen();
  sock.fireMessage({ type: 'pong', t: 1 });
  sock.fireMessage({ type: 'brand.new.event' });
  await flush();
  assert.equal(h.client.view().conn, 'online', '未知事件不应把连接状态打回 offline');
  h.client.stop();
});

test('queue.claimed / queue.done 事件就地更新条目状态', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([itemOf('x')]) });
  h.client.start();
  await flush();
  const sock = FakeSocket.last();
  sock.fireOpen();
  sock.fireMessage({ type: 'queue.claimed', itemId: 'x', claimedAt: '2026-10-20T12:00:00Z', station: 'matrix-cross' });
  await flush();
  assert.equal(h.client.view().items[0].status, 'claimed');

  sock.fireMessage({ type: 'queue.done', itemId: 'x', doneAt: '2026-10-20T13:00:00Z' });
  await flush();
  assert.equal(h.client.view().items[0].status, 'done');
  assert.equal(h.client.view().pendingCount, 0);
  h.client.stop();
});

test('queue.count 会顺带拉全量（否则新推入的条目要等 resync 才显示）', async () => {
  let serverItems = [itemOf('a')];
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf(serverItems) });
  h.client.start();
  await flush();
  assert.equal(h.client.view().items.length, 1);

  const sock = FakeSocket.last();
  sock.fireOpen();
  // 手机推入第二条，服务端广播计数变化
  serverItems = [itemOf('a'), itemOf('b')];
  sock.fireMessage({ type: 'queue.count', pendingCount: 2 });
  await flush(10);
  assert.equal(h.client.view().items.length, 2, 'count 只是信号，条目本体必须靠拉取拿到');
  assert.equal(h.client.view().pendingCount, 2);
  h.client.stop();
});

/* ------------------------------------------------------------------ */
/* 重连与降级                                                          */
/* ------------------------------------------------------------------ */

test('非 4401 断开进入 retrying，按退避重连', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([]) });
  h.client.start();
  await flush();
  FakeSocket.last().fireOpen();
  FakeSocket.last().fireClose(1006);
  assert.equal(h.client.view().conn, 'retrying');
  assert.equal(FakeSocket.instances.length, 1, '此刻还不该新建连接');

  await h.clock.advance(1000); // 第一次退避 1s
  assert.equal(FakeSocket.instances.length, 2, '1s 后应重连一次');
  h.client.stop();
});

test('连续失败按 1s/2s/4s 递增退避', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([]) });
  h.client.start();
  await flush();
  // 退避是 2 的幂（1000/2000/4000），不是线性 1000/2000/3000——
  // 曾经这里按线性写断言，第三次只差 1s 就误判成"没重连"。
  for (const [i, delay] of [1000, 2000, 4000].entries()) {
    FakeSocket.last().fireClose(1006);
    await flush();
    const before = FakeSocket.instances.length;
    await h.clock.advance(delay - 1);
    assert.equal(FakeSocket.instances.length, before, `第 ${i + 1} 次：差 1ms 不该重连`);
    await h.clock.advance(1);
    assert.equal(FakeSocket.instances.length, before + 1, `第 ${i + 1} 次应在 ${delay}ms 到点重连`);
  }
  h.client.stop();
});

test('4401 进入 unauthorized 并停止重连（凭证问题不打成 DDOS）', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([]) });
  h.client.start();
  await flush();
  FakeSocket.last().fireClose(4401);
  assert.equal(h.client.view().conn, 'unauthorized');
  assert.match(h.client.view().lastError, /重新登录/);
  await h.clock.advance(120_000);
  assert.equal(FakeSocket.instances.length, 1, '4401 之后不得再重连');
  h.client.stop();
});

test('拉取失败但有旧数据 → origin 降级为 cache 而非清空（ADR-09）', async () => {
  let fail = false;
  const h = makeHarness({
    'GET /v1/pocket/queue': () => (fail ? { __fail: 'boom' } : snapshotOf([itemOf('a')])),
  });
  h.client.start();
  await flush();
  assert.equal(h.client.view().origin, 'live');

  fail = true;
  await h.client.refresh();
  await flush();
  const v = h.client.view();
  assert.equal(v.origin, 'cache', '降级必须显式可见');
  assert.equal(v.items.length, 1, '旧数据要留住，不能白屏');
  assert.match(v.lastError, /boom/);
  h.client.stop();
});

test('首次就失败且无缓存 → origin=mock，不假装在线', async () => {
  const h = makeHarness({ 'GET *': () => ({ __fail: 'no backend', status: 503 }) });
  h.client.start();
  await flush();
  assert.equal(h.client.view().origin, 'mock');
  assert.equal(h.client.view().items.length, 0);
  h.client.stop();
});

/* ------------------------------------------------------------------ */
/* 写路径：乐观更新 + 失败回滚                                           */
/* ------------------------------------------------------------------ */

test('claim 成功：乐观置 claimed 并由服务端响应确认', async () => {
  const h = makeHarness({
    'GET /v1/pocket/queue': () => snapshotOf([itemOf('k')]),
    'POST /v1/pocket/queue/claim': () => ({ item: { ...itemOf('k', 'claimed'), claimedAt: 'srv' } }),
  });
  h.client.start();
  await flush();
  const claimPromise = h.client.claim('k');
  assert.equal(h.client.view().items[0].status, 'claimed', '必须先乐观反馈（2s 规则）');
  await claimPromise;
  assert.equal(h.client.view().items[0].status, 'claimed');
  const call = h.calls.find((c) => c.method === 'POST');
  assert.deepEqual(call.body, { itemId: 'k' });
  h.client.stop();
});

test('claim 失败：回滚到原状态并报错，不假装成功', async () => {
  const h = makeHarness({
    'GET /v1/pocket/queue': () => snapshotOf([itemOf('k')]),
    'POST /v1/pocket/queue/claim': () => ({ __fail: 'HTTP 409', status: 409 }),
  });
  h.client.start();
  await flush();
  await assert.rejects(() => h.client.claim('k'), /409/);
  assert.equal(h.client.view().items[0].status, 'pending', '失败必须回滚');
  assert.match(h.client.view().lastError, /409/);
  h.client.stop();
});

test('本地拦住 pending→done 非法跃迁，不发请求（省一次往返）', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([itemOf('k')]) });
  h.client.start();
  await flush();
  const postsBefore = h.calls.filter((c) => c.method === 'POST').length;
  await h.client.done('k');
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, postsBefore, '不该发出请求');
  assert.match(h.client.view().lastError, /非法状态跃迁/);
  assert.equal(h.client.view().items[0].status, 'pending');
  h.client.stop();
});

test('remove 失败回滚列表', async () => {
  const h = makeHarness({
    'GET /v1/pocket/queue': () => snapshotOf([itemOf('a'), itemOf('b')]),
    'DELETE *': () => ({ __fail: 'HTTP 404', status: 404 }),
  });
  h.client.start();
  await flush();
  assert.equal(h.client.view().items.length, 2);
  await assert.rejects(() => h.client.remove('a'), /404/);
  assert.equal(h.client.view().items.length, 2, '删除失败要放回列表');
  h.client.stop();
});

test('stop() 后不再重连，且可安全重复调用', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([]) });
  h.client.start();
  await flush();
  FakeSocket.last().fireOpen();
  h.client.stop();
  h.client.stop();
  const n = FakeSocket.instances.length;
  FakeSocket.last().fireClose(1006);
  await h.clock.advance(60_000);
  assert.equal(FakeSocket.instances.length, n, '已停止的连接不应复活');
});

test('on() 立即回放当前视图并可退订', async () => {
  const h = makeHarness({ 'GET /v1/pocket/queue': () => snapshotOf([itemOf('a')]) });
  const seen = [];
  const off = h.client.on((v) => seen.push(v.items.length));
  assert.equal(seen[0], 0, '注册时立刻拿到当前状态，避免首帧空白');
  h.client.start();
  await flush();
  assert.ok(seen.includes(1), '状态变化应推给订阅者');
  const n = seen.length;
  off();
  await h.client.refresh();
  assert.equal(seen.length, n, '退订后不应再收到回调');
  h.client.stop();
});
