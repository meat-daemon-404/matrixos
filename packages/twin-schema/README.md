# @matrixos/twin-schema

> MatrixOS 全息数字孪生的**唯一数据契约出口**。
>
> 18 个官方微站 + N 个第三方站之间流动的每一种结构化数据，都必须先在这里定义一次，
> 然后所有站引用同一份定义——**不允许任何站自己抄一份**。这就是架构公理 A2
> 「单一身份与资产底座」在类型层的落地。

| 项 | 值 |
| :--- | :--- |
| 包名 | `@matrixos/twin-schema` |
| 目录 | `packages/twin-schema/` |
| 运行时依赖 | 仅 `zod` |
| 事实源 | `specs/contracts/*.schema.json`（**已冻结**）+ `docs/01-plan/01-architecture.md` §5/§6 |
| 测试 | 162 个用例，4 个文件 |

## 三条红线（改代码前务必读）

1. **`evidence_anchors` 至少 1 条** —— 虫洞信封与 `asset_node` 同构、同一条 `minItems: 1`。
   每条锚点强制 `source_doi_or_url` + `verification_level`。任何「先投空壳、事后再补证据」
   的路径都必须被这层挡住，**即使只投送一个 `asset_ref` 引用**也不例外。
2. **`asset_chunk.embedding` 恰好 1024 维** —— 换 embedding 模型若维度变了，
   必须新增列做双写过渡，**不许**直接改现有列（ADR-04）。
3. **枚举一律从 `src/enums.ts` 取** —— 这是全包唯一允许写字符串字面量的地方。
   其余模块 `import { X } from './enums.js'`，禁止就地写死。

## 入口

```ts
// 全量入口
import { wormholeEnvelopeSchema, assetNodeSchema, ORBIT_STATION } from '@matrixos/twin-schema';

// 子入口：只带需要的面，不把整个包拽进产物（sideEffects: false）
import { wormholeEnvelopeSchema } from '@matrixos/twin-schema/wormhole';
import { assetNodeSchema } from '@matrixos/twin-schema/asset-graph';
import { ORBIT_STATION } from '@matrixos/twin-schema/enums';
```

只要类型、不要运行时校验时用 `import type`，打包器会把本包整个擦除。

## 类型总览

### 枚举层 · `src/enums.ts`

| 导出 | 用途 |
| :--- | :--- |
| `CONTRACT_SCHEMA_IDS` | 三份冻结契约的 `$id`，供 `$schema` 字段与 CI 契约漂移比对 |
| `MANIFEST_PROTOCOL_VERSION` | 插槽协议版本，唯一合法值 `'1.0'` |
| `PAYLOAD_TYPE` / `payloadTypeSchema` | 虫洞可投送的 **5 类**载荷（封闭枚举，扩展须走 ADR-10） |
| `VERIFICATION_LEVEL` / `verificationLevelSchema` | 证据可信 **3 档**：`Level_A_Verified` / `Level_B_Preprint` / `Retracted_Warning` |
| `ORBIT_STATION` / `orbitStationSchema` | 生涯闭环 **7 站**（轨道层级，**不是**微站 id，见「已知坑」） |
| `MODEL_TIER` / `modelTierSchema` | 模型分级 3 档 `flash` / `pro` / `local` |
| `DISPATCH_STATUS` / `dispatchStatusSchema` | DAG 步骤状态 4 档 |
| `PERMISSION` / `permissionSchema` | 第三方微站可申请的 6 个授权 scope（能力族，与 JWT 窄 scope 不是一套） |
| `ASSET_TYPE` / `assetTypeSchema` | 资产节点 **12 类**（`paper`…`receipt`），见 `enums.ts` 的来源拆解表 |
| `ASSET_RELATION` / `assetRelationSchema` | 图谱边 **5 种**关系 |
| `OFFICIAL_MICROSITE_KEY` | 18 个官方微站 `site_key`，**便捷联合类型而非运行时封闭枚举**（第 19+ 站动态注册） |
| `MICROSITE_KEY_PATTERN` | 微站 key 文法，与 manifest `app_id` 完全同一条正则 |
| `EMBEDDING_DIMENSIONS` | `1024`，与 `asset_chunk.embedding vector(1024)` 列严格对应 |
| `HNSW_INDEX_CONFIG` | `m: 16` / `efConstruction: 64`（ADR-04 明确数值） |
| `PGVECTOR_OPS_CLASS` | pgvector 算子类名，供迁移脚本直接引用 |

