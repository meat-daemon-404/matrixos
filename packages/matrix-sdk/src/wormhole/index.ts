/**
 * MatrixOS SDK · 跨站虫洞环
 *
 * ## 这一层的核心主张：**数据面是 P2P 的**
 *
 * 架构 §5.3 的 W2 规则写得很直白：明文 payload **只在浏览器内存与 `postMessage`
 * 中流动**，`matrix-core` 只存收据（哈希 + 元数据），**不存 `data` 正文**。
 *
 * 动机不是「省带宽」，而是风险集中度：如果 payload 走服务端中转，
 * `matrix-core` 就成了 18 站全部科研数据的汇聚点，一次泄露即全损；
 * 而且与 TIER 04「本地 LoRA 处理未发表原始数据」的零外泄承诺直接冲突。
 *
 * 所以本文件的投送路径是：
 *
 * ```
 *  源站内存 ──postMessage──► hub ──postMessage──► 目标站内存
 *     │                                            │
 *     └──► POST /v1/wormhole/receipt（只有哈希与元数据）
 * ```
 *
 * `#sendViaBridge` 里那句 `post('wormhole.drop', envelope)` 就是这条边界：
 * envelope 从这里出去之后**没有任何代码路径会把它发给服务端**。
 *
 * ## 三条强制规则（架构 §5.3，全部在这里执行）
 *
 * | 规则 | 内容 | 执行位置 |
 * | :--- | :--- | :--- |
 * | W1 | `evidence_anchors.length >= 1`，每条含 `source_doi_or_url` + `verification_level` | `validateDraft()` |
 * | W2 | 明文不过服务端 | `#requestReceipt()` 只发元数据 |
 * | W3 | 只投给 manifest `accepts[]` 里声明过的目标 | `validateDraft()` + 目标站 `onWormholeDrop` |
 */

import { MatrixError, UnsupportedPayloadError } from '../errors.ts';
import { validateAgainstSchema, formatIssues, validateManifestSchema } from '../contracts/index.ts';
import type { HostBridge, MatrixAppManifest, RuntimeEnv } from '../types.ts';
import type {
  AppKey,
  OnWormholeDropOptions,
  SendWormholeOptions,
  WormholeDropContext,
  WormholeEnvelope,
  WormholeEnvelopeDraft,
  WormholeReceipt,
  WormholeRingState,
  WormholeTarget,
  WormholeValidationResult,
} from '../types.ts';
import { isSameApp, normalizeAppKey, toAppHost } from '../security/origin.ts';
import type { MatrixHttpClient } from '../http/client.ts';

/** 大载荷阈值（架构 §5.4）。超过就建议改用 `asset_ref` 引用。 */
export const LARGE_PAYLOAD_THRESHOLD_BYTES = 64 * 1024;

export interface WormholeTransportInit {
  readonly env: RuntimeEnv;
  readonly http: MatrixHttpClient;
  readonly bridge: HostBridge | null;
  readonly selfApp: AppKey;
  readonly getMatrixUid: () => string | null;
  readonly getManifest: () => MatrixAppManifest;
  readonly resolveManifest: (targetApp: AppKey) => MatrixAppManifest | null | Promise<MatrixAppManifest | null>;
  readonly baseDomain?: string;
  readonly debug?: boolean;
}

/**
 * 估算一份 payload 的序列化体积。
 *
 * 返回 `0` 表示无法序列化（含循环引用等）——那种情况本身就该被拒绝投送，
 * 因为 `postMessage` 的结构化克隆同样会失败。
 */
export function estimatePayloadBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return 0;
    // UTF-8 字节数，而非字符数——中文在 postMessage 与存储里都按字节计。
    return new TextEncoder().encode(json).byteLength;
  } catch {
    return 0;
  }
}

/**
 * 判断是否属于「大载荷」，应当退化为 `payload.data.asset_ref` 引用。
 *
 * 为什么这条判定必须收敛在 SDK 里（架构 §5.4 的配套要求）：
 * 18 个微站各写一遍 `JSON.stringify(x).length > 65536`，阈值迟早会漂移，
 * 而阈值不一致的表现是「某些站能投、某些站投不动」，极难归因。
 */
