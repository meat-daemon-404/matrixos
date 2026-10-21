# 10 · PDF 公式与参量狙击镜

> MatrixOS 微站 · 轨道 5 · 工坊 · `pdf-sniper.matrixos.edu` · 目录 `apps/micro-sites/10-pdf-sniper/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致，
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 双栏光学瞄准阅读器 |
| 独立台账 | 高亮批注、公式符号表与难例卡片 |
| 原型来源 | ScholarMatrix 拆解 |
| 开发端口 | `3019` |
| 虫洞接收 | `paper_doi_bundle` ← 05 五源跨库引文声呐（lit-sonar） |
| 虫洞投送 | `comparison_matrix_row` → 14 综述拓扑推演与写作舱（review-lab） |

点击文内复杂偏微分方程，右侧自动展开物理量纲解释与 Python 求解代码。
一条台账记录 = **一个公式 / 参量卡片**：公式本体（LaTeX + 纯文本 + Python 代码）
+ 物理量纲与符号表 + PDF 定位（`pdf_page` + `bbox`）+ 原文摘录与高亮数值 + 难例判定。

## 本地开发

开发端口 **3019**（`src/site.config.ts` 与 `package.json` 的 `dev` 脚本一致）：

```bash
pnpm --filter @matrixos/microsite-10-pdf-sniper dev        # http://localhost:3019
pnpm --filter @matrixos/microsite-10-pdf-sniper build
pnpm --filter @matrixos/microsite-10-pdf-sniper typecheck  # npx tsc --noEmit
```

零 Tailwind、零外部 CDN，内网可用。`next.config.ts` 在加载时探测
`@matrixos/sdk` / `@matrixos/instrument-ui` 能否 resolve，解析不到就把 specifier 别名到
`src/lib/shims/` —— import 已按最终形态写好，包一旦就位别名自动失效。

## 数据模型

台账落在 `localStorage` 的 `mx.pdf-sniper.formula-cards` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T15:21:49.207Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "Eq. (1) · I(t) = A₁e^(-t/τ₁) + A₂e^(-t/τ₂)",
        "meta": "P.4 · bbox [72.5, 112.8, 258.1, 132.8] · 3,712 pt² · 符号 2 条 · 难度 进阶（2） · 代码 3 行",
        "detail": "量纲：…；符号表：1. … / 2. …；PDF 定位：P.4 · bbox […] · 坐标面积 3,712 pt² · 来源 layout_estimate；原文摘录：…；高亮批注：…；物理含义：…；求解代码：…；难例判定：…",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                            // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                            // 该卡的证据锚点，投送时聚合进信封
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,                       // ← 本站核心特色：页码定位
          "bbox": [72.5, 112.8, 258.1, 132.8]  // ← 本站核心特色：PDF 坐标（pt）
        },
        "formulaId": "f1",                     // 本站自定义字段：共享数据里的公式 id
        "formulaNo": 1,
        "figure": "Eq. (1)",
        "latex": "I(t) = A_1 e^{-t/\\tau_1} + A_2 e^{-t/\\tau_2}",
        "plain": "I(t) = A₁e^(-t/τ₁) + A₂e^(-t/τ₂)",
        "dimension": "A₁, A₂ 无量纲（归一化强度）；τ₁, τ₂ 单位 ns",
        "explanation": "双指数衰减模型，描述载流子在快、慢两个通道的复合过程。…",
        "python": "import numpy as np\ndef bi_exp(t, A1, tau1, A2, tau2): …",
        "pythonLines": 3,
        "symbols": ["A₁, A₂ 无量纲（归一化强度）", "τ₁, τ₂ 单位 ns"],  // 量纲按分号拆成的符号表
        "symbolCount": 2,
        "snippetId": "s1",                     // 绑定的 PDF 原文摘录
        "snippetPage": 4,
        "snippetText": "The TRPL decay curves were fitted with a bi-exponential model. …",
        "highlightNumbers": ["14.2", "89.5", "0.9884"],   // 摘录里被荧光笔标出的数值
        "pdfPage": 4,
        "bbox": [72.5, 112.8, 258.1, 132.8],
        "bboxArea": 3712,                      // 坐标框面积（pt²）
        "bboxSource": "layout_estimate",       // 明写坐标是排版推算，不是 PDF 解析结果
        "difficultyScore": 2,
        "difficultyLabel": "进阶",             // 基础 / 进阶 / 难例
        "difficultyReasons": ["含下标量纲", "求解代码多行"],
        "sourceDoi": "10.1038/s41566-025-01234-5",
        "sourceVenue": "Nat. Photon. 2025",
        "verificationLevel": "Level_A_Verified"
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `formula-cards.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `formula-cards.csv`（列：公式编号 / 纯文本 / LaTeX / 量纲 / 符号数 /
  PDF 页码 / PDF 坐标 / 坐标面积(pt²) / 坐标来源 / 摘录数值 / 难度 / 难度依据 /
  原文摘录 / DOI / 最后修改）

