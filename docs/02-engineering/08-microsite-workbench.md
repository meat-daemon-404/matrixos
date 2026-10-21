# 微站完工规范（S3 功能完备化）

> 适用对象：`apps/micro-sites/01-…` ～ `18-…` 全部 18 个微站。
> 本文是「什么叫完工」的唯一口径，也是 `scripts/microsite-verify.mjs` 验收断言的文字版。
> 相关：[S3-E2 验收模板](../01-plan/03-work-breakdown.md) · [虫洞信封契约](../../specs/contracts/wormhole-envelope.schema.json) · [微站清单 manifest 契约](../../specs/contracts/matrix-app-manifest.schema.json)

## 1. 完工层的分层结构

18 个微站的结构完全同构，所以「完工层」被拆成**一份共享实现 + 每站一份业务数据**：

| 层 | 位置 | 谁维护 | 说明 |
| :--- | :--- | :--- | :--- |
| 台账引擎 | `apps/micro-sites/shared/src/ledger.ts` | 共享 | 版本化 localStorage 信封、迁移、导出（JSON/CSV，带 BOM）、虫洞信封构造 |
| 业务规格工厂 | `apps/micro-sites/shared/src/ui/spec-factory.ts` | 共享 | `createRowSpec()`：把「记录型台账」的增删改清空导出投送接收固化 |
| 完工台 UI | `apps/micro-sites/shared/templates/workbench-impl.tsx` | 共享 | 台账列表、工具栏、投送/接收面板、`data-testid` 契约 |
| SDK 适配层 | `apps/micro-sites/shared/templates/sdk-facade.ts` | 共享 | 全站唯一 import `@matrixos/sdk` 的地方 |
| 站点外壳 | `apps/micro-sites/shared/templates/site-shell.tsx` | 共享 | 身份 / 元信息 / 仪器面板 / 状态行 / 虫洞接收器 |
| **业务数据** | **`<站点>/src/lib/site-spec.ts`** | **每站手写** | **本站台账的演示数据与字段映射 —— 唯一的站间差异** |
| 站点说明 | `<站点>/README.md` | 每站手写 | 数据模型 / accepts-emits / 本地开发 |

共享层由 `scripts/wire-workbench.mjs` 分发到各站（文件头会写「请勿直接修改本文件」）。
**改共享层要改模板再跑分发，不要直接改站内副本**，否则 18 站会漂移、验收会崩。

```bash
node scripts/wire-workbench.mjs                 # 全部分发
node scripts/wire-workbench.mjs --site=01-gpa-sandbox
node scripts/wire-workbench.mjs --check         # 只比对不写盘（CI 用）
```

## 2. 每站要写什么

### 2.1 `src/lib/site-spec.ts`

一个 `createRowSpec({...})` 调用。配置项：

```ts
interface RowSpecConfig {
  exportName: string;                    // 导出文件名前缀，如 'gpa-plans'
  seed: readonly RowSeed[];              // 首次打开时的演示数据（确定性、可复现）
  emit: { targetApp: string; payloadType: WormholePayloadType };
  accept: { payloadType: WormholePayloadType; description: string };
  draft?: (rows, nowIso) => RowSeed;     // 「+ 新增一条」的默认内容
  payloadOf?: (rows, nowIso) => Record<string, unknown>;   // 投送信封的 payload.data
  rowOfEnvelope?: (envelope, nowIso) => RowSeed;           // 接收后落成什么样
  csvOf?: (rows) => CsvTable;            // 自定义 CSV 列
}

interface RowSeed {
  title: string;      // 列表主标题
  meta: string;       // 列表副标题（一行摘要）
  detail: string;     // 展开后的详情
  anchor?: { source_doi_or_url: string; verification_level: VerificationLevel; pdf_page?: number; bbox?: [number,number,number,number] };
  [extra: string]: unknown;   // 本站自定义字段，会原样进 payload
}
```

**硬约束**：

1. `exportName` 全站唯一，用作 localStorage key 的一部分（`mx.<appId>.<exportName>`）。
2. `seed` 里的数值必须与共享演示数据一致，**不要手抄数字** —— 从 `@matrixos/microsite-data`
   导入 `GPA_COURSES` / `GRANT_COLUMNS` / `MENTORS` / `CAREER_PATHS` 等，用同一份数据算出来。
   手抄会出现「仪器面板显示 3.61、台账写 3.62」这类答辩事故。
