/**
 * ⚠️ 由 scripts/wire-workbench.mjs 从 apps/micro-sites/shared/templates/ 分发，请勿直接修改本文件。
 * 模板：apps/micro-sites/shared/templates/sdk-facade.ts
 * 作用：SDK 适配层（本站唯一 import @matrixos/sdk 的地方）
 * 站点：06 星门 · 导师五维星象仪
 * 轨道：轨道 4 · 星门 · 域名：mentor.matrixos.edu
 * 改法：改模板 → 跑 `node scripts/wire-workbench.mjs` 重新分发（18 站会一起更新）。
 */
/**
 * SDK 适配层（本站**唯一**允许 import `@matrixos/sdk` 的地方）
 * ==========================================================================
 * 为什么要有这一层：
 *  1. SDK 与本站并行开发 —— 这里做**可选解析**，包没就位或缺符号时 UI 显式说
 *     「未就位」，绝不伪造登录态，也不假装虫洞投递成功。
 *  2. SDK 真实 API 是**实例方法**（`getMatrixSDK({appId}).initSSO()`），
 *     不是顶层函数。所有版本差异都收敛在这一个文件里。
 *
 * 四条硬约束（都是被验收器/线上事故逼出来的）：
 *  1. **不在静态演示环境发起真实鉴权**：`initSSO()` 在独立窗口会走 Cookie 通道，
 *     第一句就是 `GET https://api.matrixos.edu/v1/auth/userinfo`。静态站没有后端，
 *     这一发就是失败请求。所以只有真的嵌在 orbital-hub iframe 里（`embedded`）
 *     **且握手完成**才调 `sdk.initSSO()`。握手天然晚于微站首帧（宿主桥是在
 *     iframe `onLoad` 之后才由 hub 建的），所以这里必须**等**，绝不能「判一次就放弃」
 *     —— 2026-10-21 线上「iframe 内 MatrixID 恒 offline」正是那次一次判负。
 *  2. **显式声明宿主 origin 白名单**：SDK 的 `DEFAULT_ALLOWED_ORIGINS` 只信任
 *     `*.matrixos.edu`，而真实部署全在 `*.pages.dev`。不传的话 tenant 桥会**两头自断**：
 *     发侧 `resolveTargetOrigin()` 用 `document.referrer` 推宿主 origin 被自己的白名单
 *     拒掉 → 消息只入队不发；收侧对每条 hello/ACK 校验 `event.origin` 被拒 → 静默丢弃。
 *     白名单与 `_headers` 的 CSP `frame-ancestors` 同源派生：**谁能嵌我，我才跟谁说话**。
 *  3. **manifest 走构建期内联，不走网络**：SDK 构造时会 `GET /matrix-app.manifest.json`。
 *     这里把站根的 `matrix-app.manifest.json` 直接 import 进来当初始 manifest，
 *     `ManifestHolder.load()` 见已有 manifest 会立刻返回，一个请求都不发。
 *  4. **不伪造**：SDK 没就位就报「未就位」；没宿主就说「未实际投送」。
 */
import * as MatrixSDK from "@matrixos/sdk";
import siteManifest from "../../matrix-app.manifest.json";
import type { EnvelopePayloadLike, SdkBridge } from "@matrixos/microsite-data";
import { SITE } from "../site.config";

type AnyFn = (...args: unknown[]) => unknown;

const rawSdk = MatrixSDK as unknown as Record<string, unknown>;

/** shim 模块会导出这个标记；真实 SDK 不会。 */
export const sdkIsShim = rawSdk.__matrixosShim === true;

/** SDK 实例上本站真正用到的方法子集（结构化声明，避免绑死 SDK 的导出类型）。 */
interface HostBridgeLike {
  readonly connected: boolean;
  readonly embedded: boolean;
  /**
   * 订阅桥事件。**这是「等宿主握手」的唯一可靠信号**：
   * `connected` 只是 getter，读它只能拿到「此刻」的瞬时值，而握手必然晚于首帧。
   * 宿主侧 `markConnected()` 会在握手成功时同步 emit `bridge.connected`。
   */
  on(event: string, handler: (payload: unknown, meta: unknown) => void): () => void;
  /**
   * 主动打招呼。tenant 侧发 `bridge.hello`，宿主在 listener 挂上后回 ACK。
   *
   * 为什么 facade 要自己反复调：SDK 内建的 `layout.resize` 协商确实会调它，
   * 但那段只在启动时试 3 次（每次 1.5s）就**永久放弃**——而宿主桥挂在
   * iframe `onLoad` 之后，慢网下可能晚于这个窗口。等握手是「鉴权的前置条件」，
   * 不能依赖另一条与本功能无关的链路的重试预算。
   */
  handshake?(): Promise<void>;
}

