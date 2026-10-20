/**
 * 逐步骤验证总控台首次引导的卡片定位。
 *
 * 为什么单独写成脚本，而不是串几条 `cdp.mjs eval`：
 *   上一轮我用一条 eval 里「点下一步 → 等 700ms → 量聚光框」，量到的是
 *   **上一步的旧几何** —— React 还没把新的 data-onboard 目标量完，同一个
 *   DOM 节点也没重建，于是得出「第 2 步重叠 61605 px²」的假阳性。
 *   判断引导对不对，必须每一步都：等状态真的变了 → 重新读几何 → 再算重叠。
 *
 * 判据（三条全过才算通过）：
 *   1. 聚光框存在且尺寸 > 0；
 *   2. 聚光框确实框住了当前步的 data-onboard 目标（容差 = SPOTLIGHT_PAD）；
 *   3. 卡片与聚光框重叠面积为 0。
 *
 * 用法：
 *   node scripts/verify-onboarding.mjs
 *   node scripts/verify-onboarding.mjs --shots     # 每步额外截图
 *
 * 前置：dev server 在 3000，且 `node scripts/cf-shell.mjs` 已把浏览器拉起。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP_HTTP, CDP_PORT, probeCdpIdentity } from './lib/cdp-port.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, '.tmp', 'cf-shots');
const WANT_SHOTS = process.argv.includes('--shots');

/**
 * 被测页面地址。
 *
 * 三个来源，优先级从高到低：
 *   1. `--url=<地址>`：命令行显式指定，线上验收用这个
 *   2. `MATRIXOS_CDP_START_URL`：与 cf-shell 启动浏览器时的默认页一致
 *   3. `http://localhost:3000`：本地 dev 兜底
 *
 * 注意**不能只靠** `MATRIXOS_CDP_START_URL`：那个变量只在启动浏览器时
 * 决定首个页面地址，而本脚本要主动 `Page.navigate` 到目标地址；
 * 线上验收时若漏了 `--url`，脚本会静默去验 localhost —— 本地 dev 没跑
 * 就报「页面没等到引导就绪」，看着像线上坏了，实则是验错了地址。
 */
const urlArg = process.argv.find((a) => a.startsWith('--url='))?.slice(6);
const START_URL = urlArg ?? process.env.MATRIXOS_CDP_START_URL ?? 'http://localhost:3000';

/** 目标页面的 origin，用于挑标签页与清理 localStorage（必须同源才生效）。 */
const START_ORIGIN = new URL(START_URL).origin;

const STORAGE_KEY = 'matrixos:hub:onboarded:v1';

/* ─────────────────────── CDP 最小客户端 ─────────────────────── */

async function connectPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket 错误: ${e.message ?? 'unknown'}`));
    });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else resolve(msg.result);
    }
  });

  /**
   * 超时给得比直觉大：Next dev 首次编译 / 主线程解析大 bundle 时，
   * Runtime.evaluate 会排队等到主线程空出来，20s 完全不够（实测就死在这）。
   */
  const send = (method, params = {}, timeoutMs = 90000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP ${method} 超时`));
        }
      }, timeoutMs);
    });

  return { ws, send, close: () => ws.close() };
}

async function pickPage() {
  const targets = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('没有可用的 page target');
  // 优先挑已经停在被测 origin 上的标签页：这样下一行清 localStorage 才同源生效。
  // 之前只看 localhost:3000，线上验收时挑不到匹配页就退回 pages[0]，
  // 于是在别的站上清 key（清了个寂寞）再 navigate 过去 —— 引导当然不弹。
  return pages.find((p) => p.url.startsWith(START_ORIGIN)) ?? pages[0];
}

