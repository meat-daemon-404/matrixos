# 11 · CurveLab 非线性拟合示波器

> MatrixOS 微站 · 轨道 5 · 工坊 · `curvelab.matrixos.edu` · 目录 `apps/micro-sites/11-curvelab-fit/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 荧光示波器与阻尼旋钮 |
| 独立台账 | 实验原始数据集与 30+ 回归模型库 |
| 原型来源 | ScholarMatrix 核心 |
| 开发端口 | `3020` |
| 虫洞接收 | `comparison_matrix_row` ← 09 Matrix-Cross 跨论文对比矩阵（matrix-cross） |
| 虫洞投送 | `curve_fit_parameters` → 13 Nature 级出版图表熔炉（chart-foundry） |

内置双指数衰减、洛伦兹峰拟合等 30+ 统计模型，实时显示置信带与 R²。
一条台账记录 = **一个实验数据集 + 该数据集在 38 个候选模型里 BIC 选出的最优拟合**。

## 本地开发

开发端口 **3020**（`src/site.config.ts` 与 `package.json` 的 `dev` 脚本一致）：

```bash
pnpm --filter @matrixos/microsite-11-curvelab-fit dev        # http://localhost:3020
pnpm --filter @matrixos/microsite-11-curvelab-fit build
pnpm --filter @matrixos/microsite-11-curvelab-fit typecheck  # npx tsc --noEmit
```

零 Tailwind、零外部 CDN，内网可用。`next.config.ts` 在加载时探测
`@matrixos/sdk` / `@matrixos/instrument-ui` 能否 resolve，解析不到就把 specifier 别名到
`src/lib/shims/` —— import 已按最终形态写好，包一旦就位别名自动失效。

## 数据模型

台账落在 `localStorage` 的 `mx.curvelab.curvelab-datasets` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "TRPL-A · 钙钛矿薄膜时间分辨荧光 · 双指数衰减",
        "meta": "n=180 · 最优 双指数衰减 · R² 0.9677 · BIC -604.8 · 38 模型选 1",
        "detail": "仪器：时间相关单光子计数（TCSPC）· 激发 405 nm · 探测 780 nm；……",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                            // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                            // 原文证据锚点（snake_case，投送时聚合进信封）
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,
          "bbox": [72.5, 144, 300.25, 210.75]
        },
        "datasetId": "trpl-a",                 // 以下均为本站自定义字段
        "modelId": "exp_decay2",               // BIC 选出的最优模型 id（未选型为空串）
        "modelLabel": "双指数衰减",
        "modelCount": 38,
        "expectedModelId": "exp_decay2",       // 物理预期模型（与选型结果做对照）
        "modelMatchesExpected": true,
        "n": 180, "k": 5,                      // 样本数 / 自由参数个数
        "r2": 0.9677, "adjR2": 0.967, "bic": -604.8,
        "params": { "A": 3.2, "tau1_ns": 1.4, "B": 1.1, "tau2_ns": 5.5 },
        "paramText": "A=3.2 · τ₁=1.4 · B=1.1 · τ₂=5.5",
        "runnerUpLabel": "…", "bicGap": 14.7,  // 次优模型与 BIC 差（选型置信度）
        "r2LeaderLabel": "…", "r2LeaderR2": 0.9712,  // R² 最高者（常是过拟合的高阶多项式）
        "xRange": [0, 10], "xUnit": "ns", "yUnit": "a.u.",
        "instrument": "时间相关单光子计数（TCSPC）· 激发 405 nm · 探测 780 nm",
        "scenario": "快通道对应表面缺陷复合，慢通道对应体相辐射复合；……",
        "curve": [[0, 4.3], [0.056, 4.18]]     // 最优拟合曲线采样（投送给 13 直接出图）
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `curvelab-datasets.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `curvelab-datasets.csv`（19 列：数据集 / 仪器采集 / 样本数 / 最优模型 / 模型数 /
  参数个数 / R² / 校正 R² / BIC / 拟合参数 / 次优模型 / BIC 差 / R² 最高模型 / 预期模型 /
  与预期一致 / x 范围 / 证据等级 / DOI 来源 / 最后修改）

## 模型库与 BIC 选型（本站的核心业务规则）

台账名写着「30+ 回归模型库」，所以模型库不是文案，是**真的 38 个模型**：
多项式族 6 个（1–6 次）+ 幂律 / 对数 / 倒数 / 平方根 / 指数增长 / 单·双指数衰减 /
伸展指数（Kohlrausch）/ 阿伦尼乌斯 / 倒数指数 / 双态平衡 / 指数平台 / 高斯峰 / 洛伦兹峰 /
洛伦兹平方 / 伪 Voigt 峰 / 双曲正割平方 / 对数正态峰 / 二次峰 / 高斯累积 / 朗缪尔吸附 /
Hill 方程 / 逻辑斯蒂 / 冈珀茨 / Weibull 累积 / 玻尔兹曼双平台 / 正弦 / 阻尼正弦 / 余弦衰减 /
一阶有理函数 / 双曲线 / 幂律指数混合。

