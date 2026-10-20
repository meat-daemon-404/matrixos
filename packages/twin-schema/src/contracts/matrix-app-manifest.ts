/**
 * `MatrixAppManifest` —— 第三方课题组微站接入星轨的标准插槽声明（契约已冻结）
 *
 * 唯一事实源：`specs/contracts/matrix-app-manifest.schema.json`（**不得修改该文件**）。
 *
 * ## 这个类型解决什么问题
 *
 * 任何高校实验室只要交一份 manifest，就能在星轨图上生成专属星球胶囊、
 * 接入全局虫洞环——**不需要改 MatrixOS 任何代码**（架构公理 A5：注册表驱动挂载）。
 *
 * ## 字段级要点
 *
 * | 字段 | 约束 | 落地方式 |
 * | :--- | :--- | :--- |
 * | `manifest_version` | `const: "1.0"` | `z.literal('1.0')`，不是普通 string |
 * | `app_id` | `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` | 复用 `MICROSITE_KEY_PATTERN`，与官方站共用文法 |
 * | `name` | `maxLength: 40` | 中文按 code unit 计数，与 JSON Schema 语义一致 |
 * | `entry_url` | `format: uri` | `z.url()`（URI 而非 HTTP URL） |
 * | `accent_color` | `^#[0-9a-fA-F]{6}$` | 只认 6 位，3 位简写与 8 位带 alpha 一律拒绝 |
 * | `accepts` / `emits` | 必填数组，**可为空** | 空数组 = 不接收 / 纯接收端，语义已在契约描述里写明 |
 * | `live_mini_view` | 内部 `required: [endpoint]` | 用 `z.strictObject`？**不**——见下 |
 * | `permissions` | 6 个封闭 scope | 与 JWT 的 `station:<key>:<verb>` **不是**同一套粒度 |
 *
 * ## ⚠️ `additionalProperties` 只写在顶层
 *
 * 契约的 `live_mini_view` 与 `author` **没有**声明 `additionalProperties: false`，
 * 所以这里用 `z.looseObject` 保留扩展键。只有顶层是 `z.strictObject`。
 * 理由与 dispatch 契约相同：比契约更严格 = 把当前合法报文判死。
 */

import { z } from 'zod';

import {
  CONTRACT_SCHEMA_IDS,
  MANIFEST_PROTOCOL_VERSION,
  MICROSITE_KEY_PATTERN,
  orbitStationSchema,
  payloadTypeSchema,
  permissionSchema,
} from '../enums.js';
import { emailSchema, uriSchema } from './primitives.js';

/**
 * 星轨胶囊的实况微缩态数据源。未点开微站时，胶囊上直接显示该数据。
 *
 * `refresh_seconds` 限 60–86400：低于 60 秒会把 18 个胶囊变成一台压测机；
 * 高于 1 天则「实况」名不副实。
 */
export const liveMiniViewSchema = z.looseObject({
  /** 微缩数据接口。 */
  endpoint: uriSchema,
  /** 刷新间隔（秒），60–86400。 */
  refresh_seconds: z.int().min(60).max(86400).optional(),
  /** 胶囊上展示的字段名。 */
  display_field: z.string().optional(),
});

/** 微站作者/课题组信息。契约未加 `required`，三个字段全可选。 */
export const manifestAuthorSchema = z.looseObject({
  lab_name: z.string().optional(),
  university: z.string().optional(),
  contact_email: emailSchema.optional(),
});

/**
 * 微站插槽清单本体。
 *
 * 顶层 `additionalProperties: false` → `z.strictObject`。
 */
