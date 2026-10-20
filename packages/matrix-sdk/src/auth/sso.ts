/**
 * MatrixOS SDK · MatrixID 单点登录（双通道）
 *
 * ## 双通道是什么，为什么必须有两套
 *
 * 架构 ADR-02／ADR-03 的核心取舍：18 个微站用独立子域 `*.matrixos.edu`，
 * `mx_at` 放在 `Domain=.matrixos.edu` 的 HttpOnly Cookie 里，于是「一次登录、18 站免登」。
 *
 * 但 A4 要求 hub 用 iframe 同屏挂载 2–3 个微站。**iframe 里的子域是第三方上下文**，
 * Safari ITP 与 Chrome 的第三方 Cookie 限制会让 `mx_at` 根本不被发送——
 * 这时 Cookie 通道会「看起来登录了但所有 API 都 401」，是最难排查的一类故障。
 *
 * 所以必须有第二条通道：
 *
 * | 场景 | 通道 | 令牌载体 |
 * | :--- | :--- | :--- |
 * | 顶层访问 / 同源 | **Cookie 通道** | `mx_at` HttpOnly Cookie 由浏览器自动携带 |
 * | 跨源 iframe | **`mx_idt` 通道** | 宿主 `postMessage` 发一次性 120s 凭证 → 换 `mx_at` → 存内存 + sessionStorage |
 * | Cookie 被禁且拿不到 `mx_idt` | **降级** | 只读离线态 + 明确可操作提示（ADR-09 L2） |
 *
 * ## 一条重要的工程纪律
 *
 * **降级必须显式可见**。ADR-09 明确写了「不允许静默降级」。
 * 所以 `SSOSession.hint` 不是可选的调试字段，而是 UI 必须展示的东西——
 * 它带着 `actions[]`（用户具体该点哪里），而不是一句「登录失败」。
 */

import { AuthExpiredError, IdtExchangeError, MatrixError } from '../errors.ts';
import type { MatrixHttpClient } from '../http/client.ts';
import type { IdtExchanger } from './idt.ts';
import type { HostBridge } from '../types.ts';
import type { OriginAllowList } from '../security/origin.ts';
import { readCookie, resolveSessionStorage, navigateTo } from '../runtime/env.ts';
import type {
  InitSSOOptions,
  MatrixUser,
  RuntimeContext,
  RuntimeEnv,
  SSOClient,
  SSODegradationHint,
  SSOSession,
  SSOTokenSet,
  StorageLike,
} from '../types.ts';

/** `mx_at` 在 iframe 通道下的存储键。存 sessionStorage（不是 Cookie，见 ADR-03）。 */
const TOKEN_STORAGE_KEY = 'mx.sdk.mx_at';
const SCOPE_STORAGE_KEY = 'mx.sdk.scope';
const EXPIRY_STORAGE_KEY = 'mx.sdk.expires_at';
const UID_STORAGE_KEY = 'mx.sdk.matrix_uid';

/** Cookie 通道依赖这个 Cookie 名由浏览器自动携带；JS 读不到它（HttpOnly）。 */
const ACCESS_TOKEN_COOKIE = 'mx_at';
/** CSRF 双提交令牌。它**必须**能被 JS 读到，否则无法注入请求头。 */
const CSRF_COOKIE = 'mx_csrf';
/** 第三方 Cookie 探测用的 Cookie 名。 */
const COOKIE_PROBE_NAME = 'mx_probe';

export interface SSOClientInit {
  readonly options: InitSSOOptions;
  readonly env: RuntimeEnv;
  readonly http: MatrixHttpClient;
  readonly idt: IdtExchanger;
  readonly allowedOrigins: OriginAllowList;
  readonly bridge: HostBridge | null;
  readonly runtime: RuntimeContext;
  readonly debug: boolean;
}

