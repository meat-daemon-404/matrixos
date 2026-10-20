/**
 * MatrixOS SDK · 全域公共类型
 *
 * 本文件是 SDK 的类型根。**契约类型不在本文件重复定义**：
 * manifest / wormhole envelope / asset node 的类型全部来自
 * `./contracts/types.ts`（冻结契约的结构化镜像），再由本文件补充 SDK 专属类型。
 *
 * ## 与 @matrixos/twin-schema 的关系
 *
 * twin-schema 是契约的「zod 校验器 + 类型」实现，运行时依赖 zod。
 * SDK 是协议编排层，被 18 个微站直接 import，必须保持**零运行时依赖**，
 * 所以不在构建期依赖 twin-schema，而是维护结构等价的镜像类型：
 *
 *   - 结构等价 ⇒ 消费方把 twin-schema 的 `WormholeEnvelope` 传给 `sendWormhole()`
 *     类型直接兼容，无需断言；
 *   - 契约漂移 ⇒ `test/contracts.conformance.test.ts` 直读
 *     `specs/contracts/*.schema.json` 与镜像逐字比对，改了契约没同步就红。
 *
 * 命名与 twin-schema 保持一致（已与其作者确认）：`WormholeEnvelope` /
 * `MatrixAppManifest` / `AssetNode` / `OrbitStation` / `PayloadType` 等。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. 契约类型（镜像自 specs/contracts/，见 ./contracts/types.ts 的说明）
// ─────────────────────────────────────────────────────────────────────────────

export type {
  MatrixAppManifest,
  MatrixAppManifestInput,
  OrbitStation,
  ManifestPayloadType,
  ManifestPermission,
  LiveMiniView,
  ManifestAuthor,
  WormholeEnvelope,
  WormholeEnvelopeInput,
  WormholePayload,
  WormholePayloadType,
  EvidenceAnchor,
  VerificationLevel,
  AssetNode,
  AssetNodeInput,
  AssetType,
} from './contracts/types.ts';

export {
  ORBIT_STATIONS,
  MANIFEST_PAYLOAD_TYPES,
  MANIFEST_PERMISSIONS,
  VERIFICATION_LEVELS,
} from './contracts/types.ts';

import type {
  MatrixAppManifest,
  ManifestPayloadType,
  WormholeEnvelope,
  WormholePayloadType,
  AssetNode,
  ManifestAuthor,
  ManifestPermission,
} from './contracts/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 2. 站标识
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 微站标识。两种写法 SDK 都接受，内部统一归一化为裸 key：
 *  - `'curvelab'`              裸 key（等于 manifest.app_id / 子域名前缀）
 *  - `'curvelab.matrixos.edu'` 完整主机名（WormholeEnvelope 的 source_app / target_app 用这种）
 *
 * 归一化规则见 `normalizeAppKey()`，是虫洞路由能被正确匹配的前提。
 */
export type AppKey = string;

// ─────────────────────────────────────────────────────────────────────────────
// 3. 环境探测
// ─────────────────────────────────────────────────────────────────────────────

/** 运行上下文。决定走哪条鉴权通道——见 README「双通道鉴权」。 */
export type RuntimeContext =
  /** 顶层文档、同源 iframe、或本地开发（localhost）。走域级 Cookie。 */
  | 'standalone'
  /** 跨源 iframe 内（被 orbital-hub 或第三方宿主内嵌）。走 `mx_idt` 交换。 */
  | 'embedded'
  /** 无 DOM（SSR / Node 脚本 / 单元测试）。SDK 只允许调用不依赖浏览器的接口。 */
  | 'headless';

// ─────────────────────────────────────────────────────────────────────────────
// 4. 鉴权
// ─────────────────────────────────────────────────────────────────────────────

/** 与 `matrix-core` 返回的 `/v1/auth/userinfo` 结构对齐。 */
export interface MatrixUser {
  readonly matrix_uid: string;
  readonly display_name?: string;
  readonly entitlements?: readonly string[];
  /** JWT 内携带的 scope 列表，形如 `station:curvelab:write`。 */
  readonly scope?: readonly string[];
}

/**
 * `mx_idt`（interaction token）交换的回执。
 * 服务端契约见 S1-09：120s 过期、一次性、并发交换只允许一个成功。
 */
