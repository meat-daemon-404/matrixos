# 18 · 生涯多重宇宙期望决策树

> MatrixOS 微站 · 轨道 7 · 预职 · `prejob.matrixos.cc.cd` · 目录 `apps/micro-sites/18-prejob-multiverse/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 量子分岔概率光轨沙盘 |
| 独立台账 | 保研直博 / 选调考公 / 大厂 Offer 对比树 |
| 原型来源 | 预职 WorkBuddy 原型 |
| 开发端口 | `3027` |
| 虫洞接收 | `verified_cv_evidence` ← evidence-cv（证据简历工坊） |
| 虫洞投送 | `verified_cv_evidence` → evidence-cv（证据简历工坊） |

量化推演不同生涯路径未来 5 年的期望收益与风险。一条台账记录 = 一条生涯路径
（路径名 + 五年期望收益 + 三种结局的概率 + 风险等级 + 逐年轨迹 + 支撑这条推演的专业面样本）。

**本站与另外 17 站最大的不同**：期望收益与概率不是手写的模型数字，而是用
[学职平台](https://xz.chsi.com.cn/)（教育部学生服务与素质发展中心）的真实专业目录数据
做**相对校准**算出来的。校准口径见下文「期望收益从哪来」——那里也写明了
**哪些话不能说**（学职平台不提供薪资，万元量级仍是模型假设）。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-18-prejob-multiverse dev     # http://localhost:3027
pnpm --filter @matrixos/microsite-18-prejob-multiverse build
pnpm --filter @matrixos/microsite-18-prejob-multiverse typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.prejob.career-paths` 键下（`mx.<appId>.<exportName>`），信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                  // seed-NN（演示数据）或 r-<时间戳>-<序号>-<随机>（新增）
        "title": "推免直博 · 五年期望 87 万",  // 列表主标题 = 路径名 + 校准后的期望收益
        "meta": "成功 52% · 中性 35% · 失败 13% · 风险 中 · 学职校准 ×1.02",
        "detail": "保研本校直博，5 年博士毕业进入高校或研究所。学职平台专业面：130 条本科专业……",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                        // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                        // 该路径的证据锚点，投送时聚合进信封
          "source_doi_or_url": "https://xz.chsi.com.cn/speciality/detail.action?specId=woqt114tyt2flxjh",
          "verification_level": "Level_B_Preprint"
        },
        "pathId": "p1",                   // 对应 @matrixos/microsite-data 的 CAREER_PATHS
        "kind": "career-path",            // career-path（路径） / capability-input（接收到的输入）
        "expectedGain": 87,               // 校准后的五年期望收益（万元）
        "modelGain": 85,                  // 模型基准值，校准前的原始假设
        "risk": "中",
        "riskCode": "medium",             // low / medium / high
        "calibration": 1.02,              // 学职校准系数（clamp 在 0.8–1.2）
        "probabilities": { "success": 0.52, "neutral": 0.35, "fail": 0.13 },
        "modelProbabilities": { "success": 0.62, "neutral": 0.28, "fail": 0.1 },
        "trajectory": [2, 4, 6, 8, 15],   // 五年逐年收益（万元），已乘校准系数
        "modelTrajectory": [2, 4, 6, 8, 15],
        "specialityCount": 130,           // 该路径圈定的本科专业数
        "ratedCount": 87,                 // 其中有就业满意度评价的条数
        "satisfaction": 3.9,              // 票数加权的就业满意度均值
        "votes": 1111245,                 // 满意度评价总票数
        "avgOfferCount": 132.1,           // 平均开设院校数
        "realityIndex": 0.754,            // 专业面现实指数
        "caseCount": 88,                  // 学职平台职业人物案例数（行业参照）
        "scopes": ["工学/材料类", "…"],     // 圈定专业面用的「学科门类/专业类」白名单
        "topSpeciality": {                // 代表专业（评价票数最多那个），带原站回链
          "specId": "woqt114tyt2flxjh",
          "code": "080901",
          "name": "计算机科学与技术",
          "faculty": "工学",
          "category": "计算机类",
          "evlCount": 144133,
          "satisfactionRank": 4,
          "url": "https://xz.chsi.com.cn/speciality/detail.action?specId=woqt114tyt2flxjh"
        },
        "source": "学职平台 xz.chsi.com.cn（教育部学生服务与素质发展中心）",
        "statYear": 2025
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `career-paths.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `career-paths.csv`（列：路径编号 / 路径名 / 五年期望（万） / 成功概率 / 中性概率 / 失败概率 / 风险 / 学职校准系数 / 专业面样本数 / 最后修改）

## 期望收益从哪来

### 数据来源

[学职平台](https://xz.chsi.com.cn/)（教育部学生服务与素质发展中心）的公开数据快照，
落在 `src/lib/xz-data/`：

| 文件 | 内容 | 本站用不用 |
| :--- | :--- | :--- |
| `xz-specialities.json` | 1778 条专业目录（含 1036 条本科层次），带开设院校数、就业满意度四维评分与票数 | **用**（校准主数据） |
| `xz-case-stats.json` | 722 条职业人物案例的行业 / 岗位 / 省份分布 | 用（行业参照） |
| `xz-meta.json` | 采集元信息：来源、采集时间、统计年度 2025、字段覆盖率 | 用（来源标注） |
| `xz-spec-details.json` | 2.6 MB 专业详情（课程、学长建议、去向） | 不用（懒加载，见 `use-heavy-detail.ts`） |

采集口径、合规边界与回链要求见 [docs/03-xz-integration/02-compliance.md](../../../docs/03-xz-integration/02-compliance.md)：
**事实与聚合统计值可用，创作表达不整体搬运；必须标注来源、必须回链原站、不得伪装成自有内容。**
本站台账每一条 seed 的 `anchor` 都回链到该路径代表专业的原站详情页，README 与页面页脚均标注来源。

### 算法（六步，逐字对应 `tools/derive-career-calibration.mjs`）

1. **圈专业面**：每条路径按「学科门类 / 专业类」两级白名单圈定一批真实**本科**专业
   （`level` 含「本科」= 本科（普通教育）+ 本科（职业教育），共 1036 条）。
   不按整个学科门类圈 —— 门类下混着大量高职专科专业，会把口径污染掉。
   - 推免直博：工学（材料/电子信息/机械/计算机/电气/自动化/力学/仪器）+ 理学（化学/物理学/数学/生物科学）→ **130 条**
   - 头部光企研发：工学（电子信息/材料/仪器）+ 电子与信息（电子信息/通信/集成电路）+ 装备制造（自动化）+ 能源动力与材料（新能源发电工程）+ 理学（物理学）→ **68 条**
   - 选调考公：法学（法学/政治学/社会学/马克思主义理论）+ 公共管理与服务（公共管理/公共事业）+ 公安与司法（法律实务/公安管理）+ 管理学（公共管理）→ **58 条**

2. **算专业面现实指数**（三个维度，各自先归一化到 0–1，加权求和）：

   ```
   现实指数 = 0.55 × 就业满意度加权均值 / 5
            + 0.30 × log10(1 + 评价票数) / 7
            + 0.15 × 平均开设院校数 / 300
   ```

   - **就业满意度加权均值**：`Σ(rank × count) / Σcount`，用票数加权，避免 1 票 5 星把均值拉爆；
     `rank = 0` 表示该专业无人评价，直接剔除（1036 条里有 534 条有真实评价）。
   - **评价票数**取对数：票数是样本厚度，线性相加会让「票多」直接压过「满意度高」。
   - **平均开设院校数**：专业面的结构性供给广度。

3. **算校准系数**：`clamp(路径现实指数 / 全库现实指数, 0.8, 1.2)`。
   全库基准：1036 条本科专业、就业满意度加权均值 **3.86**、现实指数 **0.739**。

4. **算期望收益**：`round(模型基准 × 校准系数)`。

5. **算三种结局的概率**：`归一化(0.5 × 模型先验 + 0.5 × 就业满意度分档占比)`，
   分档规则 `rank ≥ 4.0 → success` / `3.5 ≤ rank < 4.0 → neutral` / `rank < 3.5 → fail`。

6. **算五年轨迹**：模型轨迹逐项 × 校准系数后取整。

### 结果

| 路径 | 专业面样本 | 就业满意度 | 评价票数 | 平均院校 | 现实指数 | 校准 | 模型基准 | 校准后 | 概率（成功/中性/失败） |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 推免直博 | 130（87 有评） | 3.90 | 1,111,245 | 132.1 | 0.754 | ×1.020 | 85 万 | **87 万** | 52% / 35% / 13% |
| 头部光企研发 | 68（42 有评） | 3.80 | 305,966 | 82.8 | 0.695 | ×0.940 | 120 万 | **113 万** | 59% / 30% / 11% |
| 选调考公 | 58（26 有评） | 3.66 | 239,397 | 53.9 | 0.660 | ×0.893 | 70 万 | **63 万** | 37% / 35% / 28% |

校准后的排序（113 > 87 > 63 万）与模型假设的排序（120 > 85 > 70 万）**一致**，
说明模型先验与真实专业面数据没有系统性冲突；差异体现在幅度上：
头部光企的专业面样本更窄（68 条）且就业满意度偏低（3.80），被下调 6%；
选调考公的专业面满意度最低（3.66）、分档里近半落在 `fail` 档，下调 10.7%。

### 哪些话不能说（合规红线）

- **学职平台不提供薪资与升学率字段**。所以「万元」这个量级无法被这份数据测量 ——
  它仍然来自 MatrixOS 的模型假设，学职数据只提供**相对校准**（且被 clamp 在 ±20% 内）。
  **不能声称「期望收益由学职平台真实数据算出」。**
- **`probabilities` 是代理指标**：它是「就业满意度分档占比」与模型先验的混合，
  衡量的是「这批专业的毕业生对就业的主观评价分布」，**不是真实成功率**。
- **`flow.paths`（去向占比）完全不用**。学职平台的 `paths.考研 = 7` 意思是
  「该专业 7% 的毕业生**选择了**考研」，是去向占比；决策树的 `probabilities.success`
  是模型对成功概率的估计。两者含义不同，**不可相乘、平均或互相替换**
  （`src/lib/xz-data.ts` 的注释里也明令禁止）。
- 面板上并排展示学职数据与推演结果时，两栏**不做因果连线** ——
  [docs/03-xz-integration/03-integration-implementation.md](../../../docs/03-xz-integration/03-integration-implementation.md)
  §7 第一条遗留项正是「让决策树真正消费这些数据」，本站的校准是朝这个方向的**有限**一步：
  只让数据调整相对权重，不让数据冒充绝对量级。

### 重新生成

```bash
cd apps/micro-sites/18-prejob-multiverse
node tools/derive-career-calibration.mjs           # 重新生成 src/lib/career-calibration.ts
node tools/derive-career-calibration.mjs --check   # 只比对，不一致则 exit 1（CI 用）
```

生成脚本直接 `require('@matrixos/microsite-data')` 读 `CAREER_PATHS` 的模型基准值，
**不手抄**；改 `CAREER_PATHS` 后重跑一次即可，台账数字自动跟上。

### 为什么不在运行时聚合

`src/lib/xz-data.ts` 静态 import 了 `xz-specialities.json`（918 KB）与 `xz-cases.json`（427 KB）。
如果 `site-spec.ts` 直接 import 它做聚合，会把 1.35 MB 并进 workbench 所在 chunk，
抵消 `use-heavy-detail.ts` 的懒加载优化（`packages/xz-knowledge/test/lazy-load-guard.test.ts`
专门用源码级守卫盯着这条线）。

所以：**离线生成 6 KB 常量表**（`src/lib/career-calibration.ts`），站点只读这张表，
首屏不带 xz 原始数据。这也是为什么 `site-spec.ts` 里有一个内联的 `xzSpecialityAnchor()`：
拼一个回链 URL 不值得把 1.35 MB 拖进 chunk。

## 虫洞契约

### 接收

`verified_cv_evidence` ← **evidence-cv**（17 证据简历工坊）。

`rowOfEnvelope()` 按 `envelope.payload_type` 分流：

| 收到的 `payload_type` | 落成 |
| :--- | :--- |
| `verified_cv_evidence` | 「能力画像」记录：简历版本数 / 能力证据条数 / Level-A·B·撤稿计数 |
| 其它（未登记） | 「外部推演输入」记录：按通用字段落库，**不抛错** |

分流出来的记录 `pathId` 为空串、`kind` 为 `capability-input`，所以**不会被算进路径统计**
（`pathCount` / `expectedGainRange` / `riskProfile` 都只统计 `kind === 'career-path'` 的行）。
它的作用是「挂在决策树顶部做对照」：台账与投递信封里能看清「这条推演基于哪些已验真证据」，
但**不会自动改写路径数字** —— 路径收益是模型假设，不能因为收到一条简历就被悄悄改掉。

### 投送

`verified_cv_evidence` → **evidence-cv**（17 证据简历工坊）。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "prejob",
  "ledger": "保研直博 / 选调考公 / 大厂 Offer 对比树",
  "target": "evidence-cv",
  "generatedAt": "2026-10-20T14:03:11.482Z",
  "pathCount": 3,
  "capabilityInputCount": 0,
  "expectedGainRange": { "min": 63, "max": 113 },
  "riskProfile": { "low": 2, "medium": 1, "high": 0 },
  "recommended": { /* 期望收益最高的那条路径 */ },
  "calibration": {                      // 校准口径随信封一起走，对端能看到数字是怎么来的
    "source": "学职平台 xz.chsi.com.cn（教育部学生服务与素质发展中心）",
    "homeUrl": "https://xz.chsi.com.cn/",
    "statYear": 2025,
    "collectedAt": "2026-10-20T12:22:11.728Z",
    "specialityTotal": 1778,
    "undergradTotal": 1036,
    "caseTotal": 722,
    "globalSatisfaction": 3.86,
    "globalRealityIndex": 0.739,
    "notice": "学职平台不提供薪资与升学率字段。本表只把「就业满意度 / 评价票数 / 开设院校数」用于相对校准，不构成对期望收益绝对量级的真实测量；期望收益的万元量级仍来自 MatrixOS 模型假设。"
  },
  "paths": [
    {
      "id": "seed-01",
      "pathId": "p1",
      "name": "推免直博 · 五年期望 87 万",
      "expectedGain": 87,
      "risk": "中",
      "calibration": 1.02,
      "probabilities": { "success": 0.52, "neutral": 0.35, "fail": 0.13 },
      "trajectory": [2, 4, 6, 8, 15],
      "specialityCount": 130,
      "satisfaction": 3.9,
      "topSpeciality": { "name": "计算机科学与技术", "url": "https://xz.chsi.com.cn/speciality/detail.action?specId=…" }
    }
  ],
  "capabilities": [                    // evidence-cv 的接收侧读 data.capabilities 作为能力证据
    { "name": "生涯路径可行性 · 推免直博 · 五年期望 87 万", "evidence": "五年期望 87 万 · 成功概率 52% · 风险 中", "source": "学职平台…" }
  ],
  "inputs": []
}
```

