/**
 * orbital-hub · `layout.resize` 宿主侧决策
 * ==========================================================================
 * 对端是 `packages/matrix-sdk/src/iframe/resize.ts`（微站侧发送）。本文件是**收侧**，
 * 负责三件互相独立的事，刻意拆成纯函数 + 一个薄组件钩子：
 *
 *   1. `parseLayoutResizePayload` —— 把任意 `unknown` 收窄成可信的载荷；
 *   2. `decidePanelResize`       —— 纯决策：内容高 + 可用高 → iframe 该多高；
 *   3. `createPanelResizeReceiver` —— 桥的接线（origin 校验由 SDK 的 host 桥负责）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## 决策逻辑（这是本文件最重要的一段，也是唯一「有设计取舍」的地方）
 *
 * 先说清楚**为什么不能把 iframe 直接设成内容高而不给滚动容器**：
 * `.panel-body` 的高度由 grid 决定（1920×1080 下 807px，1600×900 下 627px），
 * 内容是 955–1221px。若 iframe 设成 1221px 而 `.panel-body` 仍是 627px 且
 * `overflow:hidden`，外侧只是把这 594px 又裁掉了 —— 等于什么都没解决。
 * 若 `.panel-body` 改成 `overflow:visible`，则整块会溢出到 hub 外层，
 * 出现「hub 外层滚动条」，正是 ADR-08 反对的双滚动条。
 *
 * 正确的组合只有一种，两个变量必须**同时**满足：
 *
 * ```
 * iframe 高度 = max(内容高, 可用高)      ← 必须 >= 内容高，否则 iframe 内部会裁
 * .panel-body = 可用高 + overflow-y:auto  ← 唯一的滚动容器，在 hub 侧
 * ```
 *
 * 为什么 iframe 一定要 `>= 内容高`（而不是 Lead 最初设想的「设成可用高」）：
 * `.panel-body` 是滚动**视口**，iframe 是它的**内容**。若 iframe 只有 627px，
 * 滚动范围 = 627 - 627 = 0，滚不动，微站内部又被 `overflow:hidden` 压着
 * （ADR-08 已达标项），那 328px 内容依旧不可达 —— 只是把「裁掉」换成了「裁掉且白送一个滚不动的滚动条」。
 * iframe 撑到内容高后，滚动范围 = 955 - 627 = 328px，且 iframe 自己的视口
 * = 955 = 内容高，**内部 `maxScroll` 仍是 0**（ADR-08 不破）。
 *
 * 内容比可用高**矮**时（如 08-lab-kanban 433px），iframe 保持可用高而不是缩到 433：
 *   - 缩下去会在面板底部留一块死白，没有任何收益；
 *   - 不缩则内部 `maxScroll` 同样是 0（视口 > 内容），零回归。
 * 也就是说 `max(内容, 可用)` 这一个式子同时覆盖了「装不下」和「装得下」两种情形。
 *
 * ## 可用高必须实时读
 *
 * 807 / 627 这两个数是同一套 CSS 在不同视口下的结果，**不能写死**。所以每次决策
 * 都重新量 `.panel-body.getBoundingClientRect().height`，并在 `ResizeObserver` /
 * `window.resize` 时重算 —— 否则用户拖动窗口后 iframe 高度就停在旧值上。
 *
 * ## 防自激（收侧）
 *
 * 宿主的动作会改变对端的测量输入，所以收侧也必须收敛：
 *   - 高度变化 < 1px 不写；写入前与**当前已应用值**比较，相同就不动 DOM（避免
 *     「收到上报 → 设高度 → 触发 iframe resize → 微站再上报 → 高度相同但
 *     又设一次」的无效循环）；
 *   - 每个面板最多接受 `MAX_APPLIES_PER_BURST` 次「只涨」的调整，超了就停在
 *     最后一次并把状态标成 `frozen` 供排障（微站侧也有一条同样的熔断，两层兜底）；
 *   - 微站侧还有 2px 阈值 + 160ms 静默窗（见 SDK 的 `resize.ts`）。
 */

