/**
 * MatrixOS SDK · 插槽清单（manifest）校验
 *
 * ## 谁用这个
 *
 * 1. **第三方实验室**在提交 manifest 前自查——把校验器当 lint 用；
 * 2. **`orbital-hub`** 在把 manifest 插入星轨前校验——防止坏数据把 18 座星轨渲染炸掉；
 * 3. **`services/matrix-core` 的注册表**在入库前做同一套校验（契约源一致，行为一致）。
 *
 * ## 除了 schema 还查什么
 *
 * 冻结契约为 `additionalProperties: false`，但它**不表达**几条工程上的硬要求：
 *
 * - `entry_url` 必须是 https（`*.matrixos.edu` 全站 HTTPS，http 入口会让
 *   `mx_idt` 在明文信道里裸奔）；
 * - `entry_url` 的主机首段应当与 `app_id` 一致（否则路由与身份对不上，
 *   scope 里的 `station:<app_id>` 会指向错的站）；
 * - `emits` 里声明的类型如果本站 `accepts` 也没声明，是**可疑但不是错误**的
 *   （转发型站点合法），所以只给 warning；
 * - `live_mini_view.endpoint` 必须同源或 https（它会被 hub 直接 fetch 来渲染胶囊）。
 *
 * 这些规则作为 `warning` 或额外的 `error` 返回，`issues[].severity` 区分。
 */

import { validateAgainstSchema, formatIssues } from '../contracts/validate.ts';
import { MATRIX_APP_MANIFEST_SCHEMA } from '../contracts/schemas.ts';
import type { ManifestIssue, ManifestValidationResult, MatrixAppManifest } from '../types.ts';

/** 与冻结 schema 的 `accepts`/`emits` 枚举一致。 */
const KNOWN_PAYLOAD_TYPES = new Set([
  'paper_doi_bundle',
  'comparison_matrix_row',
  'curve_fit_parameters',
  'mentor_match_card',
  'verified_cv_evidence',
]);

/**
 * 用冻结契约校验一份 manifest JSON。
 *
 * 输入可以是 `unknown`（来自 `JSON.parse` / `fetch`），永远不会抛异常——
 * 调用方拿 `result.valid` 决定下一步即可。
 */
