'use client';

/**
 * 仪器架空态 + 推荐组合。
 *
 * 为什么空态不能只是一句「点击左侧胶囊挂载仪器」：
 *   新用户面对 18 个站、7 条轨道，第一步的**决策成本**最高 —— 他不知道该先挂谁。
 *   空态是唯一能一次性把「常用组合」塞给他的地方，且不占常驻界面空间。
 *
 * 三个组合对应三类真实工作流（不是按轨道凑数）：
 *   · 科研攻坚   11 拟合示波器 + 09 跨论文对比 + 14 综述推演 —— 从数据到论证
 *   · 进组冲刺   06 导师星象仪 + 07 套磁信推演 + 08 进组台账 —— 从选导师到落地
 *   · 成果沉淀   16 综测核算 + 17 证据简历 + 18 生涯决策 —— 从在校成果到毕业出口
 * 每个组合 3 台，正好是 MAX_PANELS 上限，点一下就填满整架。
 */

import { STATION_BY_ID, type MicrositeStation } from '../lib/microsites.generated';

export interface MountPreset {
  readonly id: string;
  readonly title: string;
  /** 一句话说明这个组合解决什么场景 */
  readonly scenario: string;
  readonly stationIds: readonly string[];
}

export const MOUNT_PRESETS: readonly MountPreset[] = [
  {
    id: 'research',
    title: '科研攻坚',
    scenario: '从拟合数据到跨论文对比，再到综述落笔',
    stationIds: ['11', '09', '14'],
  },
  {
    id: 'join-lab',
    title: '进组冲刺',
    scenario: '选导师、写套磁、跟进度，一条链路走完',
    stationIds: ['06', '07', '08'],
  },
  {
    id: 'portfolio',
    title: '成果沉淀',
    scenario: '把在校成果核算清楚，做成能拿出手的证据',
    stationIds: ['16', '17', '18'],
  },
];

export interface RackEmptyStateProps {
  /** 点击推荐组合：把整组站一次性挂上（由上层替换而非追加，避免超上限） */
  readonly onApplyPreset: (stations: readonly MicrositeStation[]) => void;
  /** 命中不了花名册时（理论上不该发生）至少要能提示改花名册 */
  readonly missingHint?: string;
}

export function RackEmptyState({ onApplyPreset, missingHint }: RackEmptyStateProps) {
  return (
    <div className="rack-empty">
      {/* 空态示意图：三个灰位 + 一个流向箭头，纯 CSS 动，无资源请求 */}
      <div className="rack-empty-flow" aria-hidden="true">
        <span className="rack-empty-slot" />
        <span className="rack-empty-slot" />
        <span className="rack-empty-arrow">→</span>
        <span className="rack-empty-slot" data-filled="ghost" />
      </div>

      <div className="rack-empty-title">仪器架为空</div>
      <p className="rack-empty-hint">
        点左侧星轨上的任意胶囊挂载仪器，可同屏挂载 2~3 台。
        未激活的面板不会创建 iframe（性能红线 R-T03）。
      </p>

      <div className="rack-presets" role="group" aria-label="推荐挂载组合">
        <span className="rack-presets-label">或者，从一个常用组合开始</span>
        <div className="rack-presets-grid">
          {MOUNT_PRESETS.map((preset) => {
            const stations = preset.stationIds
              .map((id) => STATION_BY_ID[id])
              .filter((station): station is MicrositeStation => Boolean(station));

            // 花名册改了导致组合失效时，按钮不渲染 —— 宁可不显示，也不给一个点了没反应的按钮
            if (stations.length === 0) return null;

            return (
              <button
                key={preset.id}
                type="button"
                className="rack-preset"
                onClick={() => onApplyPreset(stations)}
                title={preset.scenario + '：' + stations.map((s) => s.name).join(' + ')}
              >
                <span className="rack-preset-title">{preset.title}</span>
                <span className="rack-preset-scenario">{preset.scenario}</span>
                <span className="rack-preset-stations">
                  {stations.map((station) => (
                    <span key={station.id} className="rack-preset-chip" style={{ ['--chip-accent' as string]: station.accent } as React.CSSProperties}>
                      <span className="rack-preset-chip-dot" aria-hidden="true" />
                      {station.name}
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        {missingHint ? <p className="rack-empty-hint">{missingHint}</p> : null}
      </div>
    </div>
  );
}
