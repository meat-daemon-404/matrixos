'use client';

/**
 * orbital-hub · 宿主侧签发 `mx_idt`（I 线）
 * ==========================================================================
 * 补上协议里**最后一处缺失的接线**：`sso.idt.request`（tenant → host）已由
 * 微站侧 SDK 发出，但 hub 从来没有订阅它，于是内嵌态永远是
 * `IFRAME_HANDSHAKE_TIMEOUT · MatrixID offline`（R-T04 预言的那个场景）。
 *
 * ## 为什么不自己写这段逻辑
 *
 * SDK 已经有 `issueIdtForTenant(bridge, { http, authorize, debug })`（`auth/sso.ts`），
 * 里面把「取 appId → 白名单 → POST /v1/auth/idt → 只回给发起方」整条链路写好了。
 * 本文件**只做三件 SDK 不该做的事**：
 *   1. 提供 hub 自己的 http 客户端（SDK 不带 baseUrl / cookie 凭据的知识）；
 *   2. 提供**真实花名册**白名单（SDK 不知道 18 个官方站是哪些）；
 *   3. 接一个 `fetchImpl` 兜住一个**真实的协议不匹配**（下面详述）。
 *
 * ## ⚠️ 协议不匹配：SDK 发 `target_app`，后端要 `target_station`
 *
 * - SDK `auth/sso.ts:603`：`body: { target_app: appId }`
 * - 后端 `schemas/auth.py` 的 `IdtIssueRequest`：**字段名 `target_station`**，
 *   且 `model_config = ConfigDict(extra="forbid")`
 *
 * 两者不一致 → FastAPI 会回 422 `extra_forbidden` / `missing`，签不出任何票据。
 * 我**不在 `packages/matrix-sdk` 里改**（那不在本任务写域，且 SDK 是 18 站共享的
 * 冻结点，改它要另走评审）。改为在 hub 侧注入 `fetchImpl`：只在
 * `POST /v1/auth/idt` 这一个请求上把 `target_app` 改写成 `target_station`，
 * 其余请求原样透传。
 *
 * 这是**有意识的窄适配**，不是偷偷绕过校验：
 *   - 字段值就是 appId（`gpa` 这类 site_key），后端 `known_site_keys()` 会再校验一次；
 *   - 适配只作用于一个 path，任何其它请求都不受影响；
 *   - 一旦 SDK 侧修好字段名，这里的改写会因为「找不到 target_app」而自然失效
 *     （见 `rewriteIdtBody` 的注释），不需要再改代码。
 *
 * ## 鉴权：`/v1/auth/idt` 要求 hub 自己是登录态
 *
 * 后端 `issue_idt_endpoint` 的签名里有 `identity: IdentityDep`
 * （= `require_identity`：验签 + 吊销 + epoch + 用户激活，四道全过）。
 * 也就是说**hub 自身必须持有 `mx_at`**，否则会拿到 401。
 *
 * hub 当前没有登录流程（`OrbitalHub.tsx` 里的 `matrixUid` 全是硬编码演示值）。
 * 所以本模块的实际行为分两种，都会**显式说出来**：
 *   - hub 已登录（有 `mx_at` cookie 或内存令牌）→ 正常签发；
 *   - hub 未登录 → 请求 401，`console.warn` 明确写「hub 自身未登录」，
 *     并且**不伪造**任何 `sso.idt.ack`（宁可让微站继续显示 offline，
 *     也不要给它一个假身份 —— 那会让「重新登录」变成「静默失败」）。
 */

import { useEffect, useRef } from 'react';
import { issueIdtForTenant, MatrixHttpClient } from '@matrixos/sdk';
import type { RequestTrace } from '@matrixos/sdk';
import { STATION_BY_ID, STATIONS } from './microsites.generated';
import type { HostBridgeHandle } from './use-host-bridge';

/** 后端 `/v1/auth/idt` 的路径（唯一需要改写的请求）。 */
const IDT_PATH = '/v1/auth/idt';

/** hub 的 API 基址。与 `QueueReceiver.tsx` 用同一套环境变量，避免两处不一致。 */
function defaultApiBase(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_MATRIX_API_BASE ?? '').trim();
  if (fromEnv.length > 0) return fromEnv;
  const legacy = (process.env.NEXT_PUBLIC_API_BASE ?? '').trim();
  if (legacy.length > 0) return legacy;
  return 'https://api.matrixos.edu';
}