export interface SSOTokenSet {
  /** RS256 JWT，15 min。iframe 路径下只存内存 + sessionStorage。 */
  readonly mx_at: string;
  readonly expires_at: number;
  readonly matrix_uid: string;
  readonly scope: readonly string[];
  readonly station_id: string;
}

/** 当前会话状态。`degraded` 是**必须显式可见**的状态，不允许静默降级（ADR-09）。 */
export type SSOSessionState =
  | 'authenticated'
  | 'authenticating'
  /** 走了 Cookie 但只拿到 `matrix_uid`，拿不到可用的 `mx_at`（第三方 Cookie 被阻断）。 */
  | 'cookie-blocked'
  /** `matrix-core` / auth 端点不可用，但站点仍可只读运行。 */
  | 'degraded'
  | 'anonymous';

/** 降级时给用户的**可操作**提示——不是一句「登录失败」，而是告诉他下一步点哪里。 */
export interface SSODegradationHint {
  readonly code:
    | 'THIRD_PARTY_COOKIE_BLOCKED'
    | 'IFRAME_HANDSHAKE_TIMEOUT'
    | 'IDT_EXCHANGE_FAILED'
    | 'AUTH_SERVICE_UNAVAILABLE'
    | 'POPUP_BLOCKED'
    | 'LOOPBACK_NOT_ALLOWED';
  readonly message: string;
  /** 用户可执行的动作，按优先级排列。 */
  readonly actions: readonly string[];
  /** 可直接跳转的顶层 URL（top-level navigation 不受第三方 Cookie 限制）。 */
  readonly fallbackUrl?: string;
  readonly retryable: boolean;
}

export interface SSOSession {
  readonly state: SSOSessionState;
  readonly matrixUid: string | null;
  readonly scope: readonly string[];
  readonly user: MatrixUser | null;
  /** 本次会话实际走通的通道，用于排障（「在我机器上能登录、iframe 里不行」）。 */
  readonly channel: 'cookie' | 'idt' | 'none';
  readonly hint: SSODegradationHint | null;
  readonly expiresAt: number | null;
}

/** `initSSO()` 的入参。 */
export interface InitSSOOptions {
  /** 本站 app_id（manifest.app_id）。用于 scope 校验与虫洞 source_app。 */
  readonly appId: AppKey;
  /** 本站入口 URL。用于子站↔父窗口互相识别 event.source。 */
  readonly entryUrl?: string;
  /** 显式指定通道；省略时按 `detectRuntimeContext()` 自动判定。 */
  readonly channel?: 'auto' | 'cookie' | 'idt';
  /** `matrix-core` 地址，默认 `https://api.matrixos.edu`。 */
  readonly apiBaseUrl?: string;
  /**
   * 宿主 origin 白名单。默认 `['*.matrixos.edu']`。
   * **必须校验**：`postMessage` 不做 origin 校验等于把 `mx_idt` 送给任意网页。
   */
  readonly allowedOrigins?: readonly string[];
  /** 是否在 Cookie 通道不可用时自动回落到 `mx_idt` 交换。默认 `true`。 */
  readonly fallbackToIdt?: boolean;
  /**
   * 拿不到会话时是否自动做一次顶层跳转登录（`/v1/auth/authorize`）。
   * 默认 `false`——静默跳转会让用户丢失当前编辑态，必须由业务显式开启。
   */
  readonly autoRedirect?: boolean;
  /** 登录完成后的回跳地址，默认当前 URL。 */
  readonly redirectUri?: string;
  /** 等待宿主握手的超时（ms），默认 3000。 */
  readonly handshakeTimeoutMs?: number;
  /** 是否启用调试日志（只打状态，不打令牌）。默认 `false`。 */
  readonly debug?: boolean;
}

