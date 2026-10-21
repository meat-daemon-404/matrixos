/**
 * 微站「完工台」(SiteWorkbench) 的类型契约。
 *
 * 为什么把类型单独放一个文件：
 *   18 个微站都要各自写一份 `src/lib/site-spec.ts`（业务数据模型），
 *   它们只依赖这里的接口，不依赖 Workbench 组件实现。
 *   这样业务侧改动不会碰到 UI 侧，UI 侧升级也不用改 18 份业务代码。
 *
 * 泛型 `T` 是该站台账的数据结构。所有回调都必须是**纯函数**：
 * 不改入参、不抛错、对同一入参给同一输出（Workbench 会包 try/catch，
 * 但纯函数是它能在浏览器里可靠工作的前提）。
 */

import type { Ledger, WormholeEvidenceAnchor, WormholePayloadType } from '../ledger.js';

/** 站点身份（与各站 `src/site.config.ts` 的 `SiteIdentity` 结构兼容）。 */
export interface SiteIdentityLike {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly appId: string;
  readonly orbitName: string;
  readonly accent: string;
  readonly uiStyle: string;
  readonly ledger: string;
  readonly source: string;
}

/** 台账里一条记录在 UI 上的展示形态。业务侧只需把数据映射成这几段文本。 */
export interface RecordView {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly detail?: string;
}

/** 虫洞信封里 `payload` 的最小形状（与 specs/contracts/wormhole-envelope.schema.json 对齐）。 */
export interface EnvelopePayloadLike {
  readonly data: Readonly<Record<string, unknown>>;
  readonly evidence_anchors: readonly WormholeEvidenceAnchor[];
}

/** 站内可消费的最小信封形状（消费逻辑不必依赖 `trace_id` 之外的元信息）。 */
export interface ConsumableEnvelope {
  readonly trace_id: string;
  readonly source_app?: string;
  readonly payload_type?: string;
  readonly payload: EnvelopePayloadLike;
}

/** 各站 `src/lib/sdk-facade.ts` 暴露的能力子集。Workbench 只调这些，不直接 import SDK。 */
export interface SdkBridge {
  /** SDK 是否真的就位（shim 不算） */
  readonly available: boolean;
  /**
   * 是否处于「有宿主可通信」的运行环境（hub iframe 内）。
   * **只有它为 true 时才允许真投送 / 真落库** —— 静态演示站点没有后端，
   * 贸然 fetch 会制造失败请求。这是诚实性 + 可验收性的共同要求。
   */
  readonly hostConnected: boolean;
  /** 真投送。`hostConnected` 为 false 时 Workbench 不会调用。 */
  readonly sendWormhole?: (
    targetApp: string,
    payloadType: WormholePayloadType,
    payload: EnvelopePayloadLike,
  ) => Promise<unknown>;
  /** 真落库 AssetGraph。语义同 `sendWormhole`。 */
  readonly emitAsset?: (asset: Readonly<Record<string, unknown>>) => Promise<unknown>;
  /** 订阅真实虫洞投送；返回取消订阅函数。 */
  readonly onWormholeDrop?: (
    handler: (envelope: ConsumableEnvelope) => void,
  ) => (() => void) | undefined;
}

/** 台账导出的表格形态。 */
export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
}

/**
 * 一个站的业务规格 —— **这是每个站唯一需要手写的业务代码**。
 */
export interface SiteWorkbenchSpec<T> {
  /** 导出文件名前缀，例如 `gpa-plans` → `gpa-plans.json` / `gpa-plans.csv` */
  readonly exportName: string;

  /** 首次打开时的演示数据（必须确定性、可复现，用于答辩演示）。 */
  readonly createDefault: () => T;

  /** 「清空」之后的空台账。必须满足 `records(createEmpty()).length === 0`。 */
  readonly createEmpty: () => T;

  /** 数据形状校验；返回 false 时台账回落默认值，不会覆盖用户已有数据。 */
  readonly validate?: (value: unknown) => value is T;

  /** 把台账数据映射成 UI 列表。 */
  readonly records: (data: T) => readonly RecordView[];

  /** 新增一条。必须让 `records()` 的长度 +1。 */
  readonly add: (data: T, nowIso: string) => T;

  /** 编辑指定记录。必须改变数据内容（Workbench 用指纹变化证明「改」真的生效）。 */
  readonly edit: (data: T, id: string, nowIso: string) => T;

  /** 删除指定记录。 */
  readonly remove: (data: T, id: string) => T;

  /** 可选：自定义 CSV。缺省按 records() 摊平成 id/title/meta/detail 四列。 */
  readonly csv?: (data: T) => CsvTable;

  /** 主动投送（emits）。证据锚点为空会被 Workbench 拦下并如实报错（契约红线）。 */
  readonly emit: {
    readonly targetApp: string;
    readonly payloadType: WormholePayloadType;
    readonly build: (data: T, nowIso: string) => EnvelopePayloadLike;
  };

  /** 接收消费（accepts）。`description` 会显示在面板上，说明消费后落到哪张表。 */
  readonly accept: {
    readonly payloadType: WormholePayloadType;
    readonly description: string;
    /** 把外部信封并入本地台账。返回新数据。 */
    readonly consume: (data: T, envelope: ConsumableEnvelope, nowIso: string) => T;
    /** 本地演示信封（无 hub 时用）。缺省由 Workbench 生成并标注「演示」。 */
    readonly demoEnvelope?: (nowIso: string) => ConsumableEnvelope;
  };

  /** 可选：写入 AssetGraph 的资产草稿。缺省用台账快照。 */
  readonly asset?: {
    readonly build: (data: T, nowIso: string) => Readonly<Record<string, unknown>>;
  };
}

/** 重新导出，方便各站只 import 一个入口。 */
export type { Ledger, WormholeEvidenceAnchor, WormholePayloadType };