/** 一条 `layout.resize` 的可信载荷。形状与 SDK 侧 `LayoutResizePayload` 一致。 */
export interface LayoutResizePayload {
  /** 内容自然高度（px）——**需求**，不是命令。 */
  readonly height: number;
  /** 上报时微站视口高（px，= 当时的 iframe 内容盒高）。 */
  readonly viewport: number;
  /** 上报方 appId，用于日志与归属断言。 */
  readonly appId?: string;
}

export interface PanelResizeDecision {
  /** 应该应用到 iframe 的 CSS 高度（px，整数）。 */
  readonly iframeHeight: number;
  /** 微站上报的内容高（clamp 前）。 */
  readonly contentHeight: number;
  /** `.panel-body` 当前可用高（px，整数）。 */
  readonly availableHeight: number;
  /**
   * `.panel-body` 是否要变成滚动容器。
   * `false` 时保持 `overflow:hidden`（现状，零回归）。
   */
  readonly scrollable: boolean;
  /** 可滚动距离 = iframeHeight - availableHeight（scrollable 时 > 0）。 */
  readonly scrollRange: number;
}

/** 内容高上限：坏测量 / 恶意站不能把面板变成无限长。与 SDK 侧的上限一致。 */
export const MAX_IFRAME_HEIGHT_PX = 3000;

/**
 * 解析 `layout.resize` 载荷。
 *
 * 容忍度是刻意的：**未知字段忽略**、`appId` 可缺（协议加字段演进的代价），
 * 但 `height` / `viewport` 必须是有限正数 —— 一个 `NaN` 高度会让 CSS 变成
 * `height: NaNpx`（被浏览器丢弃），面板停在旧高度且看不出原因。
 */
export function parseLayoutResizePayload(value: unknown): LayoutResizePayload | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const height = record['height'];
  const viewport = record['viewport'];
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null;
  if (typeof viewport !== 'number' || !Number.isFinite(viewport) || viewport < 0) return null;
  const appId = record['appId'];
  const parsed: LayoutResizePayload = {
    height: Math.round(height),
    viewport: Math.round(viewport),
    ...(typeof appId === 'string' && appId.length > 0 ? { appId } : {}),
  };
  return parsed;
}

export interface DecidePanelResizeInput {
  /** 微站上报的内容高（px）。 */
  readonly contentHeight: number;
  /** `.panel-body` 实时可用高（px）。<= 0 时说明面板还没布局，调用方应跳过。 */
  readonly availableHeight: number;
  readonly maxHeightPx?: number;
}

/**
 * 量 `.panel-body` 的可用高。
 *
 * **用 `clientHeight` 而不是 `getBoundingClientRect().height`**：iframe 是
 * `position:absolute; inset:0`，它的包含块是 `.panel-body` 的 **padding box**；
 * `getBoundingClientRect()` 给的是 **border box**。两者在 `.panel-body` 有边框时
 * 差一个边框宽（原型里实测差 2px：627 的样式高被量成 629）。
 * 2px 在「iframe 内部不许滚」这条硬约束下不是小事 —— 量大了会让 iframe 比可用空间
 * 高 2px，`.panel-body` 就多出一个本不该有的 2px 滚动量。
 */
export function measureAvailableHeight(el: { readonly clientHeight?: number } | null): number {
  if (el === null) return 0;
  return Math.max(0, Math.round(el.clientHeight ?? 0));
}

/**
 * 纯决策函数：内容高 + 可用高 → iframe 高度 + 是否滚动。
 *
 * 见文件头的推导。一句话总结：**iframe 永远不矮于内容，也不矮于可用高**；
 * 超出可用空间的部分由 `.panel-body` 滚动，iframe 内部永不滚。
 */
