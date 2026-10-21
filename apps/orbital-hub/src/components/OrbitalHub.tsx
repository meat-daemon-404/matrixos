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
 * 1. **降级由探针驱动，且只在 `lib/degradation-policy.ts` 一处裁决**（R-T03）。
 *    探针产判定，策略层把「探针判定 + 设备档位 + 全屏入站 + 手动开关」合成
 *    一个 `{strategy, liveBudget, safeVisuals}`，仪器架严格按 budget 分配活名额。
 *    为什么值得单独抽一层：上一版仪器架自己"允许手动升级到 2 个活 iframe"，
 *    而探针按 `min(n,1)` 计数 —— 两边口径不一致，采样值和降级依据都会失真。
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
import { clampZoom } from '../lib/orbit-layout';
import { startPerformanceProbe, type ProbeHandle } from '../lib/performance-probe';
import {
  decideDegradation,
  detectDeviceTier,
  strategyLabel,
  type DeviceTier,
} from '../lib/degradation-policy';
import type { ProbeVerdict } from '../lib/hub-types';
import {
  PAYLOAD_TYPE_LABEL,
  WORMHOLE_TARGET_ATTR,
  canDispatch,
  createTraceId,
  validateEnvelope,
} from '../lib/wormhole-contract';
import { StarOrbitField } from './StarOrbitField';
import { InstrumentRack, loadPersistedMount, savePersistedMount, MAX_PANELS } from './InstrumentRack';
import { CopilotWaveDock, type WaveDockState } from './CopilotWaveDock';
import { WormholeRing, DraggableCard, type WormholeTarget } from './WormholeRing';
import { PerformanceProbePanel } from './PerformanceProbePanel';
import { HubOnboarding, readOnboarded } from './HubOnboarding';
// MatrixID 登录态胶囊：hub 必须自己登录，才能为微站签发 mx_idt（见组件文件头说明）
import { HubAuthChip } from '../lib/use-hub-auth';
// 字号密度档位：答辩投影时整体放大（visual-system §3.2 的诉求）
import {
  DENSITY_LABEL,
  applyDensity,
  nextDensity,
  normalizeDensity,
  readDensity,
  saveDensity,
  type DensityMode,
} from '../lib/density';

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
  {
    /**
     * 这条是**故意的负例**：证据 0 条。
     * 契约 W1 要求 evidence_anchors minItems:1，所以它拖起来环就是红的、投不出去。
     * 把它摆在界面上，是为了让「证据不可为空」这条合规红线**随时可被演示和验收**，
     * 而不是只在文档里写着。
     */
    id: 'card-no-evidence',
    label: '未附证据的草稿结论',
    payloadType: 'comparison_matrix_row',
    evidenceCount: 0,
    matrixUid: 'mxu_01H8Z9K2',
    sourceApp: 'matrix-cross.matrixos.edu',
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

  /**
   * 首次引导。
   *
   * 初值恒为 false：`readOnboarded()` 读 localStorage，服务端没有它。
   * 若直接在 useState 初值里读，SSR 拿到 false、客户端拿到 true（老用户），
   * 水合就会不一致并报「Text content does not match」。真正是否展示要等挂载后
   * 在 effect 里判定 —— 这一帧的延迟用户看不见（引导本就是淡入的）。
   */
  const [onboardingOpen, setOnboardingOpen] = useState(false);

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

  /**
   * 设备档位：挂载后才探测（SSR 阶段没有 navigator，一律按 mid）。
   * 不参与首屏 HTML，避免"服务端算 mid、客户端算 low"的水合不一致。
   */
  const [deviceTier, setDeviceTier] = useState<DeviceTier>('mid');

  /**
   * 字号密度档位。
   *
   * 初值恒为 `'normal'`：`readDensity()` 读 localStorage，服务端没有它。
   * 若直接在 useState 初值里读，SSR 拿到 normal、客户端拿到 large，
   * 首帧文本/尺寸就不一致 —— 而 density 是**全局字号**，差异会非常明显
   * （比之前的 React #418 更容易看出来）。真实偏好在 effect 里回填。
   */
  const [density, setDensity] = useState<DensityMode>('normal');

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeq = useRef(0);

  const pushToast = useCallback((message: string, tone: ToastItem['tone']) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((prev) => [...prev, { id, message, tone }].slice(-3));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4200);
  }, []);

  // ── 1. 恢复持久化的挂载组合（S2-03 验收：刷新后恢复） ────────────────────
  useEffect(() => {
    const saved = loadPersistedMount();
    if (saved && saved.stationIds.length > 0) {
      setMountedIds(saved.stationIds);
      setFocusedId(saved.focusedId);
    }
    setRestored(true);
    setDeviceTier(detectDeviceTier());

    /*
     * 恢复字号密度偏好，并立刻应用。
     *
     * 为什么放在 effect 而不是初值里读：见 `density` state 的注释（水合一致性）。
     * 这一帧的延迟只影响字号，不影响布局结构，用户看不见跳变。
     * `applyDensity` 写的是 `<html data-density>`，CSS 变量随即重算，
     * 整站 token（含 22 处从 px 收敛来的 --text-3xs/4xs）一起放大。
     */
    const savedDensity = normalizeDensity(readDensity());
    setDensity(savedDensity);
    applyDensity(savedDensity);

    // 首访才弹引导；老用户（已标记 done）静默跳过
    if (!readOnboarded()) setOnboardingOpen(true);
  }, []);

  useEffect(() => {
    if (!restored) return; // 别在恢复之前把空状态写回去
    savePersistedMount({ stationIds: mountedIds, focusedId });
  }, [mountedIds, focusedId, restored]);

  // ── 2. 全屏入站判定（必须在降级决策之前算出来） ──────────────────────────
  /** 全屏入站：zoom 推到阈值以上且有选中站 → 声波坞自动坍缩（A4） */
  const fullscreenStationId = useMemo(() => {
    if (zoom >= ZOOM_FULLSCREEN_AT && selectedId) return selectedId;
    return null;
  }, [zoom, selectedId]);

  const autoCollapsed = fullscreenStationId !== null;

  // ── 3. 降级策略（唯一裁决点） ─────────────────────────────────────────────
  const decision = useMemo(
    () =>
      decideDegradation({
        mountedCount: mountedIds.length,
        probeLevel: verdict?.level ?? null,
        probeBreached,
        manualSnapshot,
        deviceTier,
        fullscreen: autoCollapsed,
      }),
    [mountedIds.length, verdict?.level, probeBreached, manualSnapshot, deviceTier, autoCollapsed],
  );

  /**
   * 活跃 iframe 计数 —— **数真实 DOM**，不按 mountedIds 推算。
   *
   * 为什么改：懒加载意味着"已挂载" ≠ "已创建 iframe"（面板被挤到视口外时
   * IntersectionObserver 不会让它 hydrate）。按 mountedIds 推算出来的数字会
   * 比真实值大，于是探针以为压力来自 3 个 iframe，实际只有 1 个 ——
   * 降级决策就建立在假数字上。查询本身只有 3 个节点，每秒一次，可忽略。
   */
  const countLiveIframes = useCallback((): number => {
    if (typeof document === 'undefined') return 0;
    return document.querySelectorAll('iframe.panel-iframe').length;
  }, []);

  useEffect(() => {
    const probe = startPerformanceProbe({
      thresholds: config.probe,
      getLiveIframeCount: countLiveIframes,
      onSample: (next) => {
        setVerdict(next);
        if (next.level === 'breach') {
          setProbeBreached((prev) => {
            if (!prev) {
              // 降级必须是可见的（ADR-09：不允许静默降级）
              pushToast(
                '性能超预算（' + next.reasons.join('；') + '）→ 已降级为 1 全量 + 静态快照',
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
  }, [config.probe, pushToast, countLiveIframes]);

  const resetProbe = useCallback(() => {
    probeRef.current?.resetBreachStreak();
    setProbeBreached(false);
    setManualSnapshot(false);
    setVerdict(null);
    pushToast('已重置探针判定，尝试恢复全量挂载', 'ok');
  }, [pushToast]);

  // ── 4. 星轨交互 ───────────────────────────────────────────────────────────
  const handleZoomChange = useCallback((next: number) => {
    setZoom(clampZoom(next));
  }, []);

  /**
   * 全屏入站 → 坞自动坍缩（A4）。
   *
   * 只在**进入**全屏时收，退出全屏不自动弹回来：用户可能是主动把它收起来的，
   * 自动弹开会抢走他的选择。想展开点呼吸球即可（球上有角标提示）。
   */
  const wasFullscreenRef = useRef(false);
  useEffect(() => {
    if (autoCollapsed && !wasFullscreenRef.current) {
      setDockExpanded(false);
      const name = fullscreenStationId ? STATION_BY_ID[fullscreenStationId]?.name : null;
      pushToast(
        '全屏入站' + (name ? ' · ' + name : '') + '：声波坞已坍缩为右下角呼吸球',
        'ok',
      );
    }
    wasFullscreenRef.current = autoCollapsed;
  }, [autoCollapsed, fullscreenStationId, pushToast]);

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

  // ── 5. 仪器架交互 ─────────────────────────────────────────────────────────
  const handleUnmount = useCallback((stationId: string) => {
    setMountedIds((prev) => prev.filter((id) => id !== stationId));
    setFocusedId((prev) => (prev === stationId ? null : prev));
    setSelectedId((prev) => (prev === stationId ? null : prev));
  }, []);

  const handlePromote = useCallback(
    (stationId: string) => {
      const station = STATION_BY_ID[stationId];
      if (decision.liveBudget <= 0) {
        pushToast(
          '当前为「全部让位」态（' + decision.reasons[0] + '），先退出全屏再升级',
          'warn',
        );
        return;
      }
      pushToast(
        '已把活名额让给 ' +
          (station?.name ?? stationId) +
          '（当前预算 ' +
          decision.liveBudget +
          ' 个活 iframe，其余面板转为快照）',
        'ok',
      );
    },
    [pushToast, decision.liveBudget, decision.reasons],
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

  // ── 6. 虫洞投送 ───────────────────────────────────────────────────────────
  const wormholeTargets = useMemo<readonly WormholeTarget[]>(() => {
    if (!wormholePayload) return [];
    // W3：只列出声明过的目标；未声明的也列出来但 accepts=false（让用户看到"为什么不能投"）
    return STATIONS.filter((station) => station.id !== selectedId).map((station) => ({
      station,
      accepts: canDispatch(wormholePayload.payloadType, station.accepts),
    }));
  }, [wormholePayload, selectedId]);

  /**
   * 真正提交一次投送。**先校验，后收尾** —— 校验失败时环体保持张开并转红，
   * 用户能看见原因，而不是"点了没反应"。
   */
  const handleWormholeCommit = useCallback(
    (target: WormholeTarget) => {
      if (!wormholePayload) return;

      // W3 目标声明检查（UI 层已禁用不合法的目标，这里再兜一道：
      // 松手落点命中判定不经过按钮的 disabled 状态）
      if (!canDispatch(wormholePayload.payloadType, target.station.accepts)) {
        const message =
          target.station.name + ' 未在 manifest 中声明接收 ' + wormholePayload.payloadType;
        setWormholeError(message);
        pushToast('投送被拒绝：目标站未声明该 payload_type（契约 W3）', 'error');
        return;
      }

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

  const handleWormholeCancel = useCallback(() => {
    setWormholeOpen(false);
    setWormholePayload(null);
    setWormholeTargetHover(null);
    setWormholeError(undefined);
  }, []);

  const handleDragStart = useCallback(
    (payload: {
      payloadType: PayloadType;
      summary: string;
      evidenceCount: number;
    }) => {
      const card = SOURCE_CARDS.find(
        (item) => item.payloadType === payload.payloadType && item.label === payload.summary,
      );
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

  /**
   * 松手 → 命中判定 → 投送。这是 A3「拖卡片 → 张开环 → 松手投送」的最后一环。
   *
   * 用 `document.elementFromPoint` 而不是自己算各目标的圆心距离：
   *  - 环形布局的目标位置由 CSS 百分比决定，JS 里再算一遍等于把布局逻辑抄两份，
   *    迟早漂移（改一下 ring 尺寸就全错）；
   *  - elementFromPoint 天然尊重 z-index / 遮挡 / transform，与用户看到的一致；
   *  - 拖拽中的 ghost 是 pointer-events:none，不会挡住命中。
   *
   * 落在环外（即没命中任何目标）时**取消**而不是静默保留：拖出去松手是
   * 通用的「放弃」手势，保留一个悬着的环会让人不知道自己在什么状态。
   */
  const handleDragEnd = useCallback(
    (position: { readonly x: number; readonly y: number }) => {
      if (typeof document === 'undefined') {
        handleWormholeCancel();
        return;
      }

      const element = document.elementFromPoint(position.x, position.y);
      const targetElement = element?.closest('[' + WORMHOLE_TARGET_ATTR + ']');
      const stationId = targetElement?.getAttribute(WORMHOLE_TARGET_ATTR) ?? null;

      if (!stationId) {
        pushToast('未落在任何目标站上，投送已取消', 'warn');
        handleWormholeCancel();
        return;
      }

      const target = wormholeTargets.find((item) => item.station.id === stationId);
      if (!target) {
        // 命中的节点已不在候选列表里（例如拖拽中选中站变了）：当作取消，别猜
        pushToast('目标已失效，投送已取消', 'warn');
        handleWormholeCancel();
        return;
      }

      if (!target.accepts) {
        setWormholeError(
          target.station.name + ' 未在 manifest 中声明接收 ' + wormholePayload?.payloadType,
        );
        pushToast(
          '投送被拒绝：' + target.station.name + ' 未声明该 payload_type（契约 W3）',
          'error',
        );
        return;
      }

      handleWormholeCommit(target);
    },
    [handleWormholeCommit, handleWormholeCancel, pushToast, wormholeTargets, wormholePayload],
  );

  // ── 7. 顶部状态条数据 ─────────────────────────────────────────────────────
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
    <div
      className="hub-shell"
      // 精简视觉：低预算时收敛 backdrop-filter / 发光，削减合成开销
      data-safe-visuals={decision.safeVisuals ? 'true' : 'false'}
      data-strategy={decision.strategy}
    >
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
        <span
          className="hub-stat"
          data-tone={decision.strategy === 'all-live' ? undefined : 'warn'}
          title={decision.reasons.join('；') || '全部面板为全量 iframe'}
        >
          策略 <b>{strategyLabel(decision.strategy)}</b>
        </span>
        <span className="hub-stat" title={'设备档位：' + deviceTier + '（按 navigator.hardwareConcurrency 判定）'}>
          设备 <b>{deviceTier}</b>
        </span>
        <span className="hub-stat" title="开发期 iframe 指向">
          源 <b>{config.usePlaceholder ? '占位页' : config.localMode ? '本地 dev' : '真实域名'}</b>
        </span>
        {/*
          MatrixID 登录态。
          为什么放在顶部栏：`POST /v1/auth/idt`（hub 为微站签发 mx_idt）要求
          hub 自己是登录态，否则 401 —— 这曾让内嵌态 SSO 永远 offline。
          没有这个入口时，hub 的 matrixUid 是硬编码演示值。
        */}
        <HubAuthChip apiBase={config.apiBase} />
        <span className="hub-topbar-spacer" />
        {/*
          字号密度开关（答辩投影用）。
          正文字号多为 8–12px，桌面看没问题，投影到后排就是一片模糊
          （`docs/00-analysis/04-visual-system.md:202` 明确记了这个诉求）。
          点一下进一档：标准 → 1.25× → 1.5× → 标准，选择会被记住。
        */}
        <button
          type="button"
          className="btn"
          onClick={() => {
            const next = nextDensity(density);
            setDensity(next);
            applyDensity(next);
            saveDensity(next);
            pushToast('字号已切到「' + DENSITY_LABEL[next] + '」', 'ok');
          }}
          title={'切换字号密度（当前：' + DENSITY_LABEL[density] + '）—— 答辩投影时放大'}
          aria-label={'切换字号密度，当前 ' + DENSITY_LABEL[density]}
        >
          A<sup style={{ fontSize: '0.7em' }}>±</sup>
        </button>
        {/* 「?」= 随时重看引导。引导本身可跳过，但没有这个入口的话，
            用户跳过之后就再也找不回来了（localStorage 里是 done）。 */}
        <button
          type="button"
          className="btn"
          onClick={() => setOnboardingOpen(true)}
          title="重看使用引导"
          aria-label="重看使用引导"
          /*
           * 引导关闭后焦点回到这里。
           *
           * 引导是首访自动弹出的，**没有触发按钮**；若把焦点"还原"到打开前的
           * `activeElement`（那时是 `<body>`），键盘用户等于丢失位置（WCAG 2.4.3）。
           * 这个 `?` 正是引导的对应入口，落在这里语义连贯 —— 按完还能再开一次。
           *
           * 用属性而非 ref：`HubOnboarding` 是 `OrbitalHub` 的子组件，
           * 拿不到这里的 ref，用 `data-*` 选择器耦合更松。
           */
          data-onboard-reopen=""
        >
          ?
        </button>
        {/* 全屏入站时给一个明确的退出入口，否则用户只能靠拖滑块摸索 */}
        {autoCollapsed ? (
          <button
            type="button"
            className="btn"
            data-tone="warn"
            onClick={() => {
              setZoom(2.5);
              pushToast('已退出全屏入站，恢复三栏视图', 'ok');
            }}
            title="把星轨缩放拉回 2.5x，退出全屏入站"
          >
            ← 退出全屏入站
          </button>
        ) : null}
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
            strategy={decision.strategy}
            liveBudget={decision.liveBudget}
            snapshotReason={decision.reasons.join('；') || '多 iframe 性能超预算，已自动降级'}
            resolveSrc={resolveSrc}
            onMount={(station) => handleCapsuleClick(station, {} as React.MouseEvent)}
            onUnmount={handleUnmount}
            onFocus={setFocusedId}
            onPromote={handlePromote}
          />

          {/* 虫洞源卡片：演示"拖拽数据卡片 → 张开环 → 投送"的入口 */}
          <div
            data-onboard="wormhole"
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
      <div className="wave-dock-slot" data-collapsed={dockExpanded ? 'false' : 'true'} data-onboard="dock">
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
        strategyLabel={strategyLabel(decision.strategy)}
        thresholds={config.probe}
        liveIframes={verdict?.sample.liveIframes ?? 0}
        liveBudget={decision.liveBudget}
        reasons={decision.reasons}
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

      {/* ── 首次引导（首访自动弹，可由「?」重看） ───────────────────────────── */}
      <HubOnboarding open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
    </div>
  );
}