## 卡片口径（本站的核心业务规则）

三张卡片由共享数据 `FORMULAS` 直接映射，**页码、坐标、面积、符号数、难度全部当场算，不手抄**：

| 公式 | 纯文本 | 页码 | bbox（pt） | 面积 | 符号 | 难度 | 摘录数值 |
| :--- | :--- | ---: | :--- | ---: | ---: | :--- | :--- |
| Eq. (1) 双指数衰减 | `I(t) = A₁e^(-t/τ₁) + A₂e^(-t/τ₂)` | P.4 | `[72.5, 112.8, 258.1, 132.8]` | 3,712 pt² | 2 | 进阶（2） | 14.2 / 89.5 / 0.9884 |
| Eq. (2) 决定系数 | `R² = 1 - Σ(yᵢ - ŷᵢ)² / Σ(yᵢ - ȳ)²` | P.8 | `[72.5, 112.8, 263.9, 146.8]` | 6,508 pt² | 1 | 难例（5） | — |
| Eq. (3) 外量子效率 | `EQE = J_sc / (q · Φ)` | P.5 | `[72.5, 112.8, 188.5, 146.8]` | 3,944 pt² | 3 | 进阶（3） | — |

- **页码是真的**：来自 `PDF_SNIPPETS[].page`（4 / 5 / 8）。
- **bbox 是排版推算，不是 PDF 解析结果**。共享演示数据只给了论文级锚点
  （`PAPER_ROWS[0].anchor.bbox` 是 Fig. 2b 那块图），没有逐公式坐标。所以：
  - 左边距取 1 inch（`72.5pt`）—— 与 `PAPER_ROWS` 里那条真实锚点的 `x0 = 72.5` 完全一致；
  - `y0 = 版心顶边 72 + 摘录段占行数 × 14.4pt 行距 + 12pt 段后间距`
    （行数 = `ceil(摘录字符数 / 78)`，78 = 版心宽 450.3pt ÷ 平均字宽 5.77pt）；
  - 宽 = 公式纯文本长度 × 平均字宽 5.8pt，封顶版心宽 450.3pt、下限 96pt；
  - 高 = 含 `\frac` 的展示式 34pt，其余 20pt。
  - 记录里用 `bboxSource: "layout_estimate"` **明写这是推算**，绝不冒充 PDF 解析结果。
    接真实解析（pdf.js `getTextContent`）时只换 `bboxOf()` 一个函数，接口不变。
- **符号表** = `dimension` 按中文分号拆开（`f1` → 2 条、`f3` → 3 条）。`dimension` 字段本身
  就是「符号 → 单位 / 含义」的逐条罗列，直接拆比正则解析公式可靠。
- **高亮数值** = 从原文摘录里抠出的数字（`f1` 的摘录含 `14.2 / 89.5 / 0.9884`）。
  这三张卡里只有 `f1` 的摘录带独立数值，另外两段是文字说明，批注落在公式符号本身。
- **难例判定**只看公式结构与求解代码，不看主观感觉：含 `\frac` / `\sum` / `\hat`·`\bar` /
  下标 / 多行代码各 +1 分，`≥4` 为难例、`≥2` 为进阶、其余基础。
  `f2` 五项全中（5 分）是本站唯一难例；`f1` 2 分、`f3` 3 分。
- **被狙击的 PDF** 取「页码能对上摘录」的那篇论文：`PDF_SNIPPETS` 的三段原文都出自
  `PAPER_ROWS[0]`（Nat. Photon. 2025，DOI `10.1038/s41566-025-01234-5`，Level A 已双验）。
  论文的验证等级是共享数据里的既成事实，`site-spec.ts` 不在这里改判。
- 新增的卡片落成「待狙击卡」：没有 PDF、没有页码、没有坐标（`pdfPage: 0`、`bbox: []`、
  `bboxSource: "unbound"`），**定位完成前不能当作对比矩阵的一行投送**。

## 虫洞契约

