'use client';

/**
 * orbital-hub · 面板高度自适应接线（`layout.resize` 宿主侧）
 * ==========================================================================
 * 决策逻辑全在 `panel-resize.ts`（纯函数，可单测）。本文件只负责**生命周期**：
 * 什么时候建桥、什么时候解绑、窗口 resize 时怎么重算，以及把「当前到底接没接通、
 * 内容装不装得下」如实回传给组件（ADR-09：受限状态必须显式可见）。
 *
 * ## 桥由 `useHostBridge` 统一建（不在本文件创建）
 *
 * `postMessage` 的收发都是「某个窗口」。hub 里同屏最多 3 个 iframe，每条上报
 * 都得能对应到具体某一格，否则 A 站能把 B 站的面板撑高。所以仍然是
 * **每个面板一份** `HostBridge`，但创建动作收敛到 `use-host-bridge.ts` 一处：
 *   - 本 hook（`layout.resize`）与 `useSsoIdtIssuer`（`sso.idt.request`）**共用**
 *     同一个实例 —— 建两个桥会让两个 listener 抢同一条消息、各自锁定自己的
 *     `peerOrigin`（SDK 用它防 origin 漂移），详见 `use-host-bridge.ts` 文件头；
 *   - `tenantOrigin` 显式取自 iframe 的 `src` origin（**绝不**由消息学习后信任）；
 *   - 桥上收到的每条消息仍然过 SDK 的 origin 白名单（`OriginAllowList`），
 *     白名单不通过就静默丢弃 —— 这条不被本文件改动，也不允许被放宽。
 *
 * ## 为什么建桥后要**主动**打招呼（本轮修复的核心之一）
 *
 * SDK 的 host 桥协议是「等子站先 hello，宿主回 ACK」。这个方向在**两端时序都对**
 * 时没问题，但宿主这一侧从没主动发过 hello，于是整条链路只有一个唤醒源：
 * 子站那一次 `bridge.handshake()`。只要子站的 hello 落在宿主 listener 挂上之前
 * （`iframe onLoad` 往往早于 React 的 effect），这条消息就永久丢失，之后：
 *   - 宿主 listener 挂好了，但它不会主动说话；
 *   - 子站这边 `negotiate()` 的重试窗口（3 次 × 1.5s）用完就判「宿主未声明能力」，
 *     永久降级为不上报 —— 于是 `layout.resize` 全程从未生效。
 *
 * 宿主主动发一次 hello 就把「单点唤醒」变成「双向唤醒」：即便子站的第一次 hello
 * 丢了，宿主这条 hello 仍会唤醒子站回 ACK，两边同时 markConnected。
 * host 角色的 `handshake()` 会立刻 post hello 并**立即 resolve**（不等超时），
 * 所以这里 `void` 掉它不会阻塞该 effect，也不改变「不关心握手结果」的语义。
 *
 * 注意：**不改 SDK、不改 origin 白名单**。白名单只管收侧信任，与谁先说话无关；
 * 主动握手能修的是时序，修不了「宿主 origin 本身不被信任」。那一半归 Lead。
 *
 * ## 为什么必须等 `contentWindow`
 *
 * `iframe.contentWindow` 在元素挂载后即可读，但此时子站脚本可能还没跑。
 * 反过来若在 `shouldRenderIframe` 之前建桥，`contentWindow` 是 null，消息无处可发。
 *
 * ## 能力声明
 *
 * host 桥的 `capabilities` 里必须含 `layout.resize`（已加进 SDK 的
 * `BRIDGE_CAPABILITIES`）。子站正是靠 ACK 里的这个能力决定要不要上报 ——
 * 没声明就不发，这是 ADR-10 的向后兼容要求，也让老 hub 不会被新子站打扰。
 *
 * ## 回传状态为什么是「快照对象」而不是 live getter
 *
 * 组件要据 `scrollRange > 0` 决定是否显示提示，这必须触发 re-render。
 * `binding.stats` 是一组 getter，读它不产生渲染信号；所以在事件点（收到上报 /
 * 桥连上 / 宽限期到点）把当时的数值快照成一个小对象塞进 state。
 * 快照是**只读派生值**，不回写 binding —— `panel-resize.ts` 的纯函数语义不动。
 */

