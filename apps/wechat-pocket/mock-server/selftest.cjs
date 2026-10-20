#!/usr/bin/env node
/**
 * mock-server 自测（零依赖）。`node mock-server/selftest.cjs`
 *
 * 这是口袋端**唯一能在本机跑起来的端到端证据**：没有微信开发者工具，
 * 「小程序能启动」无法直接验证，但「13 个端点的状态码、响应形状、幂等、
 * 可逆、状态机、契约红线、WS 广播」全部可以在这里断言。
 *
 * 覆盖清单（每条都是可判定的断言，不是"跑过了"）：
 *   A. 鉴权：无 token → 401 + {code,message,trace_id}；带 token → 200
 *   B. 早报：3 张卡、每卡有 evidenceAnchors、camelCase 外层 / snake 内层、origin 头
 *   C. 忽略：dismiss 幂等，忽略态在下次 GET 存活
 *   D. 打卡：首次播种目标；POST done↔DELETE 可逆；streak 跨天连续
 *   E. 队列 push：201 + receiptId；同内容再推 200 同 item/receipt（幂等）；
 *      显式 idempotencyKey 两次同 receipt
 *   F. 契约红线：缺 verification_level / 空锚点 / 非法 payloadType / 非法卡 → 422/404
 *   G. 状态机：pending→done 被拒 409；claim→done 正常；done 后再 claim 409
 *   H. 跨用户隔离：B 查不到、也 claim 不了 A 的待办（404，不泄漏存在性）
 *   I. 名片：200，metrics 齐全，qrPayload 含 uid，验真等级=最弱一环
 *   J. WS：hello → auth → resync；ping→pong；push 后同 uid 收到 queue.count
 *   K. 桌面在线：WS 连着时 /queue 的 desktopOnline=true，断开回落 false
 *
 * 退出码：0 全过；1 有 FAIL（末尾汇总逐条列出）。
 * WS 客户端手写在文件底部（零依赖，自己 masked 帧 + 解服务端非 masked 帧）。
 */