3. `anchor.verification_level` 只能是 `'Level_A_Verified' | 'Level_B_Preprint' | 'Retracted_Warning'`。
   **锚点对象不能有第五个字段** —— `wormhole-envelope.schema.json` 里锚点层是
   `additionalProperties: false`，多一个 `note` 字段整个信封就过不了契约校验。
4. `emit.payloadType` 必须等于本站 `matrix-app.manifest.json` 的 `emits[0]`；
   `accept.payloadType` 必须在 `accepts` 里。由 `wire-workbench.mjs --check` 自检。
5. 所有回调必须是**纯函数**：不改入参、不抛错、同一入参给同一输出。
6. 至少 3 条 `seed`，内容要覆盖该站真实业务场景（不是「示例 1/示例 2/示例 3」）。

### 2.2 `README.md`

必须包含（验收会人工核对）：

- 表格里 `虫洞接收` / `虫洞投送` 两行要写出真实的 payload_type 与对端站点，不再是「（当前不接收）」。
- 一节「数据模型」：说明台账里一条记录有哪些字段、localStorage key 是什么。
- 一节「虫洞契约」：accepts 什么、从谁来；emits 什么、给谁去；证据锚点从哪来。
- 一节「本地开发」：`pnpm --filter <包名> dev` 的端口。
- 「下一步（S3 功能完备化）」一节删掉 —— 已完工，改为「验收」一节，写怎么跑验收器。

## 3. 验收契约（`scripts/microsite-verify.mjs` 实际断言）

跑法：

```bash
node scripts/microsite-verify.mjs --site=01-gpa-sandbox    # 单站
node scripts/microsite-verify.mjs --all                     # 全量（约 10 分钟）
node scripts/microsite-verify.mjs --site=X --skip-build     # 复用上次 out/
```

断言逐条：

1. 静态导出能构建（`scripts/build-static-site.mjs`）
2. 首屏正文 ≥ 300 字符
3. 七个 `data-testid` 全部存在：
   `primary-tool` / `ledger-count` / `ledger-save` / `ledger-export-json` / `ledger-clear` / `wormhole-emit` / `wormhole-feedback`
4. 点 `ledger-save` → 计数 +1；刷新后计数保持
5. 点 `ledger-export-json` → 真的触发下载且文件 > 8 字节
6. 点 `ledger-clear` → 计数归 0；刷新后仍为 0
7. 点 `wormhole-emit` → `wormhole-feedback` 非空（**注意：此时台账已被清空，
   所以投送必须在空台账下也能产出反馈 —— 靠站级基线锚点兜底**）
8. console error = 0、未捕获异常 = 0、失败请求 = 0
9. 390×844 移动端无横向溢出

截图落在 `.tmp/microsite-verify/<site>-{desktop,mobile}.png`。

## 4. 已知坑（都是踩出来的）

### 4.1 静态站不能发真实网络请求

SDK 的 `initSSO()` 在独立窗口会走 Cookie 通道，第一句就是
`GET https://api.matrixos.edu/v1/auth/userinfo`。静态站没有后端，这一发就是失败请求，
直接触发验收器的「失败请求必须为 0」。所以：

- **只有 `useHostBridge().connected === true`（真嵌在 hub iframe 里且握手完成）才调 `initSSO()`**；
- manifest 走构建期内联（`import siteManifest from '../../matrix-app.manifest.json'`），
  `ManifestHolder.load()` 见已有 manifest 会立即返回，零网络。

这两条已经在 `sdk-facade.ts` 里实现了，写 site-spec 时不用管，但**不要绕过 facade 直接 import SDK**。

### 4.2 水合一致性（React #418）

`window` / `localStorage` 在服务端不存在。任何「渲染期读浏览器状态」的写法都会
让 SSR 首帧与 CSR 首帧文本不同 → React 报 hydration mismatch（验收器算作未捕获异常）。

正确写法：

