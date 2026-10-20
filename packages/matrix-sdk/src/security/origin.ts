/**
 * MatrixOS SDK · 跨源 origin 白名单
 *
 * ## 为什么这个文件必须存在
 *
 * `postMessage` 的 `event.origin` **是发送方声明的，不是认证的**。
 * 如果 SDK 不校验它，任何恶意页面都能：
 *   1. 用 `postMessage` 给 iframe 里的微站塞一个伪造的 `mx_idt`，
 *      或者直接塞一条伪造的 `WormholeEnvelope`，让目标站把假数据写进自己的台账；
 *   2. 反过来，如果微站向外 `postMessage` 时不指定 `targetOrigin`（写成 `'*'`），
 *      `mx_idt` 与虫洞 payload 就会泄露给任意嵌入者。
 *
 * 所以 SDK 的规则是两条硬约束，任何一处放宽都要有 ADR：
 *   - **收**：`event.origin` 必须命中白名单，否则丢弃且**不回复**（不回复同样重要——
 *     回复等于向攻击者确认「这里有个活的微站」）。
 *   - **发**：`targetOrigin` 必须是具体 origin，**绝不允许 `'*'`**。
 *
 * ## 白名单语法
 *
 * 支持三种条目，覆盖官方站与第三方站两种场景：
 *   - `'*.matrixos.edu'`   —— 通配子域，**只匹配一级或多级子域**，不匹配 apex 本身
 *   - `'matrixos.edu'`     —— 精确主机
 *   - `'https://lab.example.edu:8080'` —— 完整 origin（含协议端口）
 *
 * 通配符**必须**写成 `*.` 前缀形式，避免有人写出 `'*matrixos.edu'` 这种能匹配
 * `evil-matrixos.edu` 的危险模式。见 `compileOriginPattern` 的注释。
 */

/** 协议 + 主机 + 端口的完整 origin。 */
export interface ParsedOrigin {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
}

/** 解析一个 origin 字符串。非法时返回 null（调用方应按「拒绝」处理，不是「放行」）。 */
export function parseOrigin(value: string): ParsedOrigin | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.origin === 'null') return null;
    return {
      protocol: url.protocol,
      hostname: url.hostname.toLowerCase(),
      port: url.port,
    };
  } catch {
    return null;
  }
}

type CompiledPattern =
  | { readonly kind: 'exact-origin'; readonly protocol: string; readonly hostname: string; readonly port: string }
  | { readonly kind: 'host-suffix'; readonly suffix: string; readonly allowApex: boolean; readonly protocols: readonly string[] | null }
  | { readonly kind: 'host-exact'; readonly hostname: string; readonly protocols: readonly string[] | null };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * 把白名单条目编译成可判定结构。
 *
 * 关于 `*.matrixos.edu` 的语义：它匹配 `curvelab.matrixos.edu`、`a.b.matrixos.edu`，
 * **不**匹配 `matrixos.edu` 本身（apex）。需要 apex 时显式写 `matrixos.edu`。
 * 这是刻意选择——apex 通常只是营销页，不该因为它被列上就让整个后缀放行。
 */
function compileOriginPattern(pattern: string): CompiledPattern | null {
  const trimmed = pattern.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  // ── 通配子域：`*.matrixos.edu` ────────────────────────────────────────────
  if (trimmed.startsWith('*.')) {
    const suffix = trimmed.slice(2);
    if (suffix.length === 0) return null;
    // 拒绝 `*.edu` 这类过宽条目：后缀至少要有一个点（即 `.matrixos.edu`）。
    if (!suffix.includes('.')) return null;
    // 拒绝 `*.matrixos.edu/path` 这种把路径写进白名单的用法（origin 不含路径）。
    if (suffix.includes('/')) return null;
    return { kind: 'host-suffix', suffix, allowApex: false, protocols: null };
  }

  // ── 带协议的完整 origin：`https://lab.example.edu:8080` ───────────────────
  if (trimmed.includes('://')) {
    const parsed = parseOrigin(trimmed);
    if (parsed === null) return null;
    return {
      kind: 'exact-origin',
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
    };
  }

  // ── 裸主机名：`matrixos.edu` ──────────────────────────────────────────────
  if (trimmed.includes('/') || trimmed.includes(':')) return null;
  return { kind: 'host-exact', hostname: trimmed, protocols: null };
}

function matchHostSuffix(hostname: string, suffix: string, allowApex: boolean): boolean {
  if (hostname === suffix) return allowApex;
  // 必须严格以 `.suffix` 结尾，防止 `evil-matrixos.edu` 命中 `matrixos.edu`。
  return hostname.endsWith(`.${suffix}`);
}