每个模型都真做最小二乘：能线性化的走正规方程（`fitBasis` + 高斯消元），非线性形状参数
（τ、中心、宽度、η、ω……）走**确定性网格** + 线性幅度求解。没有随机初始化、没有手抄参数 ——
同一份 seed 在服务端预渲染与浏览器首帧算出同一组参数（不会 React #418）。

**选型判据是 BIC（`n·ln(SSR/n) + k·ln(n)`，越小越好），不是 R²**：
多项式阶数一高，R² 必然涨 —— 6 次多项式能把双指数衰减拟合到比真模型更高的 R²，但那是过拟合。
BIC 惩罚参数个数，选出的是「解释力 / 复杂度」最划算的模型。每条记录同时带
`r2LeaderLabel`（R² 最高者）与 `bicGap`（次优差距）做对照，答辩时讲的就是这条差异。

4 条演示数据集（散点全部由共享 `curvelabPoints` / `makeDemoSeries` 现算，下表是实测导出值）：

| 数据集 | n | 最优模型 | R² | BIC | 与预期一致 |
| :--- | --: | :--- | --: | --: | :--- |
| TRPL-A · 钙钛矿薄膜时间分辨荧光 | 180 | 双指数衰减 | 0.9677 | -604.8 | ✅ |
| TRPL-B · 钝化后薄膜（长寿命样品） | 240 | 双指数衰减 | 0.9790 | -919.5 | ✅ |
| PL-峰 · 手性界面稳态荧光峰 | 200 | 洛伦兹峰 | 0.9035 | -384.0 | ✅ |
| 标定 · 探测器线性响应曲线 | 120 | 2 次多项式 | 0.9869 | -454.7 | ⚠️ 预期一次直线 —— 这正是「BIC 选二次项时检查光路饱和 / 探测器非线性」的活教材 |

## 虫洞契约

- **接收** `comparison_matrix_row`，来自 09 Matrix-Cross 跨论文对比矩阵。消费后落成一条
  「待拟合数据集」：矩阵行只提供材料 / 方法 / 工况元信息与原文锚点，**不提供原始散点** ——
  没有散点就没有拟合，绝不凭空生成参数。
- **投送** `curve_fit_parameters`，发往 13 Nature 级出版图表熔炉。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "curvelab",
  "ledger": "实验原始数据集与 30+ 回归模型库",
  "target": "chart-foundry",
  "modelLibrarySize": 38,
  "datasetCount": 4,
  "fittedCount": 4,
  "selectionRule": "BIC = n·ln(SSR/n) + k·ln(n)，越小越好（R² 只作参考，不参与排序）",
  "focused": {                          // R² 最高的那条 —— 13 号站拿它直接出图
    "id": "seed-02", "datasetId": "trpl-b", "modelId": "exp_decay2", "modelLabel": "双指数衰减",
    "n": 240, "k": 5, "r2": 0.979, "adjR2": 0.978, "bic": -919.5,
    "params": { "A": 3.2, "tau1_ns": 1.4, "B": 1.1, "tau2_ns": 5.5 },
    "curve": [[0, 4.3]]                 // 采样曲线：下游不用重新实现 38 个模型也能画线
  },
  "datasets": [ /* 逐数据集的 id / 仪器 / 模型 / n / k / R² / BIC / params / curve */ ]
}
```

证据锚点取自每条记录的 `anchor`（原文 DOI + 页码 + bbox，**snake_case 四字段** —— 锚点层
`additionalProperties: false`，多一个 `note` 整个信封就过不了契约校验；共享数据里的
camelCase 锚点在 `site-spec.ts` 逐字段转换并丢掉 `note`）。未绑定 DOI 的数据集用站内页
`https://curvelab.matrixos.edu/datasets/<slug>` + `Level_B_Preprint` 兜底，绝不冒充 Level A。

**台账为空时**投送会退化为站级基线锚点（`https://curvelab.matrixos.edu/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=11-curvelab-fit
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/11-curvelab-fit-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 38 模型注册表、BIC 选型、
  4 条演示数据集与投送字段映射。散点来自共享 `curvelabPoints(count, seed, noise)`
  （确定性 mulberry32）与 `makeDemoSeries`，**不手抄数字**。
  文件末导出 `CURVELAB_STATS`（台账名 / 数据集数 / 模型数 / 选型一致数），README 与答辩口径同源。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（荧光示波器 `OscilloscopeCanvas` + 阻尼旋钮 `DampedKnob`），
  由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=11 --force`（`scripts/gen-site.mjs`）