### 契约层 · `src/contracts/`

**`primitives.ts`** —— 三份契约共用的原子类型，集中一处避免三处各写一遍导致漂移。

| 导出 | 用途 |
| :--- | :--- |
| `uuidSchema` / `dateTimeSchema` / `uriSchema` / `emailSchema` | 契约里 `format` 的统一写法。`dateTimeSchema` **必须** `offset: true`，否则服务端回 `+08:00` 会被误判非法 |
| `freeObjectSchema` | JSON Schema 的 `{"type":"object"}`，无语义约束且**保留**任意键 |
| `evidenceAnchorSchema` | **合规红线所在**。单条证据锚点：`source_doi_or_url` + `verification_level` 必填，`pdf_page` / `bbox` 可选 |
| `worstVerificationLevel` / `VERIFICATION_SEVERITY` | 多锚点时取**最弱**一条，防止「用一条 A 级锚点洗白一条撤稿锚点」 |

**`wormhole-envelope.ts`** —— 跨微站虫洞投送信封。

| 导出 | 用途 |
| :--- | :--- |
| `WormholeEnvelope` / `wormholeEnvelopeSchema` | 拖拽瞬间在 `postMessage` 里流动的信封。目标是「零文件导入导出，参量与证据零丢失」 |
| `WormholePayload` / `wormholePayloadSchema` | `{ data, evidence_anchors }`。`data` 自由 object；大载荷时退化为 `asset_ref` 引用 |
| `WormholeEnvelopeDraft` | 构造期入参，仅 `trace_id` 可省（由路由层注入） |
| `parseWormholeEnvelope` | 收敛成判别式联合 `{ ok, envelope } \| { ok:false, issues }`。**不吞异常、不补默认值**——失败就是硬失败，把环体变红 |
| `WORMHOLE_ENVELOPE_SCHEMA_ID` | 契约 `$id` |

**`dispatch-contract.ts`** —— 中台调度 Agent 的「一次意图 → 一张 DAG → 每一步状态」。

| 导出 | 用途 |
| :--- | :--- |
| `DispatchContract` / `dispatchContractSchema` | 顶层 `strictObject`（对应 `additionalProperties: false`） |
| `DispatchIntent` / `dispatchIntentSchema` | 意图解析结果。契约**未**封闭 `intent`，故用 `looseObject` 保留扩展键 |
| `DispatchStep` / `dispatchStepSchema` | 单个 DAG 步骤。`step_id` 用 `z.int()`——普通 `z.number()` 会放过 `1.5` |
| `topologicalSortSteps` | 按 `depends_on` 确定性拓扑排序；环依赖或依赖不存在的 `step_id` **抛错**而非静默丢步骤 |
| `DISPATCH_CONTRACT_SCHEMA_ID` | 契约 `$id` |

> ⚠️ 本契约只有**顶层**是 `additionalProperties: false`，`intent` / `workflow[]` / `input_payload`
> 都没有该声明。因此实现刻意不对这几处用 `strictObject`——比契约更严格会把**当前合法**的报文
> 判死，在生产里表现为随机 400。已由测试锁定现状。

**`matrix-app-manifest.ts`** —— 第三方课题组微站接入星轨的标准插槽声明。

