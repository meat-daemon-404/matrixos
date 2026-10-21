'use client';

/**
 * MatrixID 登录入口（hub 自身登录态）。
 *
 * ── 为什么 hub 需要自己登录 ────────────────────────────────────────────────
 *
 * `POST /v1/auth/idt`（hub 为微站签发 mx_idt）要求**调用方自己是登录态**：
 * 后端会取 `IdentityDep`（来自 `Authorization: Bearer` 或 `mx_at` Cookie），
 * 未登录直接 401 `auth.login_required`。
 *
 * 此前 hub 完全没有登录入口，`OrbitalHub.tsx` 里的 `matrixUid` 是硬编码演示值
 * `mxu_01H8Z9K2`。后果：即使 hub 接线了 `issueIdtForTenant`（I 线已做）、
 * 协议也对（`214e7b8` 修了 ack 的 rid 与字段名），`/v1/auth/idt` 仍然 401，
 * 微站内嵌态永远 `MatrixID · offline`。
 *
 * ── 本组件做什么 ──────────────────────────────────────────────────────────
 *
 * 最小可用实现（不是完整 OAuth 授权码流）：
 *   1. 用 `POST /v1/auth/login?issue_tokens=true` 换 `mx_at`；
 *   2. 存到 `sessionStorage`（**不落 localStorage**：access token 是短命凭证，
 *      放到持久存储会延长被窃取后的可用窗口）；
 *   3. 把 token 暴露给 `use-sso-idt` 的 http 客户端，让它带 `Authorization: Bearer`。
 *
 * 为什么不走 OAuth 授权码流：那需要 CAS/统一认证对接（后端 `/authorize` 起点），
 * 而当前后端只有「兜底凭据登录」（`dev_init.py` 的演示账号）可用。
 * 等 CAS 接通后，这里换成跳转 `/authorize` 即可，token 存储与暴露机制不变。
 *
 * ⚠️ 安全边界：这是**开发/演示阶段**的登录入口。
 * 生产必须换成 CAS/统一认证，且凭据不能由前端明文持有密码——
 * 本组件把密码送后端校验（不经第三方），但仍是「前端持密码」的模式，
 * 只适合受控环境。已在 UI 上标注演示账号。
 */

import { useCallback, useEffect, useState } from 'react';

/** 存储键。用 sessionStorage 而非 localStorage —— 见文件头说明。 */
const TOKEN_KEY = 'matrixos.hub.mx_at';

/** 默认演示账号（来自 `services/matrix-core/scripts/dev_init.py`）。 */
const DEMO_EMAIL = 'student@matrixos.edu';
const DEMO_PASSWORD = 'StudentPass123!';

interface LoginResult {
  readonly ok: boolean;
  readonly message: string;
  readonly uid?: string;
}

/** 从 sessionStorage 读当前 token（供 `use-sso-idt` 的 http 客户端使用）。 */
export function readHubAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.sessionStorage.getItem(TOKEN_KEY);
    return v !== null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 解析 JWT payload（不发请求、不验签——验签在后端，这里只为显示 uid/exp）。 */
function decodeClaims(token: string): { sub?: string; exp?: number } {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return { sub: typeof json.sub === 'string' ? json.sub : undefined, exp: typeof json.exp === 'number' ? json.exp : undefined };
  } catch {
    return {};
  }
}

export interface HubAuthState {
  readonly token: string | null;
  readonly uid: string | null;
  readonly expiresAt: number | null;
  readonly busy: boolean;
  readonly error: string | null;
  login(email?: string, password?: string): Promise<LoginResult>;
  logout(): void;
}

/**
 * @param apiBase 后端基址。必须与 `use-sso-idt` 的 `defaultApiBase()` 一致，
 *   否则「登录打到 A、签发打到 B」会 401。
 */
