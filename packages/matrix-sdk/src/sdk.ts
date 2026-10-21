/**
 * MatrixOS SDK · 根装配
 *
 * 把各层拼成微站直接 `import` 的那一个对象。
 *
 * ## 为什么是工厂函数而不是模块级单例
 *
 * `createMatrixSDK()` 返回实例，模块顶层不创建任何实例，理由有三：
 *
 *   1. **`orbital-hub` 需要多实例** —— 它在自己的页面里为每个内嵌微站维护一个
 *      带独立 `appId`／独立 origin 白名单的子 SDK；
 *   2. **SSR 安全** —— 模块级单例会在 Node 服务端进程里被多个请求共享，
 *      带会话状态的对象跨请求共享是经典的串号 bug；
 *   3. **测试可重入** —— 每个用例建新实例，熔断器与 `mx_idt` 黑名单互不污染。
 *
 * 微站里重复 `createMatrixSDK()` 会重复建实例，所以另提供 `getMatrixSDK()`
 * 便捷入口（按 `appId` 幂等），微站默认用它即可。
 *
 * ## manifest 的生命周期
 *
 * manifest 可以显式传入，也可以省略由 SDK 从 `/matrix-app.manifest.json` 拉取。
 * 它是**异步就绪**的，但 `getManifest()` 是同步接口（UI 渲染不能等）。
 * 所以用 `ManifestHolder` 兜住：未就绪时返回一份结构化占位，拿到后自动替换。
 * 占位的 `accepts`/`emits` 都是空数组——也就是说**虫洞能力在 manifest 就绪前不可用**，
 * 这是刻意的失败方向：宁可暂时不能投送，也不能凭一份猜的清单乱投。
 */

import { MatrixError } from './errors.ts';
import { MatrixHttpClient } from './http/client.ts';
import { DEFAULT_API_BASE_URL } from './http/client.ts';
import { AssetClientImpl } from './assets/client.ts';
import { SSOClientImpl, issueIdtForTenant } from './auth/sso.ts';
import { IdtExchanger } from './auth/idt.ts';
import { createHostBridge, BRIDGE_CAPABILITIES } from './iframe/bridge.ts';
import { createAutoResizeReporter, type AutoResizeReporter } from './iframe/resize.ts';
import { OriginAllowList, DEFAULT_ALLOWED_ORIGINS, normalizeAppKey, toAppHost } from './security/origin.ts';
import { createRuntimeEnv, detectRuntimeContext, readCookie } from './runtime/env.ts';
import { registerWormholeReceiver, WormholeTransport, createWormholeDropRing } from './wormhole/index.ts';
import { validateManifest } from './manifest/validate.ts';
import type {
  AppKey,
  AssetClient,
  AssetNode,
  EmitAssetInput,
  HostBridge,
  HttpClientOptions,
  InitSSOOptions,
  ManifestValidationResult,
  MatrixAppManifest,
  MatrixSDK,
  MatrixSDKOptions,
  OnWormholeDropOptions,
  RuntimeContext,
  RuntimeEnv,
  SSOClient,
  SendWormholeOptions,
  WormholeDropRing,
  WormholeEnvelopeDraft,
  WormholePayloadType,
  WormholeReceipt,
} from './types.ts';

const CSRF_COOKIE = 'mx_csrf';
const MANIFEST_PATH = '/matrix-app.manifest.json';

/**
 * manifest 的可变持有者。
 *
 * 单独抽出来是为了让 `getManifest()`（同步）与 `loadManifest()`（异步）
 * 共享同一份状态，而不必把 manifest 变成 facade 上的可写字段。
 */
class ManifestHolder {
  #manifest: MatrixAppManifest | null;
  #loading: Promise<MatrixAppManifest | null> | null = null;
  readonly #placeholder: MatrixAppManifest;

