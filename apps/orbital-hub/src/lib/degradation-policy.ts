/**
 * 降级策略 · R-T03 的唯一裁决点
 * =====================================================================
 * 这个模块回答一个问题：**「现在该用哪种渲染策略，为什么？」**
 *
 * 为什么把它单独抽出来（而不是散在 OrbitalHub 的 useMemo 里）：
 *  1. 降级的输入有 5 个（探针判定 / 手动开关 / 设备档位 / 全屏入站 / 挂载数），
 *     散着写必然出现「A 处允许 2 个活、B 处只允许 1 个」的自相矛盾 ——
 *     上一版就有这个问题：InstrumentRack 允许手动升级到 2 个活 iframe，
 *     而探针算 liveIframeCount 时按 min(n,1) 计，两边对不上。
 *  2. 决策必须是**纯函数**才可验证。这里不读 DOM、不读 performance，
 *     所有外部观测由调用方注入，于是可以直接对拍「给定输入 → 期望预算」。
 *  3. 每条降级都必须带 `reason` —— ADR-09 要求 L2 状态显式可见，
 *     不允许出现「用户不知道为什么面板变快照了」的静默降级。
 *
 * 输入里**没有**的东西（刻意的）：
 *  - 帧率/内存读数本身。探针已经把它们判成 'ok' | 'warn' | 'breach'，
 *    策略层只消费判定结果。这样「阈值怎么定」与「降到什么程度」是两个可独立演进的关注点。
 */

import type { RenderStrategy } from './hub-types';

/**
 * 设备档位。R-T03 缓解措施 5 要求「低性能设备检测后自动降级为单仪器模式」。
 *
 * 判据用 hardwareConcurrency 而非跑一段 benchmark：后者在首屏做测算本身就是
 * 一次长任务（恰好是我们要避免的东西），而且会拖慢首帧。核数不完美，
 * 但它是**同步可得、零成本、不污染性能样本**的唯一信号。
 * 真实帧率由探针持续兜底 —— 核数判错只是判得早或判得晚，不会判漏。
 */
export type DeviceTier = 'low' | 'mid' | 'high';

/** 核数阈值。≤4 核视为低端（高校机房常见的老笔记本 / 4 核轻薄本）。 */
export function deviceTierFromCores(cores: number | null | undefined): DeviceTier {
  if (typeof cores !== 'number' || !Number.isFinite(cores) || cores <= 0) return 'mid';
  if (cores <= 4) return 'low';
  if (cores <= 8) return 'mid';
  return 'high';
}

/** 浏览器侧探测。SSR 阶段（无 navigator）一律按 mid —— 不在服务端猜硬件。 */
export function detectDeviceTier(): DeviceTier {
  if (typeof navigator === 'undefined') return 'mid';
  return deviceTierFromCores(navigator.hardwareConcurrency);
}

export type DegradationSource =
  /** 探针判定超预算（R-T03 的自动降级主路径） */
  | 'probe'
  /** 用户/演示强制（NEXT_PUBLIC_HUB_FORCE_SNAPSHOT） */
  | 'manual'
  /** 设备档位预降级（缓解措施 5） */
  | 'device'
  /** 全屏入站：避免 iframe 叠加（架构 A4） */
  | 'fullscreen'
  /** 无需降级 */
  | 'none';

export interface DegradationInput {
  /** 当前挂在仪器架上的面板数（0..3） */
  readonly mountedCount: number;
  /** 探针最近一次判定；尚未采到第一窗时为 null */
  readonly probeLevel: 'ok' | 'warn' | 'breach' | null;
  /** 探针是否已经判定降级（有粘性：一旦降级不自动恢复，避免阈值边缘抖动） */
  readonly probeBreached: boolean;
  /** 演示/强制降级开关 */
  readonly manualSnapshot: boolean;
  readonly deviceTier: DeviceTier;
  /** 是否处于全屏入站态 */
  readonly fullscreen: boolean;
}

