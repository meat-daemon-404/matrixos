/**
 * MatrixOS SDK · 冻结契约的内嵌镜像
 *
 * 这三份 JSON 是 `specs/contracts/*.schema.json` 的**逐字副本**，供 SDK 在浏览器/
 * 第三方站内做运行时校验（那些环境访问不到仓库的 `specs/` 目录）。
 *
 * ## 防漂移机制
 *
 * `test/contracts.conformance.test.ts` 会直接读取仓库里的冻结契约文件，
 * 与本文件做**深度相等**断言（含键顺序无关的递归比较）。
 * 任何人改了 `specs/contracts/` 而没同步这里，SDK 测试立刻失败——这是**刻意**的，
 * 因为它把「契约漂移」从「线上才发现」提前到「提交前就红」。
 *
 * 唯一合法的不一致：本文件不含注释能力，所以是纯 JSON 结构的等价副本。
 *
 * @see specs/contracts/matrix-app-manifest.schema.json
 * @see specs/contracts/wormhole-envelope.schema.json
 * @see docs/01-plan/01-architecture.md §5.1、§5.4
 */

/** JSON Schema 的松散类型表示：SDK 只消费冻结契约用到的关键字子集。 */
export type JsonSchemaNode = boolean | { readonly [keyword: string]: unknown };

export interface JsonSchemaDocument {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly format?: string;
  readonly examples?: readonly unknown[];
  readonly [keyword: string]: unknown;
}

/**
 * 插槽清单契约（冻结）。
 * `$id: https://matrixos.edu/contracts/matrix-app-manifest.schema.json`
 */
export const MATRIX_APP_MANIFEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://matrixos.edu/contracts/matrix-app-manifest.schema.json',
  title: 'MatrixOS_MicroApp_Manifest',
  description:
    '第三方课题组微站接入 MatrixOS 星轨的标准插槽声明。任何高校实验室只需提供此 manifest，即可在星轨图上生成专属星球胶囊并接入全局虫洞环。',
  type: 'object',
  required: ['manifest_version', 'app_id', 'name', 'entry_url', 'orbit_station', 'accepts', 'emits'],
  additionalProperties: false,
  properties: {
    manifest_version: {
      type: 'string',
      const: '1.0',
      description: '插槽协议版本',
    },
    app_id: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$',
      description: '全局唯一微站标识，用作子域名前缀',
    },
    name: {
      type: 'string',
      maxLength: 40,
      description: '微站中文名称，显示在星轨胶囊上',
    },
    entry_url: {
      type: 'string',
      format: 'uri',
      description: '独立子域名入口，如 https://bioscan.matrixos.edu',
    },
    orbit_station: {
      type: 'string',
      description: '挂载的星轨层级（7 站生涯闭环）',
      enum: ['study', 'spark', 'pat_hot', 'xingmen', 'workshop', 'cloud_balance', 'pre_job'],
    },
    icon: {
      type: 'string',
      description: '胶囊图标，建议 SVG data-uri 或 https URL',
    },
    accent_color: {
      type: 'string',
      pattern: '^#[0-9a-fA-F]{6}$',
      description: '该微站的主强调色，用于星轨星球着色',
    },
    accepts: {
      type: 'array',
      description: '可接收的虫洞 payload_type 列表；空数组表示不接收虫洞投送',
      items: {
        type: 'string',
        enum: [
          'paper_doi_bundle',
          'comparison_matrix_row',
          'curve_fit_parameters',
          'mentor_match_card',
          'verified_cv_evidence',
        ],
      },
    },
    emits: {
      type: 'array',
      description: '可向外投送的虫洞 payload_type 列表；空数组表示纯接收端',
      items: {
        type: 'string',
        enum: [
          'paper_doi_bundle',
          'comparison_matrix_row',
          'curve_fit_parameters',
          'mentor_match_card',
          'verified_cv_evidence',
        ],
      },
    },
    live_mini_view: {
      type: 'object',
      description: '星轨胶囊的实况微缩态数据源。未点开微站时，胶囊上直接显示该数据。可选。',
      properties: {
        endpoint: { type: 'string', format: 'uri' },
        refresh_seconds: { type: 'integer', minimum: 60, maximum: 86400 },
        display_field: { type: 'string' },
      },
      required: ['endpoint'],
    },
    permissions: {
      type: 'array',
      description: '申请的 MatrixID 授权范围',
      items: {
        type: 'string',
        enum: [
          'matrix_id:read',
          'profile:read',
          'assets:read',
          'assets:write',
          'wormhole:send',
          'wormhole:receive',
        ],
      },
    },
    author: {
      type: 'object',
      properties: {
        lab_name: { type: 'string' },
        university: { type: 'string' },
        contact_email: { type: 'string', format: 'email' },
      },
    },
  },
} as const;

/**
 * 虫洞信封契约（冻结）。
 * `$id: https://matrixos.edu/contracts/wormhole-envelope.schema.json`
 */
export const WORMHOLE_ENVELOPE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://matrixos.edu/contracts/wormhole-envelope.schema.json',
  title: 'MatrixOS_v3_Wormhole_Envelope',
  description:
    '跨微站虫洞投送信封。任何微站之间拖拽数据卡片时，必须携带此契约，确保结构化参量与证据锚点零丢失。',
  type: 'object',
  required: ['trace_id', 'matrix_uid', 'source_app', 'target_app', 'payload_type', 'payload'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    trace_id: {
      type: 'string',
      format: 'uuid',
      description: '全链路追踪 ID，一次虫洞投送一个 trace',
    },
    matrix_uid: {
      type: 'string',
      description: '全域唯一 MatrixID 用户标识',
    },
    source_app: {
      type: 'string',
      examples: ['curvelab.matrixos.edu'],
    },
    target_app: {
      type: 'string',
      examples: ['mentor.matrixos.edu'],
    },
    payload_type: {
      type: 'string',
      enum: [
        'paper_doi_bundle',
        'comparison_matrix_row',
        'curve_fit_parameters',
        'mentor_match_card',
        'verified_cv_evidence',
      ],
    },
    payload: {
      type: 'object',
      required: ['data', 'evidence_anchors'],
      additionalProperties: false,
      properties: {
        data: { type: 'object' },
        evidence_anchors: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['source_doi_or_url', 'verification_level'],
            additionalProperties: false,
            properties: {
              source_doi_or_url: { type: 'string' },
              pdf_page: { type: 'integer', minimum: 1 },
              bbox: {
                type: 'array',
                description: 'PDF 原文坐标 [x0, y0, x1, y1]',
                items: { type: 'number' },
                minItems: 4,
                maxItems: 4,
              },
              verification_level: {
                type: 'string',
                enum: ['Level_A_Verified', 'Level_B_Preprint', 'Retracted_Warning'],
              },
            },
          },
        },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

/** 契约文档的检索索引，便于宿主按 `$id` 分发校验。 */
export const FROZEN_SCHEMAS = {
  'matrix-app-manifest': MATRIX_APP_MANIFEST_SCHEMA,
  'wormhole-envelope': WORMHOLE_ENVELOPE_SCHEMA,
} as const;

export type FrozenSchemaName = keyof typeof FROZEN_SCHEMAS;
