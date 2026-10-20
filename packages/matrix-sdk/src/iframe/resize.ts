/**
 * MatrixOS SDK · iframe 内容高度自适应（`layout.resize`）
 * ==========================================================================
 * 这是 ADR-08 的后半句落地：「iframe 高度自适应需要反复测量，容易出现双滚动条。
 * 必须统一约定 iframe 内不滚、由 hub 控制外层滚动。」
 *
 * `bridge.ts` 里 `BRIDGE_MSG.RESIZE = 'layout.resize'` 从协议第一版就存在，
 * 但一直**只有定义没有实现**（SDK 侧不发、hub 侧不监听）。本文件补上发送侧。
 *
 * ## 为什么必须做在 SDK 里，而不是每个微站自己写
 *
 * 18 个微站 + 第三方站都要做同一件事，而这件事有三个**容易写错且错了很难发现**的点：
 *   1. 测什么（见下「测量学」）—— 测错了得到的是视口高，于是「自适应」变成自我复制；
 *   2. 什么时候测 —— 测太勤会自激，测太懒会裁切；
 *   3. 怎么停 —— 没有停止条件就是无限循环。
 * 三条都是 ADR-09「18 站不得各自实现 18 种行为」的直接依据，所以统一在这里。
 *
 * ## 测量学：为什么不是 `documentElement.scrollHeight`
 *
 * ADR-08 的修复给 18 站加了
 *   `html:has(body[data-embedded='true']) { overflow: hidden; height: 100%; }`
 * 这条规则把 `<html>` 变成**固定高度的裁剪盒**，于是
 * `documentElement.scrollHeight === iframe 高度`（实测：626），**不再反映内容**。
 *
 * ### 为什么 `body.scrollHeight` 也不行（这是最反直觉的一条）
 *
 * `scrollHeight` 的语义是「内容 extent 与 clientHeight **取大**」，所以它至少有
 * 视口那么高。内容比视口矮时（官方 18 站里有 4 个：08/09/16/17），
 * `body.scrollHeight === iframe 高度`，把它当内容高上报就会**永远无法缩小面板**。
 *
 * 实测（Lead 独立复核 + 本会话复现）：
 *
 * | 站 | 真实内容 | `docEl.scrollHeight` | `body.scrollHeight` | 子元素底边 |
 * | :--- | ---: | ---: | ---: | ---: |
 * | 01-gpa | 965 | 626（压平） | 965 | **965** |
 * | 05-lit-sonar | 1231 | 626（压平） | 1231 | **1231** |
 * | 08-lab-kanban | **443** | 626 | **626（虚高）** | **443** |
 *
 * 结论：**只有子元素底边是可信读数**。`scrollHeight` 两个都只能当兜底，
 * 且必须只在「确实没有可量子元素」时用 —— 否则矮内容站会被固定报成视口高。
 *
 * ### 子元素底边怎么扫
 *
 * 遍历 `body.children`，逐个取 `getBoundingClientRect()`，跳过 `position:fixed`
 * （锚在视口，不构成文档内容）与不可见元素；若某个子元素自身内部还有溢出
 * （`scrollHeight > clientHeight`），把溢出量加进去（用
 * `rect.top - bodyTop + scrollHeight`），而不是拿 `scrollHeight` 当高度 ——
 * 后者对 `height:100%` 的包裹层又会掺进视口高。
 *
 * ## 防自激（这是本文件最容易被低估的部分）
 *
 * 反馈环：内容变高 → 上报 → hub 撑高 iframe → 微站视口变高 → 重新测量 → 再上报。
 * 真实站点里这条环**通常是收敛的**（内容高与视口无关），但下面两类会发散：
 *   - 站点用了 `min-height: 100vh` 之类（视口越高内容越高）；
 *   - 站点有 `calc(100vh + Npx)` 的容器。
 * 三种机制叠加把发散上限钉死在**有限步**内：
 *   1. **阈值**：与上次上报差 < `thresholdPx`（默认 2px）就不发 —— 视口变化引起的
 *      亚像素抖动被吃掉。**这道闸门任何档位都不跳过**（包括主动 flush）；
 *   2. **静默窗**：自己刚发完 `quietMs`（默认 160ms）内不重复测量，避免
 *      「hub 改高 → ResizeObserver 同步回调 → 立刻再发」；
 *   3. **增长连击熔断**：连续 `maxGrowthStreak`（默认 4）次上报都是「更高」，
 *      判定为视口耦合型发散，冻结上报并留痕。
 * 实测稳定后上报次数为 1（见 `test/resize.test.ts` 与 e2e 证据）。
 *
 * ## 载荷形状（为什么是两个数）
 *
 * ```ts
 * { height, viewport, appId }
 * ```
 *   - `height` —— **内容自然高度**（内容坐标系的绝对需求，不是「再多给我多少」）。
 *     hub 必须把它当「需求」而不是「指令」：最终高度由 hub 在自己的可用空间内决策，
 *     因为**只有 hub 知道自己能给多高**。见 `apps/orbital-hub/src/lib/panel-resize.ts`
 *     的 `decidePanelResize`。
 *   - `viewport` —— 上报时微站自己的视口高（= 当前 iframe 内容高度）。hub 用它判断
 *     「现在给的高度是不是已经够了」，也是排障时唯一能区分「内容 965 / 视口 626」
 *     与「内容 626 / 视口 626（本来就不高）」的依据。只有 height 一个数时这两件事
 *     看起来一样。
 *   - `appId` —— 上报方身份。hub 侧有多个 iframe 共用一个 `window` 的 message 事件，
 *     必须能确认「这条上报来自我这一格」，否则 A 站能把 B 站的面板撑高。
 *     **这不是信任来源**（信任只由 origin 校验给），而是**多路复用下的归属判定**。
 *     切勿把 appId 当安全边界用 —— 它可以被任意伪造，而 origin 不能。
 *
 * ## 降级
 *
 * 宿主必须在握手 ACK 的 `capabilities` 里声明 `layout.resize`。没声明（老 hub /
 * 非 hub 的嵌入者）时本模块**完全不发** —— 上报是纯副作用，老宿主拿不到也不会坏，
 * 但会白占 postMessage 通道，所以干脆不发。
 *
 * ## 微站接法
 *
 * `createMatrixSDK()` 默认自动启动（见 `sdk.ts` 的说明，避免 18 站各自改一行）；
 * 需要自己控制时机时调 `sdk.disableAutoResize()` 再自行调用 `startAutoResize()`。
 * 顶层独立打开时 `useHostBridge()` 返回惰性空桥（`connected === false`），
 * `startAutoResize` 会自己什么都不做 —— 微站不需要写 `if (isInIframe)`。
 */

