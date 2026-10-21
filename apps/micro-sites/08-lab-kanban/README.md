# 08 · 太空任务式进组跟进台账

> MatrixOS 微站 · 轨道 4 · 星门 · `lab-kanban.matrixos.cc.cd` · 目录 `apps/micro-sites/08-lab-kanban/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致，
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 航天任务控制看板 |
| 独立台账 | 已发信→已读→待面试→已进组状态机 |
| 原型来源 | 星门 实机原型 |
| 开发端口 | `3017` |
| 虫洞接收 | `mentor_match_card` ← 07 证据内嵌式套磁信推演器（cold-email） |
| 虫洞投送 | `verified_cv_evidence` → 17 区块链级学术证据简历工坊（evidence-cv） |

全周期追踪套磁与暑研面试节点，支持一键同步至手机端强提醒。
一条台账记录 = **一位导师的跟进流水**：当前处在状态机的哪一级、走过的时间线、
下一合法跃迁与下一步动作，连同该导师的五维匹配度与代表作证据锚点一起落库。

## 本地开发

开发端口 **3017**（`src/site.config.ts` 与 `package.json` 的 `dev` 脚本一致）：

```bash
pnpm --filter @matrixos/microsite-08-lab-kanban dev        # http://localhost:3017
pnpm --filter @matrixos/microsite-08-lab-kanban build
pnpm --filter @matrixos/microsite-08-lab-kanban typecheck  # npx tsc --noEmit
```

零 Tailwind、零外部 CDN，内网可用。`next.config.ts` 在加载时探测
`@matrixos/sdk` / `@matrixos/instrument-ui` 能否 resolve，解析不到就把 specifier 别名到
`src/lib/shims/` —— import 已按最终形态写好，包一旦就位别名自动失效。

## 数据模型

台账落在 `localStorage` 的 `mx.lab-kanban.lab-pipeline` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "M-01 · 李教授 · 量子光学",     // 列表主标题（任务代号 + 导师 + 方向）
        "meta": "已建档 · P1 · 待办 · 匹配 87.5% · 第 1/5 阶段",  // 一行摘要
        "detail": "状态机 已建档 ◉ → 已发信 ○ → ……",              // 详情（状态机全链路）
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                            // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                            // 该流水的证据锚点，投送时聚合进信封
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,                       // 可选，仅在共享数据带页码时出现
          "bbox": [72.5, 144, 300.25, 210.75]  // 可选，PDF 原文坐标
        },
        "taskId": "t1",                        // 本站自定义字段：看板卡片 id
        "mentorName": "李教授",
        "mentorAffiliation": "物理系 · 量子光学",
        "direction": "量子光学",
        "stage": "queued",                     // 状态机当前阶段 id
        "stageIndex": 0,                       // 阶段序号（0 起）
        "stageTitle": "已建档",
        "stageSubtitle": "Drafted",
        "priority": "P1",
        "tags": ["待办"],
        "due": "",
        "nextStage": "已发信",                  // 下一合法跃迁（终态为空串）
        "nextAction": "复核五维画像与代表作，起草首封套磁信……",
        "timeline": "已建档 ◉ → 已发信 ○ → 已读待复 ○ → 待面试 ○ → 已进组 ○",
        "passedStages": 0,
        "remainingStages": 4,
        "wipUsed": 1,                          // 该阶段当前占用（对应列的 wipLimit）
        "wipLimit": 0,
        "terminal": false,                     // 是否已到「已进组」终态
        "matchScore": 87.5,
        "verificationLevel": "Level_A_Verified",
        "evidenceSource": "10.1038/s41566-025-01234-5",
        "deliverable": "尚未进组，暂不可投送",
        "missionCode": "XINGMEN-2026"
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `lab-pipeline.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `lab-pipeline.csv`（列：任务代号 / 导师 / 方向 / 当前阶段 / 阶段序号 / 优先级 /
  标签 / 五维匹配 / 下一合法跃迁 / 下一步动作 / 证据等级 / 最后修改）

## 状态机（本站的核心业务规则）

阶段序由 `KANBAN_COLUMNS` 定义，**只能逐级推进**：

```
已建档(queued) → 已发信(sent) → 已读待复(read) → 待面试(interview) → 已进组(joined)
```

- 看板组件的 `onTaskMove` 是受控的，调用方返回 `false` 即拒绝非法跃迁 —— 跳级不成立。
- 台账的每条 `detail` 都写死「当前阶段 → 下一合法跃迁」，与看板列共用同一份
  `KANBAN_COLUMNS`，不会出现「看板卡片在已进组、台账还停在已发信」。