证据锚点取自每条记录的 `anchor` 字段（seed 行回链学职平台专业详情页，
接收行来自上游信封）。**台账为空时**投送会退化为站级基线锚点
（`https://prejob.matrixos.cc.cd/` + `Level_B_Preprint`），因为虫洞契约的红线是
`evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

### 本地演示信封

「接收演示」按钮用的不是通用空壳信封，而是 `demoEnvelope` 现拼的一个真 `verified_cv_evidence`：
`source_app` 为 `evidence-cv`，`versions` / `capabilities` 取自 `CV_ENTRIES`（2 条科研经历），
锚点走同一个 `toContractAnchor()` 转换（SDK 侧的 `note` 丢弃，转成契约的 snake_case）。
点一次就能看到「能力画像」分流路径真的跑通，且不会污染路径统计。

## 验收

```bash
node scripts/microsite-verify.mjs --site=18-prejob-multiverse
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/18-prejob-multiverse-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据、payload 分流、投送字段映射
- `src/lib/career-calibration.ts`：**生成产物**，由 `tools/derive-career-calibration.mjs` 从 xz 数据算出，请勿手改
- `tools/derive-career-calibration.mjs`：校准生成脚本（`--check` 可校验一致性）
- `src/lib/xz-data.ts` / `src/lib/xz-data/` / `src/lib/use-heavy-detail.ts`：学职平台数据访问层
  （数据懒加载，`packages/xz-knowledge/test/lazy-load-guard.test.ts` 有源码级守卫）
- `src/components/xz-explorer.tsx` / `src/components/anchor-panel.tsx` / `src/components/xz-resources.tsx`：
  学职数据浏览、专业锚定与「原站专题 / 职业测评目录」面板，
  挂在独立路由 `src/app/career/page.tsx`（不挂首页 —— 首页由 `scripts/wire-workbench.mjs` 统一分发）。
  三个面板都只做**结构化索引 + 原站回链**：专题摘要与测评简介属原站创作文本，故每条带链接；
  测评的题目、选项、计分规则与常模一律未采集（受著作权保护的心理测量内容）
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（量子分岔概率光轨沙盘），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。
学职平台接入的来龙去脉见 [docs/03-xz-integration/](../../../docs/03-xz-integration/)。

---

生成器：`pnpm gen:site --id=18 --force`（`scripts/gen-site.mjs`）
