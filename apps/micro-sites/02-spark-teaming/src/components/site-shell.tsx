/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：02 双创互补组队雷达
 * 轨道：轨道 2 · 星火 · 域名：spark.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=02 --force
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SITE } from '../site.config';
import { Bezel, bezelSource } from '../lib/instrument-facade';
import { SiteInstrument } from './site-instrument';
import {
  initSSO,
  onWormholeDrop,
  sdkStatus,
  type SessionState,
  type WormholeReceipt,
} from '../lib/sdk-facade';

export function SiteShell() {
  const [embedded, setEmbedded] = useState(false);
  const [session, setSession] = useState<SessionState>({
    phase: 'booting',
    detail: '正在初始化 MatrixID…',
  });
  const [receipts, setReceipts] = useState<readonly WormholeReceipt[]>([]);

  const status = useMemo(() => sdkStatus(), []);

  useEffect(() => {
    const isEmbedded = typeof window !== 'undefined' && window.parent !== window;
    setEmbedded(isEmbedded);
    if (typeof document !== 'undefined') {
      document.body.dataset.embedded = isEmbedded ? 'true' : 'false';
    }

    const sso = initSSO(
      {
        stationId: SITE.id,
        audience: SITE.appId,
        embedded: isEmbedded,
      },
      (next) => setSession(next),
    );

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
      detail:
        '通道自检 · ' +
        (status.available ? 'SDK 符号可用：' + status.symbols.join(' / ') : 'SDK 未就位'),
    }));
  }, [status]);

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
          <span className="chip" data-tone={status.available ? 'ok' : 'off'}>
            SDK · {status.available ? '已就位' : '未就位'}
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