| 导出 | 用途 |
| :--- | :--- |
| `MatrixAppManifest` / `matrixAppManifestSchema` | 交一份 manifest 就能生成星球胶囊、接入虫洞环，**不改 MatrixOS 任何代码**（A5 注册表驱动） |
| `MatrixAppManifestDraft` | 仅 `manifest_version` 可省（SDK 代填）。**落库前必须再走一次 `parse()`** |
| `LiveMiniView` / `liveMiniViewSchema` | 星轨胶囊的实况微缩态数据源；`refresh_seconds` 限 60–86400 |
| `ManifestAuthor` / `manifestAuthorSchema` | 课题组信息，三字段全可选 |
| `canRouteWormhole` | W3 规则：目标必须在 `accepts[]` 里声明过，否则 **hub 拒绝路由**（不是警告） |
| `wormholeLinkMatrix` | 星轨画「虫洞环」连线用：单向画实线，双向画双向箭头 |
| `MATRIX_APP_MANIFEST_SCHEMA_ID` | 契约 `$id` |

### 图谱层 · `src/asset-graph/`

`DigitalTwinAssetGraph` —— 全域唯一学术资产事实源。为什么是图而不是宽表：17 号站要回答
「这条简历经历，能追溯到哪篇论文的哪个 PDF 坐标、由哪个拟合结果支撑」，宽表要 join 五次以上
且容易断链，`asset_edge` 让多跳溯源变成一次图遍历。

| 导出 | 用途 |
| :--- | :--- |
| `AssetNode` / `assetNodeSchema` | `asset_node` 主表：一篇论文、一条拟合结果、一版简历……。`station_id` 用**文法校验**而非封闭枚举，官方站与第三方站走同一条路径 |
| `AssetNodeInput` | 写入期入参，主键与时间戳由 `matrix-core` 生成。`verification_level` **不在可省字段里**——避免「默认 A 级」这种静默合规漏洞 |
| `AssetEdge` / `assetEdgeSchema` | `asset_edge`：`derived_from` / `cites` / `evidences` / `supersedes` / `relates_to` |
| `AssetEdgeInput` | 写入期边入参（`edge_id` 由服务端生成） |
| `AssetChunk` / `assetChunkSchema` | `asset_chunk`：向量检索用分片，`embedding` 恰好 1024 维 |
| `AssetChunkInput` | 写入期分片入参 |
| `LocalRef` / `localRefSchema` | **端侧隐私仓指针**。未发表实验原始数据永不出设备（TIER 04 零外泄承诺），服务端只存 `device_id` + `local_key` |

**大载荷工具（架构 §5.4）**

| 导出 | 用途 |
| :--- | :--- |
| `WORMHOLE_INLINE_PAYLOAD_LIMIT_BYTES` | `64 * 1024`。超过即改走引用路径，让虫洞消息体积恒定 |
| `estimatePayloadBytes` | 按 **UTF-8** 计字节。用 `TextEncoder` 而非 `Buffer`——本包同时被浏览器与 Node 引用 |
| `isLargePayload` | `> 64 KB` 判定 |
| `toAssetRef` | 把大载荷改写成 `{ asset_ref, asset_version, summary, result_count? }` 塞进 `payload.data`。**不改契约**：冻结契约里 `payload_type` 是封闭枚举、`payload` 是 `additionalProperties: false`，所以只能往自由的 `data` **里面**放 |
| `isAssetRefPayload` | 识别上述引用形态 |

## 完整示例：一次虫洞投送

场景：学生在 CurveLab 拟合出一条结果，直接拖到 Mentor 站——结构化参量与 PDF 坐标零丢失。
四步走完「投送 → 落库 → 建边 → 向量化」。

