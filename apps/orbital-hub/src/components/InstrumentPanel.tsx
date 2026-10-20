'use client';

/**
 * InstrumentPanel · 右 68% 里的单个仪器面板
 * ==========================================================================
 * 这个组件的全部设计都是为了 R-T03（iframe 多实例性能崩塌）。
 *
 * 四道防线，按成本从低到高：
 *  1. **mode='dormant' 时根本不渲染 <iframe>** —— 不是 display:none，是 DOM 里没有。
 *     这是最有效的一道：没创建就没运行时、没 hydration、没 SDK 实例。
 *  2. **IntersectionObserver 可见才 hydrate** —— 面板被 3 台布局挤到可视区外时不加载。
 *  3. **iframe 内不滚**（ADR-08 约定），由 hub 控制外层，避免双滚动条引发的重复测量。
 *     高度不再是钉死的：微站通过 `layout.resize` 上报内容真实高，本面板按
 *     `max(内容高, 可用高)` 撑开，超出可用空间的部分由 `.panel-body` 滚动
 *     —— 滚动条在 hub 侧，**iframe 内部仍然不可滚**。见 `lib/panel-resize.ts`。
 *  4. **load 超时 → failed**（ADR-09 L3），显示明确原因而不是永远转圈。
 *
 * 全屏独立打开（A4 强制能力）：用 <a target="_blank" rel="noopener noreferrer">，
 * 不是 window.open —— 前者能被浏览器当普通链接处理（避免弹窗拦截）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MicrositeStation } from '../lib/microsites.generated';
import type { PanelMode } from '../lib/hub-types';
import { usePanelResize } from '../lib/use-panel-resize';
import { useHostBridge } from '../lib/use-host-bridge';
import { useSsoIdtIssuer } from '../lib/use-sso-idt';
import { describePanelNotice } from '../lib/panel-overflow';
// 上限只有这一处定义（`panel-resize.ts`），提示层不另抄一份 —— 见 panel-overflow.ts 文件头。
import { MAX_IFRAME_HEIGHT_PX } from '../lib/panel-resize';
import './panel-overflow.css';

/** iframe 加载超时（ms）。超过就判 failed，别让用户对着骨架屏猜。 */
const LOAD_TIMEOUT_MS = 12000;

/** 静态快照的柱状高度（确定性序列） */
const SNAPSHOT_BARS = [22, 41, 35, 58, 30, 47, 66, 39, 52, 28, 44, 61];

export interface InstrumentPanelProps {
  readonly station: MicrositeStation;
  /** 目标 URL（真实域名或本地 dev server，由 hub-config 解析） */
  readonly src: string;
  readonly mode: PanelMode;
  /** 降级原因（mode='snapshot' 时展示，让降级是可见的而不是静默的） */
  readonly snapshotReason?: string;
  readonly focused: boolean;
  readonly onFocus: () => void;
  readonly onClose: () => void;
  /** 快照态的「升级为全量」按钮：用户手动解除该面板的降级 */
  readonly onPromote?: () => void;
  /** iframe 首次达到 live 时回调（供探针统计冷启动） */
  readonly onFirstLive?: (stationId: string, elapsedMs: number) => void;
}

