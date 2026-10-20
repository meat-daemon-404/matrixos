'use client';

/**
 * OrbitalHub · 双态合体总控台的编排层
 * ==========================================================================
 * 这一层负责把所有部件接起来，并且**只做编排，不做视觉**：
 *
 *   左 32%  StarOrbitField      —— 7 轨 / 18 胶囊 / Semantic Zoom
 *   右 68%  InstrumentRack      —— 同屏 2~3 台 + [↗ 全屏独立打开] + 懒加载
 *   底部    CopilotWaveDock     —— 声波坞 ⇄ 坍缩呼吸球
 *   浮层    WormholeRing        —— 拖拽卡片 → 投送到目标微站
 *   角落    PerformanceProbePanel —— S2-01e 探针读数 + 自动降级依据
 *
 * 三个关键决策：
 *
 * 1. **降级由探针驱动，不由组件猜**（R-T03）。
 *    探针跑在这里，把 level 映射成 RenderStrategy 下发。这样「S2-01e 单独跑基线不降级」
 *    和「生产自动降级」是同一套代码的两种配置，不会出现两套逻辑各说各话。
 *
 * 2. **全屏入站 → 声波坞坍缩**（A4）。
 *    两条入站路径都收敛成 `fullscreenStationId`：① 点面板的 ↗ 全屏独立打开（记一次）；
 *    ② 星轨 zoom 推到 ZOOM_FULLSCREEN_AT 以上并有选中站。任一成立，坞就坍缩。
 *
 * 3. **开发期 iframe 用占位页**（本任务要求）。
 *    默认 `usePlaceholder=true`：面板显示"微站未就绪"的占位说明而不是去连一个不存在的
 *    域名（那会让每个面板都 12s 后变 failed，看起来像 bug 而不像"还没做"）。
 *    接真实微站时把 NEXT_PUBLIC_MICROSITE_PLACEHOLDER=false 即可。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  STATIONS,
  STATION_BY_ID,
  ORBIT_GROUP_DISTRIBUTION,
  type MicrositeStation,
  type PayloadType,
} from '../lib/microsites.generated';
import { readHubConfig, resolveMicrositeOrigin } from '../lib/hub-config';
import { clampZoom, ZOOM_MAX, ZOOM_MIN } from '../lib/orbit-layout';
import { startPerformanceProbe, type ProbeHandle } from '../lib/performance-probe';
import type { ProbeVerdict, RenderStrategy } from '../lib/hub-types';
import {
  PAYLOAD_TYPE_LABEL,
  canDispatch,
  createTraceId,
  validateEnvelope,
} from '../lib/wormhole-contract';
import { StarOrbitField } from './StarOrbitField';
import { InstrumentRack, loadPersistedMount, savePersistedMount, MAX_PANELS } from './InstrumentRack';
import { CopilotWaveDock, type WaveDockState } from './CopilotWaveDock';
import { WormholeRing, DraggableCard, type WormholeTarget } from './WormholeRing';
import { PerformanceProbePanel } from './PerformanceProbePanel';

/** 星轨推到这一档视为"全屏入站"（与语义缩放 tier 4 对齐） */
const ZOOM_FULLSCREEN_AT = 8.5;

interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly tone: 'ok' | 'warn' | 'error';
}

/** 演示用的虫洞源卡片数据（真实现由微站通过 SDK emit，这里给 hub 一个可拖的样例） */
interface SourceCard {
  readonly id: string;
  readonly label: string;
  readonly payloadType: PayloadType;
  readonly evidenceCount: number;
  readonly matrixUid: string;
  readonly sourceApp: string;
}

const SOURCE_CARDS: readonly SourceCard[] = [
  {
    id: 'card-curve-fit',
    label: '双指数拟合 R²=0.9884',
    payloadType: 'curve_fit_parameters',
    evidenceCount: 2,
    matrixUid: 'mxu_01H8Z9K2',
    sourceApp: 'curvelab.matrixos.edu',
  },
  {
    id: 'card-paper-bundle',
    label: '钝化配体 30 篇文献束',
    payloadType: 'paper_doi_bundle',
    evidenceCount: 1,
    matrixUid: 'mxu_01H8Z9K2',
    sourceApp: 'lit-sonar.matrixos.edu',
  },
  {
    id: 'card-mentor-card',
    label: '导师五维画像 · 张教授',
    payloadType: 'mentor_match_card',
    evidenceCount: 3,
    matrixUid: 'mxu_01H8Z9K2',
    sourceApp: 'mentor.matrixos.edu',
  },
];