export function decidePanelResize(input: DecidePanelResizeInput): PanelResizeDecision {
  const maxHeightPx = input.maxHeightPx ?? MAX_IFRAME_HEIGHT_PX;
  const contentHeight = Math.max(1, Math.round(input.contentHeight));
  const availableHeight = Math.max(0, Math.round(input.availableHeight));

  // 面板还没布局（被隐藏 / 首帧前）：不做决定，调用方据此跳过本次应用。
  if (availableHeight <= 0) {
    return {
      iframeHeight: 0,
      contentHeight,
      availableHeight: 0,
      scrollable: false,
      scrollRange: 0,
    };
  }

  const iframeHeight = Math.min(Math.max(contentHeight, availableHeight), maxHeightPx);
  const scrollRange = Math.max(0, iframeHeight - availableHeight);
  return {
    iframeHeight,
    contentHeight,
    availableHeight,
    scrollable: scrollRange > 0,
    scrollRange,
  };
}

/**
 * 判断是否需要把决策写进 DOM。
 *
 * 单独抽出来是因为这条判断就是收侧防自激的核心：高度相同就**必须**什么都不做。
 * 用 `>= 1px` 而不是 `===`：CSS 高度会被取整，浮点差异写进去也是同样的渲染结果，
 * 但会白白触发一次 reflow。
 */
export function shouldApplyDecision(
  decision: PanelResizeDecision,
  appliedHeight: number,
  appliedScrollable: boolean,
): boolean {
  if (decision.iframeHeight <= 0) return false;
  if (Math.abs(decision.iframeHeight - appliedHeight) >= 1) return true;
  return decision.scrollable !== appliedScrollable;
}

// ─────────────────────────────────────────────────────────────────────────────
// 接线：把桥上的 layout.resize 事件接到一个面板的 DOM
// ─────────────────────────────────────────────────────────────────────────────

/** 收侧熔断：连续多少次「只涨」就停在当前值。与 SDK 侧 `RESIZE_MAX_GROWTH_STREAK` 同义。 */
export const MAX_GROWTH_APPLIES = 6;

export interface PanelResizeStats {
  /** 收到并通过校验的上报条数。 */
  readonly received: number;
  /** 真正写进 DOM 的次数（防自激证据：稳定后应停止增长）。 */
  readonly applied: number;
  /** 因「高度未变」被跳过的次数。 */
  readonly skippedUnchanged: number;
  /** 因载荷非法被丢弃的次数（防御：坏数据不该动布局）。 */
  readonly rejected: number;
  readonly lastContentHeight: number;
  readonly iframeHeight: number;
  readonly availableHeight: number;
  readonly scrollable: boolean;
  /** 收侧熔断是否已触发。 */
  readonly frozen: boolean;
}

export interface PanelResizeBindingOptions {
  /** iframe 元素；不存在（面板未创建 iframe）时不接线。 */
  readonly iframe: { readonly style: { height: string }; getBoundingClientRect(): { height: number } } | null;
  /** `.panel-body` 元素：可用空间的持有者，也是唯一滚动容器。 */
  readonly panelBody:
    | {
        readonly clientHeight: number;
        readonly style: { overflowY: string; overflow: string };
      }
    | null;
  readonly maxHeightPx?: number;
  readonly debug?: boolean;
}

export interface PanelResizeBinding {
  /** 桥上收到一条 `layout.resize` 时调用。载荷未校验，本函数内部收窄。 */
  handle(raw: unknown): void;
  /**
   * 可用空间变了（窗口 resize / 面板布局变化）时重算。
   *
   * 必须存在：`807` 与 `627` 是同一套 CSS 在不同视口下的结果，可用高**不能写死**，
   * 否则用户拖动窗口后 iframe 停在旧值上。
   */
  reflow(): void;
  /** 解绑：把 iframe 高度与 overflow 恢复成「未接管」状态（切回快照/卸载时用）。 */
  reset(): void;
  readonly stats: PanelResizeStats;
}

