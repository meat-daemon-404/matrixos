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

  /**
   * 高度自适应（`layout.resize` 宿主侧）。
   *
   * 传 `iframeRef.current` 不够 —— ref 变化不会触发 re-render，而这里必须在
   * iframe 真的挂上之后才建桥（否则 `contentWindow` 是 null，消息无处可发）。
   * 所以用 `iframeReady` 作为依赖：`onLoad` 时它翻 true，正好是子站脚本已就绪
   * 的时刻（微站的 `startAutoResize()` 就挂在那个时机附近）。
   */
  usePanelResize({
    stationId: station.id,
    iframe: iframeReady ? iframeRef.current : null,
    panelBody: hostRef.current,
    src,
    enabled: shouldRenderIframe && iframeReady && effectiveMode === 'live',
    ...(process.env.NODE_ENV !== 'production' ? { allowLoopback: true } : {}),
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
    </section>
  );
}
