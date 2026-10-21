# 04 · PAT-HOT 学科脉冲雷达

> MatrixOS 微站 · 轨道 3 · 情报 · `pat-hot.matrixos.edu` · 目录 `apps/micro-sites/04-pat-radar/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 24h 频谱瀑布流 |
| 独立台账 | 订阅学科关键词与早报历史库 |
| 原型来源 | PAT-HOT 实机原型 |
| 开发端口 | `3013` |
| 虫洞接收 | `paper_doi_bundle` ← 05 五源跨库引文声呐 |
| 虫洞投送 | `paper_doi_bundle` → 05 五源跨库引文声呐 |

监听 arXiv / Nature Photonics 24h 前沿动态，每日 08:00 推送三卡早报。

一条台账记录 = **一个订阅方向**：订阅的关键词是什么、这个方向今天早上推送了哪几篇、
峰值热度多少、早报历史里留下了哪条摘要、以哪篇论文的 DOI 作为证据锚点。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-04-pat-radar dev     # http://localhost:3013
pnpm --filter @matrixos/microsite-04-pat-radar build
pnpm --filter @matrixos/microsite-04-pat-radar typecheck
```

## 数据模型

台账落在 `localStorage` 的 `mx.pat-hot.pat-subscriptions` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-<序号>-<随机>（新增）
        "title": "钙钛矿光伏 · 界面钝化 · 钙钛矿 AND (钝化 OR 界面)",  // 方向 + 检索式
        "meta": "命中 1 篇 · 峰值热度 98.4 · 均热 98.4 · DOI 1 条 · 在订",
        "detail": "订阅方向 钙钛矿光伏 · 界面钝化，推送频率 每日 07:30；早报头条：……",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                             // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                             // 可选：该条订阅的证据锚点，投送时聚合进信封
          "source_doi_or_url": "https://doi.org/10.1038/s41566-025-01234-5",
          "verification_level": "Level_B_Preprint"
        },
        "keyword": "钙钛矿 AND (钝化 OR 界面)",  // 以下为本站自定义字段
        "direction": "钙钛矿光伏 · 界面钝化",
        "cadence": "每日 07:30",
        "status": "在订",
        "itemIds": ["p1"],
        "itemCount": 1,
        "maxHeat": 98.4,
        "avgHeat": 98.4,
        "tags": ["钙钛矿", "界面工程"],
        "dois": ["10.1038/s41566-025-01234-5"],
        "doiCount": 1,
        "topItemTitle": "钙钛矿太阳能电池界面钝化的准二维策略",
        "topVenue": "Nature Photonics",
        "topHeat": 98.4,
        "topSummary": "PEAI 准二维钝化将界面缺陷密度降低两个数量级，峰值 EQE 达 28.4%。",
        "digest": "早报头条：Nature Photonics《……》热度 98.4 —— ……",
        "note": "主攻方向。准二维钝化这条线三个月内出了两篇高热度工作，早报保持日更。"
      }
    ]
  }
}
```

**热度与 DOI 全部现算，不手抄。** 站点从 `@matrixos/microsite-data` 读
`PAT_HOT_ITEMS`（4 条 24h 前沿条目，含 `heat` / `doi` / `summary` / `tags`），
每条订阅记录按 `itemIds` 聚合出命中篇数、峰值热度、平均热度、标签并集与 DOI 列表。

当前演示数据是四个订阅方向，覆盖全部 4 条前沿条目：

| 订阅方向 | 检索式 | 频率 | 命中 | 峰值热度 |
| :--- | :--- | :--- | ---: | ---: |
| 钙钛矿光伏 · 界面钝化 | `钙钛矿 AND (钝化 OR 界面)` | 每日 07:30 | 1 篇 | 98.4 |
| 自旋电子学 · 手性传输 | `手性钙钛矿 OR CISS` | 每周一 07:30 | 1 篇 | 91.2 |
| 超快光学 · 拓扑量子 | `(超快 OR 飞秒) AND (拓扑 OR 表面态)` | 每日 07:30 | 1 篇 | 85.7 |
| 微纳光学 · 动态全息 | `超表面 AND (全息 OR 等离激元)` | 每三日 07:30 | 1 篇 | 79.3 |

上表是当前演示数据的实际值，改共享数据后表会随之变化。

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：

- `导出 JSON` → `pat-subscriptions.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `pat-subscriptions.csv`（列：订阅方向 / 检索关键词 / 推送频率 / 状态 / 命中篇数 / 峰值热度 / 均热 / 标签 / DOI 列表 / 早报头条 / 最后修改）

## 虫洞契约

- **接收** `paper_doi_bundle`，来自 05 五源跨库引文声呐。消费后落成本站一条
  「回流文献包 · <方向>」的待入夹条目。早报只说「某方向有 3 篇新文」是没法核验的，
  带上 DOI 才能顺锚点去补引文树，「开山鼻祖」这条线索才不会断在摘要里。
- **投送** `paper_doi_bundle`，发往 05 五源跨库引文声呐。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "pat-hot",
  "ledger": "订阅学科关键词与早报历史库",
  "target": "lit-sonar",
  "subscriptionCount": 4,
  "doiCount": 4,
  "doiBundle": ["10.1038/s41566-025-01234-5", "10.1021/jacs.4c0112", "10.1103/PhysRevLett.134.123456", "10.1002/adma.202501234"],
  "heatBaseline": 98.4,
  "directions": [
    { "direction": "钙钛矿光伏 · 界面钝化", "keyword": "钙钛矿 AND (钝化 OR 界面)", "status": "在订", "doiCount": 1 }
  ],
  "subscriptions": [
    { "id": "...", "title": "...", "keyword": "...", "direction": "...", "cadence": "每日 07:30",
      "status": "在订", "itemCount": 1, "maxHeat": 98.4, "avgHeat": 98.4,
      "tags": ["钙钛矿", "界面工程"], "dois": ["10.1038/s41566-025-01234-5"], "digest": "..." }
  ]
}
```

`doiBundle` 做了**去重**：文献声呐拿到的是一串可直接检索的 DOI，不是重复锚点。

证据锚点取自每条订阅的 `anchor` 字段，形如
`https://doi.org/<doi>` + `Level_B_Preprint`。为什么不用 `Level_A_Verified`：
早报是自动抓取的题录与摘要，没做过「PDF 原文 + 第二来源」的双验，不能冒充已验真证据。
**台账为空时**投送会退化为站级基线锚点（`https://pat-hot.matrixos.edu/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=04-pat-radar
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/04-pat-radar-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 台账演示数据与投送字段映射
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（24h 频谱瀑布流），由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=04 --force`（`scripts/gen-site.mjs`）
