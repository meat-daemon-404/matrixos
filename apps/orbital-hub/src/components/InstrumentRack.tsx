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
 * 谁决定降级：不是这个组件，而是传入的 `strategy`。
 *   探针在 page 层跑，判定的结果通过 strategy 下发 —— 这样 S2-01e 要单独跑基线
 *   不触发降级时，只要不接探针即可，组件本身不带"自作主张"的行为。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { STATION_BY_ID, type MicrositeStation } from '../lib/microsites.generated';
import type { PanelMode, RenderStrategy } from '../lib/hub-types';
import { InstrumentPanel } from './InstrumentPanel';

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
  snapshotReason,
  resolveSrc,
  onUnmount,
  onFocus,
  onPromote,
  onFirstLive,
}: InstrumentRackProps) {
  /**
   * 用户手动升级过的面板 id。降级只对"没被手动升级"的面板生效 ——
   * 否则用户点「升级为全量」，下一个探针窗口又把它打回快照，会像 bug。
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
   * 决定每个面板的模式。
   *
   * 降级规则（当 strategy = one-live-rest-snapshot）：
   *   - 焦点面板优先当"那 1 个全量"；没有焦点就取第一个；
   *   - 被用户手动升级的面板也给全量（但最多共 2 个，防止用户把 3 个都点活
   *     反而把性能又打回原形 —— 那时探针会再降级，来回抖）。
   */
  const modes = useMemo<Record<string, PanelMode>>(() => {
    if (strategy === 'all-live') {
      return Object.fromEntries(stations.map((station) => [station.id, 'live' as PanelMode]));
    }

    const anchorId =
      focusedId && stations.some((station) => station.id === focusedId)
        ? focusedId
        : (stations[0]?.id ?? null);

    const liveIds = new Set<string>();
    if (anchorId) liveIds.add(anchorId);
    // 手动升级：最多再给 1 个名额
    for (const id of promotedIds) {
      if (liveIds.size >= 2) break;
      if (stations.some((station) => station.id === id)) liveIds.add(id);
    }

    return Object.fromEntries(
      stations.map((station) => [
        station.id,
        (liveIds.has(station.id) ? 'live' : 'snapshot') as PanelMode,
      ]),
    );
  }, [strategy, stations, focusedId, promotedIds]);

  const handlePromote = useCallback(
    (stationId: string) => {
      setPromotedIds((prev) => (prev.includes(stationId) ? prev : [...prev, stationId]));
      onPromote(stationId);
    },
    [onPromote],
  );

  const count = stations.length;

  return (
    <section className="instrument-rack" aria-label="折射仪器架">
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
              : '性能探针判定超预算，已降级为 1 全量 + 2 静态快照（R-T03 预设方案）'
          }
        >
          {strategy === 'all-live' ? '◉ 全量模式' : '◐ 降级模式 · 1 活 2 快照'}
        </span>
        <span className="btn" style={{ cursor: 'default' }} title="iframe 未激活时不创建 DOM">
          懒加载 · 可见才 hydrate
        </span>
      </div>

      <div className="rack-grid" data-count={count}>
        {count === 0 ? (
          <div className="rack-empty">
            <div>仪器架为空</div>
            <p className="rack-empty-hint">
              点击左侧星轨上的微站胶囊挂载仪器。可同屏挂载 2~3 台；
              未激活的面板不会创建 iframe（性能红线 R-T03）。
            </p>
          </div>
        ) : (
          stations.map((station) => (
            <InstrumentPanel
              key={station.id}
              station={station}
              src={resolveSrc(station)}
              mode={modes[station.id] ?? 'dormant'}
              snapshotReason={snapshotReason}
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