/** 在页面里跑一段表达式并取回值（异常要显式抛出，不能静默当 undefined）。 */
async function evaluate(conn, expression, awaitPromise = false) {
  const { result, exceptionDetails } = await conn.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (exceptionDetails) {
    throw new Error(`页面内异常：${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`);
  }
  return result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────── 页面内探针 ─────────────────────── */

/*
 * 关掉引导元素的过渡与进入动画，只测「最终落位」。
 *
 * 为什么必须这么做：`.onb-spotlight` 上有
 *   transition: top/left/width/height var(--dur-base)   （--dur-base: 300ms）
 * 在后台/被遮挡的窗口里，Chrome 的时间轴推进极慢，过渡会**卡在起始值**：
 * 实测 inline style 已经改成仪器架的 left:575.104px / width:1142.22px，
 * 而 getBoundingClientRect() 在 780ms 里恒返回上一个盒子 [0,0,581,747]。
 * 结果是连续四步读到「滞后一步」的几何，误判第 2 步重叠 63920 px²。
 *
 * 本脚本要验的是**布局最终对不对**，不是动画过程，所以直接取消过渡：
 * 这样 rect 立刻等于 inline style 的目标值，测量与窗口是否前台无关。
 * 动画观感另有截图与人工确认，不在本脚本职责内。
 */
const FREEZE_ANIMATION = `(() => {
  const id = 'matrixos-verify-freeze';
  if (document.getElementById(id)) return 'already';
  const style = document.createElement('style');
  style.id = id;
  style.textContent = '.onb-spotlight, .onb-scrim, .onb-card { transition: none !important; animation: none !important; }';
  document.head.appendChild(style);
  return 'frozen';
})()`;

/**
 * 读当前引导状态。
 *
 * 刻意返回「目标元素几何 + 聚光框几何 + 卡片几何」三者 ——
 * 只有三者对齐才能判定「聚光框框对了地方、卡片没盖住它」。
 * 另外读一次 offsetHeight 强制刷新布局，避免拿到上一帧的盒子。
 */
const PROBE = `(() => {
  const round = (n) => Math.round(n);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
  };
  void document.body.offsetHeight; // 强制布局刷新

  const card = document.querySelector('.onb-card');
  const spots = [...document.querySelectorAll('.onb-spotlight')];
  const spot = spots[0] ?? null;
  const layer = document.querySelector('.onb-layer');
  const stepLabel = document.querySelector('.onb-step')?.textContent?.trim() ?? null;
  const title = document.querySelector('.onb-title')?.textContent?.trim() ?? null;

  // 当前应该是哪一步的目标：按卡片标题反查步骤名，再用同一套映射找元素
  const TARGET_BY_TITLE = {
    '星轨引力场': 'orbit',
    '仪器架': 'rack',
    '虫洞投送': 'wormhole',
    '全局 Copilot': 'dock',
  };
  const targetKey = title ? (TARGET_BY_TITLE[title] ?? null) : null;
  const targetEl = targetKey ? document.querySelector('[data-onboard="' + targetKey + '"]') : null;

  return JSON.stringify({
    open: Boolean(layer),
    stepLabel,
    title,
    targetKey,
    card: box(card),
    spot: box(spot),
    // 同一刻存在多个聚光框说明上一步的节点没被回收，也算缺陷
    spotCount: spots.length,
    target: box(targetEl),
    spotInline: spot ? spot.getAttribute('style') : null,
  });
})()`;

/** 点「下一步 / 开始使用」。用文本匹配：卡片按钮没有稳定类名。 */
const CLICK_NEXT = `(() => {
  const card = document.querySelector('.onb-card');
  if (!card) return 'no-card';
  const buttons = [...card.querySelectorAll('button')];
  const next = buttons.find((b) => /下一步|开始使用/.test(b.textContent || ''));
  if (!next) return 'no-next-button: ' + buttons.map((b) => b.textContent?.trim()).join('|');
  next.click();
  return 'clicked:' + (next.textContent || '').trim();
})()`;

/**
 * 等页面真的可交互，而不是「睡固定秒数后祈祷它编译完了」。
 * 判据：document.readyState 完成 + 引导层已挂载 + 卡片标题已渲染。
 * 用短超时轮询，避免一条 evaluate 挂死整条流程。
 */
const WAIT_READY = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 90; i++) {
    if (
      document.readyState === 'complete' &&
      document.querySelector('.onb-layer') &&
      document.querySelector('.onb-title')?.textContent?.trim()
    ) {
      return JSON.stringify({ ready: true, waitedMs: i * 250 });
    }
    await sleep(250);
  }
  return JSON.stringify({
    ready: false,
    readyState: document.readyState,
    layer: !!document.querySelector('.onb-layer'),
    title: document.querySelector('.onb-title')?.textContent ?? null,
  });
})()`;

/**
 * 等「新的一步真的画完」。
 *
 * 坑（踩了三个）：
 *   1. 不能只按时间等。React 提交后聚光框的 inline style 才会改。
 *   2. 🔴 更隐蔽的：`.onb-spotlight` 上有
 *      `transition: top/left/width/height var(--dur-base)`，而 `--dur-base: 300ms`。
 *      过渡期间 `getBoundingClientRect()` 读到的是**插值中间态** —— 实测连续
 *      四步读到的几何全都「滞后一步」（第 2 步读到的是第 1 步的框）。原来的
 *      实现只等 250ms，正好卡在 300ms 过渡之内，于是量到的永远是上一个框，
 *      进而误判「重叠 63920 px²」。
 *   3. 🔴 「几何连续两次读数完全相同」在线上站不成立：真实页面的盒子会抖动
 *      一两个像素（字体亚像素度量、滚动条、缩放档位），于是这个判据永远等不到
 *      稳定，线上验收卡在第 1 步超时 —— 而本地 dev 恰好不抖，所以没暴露。
 *
 * 最终判据改为**语义条件**而非数值相等：标题已翻到新的一步，**且**聚光框
 * 此刻确实框住了当前步的目标（`framesTarget`，容差 2px）。这个条件在一次
 * PROBE 里原子地取完，天然免疫抖动，而且它本身就是正确性的必要条件 ——
 * 一旦成立，后面的断言必然通过，不必再等什么稳定。
 */
async function waitForSettledStep(conn, prevTitle) {
  const deadline = Date.now() + 15000;
  let lastSeen = null;

  while (Date.now() < deadline) {
    const state = JSON.parse(await evaluate(conn, PROBE));
    const sameStep = Boolean(state.title && state.title !== prevTitle);
    const framed = framesTarget(state.spot, state.target);

    if (sameStep && framed) {
      // 再多取一帧确认不是闪一下：同一条件连续成立两次即可下结论
      await sleep(150);
      const again = JSON.parse(await evaluate(conn, PROBE));
      if (again.title === state.title && framesTarget(again.spot, again.target)) {
        return { settled: true, state: again };
      }
    } else {
      lastSeen = state;
      await sleep(120);
    }
  }

  const finalState = lastSeen ?? JSON.parse(await evaluate(conn, PROBE));
  return { settled: false, state: finalState };
}

/* ─────────────────────── 判定 ─────────────────────── */

function overlapArea(a, b) {
  if (!a || !b) return 0;
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

/** 聚光框是否框住了目标（容差内——聚光框比目标大 PAD*2）。 */
function framesTarget(spot, target, pad = 10) {
  if (!spot || !target) return false;
  const tolerance = 2;
  return (
    Math.abs(spot.x - (target.x - pad)) <= tolerance &&
    Math.abs(spot.y - (target.y - pad)) <= tolerance &&
    Math.abs(spot.w - (target.w + pad * 2)) <= tolerance &&
    Math.abs(spot.h - (target.h + pad * 2)) <= tolerance
  );
}

/* ─────────────────────── 主流程 ─────────────────────── */

const identity = await probeCdpIdentity(CDP_PORT);
if (!identity.mine) {
  console.error(`✗ 端口 ${CDP_PORT} 上没有我的浏览器（${identity.reason}）`);
  console.error('  先跑 node scripts/cf-shell.mjs 启动。');
  process.exit(1);
}

const target = await pickPage();
const conn = await connectPage(target.webSocketDebuggerUrl);
await conn.send('Page.enable');
await conn.send('Runtime.enable');

/*
 * 🔴 必须把页面拉到前台并打开焦点模拟。
 *
 * 后台标签页里 Chrome 会冻结布局：inline style 明明已经改成新值，
 * `getBoundingClientRect()` 却一直返回旧盒子（实测 780ms 里恒为 [0,0,581,747]，
 * 而 style 属性已是仪器架的 575.104/1142.22）。后果是连续四步读到的几何
 * 全部「滞后一步」，进而误判「第 2 步重叠 63920 px²」——
 * 那个结论是测量事故，不是布局 bug。
 *
 * scripts/cdp.mjs 的 doShot 早就因为同一个原因加了这两行，这里漏了。
 */
await conn.send('Page.bringToFront');
await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true });

const results = [];

try {
  /*
   * 干净起点：清掉「已看过」标记，再整页重载（不能用 SPA 内部跳转）。
   *
   * 顺序很关键 —— 必须先导航到被测 origin **再**清 localStorage：
   * localStorage 按 origin 隔离。若当前标签页还停在别处（线上验收时
   * 浏览器默认页可能是 localhost），在那一页清 key 清的是那个 origin
   * 的存储，与目标站毫无关系，目标站的「已看过」标记原封不动，
   * 于是加载后静默不弹引导 —— 报错「引导没有出现」，看着像线上坏了。
   *
   * 所以：先导航 → 等 load → 清 key → 再导航一次。多一次导航换来
   * 「脚本不会验错 origin」，值。
   */
  await conn.send('Page.navigate', { url: START_URL });
  await sleep(1200);
  // 清 key 前必须确认页面已在目标 origin 上，否则清了也没用
  const onTarget = await evaluate(conn, `location.origin === ${JSON.stringify(START_ORIGIN)}`);
  if (!onTarget) {
    const landed = await evaluate(conn, 'location.href');
    console.error(`✗ 导航后不在目标 origin：期望 ${START_ORIGIN}，实际 ${landed}`);
    process.exit(1);
  }
  await evaluate(conn, `(localStorage.removeItem(${JSON.stringify(STORAGE_KEY)}), 'cleared')`);

  // 清完再重载一次，这次才是真正的「首访」状态
  await conn.send('Page.navigate', { url: START_URL });
  await sleep(1200); // 让导航真正开始，再开始轮询

  // 关键：导航后必须等「引导层已挂载」，而不是睡固定秒数 ——
  // dev 首次编译时页面解析能拖到 20s+，固定 sleep 会让下一条 evaluate 撞超时。
  const ready = JSON.parse(await evaluate(conn, WAIT_READY, true));
  if (!ready.ready) {
    console.error(`✗ 页面没等到引导就绪：${JSON.stringify(ready)}`);
    process.exit(1);
  }
  console.log(`  （页面就绪，等待 ${ready.waitedMs} ms）`);

  // 关键：取消过渡与进入动画，只测最终落位（原因见 FREEZE_ANIMATION 注释）
  const frozen = await evaluate(conn, FREEZE_ANIMATION);
  if (!/^(frozen|already)$/.test(frozen)) {
    console.error(`✗ 关不掉动画：${frozen}`);
    process.exit(1);
  }

  const first = JSON.parse(await evaluate(conn, PROBE));
  if (!first.open) {
    console.error('✗ 引导没有出现（清过 localStorage 后首访应当自动弹出）');
    process.exit(1);
  }

  let stepNo = 0;
  for (;;) {
    stepNo += 1;
    const state = JSON.parse(await evaluate(conn, PROBE));
    const stepOverlap = overlapArea(state.card, state.spot);

    const record = {
      step: stepNo,
      label: state.stepLabel,
      title: state.title,
      targetKey: state.targetKey,
      card: state.card,
      spot: state.spot,
      spotCount: state.spotCount,
      spotInline: state.spotInline,
      target: state.target,
      framesTarget: framesTarget(state.spot, state.target),
      overlap: stepOverlap,
    };

    if (WANT_SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      const { data } = await conn.send('Page.captureScreenshot', { format: 'png' });
      const file = join(SHOTS, `onb-${stepNo}-${state.targetKey ?? 'none'}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      record.shot = file;
    }

    results.push(record);

    const isLast = /开始使用/.test(
      (await evaluate(conn, `document.querySelector('.onb-card')?.textContent ?? ''`)) ?? '',
    );
    if (isLast) break;
    if (stepNo > 10) {
      console.error('✗ 步骤数异常（>10），疑似 next() 没有推进');
      break;
    }

    const clicked = await evaluate(conn, CLICK_NEXT);
    if (!/^clicked/.test(clicked)) {
      console.error(`✗ 第 ${stepNo} 步点不到「下一步」：${clicked}`);
      break;
    }
    const waited = await waitForSettledStep(conn, state.title);
    if (!waited.settled) {
      console.error(
        `✗ 第 ${stepNo} 步之后没等到新步骤稳定（title=${waited.state.title} spot=${JSON.stringify(waited.state.spot)}）`,
      );
      break;
    }
  }
} finally {
  conn.close();
}

