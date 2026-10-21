# 05 · 五源跨库引文声呐站

> MatrixOS 微站 · 轨道 3 · 情报 · `lit-sonar.matrixos.cc.cd` · 目录 `apps/micro-sites/05-lit-sonar/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致，
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 引力透镜拓扑图 |
| 独立台账 | 课题组专题文献收藏夹与引文树 |
| 原型来源 | ScholarMatrix 拆解 |
| 开发端口 | `3014` |
| 虫洞接收 | `paper_doi_bundle` ← 专利雷达（pat-hot） |
| 虫洞投送 | `paper_doi_bundle` → 跨库引文对齐（matrix-cross） |

聚合 OpenAlex / arXiv / PubMed / Crossref / Semantic Scholar 五源索引，
可视化呈现开山鼻祖与最新演进。
一条台账记录 = **一个专题文献收藏夹**，连同该夹的引文树摘要（节点数、种子文献、
总被引、五源覆盖情况）一起落库。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-05-lit-sonar dev     # http://localhost:3014
pnpm --filter @matrixos/microsite-05-lit-sonar build
pnpm --filter @matrixos/microsite-05-lit-sonar typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.lit-sonar.lit-collections` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "钙钛矿钝化 · 机理主脉",        // 列表主标题
        "meta": "3 节点 · 种子 Kojima 2009 · 总被引 9,380 · 五源 5/5", // 一行摘要
        "detail": "覆盖 Kojima 2009 / Miyata 2015 / Lee 2018（2009–2018）；……", // 详情
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                            // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                            // 该收藏夹的引文锚点，投送时聚合进信封
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,                       // 可选，仅在共享数据带页码时出现
          "bbox": [72.5, 144, 300.25, 210.75]  // 可选，PDF 图区坐标
        },
        "topic": "准二维钝化 / 缺陷钝化机理",     // 本站自定义字段：专题名
        "status": "已归档",                     // 已归档 / 在读 / 待读
        "nodeIds": ["n2", "n1", "n3"],          // 该夹覆盖的引文树节点（跨夹可重叠）
        "nodeCount": 3,                         // 引文树节点数
        "nodeLabels": ["Kojima 2009", "Miyata 2015", "Lee 2018"],
        "seminalLabel": "Kojima 2009",          // 种子文献（seminal 节点里被引最高者）
        "seminalYear": 2009,
        "totalCitations": 9380,                 // 夹内节点被引之和
        "yearSpan": "2009–2018",
        "edgeCount": 2,                         // 夹内引文关系条数
        "edgeSummary": "extends 2",             // extends / cites / refutes 计数
        "sourcesCovered": 5,                    // 五源覆盖数（数出来的，不是写死的）
        "sourcesTotal": 5,
        "primarySource": "OpenAlex",            // 索引量最大的源
        "primarySourceSharePct": 34,            // 主源占五源索引百分比
        "representativeDoi": "10.1038/s41566-025-01234-5",
        "representativeVenue": "Nat. Photon. 2025",
        "representativeStrategy": "PEAI 准二维钝化",
        "verificationLevel": "Level_A_Verified"
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `lit-collections.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `lit-collections.csv`（列：收藏夹 / 专题 / 状态 / 节点数 / 种子文献 /
  总被引 / 年份跨度 / 五源覆盖 / 代表文献 DOI / 校验等级 / 说明 / 最后修改）

## 虫洞契约

- **接收** `paper_doi_bundle`，来自专利雷达（pat-hot）。消费后落成本站一条
  `待读 · 前沿论文包 NN 篇` 的收藏夹，把对方 DOI 包里的论文当作待入树的候选节点 ——
  专利雷达关心的是「这项专利引了哪些论文」，本站关心的正是「这些论文长成一棵什么树」。
- **投送** `paper_doi_bundle`，发往跨库引文对齐（matrix-cross）。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "lit-sonar",
  "ledger": "课题组专题文献收藏夹与引文树",
  "target": "matrix-cross",
  "collectionCount": 3,          // 收藏夹条数
  "doiCount": 3,                 // 去重后的代表文献 DOI 数
  "doiBundle": [                 // 可直接检索的 DOI 串（已去重）
    "10.1038/s41566-025-01234-5",
    "10.1002/adma.202401234",
    "10.1021/jacs.4c0112"
  ],
  "sourceIndex": [               // 五源索引随包带上，目标站不必回查本站
    { "source": "openalex", "label": "OpenAlex", "records": 2840 },
    { "source": "arxiv", "label": "arXiv", "records": 1920 },
    { "source": "pubmed", "label": "PubMed", "records": 640 },
    { "source": "crossref", "label": "Crossref", "records": 1740 },
    { "source": "semantic", "label": "Semantic Scholar", "records": 1210 }
  ],
  "collections": [
    {
      "id": "seed-01",
      "title": "钙钛矿钝化 · 机理主脉",
      "topic": "准二维钝化 / 缺陷钝化机理",
      "status": "已归档",
      "nodeCount": 3,
      "totalCitations": 9380,
      "seminal": "Kojima 2009",
      "yearSpan": "2009–2018",
      "edgeCount": 2,
      "representativeDoi": "10.1038/s41566-025-01234-5",
      "verificationLevel": "Level_A_Verified",
      "nodeIds": ["n2", "n1", "n3"]
    }
  ]
}
```

证据锚点取自每条收藏夹的 `anchor` 字段。**锚点是 snake_case**（`source_doi_or_url` /
`verification_level` / `pdf_page` / `bbox`），因为虫洞信封的锚点层是
`additionalProperties: false` —— 多一个 `note` 字段整个信封都过不了校验。
共享数据里的锚点是 SDK 的 camelCase 形状（`sourceDoiOrUrl` / `pdfPage` / `note`），
所以 `site-spec.ts` 里逐字段转换并**丢掉 `note`**。

`verification_level` 只取三值：`Level_A_Verified` / `Level_B_Preprint` / `Retracted_Warning`。

**台账为空时**投送会退化为站级基线锚点（`https://lit-sonar.matrixos.cc.cd/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=05-lit-sonar
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/05-lit-sonar-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射。
  数值全部从 `@matrixos/microsite-data` 的 `CITATION_NODES` / `CITATION_EDGES` /
  `CITATION_SOURCES` 当场算出来，**不手抄**（手抄会出现「仪器显示 94.2、台账写 94」这类答辩事故）。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（引力透镜拓扑图），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=05 --force`（`scripts/gen-site.mjs`）