import { BRIDGE_MSG } from './bridge.ts';
import type { HostBridge } from '../types.ts';

/** 宿主支持「内容高度自适应」的能力名。握手时双向声明。 */
export const LAYOUT_RESIZE_CAPABILITY = 'layout.resize';

/** 与上次上报差值小于它就不发（吃掉视口变化引起的亚像素抖动）。 */
export const RESIZE_THRESHOLD_PX = 2;
/** 测量合并窗口：连续多次 reflow 只测一次。 */
export const RESIZE_DEBOUNCE_MS = 120;
/** 自己刚上报完的静默期：期间不测量，直接切断「改高→回调→再发」的同步环。 */
export const RESIZE_QUIET_MS = 160;
/** 连续多少次「只涨不落」就判定为视口耦合型发散并冻结。 */
export const RESIZE_MAX_GROWTH_STREAK = 4;
/** 上报高度上限（防御性：坏测量 / 恶意站不能把 hub 布局炸掉）。 */
export const RESIZE_MAX_HEIGHT_PX = 3000;
/** 低于它的测量视为「测量不可用」（面板隐藏、iframe 未布局），不发。 */
export const RESIZE_MIN_HEIGHT_PX = 64;

/**
 * `layout.resize` 的载荷。
 *
 * 版本演进：本形状是**加字段**演进的（`appId` 后加），收侧必须容忍未知字段、
 * 缺失字段按「未提供」处理。
 */
