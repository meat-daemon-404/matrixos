/**
 * orbital-hub · 面板「内容装不下 / 桥没接通」的可感知提示（ADR-09）
 * ==========================================================================
 * `panel-resize.ts` 的 `decidePanelResize` 早就算出了 `scrollRange`（内容比面板
 * 可用高高出多少），但此前**没有任何 UI 表达**。线上实测：面板 `.panel-body` 只有
 * 627px，微站内容 1593px —— 用户看到的是「页面滚不动了」，而真实状态是
 * 「还有 966px 在下面，滚轮在 hub 侧、不在你面前的这块 iframe 里」。
 *
 * ADR-09 的强制要求是「降级/受限状态必须在 UI 上**显式可见**，不允许静默降级」。
 * 本文件补的就是这一层：把「装不下」与「自适应根本没接通」这两种受限状态变成
 * 用户能看见的一句话。
 *
 * ## 为什么单独一个文件，而不是塞进 panel-resize.ts
 *
 * 「多高、要不要滚」是**协议行为**，「说什么话、什么时候说」是**呈现行为**。
 * 两者变更节奏完全不同：调文案不该有碰坏那套已实证的决策逻辑的机会。
 * 拆开之后这里全是纯函数，可以直接 `node --test` 覆盖边界（见同名 .test.mjs）。
 *
 * ## 三种状态，各自的前提不同（别把它们混成一个「兜底提示」）
 *
 *   1. `none` —— 装得下，什么都不说（默认态，绝大多数面板走这里）；
 *   2. `overflow` —— 内容确实超出可用高，hub 已接管滚动（`scrollRange > 0`）。
 *      告诉用户「可以滚」，并给出「全屏可看全」这个永远成立的出口；
 *   3. `bridge-gap` —— 一条 `layout.resize` 上报都没收到。此时 iframe 停在容器高，
 *      用户看到的是**静默裁切**（线上 966px 不可达就是这一态）。必须如实说出来，
 *      并且**绝不**在没握手时说「已连通」。
 *
 * `overflow` 与 `bridge-gap` 互斥：有上报才可能有 overflow，而 bridge-gap 的前提
 * 恰好是「没上报」。同时成立时（防御性）以 overflow 为准 —— 有真实数字就该报数字。
 *
 * ## 水合：本文件不读任何全局
 *
 * 所有输入由调用方（`usePanelResize` 的返回值 + 组件）显式传入，没有 `window` /
 * `document` / `Date.now()`。首帧因此与 SSR 完全一致（SSR 阶段调用方给的是全零
 * 状态 → 渲染出 `none`），不会产生 React #418 那种文本不一致。
 *
 * ## 为什么本文件**零 import**（这条约束是硬的，别为了省几行打破它）
 *
 * 本仓库的单测跑法是不带任何 loader 的 `node --test`（Node 原生 ESM loader +
 * Node 24 的类型剥离），它直接加载 `.ts` 源码。这种模式下 ESM 解析**要求显式
 * 扩展名**，而 hub 的 tsconfig 是 `moduleResolution: Bundler`（站内 import 不带
 * 扩展名）。两边只能二选一：
 *
 *   - 写 `from './panel-resize'` → tsc 绿，`node --test` 红
 *     （实测 `ERR_MODULE_NOT_FOUND`，本轮在 Lead 复核时被抓到过一次）；
 *   - 写 `from './panel-resize.ts'` → 测试绿，tsc 红（除非再开
 *     `allowImportingTsExtensions`，那会引入一条全仓其它包都没有的约定）。
 *
 * 所以本文件**不 import 任何站内模块**：需要的常量（如高度上限）由调用方从
 * `panel-resize.ts` 传入。这样「一个真相来源」由结构保证（全仓只有一处定义），
 * 而不是靠两份常量 + 一条断言去守。
 *
 * `queue-client.test.mjs` 一直绿，正是因为 `queue-client.ts` 没有任何站内 import。
 * 这是同一约束的另一面：**能被 `node --test` 直接加载的模块必须自包含**。
 */