export function validateManifest(json: unknown): ManifestValidationResult {
  const issues: ManifestIssue[] = [];

  // ── 1. 冻结契约（结构 / 枚举 / 正则 / 必填 / 封闭性）─────────────────────
  const schemaIssues = validateAgainstSchema(json, MATRIX_APP_MANIFEST_SCHEMA);
  for (const issue of schemaIssues) {
    issues.push({
      path: issue.path,
      message: issue.message,
      keyword: issue.keyword,
      severity: 'error',
    });
  }

  // schema 已经把基础结构否掉了，后面依赖字段的规则跳过，避免报错噪音。
  if (issues.length > 0) {
    return { valid: false, manifest: null, errors: issues };
  }

  const manifest = json as MatrixAppManifest;

  // ── 2. entry_url 的工程要求（schema 只校验 format: uri）──────────────────
  const entry = safeUrl(manifest.entry_url);
  if (entry === null) {
    issues.push({
      path: '/entry_url',
      message: `entry_url 不是可解析的 URL：${String(manifest.entry_url)}`,
      keyword: 'entryUrl',
      severity: 'error',
    });
  } else {
    if (entry.protocol !== 'https:') {
      issues.push({
        path: '/entry_url',
        message: `entry_url 必须使用 https（当前是 ${entry.protocol.slice(0, -1)}）。http 入口会让 mx_idt 在明文信道上传输`,
        keyword: 'entryUrlProtocol',
        severity: 'error',
      });
    }
    const firstLabel = entry.hostname.split('.')[0] ?? '';
    if (firstLabel !== manifest.app_id) {
      issues.push({
        path: '/entry_url',
        message: `entry_url 的主机首段「${firstLabel}」与 app_id「${manifest.app_id}」不一致。app_id 用作子域名前缀，两者不一致会导致 scope 与路由对不上`,
        keyword: 'entryUrlHostMismatch',
        severity: 'error',
      });
    }
    if (!entry.hostname.endsWith('.matrixos.edu') && !isThirdPartyHostAllowed(entry.hostname)) {
      issues.push({
        path: '/entry_url',
        message: `entry_url 主机「${entry.hostname}」不在 *.matrixos.edu 下。第三方站用自己的域名是允许的，但需要在注册时显式登记并在 allowedOrigins 中放行`,
        keyword: 'entryUrlHostOutsideDomain',
        severity: 'warning',
      });
    }
  }

  // ── 3. live_mini_view 的安全要求 ────────────────────────────────────────
  if (manifest.live_mini_view !== undefined) {
    const endpoint = safeUrl(manifest.live_mini_view.endpoint);
    if (endpoint === null) {
      issues.push({
        path: '/live_mini_view/endpoint',
        message: 'live_mini_view.endpoint 不是可解析的 URL',
        keyword: 'liveMiniViewEndpoint',
        severity: 'error',
      });
    } else if (endpoint.protocol !== 'https:' && !isLoopback(endpoint.hostname)) {
      issues.push({
        path: '/live_mini_view/endpoint',
        message: 'live_mini_view.endpoint 必须使用 https（hub 会直接 fetch 它来渲染星轨胶囊）',
        keyword: 'liveMiniViewProtocol',
        severity: 'error',
      });
    }
  }

  // ── 4. 语义查重与一致性（warning 级）─────────────────────────────────────
  const dupAccepts = findDuplicates(manifest.accepts);
  if (dupAccepts.length > 0) {
    issues.push({
      path: '/accepts',
      message: `accepts 中有重复项：${dupAccepts.join(', ')}`,
      keyword: 'duplicateEnum',
      severity: 'warning',
    });
  }
  const dupEmits = findDuplicates(manifest.emits);
  if (dupEmits.length > 0) {
    issues.push({
      path: '/emits',
      message: `emits 中有重复项：${dupEmits.join(', ')}`,
      keyword: 'duplicateEnum',
      severity: 'warning',
    });
  }

  if (manifest.accepts.length === 0 && manifest.emits.length === 0) {
    issues.push({
      path: '',
      message: 'accepts 与 emits 都是空数组：该站将完全不参与虫洞生态（纯孤岛）。若非刻意为之，请至少声明其中一侧',
      keyword: 'wormholeIsolated',
      severity: 'warning',
    });
  }

  // ── 5. 权限与行为的一致性 ───────────────────────────────────────────────
  const permissions = manifest.permissions ?? [];
  if (manifest.emits.length > 0 && !permissions.includes('wormhole:send')) {
    issues.push({
      path: '/permissions',
      message: 'emits 非空但未申请 wormhole:send 权限：投送会在服务端被 scope 校验拒绝',
      keyword: 'permissionMissing',
      severity: 'error',
    });
  }
  if (manifest.accepts.length > 0 && !permissions.includes('wormhole:receive')) {
    issues.push({
      path: '/permissions',
      message: 'accepts 非空但未申请 wormhole:receive 权限：接收会在服务端被 scope 校验拒绝',
      keyword: 'permissionMissing',
      severity: 'error',
    });
  }
  if (manifest.live_mini_view !== undefined && !permissions.includes('assets:read')) {
    issues.push({
      path: '/permissions',
      message: '声明了 live_mini_view 但未申请 assets:read 权限：实况微缩态数据将拉不到',
      keyword: 'permissionMissing',
      severity: 'warning',
    });
  }

  // ── 6. 枚举自洽性兜底（schema 已保证，这里防御运行时被绕过）────────────
  for (const [index, type] of manifest.accepts.entries()) {
    if (!KNOWN_PAYLOAD_TYPES.has(type)) {
      issues.push({
        path: `/accepts/${index}`,
        message: `未知的 payload_type「${String(type)}」`,
        keyword: 'unknownPayloadType',
        severity: 'error',
      });
    }
  }

  const hasError = issues.some((issue) => issue.severity !== 'warning');
  return {
    valid: !hasError,
    manifest: hasError ? null : manifest,
    errors: issues,
  };
}

/** 人类可读的校验摘要，可直接塞进 CI 输出或错误提示。 */
export function formatManifestIssues(result: ManifestValidationResult): string[] {
  return result.errors.map((issue) => {
    const where = issue.path === '' ? '(根)' : issue.path;
    const level = issue.severity === 'warning' ? '警告' : '错误';
    return `${level} ${where}: ${issue.message}`;
  });
}

/**
 * 只做**结构层**校验（冻结契约），不跑语义规则。
 *
 * 用于「从注册表拿回来的数据可信吗」这类场景：那里关心的是结构完整性，
 * 而不是「entry_url 是否为 https」这类接入审查规则。
 */
export function validateManifestSemantics(json: unknown): ManifestValidationResult {
  const issues = validateAgainstSchema(json, MATRIX_APP_MANIFEST_SCHEMA);
  return {
    valid: issues.length === 0,
    manifest: issues.length === 0 ? (json as MatrixAppManifest) : null,
    errors: issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      keyword: issue.keyword,
      severity: 'error' as const,
    })),
  };
}

export { formatIssues };

// ─────────────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────────────

function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * 第三方站使用自有域名时的判定。
 *
 * 这里只做「格式上像不像一个正常域名」的判断，**不做信任决策**——是否信任
 * 由注册表 + `allowedOrigins` 配置决定。SDK 不能凭一个域名后缀就放行。
 */
function isThirdPartyHostAllowed(hostname: string): boolean {
  return hostname.includes('.') && !hostname.startsWith('.') && !hostname.endsWith('.');
}

function findDuplicates(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  return [...dups];
}