/** 编译后的白名单。实例不可变，可安全跨请求复用。 */
export class OriginAllowList {
  readonly #patterns: readonly string[];
  readonly #compiled: readonly CompiledPattern[];
  /**
   * 是否放行 loopback（`localhost` / `127.0.0.1`）。
   * 默认**只在非生产构建下放行**——本地开发时 hub 在 localhost:3000、
   * 微站在 localhost:3011，两者是不同源，不放行就没法本地联调 iframe。
   */
  readonly #allowLoopback: boolean;

  constructor(patterns: readonly string[], options: { readonly allowLoopback?: boolean } = {}) {
    this.#patterns = [...patterns];
    this.#compiled = patterns
      .map(compileOriginPattern)
      .filter((p): p is CompiledPattern => p !== null);
    this.#allowLoopback = options.allowLoopback ?? defaultLoopbackPolicy();
  }

  /** 原始白名单条目（用于错误提示与调试输出）。 */
  get patterns(): readonly string[] {
    return this.#patterns;
  }

  /** 是否有任何有效条目。全为空时必须明确拒绝一切，而不是「没有规则所以放行」。 */
  get isEmpty(): boolean {
    return this.#compiled.length === 0 && !this.#allowLoopback;
  }

  /**
   * 判定一个 origin 是否可信。
   *
   * 注意：非法 origin（空串、无法解析）**一律返回 false**。
   * 这不是保守过度——「解析失败就放行」是跨源消息校验里最经典的一类漏洞。
   */
  allows(origin: string): boolean {
    const parsed = parseOrigin(origin);
    if (parsed === null) return false;
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;

    if (this.#allowLoopback && LOOPBACK_HOSTS.has(parsed.hostname)) {
      return true;
    }

    for (const pattern of this.#compiled) {
      switch (pattern.kind) {
        case 'exact-origin':
          if (
            parsed.protocol === pattern.protocol &&
            parsed.hostname === pattern.hostname &&
            normalizePort(parsed.port, parsed.protocol) === normalizePort(pattern.port, pattern.protocol)
          ) {
            return true;
          }
          break;
        case 'host-suffix':
          if (matchHostSuffix(parsed.hostname, pattern.suffix, pattern.allowApex)) return true;
          break;
        case 'host-exact':
          if (parsed.hostname === pattern.hostname) return true;
          break;
      }
    }
    return false;
  }

  /** 加一个新条目，返回新实例（不可变，便于「每个 SDK 实例自己的白名单」）。 */
  with(pattern: string): OriginAllowList {
    if (this.#patterns.includes(pattern)) return this;
    return new OriginAllowList([...this.#patterns, pattern], { allowLoopback: this.#allowLoopback });
  }
}

/** `https:` 的默认端口是 443，`http:` 是 80；`URL.port` 为空时要归一化后再比。 */
function normalizePort(port: string, protocol: string): string {
  if (port !== '') return port;
  return protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '';
}

/**
 * 默认 loopback 策略。
 *
 * `process.env.NODE_ENV` 在浏览器里通常被构建工具替换成字面量，
 * 这里做防御式读取：拿不到环境信息时**按生产处理**（即不放行 loopback）。
 */
function defaultLoopbackPolicy(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const nodeEnv = env?.NODE_ENV;
    if (nodeEnv === undefined) return false;
    return nodeEnv !== 'production';
  } catch {
    return false;
  }
}

/**
 * 官方站的默认白名单。
 *
 * `*.matrixos.edu` 覆盖 18 个微站 + hub + api；apex 单独列出供营销站/文档站使用。
 * **第三方实验室站自己的域必须由接入方显式配置**——SDK 不会自动信任任意 `.edu` 域。
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ['*.matrixos.edu', 'matrixos.edu', 'https://orbital.matrixos.edu'];

/** 把 `AppKey` 归一化成裸 key。`'curvelab.matrixos.edu'` → `'curvelab'`。 */
export function normalizeAppKey(app: string): string {
  const trimmed = app.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  // 去掉协议与路径，只保留主机。
  const withoutScheme = trimmed.includes('://') ? (parseOrigin(trimmed)?.hostname ?? trimmed) : trimmed;
  const host = withoutScheme.split('/')[0] ?? withoutScheme;
  const firstLabel = host.split('.')[0] ?? host;
  return firstLabel;
}

/** 把 `AppKey` 归一化成主机名。`'curvelab'` → `'curvelab.matrixos.edu'`。 */
export function toAppHost(app: string, baseDomain = 'matrixos.edu'): string {
  const trimmed = app.trim().toLowerCase();
  if (trimmed.length === 0) return baseDomain;
  const hostOnly = trimmed.includes('://') ? (parseOrigin(trimmed)?.hostname ?? trimmed) : trimmed.split('/')[0] ?? trimmed;
  return hostOnly.includes('.') ? hostOnly : `${hostOnly}.${baseDomain}`;
}

/** 两个 AppKey 是否指向同一个站（容忍 `curvelab` 与 `curvelab.matrixos.edu` 混用）。 */
export function isSameApp(a: string, b: string): boolean {
  return normalizeAppKey(a) === normalizeAppKey(b);
}