- 「已读待复」列带 `wipLimit: 3`，列头在超限时转 amber；「已进组」列 `locked: true`（终态）。
- 五个阶段的下一步动作各不相同（发信 → 查回执 → 补跟进信 → 交研究计划 → 归档进组材料），
  写的是可验收的动作，不是「继续跟进」这类套话。

## 虫洞契约

- **接收** `mentor_match_card`，来自 07 证据内嵌式套磁信推演器（cold-email）。消费后
  **自动开一条「已发信」状态**：导师画像（姓名 / 单位 / 五维匹配度）、匹配卡带的 DOI
  一并落成跟进流水，之后只能逐级推进到已读待复 → 待面试 → 已进组。
- **投送** `verified_cv_evidence`，发往 17 区块链级学术证据简历工坊（evidence-cv）。
  投出去的 `payload.data` 形如：

```jsonc
{
  "site": "lab-kanban",
  "ledger": "已发信→已读→待面试→已进组状态机",
  "target": "evidence-cv",
  "missionCode": "XINGMEN-2026",
  "stageModel": [                        // 状态机随包带上：下游可自行判断证据是否真到终态
    { "id": "queued", "title": "已建档", "subtitle": "Drafted", "wipLimit": 0, "locked": false },
    { "id": "sent", "title": "已发信", "subtitle": "Sent", "wipLimit": 0, "locked": false },
    { "id": "read", "title": "已读待复", "subtitle": "Awaiting", "wipLimit": 3, "locked": false },
    { "id": "interview", "title": "待面试", "subtitle": "Interview", "wipLimit": 0, "locked": false },
    { "id": "joined", "title": "已进组", "subtitle": "Joined", "wipLimit": 0, "locked": true }
  ],
  "pipelineCount": 5,
  "joinedCount": 1,
  "joinedRate": 20,
  "stageCounts": [{ "stage": "queued", "title": "已建档", "count": 1, "wipLimit": 0 }, "…"],
  "joinedEvidence": [                    // 只有终态流水才是能写进简历的科研经历
    {
      "id": "seed-05",
      "taskId": "t5",
      "mentor": "王博导",
      "affiliation": "超快激光实验室",
      "direction": "超快激光",
      "evidenceSource": "10.1021/jacs.4c0112",
      "verificationLevel": "Level_B_Preprint",
      "deliverable": "进组材料归档 + 首周任务清单（可投送 verified_cv_evidence）",
      "detail": "……"
    }
  ],
  "pipeline": [{ "id": "…", "stage": "sent", "nextStage": "已读待复", "nextAction": "…", "…": "…" }]
}
```

**投送语义**：`joinedEvidence` 只装「已进组」终态的流水 —— 只有真进组才是可写进简历的
科研经历；完整流水线放在 `pipeline` 里供下游追溯，`stageCounts` 给出各阶段在办量。

证据锚点取自每条流水的 `anchor` 字段，**锚点是 snake_case**
（`source_doi_or_url` / `verification_level` / `pdf_page` / `bbox`），因为虫洞信封的锚点层是
`additionalProperties: false` —— 多一个 `note` 字段整个信封都过不了校验。
共享数据里的锚点是 SDK 的 camelCase 形状（`sourceDoiOrUrl` / `pdfPage` / `note`），
所以 `site-spec.ts` 里逐字段转换并**丢掉 `note`**。
`verification_level` 只取三值：`Level_A_Verified` / `Level_B_Preprint` / `Retracted_Warning`。

没有代表作 DOI 的流水（星门未覆盖的导师、新建草稿）用站内流水页兜底：
`https://lab-kanban.matrixos.cc.cd/pipeline/<taskId>` + `Level_B_Preprint`（未双验，绝不冒充 Level A）。

**台账为空时**投送会退化为站级基线锚点（`https://lab-kanban.matrixos.cc.cd/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=08-lab-kanban
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/08-lab-kanban-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射。
  五条流水由 `KANBAN_TASKS` 直接映射（阶段序来自 `KANBAN_COLUMNS`，导师画像来自 `MENTORS`，
  代表作锚点来自 `PAPER_ROWS`），**不手抄数字**（手抄会出现「看板显示匹配 87.5%、台账写 87%」
  这类答辩事故）。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（航天任务控制看板 `TaskKanban`），
  由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=08 --force`（`scripts/gen-site.mjs`）