  constructor(appId: string, initial: MatrixAppManifest | null) {
    this.#manifest = initial;
    this.#placeholder = {
      manifest_version: '1.0',
      app_id: normalizeAppKey(appId),
      name: normalizeAppKey(appId),
      entry_url: `https://${toAppHost(appId)}`,
      orbit_station: 'workshop',
      accepts: [],
      emits: [],
    };
  }

  /** 同步取。未就绪时返回占位（能力受限但结构完整）。 */
  get(): MatrixAppManifest {
    return this.#manifest ?? this.#placeholder;
  }

  /** 是否已拿到真实 manifest。 */
  get ready(): boolean {
    return this.#manifest !== null;
  }

  set(manifest: MatrixAppManifest | null): void {
    if (manifest !== null) this.#manifest = manifest;
  }

  /**
   * 拉取本站 manifest。并发调用共享同一个 Promise。
   *
   * 失败不抛：manifest 缺失时微站仍应能读数据，只是虫洞与插槽能力受限。
   */
  load(http: MatrixHttpClient, debug: boolean): Promise<MatrixAppManifest | null> {
    if (this.#manifest !== null) return Promise.resolve(this.#manifest);
    if (this.#loading !== null) return this.#loading;

    this.#loading = (async () => {
      try {
        const response = await http.request<unknown>({
          method: 'GET',
          path: MANIFEST_PATH,
          skipCsrf: true,
          noRetry: true,
        });
        const validation = validateManifest(response);
        if (validation.valid && validation.manifest !== null) {
          this.#manifest = validation.manifest;
          return this.#manifest;
        }
        if (debug) {
          console.debug(
            `[matrixos/sdk] 本站 ${MANIFEST_PATH} 校验未通过，将使用占位 manifest：${validation.errors.map((e) => e.message).join('; ')}`,
          );
        }
        return null;
      } catch {
        if (debug) console.debug(`[matrixos/sdk] 未能加载本站 manifest（${MANIFEST_PATH}），使用占位 manifest`);
        return null;
      } finally {
        this.#loading = null;
      }
    })();

    return this.#loading;
  }
}

/** 装配好的内部依赖。facade 只读它，不直接持有状态。 */
interface SDKInternals {
  readonly env: RuntimeEnv;
  readonly runtime: RuntimeContext;
  readonly options: MatrixSDKOptions;
  readonly allowedOrigins: OriginAllowList;
  readonly http: MatrixHttpClient;
  readonly idt: IdtExchanger;
  readonly bridge: HostBridge | null;
  readonly sso: SSOClientImpl;
  readonly assets: AssetClient;
  readonly wormhole: WormholeTransport;
  readonly manifest: ManifestHolder;
  readonly debug: boolean;
  readonly teardown: (() => void)[];
}

/**
 * 创建 SDK 实例。
 *
 * 同步返回，不发任何网络请求。真正的鉴权在 `initSSO()` 里发生，
 * manifest 在后台拉取——这样微站可以在渲染前就安全地构造 SDK。
 */
export function createMatrixSDK(options: MatrixSDKOptions): MatrixSDK {
  return createFacade(buildInternals(options));
}