export class SSOClientImpl implements SSOClient {
  #session: SSOSession;
  readonly #listeners = new Set<(session: SSOSession) => void>();
  readonly #options: InitSSOOptions;
  readonly #env: RuntimeEnv;
  readonly #http: MatrixHttpClient;
  readonly #idt: IdtExchanger;
  readonly #allowedOrigins: OriginAllowList;
  readonly #bridge: HostBridge | null;
  readonly #runtime: RuntimeContext;
  readonly #storage: StorageLike;
  readonly #debug: boolean;

  /** 内存里的 `mx_at`。iframe 通道专用；Cookie 通道下恒为 null（HttpOnly 读不到）。 */
  #accessToken: string | null = null;
  #expiresAt: number | null = null;
  #inFlight: Promise<SSOSession> | null = null;

  constructor(init: SSOClientInit) {
    this.#options = init.options;
    this.#env = init.env;
    this.#http = init.http;
    this.#idt = init.idt;
    this.#allowedOrigins = init.allowedOrigins;
    this.#bridge = init.bridge;
    this.#runtime = init.runtime;
    this.#debug = init.debug;
    this.#storage = resolveSessionStorage(init.env.win);
    this.#session = anonymousSession();
    this.#restoreFromStorage();
  }

  get session(): SSOSession {
    return this.#session;
  }

