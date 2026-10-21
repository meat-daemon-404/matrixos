# 12 · 顶刊代码复现核验舱

> MatrixOS 微站 · 轨道 5 · 工坊 · `repro-check.matrixos.edu` · 目录 `apps/micro-sites/12-repro-check/`
>
> 目录名由 [ADR-001](../../../docs/01-plan/00-adr-001-microsite-numbering.md) 裁决：
> **编号与站点归属取花名册，目录词根取描述性命名**。所以目录名与域名可以不一致
> （14 是 `review-architect` 但域名是 `review-lab`；04 是 `pat-radar` 但域名是 `pat-hot`），
> 这是刻意的，**不要为了"对齐"改目录名** —— 会引发域名迁移。

| 项 | 值 |
| :--- | :--- |
| UI 形态 | 飞行前机械检查单 |
| 独立台账 | 依赖环境、随机种子与超参复现清单 |
| 原型来源 | ScholarMatrix 拆解 |
| 开发端口 | `3021` |
| 虫洞接收 | `paper_doi_bundle` / `curve_fit_parameters` ← 11 CurveLab 非线性拟合示波器（curvelab） |
| 虫洞投送 | `paper_doi_bundle` → 15 撤稿深海声呐与伦理合规仪（retract-radar） |

自动扫描论文关联 GitHub 仓库，生成 Docker 环境配置与复现避坑指南。
一条台账记录 = **一篇论文的复现核验清单**：五项标准检查各自的结论、阻塞项、
可直接复跑的 Dockerfile，连同原文证据锚点一起落库。

## 本地开发

开发端口 **3021**（`src/site.config.ts` 与 `package.json` 的 `dev` 脚本一致）：

```bash
pnpm --filter @matrixos/microsite-12-repro-check dev        # http://localhost:3021
pnpm --filter @matrixos/microsite-12-repro-check build
pnpm --filter @matrixos/microsite-12-repro-check typecheck  # npx tsc --noEmit
```

零 Tailwind、零外部 CDN，内网可用。`next.config.ts` 在加载时探测
`@matrixos/sdk` / `@matrixos/instrument-ui` 能否 resolve，解析不到就把 specifier 别名到
`src/lib/shims/` —— import 已按最终形态写好，包一旦就位别名自动失效。

## 数据模型

