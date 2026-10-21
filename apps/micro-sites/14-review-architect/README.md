# 14 · 综述拓扑推演与写作舱

> MatrixOS 微站 · 轨道 5 · 工坊 · `review-lab.matrixos.cc.cd` · 目录 `apps/micro-sites/14-review-architect/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 章节逻辑流建筑台 |
| 独立台账 | 文献综述大纲与段落证据绑定库 |
| 原型来源 | ScholarMatrix 拆解 |
| 开发端口 | `3023` |
| 虫洞接收 | `paper_doi_bundle`、`comparison_matrix_row` ← 10 复现核验舱 / 13 图表熔炉 |
| 虫洞投送 | `paper_doi_bundle` → 15 撤稿深海声呐与伦理合规仪 |

将对比矩阵中的多篇文献按技术流派自动聚类，生成带精准引文的综述初稿。

**一条记录 = 一个综述章节**：章节标题（来自 `REVIEW_OUTLINE` 大纲树）+ 归属流派（来自
`REVIEW_CLUSTERS` 拓扑聚类）+ 绑定的证据段落（页码 / PDF 坐标 / 图号，来自 `PAPER_ROWS`）
+ 代表性 DOI。章节编号由大纲树的 `level` 递推（`1`、`1.1`、`2`…），不手写。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-14-review-architect dev        # http://localhost:3023
pnpm --filter @matrixos/microsite-14-review-architect build
pnpm --filter @matrixos/microsite-14-review-architect typecheck
```

## 数据模型

localStorage key：`mx.review-lab.review-outlines`（`mx.<appId>.<exportName>`）。
落盘格式是版本化信封，`version` 不匹配时回落到默认 seed，但**不覆盖**原有数据
（用户数据不会被一次版本升级抹掉）：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T12:00:00.000Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                          // seed 行固定 seed-NN；新增行 r-<时间戳>-<序号>-<随机>
        "title": "1.1 准二维钝化：范式与局限",      // 章节编号 + 大纲标题
        "meta": "准二维钝化流派 · 12 篇 · 被引 1840 · 代表 DOI 10.1038/…",
        "detail": "段落证据 O4 · 绑定原文第 4 页 Fig. 2b（bbox [...]）。摘录：「…」",
        "anchor": {                                // 虫洞锚点：snake_case，严格 4 字段，没有 note
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,
          "bbox": [72.5, 144, 300.25, 210.75]
        },
        "section": "o4",                          // 大纲节点 id
        "sectionNo": "1.1",                       // 章节编号（由 level 递推）
        "level": 2,                               // 1 = 一级章节，2 = 二级章节
        "school": "准二维钝化流派",                // 归属流派
        "schoolId": "c1",
        "doi": "10.1038/s41566-025-01234-5",      // 代表性 DOI
        "boundDois": ["10.1038/s41566-025-01234-5"], // 本节引用的全部 DOI（投送时去重打包）
        "paragraph": "准二维层把界面缺陷密度由 …", // 绑定的原文段落摘录
        "figureRef": "Fig. 2b",                   // 图号 / 表号 / 段落号
        "verification": "Level_A_Verified",       // 与 anchor.verification_level 同步
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0
      }
    ]
  }
}
```

导出：

- **JSON** — 文件名 `review-outlines.json`（UTF-8 带 BOM），内容就是上面这封信封。
- **CSV** — 文件名 `review-outlines.csv`，列为
  `章节编号, 章节标题, 层级, 归属流派, 绑定证据段落, 代表性 DOI, 核验等级, 最后修改`。

## 虫洞契约

权威定义在 `specs/contracts/wormhole-envelope.schema.json`，本站条目见
`scripts/lib/microsite-contracts.mjs`。

### 接收

| 项 | 值 |
| :--- | :--- |
| payload_type | `comparison_matrix_row`（主）、`paper_doi_bundle` |
| 来源站 | 13 图表熔炉、10 复现核验舱 |
| 消费后落成 | 一条「待绑定段落」章节：`section: 'inbox'`、`school: '待归类流派'`，标题前缀 `待绑定段落 ·` |

收到矩阵行后的人工路径：选中对应流派 → 把矩阵行的图号与 PDF 坐标绑到章节段落 →
绑定完成再投送给撤稿声呐。未绑定段落的章节投送时只带大纲页锚点，下游撤稿体检会把它
标成「待补锚」。

### 投送

| 项 | 值 |
| :--- | :--- |
| payload_type | `paper_doi_bundle` |
| 目标站 | 15 撤稿深海声呐与伦理合规仪（`retract-radar`） |

`payload.data` 形状：

```jsonc
{
  "site": "review-lab",
  "ledger": "文献综述大纲与段落证据绑定库",
  "bundle_kind": "review_outline_doi_bundle",
  "outlineNodes": 7,                    // REVIEW_OUTLINE.length
  "clusters": [                          // 三个流派的拓扑聚类
    {
      "id": "c1",
      "school": "准二维钝化流派",
      "papers": 12,
      "citations": 1840,
      "representative_doi": "10.1038/s41566-025-01234-5",
      "key_claim": "引入大有机阳离子形成准二维层，抑制界面非辐射复合"
    }
  ],
  "sectionCount": 4,
  "doi_count": 3,
  "dois": ["10.1038/s41566-025-01234-5", "10.1002/adma.202401234", "10.1021/jacs.4c0112"],
  "sections": [
    {
      "id": "seed-01",
      "section": "o4",
      "sectionNo": "1.1",
      "level": 2,
      "title": "1.1 准二维钝化：范式与局限",
      "school": "准二维钝化流派",
      "doi": "10.1038/s41566-025-01234-5",
      "boundDois": ["10.1038/s41566-025-01234-5"],
      "paragraph": "准二维层把界面缺陷密度由 …",
      "figureRef": "Fig. 2b",
      "verification": "Level_A_Verified"
    }
  ]
}
```

证据锚点层 `payload.evidence_anchors` **取自每条记录的 `anchor` 字段**（不是从
`payload.data` 里凑），契约红线是 `minItems: 1`。台账被清空时，投送退化为站级基线锚点
`https://review-lab.matrixos.cc.cd/`（`Level_B_Preprint`），并在反馈里明写
「台账为空，使用站级基线锚点」—— 不会伪造一条假证据。