export const matrixAppManifestSchema = z.strictObject({
  /** 插槽协议版本。当前唯一合法值 `"1.0"`。 */
  manifest_version: z.literal(MANIFEST_PROTOCOL_VERSION),
  /** 全局唯一微站标识，用作子域名前缀。文法与官方 18 站相同。 */
  app_id: z.string().regex(MICROSITE_KEY_PATTERN, 'app_id 必须匹配 ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  /** 微站中文名称，显示在星轨胶囊上（≤40）。 */
  name: z.string().min(1).max(40),
  /** 独立子域名入口，如 `https://bioscan.matrixos.edu`。 */
  entry_url: uriSchema,
  /** 挂载的星轨层级（7 站生涯闭环）。 */
  orbit_station: orbitStationSchema,
  /** 胶囊图标，建议 SVG data-uri 或 https URL。 */
  icon: z.string().optional(),
  /** 该微站的主强调色，用于星轨星球着色（`#RRGGBB`）。 */
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accent_color 必须是 #RRGGBB').optional(),
  /** 可接收的虫洞 payload_type；空数组表示不接收投送。 */
  accepts: z.array(payloadTypeSchema),
  /** 可向外投送的 payload_type；空数组表示纯接收端。 */
  emits: z.array(payloadTypeSchema),
  live_mini_view: liveMiniViewSchema.optional(),
  permissions: z.array(permissionSchema).optional(),
  author: manifestAuthorSchema.optional(),
});

/** 微站插槽清单。 */
export type MatrixAppManifest = z.infer<typeof matrixAppManifestSchema>;
export type LiveMiniView = z.infer<typeof liveMiniViewSchema>;
export type ManifestAuthor = z.infer<typeof manifestAuthorSchema>;

/** 契约 `$id`。 */
export const MATRIX_APP_MANIFEST_SCHEMA_ID = CONTRACT_SCHEMA_IDS.matrixAppManifest;

/**
 * 构造期入参：`manifest_version` 可由 SDK 补齐为 `"1.0"`。
 *
 * 仅供「SDK 代填版本号」这一条路径使用；注册表落库前**必须**再走一次
 * `matrixAppManifestSchema.parse()`，不允许把 draft 直接写入注册表。
 */
export type MatrixAppManifestDraft = Omit<MatrixAppManifest, 'manifest_version'> & {
  manifest_version?: typeof MANIFEST_PROTOCOL_VERSION;
};

/**
 * 判断 `source` 站能否把 `payloadType` 投递给 `target`（架构 §5.3 的 W3 规则）。
 *
 * W3「只投给声明过的目标」：目标站必须在自身 manifest 的 `accepts[]` 里
 * 声明可接收该 payload_type，否则 hub 必须拒绝路由——**不是**警告，是拒绝。
 *
 * `source` 为 `undefined` 时只校验目标侧（用于「目标站是否接收此类载荷」的快速判断）。
 *
 * @example
 * canRouteWormhole(manifest, 'paper_doi_bundle');  // 只看目标是否 accepts
 * canRouteWormhole(target, 'paper_doi_bundle', source); // 同时看源站是否 emits
 */
export function canRouteWormhole(
  target: Pick<MatrixAppManifest, 'accepts'>,
  payloadType: MatrixAppManifest['accepts'][number],
  source?: Pick<MatrixAppManifest, 'emits'>,
): boolean {
  if (!target.accepts.includes(payloadType)) return false;
  if (source && !source.emits.includes(payloadType)) return false;
  return true;
}

/**
 * 检测两个 manifest 之间的**双向**兼容性（A→B 与 B→A 是否都通）。
 *
 * 星轨在图谱上画「虫洞环」连线时用：单向可达画实线，双向可达画双向箭头。
 */
export function wormholeLinkMatrix(manifests: readonly MatrixAppManifest[]): {
  readonly from: string;
  readonly to: string;
  readonly payloadTypes: readonly string[];
}[] {
  const links: { from: string; to: string; payloadTypes: string[] }[] = [];
  for (const from of manifests) {
    for (const to of manifests) {
      if (from.app_id === to.app_id) continue;
      const shared = from.emits.filter((type) => to.accepts.includes(type));
      if (shared.length > 0) {
        links.push({ from: from.app_id, to: to.app_id, payloadTypes: shared });
      }
    }
  }
  return links;
}
