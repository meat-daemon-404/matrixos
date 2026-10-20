'use client';

/**
 * orbital-hub · 面板高度自适应接线（`layout.resize` 宿主侧）
 * ==========================================================================
 * 决策逻辑全在 `panel-resize.ts`（纯函数，可单测）。本文件只负责**生命周期**：
 * 什么时候建桥、什么时候解绑、窗口 resize 时怎么重算。
 *
 * ## 为什么桥要按「每个 iframe 一份」来建
 *
 * `postMessage` 的收发都是「某个窗口」。hub 里同屏最多 3 个 iframe，每条上报
 * 都得能对应到具体某一格，否则 A 站能把 B 站的面板撑高。所以：
 *   - 每个面板一份 `createHostBridge({ role: 'host', tenantWindow: iframe.contentWindow })`；
 *   - `tenantOrigin` 显式取自 iframe 的 `src` origin（**绝不**由消息学习后信任）；
 *   - 桥上收到的每条消息仍然过 SDK 的 origin 白名单（`OriginAllowList`），
 *     白名单不通过就静默丢弃 —— 这条不被本文件改动，也不允许被放宽。
 *
 * ## 为什么必须等 `contentWindow`
 *
 * `iframe.contentWindow` 在元素挂载后即可读，但此时子站脚本可能还没跑。
 * 桥是「等子站先打招呼」的（host 角色 `handshake()` 立即返回），所以只要
 * listener 挂上了，子站的 `bridge.hello` 到达时就能应答。反过来若在
 * `shouldRenderIframe` 之前建桥，`contentWindow` 是 null，消息无处可发。
 *
 * ## 能力声明
 *
 * host 桥的 `capabilities` 里必须含 `layout.resize`（已加进 SDK 的
 * `BRIDGE_CAPABILITIES`）。子站正是靠 ACK 里的这个能力决定要不要上报 ——
 * 没声明就不发，这是 ADR-10 的向后兼容要求，也让老 hub 不会被新子站打扰。
 */

import { useEffect, useRef } from 'react';
import { createHostBridge, BRIDGE_CAPABILITIES, BRIDGE_MSG, OriginAllowList } from '@matrixos/sdk';
import type { HostBridge } from '@matrixos/sdk';
import { createPanelResizeBinding, type PanelResizeBinding } from './panel-resize';

/** hub 信任的微站 origin 白名单。`allowLoopback` 由调用方按环境决定。 */
export interface PanelResizeOptions {
  readonly stationId: string;
  /** iframe 元素（未创建时为 null）。 */
  readonly iframe: HTMLIFrameElement | null;
  /** `.panel-body` 元素。 */
  readonly panelBody: HTMLDivElement | null;
  /** iframe 的 src；用于取 tenant origin。 */
  readonly src: string;
  readonly enabled: boolean;
  readonly debug?: boolean;
  /** 是否放行 loopback（dev 下 microsite 跑在 localhost:301x）。 */
  readonly allowLoopback?: boolean;
}

/** 从 URL 取 origin；非法返回 null（调用方据此不建桥，而不是退化成 '*'）。 */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * 退回共享的桥与绑定。返回 undefined 表示「本次没有接线」（未启用 / 拿不到 origin）。
 *
 * 用 `useEffect` 而不是在渲染期建桥：建桥会 `addEventListener('message')`，
 * 渲染期做这个会在 StrictMode 双调用与并发渲染下泄漏 listener。
 */
export function usePanelResize(options: PanelResizeOptions): void {
  const bindingRef = useRef<PanelResizeBinding | null>(null);
  const bridgeRef = useRef<HostBridge | null>(null);
  const { stationId, iframe, panelBody, src, enabled, debug, allowLoopback } = options;

  useEffect(() => {
    if (!enabled) return;
    if (iframe === null || panelBody === null) return;
    // contentWindow 读不到（跨源限制/尚未挂载）就不接线：没有可发消息的对端。
    const tenantWindow = iframe.contentWindow;
    if (tenantWindow === null) return;

    const tenantOrigin = originOf(src);
    if (tenantOrigin === null) return;

    const binding = createPanelResizeBinding({
      iframe,
      panelBody,
      ...(debug === undefined ? {} : { debug }),
    });
    bindingRef.current = binding;

    /*
     * 白名单只放行「本站的 origin」+ 已知官方域。
     *
     * 注意这里**不**用 `DEFAULT_ALLOWED_ORIGINS` 兜底放宽：一个面板的桥只该听
     * 它自己那一格的消息，放行整个 `*.matrixos.edu` 意味着理论上另一个站的
     * iframe 也能往这个桥上发。origin 校验是这套协议唯一的信任来源，收窄到
     * 具体 origin 才符合它的设计前提。
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

    const unsubscribe = bridge.on(BRIDGE_MSG.RESIZE, (payload) => {
      binding.handle(payload);
    });

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
      });
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(reflow);
      observer.observe(panelBody);
    }
    window.addEventListener('resize', reflow);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', reflow);
      unsubscribe();
      bridge.close();
      // 解绑时恢复未接管状态：切快照 / 卸载 iframe 后不该留着一份 inline 高度。
      binding.reset();
      bindingRef.current = null;
      bridgeRef.current = null;
    };
  }, [stationId, iframe, panelBody, src, enabled, debug, allowLoopback]);
}