```tsx
const [snap, setSnap] = useState(() => ledger.readDefault());  // 服务端=默认值
useEffect(() => { setSnap(ledger.read()); }, []);               // 客户端再回填
```

`ledger.readDefault()` 是专供 SSR/首帧的纯函数，不读 localStorage。

### 4.3 中文文件不能用 PowerShell 管道回写

`Get-Content | Set-Content` 会按 GBK 误解码 UTF-8，中文变乱码、引号变全角，
文件直接语法错误（Issue #27）。写文件一律用编辑工具的 `write` / `edit`，
或用 Node 脚本 `fs.writeFileSync(path, text, 'utf8')`。

### 4.4 共享包不能有 React 组件

`apps/micro-sites/shared` 没有 `react` / `@types/react` 依赖，`tsconfig.build.json`
也只编译 `src/**/*.ts`。所以 React 组件只能放在 `shared/templates/`（不编译，靠分发脚本复制），
不能放 `shared/src/`。这也是完工台走「模板 + 分发」而不是「共享包导出」的原因。

## 5. 每站可用演示数据（`@matrixos/microsite-data`）

写 `site-spec.ts` 的 `seed` 时**从这些导出取值算出来，不要手抄数字**。

| 站 | 仪器 | 可用的共享演示数据 |
| :--- | :--- | :--- |
| 01 | `GpaPusher` | `GPA_COURSES`、`weightedGpa()`、`gradeToPoint()` |
| 02 | `SparkRadar` | `TEAMMATES`、`SELF_SKILLS`、`SKILL_LABELS` |
| 03 | `GrantGauge` | `GRANT_COLUMNS`、`GRANT_TOTAL` |
| 04 | `PatRadar` | `PAT_HOT_ITEMS` |
| 05 | `CitationSonar` | `CITATION_NODES`、`CITATION_EDGES`、`CITATION_SOURCES` |
| 06 | `MentorRadar` | `MENTORS` |
| 07 | `ColdEmailLab` | `EMAIL_DRAFTS`、`EMAIL_TIPS` |
| 08 | `LabKanban` | `KANBAN_COLUMNS`、`KANBAN_TASKS` |
| 09 | `MatrixCross` | `PAPER_ROWS` |
| 10 | `PdfSniper` | `FORMULAS`、`PDF_SNIPPETS` |
| 11 | `CurveLab` | `curvelabPoints()`（函数，返回 `{x,y}[]`） |
| 12 | `ReproChecklist` | `REPRO_CHECKS` |
| 13 | `ChartFoundry` | `CHART_STYLES` |
| 14 | `ReviewLab` | `REVIEW_CLUSTERS`、`REVIEW_OUTLINE` |
| 15 | `RetractSonar` | `RETRACT_BLIPS` |
| 16 | `YunhengBalance` | `YUNHENG_PANS`、`YUNHENG_TOTAL` |
| 17 | `EvidenceCv` | `CV_ENTRIES` |
| 18 | `PrejobTree` | `CAREER_PATHS` |

注意 `PAPER_ROWS` / `CV_ENTRIES` 里的锚点用的是 **SDK 的 camelCase 形状**
（`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel`），
而虫洞信封契约要 **snake_case**（`source_doi_or_url` / `pdf_page` / `verification_level`）。
写 `site-spec.ts` 的 `anchor` 时必须转成 snake_case，否则信封过不了校验。

## 6. 各站虫洞契约（权威表）