/** `initSSO()` 返回的会话句柄。 */
export interface SSOClient {
  readonly session: SSOSession;
  /** 主动刷新（refresh 轮转由 `matrix-core` 负责）。 */
  refresh(): Promise<SSOSession>;
  /** 订阅状态变化（含降级提示），返回取消订阅函数。 */
  onStateChange(listener: (session: SSOSession) => void): () => void;
  /** 生成带 scope 的授权跳转 URL（不自动跳转）。 */
  buildAuthorizeUrl(extra?: Record<string, string>): string;
  /** 登出：单站登出只清本地 scope 缓存，不动域级 Cookie（架构 §4.4.3）。 */
  logout(options?: { readonly allDevices?: boolean }): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. iframe 宿主桥
// ─────────────────────────────────────────────────────────────────────────────

/** SDK 内部 `postMessage` 协议的信封。带版本号，向后兼容（S2-07 验收项）。 */
export interface BridgeMessage<T = unknown> {
  /** 协议标识，固定 `matrixos/bridge`。 */
  readonly ch: 'matrixos/bridge';
  /** 协议版本。当前 `1`。 */
  readonly v: 1;
  readonly type: string;
  readonly payload?: T;
  /** 请求-响应配对。 */
  readonly rid?: string;
  readonly ts?: number;
}

/** 宿主 ↔ 子站握手能力协商结果。 */
export interface HostBridge {
  readonly role: 'host' | 'tenant';
  /** 是否已与对端完成握手。 */
  readonly connected: boolean;
  readonly protocolVersion: 1;
  /** 对端已声明的能力，用于版本协商（老宿主缺某个能力时子站要能降级）。 */
  readonly peerCapabilities: readonly string[];
  /** 让子站自适应紧凑布局（A4 要求官方微站必须支持 iframe 内降级模式）。 */
  readonly embedded: boolean;
  on(event: string, handler: (payload: unknown, meta: BridgeMeta) => void): () => void;
  /** 向对端发消息。未握手时入队，握手后补发。 */
  post(type: string, payload?: unknown): void;
  /** 请求-响应。 */
  request<T = unknown>(type: string, payload?: unknown, timeoutMs?: number): Promise<T>;
  /** 主动发起握手（宿主侧调用）。 */
  handshake(): Promise<void>;
  /** 关闭桥并清空队列与监听。 */
  close(): void;
}

export interface BridgeMeta {
  /** 已通过白名单校验的 origin。 */
  readonly origin: string;
  readonly source: 'host' | 'tenant' | 'unknown';
  readonly message: BridgeMessage;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 虫洞（跨站投送）
// ─────────────────────────────────────────────────────────────────────────────

/** 投送结果。失败时 `reason` 一定是可展示给人看的（含具体缺哪个字段）。 */
export interface WormholeReceipt {
  readonly ok: boolean;
  readonly traceId: string;
  readonly sourceApp: string;
  readonly targetApp: string;
  readonly payloadType: WormholePayloadType;
  /** 服务端收据 ID。**只回哈希与元数据，payload 正文不过服务端**（W2）。 */
  readonly receiptId?: string;
  /** 服务端下发的 `mx_idt`，供目标站在 iframe 内换 `mx_at`。 */
  readonly mxIdt?: string;
  readonly deliveredVia: 'postMessage:host' | 'window:opener' | 'window:open' | 'local';
  readonly reason?: string;
  readonly fieldErrors?: readonly string[];
}

export interface SendWormholeOptions {
  /** 调用方自带 trace_id；省略则生成 uuid v4。 */
  readonly traceId?: string;
  /** 跳过服务端收据（纯本地/离线场景）。默认 `false`。 */
  readonly skipReceipt?: boolean;
  /** 等待目标站 ack 的超时（ms），默认 2000。 */
  readonly ackTimeoutMs?: number;
}

/** `onWormholeDrop()` 的 handler 收到的上下文。 */
export interface WormholeDropContext {
  readonly envelope: WormholeEnvelope;
  /** 已校验的发送方 origin。 */
  readonly origin: string;
  readonly receiptId?: string;
  /** 目标站消费完调用它回执；不调用则 SDK 在超时后按「已投递未确认」处理。 */
  ack(result?: { readonly ok?: boolean; readonly message?: string }): void;
  /** 目标站拒绝消费（如数据格式不认识），会回传给源站展示。 */
  reject(reason: string): void;
}

export type WormholeDropHandler = (context: WormholeDropContext) => void | Promise<void>;

/** `onWormholeDrop()` 的入参。 */
export interface OnWormholeDropOptions {
  /** 本站在 manifest 里声明的 `accepts[]`。SDK 用它做白名单（W3：只投给声明过的目标）。 */
  readonly accepts: readonly ManifestPayloadType[];
  readonly onDrop: WormholeDropHandler;
  /**
   * 从 manifest 注册表读目标站声明。给了就会在**投送前**做 W3 校验，
   * 而不是等目标站收到才发现不认识。未提供时退化为「不做目标侧预检」。
   */
  readonly resolveManifest?: (targetApp: AppKey) => MatrixAppManifest | null | Promise<MatrixAppManifest | null>;
  readonly allowedOrigins?: readonly string[];
  /** 是否在收到后自动回 ack（业务没手动 ack 时的兜底）。默认 `true`。 */
  readonly autoAck?: boolean;
}

/** 无头虫洞环（视觉组件由 `instrument-ui` 提供，SDK 只出逻辑）。 */
export interface WormholeDropRing {
  /** 拖拽开始：给出草稿与合法目标清单，UI 拿去渲染环上节点。 */
  openRing(draft: WormholeEnvelopeDraft): Promise<WormholeRingState>;
  /** 拖拽过程中的实时反馈（环体变红 / 变绿）。 */
  validate(draft: WormholeEnvelopeDraft): WormholeValidationResult;
  /** 松手投送。 */
  drop(targetApp: AppKey, draft: WormholeEnvelopeDraft): Promise<WormholeReceipt>;
  close(): void;
}

export interface WormholeRingState {
  readonly draft: WormholeEnvelopeDraft;
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly targets: readonly WormholeTarget[];
}

export interface WormholeTarget {
  readonly appKey: string;
  readonly host: string;
  readonly name?: string;
  readonly accentColor?: string;
  readonly icon?: string;
  /** 该目标是否接受本 payload_type（W3）。 */
  readonly accepts: boolean;
}

/**
 * 投送草稿：契约要求 `trace_id` / `matrix_uid` 等由 SDK 补齐，
 * 业务只需要说清「投什么、给谁、证据在哪」。
 */
export interface WormholeEnvelopeDraft {
  readonly targetApp: AppKey;
  readonly payloadType: WormholePayloadType;
  readonly data: Record<string, unknown>;
  /** 合规红线：至少 1 条，缺了直接拒绝投送（W1）。 */
  readonly evidenceAnchors: WormholeEnvelope['payload']['evidence_anchors'];
  readonly traceId?: string;
  readonly matrixUid?: string;
}

export interface WormholeValidationResult {
  readonly valid: boolean;
  /** 面向人的错误描述；UI 直接显示在环体上。 */
  readonly errors: readonly string[];
  /** 机器可读的字段路径，便于埋点与测试断言。 */
  readonly fieldErrors: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 资产图谱（/v1/assets）
// ─────────────────────────────────────────────────────────────────────────────

/** `emitAsset()` 的入参。`asset_id` / `version` / 时间戳由服务端生成。 */
export interface EmitAssetInput {
  readonly assetType: AssetNode['asset_type'];
  readonly title?: string;
  readonly payload: Record<string, unknown>;
  readonly evidenceAnchors: AssetNode['evidence_anchors'];
  readonly verificationLevel?: AssetNode['verification_level'];
  /** 溯源到某次虫洞投送。 */
  readonly traceId?: string;
  /** 端侧隐私仓指针——**只存指针，正文永不出设备**（架构 §6.4）。 */
  readonly localRef?: { readonly device_id: string; readonly local_key: string };
  /** 幂等键：同 key 重复提交由服务端返回同一节点，网络重试安全。 */
  readonly idempotencyKey?: string;
}

export interface AssetListQuery {
  readonly stationId?: string;
  readonly assetType?: AssetNode['asset_type'];
  readonly verificationLevel?: AssetNode['verification_level'];
  readonly traceId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: 'asc' | 'desc';
}

export interface AssetSearchQuery {
  /** 自然语言 / 关键词查询，服务端走 pgvector + tsvector。 */
  readonly query: string;
  readonly topK?: number;
  readonly stationId?: string;
  readonly assetType?: AssetNode['asset_type'];
  readonly minScore?: number;
}

export interface AssetSearchHit {
  readonly asset: AssetNode;
  readonly score: number;
  readonly snippet?: string;
}

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly total?: number;
}

/** 资产图谱客户端。微站**不得**绕过它直连数据库（架构 §6.3）。 */
export interface AssetClient {
  emit(asset: EmitAssetInput): Promise<AssetNode>;
  get(assetId: string, options?: { readonly version?: number }): Promise<AssetNode>;
  list(query?: AssetListQuery): Promise<Paginated<AssetNode>>;
  search(query: AssetSearchQuery): Promise<readonly AssetSearchHit[]>;
  update(assetId: string, patch: Partial<EmitAssetInput>): Promise<AssetNode>;
  remove(assetId: string): Promise<void>;
  /** 图遍历：`asset_edge` 的多跳溯源。 */
  traverse(assetId: string, options?: { readonly depth?: number; readonly relation?: string }): Promise<readonly AssetNode[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.5 运行环境抽象
//
// SDK 必须能在三种宿主里跑：顶层浏览器、跨源 iframe、Node/SSR（构建期与测试）。
// 把所有 `window` / `document` / `fetch` 访问收敛到这一个接口，好处有二：
//   1. 测试不需要 jsdom —— 直接注入一个假的 `RuntimeEnv` 就能跑完整链路；
//   2. 22 个可能被 iframe 内嵌的站不会各自写「isInIframe」判断（这里写一次）。
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MessageEventLike {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export type MessageListener = (event: MessageEventLike) => void;

/** 窗口的最小结构面。只声明 SDK 实际用到的成员，便于在测试里伪造。 */
export interface WindowLike {
  readonly location: {
    readonly href: string;
    readonly origin: string;
    readonly host: string;
    readonly hostname: string;
    readonly protocol: string;
    readonly search: string;
  };
  readonly parent: WindowLike | null;
  readonly top: WindowLike | null;
  readonly opener: WindowLike | null;
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
  readonly sessionStorage: StorageLike | null;
  readonly localStorage: StorageLike | null;
  readonly navigator: { readonly cookieEnabled?: boolean; readonly userAgent?: string } | null;
  setTimeout(handler: () => void, timeout?: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DocumentLike {
  /** `document.cookie` 原文，SDK 用它读非 HttpOnly 的 CSRF 令牌。 */
  readonly cookie: string;
}

export interface RuntimeEnv {
  readonly hasDOM: boolean;
  readonly win: WindowLike | null;
  readonly doc: DocumentLike | null;
  /** 是否被父窗口内嵌。跨源时无法读 `top.location`，故用引用比较。 */
  readonly inIframe: boolean;
  readonly origin: string;
  readonly href: string;
  readonly fetchImpl: FetchLike | null;
  now(): number;
  randomUUID(): string;
}

/** 可注入的时钟与随机源，让「120s 过期」「trace_id 唯一」这类逻辑可被确定性测试。 */
export interface ClockSource {
  now(): number;
  randomUUID(): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.6 兼容别名
//
// `@matrixos/twin-schema` 使用 `PayloadType` / `ORBIT_STATION` / `PAYLOAD_TYPE` /
// `PERMISSION` 等命名。SDK 内部用带前缀的名字（避免与 `manifest` 里的同义字段混淆），
// 但对外同时导出 twin-schema 的惯用名，方便 18 个微站混用两种写法而不必记两套。
// ─────────────────────────────────────────────────────────────────────────────

export type PayloadType = ManifestPayloadType;
export type Permission = ManifestPermission;
export type MatrixAppAuthor = ManifestAuthor;

// ─────────────────────────────────────────────────────────────────────────────
// 8. HTTP 客户端
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  readonly retries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
  /** 哪些状态码值得重试。默认 408/425/429/500/502/503/504。 */
  readonly retryOn?: readonly number[];
  /** 幂等方法才自动重试（GET/HEAD/PUT/DELETE）；POST 要靠 `idempotencyKey`。 */
  readonly retryNonIdempotent?: boolean;
}

/** SDK 内置熔断器（ADR-09 强制项：18 站不得各自实现 18 种行为）。 */
export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly openMs: number;
  readonly halfOpenProbes: number;
}

export interface HttpClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly circuitBreaker?: Partial<CircuitBreakerConfig>;
  /** 取当前 `mx_at`。iframe 路径下来自内存，Cookie 路径下由浏览器自动带。 */
  readonly getAccessToken?: () => string | null;
  /** CSRF 双提交令牌的读取实现；默认读 `mx_csrf` cookie。 */
  readonly getCsrfToken?: () => string | null;
  /** 401 时的刷新钩子；返回 `false` 表示无法恢复，SDK 抛 `AuthExpiredError`。 */
  readonly onUnauthorized?: () => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
  readonly debug?: boolean;
}

export interface MatrixRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  readonly path: string;
  readonly query?: Record<string, string | number | boolean | undefined | null>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** 关闭自动 CSRF 注入（仅用于 `/v1/auth/*` 这类无副作用端点）。 */
  readonly skipCsrf?: boolean;
  readonly idempotencyKey?: string;
  readonly traceId?: string;
  /** 本次请求跳过重试（如交换 `mx_idt` 这类绝对一次性操作）。 */
  readonly noRetry?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. 错误
// ─────────────────────────────────────────────────────────────────────────────

export type MatrixErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'CIRCUIT_OPEN'
  | 'HTTP'
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVER'
  | 'VALIDATION'
  | 'CONTRACT_VERSION'
  | 'ORIGIN_REJECTED'
  | 'IDT_ALREADY_CONSUMED'
  | 'IDT_EXPIRED'
  | 'UNSUPPORTED_PAYLOAD'
  | 'NOT_IMPLEMENTED'
  | 'ENVIRONMENT'
  | 'MANIFEST_INVALID';

/** 服务端统一错误体（S1-06）：`{code, message, trace_id}`。 */
export interface MatrixErrorBody {
  readonly code: string;
  readonly message: string;
  readonly trace_id?: string;
  readonly details?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. SDK 实例
// ─────────────────────────────────────────────────────────────────────────────

export interface MatrixSDKOptions extends InitSSOOptions {
  /** 本站 manifest。省略时由 `loadManifest()` 从 `/matrix-app.manifest.json` 拉。 */
  readonly manifest?: MatrixAppManifest;
  readonly http?: HttpClientOptions;
}

/** SDK 根实例。微站 import 后只碰这一个对象。 */
export interface MatrixSDK {
  readonly appId: string;
  readonly runtime: RuntimeContext;
  readonly sso: SSOClient;
  readonly assets: AssetClient;
  readonly http: {
    request<T = unknown>(options: MatrixRequestOptions): Promise<T>;
  };
  /** 本站 manifest（插槽清单）。 */
  getManifest(): MatrixAppManifest;
  /** 跨源消息白名单，供 host bridge 与虫洞共用。 */
  readonly allowedOrigins: readonly string[];

  initSSO(): Promise<SSOSession>;

  emitAsset(asset: EmitAssetInput): Promise<AssetNode>;

  onWormholeDrop(options: OnWormholeDropOptions): () => void;

  sendWormhole(
    targetApp: AppKey,
    payloadType: WormholePayloadType,
    payload: WormholeEnvelopeDraft | { readonly data: Record<string, unknown>; readonly evidenceAnchors: WormholeEnvelope['payload']['evidence_anchors'] },
    options?: SendWormholeOptions,
  ): Promise<WormholeReceipt>;

  createWormholeDropRing(): WormholeDropRing;

  useHostBridge(): HostBridge;

  validateManifest(json: unknown): ManifestValidationResult;

  dispose(): void;
}

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly manifest: MatrixAppManifest | null;
  readonly errors: readonly ManifestIssue[];
}

export interface ManifestIssue {
  /** JSON Pointer 风格路径，如 `/accepts/0`。 */
  readonly path: string;
  readonly message: string;
  readonly keyword: string;
  /** 跨字段规则（如 emits 里声明了但 accepts 里没有）也走这里，方便 UI 分栏展示。 */
  readonly severity?: 'error' | 'warning';
}

/** 校验器句柄：不给 schema 时用 SDK 内置的 manifest 结构校验。 */
export interface ManifestValidator {
  (json: unknown): ManifestValidationResult;
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}