function buildInternals(options: MatrixSDKOptions): SDKInternals {
  const debug = options.debug ?? false;
  const env = createRuntimeEnv();
  const runtime = detectRuntimeContext(env.win);
  const allowedOrigins = new OriginAllowList(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS, {
    // 显式给了白名单就不再自动放行 loopback——生产配置应当收紧。
    ...(options.allowedOrigins !== undefined ? { allowLoopback: false } : {}),
  });

  const manifest = new ManifestHolder(options.appId, options.manifest ?? null);
  const bridge = buildBridge(env, runtime, options, allowedOrigins, debug);

  /*
   * SSO 与 HTTP 客户端互相依赖：
   *   - HTTP 要从 SSO 取 `mx_at`（iframe 通道下令牌在内存里）；
   *   - SSO 要用 HTTP 去调 `/v1/auth/*`。
   * 用 holder 打破循环——`ssoHolder.instance` 在 SSO 构造完成后立即填上，
   * 而 HTTP 的令牌读取函数是惰性的（调用时才读），所以不会拿到 null。
   */
  const ssoHolder: { instance: SSOClientImpl | null } = { instance: null };

  const http = new MatrixHttpClient({
    ...options.http,
    /*
     * 后端基址。优先级：显式 http.baseUrl > options.apiBaseUrl > 默认常量。
     *
     * 默认值走 `http/client.ts` 的 `DEFAULT_API_BASE_URL`（唯一事实源，
     * 支持构建期 `NEXT_PUBLIC_MATRIXOS_API_BASE_URL` 注入）。
     *
     * ⚠️ 2026-10-21 修：此前这里是硬编码字面量 `'https://api.matrixos.edu'`，
     * 与 client.ts 的构造函数默认值构成**两处独立硬编码**。结果：只改 client.ts
     * 的默认值时，微站走的这条路径（经 `getMatrixSDK`）仍然打到旧域名 ——
     * 表现为 `AUTH_SERVICE_UNAVAILABLE: POST https://api.matrixos.edu/v1/auth/exchange — Failed to fetch`，
     * 而 hub 侧的注入已经生效，非常难定位。
     * 教训：同一个语义的默认值散落多处时，改一处等于没改。
     */
    baseUrl: options.http?.baseUrl ?? options.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    // CSRF 从 Cookie 读（`mx_csrf` 必须是非 HttpOnly 的双提交令牌，架构 §4.4.1）。
    getCsrfToken: options.http?.getCsrfToken ?? (() => readCookie(env.doc, CSRF_COOKIE)),
    // iframe 通道下令牌在内存/sessionStorage；Cookie 通道下返回 null，
    // 让浏览器用 HttpOnly Cookie，避免令牌同时出现在 JS 可读位置。
    getAccessToken: options.http?.getAccessToken ?? (() => ssoHolder.instance?.accessToken ?? null),
    onUnauthorized:
      options.http?.onUnauthorized ??
      (async () => {
        const sso = ssoHolder.instance;
        if (sso === null) return false;
        const session = await sso.refresh();
        return session.state === 'authenticated';
      }),
    debug,
  });

  const idt = new IdtExchanger({ http, debug });

  const sso = new SSOClientImpl({
    options: { ...options, allowedOrigins: allowedOrigins.patterns },
    env,
    http,
    idt,
    allowedOrigins,
    bridge,
    runtime,
    debug,
  });
  ssoHolder.instance = sso;

  const selfApp = normalizeAppKey(options.appId);

  /**
   * 解析目标站的 manifest。
   *
   * 优先问注册表（matrix-core），这样第三方站也能被正确解析。
   * 失败返回 null——调用方据此**降级为不预检**，而不是拒绝投送：
   * 注册表不可用时仍应允许投送（W3 的最终裁决在服务端与目标站两侧）。
   */
  const resolveManifest = async (targetApp: AppKey): Promise<MatrixAppManifest | null> => {
    try {
      const response = await http.request<unknown>({
        method: 'GET',
        path: `/v1/registry/manifests/${encodeURIComponent(normalizeAppKey(targetApp))}`,
        skipCsrf: true,
        noRetry: true,
      });
      const validation = validateManifest(response);
      return validation.valid ? validation.manifest : null;
    } catch {
      return null;
    }
  };

  const wormhole = new WormholeTransport({
    env,
    http,
    bridge,
    selfApp,
    getMatrixUid: () => sso.session.matrixUid,
    getManifest: () => manifest.get(),
    resolveManifest,
    debug,
  });

  const assets = new AssetClientImpl({
    http,
    selfApp,
    getMatrixUid: () => sso.session.matrixUid,
    debug,
  });

  return {
    env,
    runtime,
    options,
    allowedOrigins,
    http,
    idt,
    bridge,
    sso,
    assets,
    wormhole,
    manifest,
    debug,
    teardown: [],
  };
}

function buildBridge(
  env: RuntimeEnv,
  runtime: RuntimeContext,
  options: MatrixSDKOptions,
  allowedOrigins: OriginAllowList,
  debug: boolean,
): HostBridge | null {
  if (env.win === null) return null;
  // 顶层文档里没有对端可握手（也没有 opener）；此时不建桥，
  // `useHostBridge()` 会返回惰性空实现，微站代码无需分支。
  if (runtime === 'standalone' && env.win.opener === null) return null;

  return createHostBridge({
    env,
    allowedOrigins,
    ...(runtime === 'embedded' ? { role: 'tenant' as const } : {}),
    capabilities: BRIDGE_CAPABILITIES,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 3_000,
    debug,
  });
}

