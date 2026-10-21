# 07 · 证据内嵌式套磁信推演器

> MatrixOS 微站 · 轨道 4 · 星门 · `cold-email.matrixos.edu` · 目录 `apps/micro-sites/07-cold-email-lab/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致，
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 双栏红蓝对抗推演器 |
| 独立台账 | 多版本套磁信草稿与导师审阅评分 |
| 原型来源 | 星门 实机原型 |
| 开发端口 | `3016` |
| 虫洞接收 | `mentor_match_card` ← 星门·导师五维星象仪（mentor） |
|  | `curve_fit_parameters` ← CurveLab 非线性拟合示波器（curvelab） |
| 虫洞投送 | `mentor_match_card` → 太空任务式进组跟进台账（lab-kanban） |

结合导师最新代表作与学生复现实验数据，生成高回复率个性化套磁信。
一条台账记录 = **一个套磁信版本 + 红队评分 + 待修问题清单**，连同收件人画像
与引用锚点一起落库；投送时把「目标导师 + 引用证据」打包成匹配卡交给跟进台账。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-07-cold-email-lab dev     # http://localhost:3016
pnpm --filter @matrixos/microsite-07-cold-email-lab build
pnpm --filter @matrixos/microsite-07-cold-email-lab typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.cold-email.cold-email-drafts` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-02",                        // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "草案 B · 证据嵌入版",          // 列表主标题（= 草稿版本名）
        "meta": "红队 91 · 可发送 · 无待修问题 · 证据密度 100%",
        "detail": "主题：准二维钝化复现结果 + 关于进组学习的请求；收件人：张教授……",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                             // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                             // 该版本引用证据的锚点，投送时聚合进信封
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,                        // 可选，仅在共享数据带页码时出现
          "bbox": [72.5, 144, 300.25, 210.75]   // 可选，PDF 图区坐标
        },
        "draftId": "d2",                        // 共享数据里的草稿 id；外部回流为 ext-<trace>
        "subject": "准二维钝化复现结果 + 关于进组学习的请求",
        "body": "张教授您好，\n\n我是光电专业大三学生孙同学……",  // 正文原样保留换行
        "redTeamScore": 91,                     // 红队（导师视角）评分 0-100
        "redTeamIssueCount": 0,                 // 待修问题条数
        "redTeamIssues": [],                    // 待修问题原文列表
        "verdict": "可发送",                     // 可发送 / 改一版再发 / 不建议发送
        "evidenceDensity": 100,                 // 五类硬证据命中率（%）
        "evidenceHits": "DOI / 数值 / 图表引用 / 附件 / 投入承诺",
        "bodyLength": 378,                      // 正文字符数
        "recipientName": "张教授",               // 收件人画像（来自星门匹配卡）
        "recipientAffiliation": "光电国家研究中心",
        "recipientMatchScore": 94.2,
        "citedDoi": "10.1038/s41566-025-01234-5",
        "citedVenue": "Nat. Photon. 2025",
        "verificationLevel": "Level_A_Verified",
        "tipCount": 5                           // 写作要点条数（来自 EMAIL_TIPS）
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `cold-email-drafts.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `cold-email-drafts.csv`（列：版本 / 主题 / 收件人 / 红队评分 / 结论 /
  待修问题数 / 证据密度 / 证据命中 / 引用 DOI / 正文长度 / 最后修改）

## 红队口径

「红队」是导师视角的审阅者。评分与结论都从共享数据当场算出来（**不手抄**），
仪器面板与台账读的是同一份推导结果，不会出现「面板 91、台账 90」这种事。

证据密度不是形容词，而是五类**可验证信号**的命中率：

| 信号 | 正则 | 命中含义 |
| :--- | :--- | :--- |
| DOI | `/10\.\d{4,9}\//` | 正文直接给出可点开的论文标识 |
| 数值 | `/\d+\.\d+\|\d+\s*%/` | 有 R²、时间常数、效率等硬数字 |
| 图表引用 | `/Fig\.\|Table\|图\s*\d\|表\s*\d/` | 指向具体图号而非泛泛而谈 |
| 附件 | `/附[件：:]\|附件\|GitHub\|记录本/` | 给了可核验的代码 / 记录 / 图 |
| 投入承诺 | `/每周\|小时\|投入/` | 写清了能投入多少时间、干什么 |