| 站 | 名称 | accepts ← 来源 | emits → 目标 |
| :--- | :--- | :--- | :--- |
| 01 | 学分绩点动态配重台 | `verified_cv_evidence` ← evidence-cv | `verified_cv_evidence` → evidence-cv |
| 02 | 双创互补组队雷达 | `verified_cv_evidence` ← evidence-cv | `verified_cv_evidence` → evidence-cv |
| 03 | 大创五科目经费液位仪 | `paper_doi_bundle` ← lit-sonar | `verified_cv_evidence` → evidence-cv |
| 04 | PAT-HOT 学科脉冲雷达 | `paper_doi_bundle` ← lit-sonar | `paper_doi_bundle` → lit-sonar |
| 05 | 五源跨库引文声呐站 | `paper_doi_bundle` ← pat-hot | `paper_doi_bundle` → matrix-cross |
| 06 | 星门 · 导师五维星象仪 | `paper_doi_bundle`, `curve_fit_parameters` ← lit-sonar | `mentor_match_card` → cold-email |
| 07 | 证据内嵌式套磁信推演器 | `mentor_match_card`, `curve_fit_parameters` ← mentor | `mentor_match_card` → lab-kanban |
| 08 | 太空任务式进组跟进台账 | `mentor_match_card` ← cold-email | `verified_cv_evidence` → evidence-cv |
| 09 | Matrix-Cross 跨论文对比矩阵 | `paper_doi_bundle` ← lit-sonar | `comparison_matrix_row` → curvelab |
| 10 | PDF 公式与参量狙击镜 | `paper_doi_bundle` ← lit-sonar | `comparison_matrix_row` → review-lab |
| 11 | CurveLab 非线性拟合示波器 | `comparison_matrix_row` ← matrix-cross | `curve_fit_parameters` → chart-foundry |
| 12 | 顶刊代码复现核验舱 | `paper_doi_bundle`, `curve_fit_parameters` ← curvelab | `paper_doi_bundle` → retract-radar |
| 13 | Nature 级出版图表熔炉 | `curve_fit_parameters`, `comparison_matrix_row` ← curvelab | `comparison_matrix_row` → review-lab |
| 14 | 综述拓扑推演与写作舱 | `paper_doi_bundle`, `comparison_matrix_row` ← chart-foundry | `paper_doi_bundle` → retract-radar |
| 15 | 撤稿深海声呐与伦理合规仪 | `paper_doi_bundle` ← repro-check | `paper_doi_bundle` → evidence-cv |
| 16 | 云衡 · 数字天平综测核算器 | `paper_doi_bundle`, `verified_cv_evidence` ← evidence-cv | `verified_cv_evidence` → evidence-cv |
| 17 | 区块链级学术证据简历工坊 | 五类全收 ← retract-radar | `verified_cv_evidence` → prejob |
| 18 | 生涯多重宇宙期望决策树 | `verified_cv_evidence` ← evidence-cv | `verified_cv_evidence` → evidence-cv |

`emit.targetApp` / `accept.payloadType` 必须与本表一致（`wire-workbench.mjs --check` 会校验生态自洽）。

## 7. 当前进度

18 站全部完工：每站都有手写 `src/lib/site-spec.ts`（933 B 骨架 → 4–53 KB 真实业务）、
完工形态 `README.md`（含「数据模型」「虫洞契约」两节）、并通过 9 项端到端验收。

| 站点 | site-spec.ts | README | 验收 |
| :--- | :--- | :--- | :--- |
| 01 学分绩点动态配重台 | ✅ 4.1 KB | ✅ | ✅ 通过 |
| 02 双创互补组队雷达 | ✅ 14.1 KB | ✅ | ✅ 通过 |
| 03 大创五科目经费液位仪 | ✅ 19.0 KB | ✅ | ✅ 通过（红线语义已修，见 §8） |
| 04 PAT-HOT 学科脉冲雷达 | ✅ 15.8 KB | ✅ | ✅ 通过 |
| 05 五源跨库引文声呐站 | ✅ 14.8 KB | ✅ | ✅ 通过 |
| 06 星门 · 导师五维星象仪 | ✅ 15.5 KB | ✅ | ✅ 通过 |
| 07 证据内嵌式套磁信推演器 | ✅ 16.6 KB | ✅ | ✅ 通过（移动端溢出已修，见 §8） |
| 08 太空任务式进组跟进台账 | ✅ 21.0 KB | ✅ | ✅ 通过 |
| 09 Matrix-Cross 跨论文对比矩阵 | ✅ 18.8 KB | ✅ | ✅ 通过（窄屏溢出已修，见 §8） |
| 10 PDF 公式与参量狙击镜 | ✅ 23.6 KB | ✅ | ✅ 通过 |
| 11 CurveLab 非线性拟合示波器 | ✅ 52.9 KB（38 模型真实最小二乘） | ✅ | ✅ 通过 |
| 12 顶刊代码复现核验舱 | ✅ 13.7 KB | ✅ | ✅ 通过 |
| 13 Nature 级出版图表熔炉 | ✅ 13.5 KB | ✅ | ✅ 通过 |
| 14 综述拓扑推演与写作舱 | ✅ 12.3 KB | ✅ | ✅ 通过 |
| 15 撤稿深海声呐与伦理合规仪 | ✅ 15.7 KB | ✅ | ✅ 通过（`Retracted_Warning` 已落地） |
| 16 云衡 · 数字天平综测核算器 | ✅ 15.6 KB | ✅ | ✅ 通过（水合 #418 已修，见 §8） |
| 17 区块链级学术证据简历工坊 | ✅ 22.9 KB（五类 payload 分流） | ✅ | ✅ 通过 |
| 18 生涯多重宇宙期望决策树 | ✅ 23.5 KB（含学职平台真实数据） | ✅ | ✅ 通过 |