- **接收** `paper_doi_bundle`，来自 05 五源跨库引文声呐（lit-sonar）。消费后
  **在台账顶部开一张「待狙击卡」**：论文包里的 DOI 清单、收藏夹数量、投来信封的锚点
  一并落成记录，之后逐篇打开 PDF 框选公式区域，把 `pdf_page` 与 `bbox` 补上，
  这张卡才算定位完成。
- **投送** `comparison_matrix_row`，发往 14 综述拓扑推演与写作舱（review-lab）。
  投出去的 `payload.data` 形如：

```jsonc
{
  "site": "pdf-sniper",
  "ledger": "高亮批注、公式符号表与难例卡片",
  "target": "review-lab",
  "bundle_kind": "formula_card_row",
  "cardCount": 3,
  "formulaCount": 3,
  "snippetCount": 3,
  "hardCaseCount": 1,                       // 难度 ≥4 的卡片数
  "locatedCount": 3,                        // 已有 pdf_page + bbox 的卡片数
  "doi": "10.1038/s41566-025-01234-5",      // ← 14 综述舱直接消费的扁平字段
  "figure": "Eq. (2)",                      // ← 同上（焦点卡 = 难度最高的那张）
  "pdf_page": 8,
  "bbox": [72.5, 112.8, 263.9, 146.8],
  "card": {                                 // 焦点卡完整内容
    "formulaId": "f2",
    "figure": "Eq. (2)",
    "plain": "R² = 1 - Σ(yᵢ - ŷᵢ)² / Σ(yᵢ - ȳ)²",
    "dimension": "无量纲，取值范围 (-∞, 1]",
    "symbols": ["无量纲，取值范围 (-∞, 1]"],
    "pdfPage": 8,
    "bbox": [72.5, 112.8, 263.9, 146.8],
    "bboxArea": 6508,
    "bboxSource": "layout_estimate",
    "difficultyScore": 5,
    "difficultyLabel": "难例",
    "verificationLevel": "Level_A_Verified"
  },
  "cards": [{ "…": "三张卡的完整列表，供综述舱批量挂段落" }]
}
```

**投送语义**：`payload_type` 叫 `comparison_matrix_row`，顾名思义是「一行」。本站投的是
**难度分最高的那张卡**（同分取页码靠前的）—— 综述舱要的是「这段公式值得单独解释」的样本，
不是三张平均卡。整份卡片表仍随包带上（`payload.data.cards`）。台账为空时 `card` 为 `null`。

**为什么 `doi` / `figure` 放在顶层**：14 综述舱的 `rowOfEnvelope` 读的是
`payload.data.doi`（string）与 `payload.data.figure`（string），塞进 `card` 里它读不到。
这是跨站字段契约，改之前先看 14 站的 site-spec。

证据锚点取自每行的 `anchor` 字段，**锚点是 snake_case**
（`source_doi_or_url` / `verification_level` / `pdf_page` / `bbox`），因为虫洞信封的锚点层是
`additionalProperties: false` —— 多一个 `note` 字段整个信封都过不了校验。
本站的锚点按契约从头拼出来（DOI 来自 `PAPER_ROWS`、页码来自 `PDF_SNIPPETS`、坐标由
`bboxOf()` 算），**全程不出现 `note`**。`verification_level` 只取三值：
`Level_A_Verified` / `Level_B_Preprint` / `Retracted_Warning`。

尚未绑定 PDF 的新卡用站内待定位清单页兜底：
`https://pdf-sniper.matrixos.edu/cards/<slug>` + `Level_B_Preprint`（未定位，绝不冒充 Level A）。

**台账为空时**投送会退化为站级基线锚点（`https://pdf-sniper.matrixos.edu/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=10-pdf-sniper
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/10-pdf-sniper-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射。
  三张卡由 `FORMULAS` / `PDF_SNIPPETS` / `PAPER_ROWS` 直接映射
  （页码 / 坐标 / 面积 / 符号数 / 难度全部当场算，**不手抄数字**），
  手抄会出现「瞄准镜右栏显示 R² = 0.9884、台账写 0.98」这类答辩事故。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（双栏光学瞄准阅读器 `PdfSniper`：
  左栏模拟 PDF 原文段落按页高亮，右栏展开公式解析 / 量纲 / 解释 / Python 代码），
  由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式 + 18 个仪器共用的类名基础样式
  （后者由 `scripts/lib/microsite-instrument-css.mjs` 经 `gen-site` 注入，**不要手改**，
  窄屏堆叠等规则要改就改那个单一事实源再重分发）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=10 --force`（`scripts/gen-site.mjs`）