真实投送只在 hub iframe 内（`useHostBridge().connected === true`）发生；独立窗口打开时
只做本地演示，反馈文案是「本地演示 · 未实际投送」，不会假装虫洞通了。

## 验收

```bash
node scripts/microsite-verify.mjs --site=14-review-architect
```

跑一次静态导出构建 + Playwright 九项断言：正文非空、七个 `data-testid` 齐全、
新增后计数 +1 且刷新保持、导出 JSON 真的落盘、清空归 0 且刷新仍 0、投送反馈非空、
零 console error / 零未捕获异常 / 零失败请求、390×844 无横向溢出。
截图落在 `.tmp/microsite-verify/14-review-architect-{desktop,mobile}.png`。

## 结构说明

- `src/lib/site-spec.ts` —— **本站唯一手写的业务代码**：台账 schema、演示数据、投送/接收映射
- `src/lib/sdk-facade.ts`、`src/components/site-shell.tsx`、`src/components/workbench-impl.tsx`、
  `src/components/site-workbench.tsx`、`src/app/page.tsx` —— 由 `node scripts/wire-workbench.mjs`
  从 `apps/micro-sites/shared/templates/` 分发，**勿改**（改了会被下一次分发覆盖，且破坏 18 站一致性）
- `src/components/site-instrument.tsx` —— 由 `scripts/wire-instrument.mjs` 分发（14 站是 `ReviewLab`
  聚类卡片 + 大纲树），**勿改**
- `src/app/globals.css` —— 站点 token（accent `#10b981`）
- `matrix-app.manifest.json` —— 供 hub 星轨注册，`accepts` / `emits` 与
  `scripts/lib/microsite-contracts.mjs` 必须一致
- `src/site.config.ts` —— 站点身份，来源是 `specs/microsites.json`，不要手改

完工规范全文见 [`docs/02-engineering/08-microsite-workbench.md`](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=14 --force`（`scripts/gen-site.mjs`）
