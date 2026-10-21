# 17 · 区块链级学术证据简历工坊

> MatrixOS 微站 · 轨道 7 · 预职 · `evidence-cv.matrixos.edu` · 目录 `apps/micro-sites/17-evidence-cv/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 绿标验真数字徽章台 |
| 独立台账 | 多版本保研/求职证据级简历库 |
| 原型来源 | 预职 WorkBuddy 原型 |
| 开发端口 | `3026` |
| 虫洞接收 | `paper_doi_bundle`、`comparison_matrix_row`、`curve_fit_parameters`、`mentor_match_card`、`verified_cv_evidence`（**五类全收**，主来源 retract-radar） |
| 虫洞投送 | `verified_cv_evidence` → prejob 生涯多重宇宙决策树 |

简历中每一条科研经历均嵌入可点击验真的 DOI 锚点、拟合图与代码仓库哈希。
一条台账记录 = 一个简历版本（版本名 + 用途 + 该版本收录的经历条目 + 每条条目的证据锚点）。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-17-evidence-cv dev     # http://localhost:3026
pnpm --filter @matrixos/microsite-17-evidence-cv build
pnpm --filter @matrixos/microsite-17-evidence-cv typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.evidence-cv.cv-versions` 键下（`mx.<appId>.<exportName>`），信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                  // seed-NN（演示数据）或 r-<时间戳>-<序号>-<随机>（新增）
        "title": "保研版 v1 · 学术证据优先",  // 列表主标题 = 版本名
        "meta": "推免 / 直博申请 · 2 条经历 · 2 个证据锚点 · Level-A 2",  // 一行摘要
        "detail": "第一屏就放已验真的论文锚点与软著仓库哈希……",          // 详情
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                        // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                        // 该版本的证据锚点，投送时聚合进信封
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,
          "bbox": [72.5, 144, 300.25, 210.75]
        },
        "version": "v1",                  // 本站自定义字段：版本号
        "purpose": "推免 / 直博申请",        // 用途
        "evidenceType": "verified_cv_evidence",
        "entryCount": 2,                  // 该版本收录的经历条数
        "anchorCount": 2,                 // 该版本收录的证据锚点总数
        "levelA": 2,                      // 三个校验等级的分项计数
        "levelB": 0,
        "retracted": 0,
        "entries": [                      // 该版本收录的经历，每条自带锚点数组
          {
            "entryId": "cv1",
            "title": "钙钛矿太阳能电池界面钝化研究",
            "role": "第一作者",
            "period": "2025.03 - 2025.09",
            "anchors": [
              {
                "source_doi_or_url": "10.1038/s41566-025-01234-5",
                "verification_level": "Level_A_Verified",
                "pdf_page": 4,
                "bbox": [72.5, 144, 300.25, 210.75]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `cv-versions.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `cv-versions.csv`（列：简历版本 / 用途 / 条目数 / 证据锚点数 / Level-A / Level-B / 撤稿警示 / 证据类型 / 说明 / 最后修改）

### 锚点形状：为什么本站要转一道

`@matrixos/microsite-data` 的 `CV_ENTRIES` / `PAPER_ROWS` 里的锚点是 **SDK 的 camelCase 形状**
（`sourceDoiOrUrl` / `pdfPage` / `bbox` / `verificationLevel` / **`note`**），
而虫洞信封契约（`specs/contracts/wormhole-envelope.schema.json`）要 **snake_case**，
且锚点层是 `additionalProperties: false` —— **多带一个 `note` 字段，整个信封就过不了校验**。

所以 `site-spec.ts` 里有一个 `toContractAnchor()` 逐字段挑出来重建，
`note` 一律丢弃；接收侧还有 `sanitizeAnchor()` 把外部锚点再洗一遍
（非法 `verification_level` 退化为 `Level_B_Preprint`，`bbox` 不是 4 个数就丢掉）。

### 演示数据从哪来

`seed` 三条不是手写的，是引用 `CV_ENTRIES`（2 条科研经历）与 `PAPER_ROWS`（跨论文对比矩阵）
算出来的：

| 版本 | 收录条目 | 来源 |
| :--- | :--- | :--- |
| `v1` 保研版 · 学术证据优先 | `cv1`、`cv2` | `CV_ENTRIES` 全量 |
| `v2` 求职版 · 学术 + 工程全量 | `cv1`、`cv2` + `PAPER_ROWS` 里非 Level-A 的行 | `CV_ENTRIES` + `PAPER_ROWS` |
| `v3` 套磁版 · 方向精准匹配 | `cv1` + 在投预印本 | `CV_ENTRIES` + `PAPER_ROWS` |

条目数、锚点数、Level-A/B 计数全部由数据现算（`entryCount` / `anchorCount` / `levelA` / `levelB`），
改数据后台账会跟着变，不会出现「面板显示 2 条、台账写 3 条」这类答辩事故。

## 虫洞契约

### 接收（五类全收）

manifest 的 `accepts` 是五类全收，面板上展示的 `accept.payloadType` 取第一个 `paper_doi_bundle`，
但 `rowOfEnvelope()` 按 `envelope.payload_type` **分流处理全部五种**：

| 收到的 `payload_type` | 落成 | 从哪来 |
| :--- | :--- | :--- |
| `paper_doi_bundle` | 「论文证据」条目，详情列出 DOI 列表 | lit-sonar / retract-radar |
| `comparison_matrix_row` | 「对比矩阵证据」条目，详情列出对比的期刊/策略 | matrix-cross / chart-foundry |
| `curve_fit_parameters` | 「拟合参数证据」条目，带最优 `R²` | curvelab |
| `mentor_match_card` | 「导师匹配证据」条目，带导师名与匹配度 | mentor / cold-email |
| `verified_cv_evidence` | 「简历证据」条目，带版本数 / GPA | gpa / spark-teaming / yunheng / prejob |
| 其它（未登记） | 「外部证据」条目，按通用字段落库 | 兜底，**不抛错** |

分流出来的每条记录都会带 `evidenceType` / `sourceApp` / `traceId` / `receivedAt` 与三个等级计数，
证据锚点经过 `sanitizeAnchor()` 清洗后挂到 `anchor` 上。回调是纯函数：不改入参、不抛错。

### 投送

`verified_cv_evidence` → **prejob**（生涯多重宇宙决策树）。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "evidence-cv",
  "ledger": "多版本保研/求职证据级简历库",
  "target": "prejob",
  "generatedAt": "2026-10-20T14:03:11.482Z",
  "versionCount": 3,
  "entryCount": 4,                       // 去重后的条目数：同一篇论文在 3 个版本里只算 1 条
  "anchorCount": 5,
  "verification": { "levelA": 4, "levelB": 1, "retracted": 0 },
  "acceptedTypes": [                     // 五类接收覆盖度，便于对端判断证据结构
    { "type": "paper_doi_bundle", "label": "论文证据", "count": 0 },
    { "type": "comparison_matrix_row", "label": "对比矩阵证据", "count": 0 },
    { "type": "curve_fit_parameters", "label": "拟合参数证据", "count": 0 },
    { "type": "mentor_match_card", "label": "导师匹配证据", "count": 0 },
    { "type": "verified_cv_evidence", "label": "简历证据", "count": 3 }
  ],
  "versions": [
    {
      "id": "seed-01",
      "title": "保研版 v1 · 学术证据优先",
      "version": "v1",
      "purpose": "推免 / 直博申请",
      "evidenceType": "verified_cv_evidence",
      "entryCount": 2,
      "anchorCount": 2,
      "verification": { "levelA": 2, "levelB": 0, "retracted": 0 },
      "entries": [
        {
          "entryId": "cv1",
          "title": "钙钛矿太阳能电池界面钝化研究",
          "role": "第一作者",
          "period": "2025.03 - 2025.09",
          "anchorCount": 1,
          "anchors": [{ "source_doi_or_url": "10.1038/s41566-025-01234-5", "verification_level": "Level_A_Verified", "pdf_page": 4, "bbox": [72.5, 144, 300.25, 210.75] }]
        }
      ]
    }
  ]
}
```

证据锚点取自每条记录的 `anchor` 字段（seed 行来自 `CV_ENTRIES` / `PAPER_ROWS`，接收行来自上游信封）。
**台账为空时**投送会退化为站级基线锚点（`https://evidence-cv.matrixos.edu/` + `Level_B_Preprint`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

### 本地演示信封

「接收演示」按钮用的不是通用空壳信封，而是 `demoEnvelope` 现拼的一个真 `paper_doi_bundle`：
`source_app` 为 `lit-sonar`，`doiBundle` 取自 `PAPER_ROWS` 的三篇代表文献，锚点走同一个
`toContractAnchor()` 转换（`note` 丢弃）。点一次就能看到「论文证据」分流路径真的跑通。

## 验收

```bash
node scripts/microsite-verify.mjs --site=17-evidence-cv
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/17-evidence-cv-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据、五类 payload 分流、投送字段映射
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（绿标验真数字徽章台），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=17 --force`（`scripts/gen-site.mjs`）