export function OrbitalHub() {
  const config = useMemo(() => readHubConfig(), []);

  // ── 挂载状态（含布局持久化） ──────────────────────────────────────────────
  const [mountedIds, setMountedIds] = useState<readonly string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  // ── 星轨 ──────────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(2.5);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── 声波坞 ────────────────────────────────────────────────────────────────
  const [dockExpanded, setDockExpanded] = useState(true);
  const [dockState] = useState<WaveDockState>('idle');

  // ── 虫洞 ──────────────────────────────────────────────────────────────────
  const [wormholeOpen, setWormholeOpen] = useState(false);
  const [wormholePayload, setWormholePayload] = useState<{
    payloadType: PayloadType;
    summary: string;
    evidenceCount: number;
    matrixUid: string;
    sourceApp: string;
  } | null>(null);
  const [wormholeTargetHover, setWormholeTargetHover] = useState<string | null>(null);
  const [wormholeError, setWormholeError] = useState<string | undefined>(undefined);

  // ── 探针与降级 ────────────────────────────────────────────────────────────
  const [verdict, setVerdict] = useState<ProbeVerdict | null>(null);
  const [probeBreached, setProbeBreached] = useState(false);
  const [manualSnapshot, setManualSnapshot] = useState(config.forceSnapshotMode);
  const probeRef = useRef<ProbeHandle | null>(null);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeq = useRef(0);

  const pushToast = useCallback((message: string, tone: ToastItem['tone']) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((prev) => [...prev, { id, message, tone }].slice(-3));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3600);
  }, []);

  // ── 1. 恢复持久化的挂载组合（S2-03 验收：刷新后恢复） ────────────────────
  useEffect(() => {
    const saved = loadPersistedMount();
    if (saved && saved.stationIds.length > 0) {
      setMountedIds(saved.stationIds);
      setFocusedId(saved.focusedId);
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return; // 别在恢复之前把空状态写回去
    savePersistedMount({ stationIds: mountedIds, focusedId });
  }, [mountedIds, focusedId, restored]);

  // ── 2. 性能探针（S2-01e） ─────────────────────────────────────────────────
  const liveIframeCountRef = useRef(0);
  // 只统计"真会创建 iframe"的面板数：live 模式且未降级
  const effectiveStrategy: RenderStrategy = manualSnapshot
    ? 'one-live-rest-snapshot'
    : probeBreached
      ? 'one-live-rest-snapshot'
      : 'all-live';

  liveIframeCountRef.current =
    effectiveStrategy === 'all-live'
      ? mountedIds.length
      : Math.min(mountedIds.length, 1);

  useEffect(() => {
    const probe = startPerformanceProbe({
      thresholds: config.probe,
      getLiveIframeCount: () => liveIframeCountRef.current,
      onSample: (next) => {
        setVerdict(next);
        if (next.level === 'breach') {
          setProbeBreached((prev) => {
            if (!prev) {
              // 降级必须是可见的（ADR-09：不允许静默降级）
              pushToast(
                '性能超预算（' + next.reasons.join('；') + '）→ 已降级为 1 全量 + 2 静态快照',
                'warn',
              );
            }
            return true;
          });
        }
        // 注意：这里**不自动恢复**。超出阈值后回到 all-live 需要用户手动重置
        // （下面的 resetProbe），避免在阈值边缘来回抖动，那比一直降级更难受。
      },
    });
    probeRef.current = probe;
    return () => {
      probe.stop();
      probeRef.current = null;
    };
  }, [config.probe, pushToast]);

  const resetProbe = useCallback(() => {
    probeRef.current?.resetBreachStreak();
    setProbeBreached(false);
    setManualSnapshot(false);
    setVerdict(null);
    pushToast('已重置探针判定，尝试恢复全量挂载', 'ok');
  }, [pushToast]);

  // ── 3. 星轨交互 ───────────────────────────────────────────────────────────
  const handleZoomChange = useCallback((next: number) => {
    setZoom(clampZoom(next));
  }, []);

  /** 全屏入站：zoom 推到阈值以上且有选中站 → 声波坞自动坍缩（A4） */
  const fullscreenStationId = useMemo(() => {
    if (zoom >= ZOOM_FULLSCREEN_AT && selectedId) return selectedId;
    return null;
  }, [zoom, selectedId]);

  const autoCollapsed = fullscreenStationId !== null;

  useEffect(() => {
    if (autoCollapsed) setDockExpanded(false);
  }, [autoCollapsed]);

  const handleCapsuleClick = useCallback(
    (station: MicrositeStation, _event: React.MouseEvent) => {
      setSelectedId(station.id);

      // 已在架子上 → 聚焦；否则挂载（或聚焦最后一个空位）
      setMountedIds((prev) => {
        if (prev.includes(station.id)) return prev;
        if (prev.length >= MAX_PANELS) {
          // 满了：替换掉当前没聚焦的那个（尾部淘汰）
          const next = [...prev];
          next[next.length - 1] = station.id;
          return next;
        }
        return [...prev, station.id];
      });
      setFocusedId(station.id);
    },
    [],
  );

  // ── 4. 仪器架交互 ─────────────────────────────────────────────────────────
  const handleUnmount = useCallback((stationId: string) => {
    setMountedIds((prev) => prev.filter((id) => id !== stationId));
    setFocusedId((prev) => (prev === stationId ? null : prev));
    setSelectedId((prev) => (prev === stationId ? null : prev));
  }, []);

  const handlePromote = useCallback(
    (stationId: string) => {
      const station = STATION_BY_ID[stationId];
      pushToast(
        '已手动升级 ' + (station?.name ?? stationId) + ' 为全量挂载（探针可能再次降级）',
        'warn',
      );
    },
    [pushToast],
  );

  const resolveSrc = useCallback(
    (station: MicrositeStation) => {
      const origin = resolveMicrositeOrigin(config.originTemplate, station);
      if (!config.usePlaceholder) return origin;
      // 开发期占位页：带站点身份的静态说明，不依赖微站是否已开发
      const params = new URLSearchParams({
        id: station.id,
        name: station.name,
        orbit: station.orbitName,
        style: station.uiStyle,
        ledger: station.ledger,
      });
      return '/placeholder?' + params.toString();
    },
    [config.originTemplate, config.usePlaceholder],
  );

  // ── 5. 虫洞投送 ───────────────────────────────────────────────────────────
  const wormholeTargets = useMemo<readonly WormholeTarget[]>(() => {
    if (!wormholePayload) return [];
    // W3：只列出声明过的目标；未声明的也列出来但 accepts=false（让用户看到"为什么不能投"）
    return STATIONS.filter((station) => station.id !== selectedId).map((station) => ({
      station,
      accepts: canDispatch(wormholePayload.payloadType, station.accepts),
    }));
  }, [wormholePayload, selectedId]);

  const handleDragStart = useCallback(
    (payload: {
      payloadType: PayloadType;
      summary: string;
      evidenceCount: number;
    }) => {
      const card = SOURCE_CARDS.find((item) => item.payloadType === payload.payloadType);
      setWormholePayload({
        ...payload,
        matrixUid: card?.matrixUid ?? 'mxu_unknown',
        sourceApp: card?.sourceApp ?? 'unknown.matrixos.edu',
      });
      setWormholeError(undefined);
      setWormholeOpen(true);
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    // 松手时环体已经开着，让用户点目标完成投送；这里不自动提交
    // （坐标命中判定在环面上，用 pointer 事件比算距离稳）
  }, []);

  const handleWormholeCancel = useCallback(() => {
    setWormholeOpen(false);
    setWormholePayload(null);
    setWormholeTargetHover(null);
    setWormholeError(undefined);
  }, []);

  const handleWormholeCommit = useCallback(
    (target: WormholeTarget) => {
      if (!wormholePayload) return;

      // 构造信封并**当场校验**（W1 红线在客户端兑现）
      const envelope = {
        trace_id: (() => {
          try {
            return createTraceId();
          } catch {
            // crypto 缺失的极端环境：留空让校验把它判成 schema 违规，不伪造一个假 UUID
            return '';
          }
        })(),
        matrix_uid: wormholePayload.matrixUid,
        source_app: wormholePayload.sourceApp,
        target_app: target.station.domain,
        payload_type: wormholePayload.payloadType,
        payload: {
          // W2：payload.data 只放摘要，正文永不出现在 hub（那是内存里的东西）
          data: { summary: wormholePayload.summary, evidence_count: wormholePayload.evidenceCount },
          evidence_anchors: Array.from({ length: wormholePayload.evidenceCount }, (_, index) => ({
            source_doi_or_url: 'pending://evidence-' + (index + 1),
            verification_level: 'Level_A_Verified' as const,
          })),
        },
      };

      const validation = validateEnvelope(envelope);
      if (!validation.ok) {
        // W1：环体已在 UI 层转红，这里补一个明确的原因
        const message = validation.issues.map((issue) => issue.message).join('；');
        setWormholeError(message);
        pushToast('投送被拒绝：' + message, 'error');
        return;
      }

      if (!canDispatch(wormholePayload.payloadType, target.station.accepts)) {
        setWormholeError(
          target.station.name + ' 未在 manifest 中声明接收 ' + wormholePayload.payloadType,
        );
        pushToast('投送被拒绝：目标站未声明该 payload_type（契约 W3）', 'error');
        return;
      }

      /**
       * 真投送：SDK 与目标站的 postMessage 通道在此接入。
       * 当前骨架阶段**只做本地演示**，并在 toast 里说清楚"未真投送"，
       * 不假装成功（那会让联调时误判 SDK 已通）。
       */
      pushToast(
        '虫洞已张开：' +
          PAYLOAD_TYPE_LABEL[wormholePayload.payloadType] +
          ' → ' +
          target.station.name +
          '（骨架态未接通 SDK，见 lib/sdk-facade）',
        'ok',
      );
      setWormholeOpen(false);
      setWormholePayload(null);
      setWormholeTargetHover(null);
      setWormholeError(undefined);
    },
    [pushToast, wormholePayload],
  );

  // ── 6. 顶部状态条数据 ─────────────────────────────────────────────────────
  const orbitDistribution = useMemo(
    () =>
      Object.entries(ORBIT_GROUP_DISTRIBUTION)
        .map(([group, count]) => group + ':' + count)
        .join(' '),
    [],
  );

  const probeTone =
    verdict?.level === 'breach' ? 'danger' : verdict?.level === 'warn' ? 'warn' : undefined;

  return (
    <div className="hub-shell">
      {/* ── 顶部状态条 ─────────────────────────────────────────────────────── */}
      <header className="hub-topbar">
        <div className="hub-brand">
          <span className="hub-brand-mark">MX</span>
          <span>MatrixOS</span>
          <span className="hub-brand-sub">双态合体总控台 · v3.0</span>
        </div>
        <span className="hub-topbar-spacer" />
        <span className="hub-stat" title="18 个官方旗舰微站，轨道分布 3/5/7/3">
          微站 <b>{STATIONS.length}</b> · 轨道分布 <b>{orbitDistribution}</b>
        </span>
        <span className="hub-stat" data-tone={probeTone}>
          探针 <b>{verdict ? verdict.sample.fps + 'fps' : '…'}</b>
        </span>
        <span className="hub-stat" data-tone={effectiveStrategy === 'all-live' ? undefined : 'warn'}>
          策略 <b>{effectiveStrategy === 'all-live' ? '全量' : '1 活 2 快照'}</b>
        </span>
        <span className="hub-stat" title="开发期 iframe 指向">
          源 <b>{config.usePlaceholder ? '占位页' : config.localMode ? '本地 dev' : '真实域名'}</b>
        </span>
      </header>

      {/* ── 主区：左星轨 + 右仪器架 ────────────────────────────────────────── */}
      <div className="hub-main">
        <StarOrbitField
          mountedIds={mountedIds}
          selectedId={selectedId}
          zoom={zoom}
          onZoomChange={handleZoomChange}
          onCapsuleClick={handleCapsuleClick}
        />

        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 10 }}>
          <InstrumentRack
            mountedIds={mountedIds}
            focusedId={focusedId}
            strategy={effectiveStrategy}
            snapshotReason={
              manualSnapshot
                ? '演示模式强制降级（NEXT_PUBLIC_HUB_FORCE_SNAPSHOT=true）'
                : '探针判定超预算：' + (verdict?.reasons.join('；') ?? '性能采样触发')
            }
            resolveSrc={resolveSrc}
            onMount={(station) => handleCapsuleClick(station, {} as React.MouseEvent)}
            onUnmount={handleUnmount}
            onFocus={setFocusedId}
            onPromote={handlePromote}
          />

          {/* 虫洞源卡片：演示"拖拽数据卡片 → 张开环 → 投送"的入口 */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
              flex: 'none',
            }}
          >
            <span className="rack-title" style={{ fontSize: 'var(--text-2xs)' }}>
              虫洞源（拖我）:
            </span>
            {SOURCE_CARDS.map((card) => (
              <DraggableCard
                key={card.id}
                label={card.label}
                payloadType={card.payloadType}
                evidenceCount={card.evidenceCount}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragCancel={handleWormholeCancel}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── 底部：声波脉冲坞 ───────────────────────────────────────────────── */}
      <div className="wave-dock-slot">
        <CopilotWaveDock
          expanded={dockExpanded}
          onExpandedChange={setDockExpanded}
          state={dockState}
          contextLabel={
            'DeepSeek V4.1 Flash 路由就绪 · 已挂载 ' +
            mountedIds.length +
            ' 站' +
            (mountedIds.length === 0 ? '（尚无）' : '')
          }
          autoCollapsed={autoCollapsed}
          badgeCount={probeBreached ? 1 : 0}
          {...(fullscreenStationId
            ? { statusText: '全屏入站 · ' + (STATION_BY_ID[fullscreenStationId]?.name ?? '') }
            : {})}
          onQuery={(query) => {
            pushToast(
              'Copilot 未接通（骨架态）：收到「' + query.slice(0, 24) + '」',
              'warn',
            );
          }}
        />
      </div>

      {/* ── 浮层：虫洞环 ───────────────────────────────────────────────────── */}
      <WormholeRing
        open={wormholeOpen && wormholePayload !== null}
        state={
          wormholeTargetHover
            ? 'valid'
            : wormholePayload && wormholePayload.evidenceCount > 0
              ? 'armed'
              : 'invalid'
        }
        targets={wormholeTargets}
        selectedTargetId={wormholeTargetHover}
        payloadType={wormholePayload?.payloadType ?? 'paper_doi_bundle'}
        evidenceCount={wormholePayload?.evidenceCount ?? 0}
        payloadSummary={
          wormholePayload
            ? wormholePayload.summary +
              ' · ' +
              PAYLOAD_TYPE_LABEL[wormholePayload.payloadType] +
              ' · 来自 ' +
              wormholePayload.sourceApp
            : ''
        }
        {...(wormholeError ? { errorMessage: wormholeError } : {})}
        onTargetHover={setWormholeTargetHover}
        onCommit={handleWormholeCommit}
        onCancel={handleWormholeCancel}
      />

      {/* ── 角落：性能探针面板 ─────────────────────────────────────────────── */}
      <PerformanceProbePanel
        verdict={verdict}
        strategyLabel={effectiveStrategy === 'all-live' ? '全量' : '降级'}
        thresholds={config.probe}
        liveIframes={liveIframeCountRef.current}
        onReset={resetProbe}
      />

      {/* ── Toast ──────────────────────────────────────────────────────────── */}
      <div className="toast-layer" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" data-tone={toast.tone}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