export interface LayoutResizePayload {
  /** 内容自然高度（px，已取整）。**不是**「再要多少」，是绝对需求。 */
  readonly height: number;
  /** 上报时微站视口高（px），即当前 iframe 的内容盒高。 */
  readonly viewport: number;
  /** 上报方 appId（如 `gpa`），供 hub 在多 iframe 共用一个 message 事件时判归属。 */
  readonly appId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 测量
// ─────────────────────────────────────────────────────────────────────────────

export interface ResizeRectLike {
  readonly top: number;
  readonly bottom: number;
  readonly height?: number;
}

export interface ResizeElementLike {
  getBoundingClientRect?(): ResizeRectLike;
  readonly scrollHeight?: number;
  readonly clientHeight?: number;
  readonly offsetHeight?: number;
  readonly children?: ArrayLike<ResizeElementLike>;
}

/** `getComputedStyle(el)` 的最小结构面。 */
export type ResizeComputedStyleReader = (
  el: ResizeElementLike,
) => { readonly position?: string; readonly display?: string; readonly visibility?: string } | null;

/**
 * 测量所需的文档结构面。
 *
 * 刻意不引用 DOM 类型：SDK 的 tsconfig 不带 `lib.dom`（包里自带 `WindowLike`
 * 这类最小结构面），而且这样测试可以直接塞普通对象进来，不需要 jsdom。
 * 真实 `document` 结构上满足本接口。
 */
export interface ResizeDocumentLike {
  readonly documentElement?:
    | { readonly scrollHeight?: number; readonly clientHeight?: number }
    | null;
  readonly body?:
    | {
        readonly scrollHeight?: number;
        readonly clientHeight?: number;
        getBoundingClientRect?(): { readonly top: number; readonly height?: number };
        readonly children?: ArrayLike<ResizeElementLike>;
      }
    | null;
  readonly scrollY?: number;
}

function positive(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 从全局取 `getComputedStyle`（可能不存在：无头/测试环境）。 */
function defaultStyleReader(): ResizeComputedStyleReader | null {
  const candidate = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  if (typeof candidate !== 'function') return null;
  const fn = candidate as (el: unknown) => {
    position?: string;
    display?: string;
    visibility?: string;
  } | null;
  return (el) => {
    try {
      return fn(el);
    } catch {
      return null;
    }
  };
}

/**
 * 读内容自然高度。返回 0 表示「测不出来」（调用方应跳过本次上报，而不是发 0）。
 *
 * 算法（顺序有讲究，见文件头「测量学」）：
 *   1. **主读数：body 的子元素底边最大值** —— 唯一不掺视口高的量，矮内容站也准；
 *   2. 子元素里若某元素**自身可滚**（内容溢出它自己），把溢出量算进去；
 *   3. 只有**一个可量子元素都没有**时，才退回 `scrollHeight`（两侧取大）。
 *
 * 绝不用「`body.scrollHeight` 与子元素底边取 max」：那会把矮内容站钉死在视口高上。
 */
export function measureContentHeight(
  doc: ResizeDocumentLike | null | undefined,
  readStyle: ResizeComputedStyleReader | null = defaultStyleReader(),
): number {
  if (doc === null || doc === undefined) return 0;

  const body = doc.body;
  let best = 0;
  let measuredAny = false;

  if (body !== null && body !== undefined && typeof body.getBoundingClientRect === 'function') {
    let bodyTop = 0;
    try {
      bodyTop = body.getBoundingClientRect().top;
    } catch {
      bodyTop = 0;
    }

    const children = body.children;
    if (children !== undefined && children !== null) {
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child === undefined || typeof child.getBoundingClientRect !== 'function') continue;

        // 过滤 position:fixed / display:none / visibility:hidden —— 它们不构成文档内容。
        if (readStyle !== null) {
          const cs = readStyle(child);
          if (cs !== null) {
            if (cs.position === 'fixed') continue;
            if (cs.display === 'none') continue;
            if (cs.visibility === 'hidden') continue;
          }
        }

        let rect: ResizeRectLike;
        try {
          rect = child.getBoundingClientRect();
        } catch {
          continue;
        }
        const height = positive(rect.height) || positive(rect.bottom - rect.top);
        if (height <= 0) continue; // 零高元素（空 div / 已折叠）不参与

        measuredAny = true;
        // 元素自身的溢出：内容比它自己的盒子高时，真正的底边在盒子之外。
        // 用「元素顶 + scrollHeight」而不是直接取 scrollHeight：后者对
        // height:100% 的包裹层会等于视口高，又掺回去了。
        const offsetTop = positive(rect.top - bodyTop);
        const overflowBottom =
          typeof child.scrollHeight === 'number' && typeof child.clientHeight === 'number'
            ? offsetTop + child.scrollHeight
            : 0;
        const natural = Math.max(positive(rect.bottom - bodyTop), overflowBottom);
        if (natural > best) best = natural;
      }
    }
  }

