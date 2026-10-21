# 02 · 双创互补组队雷达

> MatrixOS 微站 · 轨道 2 · 星火 · `spark.matrixos.edu` · 目录 `apps/micro-sites/02-spark-teaming/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 技能极坐标互补盘 |
| 独立台账 | 大创/挑战杯组队契约与分工表 |
| 原型来源 | ScholarMatrix 拆解 |
| 开发端口 | `3011` |
| 虫洞接收 | `verified_cv_evidence` ← 17 证据简历工坊 |
| 虫洞投送 | `verified_cv_evidence` → 17 证据简历工坊 |

匹配跨院系（硬件+算法+商业）互补队友并自动生成大创申报书初稿。

一条台账记录 = **一份组队契约**：和谁组、互补度多少、谁补哪一维、怎么分工、契约条款是什么。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-02-spark-teaming dev     # http://localhost:3011
pnpm --filter @matrixos/microsite-02-spark-teaming build
pnpm --filter @matrixos/microsite-02-spark-teaming typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.spark.spark-teamups` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-<序号>-<随机>（新增）
        "title": "陈同学 · 算法主攻位",          // 列表主标题 = 队友 + 分工定位
        "meta": "互补度 92.4% · 五维增益 +48 · 短板覆盖 2/2 · 互补充分",
        "detail": "分工：算法实现与数据处理全流程……契约条款：……",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                             // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                             // 可选：该条契约的证据锚点，投送时聚合进信封
          "source_doi_or_url": "https://spark.matrixos.edu/contracts/tm1",
          "verification_level": "Level_B_Preprint"
        },
        "teammateId": "tm1",                    // 以下为本站自定义字段
        "teammateName": "陈同学",
        "major": "计算机学院",
        "complementScore": 92.4,
        "gainTotal": 48,
        "coveredWeak": 2,
        "weakTotal": 2,
        "focus": "算法",
        "risk": "互补充分",
        "duty": "算法实现与数据处理全流程（模型选型、训练脚本、消融实验）",
        "clauses": ["代码进同一仓库、按周提交……", "……"],
        "status": "契约生效"
      }
    ]
  }
}
```

**互补度与五维增益全部现算，不手抄。** 站点从 `@matrixos/microsite-data` 读
`TEAMMATES`（3 位候选队友的画像）与 `SELF_SKILLS`（我方五维自评），然后：

- 五维增益 = `Σ max(0, 队友该维分 − 我方该维分)`（维度：硬件 / 算法 / 商业 / 实验 / 写作）
- 短板覆盖 = 我方低于 60 分的维度里，被队友真正补上的个数
- 风险判定 = 增益总量 ≥40 互补充分 / ≥10 部分互补 / 否则技能重叠

这样上方「技能极坐标互补盘」和下方台账永远是同一份数字，不会出现
「盘上显示 92.4%、台账写 92.5%」这类对不上的事故。手改数值请改共享演示数据，
不要改台账文本。

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：

- `导出 JSON` → `spark-teamups.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `spark-teamups.csv`（列：队友 / 学院 / 主攻位 / 互补度 / 五维增益 / 短板覆盖 / 风险判定 / 分工 / 契约条款 / 状态 / 最后修改）

## 虫洞契约

- **接收** `verified_cv_evidence`，来自 17 证据简历工坊。消费后落成本站一条
  「技能验真回执 · <队友名>」，用来给互补度打分补上第三方证据 —— 自评是主观的，
  验真后的技能证据才是可写进申报书的。
- **投送** `verified_cv_evidence`，发往 17 证据简历工坊。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "spark",
  "ledger": "大创/挑战杯组队契约与分工表",
  "selfSkills": { "hardware": 88, "algorithm": 52, "business": 35, "experiment": 90, "writing": 68 },
  "skillLabels": { "hardware": "硬件", "algorithm": "算法", "business": "商业", "experiment": "实验", "writing": "写作" },
  "weakDimensions": ["算法", "商业"],
  "contractCount": 3,
  "contracts": [
    { "id": "...", "title": "...", "teammateName": "陈同学", "complementScore": 92.4,
      "gainTotal": 48, "coveredWeak": 2, "focus": "算法", "risk": "互补充分",
      "status": "契约生效", "duty": "...", "clauses": ["..."], "detail": "..." }
  ]
}
```

证据锚点取自每条契约的 `anchor` 字段（站内契约存档页 URL + `Level_B_Preprint`）。
契约是本站自存档文件、未经第三方双验，所以**不用** `Level_A_Verified`。
**台账为空时**投送会退化为站级基线锚点（`https://spark.matrixos.edu/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=02-spark-teaming
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/02-spark-teaming-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（技能极坐标互补盘），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=02 --force`（`scripts/gen-site.mjs`）
