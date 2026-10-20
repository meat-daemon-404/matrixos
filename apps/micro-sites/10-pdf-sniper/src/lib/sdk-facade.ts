/**
 * ⚠️ 自动生成 · scripts/gen-site.mjs
 * 站点：10 PDF 公式与参量狙击镜
 * 轨道：轨道 5 · 工坊 · 域名：pdf-sniper.matrixos.edu
 * 命名依据：docs/01-plan/00-adr-001-microsite-numbering.md（目录名与域名可不一致，刻意）
 * 重新生成：pnpm gen:site --id=10 --force
 */
import * as MatrixSDK from "@matrixos/sdk";

/**
 * SDK 适配层（本站**唯一**允许 import `@matrixos/sdk` 的地方）
 * ==========================================================================
 * 为什么要有这一层：
 *  1. SDK 与本站并行开发 —— 这里做**可选解析**，包没就位或缺符号时 UI 显式说
 *     「未就位」，绝不伪造登录态，也不假装虫洞投递成功。
 *  2. 未来 SDK 改签名，只改这一个文件。
 *
 * 与 SDK owner 对齐的接口（2026-10-20 定稿）：
 *   initSSO(options): Promise<SSOSession>     —— 异步；双通道（Cookie / mx_idt 交换）
 *   onWormholeDrop(handler): () => void       —— 返回取消订阅函数
 *   emitAsset(asset): Promise<AssetNode>      —— → POST /v1/assets
 *   useHostBridge(): HostBridge               —— 框架无关（不是 React hook）
 *   sendWormhole(...) / getManifest() / createMatrixSDK(...)
 *   注意：SDK **不含** WormholeDropRing —— 环体视觉归 instrument-ui。
 */
type AnyFn = (...args: unknown[]) => unknown;

const rawSdk = MatrixSDK as unknown as Record<string, unknown>;

/** shim 模块会导出这个标记；真实 SDK 不会。 */
export const sdkIsShim = rawSdk.__matrixosShim === true;

function pick(name: string): AnyFn | null {
  const candidate = rawSdk[name];
  return typeof candidate === 'function' ? (candidate as AnyFn) : null;
}

const TRACKED_SYMBOLS = [
  'initSSO',
  'onWormholeDrop',
  'emitAsset',
  'useHostBridge',
  'sendWormhole',
  'getManifest',
] as const;

export interface SdkStatus {
  readonly available: boolean;
  readonly shim: boolean;
  readonly symbols: readonly string[];
}

export function sdkStatus(): SdkStatus {
  const symbols = TRACKED_SYMBOLS.filter((n) => pick(n) !== null);
  return {
    available: !sdkIsShim && symbols.length > 0,
    shim: sdkIsShim,
    symbols,
  };
}

export type SessionPhase = 'booting' | 'ready' | 'offline';

export interface SessionState {
  readonly phase: SessionPhase;
  readonly uid?: string;
  readonly detail: string;
}

export interface InitSSOOptions {
  /** 站点编号，如 '07' */
  readonly stationId: string;
  /** 微站对外标识（域名前缀），作为 /v1/auth/introspect 的 audience */
  readonly audience: string;
  /** 是否运行在 orbital-hub 的 iframe 内 —— 决定走 Cookie 还是 mx_idt 交换（架构 §4.4） */
  readonly embedded: boolean;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 初始化 SSO。SDK 的 initSSO 是**异步**的，这里返回一个带 `dispose` 的句柄。
 *
 * 注意：调用方拿到的永远是同步句柄，但 ready/offline 状态经 onStateChange 异步回填 ——
 * 这样 React 组件不会因为 "忘记 await" 而卡在 booting。
 */
export interface SsoHandle {
  dispose(): void;
}

export function initSSO(
  options: InitSSOOptions,
  onStateChange: (state: SessionState) => void,
): SsoHandle {
  const fn = pick('initSSO');
  if (!fn) {
    onStateChange({
      phase: 'offline',
      detail: 'MatrixID 未接入：SDK 未就位（骨架态，不伪造登录）',
    });
    return { dispose: () => {} };
  }

  let cancelled = false;
  let disposeFromSdk: (() => void) | undefined;

  const promise = (async () => {
    const result = await (fn({
      stationId: options.stationId,
      audience: options.audience,
      embedded: options.embedded,
    }) as Promise<unknown>);
    if (cancelled) return;

    const session = (result ?? {}) as Record<string, unknown>;
    // SDK 未定时可能返回 { matrix_uid } / { uid } / { session: {...} }
    const uid = String(session.matrix_uid ?? session.uid ?? '') || undefined;
    onStateChange({
      phase: 'ready',
      ...(uid ? { uid } : {}),
      detail:
        (options.embedded ? 'iframe 通道' : 'Cookie 通道') +
        ' · MatrixID 已就绪' +
        (uid ? ' · ' + uid : ''),
    });

    const maybeDispose = (session.dispose ?? session.close) as unknown;
    if (typeof maybeDispose === 'function') disposeFromSdk = maybeDispose as () => void;
  })();

  promise.catch((err: unknown) => {
    if (cancelled) return;
    onStateChange({ phase: 'offline', detail: 'MatrixID 初始化失败：' + describe(err) });
  });

  return {
    dispose: () => {
      cancelled = true;
      disposeFromSdk?.();
    },
  };
}

export interface WormholeReceipt {
  readonly traceId: string;
  readonly payloadType: string;
  readonly evidenceCount: number;
  readonly receivedAt: string;
  readonly sourceApp: string;
  /** 真投递时由 hub 下发的一次性凭证（120s）；shim/骨架态为 undefined */
  readonly receiptId?: string;
}

/**
 * 注册虫洞接收器。契约见 specs/contracts/wormhole-envelope.schema.json：
 * payload.evidence_anchors 至少 1 条，且每条必须带 source_doi_or_url + verification_level。
 */
export function onWormholeDrop(
  handler: (receipt: WormholeReceipt) => void,
): (() => void) | undefined {
  const fn = pick('onWormholeDrop');
  if (!fn) return undefined;

  const wrapped = (envelope: unknown) => {
    handler(toReceipt(envelope));
  };

  try {
    const result = fn(wrapped);
    return typeof result === 'function' ? (result as () => void) : () => {};
  } catch {
    return undefined;
  }
}

/** 把任意 envelope 归一成展示用收据；字段缺失也不抛错（骨架期要能容错）。 */
export function toReceipt(envelope: unknown): WormholeReceipt {
  const env = (envelope ?? {}) as Record<string, unknown>;
  const payload = (env.payload ?? {}) as Record<string, unknown>;
  const anchors = Array.isArray(payload.evidence_anchors) ? payload.evidence_anchors : [];
  const receiptId = env.receipt_id;
  return {
    traceId: String(env.trace_id ?? 'unknown'),
    payloadType: String(env.payload_type ?? 'unknown'),
    evidenceCount: anchors.length,
    receivedAt: new Date().toISOString(),
    sourceApp: String(env.source_app ?? 'unknown'),
    ...(typeof receiptId === 'string' ? { receiptId } : {}),
  };
}