  if (!measuredAny) {
    // 兜底：没有任何可量子元素（极端结构 / 测试替身）。此时 scrollHeight 是
    // 唯一可用信息；它至少等于视口高，所以在「本来就不高」的站上会偏大。
    // 这是有意识的降级：宁可偏大（不裁切），也不要在测不出时乱缩。
    const docEl = doc.documentElement;
    const fallback = Math.max(positive(docEl?.scrollHeight), positive(body?.scrollHeight));
    if (fallback > best) best = fallback;
  }

  // 向上取整：少 1px 会真的裁掉一行字，多 1px 看不出来。
  return best <= 0 ? 0 : Math.ceil(best);
}

/** 读当前视口高（= iframe 内容盒高）。测不出来返回 0。 */
export function measureViewportHeight(doc: ResizeDocumentLike | null | undefined): number {
  if (doc === null || doc === undefined) return 0;
  const fromElement = positive(doc.documentElement?.clientHeight);
  if (fromElement > 0) return fromElement;
  return positive(doc.body?.clientHeight);
}

// ─────────────────────────────────────────────────────────────────────────────
// 调度与观察（可注入，测试不需要真 DOM / 真定时器）
// ─────────────────────────────────────────────────────────────────────────────

export interface ResizeScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface ResizeObserverLike {
  observe(target: unknown): void;
  disconnect(): void;
}

/** 造一个观察器；宿主不支持时返回 null（调用方退化为仅首次上报）。 */
export type ResizeObserverFactory = (callback: () => void) => ResizeObserverLike | null;

const defaultScheduler: ResizeScheduler = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
  now: () => Date.now(),
};

