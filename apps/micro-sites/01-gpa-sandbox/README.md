# 01 · 学分绩点动态配重台

> MatrixOS 微站 · 轨道 1 · 学阶 · `gpa.matrixos.edu` · 目录 `apps/micro-sites/01-gpa-sandbox/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 精密推子配重仪 |
| 独立台账 | 学期目标绩点与选课博弈方案库 |
| 原型来源 | ScholarMatrix 拆解 |
| 开发端口 | `3010` |
| 虫洞接收 | `verified_cv_evidence` ← 17 证据简历工坊 |
| 虫洞投送 | `verified_cv_evidence` → 17 证据简历工坊 |

拖动推子模拟不同选修课成绩对保研/出国核心 GPA 的边际贡献。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-01-gpa-sandbox dev     # http://localhost:3010
pnpm --filter @matrixos/microsite-01-gpa-sandbox build
pnpm --filter @matrixos/microsite-01-gpa-sandbox typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.gpa.gpa-plans` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                  // seed-NN（演示数据）或 r-<时间戳>-<序号>-<随机>（新增）
        "title": "方案 A · 保研冲刺线",     // 列表主标题
        "meta": "核心 GPA 3.93 · 17 学分 · 提升 +0.32",  // 一行摘要
        "detail": "把 4 门核心课的复习预算拉满……",        // 详情
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                        // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                        // 可选：该条方案的证据锚点，投送时聚合进信封
          "source_doi_or_url": "https://gpa.matrixos.edu/plans/plan-a",
          "verification_level": "Level_B_Preprint"
        },
        "plan": "A",                       // 本站自定义字段
        "gpa": 3.93,
        "risk": "低"
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `gpa-plans.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `gpa-plans.csv`（列：方案编号 / 方案名 / 目标 GPA / 风险等级 / 说明 / 最后修改）

## 虫洞契约

- **接收** `verified_cv_evidence`，来自 17 证据简历工坊。消费后落成本站一条「基准方案」，
  用来校准后续配重推演的起点（把简历上已验真的 GPA 当作已知事实，而不是重新假设）。
- **投送** `verified_cv_evidence`，发往 17 证据简历工坊。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "gpa",
  "ledger": "学期目标绩点与选课博弈方案库",
  "currentGpa": 3.61,
  "targetGpa": 3.93,
  "credits": 17,
  "coreCourses": 4,
  "plans": [{ "id": "...", "title": "...", "plan": "A", "gpa": 3.93, "risk": "低", "detail": "..." }]
}
```

证据锚点取自每条方案的 `anchor` 字段（上例是站内方案页 URL + `Level_B_Preprint`）。
**台账为空时**投送会退化为站级基线锚点（`https://gpa.matrixos.edu/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=01-gpa-sandbox
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/01-gpa-sandbox-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（GPA 推子配重仪），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=01 --force`（`scripts/gen-site.mjs`）