export function useHubAuth(apiBase: string): HubAuthState {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 挂载时恢复已有 token（并丢弃已过期的）
  useEffect(() => {
    const saved = readHubAccessToken();
    if (saved === null) return;
    const { exp } = decodeClaims(saved);
    if (typeof exp === 'number' && exp * 1000 <= Date.now()) {
      try {
        window.sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    setToken(saved);
  }, []);

  const login = useCallback(
    async (email = DEMO_EMAIL, password = DEMO_PASSWORD): Promise<LoginResult> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/v1/auth/login?issue_tokens=true`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // credentials 不必 include：login 走 JSON body，不依赖既有 Cookie。
          body: JSON.stringify({
            email,
            password,
            client_id: 'gpa',
            redirect_uri: 'https://gpa.matrixos.edu/auth/callback',
            scope: 'openid profile assets:read assets:write',
          }),
        });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status !== 200) {
          const message =
            typeof json.message === 'string' ? json.message : `登录失败（HTTP ${res.status}）`;
          setError(message);
          return { ok: false, message };
        }
        const tokens = json.tokens as { access_token?: unknown } | undefined;
        const access = tokens?.access_token;
        if (typeof access !== 'string' || access.length === 0) {
          const message = '登录响应里没有 access_token';
          setError(message);
          return { ok: false, message };
        }
        try {
          window.sessionStorage.setItem(TOKEN_KEY, access);
        } catch {
          /* sessionStorage 被禁用时仍放内存 */
        }
        setToken(access);
        const uid = typeof json.matrix_uid === 'string' ? json.matrix_uid : decodeClaims(access).sub ?? '';
        return { ok: true, message: '已登录', ...(uid ? { uid } : {}) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return { ok: false, message };
      } finally {
        setBusy(false);
      }
    },
    [apiBase],
  );

  const logout = useCallback(() => {
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setToken(null);
  }, []);

  const claims = token !== null ? decodeClaims(token) : {};
  return {
    token,
    uid: claims.sub ?? null,
    expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : null,
    busy,
    error,
    login,
    logout,
  };
}

/**
 * 顶部栏里的登录态胶囊。
 *
 * 设计：未登录时是一个按钮（点一下用演示账号登录）；登录后显示 uid 末 6 位 + 到期时间。
 * 刻意做得克制——它不是本轮的重点功能，重点是把「hub 无登录态」这个阻塞打通。
 */
export function HubAuthChip({ apiBase }: { readonly apiBase: string }) {
  const auth = useHubAuth(apiBase);
  const [detail, setDetail] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    if (auth.token !== null) {
      auth.logout();
      return;
    }
    const r = await auth.login();
    setDetail(r.message);
    if (!r.ok) window.setTimeout(() => setDetail(null), 4000);
  }, [auth]);

  if (auth.token !== null) {
    const short = (auth.uid ?? '').slice(-6) || '已登录';
    const exp = auth.expiresAt !== null ? new Date(auth.expiresAt) : null;
    const expText = exp !== null ? `${String(exp.getHours()).padStart(2, '0')}:${String(exp.getMinutes()).padStart(2, '0')}` : '?';
    return (
      <button
        type="button"
        className="hub-stat"
        data-tone="ok"
        onClick={onClick}
        title={`MatrixID 已登录：${auth.uid ?? ''}（到期 ${exp?.toLocaleString() ?? '?'}）。点击退出。`}
      >
        MatrixID <b>{short}</b> · 至 {expText}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="hub-stat"
      data-tone={auth.error !== null ? 'warn' : 'off'}
      onClick={onClick}
      disabled={auth.busy}
      title={
        auth.error !== null
          ? `登录失败：${auth.error}`
          : '未登录。点击用演示账号（student@matrixos.edu）登录 —— hub 需要自己的登录态才能为微站签发 mx_idt。'
      }
    >
      {auth.busy ? 'MatrixID 登录中…' : detail !== null ? `MatrixID ${detail}` : 'MatrixID 未登录'}
    </button>
  );
}
