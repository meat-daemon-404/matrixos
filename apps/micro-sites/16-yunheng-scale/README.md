# 16 · 云衡 · 数字天平综测核算器

> MatrixOS 微站 · 轨道 6 · 云衡 · `yunheng.matrixos.edu` · 目录 `apps/micro-sites/16-yunheng-scale/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**，目录名与域名可以不一致
> （16 是 `yunheng-scale` 但域名是 `yunheng`），这是刻意的，**不要为了"对齐"改目录名**。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 精密三盘电子天平 |
| 独立台账 | 学年综测加分项与证明材料 PDF 包 |
| 原型来源 | 预职 & ScholarMatrix |
| 开发端口 | `3025` |
| 虫洞接收 | `paper_doi_bundle`、`verified_cv_evidence` ← 17 简历证据台 |
| 虫洞投送 | `verified_cv_evidence` → 17 简历证据台（`evidence-cv`） |

自动汇总科研论文、软著与竞赛记录，按高校综测细则满额配重并导出申报表。

**一条记录 = 一个综测加分项**：类别 + 申报分值 + 该项上限 + 证明材料。
申报分值、类别上限、折算依据全部取自 `YUNHENG_PANS` —— 天平上三只盘的读数和台账里的
分数同源，不会出现「仪器显示 14 分、台账写 12 分」的答辩事故。

上限（`capacity`）是本站的硬闸门：申报分值一律不得越过它。每条记录的 `detail` 都写成
**「申报 X 分 / 上限 Y 分 / 是否触顶」**的固定句式（例如
`申报 2.00 分 / 上限 3.00 分 / 未触顶（余量 1.00 分）`），触顶的项显式标注「已触顶」，
投送时下游只会拿到已核验且未越界的加分项。

> 口径提示：三盘 `value` 之和是 20.86，而仪器显示的总加分 `YUNHENG_TOTAL` 是 **18.5**。
> 两者不是一回事（仪器按综测细则折算，台账按申报分累计），本站**不另算总分去覆盖仪器读数**，
> 差额在投送 payload 的 `instrument.total_gap` 里显式给出。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-16-yunheng-scale dev        # http://localhost:3025
pnpm --filter @matrixos/microsite-16-yunheng-scale build
pnpm --filter @matrixos/microsite-16-yunheng-scale typecheck
```

## 数据模型