```ts
import {
  // 虫洞
  parseWormholeEnvelope,
  canRouteWormhole,
  // 图谱
  assetNodeSchema,
  assetEdgeSchema,
  // 大载荷
  isLargePayload,
  toAssetRef,
  // 枚举
  type WormholeEnvelope,
  type PayloadType,
} from '@matrixos/twin-schema';

// ── 第 0 步：投送前先问 hub「这条路通不通」（W3 规则，拒绝而非警告）──────
// 注意数组要标成 `PayloadType[]`：`canRouteWormhole` 的入参是
// `Pick<MatrixAppManifest, 'accepts'>`，其数组是可变且元素为封闭枚举的
// `PayloadType[]`。写 `as const` 会因 readonly 而编译失败；不标注则被推成
// `string[]`，同样不匹配。真实 manifest 由 `matrixAppManifestSchema.parse()`
// 产出，本来就已收窄到 `PayloadType[]`。
const mentorManifest: { accepts: PayloadType[]; emits: PayloadType[] } = {
  accepts: ['paper_doi_bundle', 'curve_fit_parameters'],
  emits: ['mentor_match_card'],
};
const curvelabManifest: { accepts: PayloadType[]; emits: PayloadType[] } = {
  accepts: ['comparison_matrix_row'],
  emits: ['curve_fit_parameters'],
};

if (!canRouteWormhole(mentorManifest, 'curve_fit_parameters', curvelabManifest)) {
  throw new Error('Mentor 未声明接收 curve_fit_parameters，hub 必须拒绝路由');
}

// ── 第 1 步：构造并校验虫洞信封 ─────────────────────────────────────
const envelope: WormholeEnvelope = {
  $schema: 'https://matrixos.edu/contracts/wormhole-envelope.schema.json',
  trace_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  matrix_uid: 'mx_01H8Z9K2QW',
  source_app: 'curvelab.matrixos.edu',
  target_app: 'mentor.matrixos.edu',
  payload_type: 'curve_fit_parameters',
  payload: {
    data: { tau_fast: 0.42, tau_slow: 3.1, r_squared: 0.987, model: 'biexponential' },
    // 🔴 红线：至少 1 条，且每条都要有来源 + 等级
    evidence_anchors: [
      {
        source_doi_or_url: '10.1021/jacs.4c0112',
        pdf_page: 7,
        bbox: [72.5, 144.0, 300.25, 210.75],
        verification_level: 'Level_A_Verified',
      },
    ],
  },
  created_at: '2026-10-20T11:54:10+08:00', // +08:00 偏移必须被接受
};

const parsed = parseWormholeEnvelope(envelope);
if (!parsed.ok) {
  // 不修补、不兜底：把环体变红即可
  throw new Error(`虫洞信封非法：\n${parsed.issues.join('\n')}`);
}

// ── 第 2 步：落库成资产节点（station_id 是**微站 key**，不是 7 站轨道名）──
const node = assetNodeSchema.parse({
  asset_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  matrix_uid: 'mx_01H8Z9K2QW',
  station_id: 'curvelab',          // ← 微站 key；写成 'workshop' 是语义错误
  asset_type: 'fit_result',
  title: 'CsPbBr3 TRPL 双指数拟合',
  payload: { tau_fast: 0.42, tau_slow: 3.1, r_squared: 0.987 },
  evidence_anchors: envelope.payload.evidence_anchors,
  verification_level: 'Level_A_Verified',
  trace_id: envelope.trace_id,
  version: 1,
  created_at: '2026-10-20T11:54:10Z',
  updated_at: '2026-10-20T11:54:10Z',
  // 原始散点永不出设备，只留指针（架构 §6.4）
  local_ref: { device_id: 'dev-abc', local_key: 'trpl-raw-001' },
});

// ── 第 3 步：建边，让 17 号站能多跳溯源 ──────────────────────────────
const edge = assetEdgeSchema.parse({
  edge_id: '11111111-2222-4333-8444-555555555555',
  from_asset_id: node.asset_id,     // fit_result
  to_asset_id: '22222222-3333-4444-8555-666666666666', // cv_entry
  relation: 'evidences',            // 这条拟合结果为那条简历经历提供证据
  weight: 0.8,
});

// ── 第 4 步：载荷过大时不硬塞，改用引用形态 ───────────────────────────
if (isLargePayload({ rows: /* 30 篇文献全量元数据 */ [] })) {
  const ref = toAssetRef({
    assetRef: node.asset_id,
    assetVersion: node.version,
    summary: '30 篇钙钛矿钝化文献元数据 + 坐标锚点',
    resultCount: 30,
  });
  // ref → { asset_ref, asset_version, summary, result_count }
  // 塞进 payload.data 后信封依然合法：证据仍当场携带，红线不因载荷变大而失效。
}
```

