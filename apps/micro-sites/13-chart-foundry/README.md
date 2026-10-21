# 13 · Nature 级出版图表熔炉

> MatrixOS 微站 · 轨道 5 · 工坊 · `chart-foundry.matrixos.edu` · 目录 `apps/micro-sites/13-chart-foundry/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 光学暗房调色台 |
| 独立台账 | TikZ / Matplotlib 出版级绘图脚本库 |
| 原型来源 | ScholarMatrix 拆解 |
| 开发端口 | `3022` |
| 虫洞接收 | `curve_fit_parameters` / `comparison_matrix_row` ← 11 CurveLab 非线性拟合示波器（curvelab） |
| 虫洞投送 | `comparison_matrix_row` → 14 综述拓扑推演与写作舱（review-lab） |

一键将拟合数据转换为符合 Nature / IEEE 双栏字号与色盲友好规范的矢量图。
一条台账记录 = **一套出版规范下的可复跑绘图脚本**：版心尺寸、字号、DPI、调色板、
figureId 与结论占位，全部从共享规范数据现算。

## 本地开发

开发端口 **3022**（`src/site.config.ts` 与 `package.json` 的 `dev` 脚本一致）：

```bash
pnpm --filter @matrixos/microsite-13-chart-foundry dev        # http://localhost:3022
pnpm --filter @matrixos/microsite-13-chart-foundry build
pnpm --filter @matrixos/microsite-13-chart-foundry typecheck  # npx tsc --noEmit
```

零 Tailwind、零外部 CDN，内网可用。`next.config.ts` 在加载时探测
`@matrixos/sdk` / `@matrixos/instrument-ui` 能否 resolve，解析不到就把 specifier 别名到
`src/lib/shims/` —— import 已按最终形态写好，包一旦就位别名自动失效。

## 数据模型

台账落在 `localStorage` 的 `mx.chart-foundry.chart-scripts` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "Nature 双栏 · 出版脚本",
        "meta": "Nature / Nature Photonics · 300 dpi · 色盲友好 是",
        "detail": "版心：89 mm（单栏）/ 183 mm（双栏）（单栏 89 mm = 3.50 in，双栏 183 mm = 7.20 in）· 字号 5–7 pt；调色板：#0C2C4D / …；脚本：fig-01-nature.py……",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                            // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                            // 站内脚本页锚点（Level_B，不冒充 Level A）
          "source_doi_or_url": "https://chart-foundry.matrixos.edu/scripts/fig-01-nature",
          "verification_level": "Level_B_Preprint"
        },
        "styleId": "nature",                   // 以下均为本站自定义字段
        "styleName": "Nature 双栏",
        "journal": "Nature / Nature Photonics",
        "columnWidth": "89 mm（单栏）/ 183 mm（双栏）",
        "fontSize": "5–7 pt",
        "dpi": 300,
        "colorBlindSafe": true,
        "palette": ["#0C2C4D", "#1B7C8C", "#57B8A8", "#E8A33D", "#C94C4C"],
        "figureId": "fig-01-nature",
        "conclusion": "待绑定数据",             // 绑定 CurveLab 参数前不出结论
        "boundModel": "",                      // 绑定后：模型名 + R²
        "boundR2": null,
        "script": "# Nature 双栏 出版脚本（chart-foundry 生成）· fig-01-nature\nimport matplotlib.pyplot as plt\n…"
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `chart-scripts.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `chart-scripts.csv`（列：图号 / 出版规范 / 期刊 / 版心 / 字号 / DPI /
  色盲友好 / 结论 / 绑定模型 / 绑定 R² / 最后修改）

## 脚本生成规则（本站的核心业务规则）

脚本里的每个数字都是**从共享规范 `CHART_STYLES` 解析出来的**，不是手抄三段 Python：

- **版心 → figsize**：`parseMm` 从「89 mm（单栏）/ 183 mm（双栏）」抽出毫米数，
  按 25.4 mm/in 换算英寸（Nature 单栏 3.50 in、双栏 7.20 in；IEEE 3.50 / 7.13 in）。
  规范写「自适应」（屏幕演示）时回退到 89 / 160 mm 双栏基准 —— 回退逻辑在代码里，不在文案里。
- **字号 → rcParams**：`parseFontSizePt` 从「5–7 pt」取 5 作为 `font.size` 基准。
- **DPI → savefig.dpi**：Nature 300 / IEEE 600 / 屏幕 150，逐字来自规范。
- **调色板 → prop_cycle**：五路色环原样进 `plt.cycler(color=[…])`，`colorBlindSafe` 同步注在输出行。

3 条演示记录 = `CHART_STYLES` 的三套规范（Nature 双栏 / IEEE Transactions / 屏幕演示），
每条都带可复跑的 `script` 字段（matplotlib，rcParams 内联规范，`savefig` 出 PDF 矢量）。

**数据输入纪律**：没有 CurveLab 投来的 `curve_fit_parameters`，脚本只画空坐标系，
`conclusion` 保持「待绑定数据」—— 绝不画假数据、绝不提前写结论。

## 虫洞契约

- **接收** `curve_fit_parameters` / `comparison_matrix_row`，来自 11 CurveLab。分流处理：
  拟合参量绑定到对应数据集的脚本上（`boundModel` / `boundR2` 落库，出图后补结论）；
  矩阵行补件用其 venue / strategy 对到本站图号上。
- **投送** `comparison_matrix_row`，发往 14 综述拓扑推演与写作舱。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "chart-foundry",
  "ledger": "TikZ / Matplotlib 出版级绘图脚本库",
  "target": "review-lab",
  "rule": "按「图-数据-结论」三元组投送；未绑定拟合参数的脚本 conclusion 保持「待绑定数据」，不编造结论",
  "scriptCount": 3,
  "boundCount": 0,
  "rows": [
    { "figureId": "fig-01-nature", "styleName": "Nature 双栏", "journal": "Nature / Nature Photonics",
      "conclusion": "待绑定数据", "sourceDoi": "https://chart-foundry.matrixos.edu/scripts/fig-01-nature",
      "boundModel": "", "boundR2": null, "palette": ["#0C2C4D", "…"] }
  ]
}
```

**投送语义**：「图-数据-结论」三元组 —— 综述写作舱按 `figureId` + `sourceDoi`
把图号绑到段落上，所以每条脚本都必须带 figureId 与结论位（未出结论就明写待绑定）。

证据锚点用站内脚本页 `https://chart-foundry.matrixos.edu/scripts/<figureId>` +
`Level_B_Preprint`（站内自存档、未经第三方复核，绝不冒充 Level A；**snake_case 四字段**，
锚点层 `additionalProperties: false`，多一个字段整个信封作废）。

**台账为空时**投送会退化为站级基线锚点（`https://chart-foundry.matrixos.edu/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=13-chart-foundry
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/13-chart-foundry-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 版心/字号/DPI/调色板的解析规则、
  matplotlib 脚本模板与投送字段映射。规范数据全部来自共享 `CHART_STYLES`，**不手抄数字**。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（光学暗房调色台，`CHART_STYLES` 直接渲染），
  由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=13 --force`（`scripts/gen-site.mjs`）