interface MatrixSdkLike {
  readonly appId: string;
  initSSO(): Promise<unknown>;
  onWormholeDrop(options: {
    accepts: readonly string[];
    onDrop: (context: { envelope: unknown }) => void | Promise<void>;
    autoAck?: boolean;
  }): () => void;
  sendWormhole(
    targetApp: string,
    payloadType: string,
    payload: { data: Record<string, unknown>; evidenceAnchors: readonly unknown[] },
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  emitAsset(asset: Record<string, unknown>): Promise<unknown>;
  useHostBridge(): HostBridgeLike;
  getManifest(): unknown;
  dispose(): void;
}

/* ───────────────────────── manifest 内联（零网络） ───────────────────────── */

const manifestRecord = siteManifest as unknown as Record<string, unknown>;

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 本站 manifest 声明的 accepts（虫洞接收白名单，SDK 会再校验一次）。 */
export const manifestAccepts: readonly string[] = stringArray(manifestRecord.accepts);
/** 本站 manifest 声明的 emits（主动投送的 payload_type 白名单）。 */
export const manifestEmits: readonly string[] = stringArray(manifestRecord.emits);

/* ─────────────────── 宿主 origin 白名单（构建期注入） ─────────────────── */

/**
 * 读构建期注入的宿主清单（`scripts/build-static-site.mjs` 写入，逗号分隔）。
 *
 * 为什么必须是**完整成员表达式** `process.env.NEXT_PUBLIC_…`：Next 的 DefinePlugin
 * 只按这个字面形状做构建期替换，解构（`const {X} = process.env`）或动态取值
 * （`process.env[name]`）在浏览器里会拿到 undefined —— 于是白名单静默变空，
 * 又回到「看着配了、一条都不放行」的老故障。
 *
 * 为什么 try 住：非 Next 打包环境（个别单测直接 import 本模块）里可能没有 `process`。
 * 这里按「未注入」处理并走开发兜底，不抛错——白名单缺失不该把整个页面打挂。
 */
function readInjectedHubOrigins(): string {
  try {
    return process.env.NEXT_PUBLIC_MATRIXOS_HUB_ORIGINS ?? '';
  } catch {
    return '';
  }
}

/**
 * 未注入时的兜底：`next dev` 不经过 `scripts/build-static-site.mjs`，
 * 而本地 hub 在 3000、微站在 301x（跨源），不带开发期宿主就永远握不上手。
 *
 * 刻意**不**做「从 `document.referrer` 自动信任任意 origin」：那等于谁嵌我就信谁，
 * 与 SDK `security/origin.ts` 的设计前提（信任必须显式且可审计）直接冲突。
 *
 * 也必须放 loopback：显式传 `allowedOrigins` 会让 SDK 关掉 loopback 自动放行
 * （`packages/matrix-sdk/src/sdk.ts` 的 allowLoopback: false 分支），
 * 所以兜底清单自己得把 `localhost:3000` / `127.0.0.1:3000` 写全。
 */
const DEFAULT_HUB_ORIGINS: readonly string[] = [
  /* 生产宿主由构建期注入（pages-headers.mjs 单一事实源）；
     这里只放开发期 loopback。原写死的 orbital.matrixos.edu 实测 NXDOMAIN，已移除。*/
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

interface HubOrigins {
  /** 传给 SDK `allowedOrigins` 的条目（SDK `OriginAllowList` 语法：通配写 `*.host`）。 */
  readonly origins: readonly string[];
  /** true = 来自构建期注入；false = 走了开发兜底。只用于状态文案，不参与判定。 */
  readonly injected: boolean;
}

let hubOriginsCache: HubOrigins | null = null;

/**
 * 从构建期注入的环境变量读后端 API 基址。
 *
 * 为什么微站要自己读一次（而不是交给 SDK 内部读）：
 *   SDK 以 `dist/` 预编译产物引入，Next 的 DefinePlugin **不会**替换 dist 里的
 *   `process.env.NEXT_PUBLIC_*` —— 浏览器端读到的是 undefined，SDK 就退回
 *   `https://api.matrixos.edu`（该域名当前 NXDOMAIN）。微站的
 *   `/v1/auth/exchange` 因此打到一个不存在的主机，报
 *   `AUTH_SERVICE_UNAVAILABLE: ... Failed to fetch`，看起来像网络问题，很难定位。
 *
 * 在**参与编译的源码**里写完整的 `process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL`
 * 才能被 Next 静态内联。
 *
 * @returns 注入值；未注入或为空时返回 null（让 SDK 用它的默认值）
 */
export function readApiBaseFromEnv(): string | null {
  try {
    const injected = process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL;
    if (typeof injected === 'string' && injected.trim().length > 0) return injected.trim();
  } catch {
    /* 非 Next 打包环境（单测）里可能没有 process */
  }
  return null;
}

/**
 * 计算宿主白名单。语义只有一个方向：**这些对端 origin 我信，我也只投给它们**。
 * 微站自己是 tenant，本站 origin **绝不能**出现在这里（那会让白名单名不副实）。
 */
export function resolveAllowedHubOrigins(): readonly string[] {
  return hubOriginsConfig().origins;
}

function hubOriginsConfig(): HubOrigins {
  if (hubOriginsCache !== null) return hubOriginsCache;

  const injected = readInjectedHubOrigins()
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  /*
   * 有注入就**完全采信注入值**，绝不并上 DEFAULT：
   * 否则「运维在 env 里删掉一条」不会真的生效，反而隐式放宽了信任面 ——
   * 配置了却被默默加回默认值，是最难排查的一类安全姿态漂移。
   */
  hubOriginsCache =
    injected.length > 0 ? { origins: injected, injected: true } : { origins: DEFAULT_HUB_ORIGINS, injected: false };
  return hubOriginsCache;
}

/* ───────────────────────────── SDK 实例解析 ───────────────────────────── */

let cachedSdk: MatrixSdkLike | null = null;
let failureReason: string | null = null;
let attempted = false;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 惰性拿 SDK 实例。浏览器端只尝试一次；SSR 端直接返回 null 且不缓存结果。
 *
 * 注意 `manifest: siteManifest` 这一项：它是「零网络」的关键。
 */
function resolveSdk(): MatrixSdkLike | null {
  if (cachedSdk !== null) return cachedSdk;
  if (typeof window === 'undefined') return null;
  if (attempted) return null;
  attempted = true;

  if (sdkIsShim) {
    failureReason = 'SDK 未就位：当前解析到本地 shim（不提供 SSO 与虫洞投递）';
    return null;
  }

  const factory = rawSdk.getMatrixSDK ?? rawSdk.createMatrixSDK;
  if (typeof factory !== 'function') {
    failureReason = 'SDK 未导出 getMatrixSDK / createMatrixSDK';
    return null;
  }

  try {
    // 显式放宽类型：manifest JSON 的字面量类型与 SDK 的枚举类型不直接兼容，
    // 真正的校验由 SDK 内部的 validateManifest 在 load() 前完成（这里给了 manifest 就不会 load）。
    const apiBase = readApiBaseFromEnv();
    const options = {
      appId: SITE.appId,
      manifest: siteManifest,
      // 不传这一项，SDK 就退回 `*.matrixos.edu` 默认值 → 线上 `*.pages.dev` 双向被拒（见文件头约束 2）。
      allowedOrigins: resolveAllowedHubOrigins(),
      /*
       * 后端 API 基址 —— 必须在**微站源码里**读，不能指望 SDK 内部读。
       *
       * 为什么：SDK 是以 `dist/` 预编译产物引入的（package.json exports → ./dist/index.js），
       * 而 Next 的 DefinePlugin **只替换参与编译的源码**里的 `process.env.NEXT_PUBLIC_*`。
       * dist 里那句 `process.env.NEXT_PUBLIC_MATRIXOS_API_BASE_URL` 会原样保留，
       * 浏览器里读到 undefined → 永远退回 `https://api.matrixos.edu`。
       *
       * 实测证据：构建产物 JS 里该变量名**未被替换**，仍是字面量字符串。
       * 这才是「微站已注入 env 却仍打旧域名」的真因。
       */
      ...(apiBase !== null ? { apiBaseUrl: apiBase } : {}),
    } as unknown as Record<string, unknown>;
    cachedSdk = (factory as AnyFn)(options) as MatrixSdkLike;
    failureReason = null;
    return cachedSdk;
  } catch (error) {
    failureReason = '构造 SDK 实例失败：' + describe(error);
    return null;
  }
}

/**
 * 惰性空桥：形态完整、永远连不上、订阅立即返回空取消函数。
 * 用它而不是各处 `if (bridge === null)` 分支，是为了让下面 `initSSO` 的
 * 「订阅 → 等握手」只有一条代码路径（少一条分支就少一处「某条路径忘了等」的坑）。
 */
function inertHost(): HostBridgeLike {
  return { connected: false, embedded: false, on: () => () => undefined };
}

function liveHost(): HostBridgeLike {
  const sdk = resolveSdk();
  if (sdk === null) return inertHost();
  try {
    return sdk.useHostBridge();
  } catch {
    return inertHost();
  }
}

/* ───────────────────────────── 状态与自检 ───────────────────────────── */

export interface SdkStatus {
  readonly available: boolean;
  readonly shim: boolean;
  readonly symbols: readonly string[];
  /** 给「通道自检」按钮直接展示的一句话。 */
  readonly detail: string;
}

const TRACKED_METHODS = [
  'initSSO',
  'onWormholeDrop',
  'sendWormhole',
  'emitAsset',
  'useHostBridge',
] as const;

export function sdkStatus(): SdkStatus {
  const sdk = resolveSdk();
  if (sdk === null) {
    return {
      available: false,
      shim: sdkIsShim,
      symbols: [],
      detail: failureReason ?? 'SDK 状态待检测',
    };
  }
  const record = sdk as unknown as Record<string, unknown>;
  const symbols = TRACKED_METHODS.filter((name) => typeof record[name] === 'function');
  const host = liveHost();
  const hubOrigins = hubOriginsConfig();
  return {
    available: !sdkIsShim && symbols.length > 0,
    shim: sdkIsShim,
    symbols,
    detail:
      'SDK 已就位 · appId=' +
      SITE.appId +
      ' · 实例方法 ' +
      symbols.join('/') +
      ' · 宿主' +
      (host.connected ? '已连接' : '未连接') +
      ' · 宿主白名单 ' +
      String(hubOrigins.origins.length) +
      ' 项（' +
      (hubOrigins.injected ? '构建期注入' : '开发兜底') +
      '）' +
      ' · manifest 内联（accepts ' +
      String(manifestAccepts.length) +
      ' / emits ' +
      String(manifestEmits.length) +
      '）',
  };
}

/* ───────────────────────────── MatrixID 会话 ───────────────────────────── */

export type SessionPhase = 'booting' | 'ready' | 'offline';

export interface SessionState {
  readonly phase: SessionPhase;
  readonly uid?: string;
  readonly detail: string;
}

export interface SsoHandle {
  dispose(): void;
}

/**
 * 等宿主握手的上限。
 *
 * 取 9s 的理由：hub 侧宿主桥建在 iframe `onLoad` **之后**，慢网下首帧到 onLoad
 * 可能几秒；同时不能无限等 —— 界面必须在用户还能容忍的时间内落到一个
 * **准确**的终态，而不是永远停在「检测中」。
 */
const HOST_HANDSHAKE_TIMEOUT_MS = 9_000;

/**
 * 重试打招呼的间隔。
 *
 * 为什么不能只订阅一次 `bridge.connected` 就干等：宿主桥的 listener 也是
 * 在 iframe `onLoad` 之后才挂上的，此刻发出的 `bridge.hello` 会**落在空气里**
 * （`postMessage` 没有重传）。而握手是双向的，只有我们主动 hello、宿主回 ACK
 * 才算连通。所以按固定间隔再敲一次门，直到超时。
 */
const HOST_HANDSHAKE_RETRY_MS = 500;

/**
 * 初始化 MatrixID。**同步返回句柄**，状态经 `onStateChange` 异步回填，
 * 这样 React 组件不会因为「忘记 await」而卡在 booting。
 *
 * 时序（这是本函数唯一容易写错的地方，故显式列出）：
 *
 *   1. 独立窗口（`embedded === false`）→ **立即**报待命，一个请求都不发（约束 1）。
 *   2. iframe 内已握手（桥比 effect 先建好）→ 直接发起鉴权。
 *   3. iframe 内尚未握手（**常态**）→ 订阅 `bridge.connected` 等宿主，
 *      握手成功后自动继续；超过 `HOST_HANDSHAKE_TIMEOUT_MS` 才落 offline。
 *
 * 为什么不能「读一次 `connected` 就判负」：宿主桥必须在 iframe `onLoad` 之后
 * 才由 hub 创建，所以微站首帧那一刻 `connected` 几乎必然是 false。
 * 2026-10-21 线上全部微站在总控台里恒显 `MatrixID · offline` 就是这条造成的。
 */
export function initSSO(onStateChange: (state: SessionState) => void): SsoHandle {
  const sdk = resolveSdk();
  if (sdk === null) {
    onStateChange({
      phase: 'offline',
      detail: 'MatrixID 未接入：' + (failureReason ?? 'SDK 未就位') + '（不伪造登录）',
    });
    return { dispose: () => undefined };
  }

  const host = liveHost();

  /*
   * 硬约束 1：只有真的嵌在宿主 iframe 里才等待/发起。
   * `embedded` 是「本窗口是不是 tenant」，与握手是否完成无关 ——
   * 正是它该作为「要不要等」的判据，而不是 `connected`。
   */
  if (!host.embedded) {
    onStateChange({
      phase: 'offline',
      detail: 'MatrixID 待命：独立窗口无 hub 宿主，静态演示不发起真实鉴权请求（不伪造登录态）。',
    });
    return { dispose: () => undefined };
  }

  let cancelled = false;
  /** 是否已经有最终结论（成功或失败）。保证 `onStateChange` 只被终结一次。 */
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setInterval> | null = null;

  /** 卸掉等待期的订阅与计时器：两条路径（握手成功 / 超时）都要走，避免重复回调。 */
  const stopWaiting = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (retryTimer !== null) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  /**
   * 握手已就绪后的正规路径：这一句才真的会发请求（iframe 通道：先静默 Cookie 探测，再换 mx_idt）。
   *
   * ⚠️ 这里必须**先翻一次状态**再 await。
   *
   * 线上实测（2026-10-21，修复部署后）：握手其实在 t≈6s 之前就完成了，
   * 但 `sdk.initSSO()` 内部要依次走「静默 Cookie 探测（打到无后端的 api.matrixos.edu，
   * 要等它失败）」→「向宿主要 mx_idt（3s 超时）」→ 才返回。整段大约 18 秒。
   * 而在此之前 UI 一直显示「等待宿主握手」—— **那句话是假的**：桥早就通了。
   *
   * 这个错误文案的代价不是「不好看」，是**排障方向被带偏**：看到「握手没通」的人会去查
   * 白名单、CSP、桥时序，而真实原因在鉴权侧。所以一进这个函数就先说清「在换凭证」。
   */
  const authenticate = (): void => {
    settled = true;
    // 立刻把界面从「等握手」切到「换凭证」。不要等 await 回来再改。
    onStateChange({
      phase: 'booting',
      detail: 'MatrixID 握手已通，正在交换登录凭证（先试 Cookie 通道，失败再向宿主要 mx_idt）…',
    });
    void (async () => {
      try {
        const session = (await sdk.initSSO()) as Record<string, unknown> | null;
        if (cancelled) return;
        const record = (session ?? {}) as Record<string, unknown>;
        const uidRaw = record.matrixUid;
        const uid = typeof uidRaw === 'string' && uidRaw !== '' ? uidRaw : undefined;
        const state = typeof record.state === 'string' ? record.state : 'anonymous';
        const authenticated = state === 'authenticated';
        onStateChange({
          phase: authenticated ? 'ready' : 'offline',
          ...(uid !== undefined ? { uid } : {}),
          detail:
            'iframe 通道 · MatrixID ' +
            state +
            (uid !== undefined ? ' · ' + uid : '') +
            // 走到这里说明**宿主桥是通的**，offline 只可能是鉴权侧的问题
            // （未登录 / 宿主不签发 mx_idt / 一次性凭证过期）。把 SDK 的
            // 降级提示原样带出来，避免与「等不到宿主」混成同一句话。
            (!authenticated ? ' · ' + describeSessionHint(record.hint) : ''),
        });
      } catch (error) {
        if (cancelled) return;
        onStateChange({ phase: 'offline', detail: 'MatrixID 初始化失败：' + describe(error) });
      }
    })();
  };

  if (host.connected) {
    // 桥比本次 effect 更早建好（例如面板里切站后重挂载）。不必等。
    authenticate();
    return {
      dispose: () => {
        cancelled = true;
      },
    };
  }

  // ── 常态：宿主桥还没建，等它 ────────────────────────────────────────────
  onStateChange({
    phase: 'booting',
    detail: 'MatrixID 等待宿主握手：宿主桥晚于微站首帧建立，握手完成后会自动继续鉴权…',
  });

  try {
    unsubscribe = host.on('bridge.connected', () => {
      if (cancelled || settled) return;
      stopWaiting();
      authenticate();
    });
  } catch {
    // 订阅失败（非标准桥实现）：退化成「只靠超时」，但仍不能一次判负后静默。
    unsubscribe = null;
  }

  /*
   * 主动反复敲门，**不等** `handshake()` 的返回。
   *
   * 为什么不能「在途就不发」：`handshake()` 内部要等满一个 handshakeTimeout（默认 3s）
   * 才落超时。若加「在途」闸，9s 窗口里只会在 0s / 3s / 6s 各发一次 hello ——
   * 而 hello 是**没有重传**的 `postMessage`，落在宿主 listener 挂上之前就永远丢了。
   * 所以宁可发密一点（每 `HOST_HANDSHAKE_RETRY_MS` 一个 hello），
   * 让「宿主什么时候把桥挂上」与「我们什么时候正好敲门」解耦。
   *
   * 代价可接受：每次只有一个计时器 + 一个监听，连上后各自 resolve 并退订。
   */
  const poke = (): void => {
    if (cancelled || settled) return;
    if (host.connected) {
      stopWaiting();
      authenticate();
      return;
    }
    const handshake = host.handshake;
    if (typeof handshake !== 'function') return;
    /*
     * 发之前再看一眼 `cancelled`：`poke()` 是同步调、握手是微任务，
     * 中间这一拍足够 `dispose()` 跑完。不查的话「dispose 之后仍会往宿主发一条 hello」——
     * 虽然无害，但取消语义要经得起逐条推敲，不能靠「反正没后果」。
     */
    void Promise.resolve()
      .then(() => {
        if (cancelled || settled) return undefined;
        return handshake.call(host);
      })
      // `handshake()` 内部把超时当正常结果 resolve，这里只吞掉真正的意外拒绝。
      .catch(() => undefined);
  };

  /*
   * 先把两个计时器登记好，再敲第一次门。
   *
   * 这不是在修一个已知 bug（`poke()` 内部走微任务，初次调用不可能同步连上），
   * 而是不愿意让正确性依赖那个实现细节：`stopWaiting()` 只清得掉**已经赋值**的句柄，
   * 万一将来有人把 poke 改成同步路径，顺序反过来就会留下一个空转的 interval。
   * 顺序摆对了，这个隐患从根上不存在，成本是零。
   */
  retryTimer = setInterval(poke, HOST_HANDSHAKE_RETRY_MS);

  timer = setTimeout(() => {
    timer = null;
    if (cancelled || settled) return;
    settled = true;
    stopWaiting();
    /*
     * 文案必须**准确**：走到这里只证明一件事 —— 9s 内没收到宿主的握手 ACK。
     * 绝不能说成「未登录」或「鉴权失败」：那会把排障方向从
     * 「通道没建起来」误导到「账号有问题」。真实原因只可能是这三类之一。
     */
    onStateChange({
      phase: 'offline',
      detail:
        'MatrixID 等不到宿主：' +
        String(HOST_HANDSHAKE_TIMEOUT_MS / 1000) +
        's 内未收到 hub 的握手 ACK（iframe 已内嵌，但桥未连通），未发起鉴权。' +
        '常见原因：宿主页面未建桥 / CSP frame-ancestors 未放行本宿主 / SDK 宿主白名单不含该 origin。',
    });
  }, HOST_HANDSHAKE_TIMEOUT_MS);

  poke();

  return {
    dispose: () => {
      // 取消语义：订阅卸掉、计时器清掉，之后任何回调都不再触发（`cancelled` 兜底）。
      cancelled = true;
      stopWaiting();
    },
  };
}

/** 把 SDK 的降级提示压成一句话；没有提示时给一个不撒谎的兜底描述。 */
function describeSessionHint(hint: unknown): string {
  if (hint === null || typeof hint !== 'object') return '宿主通道已连通但未取得登录态';
  const record = hint as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  if (code !== '' && message !== '') return code + '：' + message;
  if (message !== '') return message;
  if (code !== '') return code;
  return '宿主通道已连通但未取得登录态';
}

/* ───────────────────────────── 虫洞接收 ───────────────────────────── */

export interface WormholeReceipt {
  readonly traceId: string;
  readonly payloadType: string;
  readonly evidenceCount: number;
  readonly receivedAt: string;
  readonly sourceApp: string;
  /** 真投递时由 hub 下发的一次性凭证（120s）；本地演示为 undefined */
  readonly receiptId?: string;
}

/**
 * 注册虫洞接收器。契约见 specs/contracts/wormhole-envelope.schema.json：
 * payload.evidence_anchors 至少 1 条，且每条必须带 source_doi_or_url + verification_level。
 *
 * 注意 SDK 的签名是 `onWormholeDrop({ accepts, onDrop })` —— 不是裸 handler，
 * 且 `onDrop` 收到的是 context（`{ envelope, origin, ack, reject }`）。
 */
export function onWormholeDrop(
  handler: (receipt: WormholeReceipt) => void,
): (() => void) | undefined {
  const sdk = resolveSdk();
  if (sdk === null) return undefined;
  if (manifestAccepts.length === 0) return undefined;

  try {
    return sdk.onWormholeDrop({
      accepts: manifestAccepts,
      autoAck: true,
      onDrop: (context) => {
        handler(toReceipt(context.envelope));
      },
    });
  } catch {
    return undefined;
  }
}

/* ───────────────────────── 宿主字号密度下发 ───────────────────────── */

/**
 * 宿主（orbital-hub）的字号密度档位，通过 iframe 桥下发给微站。
 *
 * ## 为什么必须有这条链路
 *
 * hub 顶栏有「A±」字号开关（答辩投影用，normal 1.0 / large 1.25 / xlarge 1.5）。
 * 但它**只作用于 hub 自己的 DOM** —— iframe 是独立浏览上下文，父页面的 CSS 变量
 * 和 font-size 都不会继承进去。实测（2026-10-21，线上）：
 *
 * ```
 * hub 切到 xlarge 后：
 *   hub 自己的 .hub-stat  = 15px  ✓ 放大了
 *   iframe 内 .instrument .mono = 10px  ✗ 完全没变
 * ```
 *
 * 而答辩时要看的恰恰是**仪器里的公式与读数**（那些 8–10px 的字），
 * 不是顶栏统计。不打通这条链路，那个开关对它的初衷只做了一半。
 *
 * ## 为什么用 `data-iu-density` 而不是自己造一套
 *
 * `packages/instrument-ui` 早就定义了这套机制（`tokens.css:174`）：
 *
 * ```css
 * [data-iu-density='presentation'] { --iu-type-scale: 1.25; }
 * ```
 *
 * 组件库里所有字号都走 `--iu-type-scale`，所以**只要把属性挂上去，整套仪器
 * 就会等比放大**，不需要微站或组件库改任何字号。这正是该机制存在的目的
 * （视觉体系 §3.2 V8 建议），复用它比自己再造一层更不容易漂移。
 *
 * ## 档位映射
 *
 *   hub normal  → 移除属性（默认密度）
 *   hub large   → 'presentation'（组件库定义的 1.25×，与 hub 的 large 倍数一致）
 *   hub xlarge  → 'presentation' + 额外把缩放提到 1.5
 *
 * 注意 `--iu-type-scale` 是组件库的内部变量，直接覆盖属于「跨层改内部量」，
 * 但这里没有更好的公开接口（`data-iu-density` 只有 default/presentation 两档），
 * 且失败时只是放大倍数不精确、不会破版 —— 可接受，已在下面注明。
 */
export function applyHostDensity(mode: unknown): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  if (mode === 'large' || mode === 'xlarge') {
    root.setAttribute('data-iu-density', 'presentation');
    /*
     * 组件库只提供 1.25 一档。xlarge 需要 1.5，
     * 在 html 上覆盖 `--iu-type-scale` 即可（该变量被组件库所有字号引用）。
     * 若组件库将来改了这个变量名，最坏情况是回落到 1.25 —— 仍然是放大，不会破版。
     */
    if (mode === 'xlarge') {
      root.style.setProperty('--iu-type-scale', '1.5');
    } else {
      root.style.removeProperty('--iu-type-scale');
    }
  } else {
    root.removeAttribute('data-iu-density');
    root.style.removeProperty('--iu-type-scale');
  }
}

/**
 * 订阅宿主下发的字号密度，并自动应用。返回取消订阅函数。
 *
 * 宿主侧通过桥的 `theme.density` 消息发送 `{ mode: 'normal' | 'large' | 'xlarge' }`。
 * 未收到任何消息时保持微站自己的默认密度（不擅自放大）。
 *
 * 为什么复用桥而不是 query string / postMessage 裸通道：
 * 桥已带 origin 白名单与协议版本校验，是宿主↔微站唯一被审计过的通道；
 * 另开一条通道等于绕过那层校验。
 */
export function onHostDensity(handler?: (mode: string) => void): (() => void) | undefined {
  const sdk = resolveSdk();
  if (sdk === null) return undefined;
  const host = liveHost();
  /* 独立窗口没有宿主，谈不上"宿主下发" */
  if (!host.embedded) return undefined;

  const apply = (raw: unknown): void => {
    const payload = (raw ?? {}) as Record<string, unknown>;
    const mode = typeof payload.mode === 'string' ? payload.mode : 'normal';
    applyHostDensity(mode);
    handler?.(mode);
  };

  try {
    const off = host.on('theme.density', apply);
    /*
     * 握手时补一次：宿主可能在桥连上之前就发过密度（那时消息入队/丢失），
     * 而 `bridge.connected` 时宿主通常已把当前档位准备好。
     * 这里**主动问一次**，避免"首次放大要等用户再点一下开关"。
     */
    const offConnected = host.on('bridge.connected', () => {
      try {
        (host as unknown as { post?: (type: string, payload?: unknown) => void }).post?.(
          'theme.density.request',
          {},
        );
      } catch {
        /* 老宿主不认这条消息：保持默认密度即可 */
      }
    });
    return () => {
      off();
      offConnected();
    };
  } catch {
    return undefined;
  }
}

/** 把任意 envelope 归一成展示用收据；字段缺失也不抛错。 */
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

/* ───────────────────────────── 完工台能力桥 ───────────────────────────── */

/**
 * 给 `SiteWorkbench` 用的能力桥。
 *
 * `available` / `hostConnected` 都是 **getter**：宿主可能晚于首帧才握手成功，
 * 用 getter 就能让「点击那一刻」读到真实状态，而不必把桥做成响应式。
 * 两者在渲染期都不会被读取（Workbench 只在事件回调里读），因此不会造成
 * 服务端/客户端首帧不一致的 hydration 告警。
 */
export function sdkBridge(): SdkBridge {
  return {
    get available(): boolean {
      return resolveSdk() !== null;
    },
    get hostConnected(): boolean {
      return liveHost().connected;
    },
    sendWormhole(targetApp: string, payloadType: string, payload: EnvelopePayloadLike): Promise<unknown> {
      const sdk = resolveSdk();
      if (sdk === null) return Promise.reject(new Error('SDK 未就位，无法投送'));
      return sdk.sendWormhole(
        targetApp,
        payloadType,
        { data: payload.data, evidenceAnchors: payload.evidence_anchors },
        // 静态演示不申请服务端收据（那是一条 POST）；真 hub 环境会走完整链路。
        { skipReceipt: true },
      );
    },
    emitAsset(asset: Readonly<Record<string, unknown>>): Promise<unknown> {
      const sdk = resolveSdk();
      if (sdk === null) return Promise.reject(new Error('SDK 未就位，无法写入资产图谱'));
      return sdk.emitAsset(asset as Record<string, unknown>);
    },
    onWormholeDrop(handler) {
      const sdk = resolveSdk();
      if (sdk === null || manifestAccepts.length === 0) return undefined;
      try {
        return sdk.onWormholeDrop({
          accepts: manifestAccepts,
          autoAck: true,
          onDrop: (context) => {
            handler(toEnvelope(context.envelope));
          },
        });
      } catch {
        return undefined;
      }
    },
  };
}

/** 把原始 envelope 归一成 `ConsumableEnvelope`（缺失字段不抛错）。 */
function toEnvelope(envelope: unknown): {
  trace_id: string;
  source_app?: string;
  payload_type?: string;
  payload: EnvelopePayloadLike;
} {
  const env = (envelope ?? {}) as Record<string, unknown>;
  const payload = (env.payload ?? {}) as Record<string, unknown>;
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const anchors = Array.isArray(payload.evidence_anchors)
    ? (payload.evidence_anchors as EnvelopePayloadLike['evidence_anchors'])
    : [];
  const sourceApp = env.source_app;
  const payloadType = env.payload_type;
  return {
    trace_id: String(env.trace_id ?? 'unknown'),
    ...(typeof sourceApp === 'string' ? { source_app: sourceApp } : {}),
    ...(typeof payloadType === 'string' ? { payload_type: payloadType } : {}),
    payload: { data, evidence_anchors: anchors },
  };
}
