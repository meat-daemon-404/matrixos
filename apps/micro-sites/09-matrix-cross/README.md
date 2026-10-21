# 09 · Matrix-Cross 跨论文对比矩阵

> MatrixOS 微站 · 轨道 5 · 工坊 · `matrix-cross.matrixos.cc.cd` · 目录 `apps/micro-sites/09-matrix-cross/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致，
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 激光溯源对比网格 |
| 独立台账 | 多篇顶刊核心实验参量横向对比表 |
| 原型来源 | ScholarMatrix 核心 |
| 开发端口 | `3018` |
| 虫洞接收 | `paper_doi_bundle` ← 05 五源跨库引文声呐（lit-sonar） |
| 虫洞投送 | `comparison_matrix_row` → 11 CurveLab 非线性拟合示波器（curvelab） |

自动抽取多篇 PDF 的材料、方法与性能指标，悬停单元格激射 PDF 原文坐标。
一条台账记录 = **对比矩阵的一行**：一篇顶刊的 venue + 钝化界面策略 + 关键参量（EQE 峰值）
+ 证据锚点（DOI / 页码 / PDF 坐标），连同它在矩阵里的排名、与上界的差值一起落库。

## 本地开发

开发端口 **3018**（`src/site.config.ts` 与 `package.json` 的 `dev` 脚本一致）：

```bash
pnpm --filter @matrixos/microsite-09-matrix-cross dev        # http://localhost:3018
pnpm --filter @matrixos/microsite-09-matrix-cross build
pnpm --filter @matrixos/microsite-09-matrix-cross typecheck  # npx tsc --noEmit
```

零 Tailwind、零外部 CDN，内网可用。`next.config.ts` 在加载时探测
`@matrixos/sdk` / `@matrixos/instrument-ui` 能否 resolve，解析不到就把 specifier 别名到
`src/lib/shims/` —— import 已按最终形态写好，包一旦就位别名自动失效。

## 数据模型

台账落在 `localStorage` 的 `mx.matrix-cross.cross-matrix` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "Nat. Photon. 2025 · PEAI 准二维钝化",
        "meta": "EQE 28.4% · 排名 1/3 · 矩阵上界 · Level A · 已双验 · 锚点 3/3",
        "detail": "对比维度：顶刊文献 / 钝化界面工程 / EQE 峰值 / …；关键参量 EQE 28.4%（本矩阵最高）；证据锚点：DOI 10.1038/s41566-025-01234-5 · P.4 Fig. 2b · bbox [72.5, 144, 300.25, 210.75] · 26656 pt²；…",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                            // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                            // 该行的证据锚点，投送时聚合进信封
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,                       // 可选，仅在共享数据带页码时出现
          "bbox": [72.5, 144, 300.25, 210.75]  // 可选，PDF 原文坐标（pt）
        },
        "paperId": "r1",                       // 本站自定义字段：共享数据里的行 id
        "rowIndex": 1,
        "venue": "Nat. Photon. 2025",
        "strategy": "PEAI 准二维钝化",
        "eqe": "28.4%",                        // 原始字符串，保留论文写法
        "eqeValue": 28.4,                      // 解析出的数值，排名与差值都基于它
        "rank": 1,                             // 矩阵排名（并列同名次）
        "rowCount": 3,
        "deltaToBest": 0,                      // 落后矩阵上界多少个百分点
        "isBest": true,
        "isWorst": false,
        "spread": 3.3,                         // 矩阵极差（上界 - 下界）
        "verificationLevel": "Level_A_Verified",
        "verificationText": "Level A · 已双验",
        "sourceDoi": "10.1038/s41566-025-01234-5",
        "pdfPage": 4,
        "bbox": [72.5, 144, 300.25, 210.75],
        "bboxArea": 26656,                     // 坐标框面积（pt²）
        "figureNote": "Fig. 2b",               // 锚点 note 只留在台账里，绝不进信封
        "anchorCompleteness": 3,               // DOI + 页码 + 坐标 三项命中数
        "rowRole": "矩阵的效率上界样本：……"
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `cross-matrix.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `cross-matrix.csv`（列：顶刊文献 / 钝化界面工程 / EQE 峰值 / 矩阵排名 /
  落后上界(pt) / 证据等级 / 原文页码 / PDF 坐标 / 图号 / DOI / 锚点完整度 / 最后修改）

## 矩阵口径（本站的核心业务规则）

三行由共享数据 `PAPER_ROWS` 直接映射，**排名与差值全部当场算，不手抄**：

| 顶刊 | 策略 | EQE | 排名 | 落后上界 | 证据等级 | 锚点 |
| :--- | :--- | ---: | :--- | ---: | :--- | :--- |
| Nat. Photon. 2025 | PEAI 准二维钝化 | 28.4% | 1/3 | 0.0 pt | Level A · 已双验 | P.4 Fig. 2b |
| JACS 2025 | 双氟代配体交联 | 26.8% | 2/3 | 1.6 pt | Level B · 仅预印本 | P.3 Para. 2 |
| Adv. Mater. 2024 | R/S-MBA 手性界面 | 25.1% | 3/3 | 3.3 pt | Level A · 已双验 | P.7 Tab. S3 |