export function InstrumentPanel({
  station,
  src,
  mode,
  snapshotReason,
  focused,
  onFocus,
  onClose,
  onPromote,
  onFirstLive,
}: InstrumentPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mountedAtRef = useRef<number>(0);
  const [visible, setVisible] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  /** 只有 live 态才真的创建 iframe —— 这是第一道也是最重要的一道防线。 */
  const shouldRenderIframe = mode === 'live' && visible;

  // ── 可见性探测 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'live') return;
    const node = hostRef.current;
    if (!node) return;

    // 不支持 IntersectionObserver 的老浏览器：直接当作可见（宁可加载也别白屏）
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            // 一旦可见就不再撤销：反复卸载/重载 iframe 比让它留着更贵
            observer.disconnect();
            return;
          }
        }
      },
      { threshold: 0.01, rootMargin: '80px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [mode]);

  // ── 加载超时保护 ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!shouldRenderIframe || iframeReady) return;
    const timer = window.setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [shouldRenderIframe, iframeReady]);

  // ── 记录挂载时刻，用于冷启动统计 ──────────────────────────────────────────
  useEffect(() => {
    if (shouldRenderIframe && mountedAtRef.current === 0) {
      mountedAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
  }, [shouldRenderIframe]);

  const handleLoad = useCallback(() => {
    setIframeReady(true);
    const startedAt = mountedAtRef.current;
    if (startedAt > 0 && typeof performance !== 'undefined') {
      onFirstLive?.(station.id, Math.round(performance.now() - startedAt));
    }
  }, [onFirstLive, station.id]);

  /**
   * 降级成快照 / 回升为 live 时把 iframe 相关状态清干净。
   *
   * 这里的 `visible` 必须一起重置，理由是一个真实会发生的手势：
   * 用户挂了 3 台 → 探针降级 → 第 2、3 台变快照（iframe 被卸载）→
   * 用户点第 3 台的「升级为全量」→ 预算落回 1，第 1 台让位、第 3 台转 live。
   * 如果 `visible` 还留着上一轮的 true，iframe 会**立刻**创建；
   * 而那一刻它可能刚被布局挤到可视区外，等于绕过了第二道防线。
   * 重置成 false 后由 IntersectionObserver 重新判定，代价只是多一帧。
   */
  useEffect(() => {
    if (mode !== 'live') {
      setIframeReady(false);
      setTimedOut(false);
      setVisible(false);
      mountedAtRef.current = 0;
    }
  }, [mode]);

  const effectiveMode: PanelMode = timedOut && mode === 'live' ? 'failed' : mode;

  /** 桥是否该工作：只有 live 且 iframe 真的挂上才谈通信。 */
  const bridgeEnabled = shouldRenderIframe && iframeReady && effectiveMode === 'live';

  /**
   * **每个面板唯一的那一个宿主桥**。
   *
   * 建在这里（而不是各自的 hook 里）是刻意的：`layout.resize`（H 线）与
   * `sso.idt.request`（I 线）必须消费**同一个** `HostBridge` 实例。
   * 建两个桥会有两个 `message` listener 抢同一条消息，且各自锁定自己的
   * `peerOrigin` —— SDK 用它防 origin 漂移，分裂后 `sso.idt.ack` 可能发到错的
   * targetOrigin。完整论证见 `lib/use-host-bridge.ts` 文件头。
   *
   * 传 `iframeRef.current` 不够：ref 变化不触发 re-render，而建桥必须等 iframe
   * 真的挂上（否则 `contentWindow` 是 null，消息无处可发）。所以用 `iframeReady`
   * 作为门闩 —— `onLoad` 翻 true 的时刻正好是子站脚本已就绪的时候。
   */
  const hostBridge = useHostBridge({
    stationId: station.id,
    iframe: iframeReady ? iframeRef.current : null,
    src,
    enabled: bridgeEnabled,
    ...(process.env.NODE_ENV !== 'production' ? { allowLoopback: true } : {}),
  });

  /** 高度自适应（H 线）：只消费桥，不建桥。 */
  const resizeState = usePanelResize({
    hostBridge,
    iframe: iframeReady ? iframeRef.current : null,
    panelBody: hostRef.current,
    stationId: station.id,
    enabled: bridgeEnabled,
    ...(process.env.NODE_ENV !== 'production' ? { debug: false } : {}),
  });

  /**
   * 宿主侧签发 `mx_idt`（I 线）。
   *
   * 修的是「内嵌态永远 offline」：微站已经发出 `sso.idt.request`，但 hub 此前
   * 从未订阅它，于是微站只能超时。接线后由 SDK 的 `issueIdtForTenant` 完成
   * 「白名单 → POST /v1/auth/idt → 只回发起方」整条链路。
   *
   * 与上面的 `layout.resize` 挂在**同一个桥**上（SDK 的 `on()` 是 Set 订阅，
   * 多订阅者互不干扰）—— 这正是「一个面板只能有一个桥」约束下的正确用法。
   */
  useSsoIdtIssuer({
    bridge: hostBridge,
    ...(process.env.NODE_ENV !== 'production' ? { debug: true } : {}),
  });

  /*
   * 提示条的数据全部来自上一步的**实测/实报**值，没有一处是推测的：
   *   - `scrollRange > 0` 才能说「装不下」；它是 `usePanelResize` 用**已经写进 DOM
   *     的两个高度**相减得到的（不是重跑 `decidePanelResize`）—— 熔断时决策值会
   *     比实际可滚距离大，用它会向用户报一个滚不到的数值；
   *   - 没上报时说「未接通」，`bridgeWaitMs` 未过宽限期则一律不说（避免狼来了）。
   *
   * 水合安全：`describePanelNotice` 是纯函数，输入的初始值就是全零
   * （`EMPTY_PANEL_RESIZE_STATE`），SSR 与 CSR 首帧因此渲染出完全相同的 DOM
   * —— 这里**不读** `window` / `document` / `Date.now()`，React #418 的成因被从
   * 根上排除，而不是靠 `useEffect` 补一个 `mounted` 标志来规避。
   *
   * 只在 live 态谈桥：snapshot / failed / dormant 下根本没有 iframe，也就无所谓
   * 「自适应接通没接通」，说出来只是噪音。
   */
  const notice = describePanelNotice({
    overflow: {
      scrollRange: resizeState.scrollRange,
      contentHeight: resizeState.contentHeight,
      availableHeight: resizeState.availableHeight,
      iframeHeight: resizeState.iframeHeight,
      maxHeightPx: MAX_IFRAME_HEIGHT_PX,
      frozen: resizeState.frozen,
    },
    bridge:
      shouldRenderIframe && effectiveMode === 'live'
        ? {
            connected: resizeState.connected,
            hasReport: resizeState.hasReport,
            elapsedMs: resizeState.bridgeWaitMs,
          }
        : null,
  });

  const modeLabel =
    effectiveMode === 'live'
      ? '全量'
      : effectiveMode === 'snapshot'
        ? '静态快照'
        : effectiveMode === 'loading'
          ? '加载中'
          : effectiveMode === 'failed'
            ? '不可达'
            : '未激活';

  return (
    <section
      className="panel"
      data-mode={effectiveMode}
      data-focused={focused ? 'true' : 'false'}
      aria-label={station.name + ' 仪器面板'}
      onPointerDown={onFocus}
    >
      <header className="panel-head">
        <span
          className="panel-accent-bar"
          style={{ ['--panel-accent' as string]: station.accent } as React.CSSProperties}
          aria-hidden="true"
        />
        <div className="panel-titles">
          <span className="panel-name">{station.name}</span>
          <span className="panel-meta">
            {station.id} · {station.domain}
          </span>
        </div>
        <span className="panel-head-spacer" />
        <span className="panel-badge" data-mode={effectiveMode}>
          {modeLabel}
        </span>
        {/* [↗ 全屏独立打开] —— 架构 A4 要求每个面板都有 */}
        <a
          className="panel-fullscreen"
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          title={'在新标签页全屏独立打开 ' + station.domain}
        >
          ↗ 全屏独立打开
        </a>
        <button
          type="button"
          className="panel-close"
          onClick={onClose}
          title={'从仪器架移除 ' + station.name}
          aria-label={'从仪器架移除 ' + station.name}
        >
          ✕
        </button>
      </header>

      <div className="panel-body" ref={hostRef}>
        {/* ── 全量 iframe ─────────────────────────────────────────────── */}
        {shouldRenderIframe ? (
          <iframe
            ref={iframeRef}
            className="panel-iframe"
            data-pending={iframeReady ? 'false' : 'true'}
            src={src}
            title={station.name + ' · ' + station.domain}
            // 微站需要脚本与同源能力（SSO 走 mx_idt postMessage）
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            allow="clipboard-write; fullscreen"
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={handleLoad}
          />
        ) : null}

        {/* ── 加载骨架（live 但还没首帧） ─────────────────────────────── */}
        {(mode === 'loading' || (mode === 'live' && !iframeReady)) && !timedOut ? (
          <div className="panel-skeleton" aria-live="polite">
            <div className="panel-skeleton-bar" />
            <span>挂载 {station.domain} …</span>
          </div>
        ) : null}

        {/* ── 静态快照（降级态） ──────────────────────────────────────── */}
        {effectiveMode === 'snapshot' ? (
          <div className="panel-snapshot">
            <span className="snapshot-flag">
              <span aria-hidden="true">◐</span> 静态快照 · 非实时
            </span>
            <div className="snapshot-bars" aria-hidden="true">
              {SNAPSHOT_BARS.map((height, index) => (
                <span key={index} style={{ height: height + '%' }} />
              ))}
            </div>
            <p className="snapshot-desc">{station.desc}</p>
            <p className="snapshot-reason">
              {snapshotReason ?? '多 iframe 性能超预算，已自动降级（R-T03 的预设方案）'}
            </p>
            <div className="snapshot-actions">
              <a className="btn" href={src} target="_blank" rel="noopener noreferrer">
                ↗ 独立打开（全量）
              </a>
              {onPromote ? (
                <button type="button" className="btn" onClick={onPromote}>
                  ⚡ 升级为全量挂载
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── 失败态（ADR-09 L3：明确原因，不白屏） ────────────────────── */}
        {effectiveMode === 'failed' ? (
          <div className="panel-snapshot">
            <span className="snapshot-flag" style={{ borderColor: 'rgba(244,63,94,.55)' }}>
              <span aria-hidden="true">✕</span> 微站不可达
            </span>
            <p className="snapshot-desc">{station.desc}</p>
            <p className="snapshot-reason">
              {timedOut
                ? LOAD_TIMEOUT_MS / 1000 + 's 内未完成首帧（可能未启动或维护中）'
                : '加载失败'}
              {' · '}
              <span className="mono">{src}</span>
            </p>
            <div className="snapshot-actions">
              <a className="btn" href={src} target="_blank" rel="noopener noreferrer">
                ↗ 独立打开排查
              </a>
            </div>
          </div>
        ) : null}

        {/* ── 未激活（dormant）：只提示，绝不建 iframe ─────────────────── */}
        {effectiveMode === 'dormant' ? (
          <div className="panel-skeleton">
            <span>面板已保留但未激活（未创建 iframe）</span>
            <span style={{ color: 'var(--color-text-faint)' }}>点击面板标题栏或星轨胶囊激活</span>
          </div>
        ) : null}
      </div>

      {/*
        ── 内容溢出 / 自适应未接通 的提示条（ADR-09） ─────────────────────
        放在 `.panel-body` **之外**、`.panel` 的最后一个孩子：
          - 不覆盖 iframe 一个像素，因此绝不会挡住微站交互（若用 absolute 浮层，
            「滚动条底部」恰是最需要点的位置，挡住就是新 bug）；
          - 它是 flex 里 `flex: none` 的一条，占 18px 会把 `.panel-body` 压小 18px，
            这次变化经 ResizeObserver 正常回流到 `decidePanelResize`，方向单一
            （可用高只会变小 → 溢出判定只会更保守），不存在来回振荡。
        用 `role="status"` + `aria-live="polite"`：读屏用户也要能知道内容被裁了。
      */}
      {notice.visible ? (
        <div
          className="panel-overflow"
          data-kind={notice.kind}
          role="status"
          aria-live="polite"
          title={notice.detail}
        >
          <span aria-hidden="true">{notice.kind === 'bridge-gap' ? '⚠' : '⇅'}</span>
          <span className="panel-overflow-text">{notice.text}</span>
          <a className="panel-overflow-action" href={src} target="_blank" rel="noopener noreferrer">
            {notice.action}
          </a>
        </div>
      ) : null}
    </section>
  );
}