/** 默认用 ResizeObserver（比轮询省电、且不丢中间态）；没有就返回 null。 */
function defaultObserverFactory(): ResizeObserverFactory | null {
  const Ctor = (globalThis as {
    ResizeObserver?: new (callback: () => void) => ResizeObserverLike;
  }).ResizeObserver;
  if (typeof Ctor !== 'function') return null;
  return (callback) => {
    try {
      return new Ctor(callback);
    } catch {
      return null;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 上报器
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoResizeStats {
  /** 真正发出去的上报条数 —— 防自激的核心证据。 */
  readonly reports: number;
  /** 测量次数（含被判为「不值得发」的）。 */
  readonly measurements: number;
  /** 因变化小于阈值而跳过的次数。 */
  readonly skippedThreshold: number;
  /** 因静默窗而跳过的次数。 */
  readonly skippedQuiet: number;
  readonly lastHeight: number;
  readonly growthStreak: number;
  /** 是否因增长连击熔断而冻结。 */
  readonly frozen: boolean;
  /** 宿主未声明能力 / 不在 iframe 内，完全降级。 */
  readonly degraded: boolean;
  /** 宿主已声明能力，可以正常上报。 */
  readonly supported: boolean;
}

export interface AutoResizeOptions {
  readonly bridge: HostBridge;
  /** 本站 appId（如 `gpa`）。写进载荷供 hub 判归属。 */
  readonly appId: string;
  /** 被测文档；省略时取全局 `document`。 */
  readonly doc?: ResizeDocumentLike | null;
  /** 被测窗口（用于判断是否在 iframe 里）；省略时取全局 `window`。 */
  readonly win?: { readonly parent?: unknown } | null;
  readonly scheduler?: ResizeScheduler;
  readonly createObserver?: ResizeObserverFactory | null;
  readonly thresholdPx?: number;
  readonly debounceMs?: number;
  readonly quietMs?: number;
  readonly maxGrowthStreak?: number;
  readonly maxHeightPx?: number;
  /** 单次握手的等待时长。 */
  readonly handshakeTimeoutMs?: number;
  /** 握手重试次数（宿主 listener 可能比子站脚本晚挂上）。 */
  readonly handshakeAttempts?: number;
  readonly debug?: boolean;
}

export interface AutoResizeReporter {
  /** 握手 → 能力确认 → 首次测量上报 → 开始观察。可重复调用（幂等）。 */
  start(): Promise<void>;
  /** 请求一次测量（合并到 debounce 窗口）。观察器回调走这里。 */
  check(): void;
  /** 立刻测量并上报（跳过静默窗，但仍守阈值与熔断）。 */
  flush(): void;
  stop(): void;
  readonly stats: AutoResizeStats;
}

/**
 * 造一个上报器。
 *
 * 刻意不在构造时做任何 DOM 访问或计时器启动 —— `start()` 才真正开始，
 * 这样上层可以先 `start()` 再决定 `stop()`，也方便测试逐帧推进。
 */
export function createAutoResizeReporter(options: AutoResizeOptions): AutoResizeReporter {
  const bridge = options.bridge;
  const scheduler = options.scheduler ?? defaultScheduler;
  const doc = options.doc === undefined ? defaultDocument() : options.doc;
  const thresholdPx = options.thresholdPx ?? RESIZE_THRESHOLD_PX;
  const debounceMs = options.debounceMs ?? RESIZE_DEBOUNCE_MS;
  const quietMs = options.quietMs ?? RESIZE_QUIET_MS;
  const maxGrowthStreak = options.maxGrowthStreak ?? RESIZE_MAX_GROWTH_STREAK;
  const maxHeightPx = options.maxHeightPx ?? RESIZE_MAX_HEIGHT_PX;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 1_500;
  const handshakeAttempts = Math.max(1, options.handshakeAttempts ?? 3);
  const debug = options.debug ?? false;
  const observerFactory =
    options.createObserver === undefined ? defaultObserverFactory() : options.createObserver;

  let started = false;
  let stopped = false;
  let frozen = false;
  let degraded = false;
  let supported = false;
  let observer: ResizeObserverLike | null = null;
  let pendingTimer: unknown = null;
  let lastSentHeight = -1;
  let lastSentAt = 0;
  let growthStreak = 0;
  let reports = 0;
  let measurements = 0;
  let skippedThreshold = 0;
  let skippedQuiet = 0;

  const stats: AutoResizeStats = {
    get reports() {
      return reports;
    },
    get measurements() {
      return measurements;
    },
    get skippedThreshold() {
      return skippedThreshold;
    },
    get skippedQuiet() {
      return skippedQuiet;
    },
    get lastHeight() {
      return lastSentHeight;
    },
    get growthStreak() {
      return growthStreak;
    },
    get frozen() {
      return frozen;
    },
    get degraded() {
      return degraded;
    },
    get supported() {
      return supported;
    },
  };

  function log(message: string): void {
    if (debug) console.debug(`[matrixos/sdk] layout.resize · ${message}`);
  }

  /** 只有握手 ACK 明确声明了能力才上报。老宿主 / 非 hub 嵌入者一律静默。 */
  function peerSupportsResize(): boolean {
    return bridge.peerCapabilities.includes(LAYOUT_RESIZE_CAPABILITY);
  }

  async function negotiate(): Promise<boolean> {
    for (let attempt = 0; attempt < handshakeAttempts; attempt += 1) {
      if (stopped) return false;
      if (peerSupportsResize()) return true;
      // `handshake()` 内部对已连接状态是幂等的；重试只为覆盖
      // 「宿主 listener 比子站脚本晚挂上」这一帧竞态。
      try {
        await withTimeout(bridge.handshake(), handshakeTimeoutMs, scheduler);
      } catch {
        // 握手失败不是错误路径：没有宿主就静默降级。
      }
      if (peerSupportsResize()) return true;
      if (!bridge.connected) {
        // 连不上就再等一拍，最多 handshakeAttempts 次。
        await sleep(Math.min(handshakeTimeoutMs, 400), scheduler);
      }
    }
    return peerSupportsResize();
  }

  function postResize(height: number): void {
    const viewport = measureViewportHeight(doc);
    const payload: LayoutResizePayload = {
      height,
      viewport,
      appId: options.appId,
    };
    lastSentHeight = height;
    lastSentAt = scheduler.now();
    reports += 1;
    log(`上报 #${reports}: height=${height} viewport=${viewport}`);
    try {
      bridge.post(BRIDGE_MSG.RESIZE, payload);
    } catch {
      // 发失败不影响微站自身：高度自适应是增强，不是前置条件。
    }
  }

  /**
   * 测量并决定是否上报。
   *
   * `mode` 三档，区别只在「跳过哪几道闸门」——**阈值永远不被跳过**（除首报）。
   * 这是刻意的：阈值是防自激的最后一道，任何档位都不该绕过它。曾经的实现让
   * `flush()` 跳过阈值，结果「调用方主动 flush」就等于把反馈环重新打开，
   * 单测当场抓到这个洞（同高度被连发 11 条）。
   *
   * - `initial`   —— 首次上报：跳过静默窗；无「上一次」所以阈值自然放行；
   * - `immediate` —— 主动 flush：跳过静默窗（是我们自己要测），但**守阈值**；
   * - `normal`    —— 观察器回调：静默窗 + 阈值都守。
   */
  function evaluate(mode: 'initial' | 'immediate' | 'normal'): void {
    if (stopped || frozen || !supported) return;
    const height = measureContentHeight(doc);
    measurements += 1;
    if (height < RESIZE_MIN_HEIGHT_PX) {
      // 测不出来（面板隐藏 / iframe 还没布局）—— 不发，绝不能把 hub 打个 0 过去。
      return;
    }

    const now = scheduler.now();
    if (mode === 'normal' && lastSentAt > 0 && now - lastSentAt < quietMs) {
      skippedQuiet += 1;
      return;
    }

    // 阈值：三种档位一律守（首报时 lastSentHeight<0，此判据自然放行）。
    if (lastSentHeight >= 0 && Math.abs(height - lastSentHeight) < thresholdPx) {
      skippedThreshold += 1;
      return;
    }

    const clamped = Math.min(height, maxHeightPx);
    if (lastSentHeight >= 0 && clamped > lastSentHeight) {
      growthStreak += 1;
      if (growthStreak >= maxGrowthStreak) {
        /*
         * 连续「只涨不落」= 内容高随视口增长。再报下去就是无限循环，
         * 所以冻结在最后一次上报上并留日志 —— 宁可留一条 hub 侧滚动条，
         * 也不要让面板高度无限增长。
         */
        frozen = true;
        log(`检测到视口耦合型增长（连续 ${growthStreak} 次只涨不落），冻结上报于 ${lastSentHeight}px`);
        return;
      }
    } else {
      growthStreak = 0;
    }

    postResize(clamped);
  }

  function scheduleCheck(): void {
    if (stopped || pendingTimer !== null) return;
    pendingTimer = scheduler.setTimeout(() => {
      pendingTimer = null;
      evaluate('normal');
    }, debounceMs);
  }

  return {
    async start(): Promise<void> {
      if (started || stopped) return;
      started = true;

      /*
       * 顶层独立打开时 `useHostBridge()` 给的是惰性空桥（role='host', connected=false），
       * 此时根本不该尝试握手 —— 微站不该为了「可能在未来被嵌入」而付一次 3s 超时。
       */
      if (!(options.win === undefined ? defaultInIframe() : isInIframe(options.win))) {
        degraded = true;
        log('不在 iframe 内，跳过高度自适应');
        return;
      }

      supported = await negotiate();
      if (!supported) {
        degraded = true;
        log('宿主未声明 layout.resize 能力（老 hub 或非 hub 嵌入者），降级为不上报');
        return;
      }
      if (stopped) return;

      // 首次必须发：hub 面板在收到第一条上报前只有默认高度。
      evaluate('initial');

      if (observerFactory !== null) {
        try {
          observer = observerFactory(() => scheduleCheck());
          if (observer !== null) {
            for (const target of observerTargets(doc)) {
              try {
                observer.observe(target);
              } catch {
                // 某个 target 不可观察不影响其他。
              }
            }
          }
        } catch {
          observer = null;
        }
      }
      if (observer === null) {
        log('无 ResizeObserver 可用，退化为仅首次上报');
      }
    },

    check(): void {
      scheduleCheck();
    },

    flush(): void {
      evaluate('immediate');
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      if (pendingTimer !== null) {
        scheduler.clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      observer?.disconnect();
      observer = null;
    },

    stats,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 便捷入口（微站用这一个）
// ─────────────────────────────────────────────────────────────────────────────

export interface StartAutoResizeOptions {
  readonly bridge: HostBridge;
  readonly appId: string;
  readonly debug?: boolean;
  readonly thresholdPx?: number;
  readonly debounceMs?: number;
  readonly quietMs?: number;
  readonly maxGrowthStreak?: number;
}

/**
 * 微站接入入口。返回 reporter（`stop()` 可解绑）。顶层/非 iframe 场景自动 no-op。
 *
 * 注意 `createMatrixSDK()` 已默认自动启动一份，正常微站**不需要**调用本函数；
 * 它存在是为了「站点要自己控制时机」的场景。
 */
export function startAutoResize(options: StartAutoResizeOptions): AutoResizeReporter {
  const reporter = createAutoResizeReporter({
    bridge: options.bridge,
    appId: options.appId,
    doc: defaultDocument(),
    win: defaultWindow(),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
    ...(options.thresholdPx === undefined ? {} : { thresholdPx: options.thresholdPx }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
    ...(options.maxGrowthStreak === undefined ? {} : { maxGrowthStreak: options.maxGrowthStreak }),
  });
  void reporter.start();
  return reporter;
}

// ─────────────────────────────────────────────────────────────────────────────
// 全局访问（全部经 unknown 窄化，SDK 不带 lib.dom）
// ─────────────────────────────────────────────────────────────────────────────

function globalObject(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function defaultDocument(): ResizeDocumentLike | null {
  const doc = globalObject()['document'];
  return doc !== null && typeof doc === 'object' ? (doc as ResizeDocumentLike) : null;
}

function defaultWindow(): { readonly parent?: unknown } | null {
  const win = globalObject()['window'];
  return win !== null && typeof win === 'object' ? (win as { readonly parent?: unknown }) : null;
}

function isInIframe(win: { readonly parent?: unknown } | null): boolean {
  if (win === null) return false;
  return win.parent !== undefined && win.parent !== null && win.parent !== win;
}

function defaultInIframe(): boolean {
  return isInIframe(defaultWindow());
}

/** ResizeObserver 要观察哪些节点：html + body 两层都变（html 被 height:100% 压平，body 承载内容）。 */
function observerTargets(doc: ResizeDocumentLike | null): unknown[] {
  if (doc === null) return [];
  const targets: unknown[] = [];
  if (doc.documentElement !== undefined && doc.documentElement !== null) targets.push(doc.documentElement);
  if (doc.body !== undefined && doc.body !== null) targets.push(doc.body);
  // 官方站的真正内容在 `.site-root` 上；有就一起观察，没有就算了。
  const withQuery = doc as { querySelectorAll?: (selector: string) => ArrayLike<unknown> };
  if (typeof withQuery.querySelectorAll === 'function') {
    try {
      const root = withQuery.querySelectorAll('.site-root');
      if (root.length > 0 && root[0] !== null && root[0] !== undefined) targets.push(root[0]);
    } catch {
      /* ignore */
    }
  }
  return targets;
}

function withTimeout<T>(promise: Promise<T>, ms: number, scheduler: ResizeScheduler): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = scheduler.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`layout.resize 握手超时（${ms}ms）`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        scheduler.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        scheduler.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function sleep(ms: number, scheduler: ResizeScheduler): Promise<void> {
  return new Promise((resolve) => {
    scheduler.setTimeout(() => resolve(), ms);
  });
}

/** 收侧校验用同一条规则：一条 `layout.resize` 消息应满足的形状。 */
export function isLayoutResizePayload(value: unknown): value is LayoutResizePayload {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const height = record['height'];
  const viewport = record['viewport'];
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return false;
  if (typeof viewport !== 'number' || !Number.isFinite(viewport) || viewport < 0) return false;
  const appId = record['appId'];
  if (appId !== undefined && typeof appId !== 'string') return false;
  return true;
}
