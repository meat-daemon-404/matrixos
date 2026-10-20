'use client';

/**
 * InstrumentRack · 右 68% 折射仪器架
 * ==========================================================================
 * 同屏挂载 2~3 个微站 + 每个面板 [↗ 全屏独立打开] + 布局持久化（S2-03 验收项）。
 *
 * **降级方案（架构文档 ADR-08 + 风险 R-T03 的强制要求）**：
 *   性能探针判定 breach 时，自动切换为「1 个全量 iframe + 2 个静态快照」。
 *   视觉上仍是同屏 3 台仪器（构图不破），但只有 1 台是真活的。
 *   降级是**可见的**：快照面板有「静态快照 · 非实时」角标 + 降级原因 + 升级按钮，
 *   符合 ADR-09「L2 状态必须显式可见，不允许静默降级」。
 *
 * 谁决定降级：不是这个组件，而是传入的 `strategy` + `liveBudget`。
 *   两者都由 `lib/degradation-policy.ts` 从探针判定 / 设备档位 / 全屏入站 /
 *   手动开关这四个输入**纯函数式**算出，page 层只做分发。本组件严格按预算
 *   分配活名额，一不多给（会与探针计数打架）也不少给（会白白损失功能）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { STATION_BY_ID, type MicrositeStation } from '../lib/microsites.generated';
import type { PanelMode, RenderStrategy } from '../lib/hub-types';
import { InstrumentPanel } from './InstrumentPanel';
import { RackEmptyState } from './RackEmptyState';

/** 布局持久化 key（刷新后挂载组合恢复，S2-03 验收） */
const STORAGE_KEY = 'matrixos.hub.mount.v1';
const MAX_PANELS = 3;

interface PersistedMount {
  readonly stationIds: readonly string[];
  readonly focusedId: string | null;
}

export interface InstrumentRackProps {
  readonly mountedIds: readonly string[];
  readonly focusedId: string | null;
  readonly strategy: RenderStrategy;
  /**
   * 允许同时存活的 iframe 数（由 lib/degradation-policy 唯一裁决）。
   *
   * 上一版这里是组件自己从 strategy 推的（"焦点优先，再允许手动升级到 2 个"），
   * 结果与探针的 `getLiveIframeCount`（按 min(n, 1) 算）对不上：探针以为自己
   * 在看 1 个 iframe，实际屏幕上有 2 个在跑。采样和降级依据就此失真。
   * 现在预算由外部单点下发，本组件只负责**严格按预算分配**，不自行加码。
   */
  readonly liveBudget: number;
  /** 降级原因，透传给快照面板显示 */
  readonly snapshotReason: string;
  readonly resolveSrc: (station: MicrositeStation) => string;
  readonly onMount: (station: MicrositeStation) => void;
  readonly onUnmount: (stationId: string) => void;
  readonly onFocus: (stationId: string) => void;
  /** 用户手动把某个快照升级成全量（会临时解除该面板降级） */
  readonly onPromote: (stationId: string) => void;
  readonly onFirstLive?: (stationId: string, elapsedMs: number) => void;
  /** 挂载组合变化时回调，供 page 层持久化 */
  readonly onPersist?: (mount: PersistedMount) => void;
}

