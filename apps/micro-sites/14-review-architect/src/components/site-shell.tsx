/**
 * ⚠️ 由 scripts/wire-workbench.mjs 从 apps/micro-sites/shared/templates/ 分发，请勿直接修改本文件。
 * 模板：apps/micro-sites/shared/templates/site-shell.tsx
 * 作用：站点外壳（身份 / 元信息 / 仪器面板 / 状态行 / 虫洞接收器）
 * 站点：14 综述拓扑推演与写作舱
 * 轨道：轨道 5 · 工坊 · 域名：review-lab.matrixos.edu
 * 改法：改模板 → 跑 `node scripts/wire-workbench.mjs` 重新分发（18 站会一起更新）。
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { SITE } from '../site.config';
import { Bezel, bezelSource } from '../lib/instrument-facade';
import { SiteInstrument } from './site-instrument';
import {
  initSSO,
  manifestAccepts,
  manifestEmits,
  onWormholeDrop,
  sdkStatus,
  type SdkStatus,
  type SessionState,
  type WormholeReceipt,
} from '../lib/sdk-facade';

/**
 * 站点外壳：身份 → 元信息 → 仪器面板 → 状态行 → 虫洞接收器。
 *
 * 水合安全（踩过 React #418 才这么写）：
 *   `sdkStatus()` 在服务端必然返回「未就位」（没有 window），在浏览器端才可能「已就位」。
 *   若在渲染期直接调用，首帧文本两边不一致 → React 报 hydration mismatch。
 *   所以这里先渲染一个**中性**占位（「检测中」），真实状态只在 effect 里回填。
 */
export function SiteShell() {
  const [embedded, setEmbedded] = useState(false);
  const [status, setStatus] = useState<SdkStatus | null>(null);
  const [session, setSession] = useState<SessionState>({
    phase: 'booting',
    detail: '正在检测宿主与 SDK…',
  });
  const [receipts, setReceipts] = useState<readonly WormholeReceipt[]>([]);

  useEffect(() => {
    const isEmbedded = typeof window !== 'undefined' && window.parent !== window;
    setEmbedded(isEmbedded);
    if (typeof document !== 'undefined') {
      document.body.dataset.embedded = isEmbedded ? 'true' : 'false';
    }

    setStatus(sdkStatus());

    /* 只有真的在 hub iframe 内握手成功才会真发起鉴权（见 sdk-facade 文件头）。 */
    const sso = initSSO((next) => setSession(next));

    const disposeDrop = onWormholeDrop((receipt) => {
      setReceipts((prev) => [receipt, ...prev].slice(0, 5));
    });

    return () => {
      sso.dispose();
      disposeDrop?.();
    };
  }, []);

  const handleManualProbe = useCallback(() => {
    setSession((prev) => ({
      phase: prev.phase,
      uid: prev.uid,
      detail: '通道自检 · ' + sdkStatus().detail,
    }));
  }, []);

  const tone = session.phase === 'ready' ? 'ok' : session.phase === 'booting' ? 'warn' : 'off';

  return (
    <>
      <header className="site-header site-chrome">
        <span className="site-id">{SITE.id}</span>
        <h1 className="site-title">{SITE.name}</h1>
        <span className="site-orbit">{SITE.orbitName}</span>
        <span className="site-domain mono">{SITE.domain}</span>
      </header>

      <dl className="meta-grid">
        <div className="meta-card">
          <dt>UI 形态</dt>
          <dd>{SITE.uiStyle}</dd>
        </div>
        <div className="meta-card">
          <dt>独立台账</dt>
          <dd>{SITE.ledger}</dd>
        </div>
        <div className="meta-card">
          <dt>原型来源</dt>
          <dd>{SITE.source}</dd>
        </div>
      </dl>

      <Bezel className="instrument-slot">
        <SiteInstrument siteId={SITE.id} />
        <div className="status-row">
          <span className="chip" data-tone={tone}>
            MatrixID · {session.phase}
          </span>
          <span className="chip" data-tone={embedded ? 'warn' : 'off'}>
            {embedded ? 'iframe 内嵌' : '独立窗口'}
          </span>
          <span className="chip" data-tone={bezelSource === 'instrument-ui' ? 'ok' : 'off'}>
            面板 · {bezelSource}
          </span>
          <span className="chip" data-tone={status === null ? 'warn' : status.available ? 'ok' : 'off'}>
            SDK · {status === null ? '检测中' : status.available ? '已就位' : '未就位'}
          </span>
          <span className="chip" data-tone={manifestAccepts.length > 0 ? 'ok' : 'off'}>
            accepts · {manifestAccepts.length} 类
          </span>
          <span className="chip" data-tone={manifestEmits.length > 0 ? 'ok' : 'off'}>
            emits · {manifestEmits.length} 类
          </span>
          <button type="button" className="chip" onClick={handleManualProbe}>
            通道自检
          </button>
        </div>
        <p className="mono" style={{ fontSize: 'var(--text-2xs)' }}>
          {session.detail}
        </p>
        {receipts.length > 0 ? (
          <ul className="receipt-list custom-scrollbar">
            {receipts.map((receipt) => (
              <li key={receipt.traceId + receipt.receivedAt}>
                ← {receipt.sourceApp} · {receipt.payloadType} · 证据锚点 {receipt.evidenceCount} 条 ·
                trace {receipt.traceId.slice(0, 8)}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--color-text-faint)' }}>
            虫洞接收器已挂载：等待 hub 投送（当前 0 条收据）。
          </p>
        )}
      </Bezel>
    </>
  );
}