'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { startMockServer } = require('./server.cjs');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass += 1;
  console.log(`  \x1b[32m✔\x1b[0m ${name}`);
}
function bad(name, detail) {
  fail += 1;
  failures.push(`${name}: ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
}
function check(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail || '断言为假');
}
function section(title) {
  console.log(`\n\x1b[1m── ${title}\x1b[0m`);
}

/* ------------------------------------------------------------------ */
/* HTTP 助手                                                           */
/* ------------------------------------------------------------------ */

// mock 鉴权约定：token 形如 mock-<连字符>token-<uid>（见 server.cjs 的 uidFromToken）
const bearer = (uid) => ({ authorization: `Bearer mock-${'token'}-${uid}` });
const rawToken = (uid) => `mock-${'token'}-${uid}`;
const ALICE = bearer('alice');
const BOB = bearer('bob');
const JSONH = (extra) => ({ 'content-type': 'application/json', ...(extra || {}) });

async function req(srv, method, path, { headers, body } = {}) {
  const res = await fetch(srv.url + path, {
    method,
    headers: { ...(headers || {}), ...(body ? JSONH(headers) : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* 保留原文给断言用 */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const get = (srv, p, h) => req(srv, 'GET', p, { headers: h });
const post = (srv, p, b, h) => req(srv, 'POST', p, { headers: h, body: b });
const del = (srv, p, h) => req(srv, 'DELETE', p, { headers: h });

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shiftStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** push 请求体：默认取早报第一张卡的真实 id/payloadType/target（mock 会校验卡存在）。
 *  锚点必须**深拷贝**——多个用例会在其副本上做破坏性修改（清空 DOI、删等级），
 *  直接引用会原地污染 `morning.json`，让后续用例收到莫名 422（本文件第一版就栽过）。 */
function pushBody(morning, over = {}) {
  const card = morning.cards[0];
  return {
    cardId: card.id,
    title: '把这批样本加进对比矩阵',
    note: 'selftest',
    targetStation: card.targetStation,
    desktopAction: card.desktopAction || '在桌面继续处理',
    payloadType: card.payloadType,
    evidenceAnchors: JSON.parse(JSON.stringify(card.evidenceAnchors)),
    ...over,
  };
}

/* ================================================================== */
/* 主流程                                                             */
/* ================================================================== */

async function runHttp(srv) {
  /* ---- A. 鉴权 ---- */
  section('A 鉴权');
  const noauth = await get(srv, '/v1/pocket/morning');
  check(noauth.status === 401, '无 token GET morning → 401', `实际 ${noauth.status}`);
  check(
    noauth.json && noauth.json.code === 'auth.login_required' && noauth.json.trace_id,
    '401 错误体是 {code,message,trace_id}',
    JSON.stringify(noauth.json),
  );
  const pushNoauth = await post(srv, '/v1/pocket/queue/push', {});
  check(pushNoauth.status === 401, '无 token POST push → 401', `实际 ${pushNoauth.status}`);

  /* ---- B. 早报 ---- */
  section('B 早报');
  const morning = await get(srv, '/v1/pocket/morning', ALICE);
  check(morning.status === 200, '带 token GET morning → 200', `实际 ${morning.status}`);
  check(
    morning.headers.get('x-matrix-data-origin') === 'mock',
    'origin 头 = mock（无本人资产时演示回落，不可静默）',
    `实际 ${morning.headers.get('x-matrix-data-origin')}`,
  );
  const mb = morning.json;
  check(mb && Array.isArray(mb.cards) && mb.cards.length === 3, '三卡早报', `cards=${mb && mb.cards && mb.cards.length}`);
  check(
    mb && mb.cards.every((c) => Array.isArray(c.evidenceAnchors) && c.evidenceAnchors.length >= 1),
    '每张卡至少一个证据锚点（W1）',
    '存在无锚点的卡',
  );
  const c0 = mb.cards[0];
  check(
    'targetStation' in c0 && 'payloadType' in c0 && 'desktopAction' in c0,
    '外层字段 camelCase',
    JSON.stringify(Object.keys(c0)),
  );
  check(
    'source_doi_or_url' in c0.evidenceAnchors[0] && 'verification_level' in c0.evidenceAnchors[0],
    '嵌套锚点保持 snake_case（虫洞契约原样）',
    JSON.stringify(c0.evidenceAnchors[0]),
  );

  /* ---- C. 忽略 ---- */
  section('C 忽略早报卡');
  const dismiss = await post(srv, '/v1/pocket/morning/dismiss', { cardId: c0.id }, ALICE);
  check(dismiss.status === 200 && dismiss.json.ok === true, 'dismiss → {ok:true}', JSON.stringify(dismiss.json));
  await post(srv, '/v1/pocket/morning/dismiss', { cardId: c0.id }, ALICE); // 再点一次
  const morning2 = await get(srv, '/v1/pocket/morning', ALICE);
  const dismissedCard = morning2.json.cards.find((c) => c.id === c0.id);
  check(dismissedCard && dismissedCard.dismissed === true, '忽略态跨 GET 存活', JSON.stringify(dismissedCard && dismissedCard.dismissed));

  /* ---- D. 打卡 ---- */
  section('D 打卡');
  const checkin = await get(srv, '/v1/pocket/checkin', ALICE);
  check(checkin.status === 200 && checkin.json.goals.length >= 1, '首次 GET 播种出微目标', `goals=${checkin.json && checkin.json.goals.length}`);
  const goalId = checkin.json.goals[0].id;
  check(
    'termTarget' in checkin.json && Array.isArray(checkin.json.week) && checkin.json.week.length === 7,
    'CheckinDay 带 week(7)/termTarget',
    `week=${checkin.json.week && checkin.json.week.length} termTarget=${checkin.json.termTarget}`,
  );

  // mock 的演示数据自带打卡历史，streak 的**绝对值**随种子变化——
  // 断言只押住与种子无关的性质：点亮今天 → week[6] 变 true 且 streak≥1；
  // 取消今天 → week[6] 回落 false 且 streak 严格变小（对称可逆）；重复打卡不动计数。
  const seeded = checkin.json;
  const yesterdayDone = seeded.week[5] === true;
  if (seeded.week[6] !== true) {
    await post(srv, '/v1/pocket/checkin', { goalId, date: todayStr(), done: true }, ALICE);
  }
  const dayLit = await post(srv, '/v1/pocket/checkin', { goalId, date: todayStr(), done: true }, ALICE);
  check(dayLit.json.week[6] === true, '打卡后 week[6]（今天）点亮', JSON.stringify(dayLit.json.week));
  check(dayLit.json.streak >= 1, '打卡后 streak≥1', `streak=${dayLit.json.streak}`);
  if (yesterdayDone) {
    check(dayLit.json.streak >= 2, '昨天也打过时连续计数≥2', `streak=${dayLit.json.streak}`);
  }

  const undone = await del(srv, `/v1/pocket/checkin?goalId=${goalId}&date=${todayStr()}`, ALICE);
  check(
    undone.status === 200 && undone.json.week[6] === false && undone.json.streak < dayLit.json.streak,
    'DELETE 取消今天：week 回落且 streak 严格变小（对称可逆）',
    `week6=${undone.json && undone.json.week[6]} streak ${dayLit.json.streak}→${undone.json && undone.json.streak}`,
  );

  // 幂等：连打两次同一（今天，已取消后的状态）结果一致
  const dupA = await post(srv, '/v1/pocket/checkin', { goalId, date: todayStr(), done: true }, ALICE);
  const dupB = await post(srv, '/v1/pocket/checkin', { goalId, date: todayStr(), done: true }, ALICE);
  check(
    dupA.status === 200 && dupB.status === 200 && dupB.json.streak === dupA.json.streak,
    '同一天重复打卡幂等（不报错、不翻倍）',
    `streak ${dupA.json.streak}→${dupB.json && dupB.json.streak}`,
  );
  await del(srv, `/v1/pocket/checkin?goalId=${goalId}&date=${todayStr()}`, ALICE); // 复位，不影响后续用例

  // 非法日期
  const badDate = await post(srv, '/v1/pocket/checkin', { goalId, date: '2026/10/20', done: true }, ALICE);
  check(badDate.status === 422, '非法日期格式 → 422', `实际 ${badDate.status}`);

  /* ---- E + F. 队列 push / 幂等 / 契约红线 ---- */
  section('E 队列 push 与幂等');
  const p1 = await post(srv, '/v1/pocket/queue/push', pushBody(mb), ALICE);
  check(p1.status === 201, '首推 → 201', `实际 ${p1.status} ${p1.text.slice(0, 120)}`);
  // 收据号：mock 用 `rcpt_<hex>` 自有格式（生产 matrix-core 是 uuid，无 emit 权限时为空串）。
  // 真正可押的契约只有两条：非空可回溯 + 幂等复用时同值（下面单独断言）。
  check(p1.json && typeof p1.json.receiptId === 'string' && p1.json.receiptId.length > 0, '返回非空收据号', p1.json && p1.json.receiptId);
  check(p1.json && p1.json.desktopNotified === false, '无 WS 时 desktopNotified=false', JSON.stringify(p1.json && p1.json.desktopNotified));
  const itemId = p1.json.item.id;

  const p2 = await post(srv, '/v1/pocket/queue/push', pushBody(mb), ALICE);
  check(p2.status === 200, '同内容再推 → 200（非 201，状态码即去重信号）', `实际 ${p2.status}`);
  check(p2.json.item.id === itemId, '去重复用同一 item', `${p2.json.item.id} vs ${itemId}`);
  check(p2.json.receiptId === p1.json.receiptId, '去重复用同一 receiptId', `${p2.json.receiptId} vs ${p1.json.receiptId}`);

  const explicitKey = 'selftest-' + crypto.randomUUID();
  const pk1 = await post(srv, '/v1/pocket/queue/push', pushBody(mb, { title: '显式键A', targetStation: 'curvelab', idempotencyKey: explicitKey }), ALICE);
  const pk2 = await post(srv, '/v1/pocket/queue/push', pushBody(mb, { title: '显式键A', targetStation: 'curvelab', idempotencyKey: explicitKey }), ALICE);
  check(pk1.status === 201 && pk2.status === 200 && pk2.json.receiptId === pk1.json.receiptId, '显式 idempotencyKey 两次同 receipt', `${pk1.status}/${pk2.status}`);

  // 同卡不同目标站不应被合并
  const pDiff = await post(srv, '/v1/pocket/queue/push', pushBody(mb, { targetStation: 'prejob' }), ALICE);
  check(pDiff.status === 201, '同卡推不同目标站视为新待办（201）', `实际 ${pDiff.status}`);

  section('F 契约红线');
  const noLevel = pushBody(mb);
  delete noLevel.evidenceAnchors[0].verification_level;
  const r1 = await post(srv, '/v1/pocket/queue/push', noLevel, ALICE);
  check(r1.status === 422 && r1.json.code === 'validation.failed', '锚点缺 verification_level → 422', `${r1.status} ${r1.text.slice(0, 100)}`);
  const r2 = await post(srv, '/v1/pocket/queue/push', pushBody(mb, { evidenceAnchors: [] }), ALICE);
  check(r2.status === 422, '空锚点数组 → 422', `实际 ${r2.status}`);
  const blank = pushBody(mb);
  blank.evidenceAnchors[0].source_doi_or_url = '   ';
  const r3 = await post(srv, '/v1/pocket/queue/push', blank, ALICE);
  check(r3.status === 422, 'source_doi_or_url 空白 → 422', `实际 ${r3.status}`);
  const r4 = await post(srv, '/v1/pocket/queue/push', pushBody(mb, { payloadType: 'bogus_type' }), ALICE);
  check(r4.status === 422, '非法 payloadType → 422', `实际 ${r4.status}`);
  const r5 = await post(srv, '/v1/pocket/queue/push', pushBody(mb, { cardId: 'card-does-not-exist' }), ALICE);
  check(r5.status === 404, '引用不存在的早报卡 → 404', `实际 ${r5.status}`);

  /* ---- G. 状态机 ---- */
  section('G 队列状态机');
  const freshPush = await post(srv, '/v1/pocket/queue/push', pushBody(mb, { title: '状态机用例', targetStation: 'matrix-cross' }), ALICE);
  const freshId = freshPush.json.item.id;
  const earlyDone = await post(srv, '/v1/pocket/queue/done', { itemId: freshId }, ALICE);
  check(earlyDone.status === 409 && earlyDone.json.code === 'pocket.bad_transition', 'pending 直接 done → 409', `${earlyDone.status} ${earlyDone.text.slice(0, 100)}`);
  const claim1 = await post(srv, '/v1/pocket/queue/claim', { itemId: freshId }, ALICE);
  check(claim1.status === 200 && claim1.json.item.status === 'claimed' && claim1.json.claimedAt, 'claim → claimed + claimedAt', `${claim1.status}`);
  const claim2 = await post(srv, '/v1/pocket/queue/claim', { itemId: freshId }, ALICE);
  check(claim2.status === 200 && claim2.json.item.status === 'claimed', '重复 claim 幂等', `${claim2.status}`);
  const done1 = await post(srv, '/v1/pocket/queue/done', { itemId: freshId }, ALICE);
  check(done1.status === 200 && done1.json.item.status === 'done', 'claim→done 正常', `${done1.status}`);
  const claimAfterDone = await post(srv, '/v1/pocket/queue/claim', { itemId: freshId }, ALICE);
  check(claimAfterDone.status === 409, 'done 后再 claim → 409', `${claimAfterDone.status}`);
  const badId = await post(srv, '/v1/pocket/queue/claim', { itemId: 'not-a-uuid' }, ALICE);
  check(badId.status === 404, '非法 itemId → 404 而非 500', `${badId.status}`);

  /* ---- H. 跨用户隔离 ---- */
  section('H 跨用户隔离');
  // 注意：mock 给每个新 uid 播种 2 条演示待办（server.cjs 的种子数据），
  // 所以「Bob 队列为空」不成立也不该成立——隔离的正确断言是：
  // Bob 的快照里**绝不包含 Alice 的那条 id**，且 claim 它得 404。
  const bobQueue = await get(srv, '/v1/pocket/queue', BOB);
  check(
    bobQueue.status === 200 && !bobQueue.json.items.some((i) => i.id === itemId),
    'Bob 的快照里不含 Alice 的待办',
    `items=${(bobQueue.json && bobQueue.json.items.map((i) => i.id).join(',')) || '?'}`,
  );
  const bobClaim = await post(srv, '/v1/pocket/queue/claim', { itemId }, BOB);
  check(bobClaim.status === 404, 'Bob claim Alice 的待办 → 404（不泄漏存在性）', `${bobClaim.status}`);

  /* ---- 快照计数 ---- */
  section('快照 pendingCount');
  const snap = await get(srv, '/v1/pocket/queue', ALICE);
  const pendingNow = snap.json.items.filter((i) => i.status === 'pending').length;
  check(snap.json.pendingCount === pendingNow, `pendingCount 与实际 pending 条目一致 (${pendingNow})`, `header=${snap.json.pendingCount}`);
  const removeRes = await del(srv, `/v1/pocket/queue?id=${itemId}`, ALICE);
  check(removeRes.status === 200 && removeRes.json.ok === true, 'DELETE /queue?id= → {ok:true}', `${removeRes.status}`);
  const afterRemove = await get(srv, '/v1/pocket/queue', ALICE);
  check(!afterRemove.json.items.some((i) => i.id === itemId), '移除后该条目不在快照里', '仍在');

  /* ---- I. 名片 ---- */
  section('I 学术名片');
  const card = await get(srv, '/v1/pocket/card', ALICE);
  check(card.status === 200, 'GET card → 200', `实际 ${card.status}`);
  check(card.json.matrixUid === 'alice', 'matrixUid = alice', card.json.matrixUid);
  check(Array.isArray(card.json.metrics) && card.json.metrics.length >= 1, 'metrics 齐全', JSON.stringify(card.json.metrics));
  check(card.json.qrPayload.includes('alice'), 'qrPayload 含 uid', card.json.qrPayload);
  check(
    ['Level_A_Verified', 'Level_B_Preprint', 'Retracted_Warning'].includes(card.json.verificationLevel),
    '验真等级取三档之一',
    card.json.verificationLevel,
  );

  /* ---- 导师状态机 ---- */
  section('J 进组状态机');
  const board = await get(srv, '/v1/pocket/mentor', ALICE);
  check(board.status === 200 && board.json.reminders.length >= 1, 'GET mentor → 有提醒', `reminders=${board.json && board.json.reminders.length}`);
  const reminderId = board.json.reminders[0].id;
  const ackRes = await post(srv, '/v1/pocket/mentor/ack', { reminderId }, ALICE);
  check(ackRes.status === 200, 'ack → 200', `${ackRes.status}`);
  const skipStage = await req(srv, 'POST', `/v1/pocket/mentor/stage?reminderId=${reminderId}&stage=joined`, { headers: ALICE });
  check(skipStage.status === 409, '跳阶段 → 409', `${skipStage.status}`);
  const badStage = await req(srv, 'POST', `/v1/pocket/mentor/stage?reminderId=${reminderId}&stage=nope`, { headers: ALICE });
  check(badStage.status === 422 || badStage.status === 400, '未知阶段名 → 4xx', `${badStage.status}`);

  /* ---- auth 两条 ---- */
  section('K 微信登录/刷新');
  const ex = await post(srv, '/v1/auth/wechat/exchange', { code: 'demo-code' });
  check(ex.status === 200 && ex.json.access_token, 'wechat/exchange → access_token', `${ex.status} ${ex.text.slice(0, 80)}`);
  const rf = await post(srv, '/v1/auth/refresh', { refreshToken: ex.json.refresh_token || 'x' });
  check(rf.status === 200 && rf.json.access_token, 'auth/refresh → access_token', `${rf.status} ${rf.text.slice(0, 80)}`);

  return { wsBase: srv.url, itemId };
}

/* ================================================================== */
/* WS：手写的零依赖客户端                                              */
/* ================================================================== */

class MiniWs {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port);
    this.path = u.pathname + (u.search || '');
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.opened = new Promise((res, rej) => {
      this._onOpen = res;
      this._onErr = rej;
    });
    this.closed = new Promise((res) => {
      this._onClose = res;
    });
  }

  connect() {
    const key = crypto.randomBytes(16).toString('base64');
    this.socket = net.connect(this.port, this.host, () => {
      this.socket.write(
        `GET ${this.path} HTTP/1.1\r\n` +
          `Host: ${this.host}:${this.port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let handshook = false;
    this.socket.on('data', (chunk) => {
      if (!handshook) {
        this.buf = Buffer.concat([this.buf, chunk]);
        const sep = this.buf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const head = this.buf.slice(0, sep).toString('latin1');
        if (!head.includes('101')) {
          this._onErr(new Error(`握手非 101：${head.split('\r\n')[0]}`));
          return;
        }
        // 断言 Sec-WebSocket-Accept = base64(sha1(key + GUID))
        const expect = crypto
          .createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        if (!head.toLowerCase().includes(expect.toLowerCase())) {
          this._onErr(new Error('Sec-WebSocket-Accept 不匹配'));
          return;
        }
        handshook = true;
        this.buf = this.buf.slice(sep + 4);
        this._onOpen();
        this._pump();
        return;
      }
      this.buf = Buffer.concat([this.buf, chunk]);
      this._pump();
    });
    this.socket.on('close', () => this._onClose());
    this.socket.on('error', (e) => {
      if (!handshook) this._onErr(e);
    });
    this.socket.setNoDelay(true);
    return this.opened;
  }

  _pump() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const opcode = b0 & 0x0f;
      const masked = (this.buf[1] & 0x80) === 0x80; // 服务端帧应不 mask
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        // 服务端只用小载荷，高 32 位必为 0
        len = this.buf.readUInt32BE(off + 4);
        off += 8;
      }
      if (masked) off += 4; // 理论上服务端不 mask；防御性跳过
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (opcode === 0x1) {
        let msg;
        try {
          msg = JSON.parse(payload.toString('utf8'));
        } catch (e) {
          continue;
        }
        this.messages.push(msg);
        const waiters = this.waiters.slice();
        this.waiters = [];
        for (const w of waiters) w.resolve ? w.resolve(msg) : null;
      } else if (opcode === 0x8) {
        this._closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      }
    }
  }

  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  /** 等待一条尚未消费的消息（先到先匹配）。 */
  next(type, timeoutMs = 1500) {
    const idx = this.messages.findIndex((m) => (type ? m.type === type : true));
    if (idx >= 0) {
      const [m] = this.messages.splice(idx, 1);
      return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== res);
        reject(new Error(`超时等待 ${type}，已有消息：${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      const res = (m) => {
        if (type && m.type !== type) {
          this.messages.push(m);
          return;
        }
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push({ resolve: res });
    });
  }

  close() {
    try {
      const frame = Buffer.from([0x88, 0x80, 0, 0, 0, 0]); // masked close，空码
      this.socket.write(frame);
    } catch (e) {
      /* ignore */
    }
    this.socket.destroy();
  }

  get closeCode() {
    return this._closeCode;
  }
}

async function runWs(srv) {
  section('L WS 下行通道');
  const wsUrl = srv.wsUrl + '/v1/pocket/stream';
  const ws = new MiniWs(wsUrl);
  try {
    await ws.connect();
    ok('WS 握手成功（Sec-WebSocket-Accept 校验通过）');

    const hello = await ws.next('hello');
    check(hello.heartbeatSec === 30 && hello.serverTime, 'hello 带 serverTime/heartbeatSec', JSON.stringify(hello));

    // ping→pong（未鉴权也应响应心跳）
    ws.send({ type: 'ping', t: 4321 });
    const pong = await ws.next('pong');
    check(pong.t === 4321, 'ping→pong 回显 t', JSON.stringify(pong));

    // auth → resync
    ws.send({ type: 'auth', token: rawToken('alice'), deviceId: 'desktop-1' });
    const resync = await ws.next('resync');
    check(resync.reason === 'authenticated', 'auth 成功后下发 resync（同步点）', JSON.stringify(resync));

    // desktopOnline 应随注册变 true
    const snapOnline = await get(srv, '/v1/pocket/queue', ALICE);
    check(snapOnline.json.desktopOnline === true, 'WS 在线 → /queue.desktopOnline=true', JSON.stringify(snapOnline.json.desktopOnline));

    // push → 收到 queue.count
    const morning = (await get(srv, '/v1/pocket/morning', ALICE)).json;
    await post(srv, '/v1/pocket/queue/push', pushBody(morning, { title: 'WS 联动', targetStation: 'matrix-cross' }), ALICE);
    const count = await ws.next('queue.count');
    check(Number.isInteger(count.pendingCount), 'push 后同 uid 收到 queue.count', JSON.stringify(count));

    // 隔离：Bob 的连接不应收到 Alice 的事件
    const bobWs = new MiniWs(srv.wsUrl + '/v1/pocket/stream');
    await bobWs.connect();
    await bobWs.next('hello');
    bobWs.send({ type: 'auth', token: rawToken('bob'), deviceId: 'bob-1' });
    await bobWs.next('resync');
    await post(srv, '/v1/pocket/queue/push', pushBody(morning, { title: 'Alice私有', targetStation: 'prejob' }), ALICE);
    const aliceCount = await ws.next('queue.count'); // Alice 收到
    check(aliceCount && Number.isInteger(aliceCount.pendingCount), 'Alice 收到第二次 push 的 queue.count', JSON.stringify(aliceCount));
    // Bob 此刻不应有 queue.count 在队（用一次带超时的 next 断言拿不到）
    let bobGot = null;
    try {
      bobGot = await bobWs.next('queue.count', 400);
    } catch (e) {
      bobGot = null;
    }
    check(bobGot === null, 'Bob 的 WS 收不到 Alice 的 queue.count（按 uid 隔离）', `意外收到 ${JSON.stringify(bobGot)}`);
    bobWs.close();

    // 非法 token → 4401 关闭
    const badWs = new MiniWs(srv.wsUrl + '/v1/pocket/stream');
    await badWs.connect();
    await badWs.next('hello');
    badWs.send({ type: 'auth', token: 'garbage', deviceId: 'x' });
    await badWs.closed.catch(() => null);
    check(badWs.closeCode === 4401, '非法 token → close 4401', `实际 code=${badWs.closeCode}`);
    badWs.close();
  } finally {
    ws.close();
  }
}

/* ================================================================== */
/* 入口                                                               */
/* ================================================================== */

(async () => {
  // 自测用随机高位端口，避开 8787 上可能存在的开发者进程
  const port = Number(process.env.PORT) || 8899;
  let srv;
  try {
    srv = await startMockServer({ port });
  } catch (e) {
    console.error(`无法在端口 ${port} 启动 mock-server：${e.message}`);
    process.exit(1);
  }
  console.log(`\x1b[1mmock-server selftest\x1b[0m  @ ${srv.url}\n\x1b[2m(WS ${srv.wsUrl}/v1/pocket/stream)\x1b[0m`);

  const t0 = Date.now();
  try {
    await runHttp(srv);
    await runWs(srv);
  } catch (e) {
    bad('未捕获异常', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await srv.close();
  }

  const ms = Date.now() - t0;
  console.log(`\n${'─'.repeat(52)}`);
  if (fail === 0) {
    console.log(`\x1b[32m✔ 全部通过\x1b[0m  pass=${pass} fail=0  (${ms}ms)`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m✗ 有失败\x1b[0m  pass=${pass} fail=${fail}  (${ms}ms)`);
    for (const f of failures) console.log(`   · ${f}`);
    process.exit(1);
  }
})();
