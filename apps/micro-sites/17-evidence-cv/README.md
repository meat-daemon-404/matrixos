# 17 · 区块链级学术证据简历工坊

> MatrixOS 微站 · 轨道 7 · 预职 · `evidence-cv.matrixos.edu` · 目录 `apps/micro-sites/17-evidence-cv/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 绿标验真数字徽章台 |
| 独立台账 | 多版本保研/求职证据级简历库 |
| 原型来源 | 预职 WorkBuddy 原型 |
| 开发端口 | `3026` |
| 虫洞接收 | `paper_doi_bundle`、`comparison_matrix_row`、`curve_fit_parameters`、`mentor_match_card` |
| 虫洞投送 | `verified_cv_evidence` |

简历中每一条科研经历均嵌入可点击验真的 DOI 锚点、拟合图与代码仓库哈希。

## 跑起来

```bash
pnpm --filter @matrixos/microsite-17-evidence-cv dev     # http://localhost:3026
pnpm --filter @matrixos/microsite-17-evidence-cv build
```

## 这个骨架包含什么

- Next.js 15 App Router + React 19，零 Tailwind、零外部 CDN（内网可用）
- `src/site.config.ts`：站点身份，来源是 `specs/microsites.json`，不要手改
- `src/lib/sdk-facade.ts`：**唯一** import `@matrixos/sdk` 的地方（SSO + 虫洞接收器）
- `src/lib/instrument-facade.tsx`：**唯一** import `@matrixos/instrument-ui` 的地方（面板容器）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册
- iframe 内降级模式：被 hub 嵌入时自动隐藏站内标题/页脚（ADR-08 的强制能力）

### 两个 package 还没发布也能跑

`next.config.ts` 在加载时探测 `@matrixos/sdk` / `@matrixos/instrument-ui` 能否 resolve，
**解析不到就把 specifier 别名到 `src/lib/shims/`**。于是：

- import 已经按最终形态写好（不用等包）
- `pnpm dev` 立刻能跑
- 包一旦就位，别名自动失效，源码一行都不用改

界面会**显式**标注「SDK 未就位」「面板 · local」——不伪造登录态，不假装虫洞通了。

## 下一步（S3 功能完备化）

1. 用 `@matrixos/instrument-ui` 的仪器族替换占位仪器（旋钮族/图表族/雷达族/天平族）
2. 按台账 `多版本保研/求职证据级简历库` 落 `/v1/assets` 读写
3. 虫洞契约按 `specs/contracts/wormhole-envelope.schema.json` 接实现（证据锚点非空是红线）

---

生成器：`pnpm gen:site --id=17 --force`（`scripts/gen-site.mjs`）