结论阈值（`verdictOf`）：问题数 0 且密度 ≥ 60% → **可发送**；问题数 ≤ 1 且密度 ≥ 40%
→ **改一版再发**；其余 → **不建议发送**。

两条演示数据正好是反面与正面教材：`草案 A · 平铺直叙` 红队 62 分、密度 20%、3 条待修；
`草案 B · 证据嵌入版` 红队 91 分、密度 100%、无待修问题。

## 虫洞契约

- **接收** `mentor_match_card`，来自星门·导师五维星象仪（mentor）。消费后落成本站一条
  `草案 · 致 <导师名>` 的待撰写版本：收件人画像、五维评分、匹配度、代表作 DOI 一并带过来，
  学生只需要补主题与正文 —— 这正是「先有匹配卡，再写信」的流程。
- **接收** `curve_fit_parameters`，来自 CurveLab（curvelab）。拟合质量（`R²`、`tau1_ns`、
  `tau2_ns`）直接可用在证据段，落库时写进 detail 提示「拟合 R² 可直接写进证据段」。
- **投送** `mentor_match_card`，发往太空任务式进组跟进台账（lab-kanban）。投出去的
  `payload.data` 形如：

```jsonc
{
  "site": "cold-email",
  "ledger": "多版本套磁信草稿与导师审阅评分",
  "target": "lab-kanban",
  "draftCount": 2,
  "sendableCount": 1,              // 结论为「可发送」的版本数，跟进台账据此决定要不要发信
  "averageRedTeamScore": 76.5,     // 全库平均红队分（台账为空时的兜底口径）
  "bestRedTeamScore": 91,
  "bestVersion": "草案 B · 证据嵌入版",
  "recipient": {                   // 目标导师画像，来自星门匹配卡
    "name": "张教授",
    "affiliation": "光电国家研究中心",
    "matchScore": 94.2,
    "dimensions": { "activity": 92, "hIndexSlope": 88, "funding": 95,
                    "undergradFriendly": 90, "directionFit": 96 }
  },
  "tipCount": 5,
  "doiBundle": ["10.1038/s41566-025-01234-5"],
  "drafts": [
    {
      "id": "seed-02",
      "draftId": "d2",
      "version": "草案 B · 证据嵌入版",
      "subject": "准二维钝化复现结果 + 关于进组学习的请求",
      "redTeamScore": 91,
      "verdict": "可发送",
      "issueCount": 0,
      "issues": [],
      "evidenceDensity": 100,
      "citedDoi": "10.1038/s41566-025-01234-5",
      "verificationLevel": "Level_A_Verified"
    }
  ]
}
```

证据锚点取自每条草稿的 `anchor` 字段（按 DOI 去重）。**锚点是 snake_case**
（`source_doi_or_url` / `verification_level` / `pdf_page` / `bbox`），因为虫洞信封的锚点层是
`additionalProperties: false` —— 多一个 `note` 字段整个信封都过不了校验。
共享数据里的锚点是 SDK 的 camelCase 形状（`sourceDoiOrUrl` / `pdfPage` / `note`），
所以 `site-spec.ts` 里逐字段转换并**丢掉 `note`**。

`verification_level` 只取三值：`Level_A_Verified` / `Level_B_Preprint` / `Retracted_Warning`。

**台账为空时**投送会退化为站级基线锚点（`https://cold-email.matrixos.edu/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=07-cold-email-lab
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/07-cold-email-lab-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射。
  红队评分、问题条数、证据密度、正文字符数全部从 `@matrixos/microsite-data` 的
  `EMAIL_DRAFTS` 当场算出来，收件人与引用锚点取自 `MENTORS` / `PAPER_ROWS`，**不手抄**
  （手抄会出现「仪器显示 91、台账写 90」这类答辩事故）。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（双栏红蓝对抗推演器），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=07 --force`（`scripts/gen-site.mjs`）