/**
 * 桥迟迟不握手、或握了手却不上报时，等多久才提示。
 *
 * 为什么要有等待期：iframe `onLoad` 之后子站脚本才启动、SDK 才建桥、测量才发生，
 * 这段时间里「没有上报」是**正常的**，提前报警等于制造噪音（狼来了）。
 * 5s 覆盖了 SDK 侧 `negotiate()` 的 3 次重试窗口（1.5s × 3）再留一点余量 ——
 * 超过 5s 还没动静，就基本可以判定链路真的断了。
 */
export const PANEL_BRIDGE_GRACE_MS = 5_000;

/** 面板溢出的事实（来自 `PanelResizeStats`，全部是实测值，不含推测）。 */
export interface PanelOverflowFacts {
  /** 可滚动距离 = iframe 高 - 可用高；`<= 0` 表示装得下。 */
  readonly scrollRange: number;
  /**
   * 协议高度上限（px）。**必填**，由调用方从 `panel-resize.ts` 的
   * `MAX_IFRAME_HEIGHT_PX` 传进来（原因见文件头「为什么本文件零 import」）。
   *
   * 必填而不是带默认值：默认值就等于在本文件里再抄一份 3000，两份数一旦漂移，
   * 提示条会向用户报一个假的上限。必填让「调了协议上限却忘了改提示」变成
   * **编译错误**，而不是一个只在线上才被发现的口径不一致。
   */
  readonly maxHeightPx: number;
  /** 微站上报的内容高（clamp 前）。 */
  readonly contentHeight?: number;
  /** `.panel-body` 当前可用高。 */
  readonly availableHeight?: number;
  /** 实际应用到 iframe 的高度（已按上限 clamp）。 */
  readonly iframeHeight?: number;
  /** 收侧熔断是否触发（连续「只涨」被停住，排障关键信息）。 */
  readonly frozen?: boolean;
}

/** 宿主桥的事实。`hasReport` 是「收到过任何一条通过校验的 layout.resize」。 */
export interface PanelBridgeFacts {
  readonly connected: boolean;
  readonly hasReport: boolean;
  /** 自 iframe 就绪以来的毫秒数。 */
  readonly elapsedMs: number;
  /** 覆盖 `PANEL_BRIDGE_GRACE_MS`（测试用）。 */
  readonly graceMs?: number;
}

export interface PanelNoticeInput {
  readonly overflow: PanelOverflowFacts;
  /** `null` / 省略 = 当前不该谈桥（面板不是 live、或 iframe 还没就绪）。 */
  readonly bridge?: PanelBridgeFacts | null;
}

export interface PanelNotice {
  readonly visible: boolean;
  readonly kind: 'none' | 'overflow' | 'bridge-gap';
  /** 面向用户的一句话（克制、不带技术黑话）。 */
  readonly text: string;
  /** 排障明细：放 `title`，不占视觉空间。 */
  readonly detail: string;
  /** 「全屏」出口的文案；`kind === 'none'` 时为空串。 */
  readonly action: string;
}

/** 不可见态。用共享常量而不是每次 new：组件里比较/渲染都不需要新对象。 */
const HIDDEN: PanelNotice = {
  visible: false,
  kind: 'none',
  text: '',
  detail: '',
  action: '',
};