## 已知坑

### 1. `station_id` 与 `orbit_station` 是两套定义域，且在字符串层重叠

同名概念在两处含义完全不同：

- `asset_node.station_id` = **微站 key**（`'curvelab'`、`'evidence-cv'`），走
  `MICROSITE_KEY_PATTERN` 文法；
- `orbit_station` / `ORBIT_STATION` = **7 站生涯闭环**（`'study'`、`'pat_hot'`…），封闭枚举。

7 个轨道名里，只有含下划线的 3 个会被微站文法挡下（正则不含下划线）：
`pat_hot`、`cloud_balance`、`pre_job`。剩下 4 个与微站 key **完全同形**：
`study`、`spark`、`xingmen`、`workshop`。

其中 `spark` 是**真实重名**——它既是 7 站之一，也是 18 个官方微站之一
（`apps/micro-sites/02-spark-teaming/` 的 manifest 里 `app_id` 与 `orbit_station` 都是 `"spark"`）。
于是 `station_id: 'spark'` 两套定义域都接受，类型系统和正则都无从区分。这不是实现缺陷，
而是两份冻结契约的定义域本身重叠，**只能靠文档约定 + code review 兜底**。
已由 `test/asset-graph.test.ts` 的两个用例锁定这两条事实。

### 2. `app_id` 最短是 3 个字符，不是 2 个

契约正则是 `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`：首字符 1 + 中间 `{1,30}` + 尾字符 1，
所以总长度 **3..32**。`'ab'` 会被拒，`'abc'` 合法。容易误以为下界是 2。

顺带：正则是 `{1,30}` 而不是 `{0,30}`——**两字符的 key 不存在**，这不是笔误。

### 3. `dateTimeSchema` 必须 `offset: true`

本项目服务器全在 `Asia/Shanghai`。zod 默认配置只认 `Z` 结尾，服务端一旦回
`2026-10-20T11:54:10+08:00` 就会被判非法——这是最容易踩的一个坑。

### 4. 契约没有 `additionalProperties: false` 的地方，不要擅自加严格

`dispatch-contract` 的 `intent` / `workflow[]` / `input_payload`，以及
`matrix-app-manifest` 的 `live_mini_view` / `author`，契约都**没有**封闭。
比契约更严格 = 把当前合法报文判死，比放宽更危险（生产里表现为随机 400）。

### 5. `Retracted_Warning` 不许降级为静默通过

命中撤稿/勘误库的锚点必须在 UI 上可见。多条锚点时用 `worstVerificationLevel()`
取最弱一条作为节点整体等级。

## 开发

```bash
pnpm --filter @matrixos/twin-schema test        # 162 个用例
pnpm --filter @matrixos/twin-schema typecheck   # tsc --noEmit
```

`test/fixtures.ts` 集中放合法样本工厂，避免每个测试文件各写一份——那样契约一加字段
就要改 5 个文件，改漏一个就静默失去覆盖。

> ⚠️ `levelAAnchor()` 的 `verification_level` 用**显式联合类型**
> `VerificationLevel` 标注，**不要**改回 `as const`：`as const` 会把返回类型收窄成
> 单一字面量，导致测试里给锚点赋其他等级时编译失败。

## 不改冻结契约

`specs/contracts/*.schema.json` **已冻结，不得修改**。需要新增字段或枚举值时：

1. 走 ADR-10 版本化流程，发布 `wormhole-envelope.v2.schema.json`；
2. 在 `src/enums.ts` 更新唯一事实源；
3. 补 `test/` 对应用例；
4. **不要**在 zod 层偷偷放宽或收紧——那会让契约与实现静默分叉。