/* ─────────────────────── 输出 ─────────────────────── */

console.log('');
console.log('引导步骤逐条测量');
console.log('─'.repeat(78));
for (const r of results) {
  const fmt = (b) => (b ? `(${b.x},${b.y}) ${b.w}×${b.h}` : 'null');
  const badge = r.overlap === 0 && r.framesTarget ? '✓' : '✗';
  console.log(`${badge} 第 ${r.step} 步 ${r.label ?? '?'}  ${r.title ?? '?'}  [target=${r.targetKey ?? '-'}]`);
  console.log(`    卡片  ${fmt(r.card)}`);
  console.log(`    聚光  ${fmt(r.spot)}`);
  console.log(`    目标  ${fmt(r.target)}`);
  console.log(`    框对了=${r.framesTarget}  重叠=${r.overlap} px²`);
  if (r.shot) console.log(`    截图  ${r.shot}`);
}
console.log('─'.repeat(78));

const failed = results.filter((r) => r.overlap !== 0 || !r.framesTarget);
const stepCountOk = results.length === 4;
if (failed.length === 0 && stepCountOk) {
  console.log(`✓ ${results.length} 步全部通过：聚光框框住目标，卡片零遮挡`);
  process.exit(0);
}
if (!stepCountOk) console.error(`✗ 步骤数应为 4，实际 ${results.length}`);
for (const r of failed) {
  console.error(`✗ 第 ${r.step} 步不合格：重叠 ${r.overlap} px²，框对了=${r.framesTarget}`);
}
process.exit(1);