  /** 供 HTTP 客户端取令牌。Cookie 通道下返回 null，靠浏览器自动带 Cookie。 */
  get accessToken(): string | null {
    if (this.#accessToken === null) return null;
    if (this.#expiresAt !== null && this.#expiresAt <= this.#env.now()) {
      // 过期了就不再往外发，避免带着死令牌打一串 401。
      return null;
    }
    return this.#accessToken;
  }

  /** CSRF 双提交令牌读取器，注入给 HTTP 客户端。 */
  readonly getCsrfToken = (): string | null => readCookie(this.#env.doc, CSRF_COOKIE);

  onStateChange(listener: (session: SSOSession) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 主入口：建立会话。
   *
   * 并发调用共享同一个 Promise——这是 `mx_idt` 一次性语义的第一道防线
   * （React 18 StrictMode 会双跑 effect，不挡就会双发交换请求）。
   */
  async init(): Promise<SSOSession> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.#doInit().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async refresh(): Promise<SSOSession> {
    if (this.#runtime === 'headless') return this.#session;
    // iframe 通道：内存令牌过期只能重新问宿主要 mx_idt（refresh token 在 HttpOnly Cookie 里）。
    if (this.#session.channel === 'idt') {
      const idt = await this.#requestIdtFromHost();
      if (idt !== null) return this.#completeIdtExchange(idt);
      return this.#degrade({
        code: 'IFRAME_HANDSHAKE_TIMEOUT',
        message: '无法从 MatrixOS 主控台获取新的登录凭证',
        actions: [
          '点击右上角「↗ 全屏独立打开」，在新标签页中使用本微站',
          '若已在独立标签页打开，刷新页面即可重新登录',
        ],
        retryable: true,
      });
    }
    // Cookie 通道：服务端通过 mx_rt 滑动续期，SDK 只需重新问一次 userinfo。
    return this.#initCookieChannel({ silent: true });
  }

  buildAuthorizeUrl(extra: Record<string, string> = {}): string {
    const base = this.#options.apiBaseUrl ?? 'https://api.matrixos.edu';
    const redirectUri = this.#options.redirectUri ?? this.#env.href;
    const params = new URLSearchParams({
      client: this.#options.appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: `station:${this.#options.appId}:read,station:${this.#options.appId}:write`,
      ...extra,
    });
    return `${trimSlash(base)}/v1/auth/authorize?${params.toString()}`;
  }

  async logout(options: { readonly allDevices?: boolean } = {}): Promise<void> {
    const path = options.allDevices === true ? '/v1/auth/logout-all' : '/v1/auth/logout';
    try {
      await this.#http.request({ method: 'POST', path, body: { client: this.#options.appId } });
    } catch (error) {
      // 登出失败不能把用户卡在登录态里：本地状态无论如何要清。
      if (this.#debug) console.debug(`[matrixos/sdk] 登出请求失败（本地状态仍会清理）：${String(error)}`);
    }
    this.#clearLocalTokens();
    this.#setSession(anonymousSession());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 通道判定与执行
  // ───────────────────────────────────────────────────────────────────────────

  async #doInit(): Promise<SSOSession> {
    this.#setState('authenticating');

    if (this.#runtime === 'headless') {
      return this.#degrade({
        code: 'AUTH_SERVICE_UNAVAILABLE',
        message: '当前无浏览器环境（SSR / Node），MatrixID 会话不可用',
        actions: ['若这是在服务端渲染阶段，请在客户端组件（useEffect）中调用 initSSO()'],
        retryable: false,
      });
    }

    const requested = this.#options.channel ?? 'auto';

    // ── 显式指定 Cookie 通道 ────────────────────────────────────────────────
    if (requested === 'cookie') {
      return this.#initCookieChannel({ silent: false });
    }

    // ── 显式指定 mx_idt 通道 ───────────────────────────────────────────────
    if (requested === 'idt') {
      return this.#initIdtChannel();
    }

    // ── auto：按运行上下文分叉 ─────────────────────────────────────────────
    if (this.#runtime === 'embedded') {
      /*
       * iframe 内的**探测顺序**是刻意的：先试 Cookie，再走 mx_idt。
       *
       * 理由：第三方 Cookie **没被**阻断时（Chrome 默认配置、同站子域），
       * Cookie 通道只需一次 userinfo 调用，比「要 mx_idt + 交换」快一个往返。
       * 而阻断时我们本来就要发那个 userinfo 才能**确认**它被阻断——
       * 不确认就无法给出准确的降级提示（用户看到「登录失败」会以为是自己密码错了）。
       */
      const cookieAttempt = await this.#initCookieChannel({ silent: true });
      if (cookieAttempt.state === 'authenticated') return cookieAttempt;

      // Cookie 不可用 → 走 iframe 的正规通道。
      if (this.#options.fallbackToIdt !== false) {
        const idtSession = await this.#initIdtChannel();
        if (idtSession.state === 'authenticated' || idtSession.state === 'degraded') return idtSession;
      }

      // 两条路都断了：给出**针对第三方 Cookie** 的精确提示。
      const blocked = this.#detectCookieBlocked();
      return this.#degrade(
        blocked
          ? {
              code: 'THIRD_PARTY_COOKIE_BLOCKED',
              message:
                '当前浏览器阻止了第三方 Cookie，且未能从主控台获得一次性登录凭证，因此无法在嵌入式面板内建立登录态。',
              actions: [
                '点击面板右上角「↗ 全屏独立打开」，在独立标签页中使用本微站（不受第三方 Cookie 限制）',
                'Safari：设置 → Safari 浏览器 → 隐私 → 关闭「阻止跨网站跟踪」后刷新',
                'Chrome 无痕窗口默认阻止第三方 Cookie，请换用普通窗口',
              ],
              fallbackUrl: this.#env.href,
              retryable: true,
            }
          : {
              code: 'AUTH_SERVICE_UNAVAILABLE',
              message: '暂时无法连接 MatrixID 鉴权服务，当前以只读离线态运行。',
              actions: ['稍后重试', '若持续失败，请联系平台运维（错误码 AUTH_SERVICE_UNAVAILABLE）'],
              retryable: true,
            },
      );
    }