台账落在 `localStorage` 的 `mx.repro-check.repro-checklists` 键下，信封形状：

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-20T14:03:11.482Z",
  "data": {
    "rows": [
      {
        "id": "seed-01",                       // seed-NN（演示数据）或 r-<时间戳>-…（新增）
        "title": "复现核验 · Nat. Photon. 2025",
        "meta": "通过 3/5 · 警告 1 · 失败 1 · 不可复现 · 超参完整性缺失",
        "detail": "对象：PEAI 准二维钝化（关键指标 28.4%，原文 p.4 Fig. 2b）；清单：依赖环境=通过 · ……；阻塞项：超参完整性 —— 缺少学习率与 batch size 记录；避坑：先补 training_config.yaml……",
        "updatedAt": "1970-01-01T00:00:00.000Z",
        "edits": 0,                            // 编辑次数，标题会追加「· 已编辑 N 次」
        "anchor": {                            // 原文证据锚点（snake_case，投送时聚合进信封）
          "source_doi_or_url": "10.1038/s41566-025-01234-5",
          "verification_level": "Level_A_Verified",
          "pdf_page": 4,
          "bbox": [72.5, 144, 300.25, 210.75]
        },
        "paperId": "r1",                       // 以下均为本站自定义字段
        "venue": "Nat. Photon. 2025",
        "strategy": "PEAI 准二维钝化",
        "keyMetric": "28.4%",
        "sourceDoi": "10.1038/s41566-025-01234-5",
        "verificationLevel": "Level_A_Verified",
        "passCount": 3, "warnCount": 1, "failCount": 1,
        "verdict": "不可复现 · 超参完整性缺失",
        "checks": [                            // 五项标准检查的逐项结论
          { "id": "k1", "item": "依赖环境",   "status": "pass", "detail": "requirements.txt 锁定版本，Python 3.11" },
          { "id": "k2", "item": "数据可得性", "status": "pass", "detail": "Figshare 开放数据 DOI 可解析" },
          { "id": "k3", "item": "随机种子",   "status": "warn", "detail": "仅主实验固定 seed，消融未说明" },
          { "id": "k4", "item": "超参完整性", "status": "fail", "detail": "缺少学习率与 batch size 记录" },
          { "id": "k5", "item": "硬件要求",   "status": "pass", "detail": "单卡 A100 可复现" }
        ],
        "dockerfile": "# Nat. Photon. 2025 · PEAI 准二维钝化 复现环境（repro-check 生成）\nFROM python:3.11-slim\n…"
      }
    ]
  }
}
```

信封是**版本化**的：`version` 与 `LEDGER_VERSION` 不符且没有迁移函数时，读盘会回落默认值
但**不覆盖**原数据（保护用户已存内容）。坏 JSON、形状不符同样处理。

导出：
- `导出 JSON` → `repro-checklists.json`（完整信封，UTF-8 BOM，Excel 直接打开不乱码）
- `导出 CSV` → `repro-checklists.csv`（列：论文 / 期刊·预印本 / 方法 / 关键指标 / 通过 /
  警告 / 失败 / 结论 / DOI / 证据等级 / 最后修改）

## 核验规则（本站的核心业务规则）

检查项**不是本站编的** —— 来自共享标准清单 `REPRO_CHECKS`（依赖环境 / 数据可得性 /
随机种子 / 超参完整性 / 硬件要求，共 5 项）。逐项状态按论文的**证据等级**用确定性规则推导
（`statusFor`），不逐条手抄：

| 证据等级 | 规则 | 效果（以标准清单 pass/pass/warn/fail/pass 为基线） |
| :--- | :--- | :--- |
| `Level_A_Verified` | 用标准清单原始状态 | 通过 3 · 警告 1 · 失败 1 →「不可复现 · 超参完整性缺失」 |
| `Level_B_Preprint` | 整体降一档（pass→warn、warn→fail） | 通过 0 · 警告 3 · 失败 2 →「不可复现 · 随机种子、超参完整性缺失」 |
| `Retracted_Warning` | 全项 fail | 撤稿论文不值得复现（防御分支） |

这样「核验结论」是证据等级的函数：预印本天然拿不到完整训练配置，判得更严是规律，
不是故事。Dockerfile 里的 Python 版本、依赖说明、随机种子注释也都从 `REPRO_CHECKS` 的
detail 现算 —— 改共享数据，脚本跟着变。

3 条演示记录 = `PAPER_ROWS` 的三篇顶刊（Nat. Photon. 2025 / Adv. Mater. 2024 / JACS 2025），
结论分布是「已发表但超参缺 → 不可复现」「预印本降档 → 更不可复现」的真实梯度。

## 虫洞契约

- **接收** `paper_doi_bundle` / `curve_fit_parameters`，来自 11 CurveLab。分流处理：
  DOI 包落成「待核验清单」（未开检）；CurveLab 回传的拟合参量补件用来复核
  「超参完整性」项 —— 复核前不改判，补件也要对得上原始散点。
- **投送** `paper_doi_bundle`，发往 15 撤稿深海声呐。投出去的 `payload.data` 形如：

```jsonc
{
  "site": "repro-check",
  "ledger": "依赖环境、随机种子与超参复现清单",
  "target": "retract-radar",
  "rule": "核验结论随 DOI 包投送：pass/fail 分布作为引文风险评分的输入权重",
  "checkTemplate": [{ "id": "k1", "item": "依赖环境" }],
  "paperCount": 3,
  "doiCount": 3,
  "doiBundle": ["10.1038/s41566-025-01234-5"],
  "papers": [{ "id": "r1", "venue": "Nat. Photon. 2025", "verdict": "不可复现 · 超参完整性缺失",
               "passCount": 3, "warnCount": 1, "failCount": 1 }]
}
```

**投送语义**：不只是 DOI 列表，而是带核验结论的 DOI 包 —— 声呐据此给引文风险评分加权：
「代码不可复现」的引用风险更高，形成「可复现 → 才值得引用」的链路。

证据锚点取自每条清单的 `anchor`（原文 DOI + 页码 + bbox，**snake_case 四字段** —— 锚点层
`additionalProperties: false`，多一个 `note` 整个信封就过不了契约校验；共享数据里的
camelCase 锚点在 `site-spec.ts` 逐字段转换并丢掉 `note`）。未绑定 DOI 的清单用站内页
`https://repro-check.matrixos.edu/checklists/<paperId>` + `Level_B_Preprint` 兜底，绝不冒充 Level A。

**台账为空时**投送会退化为站级基线锚点（`https://repro-check.matrixos.edu/`），
因为虫洞契约的红线是 `evidence_anchors` 至少 1 条 —— 宁可退化，也不发一个非法信封。

只有真嵌在 orbital-hub iframe 内且握手完成（`useHostBridge().connected === true`）才真投送；
独立窗口下只做本地演示，反馈里会明写「未实际投送」。

## 验收

```bash
node scripts/microsite-verify.mjs --site=12-repro-check
```

九项断言（正文长度、七个 testid、增/持久化/导出/清空/刷新、投送反馈、零 console error、
零失败请求、移动端无溢出）全部通过。截图落 `.tmp/microsite-verify/12-repro-check-*.png`。

## 结构说明

- `src/lib/site-spec.ts`：**本站唯一手写的业务代码** —— 标准检查清单、按证据等级推导的
  确定性规则、Dockerfile 模板与投送字段映射。检查项与论文对象全部来自共享
  `REPRO_CHECKS` / `PAPER_ROWS`，**不手抄数字**。
- `src/lib/sdk-facade.ts` / `src/components/site-shell.tsx` / `src/components/workbench-impl.tsx`
  / `src/components/site-workbench.tsx` / `src/app/page.tsx`：由
  `node scripts/wire-workbench.mjs` 从 `apps/micro-sites/shared/templates/` 分发，
  **请勿直接修改**（改模板再分发）
- `src/components/site-instrument.tsx`：仪器面板（飞行前机械检查单，`REPRO_CHECKS` 直接渲染），
  由 `scripts/wire-instrument.mjs` 分发
- `src/app/globals.css`：站点 token 与外壳样式（每站 accent 不同，独立维护）
- `matrix-app.manifest.json`：符合 `specs/contracts/matrix-app-manifest.schema.json`，供 hub 星轨注册

完工规范见 [docs/02-engineering/08-microsite-workbench.md](../../../docs/02-engineering/08-microsite-workbench.md)。

---

生成器：`pnpm gen:site --id=12 --force`（`scripts/gen-site.mjs`）