/**
 * 为一个面板接线。
 *
 * 只做「收到上报 → 决策 → 写样式」，不做任何 DOM 之外的事（不持有桥、不监听 window），
 * 这样组件层可以自由决定生命周期，也便于用假元素做单测。
 */
export function createPanelResizeBinding(options: PanelResizeBindingOptions): PanelResizeBinding {
  const maxHeightPx = options.maxHeightPx ?? MAX_IFRAME_HEIGHT_PX;
  let appliedHeight = 0;
  let appliedScrollable = false;
  let lastContentHeight = 0;
  let received = 0;
  let applied = 0;
  let skippedUnchanged = 0;
  let rejected = 0;
  let growthBudget = MAX_GROWTH_APPLIES;
  let frozen = false;

  function availableHeight(): number {
    return measureAvailableHeight(options.panelBody);
  }

  const stats: PanelResizeStats = {
    get received() {
      return received;
    },
    get applied() {
      return applied;
    },
    get skippedUnchanged() {
      return skippedUnchanged;
    },
    get rejected() {
      return rejected;
    },
    get lastContentHeight() {
      return lastContentHeight;
    },
    get iframeHeight() {
      return appliedHeight;
    },
    get availableHeight() {
      return availableHeight();
    },
    get scrollable() {
      return appliedScrollable;
    },
    get frozen() {
      return frozen;
    },
  };

  function apply(contentHeight: number): void {
    const iframe = options.iframe;
    const panelBody = options.panelBody;
    if (iframe === null || panelBody === null) return;

    const decision = decidePanelResize({ contentHeight, availableHeight: availableHeight(), maxHeightPx });
    if (decision.iframeHeight <= 0) return; // 面板还没布局

    if (!shouldApplyDecision(decision, appliedHeight, appliedScrollable)) {
      skippedUnchanged += 1;
      return;
    }

    // 收侧熔断：连着只涨就停住。微站侧也有一条（RESIZE_MAX_GROWTH_STREAK），两层兜底。
    if (decision.iframeHeight > appliedHeight && appliedHeight > 0) {
      growthBudget -= 1;
      if (growthBudget < 0) {
        frozen = true;
        if (options.debug === true) {
          console.warn('[layout.resize] 收侧熔断：连续只涨，停在 ' + appliedHeight + 'px');
        }
        return;
      }
    } else {
      growthBudget = MAX_GROWTH_APPLIES;
    }

    appliedHeight = decision.iframeHeight;
    appliedScrollable = decision.scrollable;
    iframe.style.height = appliedHeight + 'px';
    /*
     * 唯一滚动容器放在 hub 侧。`scrollable=false` 时显式写回 hidden：
     * 面板可能先被撑高（auto）后内容又变矮，不写回就会留一个「没有滚动量但
     * overflow:auto」的容器 —— 触控板横滑时可能露出来。
     */
    panelBody.style.overflowY = decision.scrollable ? 'auto' : 'hidden';
    applied += 1;
  }

  return {
    handle(raw: unknown): void {
      if (frozen) return;
      const parsed = parseLayoutResizePayload(raw);
      if (parsed === null) {
        rejected += 1;
        return;
      }
      received += 1;
      lastContentHeight = parsed.height;
      apply(parsed.height);
    },

    reflow(): void {
      // 可用空间变了：用**上次上报的内容高**重算，不需要等微站再报一次。
      if (lastContentHeight <= 0) return;
      apply(lastContentHeight);
    },

    reset(): void {
      appliedHeight = 0;
      appliedScrollable = false;
      lastContentHeight = 0;
      growthBudget = MAX_GROWTH_APPLIES;
      frozen = false;
      if (options.iframe !== null) options.iframe.style.height = '';
      if (options.panelBody !== null) options.panelBody.style.overflowY = '';
    },

    stats,
  };
}
