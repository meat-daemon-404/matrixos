# 03 · 大创五科目经费液位仪

> MatrixOS 微站 · 轨道 2 · 星火 · `grant-audit.matrixos.cc.cd` · 目录 `apps/micro-sites/03-grant-audit/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 五柱流体压差计 |
| 独立台账 | 国创 ¥20,000 报销凭据与红线台账 |
| 原型来源 | MatrixOS 原创 |
| 开发端口 | `3012` |
| 虫洞接收 | `paper_doi_bundle` ← 05 五源跨库引文声呐 |
| 虫洞投送 | `verified_cv_evidence` → 17 证据简历工坊 |

内置劳务费 ≤20% 硬件限位阀，实时监控算力、软著、差旅报销进度。

一条台账记录 = **一个科目的报销凭据包**（发票清单 + 额度占用 + 红线判定）。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-03-grant-audit dev     # http://localhost:3012
pnpm --filter @matrixos/microsite-03-grant-audit build
pnpm --filter @matrixos/microsite-03-grant-audit typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.grant-audit.grant-receipts` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-<序号>-<随机>（新增）
        "title": "云算力与测试加工 · ¥6,800 凭据包",  // 列表主标题 = 科目 + 金额
        "meta": "占预算 34.0% · 额度 ¥6,800 / ¥6,800 · 已满额结项",
        "detail": "凭据清单：GPU 算力租用发票 ×3（¥4,200）；……",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                             // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                             // 可选：该条凭据的证据锚点，投送时聚合进信封
          "source_doi_or_url": "https://grant-audit.matrixos.cc.cd/receipts/compute",
          "verification_level": "Level_B_Preprint"
        },
        "columnId": "compute",                  // 以下为本站自定义字段
        "columnLabel": "云算力与测试加工",
        "amount": 6800,
        "capacity": 6800,
        "sharePct": 34,
        "redlinePct": null,                     // 只有劳务科目有红线（20）
        "compliant": true,
        "verdict": "已满额结项",
        "receipts": ["GPU 算力租用发票 ×3（¥4,200）", "……"]
      }
    ]
  }
}
```

**金额全部现算，不手抄。** 站点从 `@matrixos/microsite-data` 读 `GRANT_COLUMNS`
（五科目预算表）与 `GRANT_TOTAL`（¥20,000），然后派生出：

| 科目 | 已用 | 额度 | 占预算 |
| :--- | ---: | ---: | ---: |
| 云算力与测试加工 `compute` | ¥6,800 | ¥6,800 | 34.0% |
| 知识产权与出版版面 `ip` | ¥4,500 | ¥4,500 | 22.5% |
| 学生科研测试劳务 `labor` | ¥2,500 | ¥4,000 | 12.5% |
| 跨校调研与竞赛差旅 `travel` | ¥3,500 | ¥3,500 | 17.5% |
| 数据采集与文献耗材 `data` | ¥2,700 | ¥2,700 | 13.5% |
| **合计** | **¥20,000** | ¥21,500 | **100.0%** |

上表是当前演示数据的实际值，改共享数据后表会随之变化 —— 正文里的数字都由代码现算，
不存在「仪器显示 3.61、台账写 3.62」的漂移。

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：

- `导出 JSON` → `grant-receipts.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `grant-receipts.csv`（列：科目 / 金额 / 额度上限 / 占预算% / 红线% / 是否合规 / 判定 / 凭据清单 / 最后修改）

### 劳务费 ≤20% 红线硬限位

这是本站的核心业务规则（WBS `S3-MS03`），**演示数据里刻意放了三条对照**，
让「规则正确」和「阻断后给了出路」同时可验：

| 记录 | 劳务费 | 占总额 | 判定 |
| :--- | ---: | ---: | :--- |
| `学生科研测试劳务 · ¥2,500 凭据包` | ¥2,500 | 12.5% | ✓ 合规，剩余可报 ¥1,500 |
| `劳务费压线推演 · ¥4,000` | ¥4,000 | 20.0% | ✓ 合规（闭区间边界，再报 ¥1 即阻断） |
| `劳务费超线拦截 · ¥4,200` | ¥4,200 | 21.0% | ✗ 超限，财务拒绝入账（超 ¥200） |

判定规则写在 `site-spec.ts` 里：

```ts
const LABOR_CAP = Math.round(GRANT_TOTAL * LABOR_REDLINE);  // ¥20,000 × 20% = ¥4,000
const LABOR_COMPLIANT = LABOR_USED <= LABOR_CAP;            // 「≤」是闭区间
```

超线那条不只是判个红字，`detail` 里会给**可执行的调剂方案**：先算其他科目的结余合计，
结余够就写「把超出的 ¥200 调剂到结余科目」，结余不够（当前演示数据四科全部满额、
结余为 ¥0）就写「必须压回 ¥4,000，超出 ¥200 转课题组成员自付，或先办理预算调整审批」。
结论随共享数据变，不是写死的套话。

红线金额上限 `¥4,000` 与 `labor` 科目的 `capacity` 一致 —— 注意 `capacity` 在这里
就是红线换算出来的上限，不是「预算表上写着 4,000」。改 `GRANT_TOTAL` 或红线比例，
上限自动跟着变。

## 虫洞契约

- **接收** `paper_doi_bundle`，来自 05 五源跨库引文声呐。消费后落成本站一条
  「文献产出挂账 · <标题>」，把论文 DOI 挂到对应报销凭据上 —— 形成
  「钱花在哪 → 产出了什么」的闭环证据链。经费台账只有发票是没说服力的，
  要有产出才能证明这笔钱花得值。
- **投送** `verified_cv_evidence`，发往 17 证据简历工坊。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "grant-audit",
  "title": "国创项目经费与产出证据包",
  "ledger": "国创 ¥20,000 报销凭据与红线台账",
  "grantTotal": 20000,
  "totalUsed": 20000,
  "totalCapacity": 21500,
  "totalRemaining": 0,
  "labor": {
    "used": 2500, "cap": 4000, "redlinePct": 20, "sharePct": 12.5,
    "headroom": 1500, "compliant": true
  },
  "columns": [{ "id": "compute", "label": "云算力与测试加工", "value": 6800, "capacity": 6800, "sharePct": 34 }],
  "receipts": [
    { "id": "...", "title": "...", "columnId": "labor", "amount": 2500, "sharePct": 12.5,
      "redlinePct": 20, "compliant": true, "verdict": "合规 · 未触红线",
      "detail": "...", "receipts": ["..."] }
  ]
}
```

证据锚点取自每条凭据的 `anchor` 字段：普通科目用
`https://grant-audit.matrixos.cc.cd/receipts/<columnId>` + `Level_B_Preprint`（站内自存档、
未经第三方双验）；劳务红线用 `https://grant-audit.matrixos.cc.cd/redlines/labor-20pct` +
`Level_A_Verified`（财务制度条款有明文文件、可双验，够得上 A 级）。

**台账为空时**投送会退化为站级基线锚点（`https://grant-audit.matrixos.cc.cd/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=03-grant-audit
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/03-grant-audit-*.png`。

红线限位的额外人工核对点：打开台账应能同时看到 12.5% / 20.0% / 21.0% 三条劳务记录，
且 21.0% 那条的 `detail` 里带调剂方案。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（五柱流体压差计），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=03 --force`（`scripts/gen-site.mjs`）