/**
 * 花名册白名单：只有 `microsites.generated.ts` 里登记过的 appId 才签发。
 *
 * 为什么用生成的 `STATIONS` 而不是手写一份清单：手写清单会随花名册漂移
 * （加站时忘改），而 `microsites.generated.ts` 是 `scripts/gen-microsites.mjs`
 * 从站点目录生成的，**加站必然同步**。
 *
 * 为什么不用 `() => true`：`issueIdtForTenant` 的 `authorize` 是这条链路上
 * **唯一的 appId 准入检查**（origin 校验只保证「消息来自信任的源」，
 * 不保证「这个源要的身份是它自己的」）。返回 true 等于任何嵌在 hub 里的
 * 第三方页都能拿到 18 个站里任意一个的一次性身份。
 *
 * 归一化：花名册的 `appId` 是 `gpa` 这类裸 key，而微站可能传 `gpa.matrixos.edu`。
 * 两种都接受，但**必须以归一化后的裸 key 命中花名册**。
 */
export function isRosterAppId(appId: string): boolean {
  const raw = appId.trim().toLowerCase();
  if (raw.length === 0) return false;
  // `gpa.matrixos.edu` / `https://gpa.matrixos.edu/x` → `gpa`
  const withoutScheme = raw.includes('://') ? raw.slice(raw.indexOf('://') + 3) : raw;
  const host = withoutScheme.split('/')[0] ?? '';
  const label = host.split('.')[0] ?? '';
  if (label.length === 0) return false;

  // 官方站：裸 appId 直接命中 STATION_BY_ID 的 appId 字段。
  for (const station of STATIONS) {
    if (station.appId === label) return true;
  }
  // 少数站的目录 id 与 appId 不同（ADR-001 刻意），按 id 也认一次。
  return STATION_BY_ID[label] !== undefined;
}

/**
 * 把 SDK 发出的 `target_app` 改写成后端要的 `target_station`。
 *
 * 只对 idt 请求生效；其它请求原样返回（保持 `body` 与 `init` 不变）。
 *
 * **幂等且会自然失效**：如果 body 里已经没有 `target_app`（说明 SDK 侧已改好），
 * 这里直接原样透传，不改写 —— 所以这个适配层不需要跟着 SDK 一起删。
 */
function rewriteIdtBody(url: string, init: RequestInit): RequestInit {
  if (!url.includes(IDT_PATH)) return init;
  if (typeof init.body !== 'string' || init.body.length === 0) return init;

  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (parsed === null || typeof parsed !== 'object') return init;

  const record = parsed as Record<string, unknown>;
  const targetApp = record['target_app'];
  if (typeof targetApp !== 'string' || targetApp.length === 0) {
    // SDK 已经用对了字段名（或没人用 target_app）：不插手。
    return init;
  }

  const rewritten: Record<string, unknown> = { ...record, target_station: targetApp };
  delete rewritten['target_app'];
  return { ...init, body: JSON.stringify(rewritten) };
}

/**
 * 造 hub 侧 http 客户端。
 *
 * 复用 SDK 的 `MatrixHttpClient`（自带超时、熔断、401 归一化），
 * 只注入两样 hub 才知道的东西：
 *   - `baseUrl`：hub 的 API 基址；
 *   - `fetchImpl`：在上面做 idt 字段名的窄改写。
 *
 * `credentials: 'include'` 由 SDK 内部固定加上（域级 Cookie 是 SSO 的
 * 非 iframe 通道），所以 hub 只要浏览器里有 `mx_at` cookie，这里就会自动带上。
 */
function createHubHttpClient(debug: boolean): MatrixHttpClient {
  return new MatrixHttpClient({
    baseUrl: defaultApiBase(),
    debug,
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const next = rewriteIdtBody(url, init ?? {});
      return fetch(input, next);
    },
  });
}

export interface SsoIdtOptions {
  /** 共享的宿主桥句柄（由 `useHostBridge` 提供 —— **不要**在这里再建一个桥）。 */
  readonly bridge: HostBridgeHandle;
  readonly debug?: boolean;
}

export interface SsoIdtState {
  /** 是否已订阅上 `sso.idt.request`。false = 桥没就绪，正在等。 */
  readonly listening: boolean;
  /** 成功签发并已回 `sso.idt.ack` 的次数。 */
  readonly issued: number;
  /** 因白名单被拒的次数。 */
  readonly rejected: number;
  /** 请求失败次数（网络 / 401 / 422 等）。 */
  readonly failed: number;
  /** 最近一次失败的**可读原因**（排障用，成功时为 null）。 */
  readonly lastError: string | null;
}