localStorage key：`mx.yunheng.yunheng-items`（`mx.<appId>.<exportName>`）。
落盘格式是版本化信封，`version` 不匹配时回落到默认 seed，但**不覆盖**原有数据：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T12:00:00.000Z",
  "data": {
    "rows": [
      {
        "id": "seed-03",                          // seed 行固定 seed-NN；新增行 r-<时间戳>-<序号>-<随机>
        "title": "科研双创 · 国创项目 + 一作论文（国创 +1 作论文）",
        "meta": "科研双创类 · 申报 14.00 分 / 上限 15.00 分 / 未触顶（余量 1.00 分）",
        "detail": "加分依据：国创结项（8.00 分）＋ 一作论文见刊（6.00 分），合计 14.00 分。…",
        "anchor": {                                // 虫洞锚点：snake_case，严格 4 字段，没有 note
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,
          "bbox": [72.5, 144, 300.25, 210.75]
        },
        "panId": "research",                      // 归属盘：moral / intellect / research
        "category": "科研双创",                    // = YUNHENG_PANS[].label
        "declared": 14,                           // 申报分值，来自 YUNHENG_PANS[].value
        "capacity": 15,                           // 该项上限，来自 YUNHENG_PANS[].capacity
        "headroom": 1,                            // 余量 = capacity − declared
        "capped": false,                          // 是否触顶
        "evidenceKind": "国创结项证书 + 一作论文",
        "material": "结项证书 PDF + 论文原文 PDF",
        "reviewState": "科研院验真",               // 待核验 / 院系初审通过 / 系统自动核验 / 科研院验真
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0
      }
    ]
  }
}
```

导出：

- **JSON** — 文件名 `yunheng-items.json`（UTF-8 带 BOM），内容就是上面这封信封。
- **CSV** — 文件名 `yunheng-items.csv`，列为
  `加分项, 类别, 申报分值, 该项上限, 余量, 是否触顶, 证明材料, 核验状态, 最后修改`。

## 虫洞契约

权威定义在 `specs/contracts/wormhole-envelope.schema.json`，本站条目见
`scripts/lib/microsite-contracts.mjs`。

### 接收

| 项 | 值 |
| :--- | :--- |
| payload_type | `verified_cv_evidence`（主）、`paper_doi_bundle` |
| 来源站 | 17 简历证据台（`evidence-cv`） |
| 消费后落成 | 一条「待折算」加分项：`reviewState: '待折算'`，标题前缀 `待折算 ·`，`declared` 从信封 `payload.data.items[0].declared` 读，类别由 `payload.data.panId` 决定（缺省落到科研双创盘） |

收到已验真科研证据后的人工路径：判定归属类别 → 比对该项上限 → 折算申报分值
（**越界即拒收**）→ 补齐证明材料 PDF → 回投简历证据台。

### 投送

| 项 | 值 |
| :--- | :--- |
| payload_type | `verified_cv_evidence` |
| 目标站 | 17 简历证据台（`evidence-cv`） |

`payload.data` 形状：

```jsonc
{
  "site": "yunheng",
  "ledger": "学年综测加分项与证明材料 PDF 包",
  "bundle_kind": "composite_score_evidence_bundle",
  "instrument": {
    "total": 18.5,                      // = YUNHENG_TOTAL（仪器显示值，不重算）
    "pans": 3,                          // YUNHENG_PANS.length
    "capacity_sum": 23,                 // 三盘上限之和（3 + 5 + 15）
    "declared_sum": 20.86,              // 三盘 value 之和（2 + 4.86 + 14）
    "total_gap": 2.36                   // declared_sum − total，口径差而非错误
  },
  "item_count": 4,
  "item_total": 21.86,                // 四条记录申报分值之和（2 + 4.86 + 14 + 1）
  "capped_count": 1,
  "over_cap_count": 0,                  // 越界记录数，正常恒为 0
  "by_category": [
    { "panId": "moral", "category": "德育", "declared": 3, "capacity": 3, "capped": true },
    { "panId": "intellect", "category": "智育", "declared": 4.86, "capacity": 5, "capped": false },
    { "panId": "research", "category": "科研双创", "declared": 14, "capacity": 15, "capped": false }
  ],
  "items": [
    {
      "id": "seed-03",
      "panId": "research",
      "category": "科研双创",
      "declared": 14,
      "capacity": 15,
      "capped": false,
      "overCap": false,                 // declared > capacity，即越界
      "evidenceKind": "国创结项证书 + 一作论文",
      "material": "结项证书 PDF + 论文原文 PDF",
      "reviewState": "科研院验真"
    }
  ]
}
```

证据锚点层 `payload.evidence_anchors` **取自每条记录的 `anchor` 字段**，契约红线是
`minItems: 1`。台账被清空时，投送退化为站级基线锚点 `https://yunheng.matrixos.edu/`
（`Level_B_Preprint`），并在反馈里明写「台账为空，使用站级基线锚点」—— 不会伪造一条假证据。

真实投送只在 hub iframe 内（`useHostBridge().connected === true`）发生；独立窗口打开时
只做本地演示，反馈文案是「本地演示 · 未实际投送」，不会假装虫洞通了。

## 验收

```bash
node scripts/microsite-verify.mjs --site=16-yunheng-scale
```

跑一次静态导出构建 + Playwright 九项断言：正文非空、七个 `data-testid` 齐全、
新增后计数 +1 且刷新保持、导出 JSON 真的落盘、清空归 0 且刷新仍 0、投送反馈非空、
零 console error / 零未捕获异常 / 零失败请求、390×844 无横向溢出。
截图落在 `.tmp/microsite-verify/16-yunheng-scale-{desktop,mobile}.png`。

## 结构说明

- `src/lib/site-spec.ts` —— **本站唯一手写的业务代码**：台账 schema、演示数据、投送/接收映射；
  末尾另导出 `YUNHENG_SPEC_FACTS`（分数口径常量），供 README 与答辩引用，不参与渲染
- `src/lib/sdk-facade.ts`、`src/components/site-shell.tsx`、`src/components/workbench-impl.tsx`、
  `src/components/site-workbench.tsx`、`src/app/page.tsx` —— 由 `node scripts/wire-workbench.mjs`
  从 `apps/micro-sites/shared/templates/` 分发，**勿改**（改了会被下一次分发覆盖，且破坏 18 站一致性）
- `src/components/site-instrument.tsx` —— 由 `scripts/wire-instrument.mjs` 分发（16 站是
  `YunhengBalance`，`PrecisionBalance` 三盘电子天平 + 总加分读数），**勿改**
- `src/app/globals.css` —— 站点 token（accent `#22d3ee`）
- `matrix-app.manifest.json` —— 供 hub 星轨注册，`accepts` / `emits` 与
  `scripts/lib/microsite-contracts.mjs` 必须一致
- `src/site.config.ts` —— 站点身份，来源是 `specs/microsites.json`，不要手改

完工规范全文见 [`docs/02-engineering/08-microsite-workbench.md`](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=16 --force`（`scripts/gen-site.mjs`）
