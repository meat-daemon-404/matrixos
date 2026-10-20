/**
 * 总控台运行时状态类型（与 mount 逻辑共享）
 */

import type { MicrositeStation, PayloadType } from './microsites.generated';

/** 面板的加载/降级状态。 */
export type PanelMode =
  /** 未激活：只有占位骨架，**不创建 iframe**（R-T03 缓解措施 3） */
  | 'dormant'
  /** 正在创建 iframe，等待首帧 */
  | 'loading'
  /** 全量 iframe，活的应用 */
  | 'live'
  /** 静态快照：降级态，只有一张图/一段摘要，没有 iframe */
  | 'snapshot'
  /** iframe 加载失败或站点维护中（ADR-09 L3） */
  | 'failed';

/** 面板健康态：hub 需要能感知微站状态并在星轨上体现（ADR-09） */
export type PanelHealth = 'normal' | 'degraded' | 'maintenance';

export interface InstrumentPanel {
  /** 面板实例 id（同一微站可挂多个实例时用，例如对比两版草稿） */
  readonly panelId: string;
  readonly stationId: string;
  readonly mode: PanelMode;
  readonly health: PanelHealth;
  /** 面板顺序即屏幕顺序（左→右） */
  readonly order: number;
  /** 首帧时间戳（ms），用于探针统计冷启动 */
  readonly firstPaintAt?: number;
}

export interface MountRequest {
  readonly station: MicrositeStation;
  /** 不传 = 追加到末尾 */
  readonly slot?: number;
}

/** 降级方案：1 全量 + 2 快照（ADR-08 / R-T03 预设） */
export type RenderStrategy =
  /** 全部 iframe 都活着（性能达标时） */
  | 'all-live'
  /** 降级：只有 1 个真 iframe，其余 2 个是静态快照 */
  | 'one-live-rest-snapshot'
  /** 全屏入站态：星轨推进到 10x 打开单站全屏，仪器架全部让位为快照（避免 iframe 叠加） */
  | 'all-snapshot';

/** 性能探针采样快照（S2-01e 要求的帧率/内存采样） */
export interface PerformanceSample {
  readonly at: number;
  /** 实测帧率（rAF 采样窗口） */
  readonly fps: number;
  /** 已用 JS 堆（MB）；浏览器不支持 performance.memory 时为 null */
  readonly heapMB: number | null;
  /** 采样窗口内最长的长任务（ms） */
  readonly longestTaskMs: number;
  /** 当前活跃 iframe 数 */
  readonly liveIframes: number;
}

export interface ProbeVerdict {
  readonly level: 'ok' | 'warn' | 'breach';
  readonly reasons: readonly string[];
  readonly sample: PerformanceSample;
}

/** 虫洞投送信封（严格对齐 specs/contracts/wormhole-envelope.schema.json） */
export interface WormholeEnvelopeDraft {
  readonly trace_id: string;
  readonly matrix_uid: string;
  readonly source_app: string;
  readonly target_app: string;
  readonly payload_type: PayloadType;
  readonly payload: {
    readonly data: Record<string, unknown>;
    readonly evidence_anchors: readonly {
      readonly source_doi_or_url: string;
      readonly pdf_page?: number;
      readonly bbox?: readonly [number, number, number, number];
      readonly verification_level: 'Level_A_Verified' | 'Level_B_Preprint' | 'Retracted_Warning';
    }[];
  };
}