    // 顶层文档：域级 Cookie 就是零成本 SSO。
    return this.#initCookieChannel({ silent: false });
  }

  /** Cookie 通道：完全依赖浏览器自动携带 `mx_at`（HttpOnly，JS 读不到）。 */
  async #initCookieChannel(context: { readonly silent: boolean }): Promise<SSOSession> {
    try {
      const user = await this.#http.request<MatrixUser>({
        method: 'GET',
        path: '/v1/auth/userinfo',
        // 域级 Cookie 通道的核心：必须带凭据。
        skipCsrf: true,
        noRetry: true,
      });

      if (user === null || typeof user !== 'object' || typeof user.matrix_uid !== 'string') {
        return this.#degrade(this.#authUnavailableHint('鉴权服务返回了无法识别的用户信息'));
      }

      this.#setSession({
        state: 'authenticated',
        matrixUid: user.matrix_uid,
        scope: user.scope ?? [],
        user,
        channel: 'cookie',
        hint: null,
        expiresAt: null,
      });
      return this.#session;
    } catch (error) {
      const normalized = error instanceof MatrixError ? error : null;

      // 401 = 没登录（正常情况，不是故障）。是否跳登录由 autoRedirect 决定。
      if (normalized?.status === 401 || normalized?.code === 'AUTH_REQUIRED') {
        if (context.silent) {
          return this.#setSession({ ...anonymousSession(), channel: 'cookie', state: 'anonymous' });
        }
        if (this.#options.autoRedirect === true) {
          this.#redirectToLogin();
        }
        return this.#setSession({
          ...anonymousSession(),
          channel: 'cookie',
          state: 'anonymous',
          hint: {
            code: 'THIRD_PARTY_COOKIE_BLOCKED',
            message: '尚未登录 MatrixOS',
            actions: [`打开 ${this.buildAuthorizeUrl()} 完成登录`],
            fallbackUrl: this.buildAuthorizeUrl(),
            retryable: true,
          },
        });
      }

      // 网络 / 5xx = 服务不可用 → 只读离线态（ADR-09 L2），令牌可能仍然有效。
      if (normalized?.code === 'CIRCUIT_OPEN' || normalized?.code === 'NETWORK' || normalized?.code === 'TIMEOUT' || normalized?.code === 'SERVER') {
        return this.#degrade(this.#authUnavailableHint(normalized.message));
      }

      return this.#degrade(this.#authUnavailableHint(normalized?.message ?? String(error)));
    }
  }

  /** `mx_idt` 通道：向宿主要一次性凭证，换来 `mx_at` 并存在内存 + sessionStorage。 */
  async #initIdtChannel(): Promise<SSOSession> {
    // 先用可能已存在的会话内令牌（页面内跳转不必重新交换）。
    const cached = this.#readTokenFromStorage();
    if (cached !== null && cached.expires_at > this.#env.now() + 30_000) {
      this.#accessToken = cached.mx_at;
      this.#expiresAt = cached.expires_at;
      this.#setSession({
        state: 'authenticated',
        matrixUid: cached.matrix_uid,
        scope: cached.scope,
        user: { matrix_uid: cached.matrix_uid, scope: cached.scope },
        channel: 'idt',
        hint: null,
        expiresAt: cached.expires_at,
      });
      return this.#session;
    }

    const idt = await this.#requestIdtFromHost();
    if (idt === null) {
      return this.#degrade({
        code: 'IFRAME_HANDSHAKE_TIMEOUT',
        message: '未能从 MatrixOS 主控台获得一次性登录凭证（mx_idt）',
        actions: [
          '点击面板右上角「↗ 全屏独立打开」，在独立标签页中使用本微站',
          '若刚刷新过主控台，请等待星轨加载完成后再打开本面板',
        ],
        retryable: true,
      });
    }

    return this.#completeIdtExchange(idt);
  }

  /** 通过宿主桥索取 `mx_idt`。宿主侧由 `issueIdtForTenant()` 响应。 */
  async #requestIdtFromHost(): Promise<string | null> {
    const bridge = this.#bridge;
    if (bridge === null) return null;

    try {
      const response = await bridge.request<{ mx_idt?: unknown }>('sso.idt.request', { appId: this.#options.appId }, this.#options.handshakeTimeoutMs ?? 3_000);
      if (response !== null && typeof response === 'object') {
        const idt = (response as { mx_idt?: unknown }).mx_idt;
        if (typeof idt === 'string' && idt.length > 0) return idt;
      }
      return null;
    } catch (error) {
      if (this.#debug) console.debug(`[matrixos/sdk] 向宿主索取 mx_idt 失败：${String(error)}`);
      return null;
    }
  }

  async #completeIdtExchange(idt: string): Promise<SSOSession> {
    try {
      const tokenSet = await this.#idt.exchange(idt);
      this.#persistToken(tokenSet);
      this.#setSession({
        state: 'authenticated',
        matrixUid: tokenSet.matrix_uid,
        scope: tokenSet.scope,
        user: { matrix_uid: tokenSet.matrix_uid, scope: tokenSet.scope },
        channel: 'idt',
        hint: null,
        expiresAt: tokenSet.expires_at,
      });
      return this.#session;
    } catch (error) {
      if (error instanceof IdtExchangeError) {
        const alreadyConsumed = error.code === 'IDT_ALREADY_CONSUMED';
        return this.#degrade({
          code: alreadyConsumed ? 'IDT_EXCHANGE_FAILED' : 'IFRAME_HANDSHAKE_TIMEOUT',
          message: alreadyConsumed
            ? '本次登录凭证已被使用过（一次性凭证不可重复交换）。这通常是页面重复初始化导致的。'
            : '一次性登录凭证已过期（有效期 120 秒）。',
          actions: [
            '回到 MatrixOS 主控台，重新点击本微站的星轨胶囊',
            '或点击「↗ 全屏独立打开」在新标签页使用本微站',
          ],
          retryable: true,
        });
      }
      if (error instanceof AuthExpiredError) {
        return this.#degrade(this.#authUnavailableHint('一次性凭证交换后仍未获得有效令牌'));
      }
      return this.#degrade(this.#authUnavailableHint(String(error)));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 第三方 Cookie 探测
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 探测「第三方 Cookie 是否被阻断」。
   *
   * 手法：在 iframe 内写一个 `SameSite=None; Secure` 的探测 Cookie 再读回。
   * Safari ITP 与 Chrome 的第三方 Cookie 拦截会静默丢弃这次写入，读回为空。
   *
   * 这是**启发式**而非权威判定——没有浏览器 API 能直接告诉你「你现在能否在
   * 第三方上下文写 Cookie」。所以它只用来**选一句更准的提示文案**，
   * 绝不用它来决定「是否放行登录」（放行判定只认服务端响应）。
   */
  #detectCookieBlocked(): boolean {
    const doc = this.#env.doc as (DocumentLikeWithCookieSetter | null);
    if (doc === null) return false;

    try {
      const marker = `1-${this.#env.now()}`;
      doc.cookie = `${COOKIE_PROBE_NAME}=${marker}; path=/; SameSite=None; Secure`;
      const readBack = readCookie({ cookie: doc.cookie }, COOKIE_PROBE_NAME);
      const ok = readBack === marker;
      // 清理探测痕迹
      doc.cookie = `${COOKIE_PROBE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=None; Secure`;
      return !ok;
    } catch {
      return true;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 令牌持久化
  // ───────────────────────────────────────────────────────────────────────────

  #persistToken(tokenSet: SSOTokenSet): void {
    this.#accessToken = tokenSet.mx_at;
    this.#expiresAt = tokenSet.expires_at;
    /*
     * 存 sessionStorage 而非 localStorage 的理由（ADR-03 的折中）：
     *  - localStorage 会跨标签页存活，XSS 可长期窃取；
     *  - sessionStorage 随标签页关闭销毁，且不跨标签页共享——
     *    18 个站本来就各自是独立标签页，不需要共享内存令牌；
     *  - 内存 + sessionStorage 双写：内存优先（最快），sessionStorage 兜住
     *    「同标签页内跳转到另一个 iframe 路由」这类场景，避免重复交换消耗一次性凭证。
     */
    try {
      this.#storage.setItem(TOKEN_STORAGE_KEY, tokenSet.mx_at);
      this.#storage.setItem(EXPIRY_STORAGE_KEY, String(tokenSet.expires_at));
      this.#storage.setItem(UID_STORAGE_KEY, tokenSet.matrix_uid);
      this.#storage.setItem(SCOPE_STORAGE_KEY, tokenSet.scope.join(','));
    } catch {
      // 存储不可用（隐私模式）：退化为纯内存会话，功能不降级。
    }
  }

  #readTokenFromStorage(): SSOTokenSet | null {
    try {
      const mxAt = this.#storage.getItem(TOKEN_STORAGE_KEY);
      const expiresAtRaw = this.#storage.getItem(EXPIRY_STORAGE_KEY);
      const matrixUid = this.#storage.getItem(UID_STORAGE_KEY);
      if (mxAt === null || expiresAtRaw === null || matrixUid === null) return null;
      const expiresAt = Number(expiresAtRaw);
      if (!Number.isFinite(expiresAt)) return null;
      const scopeRaw = this.#storage.getItem(SCOPE_STORAGE_KEY) ?? '';
      return {
        mx_at: mxAt,
        expires_at: expiresAt,
        matrix_uid: matrixUid,
        scope: scopeRaw.length === 0 ? [] : scopeRaw.split(',').filter((s) => s.length > 0),
        station_id: this.#options.appId,
      };
    } catch {
      return null;
    }
  }

  #restoreFromStorage(): void {
    const cached = this.#readTokenFromStorage();
    if (cached === null || cached.expires_at <= this.#env.now()) return;
    this.#accessToken = cached.mx_at;
    this.#expiresAt = cached.expires_at;
  }

  #clearLocalTokens(): void {
    this.#accessToken = null;
    this.#expiresAt = null;
    this.#idt.reset();
    try {
      this.#storage.removeItem(TOKEN_STORAGE_KEY);
      this.#storage.removeItem(EXPIRY_STORAGE_KEY);
      this.#storage.removeItem(UID_STORAGE_KEY);
      this.#storage.removeItem(SCOPE_STORAGE_KEY);
    } catch {
      // 忽略：清理失败不影响内存态已失效。
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 会话状态
  // ───────────────────────────────────────────────────────────────────────────

  #setState(state: SSOSession['state']): void {
    this.#setSession({ ...this.#session, state });
  }

  #setSession(session: SSOSession): SSOSession {
    this.#session = session;
    for (const listener of [...this.#listeners]) {
      try {
        listener(session);
      } catch (error) {
        if (this.#debug) console.debug(`[matrixos/sdk] 会话监听器抛错：${String(error)}`);
      }
    }
    return session;
  }

  #degrade(hint: SSODegradationHint): SSOSession {
    return this.#setSession({
      state: hint.code === 'THIRD_PARTY_COOKIE_BLOCKED' ? 'cookie-blocked' : 'degraded',
      matrixUid: this.#session.matrixUid,
      scope: this.#session.scope,
      user: this.#session.user,
      channel: this.#session.channel,
      hint,
      expiresAt: this.#session.expiresAt,
    });
  }

  #authUnavailableHint(detail: string): SSODegradationHint {
    return {
      code: 'AUTH_SERVICE_UNAVAILABLE',
      message: `MatrixID 鉴权服务暂不可用：${detail}`,
      actions: [
        '当前为只读离线态，可查看已缓存数据，写入已暂停',
        '稍后点击重试；若持续失败请联系平台运维并附上错误码',
      ],
      retryable: true,
    };
  }

  #redirectToLogin(): void {
    const win = this.#env.win;
    if (win === null) return;
    const url = this.buildAuthorizeUrl();
    try {
      // 顶层跳转不受第三方 Cookie 限制——这是 iframe 降级最可靠的那一招。
      navigateTo(win.top ?? win, url);
    } catch {
      // 跨源时改 top.location 会抛 SecurityError。此时只在本帧内跳转是不安全的
      // （会把登录页塞进 iframe 的 300px 面板里），故放弃并留给 UI 的「全屏打开」按钮。
      if (this.#debug) console.debug('[matrixos/sdk] 无法顶层跳转登录（跨源 iframe），请使用「↗ 全屏独立打开」');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 宿主侧：为子站签发 mx_idt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 宿主（`orbital-hub`）侧：挂在桥上响应子站的 `mx_idt` 请求。
 *
 * 为什么不把这个逻辑塞进 SDK 内部自动执行：**签发票据必须有服务端往返**
 * （`POST /v1/auth/idt` 由核心服务绑定 `trace_id` + 目标站），
 * 宿主是唯一知道「当前用户 + 目标是哪个站」的一方。SDK 只提供粘合代码。
 *
 * @returns 取消订阅函数
 */
export function issueIdtForTenant(
  bridge: HostBridge,
  options: {
    readonly http: MatrixHttpClient;
    /** 从请求里取 appId，返回该站允许的 `matrix_uid` 等上下文（可做白名单校验）。 */
    readonly authorize: (appId: string) => boolean | Promise<boolean>;
    readonly debug?: boolean;
  },
): () => void {
  return bridge.on('sso.idt.request', (payload, meta) => {
    /**
     * 请求的 `rid` —— **必须原样回传**，否则 tenant 的 `await bridge.request(…)`
     * 永远配不上（见 Bug C 说明）。
     *
     * `bridge.request()` 发请求时会带 `rid`，对端只有把同一个 `rid` 放回
     * `*.ack`，本地 `settlePending(rid)` 才能把 Promise 收敛。
     * 2026-10-21 修复前：这里用 `bridge.post('sso.idt.ack', …)` 不带 rid，
     * 于是 ack 明明送达、`bridge.on('sso.idt.ack')` 也能收到，
     * 但 `#requestIdtFromHost` 的 Promise 永不 resolve → 5s 超时 →
     * 内嵌态永远 `IFRAME_HANDSHAKE_TIMEOUT`。
     */
    const requestRid = meta?.message?.rid;
    void (async () => {
      const appId = payload !== null && typeof payload === 'object' ? (payload as { appId?: unknown }).appId : undefined;
      if (typeof appId !== 'string' || appId.length === 0) return;

      const allowed = await options.authorize(appId);
      if (!allowed) {
        if (options.debug === true) console.debug(`[matrixos/sdk] 拒绝为 ${appId} 签发 mx_idt：不在允许清单内`);
        return;
      }

      try {
        const response = await options.http.request<{ mx_idt?: unknown }>({
          method: 'POST',
          path: '/v1/auth/idt',
          /**
           * 字段名必须是 `target_station`。
           *
           * 2026-10-21 修复（Bug D）：此前写的是 `target_app`，而后端
           * `IdtIssueRequest` 声明的是 `target_station` 且 `extra="forbid"`，
           * 于是真实后端必然回 **422**（实测：
           * `target_station: Field required; target_app: Extra inputs are not permitted`）。
           * 这个错误在只用 mock 的联调里看不出来 —— mock 通常对字段名宽松。
           */
          body: { target_station: appId },
          noRetry: true,
        });
        const idt = response !== null && typeof response === 'object' ? (response as { mx_idt?: unknown }).mx_idt : undefined;
        if (typeof idt !== 'string' || idt.length === 0) return;

        // 关键：只发给发起请求的那个 origin，绝不广播；并回传 rid 完成配对。
        bridge.post('sso.idt.ack', { mx_idt: idt, appId }, requestRid);
      } catch (error) {
        if (options.debug === true) console.debug(`[matrixos/sdk] 签发 mx_idt 失败：${String(error)}`);
      }
    })();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

interface DocumentLikeWithCookieSetter {
  cookie: string;
}

function anonymousSession(): SSOSession {
  return {
    state: 'anonymous',
    matrixUid: null,
    scope: [],
    user: null,
    channel: 'none',
    hint: null,
    expiresAt: null,
  };
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** 供 `MatrixSDK` 判定「是否已登录」用。 */
export function isAuthenticated(session: SSOSession): boolean {
  return session.state === 'authenticated' && session.matrixUid !== null;
}