/** 把内部依赖包成对外的只读门面。 */
function createFacade(internals: SDKInternals): MatrixSDK {
  const { env, runtime, options, allowedOrigins, http, bridge, sso, assets, wormhole, manifest, debug, teardown } = internals;
  let disposed = false;
  let autoResize: AutoResizeReporter | null = null;

  const facade: MatrixSDK = {
    appId: normalizeAppKey(options.appId),
    runtime,
    sso,
    assets,
    http: { request: (requestOptions) => http.request(requestOptions) },
    allowedOrigins: allowedOrigins.patterns,

    getManifest(): MatrixAppManifest {
      return manifest.get();
    },

    async initSSO() {
      // 初始化会话的同时把 manifest 拉起来（两者独立，并行不互相阻塞）。
      void manifest.load(http, debug);
      return sso.init();
    },

    async emitAsset(asset: EmitAssetInput): Promise<AssetNode> {
      assertNotDisposed(disposed);
      return assets.emit(asset);
    },

    onWormholeDrop(dropOptions: OnWormholeDropOptions): () => void {
      assertNotDisposed(disposed);
      const unregister = registerWormholeReceiver({
        env,
        options: dropOptions,
        allowedOrigins,
        selfApp: normalizeAppKey(options.appId),
        debug,
      });
      teardown.push(unregister);
      return unregister;
    },

    async sendWormhole(
      targetApp: AppKey,
      payloadType: WormholePayloadType,
      payload:
        | WormholeEnvelopeDraft
        | {
            readonly data: Record<string, unknown>;
            readonly evidenceAnchors: WormholeEnvelopeDraft['evidenceAnchors'];
          },
      sendOptions: SendWormholeOptions = {},
    ): Promise<WormholeReceipt> {
      assertNotDisposed(disposed);
      return wormhole.send(targetApp, payloadType, payload, sendOptions);
    },

    createWormholeDropRing(): WormholeDropRing {
      assertNotDisposed(disposed);
      return createWormholeDropRing(wormhole);
    },

    useHostBridge(): HostBridge {
      return bridge ?? inertBridge();
    },

    disableAutoResize(): void {
      autoResize?.stop();
      autoResize = null;
    },

    validateManifest(json: unknown): ManifestValidationResult {
      return validateManifest(json);
    },

    async loadManifest(): Promise<MatrixAppManifest | null> {
      return manifest.load(http, debug);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const fn of teardown) {
        try {
          fn();
        } catch {
          // 清理失败不应阻断其他清理。
        }
      }
      teardown.length = 0;
      autoResize?.stop();
      autoResize = null;
      bridge?.close();
      internals.idt.reset();
    },
  };

  // 后台把 manifest 拉起来，供 `getManifest()` 稍后同步返回真实值。
  void manifest.load(http, debug);

  /*
   * ── 内容高度自适应（`layout.resize`）：默认自动启动 ─────────────────────
   *
   * 为什么不要求微站显式调用 `startAutoResize()`：
   *   1. 18 个官方站里绝大多数是 `scripts/gen-site.mjs` 生成的，加一行要扇出 18 次，
   *      而每次扇出都可能与 `apps/micro-sites/**` 的其它在制改动撞车；
   *   2. 忘记调用不会报错，只会表现为「某些面板内容被裁掉」——一类很难归因的静默故障；
   *   3. 这个能力**只在被 hub 内嵌时才有副作用**（顶层打开时 `useHostBridge()`
   *      返回惰性空桥，`startAutoResize` 自己就 no-op），所以默认开着的风险很低。
   *
   * 微站若要自己控制时机，调 `sdk.disableAutoResize()` 再自行 `startAutoResize()`。
   */
  if (bridge !== null) {
    try {
      autoResize = createAutoResizeReporter({
        bridge,
        appId: normalizeAppKey(options.appId),
        debug,
      });
      void autoResize.start();
    } catch {
      // 高度自适应失败不能影响 SDK 初始化：它是增强，不是前置条件。
      autoResize = null;
    }
  }

  return facade;
}

function assertNotDisposed(disposed: boolean): void {
  if (disposed) {
    throw new MatrixError({ code: 'ABORTED', message: 'SDK 实例已 dispose()，不能继续使用', retryable: false });
  }
}

/** 非 iframe 环境的惰性桥：接口完整但什么也不发。 */
function inertBridge(): HostBridge {
  return {
    role: 'host',
    connected: false,
    protocolVersion: 1,
    peerCapabilities: [],
    embedded: false,
    on: () => () => undefined,
    post: () => undefined,
    request: () =>
      Promise.reject(
        new MatrixError({
          code: 'ENVIRONMENT',
          message: '当前不在 iframe 内，没有宿主可通信。若需与父窗口通信，请用 iframe 嵌入本微站',
          retryable: false,
        }),
      ),
    handshake: () => Promise.resolve(),
    close: () => undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 便捷单例
// ─────────────────────────────────────────────────────────────────────────────

let singleton: { readonly instance: MatrixSDK; readonly appId: string } | null = null;

/**
 * 微站默认入口：拿到（或创建）当前页的 SDK 实例。
 *
 * 按 `appId` 幂等：同一 `appId` 重复调用返回同一实例；换 `appId` 会 dispose 旧的
 * （只会在开发期热更新时发生，生产不会）。
 */
export function getMatrixSDK(options: MatrixSDKOptions): MatrixSDK {
  const appId = normalizeAppKey(options.appId);
  if (singleton !== null) {
    if (singleton.appId === appId) return singleton.instance;
    singleton.instance.dispose();
    singleton = null;
  }
  const instance = createMatrixSDK(options);
  singleton = { instance, appId };
  return instance;
}

/** 仅测试用：重置单例。 */
export function resetMatrixSDKSingleton(): void {
  singleton?.instance.dispose();
  singleton = null;
}

export { issueIdtForTenant };
export type { InitSSOOptions, HttpClientOptions, SSOClient };