export function InstrumentRack({
  mountedIds,
  focusedId,
  strategy,
  liveBudget,
  snapshotReason,
  resolveSrc,
  onMount,
  onUnmount,
  onFocus,
  onPromote,
  onFirstLive,
}: InstrumentRackProps) {
  /**
   * 用户手动升级过的面板 id。
   *
   * 语义收窄了一档：手动升级**不能突破 liveBudget**（上一版允许最多 2 个活，
   * 但那正是与探针打架的根源）。它现在的作用是把"哪个面板占用那唯一的活名额"
   * 从焦点面板改判给用户点的那一个 —— 用户想看的仪器优先拿到预算，
   * 而不是让用户以为升级成功了、实际性能被自己搞崩。
   */
  const [promotedIds, setPromotedIds] = useState<readonly string[]>([]);

  useEffect(() => {
    // 降级解除后清理手动标记，避免陈旧状态
    if (strategy === 'all-live') setPromotedIds((prev) => (prev.length === 0 ? prev : []));
  }, [strategy]);

  const stations = useMemo(
    () =>
      mountedIds
        .map((id) => STATION_BY_ID[id])
        .filter((station): station is MicrositeStation => Boolean(station))
        .slice(0, MAX_PANELS),
    [mountedIds],
  );

  /**
   * 决定每个面板的模式 —— 严格按 liveBudget 分配，一个不多。
   *
   * 名额分配顺序：
   *   1. 用户手动升级过的面板（最近点的那个优先，所以反向遍历 promotedIds）；
   *   2. 焦点面板；
   *   3. 第一个面板（兜底，保证只要预算 ≥1 就有一台活的）。
   *
   * 为什么用"最近升级优先"而不是"按挂载顺序"：用户点了「⚡ 升级为全量挂载」，
   * 期待的是**这一台**亮起来。如果按顺序分配，他点第 3 台时第 1 台抢走名额，
   * 界面看起来毫无反应 —— 那比不提供这个按钮更糟。
   */
  const modes = useMemo<Record<string, PanelMode>>(() => {
    if (stations.length === 0) return {};

    const budget = Math.max(0, Math.min(liveBudget, stations.length));

    if (budget === 0) {
      // all-snapshot：全屏入站态，一个 iframe 都不留
      return Object.fromEntries(stations.map((station) => [station.id, 'snapshot' as PanelMode]));
    }

    const presentIds = new Set(stations.map((station) => station.id));
    const liveIds = new Set<string>();

    // 1. 手动升级优先，最近点击的排前面
    for (let index = promotedIds.length - 1; index >= 0 && liveIds.size < budget; index -= 1) {
      const id = promotedIds[index];
      if (id && presentIds.has(id)) liveIds.add(id);
    }

    // 2. 焦点面板
    if (liveIds.size < budget && focusedId && presentIds.has(focusedId)) {
      liveIds.add(focusedId);
    }

    // 3. 兜底：按挂载顺序补满
    for (const station of stations) {
      if (liveIds.size >= budget) break;
      liveIds.add(station.id);
    }

    return Object.fromEntries(
      stations.map((station) => [
        station.id,
        (liveIds.has(station.id) ? 'live' : 'snapshot') as PanelMode,
      ]),
    );
  }, [stations, liveBudget, focusedId, promotedIds]);

  const handlePromote = useCallback(
    (stationId: string) => {
      setPromotedIds((prev) => (prev.includes(stationId) ? prev : [...prev, stationId]));
      onPromote(stationId);
    },
    [onPromote],
  );

  /**
   * 应用推荐组合。
   *
   * 走 `onMount` 而不是直接改本地态：挂载会触发 hub 层的持久化与探针重算，
   * 组件若自己改一份 mountedIds 副本，两边就会不同步。
   *
   * 顺序挂载（而不是批量回调）是刻意的 —— onMount 的签名是单站，
   * hub 侧的 setState 是函数式更新，连续调用会正确累积。
   */
  const handleApplyPreset = useCallback(
    (presetStations: readonly MicrositeStation[]) => {
      for (const station of presetStations.slice(0, MAX_PANELS)) {
        onMount(station);
      }
    },
    [onMount],
  );

  const count = stations.length;
  const liveCount = useMemo(
    () => Object.values(modes).filter((mode) => mode === 'live').length,
    [modes],
  );

  return (
    <section className="instrument-rack" aria-label="折射仪器架" data-onboard="rack">
      <div className="rack-toolbar">
        <span className="rack-title">
          折射仪器架 · <b>同屏 {count}</b> / {MAX_PANELS}
        </span>
        <span className="panel-head-spacer" />
        {/* 降级状态显式可见（ADR-09） */}
        <span
          className="btn"
          data-tone={strategy === 'all-live' ? undefined : 'warn'}
          style={{ cursor: 'default' }}
          title={
            strategy === 'all-live'
              ? '全部面板为全量 iframe'
              : strategy === 'all-snapshot'
                ? '全屏入站：所有面板让位为静态快照，避免 iframe 叠加'
                : '性能探针判定超预算，已降级为 1 全量 + 静态快照（R-T03 预设方案）'
          }
        >
          {strategy === 'all-live'
            ? '◉ 全量模式'
            : strategy === 'all-snapshot'
              ? '◌ 全部让位 · 全屏入站'
              : '◐ 降级模式 · 1 活 2 快照'}
        </span>
        {/*
          把「预算」直接摆出来。用户看到 "活 1 / 3" 才知道还有 2 台是快照、
          以及点「升级为全量」是在争夺同一个名额 —— 否则他会以为按钮坏了。
        */}
        <span
          className="btn"
          style={{ cursor: 'default' }}
          title={'当前允许同时存活的 iframe 数：' + liveBudget + '（由探针与设备档位共同裁决）'}
        >
          活 <b>{liveCount}</b> / {count}
        </span>
        <span className="btn" style={{ cursor: 'default' }} title="iframe 未激活时不创建 DOM">
          懒加载 · 可见才 hydrate
        </span>
      </div>

      <div className="rack-grid" data-count={count}>
        {count === 0 ? (
          <RackEmptyState onApplyPreset={handleApplyPreset} />
        ) : (
          stations.map((station) => (
            <InstrumentPanel
              key={station.id}
              station={station}
              src={resolveSrc(station)}
              mode={modes[station.id] ?? 'dormant'}
              snapshotReason={
                modes[station.id] === 'snapshot' && liveBudget < stations.length
                  ? snapshotReason +
                    ' · 本台为快照（当前预算 ' +
                    liveBudget +
                    ' 个活 iframe，点「升级」可把活名额让给本台）'
                  : snapshotReason
              }
              focused={focusedId === station.id}
              onFocus={() => onFocus(station.id)}
              onClose={() => onUnmount(station.id)}
              onPromote={() => handlePromote(station.id)}
              {...(onFirstLive ? { onFirstLive } : {})}
            />
          ))
        )}
      </div>
    </section>
  );
}

/** ── 布局持久化 helper（S2-03：刷新后挂载组合恢复） ─────────────────────── */

export function loadPersistedMount(): PersistedMount | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const ids = Array.isArray(obj.stationIds)
      ? obj.stationIds.filter((id): id is string => typeof id === 'string')
      : [];
    // 只保留花名册里真实存在的站（花名册改了也不会炸）
    const valid = ids.filter((id) => Boolean(STATION_BY_ID[id])).slice(0, MAX_PANELS);
    const focusedId = typeof obj.focusedId === 'string' ? obj.focusedId : null;
    return {
      stationIds: valid,
      focusedId: focusedId && valid.includes(focusedId) ? focusedId : (valid[0] ?? null),
    };
  } catch {
    return null;
  }
}

export function savePersistedMount(mount: PersistedMount): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(mount));
  } catch {
    /* localStorage 满了或被禁用：持久化失败不该影响主流程 */
  }
}

export { MAX_PANELS };