import { useEffect, useRef, useState } from 'react';
import { BRIDGE_MSG } from '@matrixos/sdk';
import type { HostBridge } from '@matrixos/sdk';
import { createPanelResizeBinding, type PanelResizeBinding } from './panel-resize';
import { PANEL_BRIDGE_GRACE_MS } from './panel-overflow';
import type { HostBridgeHandle } from './use-host-bridge';

/**
 * 接线参数。
 *
 * ⚠️ **桥不再由本 hook 创建**：改由 `useHostBridge(...)` 统一建一次，
 * 本 hook 与 `useSsoIdtIssuer` 共用同一个实例。原因是 `createHostBridge()`
 * 会 `window.addEventListener('message')` —— 一个面板建两个桥，就有两个
 * listener 抢同一条消息、且各自锁定自己的 `peerOrigin`（SDK 用它防 origin
 * 漂移）。三段论证见 `use-host-bridge.ts` 文件头。
 */
export interface PanelResizeOptions {
  /**
   * 共享的宿主桥句柄。`bridge === null` 表示还没法通信（iframe 未挂载 /
   * origin 非法）—— 此时本 hook 只归零状态，不建任何东西。
   */
  readonly hostBridge: HostBridgeHandle;
  /**
   * iframe 元素 —— 仅用于**写高度**（`decidePanelResize` 的结果要落到 DOM 上）。
   * 它**不**参与建桥：桥的目标窗口由 `useHostBridge` 在内部取
   * `iframe.contentWindow` 后交给 SDK，两处用的是同一个元素。
   */
  readonly iframe: HTMLIFrameElement | null;
  /** `.panel-body` 元素。 */
  readonly panelBody: HTMLDivElement | null;
  /** 面板标识，仅用于排障日志。 */
  readonly stationId: string;
  readonly enabled: boolean;
  readonly debug?: boolean;
}

/**
 * 面板高度自适应的**只读**运行时状态。全部字段都是「当时实测/实报」的值，
 * 没有任何推测 —— 桥没连上就 `connected: false`，没收到上报就 `hasReport: false`。
 */
export interface PanelResizeState {
  /** 宿主桥是否已完成握手（双向 hello/ACK，`markConnected()` 已发生）。 */
  readonly connected: boolean;
  /** 是否收到过至少一条通过载荷校验的 `layout.resize`。 */
  readonly hasReport: boolean;
  /** 可滚动距离（px）。`> 0` 意味着内容真的装不下、滚动条在 hub 侧。 */
  readonly scrollRange: number;
  /** 微站上报的内容高（px，clamp 前）。 */
  readonly contentHeight: number;
  /** `.panel-body` 当前可用高（px）。 */
  readonly availableHeight: number;
  /** 已应用到 iframe 的高度（px，含上限 clamp）。 */
  readonly iframeHeight: number;
  /** 收侧熔断是否触发（连续「只涨」被停住）。 */
  readonly frozen: boolean;
  /**
   * 建桥后已经等了多久（ms）。宽限期内为 0 —— 组件据此**不报**「没上报」，
   * 因为 iframe 刚 load 的几百毫秒里没有上报是正常的。
   */
  readonly bridgeWaitMs: number;
}

/**
 * 初始状态。必须与 SSR 完全一致（全零、未连通），否则首帧文本会在
 * hydration 时对不上 —— 仓库踩过 React #418。共享常量而非每次 new，
 * 也让「没有变化」的 setState 能靠引用相等直接 bail out。
 */
export const EMPTY_PANEL_RESIZE_STATE: PanelResizeState = Object.freeze({
  connected: false,
  hasReport: false,
  scrollRange: 0,
  contentHeight: 0,
  availableHeight: 0,
  iframeHeight: 0,
  frozen: false,
  bridgeWaitMs: 0,
});