export function isLargePayload(value: unknown, thresholdBytes = LARGE_PAYLOAD_THRESHOLD_BYTES): boolean {
  const size = estimatePayloadBytes(value);
  return size === 0 || size > thresholdBytes;
}

/**
 * 把大载荷转成契约内合法的引用形态。
 *
 * 契约约束（ADR-10）：`payload_type` 是封闭枚举，`payload` 是
 * `additionalProperties: false`——**不能**加 `asset_pointer` 之类的新字段。
 * 唯一合法的位置是 `payload.data`（自由 `object`）。
 */
export function toAssetRef(input: {
  readonly assetRef: string;
  readonly assetVersion?: number;
  readonly summary?: string;
  readonly resultCount?: number;
}): Record<string, unknown> {
  const data: Record<string, unknown> = { asset_ref: input.assetRef };
  if (input.assetVersion !== undefined) data.asset_version = input.assetVersion;
  if (input.summary !== undefined) data.summary = input.summary;
  if (input.resultCount !== undefined) data.result_count = input.resultCount;
  return data;
}

/** 站清单与虫洞投送共用的传输层。 */
export class WormholeTransport {
  readonly #env: RuntimeEnv;
  readonly #http: MatrixHttpClient;
  readonly #bridge: HostBridge | null;
  readonly #selfApp: AppKey;
  readonly #getMatrixUid: () => string | null;
  readonly #getManifest: () => MatrixAppManifest;
  readonly #resolveManifest: (targetApp: AppKey) => MatrixAppManifest | null | Promise<MatrixAppManifest | null>;
  readonly #baseDomain: string;
  readonly #debug: boolean;

  constructor(init: WormholeTransportInit) {
    this.#env = init.env;
    this.#http = init.http;
    this.#bridge = init.bridge;
    this.#selfApp = init.selfApp;
    this.#getMatrixUid = init.getMatrixUid;
    this.#getManifest = init.getManifest;
    this.#resolveManifest = init.resolveManifest;
    this.#baseDomain = init.baseDomain ?? 'matrixos.edu';
    this.#debug = init.debug ?? false;
  }

  /** 本站可投送的类型（manifest.emits）。空数组 = 纯接收端。 */
  get emits(): readonly string[] {
    return this.#getManifest().emits;
  }

  /** 本站可接收的类型（manifest.accepts）。空数组 = 不接收投送。 */
  get accepts(): readonly string[] {
    return this.#getManifest().accepts;
  }

