# 06 · 星门 · 导师五维星象仪

> MatrixOS 微站 · 轨道 4 · 星门 · `mentor.matrixos.cc.cd` · 目录 `apps/micro-sites/06-xingmen-mentor/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 天文星象五维雷达 |
| 独立台账 | 目标博导/硕导全景学术画像库 |
| 原型来源 | 星门 实机原型 |
| 开发端口 | `3015` |
| 虫洞接收 | `paper_doi_bundle` ← 五源跨库引文声呐站（lit-sonar）、`curve_fit_parameters` ← CurveLab |
| 虫洞投送 | `mentor_match_card` → 证据内嵌式套磁信推演器（cold-email） |

量化分析导师近 3 年活跃度、H-index 斜率、经费充足度、本科生友好度与方向契合度，
五维加权成一张匹配卡。一条台账记录 = **一位目标导师的画像卡**：五维评分、
综合匹配度、档位、推荐理由与短板提示。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-06-xingmen-mentor dev     # http://localhost:3015
pnpm --filter @matrixos/microsite-06-xingmen-mentor build
pnpm --filter @matrixos/microsite-06-xingmen-mentor typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.mentor.mentor-profiles` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                        // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "张教授 · 光电国家研究中心",      // 列表主标题（导师 + 机构）
        "meta": "光电国家研究中心 · 匹配 94.2% · 第一梯队 · 最强 方向契合度 96", // 一行摘要
        "detail": "五维：近3年活跃度 92 · H-index 斜率 88 · ……",             // 详情
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                             // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                             // 该导师代表作锚点，投送时聚合进信封
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,                        // 可选，仅在共享数据带页码时出现
          "bbox": [72.5, 144, 300.25, 210.75]   // 可选，PDF 图区坐标
        },
        "mentorId": "m1",                       // 本站自定义字段
        "affiliation": "光电国家研究中心",
        "matchScore": 94.2,                     // 仪器口径的综合匹配度
        "weightedScore": 92.2,                  // 纯五维加权复核值（与 matchScore 差 2.0）
        "tier": "第一梯队",                      // 第一梯队 / 重点跟进 / 备选
        "strongestDim": "方向契合度",
        "strongestValue": 96,
        "weakestDim": "H-index 斜率",
        "weakestValue": 88,
        "dimActivity": 92,                      // 五维拆成扁平字段，CSV 导出直接可用
        "dimHIndexSlope": 88,
        "dimFunding": 95,
        "dimUndergradFriendly": 90,
        "dimDirectionFit": 96,
        "signatureDoi": "10.1038/s41566-025-01234-5",
        "signatureVenue": "Nat. Photon. 2025",
        "signatureStrategy": "PEAI 准二维钝化",
        "verificationLevel": "Level_A_Verified",
        "recommendation": "经费与方向契合双高……",
        "gapNote": "活跃度高意味着组里节奏快……"
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `mentor-profiles.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `mentor-profiles.csv`（列：导师 / 机构 / 综合匹配 / 加权复核 / 档位 /
  近3年活跃度 / H-index斜率 / 经费充足度 / 本科生友好度 / 方向契合度 /
  代表作 DOI / 推荐理由 / 最后修改）

## 五维口径

| 维度 | 字段 | 权重 | 说明 |
| :--- | :--- | ---: | :--- |
| 近 3 年活跃度 | `activity` | 0.24 | 近三年通讯/一作产出与在研项目 |
| H-index 斜率 | `hIndexSlope` | 0.20 | 不是绝对值，是增速 —— 上升期导师更愿意带新人 |
| 经费充足度 | `funding` | 0.18 | 决定能不能给你配设备与耗材 |
| 本科生友好度 | `undergradFriendly` | 0.18 | 历史带本科生比例与反馈 |
| 方向契合度 | `directionFit` | 0.20 | 与你已复现实验的方向重合度 |

加权和即 `weightedScore`，用来**复核**仪器面板给出的 `matchScore`。两者口径不同：
`matchScore` 是星门仪器的综合评分（含方向权重外的修正项），`weightedScore` 是
纯五维线性加权和，实测差值 1.4–2.6 分（张教授 94.2 / 92.2、李教授 87.5 / 84.9、
王博导 81.3 / 79.9）—— **同向但不等值，这是设计如此**，台账如实展示两个数，
不做「凑成一样」的美化。台账里的每一个数字都由 `@matrixos/microsite-data` 的
`MENTORS` 当场算出，**不手抄**（手抄会出现「仪器显示 94.2、台账写 94」这类答辩事故）。

## 虫洞契约

- **接收** `paper_doi_bundle`，来自五源跨库引文声呐站（lit-sonar）。消费后落成一条
  `待画像 · <作者>` 条目：从 DOI 包里抽作者线索，等文献声呐回流数据把五维评分补齐。
  也接收 `curve_fit_parameters`（来自 CurveLab），用拟合 R² 判断复现证据的质量 ——
  R² 会写进条目的 `meta` 行（`拟合 R² 0.9884`），画像未完成时 `matchScore` 记为 0、
  档位为「观望」，避免拿一张空卡去投送。
- **投送** `mentor_match_card`，发往证据内嵌式套磁信推演器（cold-email）。
  投出去的 `payload.data` 形如：

```jsonc
{
  "site": "mentor",
  "ledger": "目标博导/硕导全景学术画像库",
  "target": "cold-email",
  "profileCount": 3,
  "scoredCount": 3,              // 有匹配度的画像数（0 分不计入均值）
  "libraryAverageMatch": 87.7,   // 全库平均匹配度
  "topTierCount": 1,             // 第一梯队人数
  "doiBundle": [                 // 去重后的代表作 DOI
    "10.1038/s41566-025-01234-5",
    "10.1002/adma.202401234",
    "10.1021/jacs.4c0112"
  ],
  "profiles": [
    {
      "id": "seed-01",
      "mentorId": "m1",
      "name": "张教授 · 光电国家研究中心",
      "affiliation": "光电国家研究中心",
      "matchScore": 94.2,
      "weightedScore": 92.2,
      "tier": "第一梯队",
      "dimensions": { "activity": 92, "hIndexSlope": 88, "funding": 95,
                      "undergradFriendly": 90, "directionFit": 96 },
      "strongest": "方向契合度",
      "weakest": "H-index 斜率",
      "signatureDoi": "10.1038/s41566-025-01234-5",
      "verificationLevel": "Level_A_Verified",
      "recommendation": "……",
      "gapNote": "……"
    }
  ]
}
```

证据锚点取自每条画像的 `anchor` 字段，指向该导师的代表作 DOI。
**锚点是 snake_case**（`source_doi_or_url` / `verification_level` / `pdf_page` / `bbox`），
因为虫洞信封的锚点层是 `additionalProperties: false` —— 多一个 `note` 字段整个信封
都过不了校验。共享数据里的锚点是 SDK 的 camelCase 形状（`sourceDoiOrUrl` / `pdfPage` /
`note`），所以 `site-spec.ts` 里逐字段转换并**丢掉 `note`**。

`verification_level` 只取三值：`Level_A_Verified` / `Level_B_Preprint` / `Retracted_Warning`。

**台账为空时**投送会退化为站级基线锚点（`https://mentor.matrixos.cc.cd/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=06-xingmen-mentor
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/06-xingmen-mentor-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射。
  五维评分、加权复核、档位、代表作映射全部从 `MENTORS` / `PAPER_ROWS` 推导。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（天文星象五维雷达），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=06 --force`（`scripts/gen-site.mjs`）