/** 逐字段比较，避免在高频事件（窗口 resize / 上报）里制造无变化的重渲染。 */
function sameState(a: PanelResizeState, b: PanelResizeState): boolean {
  return (
    a.connected === b.connected &&
    a.hasReport === b.hasReport &&
    a.scrollRange === b.scrollRange &&
    a.contentHeight === b.contentHeight &&
    a.availableHeight === b.availableHeight &&
    a.iframeHeight === b.iframeHeight &&
    a.frozen === b.frozen &&
    a.bridgeWaitMs === b.bridgeWaitMs
  );
}

/**
 * 接线并返回只读状态。
 *
 * 桥从 `hostBridge` 拿来（由 `useHostBridge` 建），本 hook **不创建**桥。
 * 订阅与解绑都放在 `useEffect` 里：`bridge.on()` 会往 Set 里加 handler，
 * 渲染期做这个会在 StrictMode 双调用下泄漏订阅。
 */
export function usePanelResize(options: PanelResizeOptions): PanelResizeState {
  const bindingRef = useRef<PanelResizeBinding | null>(null);
  const [state, setState] = useState<PanelResizeState>(EMPTY_PANEL_RESIZE_STATE);
  const { hostBridge, iframe, panelBody, stationId, enabled, debug } = options;

  /*
   * 桥实例与它的「代际」都进依赖：桥被重建（换 src）时 version 会变，
   * 本 effect 随之重挂订阅。只依赖对象引用不够稳 —— ref 持有的是同一个可变
   * 容器，对象换了引用本身可能没变，靠 version 才是可靠信号。
   */
  const bridge: HostBridge | null = hostBridge.bridge;
  const bridgeVersion = hostBridge.version;

  useEffect(() => {
    // 未启用：把状态归零（否则切快照/降级后旧数字会留在提示条上）。
    if (!enabled) {
      setState((prev) => (prev === EMPTY_PANEL_RESIZE_STATE ? prev : EMPTY_PANEL_RESIZE_STATE));
      return;
    }
    // 桥没就绪（iframe 未挂载 / origin 非法）：不接线，状态保持全零。
    if (bridge === null || iframe === null || panelBody === null) return;

    const binding = createPanelResizeBinding({
      iframe,
      panelBody,
      ...(debug === undefined ? {} : { debug }),
    });
    bindingRef.current = binding;

    /*
     * 宽限期计时器的可变载体。
     *
     * 声明在 `sync` 之前：`sync` 每次都从它取「已经等了多久」，而计时器到点后
     * 才第一次写入真值。放在 `sync` 后面虽然靠闭包也能跑（调用总在声明之后），
     * 但读代码的人要在两屏之外找声明 —— 顺序直白比省一行重要。
     */
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const waitRef = { value: 0 };

    /** 把 binding + 桥的当前事实快照成 state；无变化则不触发重渲染。 */
    const sync = (bridgeWaitMs: number): void => {
      const next: PanelResizeState = {
        connected: bridge.connected,
        hasReport: binding.stats.received > 0,
        /*
         * `scrollRange` 取**已真正写进 DOM 的两个值**相减，而不是重跑一遍
         * `decidePanelResize`。
         *
         * 理由是熔断：收侧一旦 `frozen`，`apply()` 就不再写新高度，而
         * `decidePanelResize` 会继续按「假如撑到内容高」算出更大的数。若这里
         * 用决策值，提示条就会宣称一个用户实际滚不到的距离 —— 那是对用户撒谎。
         * 用 `stats.iframeHeight - stats.availableHeight` 得到的永远是「现在真的
         * 还能往下滚多少」，与用户滚动条的手感一致。
         *
         * 这两个 getter 都是实时读的：`availableHeight` 会重新量 `.panel-body`，
         * 所以窗口拖动后提示条能跟着翻转，不需要等微站再上报一次。
         */
        scrollRange: Math.max(0, binding.stats.iframeHeight - binding.stats.availableHeight),
        contentHeight: binding.stats.lastContentHeight,
        availableHeight: binding.stats.availableHeight,
        iframeHeight: binding.stats.iframeHeight,
        frozen: binding.stats.frozen,
        bridgeWaitMs,
      };
      setState((prev) => (sameState(prev, next) ? prev : next));
    };

    const unsubscribe = bridge.on(BRIDGE_MSG.RESIZE, (payload) => {
      binding.handle(payload);
      // 上报处理完立刻同步：`scrollRange` 是提示条唯一的开关。
      sync(waitRef.value);
    });

    /*
     * 桥连上（收到 hello 或 ACK 都会走到 `bridge.connected` 这个本地事件）时
     * 也同步一次 —— 「连上了但微站不上报」与「压根没连上」是两种不同的故障，
     * 提示文案必须能区分，所以 connected 必须被回传。
     */
    const unsubscribeConnected = bridge.on('bridge.connected', () => {
      sync(waitRef.value);
    });

    /*
     * 主动握手（见文件头「为什么建桥后要主动打招呼」）。
     *
     * 顺序：先 `on()` 订阅、后 handshake。虽然 host 的 handshake 只是往外 post
     * 一条 hello（ACK 是异步回来的），但订阅放在前面可以保证**任何**回调都不会
     * 落在没人听的窗口里 —— 这个 effect 本身不 await，所以顺序只是防御性写法。
     */
    void bridge.handshake();

    /*
     * 宽限期计时：超过 `PANEL_BRIDGE_GRACE_MS` 仍没有任何上报时，才允许组件
     * 提示「自适应未接通」。提前提示等于狼来了 —— iframe 首字节到子站 SDK 建桥
     * 本身就要几百毫秒，那段时间「没上报」是正常的。
     */
    const graceTimer = window.setTimeout(() => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      waitRef.value = Math.max(0, Math.round(now - startedAt));
      sync(waitRef.value);
    }, PANEL_BRIDGE_GRACE_MS);

    /*
     * 可用空间变化时重算。两个触发源都要，缺一不可：
     *   - `ResizeObserver` 覆盖「面板布局变了」（同屏 1→2→3 台时 grid 重分配）；
     *   - `window.resize` 覆盖「浏览器窗口变了」（807 vs 627 就是这一维）。
     * 后者其实也会引起前者，但 `.panel-body` 高度不变而 `iframe` 宽度变的情形
     * （只改宽度）下，内容可能因换行而变高，此时两边都不会触发 —— 那种情况
     * 由微站自己的 ResizeObserver 上报解决，hub 侧无需额外处理。
     */
    let frame = 0;
    const reflow = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        binding.reflow();
        // 重算后可用高可能变了：同步一次，让提示条跟着「装得下/装不下」翻转。
        sync(waitRef.value);
      });
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(reflow);
      observer.observe(panelBody);
    }
    window.addEventListener('resize', reflow);

    return () => {
      window.clearTimeout(graceTimer);
      if (frame !== 0) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', reflow);
      unsubscribe();
      unsubscribeConnected();
      /*
       * ⚠️ **绝不在这里 `bridge.close()`**：桥是共享的，`useSsoIdtIssuer`
       * 还在上面挂着 `sso.idt.request` 订阅。关掉它等于把 SSO 一起拆了
       * —— 而本 hook 的 cleanup 会因窗口 resize 以外的原因（如 iframe 重挂）
       * 频繁触发，那会造成 SSO 静默断开却看不出原因。
       * 桥的生死归 `useHostBridge` 的 effect 管，它才是唯一 owner。
       */
      // 解绑时恢复未接管状态：切快照 / 卸载 iframe 后不该留着一份 inline 高度。
      binding.reset();
      bindingRef.current = null;
      setState((prev) => (prev === EMPTY_PANEL_RESIZE_STATE ? prev : EMPTY_PANEL_RESIZE_STATE));
    };
  }, [bridge, bridgeVersion, stationId, iframe, panelBody, enabled, debug]);

  return state;
}