/** 把脏输入（NaN / 负数 / Infinity）压成 0 —— 提示层绝不能因为坏数值而炸或乱报。 */
function safePx(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/**
 * 内容溢出 → 提示。
 *
 * 只在 `scrollRange > 0` 时可见：**恰好装得下（差 0px）不提示**。
 * 这一条是刻意的 —— 内容等于面板高时没有任何东西被藏起来，此时弹一个
 * 「面板内可滚动」就是对用户撒谎，而且会让提示频繁闪烁（窗口拖动 1px 就穿越阈值）。
 */
export function describePanelOverflow(facts: PanelOverflowFacts): PanelNotice {
  const scrollRange = safePx(facts.scrollRange);
  if (scrollRange <= 0) return HIDDEN;

  const contentHeight = safePx(facts.contentHeight);
  const availableHeight = safePx(facts.availableHeight);
  const iframeHeight = safePx(facts.iframeHeight);
  /**
   * 协议上限。调用方必填，但这里仍按脏输入防御：
   * 拿不到一个可信的正数时，**放弃「撞上限」这个判断**（`capped` 恒 false）。
   * 宁可少说一句「已到上限」，也不能拿 `NaN` 去比出一个假的结论。
   */
  const maxHeightPx = safePx(facts.maxHeightPx);

  /*
   * 「撑到上限仍装不下」的判据用**上报的内容高 vs 协议上限**，不是 vs 当前
   * iframe 高。
   *
   * 为什么不用 `contentHeight > iframeHeight`：收侧熔断（frozen）时 iframe 会
   * 停在半路（比如 1200px），此时 `contentHeight(1593) > iframeHeight(1200)` 也成立，
   * 但真实原因是熔断而非「撞到 3000 上限」—— 两者混在一起，detail 里就会同时
   * 出现「已到 3000px 上限」（假的，当前只有 1200）和「已熔断」，自相矛盾。
   *
   * 这一点必须说清楚：撞上限时**连 hub 侧滚动也到不了那部分内容**
   * （iframe 内部不滚，ADR-08），所以不能假装「滚一下就能看全」。
   *
   * `maxHeightPx > 0` 是必要条件：上限字段是脏值时（见上）不做这个判断，
   * 否则 `contentHeight > 0` 会恒成立，每条提示都变成「已到上限」。
   */
  const capped = contentHeight > 0 && maxHeightPx > 0 && contentHeight > maxHeightPx;

  const text = capped ? '内容超长 · 面板内可滚动（已到高度上限）' : '内容较长 · 面板内可滚动';

  const parts: string[] = [];
  if (contentHeight > 0) parts.push('内容 ' + contentHeight + 'px');
  if (availableHeight > 0) parts.push('面板 ' + availableHeight + 'px');
  parts.push('可滚动 ' + scrollRange + 'px');
  if (capped) {
    parts.push(
      '内容超过 iframe 高度上限 ' + maxHeightPx + 'px，超出部分在面板内滚不到，只能全屏查看',
    );
  }
  if (facts.frozen === true) parts.push('自适应已熔断（连续只涨，停在 ' + (iframeHeight || 0) + 'px）');

  return {
    visible: true,
    kind: 'overflow',
    text,
    detail: parts.join(' · '),
    action: capped ? '↗ 全屏看全' : '↗ 全屏可看全',
  };
}

/**
 * 桥没接通 / 没上报 → 提示。
 *
 * 这是线上 966px 不可达的那一态：iframe 停在容器高、内容被裁切，而用户完全
 * 不知道。两种子情形的文案必须区分，因为它们指向的修复完全不同：
 *   - `connected === false`：握手就没成功（子站 hello 丢失 / origin 白名单拒绝宿主）；
 *   - `connected === true` 但 `hasReport === false`：握手通了，微站侧却没集成上报
 *     （老版本微站 / 没调 `startAutoResize()`）。
 */
export function describePanelBridgeGap(facts: PanelBridgeFacts): PanelNotice {
  if (facts.hasReport) return HIDDEN;

  const elapsedMs = facts.elapsedMs;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return HIDDEN;

  const graceMs = facts.graceMs ?? PANEL_BRIDGE_GRACE_MS;
  // 还在正常启动窗口内：这是「可能」而不是「异常」，先不说。
  if (elapsedMs < graceMs) return HIDDEN;

  const waited = '已等待 ' + Math.round(elapsedMs) + 'ms';

  if (facts.connected) {
    return {
      visible: true,
      kind: 'bridge-gap',
      text: '微站未上报内容高度 · 内容可能被裁切',
      detail:
        '宿主桥已连通，但 ' +
        Math.round(elapsedMs) +
        'ms 内没收到 layout.resize 上报（微站可能未集成 SDK 自适应）',
      action: '↗ 全屏查看',
    };
  }

  return {
    visible: true,
    kind: 'bridge-gap',
    text: '高度自适应未接通 · 内容可能被裁切',
    detail:
      '宿主桥未完成握手（' +
      waited +
      '）：子站的 hello 可能早于宿主 listener 而丢失，或 origin 白名单拒绝了宿主',
    action: '↗ 全屏查看',
  };
}

/**
 * 组件唯一入口：先看溢出（有实测数字就是最硬的证据），再看桥。
 */
export function describePanelNotice(input: PanelNoticeInput): PanelNotice {
  const overflow = describePanelOverflow(input.overflow);
  if (overflow.visible) return overflow;
  if (input.bridge !== undefined && input.bridge !== null) {
    return describePanelBridgeGap(input.bridge);
  }
  return HIDDEN;
}
