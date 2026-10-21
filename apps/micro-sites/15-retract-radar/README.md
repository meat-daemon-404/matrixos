# 15 · 撤稿深海声呐与伦理合规仪

> MatrixOS 微站 · 轨道 5 · 工坊 · `retract-radar.matrixos.edu` · 目录 `apps/micro-sites/15-retract-radar/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**，目录名与域名可以不一致，
> 这是刻意的，**不要为了"对齐"改目录名**。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 360° 极坐标声呐盘 |
| 独立台账 | 论文引文合规体检报告与伦理声明 |
| 原型来源 | ScholarMatrix 拆解 |
| 开发端口 | `3024` |
| 虫洞接收 | `paper_doi_bundle` ← 10 复现核验舱 |
| 虫洞投送 | `paper_doi_bundle` → 17 简历证据台（`evidence-cv`） |

对接 Crossref 与 PubPeer 排查撤稿与勘误引文，自动生成顶刊 AI 使用披露声明。

**一条记录 = 一份引文合规体检报告**：被检论文 + 声呐检出的风险项 + 伦理声明。
风险等级、风险项文案、声呐方位与半径全部从 `RETRACT_BLIPS` 推出来 —— 声呐盘上亮
几个点，台账里就落几条报告，不会出现「盘上是红的、台账写着安全」。

本站的核心是**拦截**。命中撤稿库的引文，锚点的 `verification_level` 必须落成
`Retracted_Warning`（演示数据里 `10.1021/jacs.4c0112` 就是这一条），下游 `evidence-cv`
拿到这个等级会直接拒绝入库 —— 这是整条链路的伦理红线。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-15-retract-radar dev        # http://localhost:3024
pnpm --filter @matrixos/microsite-15-retract-radar build
pnpm --filter @matrixos/microsite-15-retract-radar typecheck
```

## 数据模型

localStorage key：`mx.retract-radar.retract-reports`（`mx.<appId>.<exportName>`）。
落盘格式是版本化信封，`version` 不匹配时回落到默认 seed，但**不覆盖**原有数据：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T12:00:00.000Z",
  "data": {
    "rows": [
      {
        "id": "seed-02",                          // seed 行固定 seed-NN；新增行 r-<时间戳>-<序号>-<随机>
        "title": "撤稿拦截 · 10.1021/jacs.4c0112 双氟代配体交联",
        "meta": "风险等级 撤稿/勘误 · 方位 165° / 半径 0.55 · 该引文已被撤稿，禁止引用",
        "detail": "体检对象：JACS 2025 双氟代配体交联（DOI …）。检出：… 判定：该引文已被撤稿，禁止引用 …",
        "anchor": {                                // 虫洞锚点：snake_case，严格 4 字段，没有 note
          "source_doi_or_url": "10.1021/jacs.4c0112",
          "verification_level": "Retracted_Warning", // ← 本站特殊验收点
          "pdf_page": 3,
          "bbox": [55, 180, 290, 260]
        },
        "reportKind": "撤稿拦截",                  // 全量体检 / 撤稿拦截 / 质疑待回应 / 勘误复核 / 待体检
        "checkedDois": ["10.1021/jacs.4c0112"],   // 本次体检覆盖的 DOI
        "riskLevel": "撤稿/勘误",                  // 安全 / 关注 / 撤稿/勘误（= SonarRiskLevel 中文）
        "riskItems": ["DOI:10.1021/jacs.4c0112（PubPeer 有 2 条评论）", "2 篇勘误未处理"],
        "citationImpact": "1 篇代表作 · 约 116 条二次引用待回溯",
        "ethics": "撤稿引文已从证据链剔除；如需讨论，仅以「已撤稿案例」出现在方法学局限一节。",
        "verdict": "拦截 · 禁止引用",              // 放行 / 暂缓 · 方法学可引 / 拦截 · 禁止引用 / 返工 · 重绑锚点
        "verification": "Retracted_Warning",      // 与 anchor.verification_level 同步
        "bearing": "方位 165° / 半径 0.55",        // 与声呐盘上的光点坐标一致
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0
      }
    ]
  }
}
```

导出：

- **JSON** — 文件名 `retract-reports.json`（UTF-8 带 BOM），内容就是上面这封信封。
- **CSV** — 文件名 `retract-reports.csv`，列为
  `被检论文, 报告类型, 风险等级, 检出风险项, 判定, 核验等级, 伦理声明, 最后修改`。

## 虫洞契约

权威定义在 `specs/contracts/wormhole-envelope.schema.json`，本站条目见
`scripts/lib/microsite-contracts.mjs`。

### 接收

| 项 | 值 |
| :--- | :--- |
| payload_type | `paper_doi_bundle` |
| 来源站 | 10 复现核验舱 |
| 消费后落成 | 一条「待体检」报告：`reportKind: '待体检'`、`verdict: '待判定'`、`riskLevel: '关注'`，`checkedDois` 从信封 `payload.data.dois` 展开 |

收到论文包后的人工路径：Crossref 撤稿库比对 → PubPeer 检索 → 判定风险等级 →
写伦理声明 → 放行或拦截。未出结论前一律按「关注」对待，不进入下游证据链。

### 投送

| 项 | 值 |
| :--- | :--- |
| payload_type | `paper_doi_bundle` |
| 目标站 | 17 简历证据台（`evidence-cv`） |

`payload.data` 形状：

```jsonc
{
  "site": "retract-radar",
  "ledger": "论文引文合规体检报告与伦理声明",
  "bundle_kind": "citation_compliance_bundle",
  "sonar": { "blips": 6, "safe": 3, "caution": 2, "critical": 1 },
  "checked_count": 3,
  "cleared_count": 1,                 // verdict 含「放行」的报告所覆盖的 DOI
  "blocked_count": 1,                 // verdict 含「拦截」的报告所覆盖的 DOI
  "dois": ["10.1038/s41566-025-01234-5", "10.1021/jacs.4c0112", "10.1002/adma.202401234"],
  "cleared_dois": ["10.1038/s41566-025-01234-5"],
  "blocked_dois": ["10.1021/jacs.4c0112"],
  "reports": [
    {
      "id": "seed-02",
      "title": "撤稿拦截 · 10.1021/jacs.4c0112 双氟代配体交联",
      "reportKind": "撤稿拦截",
      "riskLevel": "撤稿/勘误",
      "verdict": "拦截 · 禁止引用",
      "riskItems": ["DOI:10.1021/jacs.4c0112（PubPeer 有 2 条评论）", "2 篇勘误未处理"],
      "ethics": "撤稿引文已从证据链剔除；…",
      "verification": "Retracted_Warning"
    }
  ]
}
```

证据锚点层 `payload.evidence_anchors` **取自每条记录的 `anchor` 字段**，契约红线是
`minItems: 1`。台账被清空时，投送退化为站级基线锚点
`https://retract-radar.matrixos.edu/`（`Level_B_Preprint`），并在反馈里明写
「台账为空，使用站级基线锚点」—— 不会伪造一条假证据。