共享层（ledger / spec-factory / 7 个模板 / 仪器样式表）已全部就位，18 站完工层逐字节一致
（`node scripts/wire-workbench.mjs --check` 全绿）。

## 8. 完工过程中修掉的共享层缺陷

这些都不是「某站写错了」，而是共享层/工具链的问题 —— 记在这里，避免下次再从零排查。

### 8.1 18 站仪器类名从来没有样式表

`site-instrument.tsx` 里 18 个仪器用了 139 个 class（`.gpa-summary` / `.email-body` /
`.cite-node` / `.cross-table` …），但 18 站 `globals.css` 里一个都没定义 —— 仪器一直是
「无样式纯文本」，`<pre>` 不换行把 07 站移动端顶到 530 px。
修法：新增 `scripts/lib/microsite-instrument-css.mjs`（单一事实源），由 `renderGlobalsCss`
注入，重新生成 18 站 `globals.css`（每站 ~11 KB → ~31 KB）。

### 8.2 `.iu-evidence__badge` 的 `white-space: nowrap` 撑破 390 px

09 站表格单元格里放 `EvidenceLink`，徽章 min-content 宽 306 px，把 `table.cross-table`
撑到 387 px，390 px 视口只剩 316 px 可用 → `scrollWidth` 424。
修法：在 `@media (max-width: 480px)` 里同时做两件事 —— 表格自己变横向滚动容器
（`display:block; overflow-x:auto`）**并且**把徽章放开成可换行（`white-space:normal`）。
只做前者是「把溢出藏起来、内容看不全」。

### 8.3 03 站把合规的劳务费判成超限

`FluidGaugeBank` 把 `redline` 当「占本柱 capacity 的比例」，而共享数据把 `labor.capacity`
写成了「20% 红线换算出的金额 4000」→ 2500/4000 = 62.5% > 20%，误报「超出 42.5 个百分点」；
同时 Σcapacity = 21500 ≠ 20000，总计显示 93.0%（实际已花完 100%）。
修法（向后兼容）：`GaugeColumn.redlineBasis?: 'capacity' | 'total'`（缺省 `'capacity'`，
demo 与既有调用方零影响）+ `FluidGaugeBankProps.totalBudget?: number`；红线判定统一归一到
「金额」比较，总览分母改用 `totalBudget`。labor 列标 `redlineBasis: 'total'`，
`GrantGauge` 传 `totalBudget={GRANT_TOTAL}`。修后 2500/20000 = 12.5% ≤ 20% 合规，
总计 100%，红线刻度仍贴在柱顶可见。

### 8.4 `PrecisionBalance` 的总分计数器导致 React #418

`displayTotal` 初值是 `0`，SSR 渲染 `0.0`、客户端挂载后动画推进到 `18.5` → 文本不一致。
dev 模式只警告不抛，**只有 `next build` 产物严格校验**，所以这个问题在 16 站单站稳定复现，
dev 下却抓不到。
修法：`displayTotal` 初值改 `number | null`（null = 未挂载），渲染 `displayTotal ?? cappedTotal`
—— SSR 与客户端首帧都给终值，文本一致；`mountedRef` 保证首帧不对齐后又重跑一遍动画
（否则用户会看到「18.5 → 0 → 18.5」闪跳），只有后续 target 变化才跑缓动。