export interface DegradationDecision {
  readonly strategy: RenderStrategy;
  /** 允许同时存活的 iframe 数（0..mountedCount）。InstrumentRack 必须严格按这个数分配。 */
  readonly liveBudget: number;
  /**
   * 精简视觉模式：关掉 backdrop-filter、收敛发光与动效。
   * 这不是"降级装饰"，是实打实的合成开销削减 —— 多个 backdrop-filter 叠加在
   * 正在重绘的 iframe 之上时，浏览器每帧都要重新模糊背景，是 3 iframe 场景下
   * 最容易被忽视的一块主线程/GPU 成本。
   */
  readonly safeVisuals: boolean;
  readonly source: DegradationSource;
  /** 用一句人话解释为什么降级；strategy 为 all-live 时为空数组 */
  readonly reasons: readonly string[];
}

/** 全量模式：每个挂载的面板一个活 iframe。 */
function allLive(mountedCount: number): DegradationDecision {
  return {
    strategy: 'all-live',
    liveBudget: mountedCount,
    safeVisuals: false,
    source: 'none',
    reasons: [],
  };
}

/**
 * 计算降级决策。**纯函数**：同样的输入永远得到同样的输出。
 *
 * 优先级（从高到低，先命中先返回）：
 *   1. 全屏入站 → all-snapshot，预算 0。
 *      理由：全屏时星轨推到 10x，屏幕上只有 1 个站的内容，再留活 iframe 只是
 *      让它们在后台白烧 CPU，反而拖累那唯一在用的页面。
 *   2. 探针 breach → 1 活 N 快照。
 *   3. 手动 / 演示强制 → 1 活 N 快照。
 *   4. 低端设备且挂了 ≥2 台 → 1 活 N 快照（缓解措施 5 的"单仪器模式"）。
 *   5. 其余 → 全量。
 *
 * 一个刻意的克制：**挂载数 ≤ 1 时探针降级不生效**。
 *   因为「1 全量 + 2 快照」在只有 1 台仪器时等价于「把唯一那台也变快照」，
 *   用户会直接失去功能却换不到任何性能收益（本来就只有 1 个 iframe）。
 *   此时探针读数仍然在面板上显示为红，但不动渲染 —— 让人看见问题，而不是制造新问题。
 */
export function decideDegradation(input: DegradationInput): DegradationDecision {
  const { mountedCount, fullscreen, probeBreached, manualSnapshot, deviceTier } = input;

  // 1. 全屏入站：让位
  if (fullscreen) {
    return {
      strategy: 'all-snapshot',
      liveBudget: 0,
      safeVisuals: true,
      source: 'fullscreen',
      reasons: ['全屏入站：仪器架全部让位为快照，只保留当前站点全屏显示'],
    };
  }

  // 2. 探针判定（只在挂了 2 台以上时才真正改变渲染，见上方注释）
  if (probeBreached) {
    if (mountedCount <= 1) {
      return {
        ...allLive(mountedCount),
        safeVisuals: true,
        source: 'probe',
        reasons: ['探针判定超预算，但当前仅 1 台仪器，无可降级对象（已自动收敛视觉开销）'],
      };
    }
    return {
      strategy: 'one-live-rest-snapshot',
      liveBudget: 1,
      safeVisuals: true,
      source: 'probe',
      reasons: ['性能探针判定超预算（R-T03）：降级为 1 全量 + ' + (mountedCount - 1) + ' 静态快照'],
    };
  }

  // 3. 手动 / 演示强制
  if (manualSnapshot && mountedCount > 0) {
    return {
      strategy: 'one-live-rest-snapshot',
      liveBudget: mountedCount <= 1 ? mountedCount : 1,
      safeVisuals: true,
      source: 'manual',
      reasons: ['演示模式强制降级（NEXT_PUBLIC_HUB_FORCE_SNAPSHOT=true）'],
    };
  }

  // 4. 低端设备预降级：挂了 2 台以上才动手
  if (deviceTier === 'low' && mountedCount >= 2) {
    return {
      strategy: 'one-live-rest-snapshot',
      liveBudget: 1,
      safeVisuals: true,
      source: 'device',
      reasons: [
        '低端设备（navigator.hardwareConcurrency ≤ 4）：预降级为单仪器模式，' +
          '其余面板按需手动升级（R-T03 缓解措施 5）',
      ],
    };
  }

  // 5. 全量
  return allLive(mountedCount);
}

/** 给状态条/探针面板用的短标签。 */
export function strategyLabel(strategy: RenderStrategy): string {
  switch (strategy) {
    case 'all-live':
      return '全量';
    case 'one-live-rest-snapshot':
      return '1 活 2 快照';
    case 'all-snapshot':
      return '全部快照';
  }
}
