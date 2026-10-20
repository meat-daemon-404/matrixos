'use client';

/**
 * orbital-hub · 每个面板一份的**共享宿主桥**
 * ==========================================================================
 * 一个面板只允许有**一个** `HostBridge` 实例。这个约束不是洁癖，是协议要求：
 *
 * `createHostBridge()` 内部第一件事就是 `win.addEventListener('message', onMessage)`。
 * 如果为 `layout.resize`（H 线）和 `sso.idt`（I 线）各建一个桥，同一个面板上就会
 * 挂着**两个 listener**，而它们共享同一个 `window`：
 *
 *   1. **消息竞争**：每条 `bridge.hello` 会被两个桥各处理一遍，各自回一条 ACK，
 *      子站收到两条 ACK（幂等所以不炸，但纯属浪费 + 日志污染）；
 *   2. **origin 学习状态分裂**：SDK 的桥在收到第一条通过白名单的消息时
 *      用 `peerOrigin = event.origin` **锁定**对端 origin（防 origin 漂移）。
 *      两个桥各自锁定自己看到的那条 —— 若其中一个先收到 `layout.resize`、
 *      另一个先收到 `sso.idt.request`，它们的 `peerOrigin` 可能不同，
 *      之后发 `sso.idt.ack` 时就可能用错 targetOrigin（消息石沉大海）；
 *   3. **生命周期不一致**：H 线的桥在 `iframe` 换 src 时被 close/重建，
 *      若 SSO 的桥还活着，它就指向已销毁的 `contentWindow`。
 *
 * 所以这里把「建桥」抽成唯一入口：两个 hook 都**消费**同一个实例，
 * 谁也不 new 第二个。`useHostBridge` 返回不可变句柄，订阅方（`panel-resize`
 * 与 `sso-idt`）各自 `on()` 自己关心的事件，互不干扰 —— `on()` 是 Set 订阅，
 * 天然支持多订阅者。
 *
 * ## 为什么不把桥放进 React state
 *
 * 桥是**有副作用的对象**（listener、定时器、队列）。放 state 会让它参与
 * render 相等性比较，并在 StrictMode 双渲染下被重复创建。用 ref 持有、
 * 用一个 `version` 计数器通知「桥换了」，是 React 里管理这种情况的标准做法：
 * 订阅方依赖 `version` 而不是桥对象本身，既不会漏重建，也不会因引用变化而抖动。
 */

import { useEffect, useRef, useState } from 'react';
import { createHostBridge, BRIDGE_CAPABILITIES, OriginAllowList } from '@matrixos/sdk';
import type { HostBridge } from '@matrixos/sdk';

/** 从 URL 取 origin；非法返回 null（调用方据此不建桥，而不是退化成 '*'）。 */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

export interface HostBridgeOptions {
  /** 面板标识，仅用于调试输出。 */
  readonly stationId: string;
  /** iframe 元素（未创建时为 null）。 */
  readonly iframe: HTMLIFrameElement | null;
  /** iframe 的 src；用于取 tenant origin。 */
  readonly src: string;
  readonly enabled: boolean;
  readonly debug?: boolean;
  /** 是否放行 loopback（dev 下微站跑在 localhost:301x）。 */
  readonly allowLoopback?: boolean;
}

export interface HostBridgeHandle {
  /** 当前桥实例；未就绪（iframe 未挂载 / 未启用 / origin 非法）时为 null。 */
  readonly bridge: HostBridge | null;
  /**
   * 桥的「代际」计数器。
   *
   * 每次桥被重建（iframe 换 src、面板重新激活）就 +1。订阅方应把它放进
   * `useEffect` 依赖里：**依赖 version 而不是 bridge 对象**，这样
   *   - 桥重建 → version 变 → 订阅方重挂 listener（不会漏掉新桥的事件）；
   *   - 桥未变 → version 不变 → 不会因为 ref 对象引用相同而误判「没变化」，
   *     也不会因为它不同而误重建。
   */
  readonly version: number;
}

/**
 * 为一个面板建（并持有）宿主桥。
 *
 * 调用方必须保证**同一面板只调一次** —— 这正是本 hook 存在的意义：
 * `usePanelResize` 与 `useSsoIdtIssuer` 都从它拿桥，而不是各自建。
 *
 * @returns 句柄；`bridge === null` 表示当前无法通信（尚未挂载 / 已解绑）。
 */
export function useHostBridge(options: HostBridgeOptions): HostBridgeHandle {
  const bridgeRef = useRef<HostBridge | null>(null);
  const [version, setVersion] = useState(0);
  const { stationId, iframe, src, enabled, debug, allowLoopback } = options;

  useEffect(() => {
    if (!enabled) {
      // 未启用：确保旧桥被关掉（切快照 / 降级时不能留 listener）。
      if (bridgeRef.current !== null) {
        bridgeRef.current.close();
        bridgeRef.current = null;
        setVersion((v) => v + 1);
      }
      return;
    }
    if (iframe === null) return;

    const tenantWindow = iframe.contentWindow;
    if (tenantWindow === null) return;

    const tenantOrigin = originOf(src);
    if (tenantOrigin === null) return;

    /*
     * 白名单只放行「本站的 origin」。
     *
     * 刻意**不**用 `DEFAULT_ALLOWED_ORIGINS` 兜底放宽：一个面板的桥只该听它自己
     * 那一格的消息，放行整个 `*.matrixos.edu` 意味着理论上另一个站的 iframe
     * 也能往这个桥上发。origin 校验是这套协议唯一的信任来源，收窄到具体 origin
     * 才符合它的设计前提。
     *
     * `allowLoopback` 只在 dev 下由调用方传 true；生产构建里微站与 hub 都是
     * https 真域名，不需要它。
     */
    const allowedOrigins = new OriginAllowList([tenantOrigin], {
      allowLoopback: allowLoopback === true,
    });

    const bridge = createHostBridge({
      env: {
        hasDOM: true,
        win: window as never,
        doc: { cookie: document.cookie } as never,
        inIframe: false,
        origin: window.location.origin,
        href: window.location.href,
        fetchImpl: null,
        now: () => Date.now(),
        randomUUID: () => crypto.randomUUID(),
      },
      allowedOrigins,
      role: 'host',
      tenantOrigin,
      tenantWindow: tenantWindow as never,
      capabilities: BRIDGE_CAPABILITIES,
      ...(debug === undefined ? {} : { debug }),
    });

    bridgeRef.current = bridge;
    setVersion((v) => v + 1);

    return () => {
      // 桥换了/面板卸载：关掉旧桥（移除 listener、清队列、拒绝 pending）。
      // 订阅方会因为 version 变化而在自己的 cleanup 里解绑，顺序无关：
      // `close()` 会 `listeners.clear()`，重复解绑是安全的。
      bridge.close();
      if (bridgeRef.current === bridge) {
        bridgeRef.current = null;
      }
    };
  }, [stationId, iframe, src, enabled, debug, allowLoopback]);

  return { bridge: bridgeRef.current, version };
}