- **矩阵上界 28.4%、下界 25.1%、极差 3.3 pt**：投送时随包带上，CurveLab 直接拿这三个值定 y 轴范围。
- 排名用「数一数有几行比它高」实现（并列同名次），不用 `sort` —— 避免就地改动共享常量。
- 「唯一的预印本行」是 JACS 2025（Level B）：效率接近上界但未双验，下游只能当软约束，
  不能当硬性上界。这条区分是本站业务判断的核心，写进了每行 `detail` 的「行角色」。
- 新增的行落成「待抽取行」：`rank` 为 0、`eqeValue` 为 0，**不计入排名**，直到 EQE 从 PDF 里抽出来，
  否则会污染上界。
- 锚点完整度 `anchorCompleteness` 是 DOI / 页码 / 坐标三项的命中数（0–3），
  `detail` 与 CSV 都会写出来 —— 「这条数值能不能被点回原文」是本站的验收口径。

## 虫洞契约

- **接收** `paper_doi_bundle`，来自 05 五源跨库引文声呐（lit-sonar）。消费后
  **在矩阵顶部开一条「待抽取行」**：论文包里的 DOI 清单、收藏夹数量、投来信封的锚点
  一并落成记录，之后逐篇打开 PDF 把 EQE 峰值与页码坐标抽进去，这一行才进排名。
- **投送** `comparison_matrix_row`，发往 11 CurveLab 非线性拟合示波器（curvelab）。
  投出去的 `payload.data` 形如：

```jsonc
{
  "site": "matrix-cross",
  "ledger": "多篇顶刊核心实验参量横向对比表",
  "target": "curvelab",
  "matrixName": "顶刊钝化策略 × EQE 峰值",
  "rowCount": 3,
  "columnCount": 8,
  "columns": [                            // 列定义随包带上，下游不必猜字段含义
    { "key": "venue", "label": "顶刊文献", "unit": "" },
    { "key": "eqe", "label": "EQE 峰值", "unit": "%" },
    { "key": "bboxArea", "label": "坐标面积", "unit": "pt²" }
  ],
  "bestEqe": 28.4,                        // 上界 / 下界 / 极差：拟合曲线 y 轴范围
  "worstEqe": 25.1,
  "spread": 3.3,
  "verification": { "levelA": 2, "levelB": 1, "retracted": 0 },
  "row": {                                // comparison_matrix_row 的「那一行」
    "paperId": "r1",
    "venue": "Nat. Photon. 2025",
    "strategy": "PEAI 准二维钝化",
    "eqe": "28.4%",
    "eqeValue": 28.4,
    "rank": 1,
    "verificationLevel": "Level_A_Verified",
    "sourceDoi": "10.1038/s41566-025-01234-5",
    "pdfPage": 4,
    "bbox": [72.5, 144, 300.25, 210.75],
    "figureNote": "Fig. 2b"
  },
  "matrix": [{ "…": "整张表，供下游追溯这一行在什么坐标系里比出来的" }]
}
```

**投送语义**：`payload_type` 叫 `comparison_matrix_row`，顾名思义是「一行」，所以 `row`
装的是**当前矩阵里 EQE 最高的那一行**（CurveLab 建一条拟合数据集只需要一条材料 / 方法 /
工况元信息，不需要整张表）；整张矩阵仍随包带上供追溯。台账为空或全是待抽取行时 `row` 为 `null`。

证据锚点取自每行的 `anchor` 字段，**锚点是 snake_case**
（`source_doi_or_url` / `verification_level` / `pdf_page` / `bbox`），因为虫洞信封的锚点层是
`additionalProperties: false` —— 多一个 `note` 字段整个信封都过不了校验。
共享数据里的锚点是 SDK 的 camelCase 形状（`sourceDoiOrUrl` / `pdfPage` / `note`），
所以 `site-spec.ts` 里逐字段转换并**丢掉 `note`**（`note` 只留在台账的 `figureNote` 字段里）。
`verification_level` 只取三值：`Level_A_Verified` / `Level_B_Preprint` / `Retracted_Warning`。

没有绑定 DOI 的新建行用站内矩阵页兜底：
`https://matrix-cross.matrixos.cc.cd/matrix/<slug>` + `Level_B_Preprint`（未双验，绝不冒充 Level A）。

**台账为空时**投送会退化为站级基线锚点（`https://matrix-cross.matrixos.cc.cd/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=09-matrix-cross
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/09-matrix-cross-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射。
  三行由 `PAPER_ROWS` 直接映射（排名 / 差值 / 坐标面积全部当场算，**不手抄数字**），
  手抄会出现「仪器面板表格显示 28.4%、台账写 28%」这类答辩事故。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（激光溯源对比网格 `MatrixCross`），
  由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式 + 18 个仪器共用的类名基础样式
  （后者由 `scripts/lib/microsite-instrument-css.mjs` 经 `gen-site` 注入，**不要手改**。
  窄屏 390px 下 `.cross-table` 转块级横向滚动、`.iu-evidence*` 徽章允许换行，
  就是这套共享样式里的兜底规则 —— 要改就改那个单一事实源再重分发）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=09 --force`（`scripts/gen-site.mjs`）