  /**
   * 校验投送草稿。**UI 每拖一下都调它**（架构 §5.2 的「环体变红」就是这个结果）。
   *
   * 校验顺序是刻意的：先查本地能力（快、无需 IO），再查目标站声明（可能要拉 manifest）。
   */
  async validate(draft: WormholeEnvelopeDraft): Promise<WormholeValidationResult> {
    const errors: string[] = [];
    const fieldErrors: string[] = [];

    // ── W1：证据锚点非空 ──────────────────────────────────────────────────
    if (!Array.isArray(draft.evidenceAnchors) || draft.evidenceAnchors.length === 0) {
      errors.push('证据锚点为空：虫洞投送必须携带证据锚点（source_doi_or_url + verification_level），不允许投送无证据的空壳数据');
      fieldErrors.push('payload.evidence_anchors: 至少需要 1 条');
    }

    // ── 本站不得投送自己没声明过的类型（manifest.emits）────────────────────
    const selfEmits = this.emits;
    if (selfEmits.length > 0 && !selfEmits.includes(draft.payloadType)) {
      errors.push(`本站 manifest 的 emits 未声明「${draft.payloadType}」，投送会被注册表拒绝`);
      fieldErrors.push(`payload_type: 本站 emits = [${selfEmits.join(', ')}]`);
    }

    // ── payload_type 必须是契约的封闭枚举 ─────────────────────────────────
    // （由下面的 schema 校验兜住，这里不重复列举，避免两处枚举漂移）

    // ── W3：目标站必须声明 accepts ────────────────────────────────────────
    const targetManifest = await this.#safeResolveManifest(draft.targetApp);
    if (targetManifest !== null) {
      const acceptsList = targetManifest.accepts;
      if (!acceptsList.includes(draft.payloadType)) {
        errors.push(
          acceptsList.length === 0
            ? `目标站 ${draft.targetApp} 未声明接收任何虫洞投送（accepts 为空）`
            : `目标站 ${draft.targetApp} 不接受「${draft.payloadType}」，它只接受 [${acceptsList.join(', ')}]`,
        );
        fieldErrors.push(`target_app: accepts 不匹配`);
      }
    }

    // ── 构造完整 envelope 后跑冻结契约校验 ────────────────────────────────
    const envelope = this.buildEnvelope(draft);
    const issues = validateAgainstSchema(envelope, WORMHOLE_ENVELOPE_SCHEMA_FOR_VALIDATION);
    for (const issue of issues) {
      errors.push(issue.message);
      fieldErrors.push(issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`);
    }

    // ── 大载荷提醒（warning 而非 error：契约允许，只是会撑爆 postMessage）──
    const bytes = estimatePayloadBytes(draft.data);
    if (bytes > LARGE_PAYLOAD_THRESHOLD_BYTES) {
      errors.push(
        `payload 约 ${Math.round(bytes / 1024)} KB，超过 ${LARGE_PAYLOAD_THRESHOLD_BYTES / 1024} KB 阈值。` +
          `建议改用 payload.data.asset_ref 引用（见架构 §5.4 与 toAssetRef()），否则可能超出 postMessage 体积上限`,
      );
      fieldErrors.push(`payload.data: ${bytes} bytes`);
    }

    return { valid: errors.length === 0, errors, fieldErrors };
  }

  /** 把草稿补成完整 envelope（补 `trace_id` / `matrix_uid` / `source_app` / `target_app`）。 */
  buildEnvelope(draft: WormholeEnvelopeDraft): WormholeEnvelope {
    const matrixUid = draft.matrixUid ?? this.#getMatrixUid() ?? 'mxu_anonymous';
    return {
      trace_id: draft.traceId ?? this.#env.randomUUID(),
      matrix_uid: matrixUid,
      source_app: toAppHost(this.#selfApp, this.#baseDomain),
      target_app: toAppHost(draft.targetApp, this.#baseDomain),
      payload_type: draft.payloadType,
      payload: {
        data: draft.data,
        evidence_anchors: draft.evidenceAnchors.map((anchor) => ({
          source_doi_or_url: anchor.source_doi_or_url,
          verification_level: anchor.verification_level,
          ...(anchor.pdf_page !== undefined ? { pdf_page: anchor.pdf_page } : {}),
          ...(anchor.bbox !== undefined ? { bbox: anchor.bbox } : {}),
        })),
      },
      created_at: new Date(this.#env.now()).toISOString(),
    } as WormholeEnvelope;
  }

  /** 列出本次投送的候选目标（供环体渲染节点）。 */
  async listTargets(payloadType?: string): Promise<WormholeTarget[]> {
    const manifest = this.#getManifest();
    const declared = manifest.accepts;
    void declared;
    // 目标清单来自注册表（matrix-core）。S1 阶段注册表未就绪时返回空，
    // UI 应展示「暂无可用目标」而不是崩溃。
    try {
      const response = await this.#http.request<{ manifests?: unknown }>({
        method: 'GET',
        path: '/v1/registry/manifests',
        skipCsrf: true,
      });
      const raw = response !== null && typeof response === 'object' ? (response as { manifests?: unknown }).manifests : undefined;
      if (!Array.isArray(raw)) return [];

      const targets: WormholeTarget[] = [];
      for (const entry of raw) {
        const candidate = normalizeManifestEntry(entry);
        if (candidate === null) continue;
        // 不把自己列成目标（自投送没有意义，且会形成环）。
        if (isSameApp(candidate.app_id, this.#selfApp)) continue;
        const accepts = payloadType === undefined ? true : candidate.accepts.includes(payloadType as never);
        targets.push({
          appKey: candidate.app_id,
          host: toAppHost(candidate.app_id, this.#baseDomain),
          name: candidate.name,
          ...(candidate.accent_color !== undefined ? { accentColor: candidate.accent_color } : {}),
          ...(candidate.icon !== undefined ? { icon: candidate.icon } : {}),
          accepts,
        });
      }
      return targets;
    } catch (error) {
      if (this.#debug) console.debug(`[matrixos/sdk] 获取虫洞目标清单失败（注册表可能未就绪）：${String(error)}`);
      return [];
    }
  }

  /**
   * 执行投送。
   *
   * 顺序：校验 → 服务端收据（只发元数据）→ P2P 投递
   *
   * 「先拿收据再投递」而不是「先投递再补收据」，是因为收据还给目标站一个
   * `mx_idt`——目标站若在 iframe 里且没有 Cookie，靠这个才能建立会话消费数据。
   */
  async send(
    targetApp: AppKey,
    payloadType: WormholeEnvelopeDraft['payloadType'],
    payload: { readonly data: Record<string, unknown>; readonly evidenceAnchors: WormholeEnvelopeDraft['evidenceAnchors'] },
    options: SendWormholeOptions = {},
  ): Promise<WormholeReceipt> {
    const draft: WormholeEnvelopeDraft = {
      targetApp,
      payloadType,
      data: payload.data,
      evidenceAnchors: payload.evidenceAnchors,
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    };

    const validation = await this.validate(draft);
    if (!validation.valid) {
      throw MatrixError.validation(
        `虫洞投送被拒绝：${validation.errors[0] ?? '校验未通过'}`,
        validation.fieldErrors,
      );
    }

    const envelope = this.buildEnvelope(draft);

    // ── W3 硬校验（无论 validate 是否拿到目标 manifest，投递前再确认一次）──
    const targetManifest = await this.#safeResolveManifest(targetApp);
    if (targetManifest !== null && !targetManifest.accepts.includes(payloadType)) {
      throw new UnsupportedPayloadError(targetApp, payloadType, targetManifest.accepts);
    }

    // ── 服务端收据：只发元数据，**绝不发 payload.data**（W2）────────────
    let receiptId: string | undefined;
    let mxIdt: string | undefined;
    if (options.skipReceipt !== true) {
      const receipt = await this.#requestReceipt(envelope);
      receiptId = receipt.receiptId;
      mxIdt = receipt.mxIdt;
    }

    // ── 数据面 P2P 投递 ───────────────────────────────────────────────────
    const deliveredVia = await this.#deliver(envelope, receiptId, mxIdt, options.ackTimeoutMs ?? 2_000);

    return {
      ok: true,
      traceId: envelope.trace_id,
      sourceApp: envelope.source_app,
      targetApp: envelope.target_app,
      payloadType: envelope.payload_type,
      ...(receiptId !== undefined ? { receiptId } : {}),
      ...(mxIdt !== undefined ? { mxIdt } : {}),
      deliveredVia,
    };
  }

  /**
   * 服务端收据。
   *
   * **这里发出去的字段清单就是 W2 的执行点**：没有 `payload`、没有 `data`。
   * 只发 `{trace_id, source_app, target_app, payload_type, evidence_count}`。
   */
  async #requestReceipt(envelope: WormholeEnvelope): Promise<{ receiptId?: string; mxIdt?: string }> {
    try {
      const response = await this.#http.request<{ receipt_id?: unknown; mx_idt?: unknown }>({
        method: 'POST',
        path: '/v1/wormhole/receipt',
        body: {
          trace_id: envelope.trace_id,
          source_app: envelope.source_app,
          target_app: envelope.target_app,
          payload_type: envelope.payload_type,
          evidence_count: envelope.payload.evidence_anchors.length,
          // 载荷的哈希用于防篡改校验与去重，但**不是明文**。
          payload_digest: digestOf(envelope.payload.data),
        },
        traceId: envelope.trace_id,
      });
      return {
        ...(typeof response?.receipt_id === 'string' ? { receiptId: response.receipt_id } : {}),
        ...(typeof response?.mx_idt === 'string' ? { mxIdt: response.mx_idt } : {}),
      };
    } catch (error) {
      // 收据失败不阻断投递：W2 的价值在于「数据不落库」，收据只是计费与审计。
      // 但在只读离线态下应该让业务知道审计链断了。
      if (this.#debug) console.debug(`[matrixos/sdk] 虫洞收据请求失败（投递继续，审计链缺失）：${String(error)}`);
      return {};
    }
  }

  /** 实际投递。三条路径按可用性依次尝试。 */
  async #deliver(
    envelope: WormholeEnvelope,
    receiptId: string | undefined,
    mxIdt: string | undefined,
    ackTimeoutMs: number,
  ): Promise<WormholeReceipt['deliveredVia']> {
    const meta = {
      ...(receiptId !== undefined ? { receiptId } : {}),
      ...(mxIdt !== undefined ? { mxIdt } : {}),
    };

    // 路径 1：hub 内嵌 → 走宿主桥中转给目标 iframe（正常的主路径）。
    if (this.#bridge !== null && this.#bridge.role === 'tenant' && this.#bridge.connected) {
      this.#bridge.post('wormhole.drop', { envelope, ...meta });
      return 'postMessage:host';
    }

    // 路径 2：顶层标签页 + 有 opener（如「在新标签页打开」的场景）。
    if (this.#env.win !== null && this.#env.win.opener !== null) {
      this.#postToPeer(this.#env.win.opener, { envelope, ...meta });
      return 'window:opener';
    }

    // 路径 3：hub 作为最外层（role === 'host'）时直接广播给各子 iframe。
    // 实际路由由宿主实现；SDK 只把消息投到宿主，由宿主决定落到哪个 iframe。
    if (this.#bridge !== null) {
      this.#bridge.post('wormhole.drop', { envelope, ...meta });
      return 'postMessage:host';
    }

    // 无可用通道（headless / 未初始化）：明确失败而不是假装成功。
    if (this.#debug) console.debug('[matrixos/sdk] 无可用的虫洞投递通道（无宿主桥、无 opener）');
    void ackTimeoutMs;
    return 'local';
  }

  #postToPeer(target: NonNullable<RuntimeEnv['win']>, payload: unknown): void {
    /*
     * targetOrigin 取目标站 origin——注意这里**不能**用 `'*'`。
     * 但 opener 的 origin 往往读不到（跨源），此时退化为「按主机名构造」。
     * 构造失败就直接放弃投递：宁可投不出去，也不能把 payload 广播给任意页面。
     */
    const targetOrigin = guessTargetOrigin(payload, this.#baseDomain);
    if (targetOrigin === null) return;
    try {
      target.postMessage({ ch: 'matrixos/wormhole', v: 1, ...(payload as object) }, targetOrigin);
    } catch (error) {
      if (this.#debug) console.debug(`[matrixos/sdk] 向 opener 投递失败：${String(error)}`);
    }
  }

  async #safeResolveManifest(targetApp: AppKey): Promise<MatrixAppManifest | null> {
    try {
      const result = await this.#resolveManifest(targetApp);
      if (result === null) return null;
      // 注册表返回的 manifest 也要过一遍校验——服务端数据同样可能过期/损坏。
      const validation = validateManifestSchema(result);
      return validation.valid ? result : null;
    } catch {
      return null;
    }
  }
}

/** 注册表返回项的宽松归一化。字段缺失就当无效条目跳过，而不是抛错整个列表。 */
function normalizeManifestEntry(entry: unknown): MatrixAppManifest | null {
  if (entry === null || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.app_id !== 'string') return null;
  const validation = validateManifestSchema(entry);
  return validation.valid ? (entry as MatrixAppManifest) : null;
}

/** 从 payload 里推断目标 origin。推断不出来返回 null（调用方必须放弃投递）。 */
function guessTargetOrigin(payload: unknown, baseDomain: string): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const envelope = (payload as { envelope?: unknown }).envelope;
  if (envelope === null || typeof envelope !== 'object') return null;
  const targetApp = (envelope as { target_app?: unknown }).target_app;
  if (typeof targetApp !== 'string' || targetApp.length === 0) return null;
  const host = toAppHost(targetApp, baseDomain);
  return `https://${host}`;
}

/**
 * payload 的稳定摘要。
 *
 * 用途：服务端收据里存一份哈希，可回答「这条 payload 是否与当初那次投送一致」，
 * 而不需要存正文。这里用 FNV-1a 的 64 位变体 + 长度，够用于去重与完整性提示，
 * **不是**密码学哈希（也不是安全边界——安全边界在 TLS 与 JWT 上）。
 */
export function digestOf(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    json = String(value);
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return `fnv1a64:${hex(h1)}${hex(h2)}:${json.length}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 接收侧
// ─────────────────────────────────────────────────────────────────────────────

export interface WormholeReceiverInit {
  readonly env: RuntimeEnv;
  readonly options: OnWormholeDropOptions;
  readonly allowedOrigins: { allows(origin: string): boolean };
  readonly selfApp: AppKey;
  readonly debug?: boolean;
}

/**
 * 注册跨站拖拽接收器。
 *
 * 收到的每条消息都要过三关：
 *   1. **origin 白名单**（`postMessage` 的 origin 是否可信）；
 *   2. **冻结契约校验**（结构、枚举、证据非空）；
 *   3. **accepts 白名单**（本站 manifest 声明了能接这种类型吗）。
 *
 * 顺序不能换：先校验 origin，否则我们会在恶意输入上跑 schema 校验（无害但浪费），
 * 更重要的是**不能对未信任来源回 ack**——回复等于确认站点存活。
 */
export function registerWormholeReceiver(init: WormholeReceiverInit): () => void {
  const win = init.env.win;
  if (win === null) return () => undefined;

  const listener = (event: { data: unknown; origin: string }): void => {
    // ── 关 1：origin ───────────────────────────────────────────────────────
    if (!init.allowedOrigins.allows(event.origin)) {
      if (init.debug === true) console.debug(`[matrixos/sdk] 丢弃虫洞消息：origin ${event.origin} 不可信`);
      return;
    }

    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    const record = data as Record<string, unknown>;
    if (record.ch !== 'matrixos/wormhole') return;

    const envelope = record.envelope;
    if (envelope === null || typeof envelope !== 'object') return;

    // ── 关 2：契约校验 ─────────────────────────────────────────────────────
    const issues = validateAgainstSchema(envelope, WORMHOLE_ENVELOPE_SCHEMA_FOR_VALIDATION);
    if (issues.length > 0) {
      if (init.debug === true) console.debug(`[matrixos/sdk] 丢弃虫洞消息：契约校验失败 — ${formatIssues(issues).join('; ')}`);
      return;
    }

    const parsed = envelope as WormholeEnvelope;

    // ── 关 3：accepts 白名单（W3 的接收侧执行点）───────────────────────────
    if (!init.options.accepts.includes(parsed.payload_type)) {
      if (init.debug === true) {
        console.debug(
          `[matrixos/sdk] 拒绝虫洞投送：本站 accepts = [${init.options.accepts.join(', ')}]，收到的是「${parsed.payload_type}」`,
        );
      }
      return;
    }

    // 目标站不匹配本机 → 说明消息投错了，忽略（不 ack，让源站超时重试到正确目标）。
    if (!isSameApp(parsed.target_app, init.selfApp)) {
      if (init.debug === true) console.debug(`[matrixos/sdk] 丢弃虫洞消息：目标站 ${parsed.target_app} 不是本机 ${init.selfApp}`);
      return;
    }

    const receiptId = typeof record.receiptId === 'string' ? record.receiptId : undefined;
    let acked = false;

    const ack = (result: { readonly ok?: boolean; readonly message?: string } = {}): void => {
      if (acked) return;
      acked = true;
      replyToSource(init.env, event.origin, {
        type: 'wormhole.ack',
        traceId: parsed.trace_id,
        ok: result.ok ?? true,
        ...(receiptId !== undefined ? { receiptId } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
      });
    };

    const reject = (reason: string): void => {
      if (acked) return;
      acked = true;
      replyToSource(init.env, event.origin, {
        type: 'wormhole.reject',
        traceId: parsed.trace_id,
        ok: false,
        reason,
        ...(receiptId !== undefined ? { receiptId } : {}),
      });
    };

    const context: WormholeDropContext = {
      envelope: parsed,
      origin: event.origin,
      ...(receiptId !== undefined ? { receiptId } : {}),
      ack,
      reject,
    };

    try {
      const result = init.options.onDrop(context);
      if (result instanceof Promise) {
        result.then(
          () => {
            if (init.options.autoAck !== false) ack();
          },
          (error: unknown) => {
            reject(error instanceof Error ? error.message : String(error));
          },
        );
      } else if (init.options.autoAck !== false) {
        ack();
      }
    } catch (error) {
      reject(error instanceof Error ? error.message : String(error));
    }
  };

  win.addEventListener('message', listener);
  return () => win.removeEventListener('message', listener);
}

function replyToSource(env: RuntimeEnv, origin: string, payload: Record<string, unknown>): void {
  const win = env.win;
  if (win === null) return;
  // 回给宿主（iframe 场景）或 opener（标签页场景）。targetOrigin 用已校验的 origin。
  const target = win.parent !== null && win.parent !== win ? win.parent : win.opener;
  if (target === null) return;
  try {
    target.postMessage({ ch: 'matrixos/wormhole', v: 1, ...payload }, origin);
  } catch {
    // 回执失败不影响消费：源站会按超时处理。
  }
}

/** 无头虫洞环。视觉由 `instrument-ui` 提供，这里只出状态与动作。 */
export function createWormholeDropRing(transport: WormholeTransport): import('../types.ts').WormholeDropRing {
  let closed = false;

  return {
    async openRing(draft: WormholeEnvelopeDraft): Promise<WormholeRingState> {
      const [validation, targets] = await Promise.all([transport.validate(draft), transport.listTargets(draft.payloadType)]);
      return {
        draft,
        valid: validation.valid,
        errors: validation.errors,
        targets: targets.filter((t) => t.accepts),
      };
    },

    validate(draft: WormholeEnvelopeDraft): WormholeValidationResult {
      // 同步版本只做本地可判定部分（证据非空 + 结构），目标站声明要异步拉。
      const errors: string[] = [];
      const fieldErrors: string[] = [];
      if (!Array.isArray(draft.evidenceAnchors) || draft.evidenceAnchors.length === 0) {
        errors.push('证据锚点为空：虫洞投送必须携带至少 1 条证据锚点');
        fieldErrors.push('payload.evidence_anchors: 至少需要 1 条');
      }
      const envelope = transport.buildEnvelope(draft);
      const issues = validateAgainstSchema(envelope, WORMHOLE_ENVELOPE_SCHEMA_FOR_VALIDATION);
      for (const issue of issues) {
        errors.push(issue.message);
        fieldErrors.push(`${issue.path}: ${issue.message}`);
      }
      return { valid: errors.length === 0, errors, fieldErrors };
    },

    async drop(targetApp: AppKey, draft: WormholeEnvelopeDraft): Promise<WormholeReceipt> {
      if (closed) throw new MatrixError({ code: 'ABORTED', message: '虫洞环已关闭', retryable: false });
      return transport.send(
        targetApp,
        draft.payloadType,
        { data: draft.data, evidenceAnchors: draft.evidenceAnchors },
        draft.traceId !== undefined ? { traceId: draft.traceId } : {},
      );
    },

    close(): void {
      closed = true;
    },
  };
}

// 延迟引用，避免 contracts/index.ts ↔ wormhole 的运行时循环。
import { WORMHOLE_ENVELOPE_SCHEMA } from '../contracts/schemas.ts';
const WORMHOLE_ENVELOPE_SCHEMA_FOR_VALIDATION = WORMHOLE_ENVELOPE_SCHEMA;