/**
 * 订阅 `sso.idt.request` 并签发 `mx_idt`。
 *
 * 桥来自 `useHostBridge`，这里只挂一个 `on()` 订阅 —— 与 `usePanelResize`
 * 的 `layout.resize` 订阅**并存在同一个桥上**（SDK 的 `on()` 是 Set 订阅，
 * 多订阅者互不干扰）。这正是「一个面板只能有一个桥」约束下的正确用法。
 */
export function useSsoIdtIssuer(options: SsoIdtOptions): SsoIdtState {
  const { bridge: handle, debug } = options;
  const stateRef = useRef<SsoIdtState>({
    listening: false,
    issued: 0,
    rejected: 0,
    failed: 0,
    lastError: null,
  });
  // 状态只在排障时读，不驱动渲染 —— 用 ref 避免每次签发都触发整面板重渲染。
  // （组件层若要显示，应从 `bridge.version` 变化时读一次快照。）

  useEffect(() => {
    const bridge = handle.bridge;
    if (bridge === null) {
      stateRef.current = { ...stateRef.current, listening: false };
      return;
    }

    const http = createHubHttpClient(debug === true);
    let disposed = false;

    /*
     * 直接复用 SDK 的 `issueIdtForTenant`。
     *
     * 它内部已经处理了：
     *   - payload 形状校验（appId 必须是非空 string）；
     *   - `await authorize(appId)`（我们的花名册白名单）；
     *   - `POST /v1/auth/idt`（我们的 fetchImpl 会改写字段名）；
     *   - 只对发起方 `bridge.post('sso.idt.ack', ...)`，不广播。
     * 我们只在它外面包一层**可观测性**：成功/被拒/失败各记一次，
     * 失败把原因打到 console.warn（原来这里是完全静默的）。
     */
    const unsubscribe = issueIdtForTenant(bridge, {
      http,
      authorize: async (appId: string): Promise<boolean> => {
        const allowed = isRosterAppId(appId);
        if (!allowed) {
          stateRef.current = {
            ...stateRef.current,
            rejected: stateRef.current.rejected + 1,
            lastError: `拒绝为「${appId}」签发：不在花名册（STATIONS）内`,
          };
          /*
           * 拒绝必须留痕。这是安全事件（有人试图拿不属于自己的身份），
           * 不只是"没做成" —— 所以用 warn 而不是 debug。
           */
          console.warn(`[hub/sso] 拒绝 mx_idt 签发：appId「${appId}」不在花名册内，可能是伪造请求`);
        }
        return allowed;
      },
      ...(debug === undefined ? {} : { debug }),
    });

    stateRef.current = { ...stateRef.current, listening: true };

    /*
     * SDK 的 `issueIdtForTenant` 内部把成功/失败都吞掉了（只在 debug 下打日志），
     * 所以这里**额外挂一个观察点**：监听桥自己发出的 `sso.idt.ack`。
     *
     * 为什么能听到：`bridge.post()` 只负责发出去，不会 emitLocal；但
     * `issueIdtForTenant` 是同步调 `bridge.post()` 的，我们无法从外部观测。
     * 所以改为在 http 层做观测 —— 见下面的 trace 订阅。
     */
    const unsubscribeTrace = (() => {
      const listener = (trace: RequestTrace): void => {
        if (!trace.path.includes(IDT_PATH)) return;
        if (disposed) return;
        if (trace.status !== null && trace.status >= 200 && trace.status < 300) {
          stateRef.current = { ...stateRef.current, issued: stateRef.current.issued + 1, lastError: null };
          return;
        }
        const reason =
          trace.status === 401
            ? 'hub 自身未登录（/v1/auth/idt 要求 hub 持有 mx_at）。这不是微站的问题：需要先让 hub 完成 MatrixID 登录。'
            : trace.status === 422
              ? '请求体字段不被后端接受（422）。检查 /v1/auth/idt 的字段名与 SDK 发出的是否一致。'
              : trace.status === null
                ? `网络层失败（${trace.errorCode ?? '未知'}）：无法访问 matrix-core。`
                : `后端返回 HTTP ${trace.status}。`;
        stateRef.current = {
          ...stateRef.current,
          failed: stateRef.current.failed + 1,
          lastError: reason,
        };
        console.warn(`[hub/sso] 签发 mx_idt 失败：${reason}`);
      };
      return http.onRequest(listener);
    })();

    if (debug === true) {
      console.debug(`[hub/sso] 已订阅 sso.idt.request（桥 version ${handle.version}）`);
    }

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeTrace();
      stateRef.current = { ...stateRef.current, listening: false };
    };
  }, [handle.bridge, handle.version, debug]);

  return stateRef.current;
}