真实投送只在 hub iframe 内（`useHostBridge().connected === true`）发生；独立窗口打开时
只做本地演示，反馈文案是「本地演示 · 未实际投送」，不会假装虫洞通了。

## 验收

```bash
node scripts/microsite-verify.mjs --site=15-retract-radar
```

跑一次静态导出构建 + Playwright 九项断言：正文非空、七个 `data-testid` 齐全、
新增后计数 +1 且刷新保持、导出 JSON 真的落盘、清空归 0 且刷新仍 0、投送反馈非空、
零 console error / 零未捕获异常 / 零失败请求、390×844 无横向溢出。
截图落在 `.tmp/microsite-verify/15-retract-radar-{desktop,mobile}.png`。

## 结构说明

- `src/lib/site-spec.ts` —— **本站唯一手写的业务代码**：台账 schema、演示数据、投送/接收映射
- `src/lib/sdk-facade.ts`、`src/components/site-shell.tsx`、`src/components/workbench-impl.tsx`、
  `src/components/site-workbench.tsx`、`src/app/page.tsx` —— 由 `node scripts/wire-workbench.mjs`
  从 `apps/micro-sites/shared/templates/` 分发，**勿改**（改了会被下一次分发覆盖，且破坏 18 站一致性）
- `src/components/site-instrument.tsx` —— 由 `scripts/wire-instrument.mjs` 分发（15 站是 `RetractSonar`，
  `SonarDisc` 极坐标声呐盘 + 可访问性表格），**勿改**
- `src/app/globals.css` —— 站点 token（accent `#10b981`）
- `matrix-app.manifest.json` —— 供 hub 星轨注册，`accepts` / `emits` 与
  `scripts/lib/microsite-contracts.mjs` 必须一致
- `src/site.config.ts` —— 站点身份，来源是 `specs/microsites.json`，不要手改

完工规范全文见 [`docs/02-engineering/08-microsite-workbench.md`](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=15 --force`（`scripts/gen-site.mjs`）