### 8.5 静态导出把半成品当成功

`build-static-site.mjs` 原来只检查 `out/index.html` 存在就 break。Next 15.5.28 偶发
`Invariant: no direct app page entry found for /icon.svg`，此时退出码 0、`index.html` 在，
但缺 `icon.svg` / `index.txt` → 下游验收器报 404。
修法：判据改成 `index.html` + `icon.svg` + `index.txt` 三者齐全，缺一个就 fixup 再重试。

### 8.6 重试机制一直是空转的（最隐蔽的一个）

`build-static-site.mjs` 用 `execFileSync(cmd, args, { stdio: 'inherit' })` 跑 `next build`。
`'inherit'` 让日志直接进终端 —— **但命令非零退出时 `e.stdout` / `e.stderr` 是 `undefined`**。
于是不稳定态判据 `isFlakyBuildError(out)` 永远拿到空串、恒为 `false`，
**重试分支一次都不会进入**，所有 Next 的不稳定族错误全部当硬失败抛出。

表现：单站构建时好时坏（成功率约 50%），批量跑时 14/15/16/17/18 连环失败；
而且因为 `stdio: 'inherit'`，错误日志进了终端、却不进 `e.stdout`，排查时极具误导性。

修法：改 `spawnSync(..., { encoding: 'utf8' })` 自己收 stdout/stderr，
再手动把尾部 40 行转发到终端（保留可读日志），判据用累积的 `combinedOutput`。
修完后同一次批量验收里就能看到「（第 2 次构建成功）」—— 重试真正在工作。

**这条的教训**：`execFileSync` + `stdio: 'inherit'` 与「读错误输出来做判断」是互斥的，
两者同时需要时必须用 `pipe` / `spawnSync`。

### 8.7 不稳定族的判据要覆盖整族，不能只认一种

Next 15.5.28 的 `output: 'export'` 报错会在下列形态间随机切换（同一份代码、连续构建）：

```
Invariant: no direct app page entry found for /xxx
ENOENT ... .nft.json
ENOENT ... pages-manifest.json
ENOENT ... build-manifest.json
ENOENT ... _ssgManifest.js
ENOENT ... prerender-manifest.json
Could not find a production build in the '.next' directory
```

只认 `Invariant:` 会漏掉实测最常见的 ENOENT 与 production build 两类。
判据改为「任一特征串命中即视为可重试」。

### 8.8 `gen:site.mjs` 的 site-spec 骨架语法错

`renderSiteSpecStarter` 拼了 `fileHeader(station)`（自带收尾 `*/`）之后又接一段
` * 业务规格… */`，注释提前闭合 → 生成出来的 site-spec 直接 TS1109 / TS1127。
所以 12/13 站一度是「能生成但编译不过」的坏骨架。修法：自建 header 数组，不再拼 `fileHeader`。

### 8.9 虫洞契约三处各持一份曾漂移

`gen:site.mjs` 的 `HOOKS`、`wire-workbench.mjs` 的 `CONTRACTS`、各站 `site-spec.ts`
的 `emit.payloadType` 是同一份事实的三个副本。生成器那份还是骨架期默认值，
跑一次 `gen:site --force` 就会把已完工站的 manifest 打回 `accepts: [] / emits: []`。
修法：抽出 `scripts/lib/microsite-contracts.mjs`（单一事实源 + `auditContracts()` 生态自检）
与 `scripts/lib/microsite-templates.mjs`（6 个分发模板清单），两个脚本共用。
自检四条判据：emits 必须被目标站 accepts（否则 SDK W3 抛 `UnsupportedPayloadError`）、
accepts 至少一个类型被来源站 emits、accepts 的每个类型至少有一站 emits、枚举合法性。

### 8.10 并发验收会互相踩 `.next/`

多个验收进程（或 teammate）同时 `next build` 同一站时，会互相删写 `.next/`：
表现为随机 ENOENT、CSS 404、React #418 —— 全是假红，单跑立刻绿。
修法：`microsite-verify.mjs` 加站点级构建锁（`<站>/.verify-build.lock` 目录做原子互斥，
等锁上限 8 分钟，超时明确报错而不是无限等）。
