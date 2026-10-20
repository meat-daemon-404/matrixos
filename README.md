# MatrixOS · 智轨星云 v3.0

> **高校拔尖创新人才的全域科研工作台与学术数字资产操作系统**
>
> 覆盖「学业 → 科研 → 生涯」的 7 站闭环：学阶 Study · 星火 Spark · 情报 PAT-HOT · 星门 Xingmen · 学术星轨工坊 · 云衡 Asset · 预职 Pre-Job

[![Status](https://img.shields.io/badge/status-stage--1--scaffold-yellow)](#当前实现状态)
[![Version](https://img.shields.io/badge/spec-v3.0-6366f1)](#)
[![License](https://img.shields.io/badge/license-TBD-lightgrey)](#)

---

## 这是什么

MatrixOS 把四个已独立上线并验证过的原型系统，解耦重构为统一的**群岛式微站矩阵**：

| 原型 | 现有能力 | 在 v3 中的归属 |
| :--- | :--- | :--- |
| **ScholarMatrix** | 42+ 学术工具、跨论文对比矩阵、统计拟合台、综述生成 | 拆解为 **10 个纯源微站**（01/02/05/09/10/11/12/13/14/15）+ 与预职共担 1 站（16 yunheng）＝**涉及 11 站** |
| **星门 Xingmen** | 导师画像、自适应套磁信、进组台账 | **3 个微站**（轨道 4：06 mentor / 07 cold-email / 08 lab-kanban） |
| **PAT-HOT** | 物理·天文·光电 24h 流式情报监听 | **1 个微站**（轨道 3：04 pat-hot） |
| **预职 Pre-Job** | 证据级简历、升学/考公/求职决策树 | **2 个微站**（轨道 7：17 evidence-cv / 18 prejob）+ 与 ScholarMatrix 共担 16 yunheng |
| **MatrixOS 原创** | v3 全新设计，非任何原型拆解 | **1 个微站**（03 grant-audit 大创经费液位仪） |

> 口径说明：10（纯 ScholarMatrix）+ 3（星门）+ 1（PAT-HOT）+ 2（纯预职）+ 1（原创 grant-audit）+ 1（双源 yunheng）= **18**。
> 归属明细以 [`specs/microsites.json`](specs/microsites.json) 的 `source` 字段为准。

### 五大锁定架构决策（Q1–Q5）

| 编号 | 决策 | 内容 |
| :--- | :--- | :--- |
| **Q1** | 产品形态 | 18+N 群岛式「小而精」独立微站，淘汰臃肿单页大杂烩 |
| **Q2** | 账号与数据 | 全域唯一 `MatrixID`（OAuth2 + JWT）+ 统一 `DigitalTwinAssetGraph` |
| **Q3** | AI 交互范式 | 全局常驻 Copilot + 跨站「虫洞环」拖拽投送（零文件导入导出） |
| **Q4** | 主视觉形态 | 星轨引力场 + 数字精密科研仪器「双态合体」总控台 |
| **Q5** | 生态扩展 | 官方 18 旗舰站 + `@matrixos/sdk` 开放插槽协议（`matrix-app.manifest.json`） |

---

## 双态合体总控台

```
┌──────────────────────────────────────────────────────────────┐
│  orbital.matrixos.edu                                   v3.0 │
├─────────────────────┬────────────────────────────────────────┤
│                     │  ┌──────────────┐ ┌────────────────┐   │
│   左 32%            │  │ INSTRUMENT   │ │ INSTRUMENT     │   │
│   2.5D 星轨引力场   │  │ #08 CurveLab │ │ #05 Matrix-X   │   │
│                     │  │ 荧光示波器   │ │ 激光溯源矩阵   │   │
│   7 轨生涯轨道      │  └──────────────┘ └────────────────┘   │
│   + 18 动态实况胶囊 │  ┌──────────────┐                      │
│   Semantic Zoom     │  │ INSTRUMENT   │   右 68%             │
│   1.0x → 10.0x      │  │ #04 星门     │   折射仪器架         │
│                     │  └──────────────┘   (2~3 台同屏)      │
├─────────────────────┴────────────────────────────────────────┤
│  ◖◗ AI Copilot 声波脉冲底座 · DeepSeek V4.1 Flash 路由就绪   │
└──────────────────────────────────────────────────────────────┘
```

点击任意仪器面板 `[↗ 全屏独立打开]` → 进入该微站 100% 独立专精态，底部声波条自动坍缩为右下角呼吸能量球。

---

## 18 微站矩阵

### 轨道 1 · 学阶 & 轨道 2 · 星火

| ID | 微站 | 域名 | UI 形态 | 来源 |
| :-- | :--- | :--- | :--- | :--- |
| 01 | 学分绩点动态配重台 | `gpa.matrixos.edu` | 精密推子配重仪 | ScholarMatrix 拆解 |
| 02 | 双创互补组队雷达 | `spark.matrixos.edu` | 技能极坐标互补盘 | ScholarMatrix 拆解 |
| 03 | 大创五科目经费液位仪 | `grant-audit.matrixos.edu` | 五柱流体压差计 | MatrixOS 原创 |

### 轨道 3 · 情报 & 轨道 4 · 星门

| ID | 微站 | 域名 | UI 形态 | 来源 |
| :-- | :--- | :--- | :--- | :--- |
| 04 | PAT-HOT 学科脉冲雷达 | `pat-hot.matrixos.edu` | 24h 频谱瀑布流 | PAT-HOT 实机原型 |
| 05 | 五源跨库引文声呐站 | `lit-sonar.matrixos.edu` | 引力透镜拓扑图 | ScholarMatrix 拆解 |
| 06 | 星门 · 导师五维星象仪 | `mentor.matrixos.edu` | 天文星象五维雷达 | 星门 实机原型 |
| 07 | 证据内嵌式套磁信推演器 | `cold-email.matrixos.edu` | 双栏红蓝对抗推演器 | 星门 实机原型 |
| 08 | 太空任务式进组跟进台账 | `lab-kanban.matrixos.edu` | 航天任务控制看板 | 星门 实机原型 |

### 轨道 5 · 学术星轨工坊

| ID | 微站 | 域名 | UI 形态 | 来源 |
| :-- | :--- | :--- | :--- | :--- |
| 09 | Matrix-Cross 跨论文对比矩阵 | `matrix-cross.matrixos.edu` | 激光溯源对比网格 | ScholarMatrix 核心 |
| 10 | PDF 公式与参量狙击镜 | `pdf-sniper.matrixos.edu` | 双栏光学瞄准阅读器 | ScholarMatrix 拆解 |
| 11 | CurveLab 非线性拟合示波器 | `curvelab.matrixos.edu` | 荧光示波器与阻尼旋钮 | ScholarMatrix 核心 |
| 12 | 顶刊代码复现核验舱 | `repro-check.matrixos.edu` | 飞行前机械检查单 | ScholarMatrix 拆解 |
| 13 | Nature 级出版图表熔炉 | `chart-foundry.matrixos.edu` | 光学暗房调色台 | ScholarMatrix 拆解 |
| 14 | 综述拓扑推演与写作舱 | `review-lab.matrixos.edu` | 章节逻辑流建筑台 | ScholarMatrix 拆解 |
| 15 | 撤稿深海声呐与伦理合规仪 | `retract-radar.matrixos.edu` | 360° 极坐标声呐盘 | ScholarMatrix 拆解 |

### 轨道 6 · 云衡 & 轨道 7 · 预职

| ID | 微站 | 域名 | UI 形态 | 来源 |
| :-- | :--- | :--- | :--- | :--- |
| 16 | 云衡 · 数字天平综测核算器 | `yunheng.matrixos.edu` | 精密三盘电子天平 | 预职 & ScholarMatrix |
| 17 | 区块链级学术证据简历工坊 | `evidence-cv.matrixos.edu` | 绿标验真数字徽章台 | 预职 WorkBuddy 原型 |
| 18 | 生涯多重宇宙期望决策树 | `prejob.matrixos.edu` | 量子分岔概率光轨沙盘 | 预职 WorkBuddy 原型 |

> 机器可读花名册：[`specs/microsites.json`](specs/microsites.json)

---

## 双端不对称协同

| | 口袋微信小程序（移动伴侣端） | 桌面 WebOS（重型攻坚端） |
| :--- | :--- | :--- |
| **定位** | 高频碎片化 | 长周期深任务 |
| **场景** | 08:00 晨间三卡早报、微目标打卡、进组/面试强提醒、学术名片 | 跨论文长文本对比矩阵、30+ 非线性回归实验台、综述推演、全息决策树 |
| **指标** | 冷启动 < 800ms，单手轻交互 | 自适应画布动态装配，可切 2~3 仪器同屏 |
| **协同** | 「⚡ 推入电脑端对比矩阵待办队列」 | 接收后自动唤醒对应微站 |

**铁律**：严禁把桌面重型功能搬运到移动端。

---

## 模型分级调度（单用户年均 API 成本 < ¥1.5）

```
[用户意图]
    │
    ▼
┌──────────────────────────────────┐
│ TIER 01 · DeepSeek V4.1 Flash    │  ¥0.30 / 百万 token
│ 意图分词 · 虫洞类型识别 · 早报合成 │
└──────────────┬───────────────────┘
      ┌────────┴────────┬──────────────────┐
      ▼                 ▼                  ▼
 TIER 02           TIER 03            TIER 04
 Qwen 3.8 Flash    DeepSeek V4 Pro    Qwen 3.8-7B LoRA
 ¥0.40/M           ¥2.00/M            ¥0 (本地/校内算力)
 Schema 校验        长上下文对比        未发表数据
 代码自愈           综述推演            术语校准
 表格对齐           套磁信深度定制      隐私隔离
```

---

## 四阶段交付

| Stage | 周期 | 目标 | 关键交付物 |
| :--- | :--- | :--- | :--- |
| **1** | 2 个月 | 解耦与接口协议标准化 | 42 工具解耦为无状态 API、统一调度 JSON Schema、monorepo 脚手架 |
| **2** | 3 个月 | 双端协同感知与大模型微调 | 小程序上线、WebOS 动态装配画布、DeepSeek V4.1 + 本地 Qwen LoRA 接入 |
| **3** | 4 个月 | 原型联调与高校试点部署 | 3 所重点大学物理/光电实验室、500+ 种子用户、星门×PAT-HOT 数据流打通 |
| **4** | 3 个月 | 资产闭环与立项验收 | 云衡综测加分材料、预职简历、大创结题报告、3 件软著 |

详见 [`docs/01-plan/02-roadmap.md`](docs/01-plan/02-roadmap.md)。

---

## 仓库结构

```
MatrixOS/
├── bundle/                 # 原始设计交付物（只读归档，勿修改）
│   ├── MatrixOS_v3_完整交互规范与UI图谱_高清版.html
│   ├── matrix_os_agent_execution_spec.md
│   └── UI_Renders/         # 4 张 16:9 概念渲染图
├── specs/                  # 机器可读规范
│   ├── microsites.json     # 18 微站权威花名册
│   └── contracts/          # Wormhole / Dispatch JSON Schema
├── docs/
│   ├── 00-analysis/        # Bundle 解构与差距分析
│   ├── 01-plan/            # 架构、路线图、WBS、ADR、风险
│   └── 02-engineering/     # 开发约定、实现状态盘点
├── packages/               # 3 个共享包（见「当前实现状态」）
├── services/               # 3 个后端服务（Python）
├── apps/                   # 总控台 + 18 微站 + 口袋小程序
├── scripts/                # 校验与工具脚本
│   ├── verify.mjs          # 单一校验入口
│   ├── doctor.mjs          # 环境 + 模块就绪度诊断
│   ├── gen-site.mjs        # 18 微站骨架生成器
│   ├── install-hooks.mjs   # 安装 pre-commit 钩子
│   ├── validate-specs.mjs  # 契约 + 花名册 + 编码
│   └── check-doc-links.mjs # 文档断链
├── .github/                # Issue/PR 模板、协作规范、CI 工作流
└── README.md
```

> **注意**：`bundle/` 是设计交付物（HTML 图谱 + 概念渲染图），**不含可运行的产品代码**。
> 产品实现已从 Stage 1 开始落入 `apps/`、`packages/`、`services/`，进度见下一节。

### 提交前校验

本仓库的 **GitHub Actions 目前尚未生效**（账户计费受限，用户已申请学生认证，权益未到账）。
`.github/workflows/verify.yml` 已就绪待生效，**在此之前校验由本地 `pre-commit` 钩子承担**，新克隆后装一次：

```bash
node scripts/install-hooks.mjs
```

之后每次 `git commit` 自动跑契约校验 + 断链检查 + 编码检查，不通过即拒绝提交。手动跑：`pnpm check`。
详见 [`docs/02-engineering/01-dev-setup.md`](docs/02-engineering/01-dev-setup.md)。

---

## 当前实现状态

> 盘点日期：2026-10-20 · 完整明细见 [`docs/02-engineering/04-implementation-status.md`](docs/02-engineering/04-implementation-status.md)

**一句话**：脚手架已铺满 9 个模块，逻辑层实现质量不错，但业务层（18 个微站的工具、小程序页面、pocket 接口）基本还是骨架。

**「能构建」不等于「有功能」** —— 这是阅读本节最需要带上的判断。

### 九模块就绪度

| # | 模块 | 状态 | 源文件 | 测试 | 能构建 |
| :-- | :--- | :--- | --: | --: | :-- |
| 1 | `packages/twin-schema` | ✅ 已实现 | 15 | **162 passed** | ✅ |
| 2 | `packages/matrix-sdk` | ✅ 已实现 | 20 | 1 passed | ✅ |
| 3 | `packages/instrument-ui` | ✅ 已实现 | 46 | ❌ 0 | ✅ |
| 4 | `services/matrix-core` | 🔶 部分实现 | 50 | ❌ 0 | n/a（Python） |
| 5 | `services/copilot-router` | ✅ 已实现 | 18 | **179 passed · 81%** | n/a（Python） |
| 6 | `services/openalex-pat-worker` | 🔶 部分实现 | 32 | 43 passed | n/a（Python） |
| 7 | `apps/orbital-hub` | 🔶 部分实现 | 27 | ❌ 0 | ⚠️ 见下 |
| 8 | `apps/wechat-pocket` | 🔶 部分实现 | 20 | ❌ 0 | ❌ 无 build 任务 |
| 9 | `apps/micro-sites`（18 站） | 🔶 仅骨架 | 306 | ❌ 0 | ⚠️ 见下 |

**自动化测试合计 385 个通过**（162 + 1 + 179 + 43），但集中在前 4 个模块 —— 有测试的模块只有 4/9。

### 各模块做到了什么程度

| 模块 | 已经能用的 | 还缺的 |
| :--- | :--- | :--- |
| **twin-schema** | 三份契约的 Schema + zod 校验，测试充分 | — |
| **matrix-sdk** | SSO / 虫洞 / iframe 桥 / manifest 校验齐全 | 只有 1 个 smoke 用例；`security/origin` 等安全面零测试 |
| **instrument-ui** | 10 个仪器组件 + 设计 token，vite 构建通过 | 零测试；`test` 脚本指向不存在的 `scripts/self-test.mjs` |
| **matrix-core** | 鉴权（RS256/JWKS/黑名单）、资产（含乐观锁）、虫洞收据路由真实存在 | **零测试**；无 `/v1/pocket/*`；无 `/v1/pat/*` |
| **copilot-router** | 路由/计费/缓存/降级/敏感度，179 测试 81% 覆盖 | `api.py` 与 `api_models.py` 覆盖率为 **0%** |
| **openalex-pat-worker** | 热度/脉冲计算 + 43 个测试 | 未接入 matrix-core，目前是孤立服务 |
| **orbital-hub** | 总控台组件齐全（星轨场、虫洞环、仪器架、Copilot 波） | **无队列接收器**；无测试 |
| **wechat-pocket** | 逻辑层完整：鉴权/请求/缓存/sync 通道/QR 编码器 | **视图层为零**：0 个页面、0 个组件、0 张图标、无 `app.ts` |
| **micro-sites** | 18 站骨架 + manifest 合规 + 命名符合 ADR-001 | 页面是占位骨架，**没有一个真实业务工具** |

### 两个最容易被误判的点

**1. 18 微站 ≠ 18 个可用工具。**
18 个站点全部由 `scripts/gen-site.mjs` 生成，每个 `page.tsx` 都标着「骨架 / 占位」，
渲染的是同一套占位柱状图（高度写死为 `[38, 62, 47, 81, 55, 70, 44, 92, 66, 51]`）。
ADR-001 规定的 UI 形态（精密推子配重仪、五柱流体压差计、360° 极坐标声呐盘…）**一个都没实现**。

**2. 小程序 `typecheck` 通过 ≠ 小程序能跑。**
`apps/wechat-pocket/tsconfig.json` 只 include `miniprogram/**/*.ts`，
而 `pages/`、`components/`、`pkg-queue/`、`assets/tabbar/` **全是空目录**，也没有 `app.ts`。
微信开发者工具打开会直接报错。详见 [`apps/wechat-pocket/README.md`](apps/wechat-pocket/README.md)。

### 构建与验证现状

| 项 | 命令 | 结果 |
| :--- | :--- | :--- |
| 类型检查 | `npx turbo run typecheck` | ✅ **25/25**（23 个包 + 2 个依赖前置 build） |
| 构建 | `npx turbo run build --concurrency=2` | ✅ **22/22** |
| 构建（默认并发） | `npx turbo run build` | ⚠️ **不稳定**，实测 17–20/22，每次失败包不同 |
| Python 语法 | `ast.parse` 全量 | ✅ 96 文件 0 失败 |
| 契约 + 断链 | `node scripts/verify.mjs` | ✅ 2/2 |

> ⚠️ **构建必须降并发**：19 个 Next.js 应用同时读写各自 `.next/`，在 Windows 上会撞出
> `ENOENT` 假红灯。请统一使用 `--concurrency=2`。详见
> [`docs/02-engineering/00-known-issues.md`](docs/02-engineering/00-known-issues.md#附构建不稳定非阻塞但会造成假红灯)。

### 当前短板（按优先级）

| 优先级 | 事项 |
| :--- | :--- |
| **P0** | `matrix-core` 补测试（承载鉴权与资产的核心服务零测试） |
| **P0** | `wechat-pocket` 补 `app.ts` + 6 个页面 + 8 张 tabBar 图标（否则完全无法启动） |
| **P1** | `matrix-core` 补 `/v1/pocket/*` 与 WSS（小程序目前 13 个端点全是 mock） |
| **P1** | 统一用 `--concurrency=2` 构建，消除假红灯 |
| **P2** | 修 `scripts/self-test.mjs` 缺失；补 `copilot-router` 的 `api.py` 测试 |

---

## ⚠️ 开工前必读：两条已裁决的关键事实

### 1. Bundle 内两份规范互相冲突，v3 HTML 图谱为唯一权威源

`bundle/matrix_os_agent_execution_spec.md` 经全文关键词扫描确认是 **v2 时代旧稿**——`18` / `v3` / `orbital` / `wormhole` / `Q1-Q5` / `Turborepo` / `Next.js` / `pgvector` / `MatrixID` 出现次数**全部为 0 次**。它描述的「42 工具 + `services/` + `core-agent/` 集中式状态机」与 v3 的「18 独立微站 + Turborepo + 虫洞投送」根本不可调和。

**裁决：以 HTML 图谱为准，MD 旧稿降级为历史参考。**
完整证据与影响分析见 [`docs/01-plan/00-adr-000-spec-authority.md`](docs/01-plan/00-adr-000-spec-authority.md)。

### 2. HTML 图谱是设计演示页，不是产品原型

它能点击、能拖动滑块、能弹出虫洞环，但：

| 检查项 | 实际 |
| :--- | :--- |
| `fetch` / `XHR` 网络请求 | **0 处** |
| `localStorage` / `indexedDB` 持久化 | **0 处** |
| `draggable` / `dragstart` / `dataTransfer` 真实拖拽 | **0 处** |
| Q3 核心交互「拖拽即张开虫洞环」 | **未实现**，仅点击弹窗 + 文案 |
| CurveLab 的 R² | 装饰性公式 `max(0.912, 0.996 - noise*0.0022)`，非真实拟合 |
| 4 张渲染图 | **AI 生成**，含伪造文字（`Hytothesis Lab`、`Enformatics`、`Ceiton Mareme` 等） |

**结论**：设计稿 ≠ 可交付产品。产品代码从 Stage 1 第一行开始写，详见 [`bundle/README.md`](bundle/README.md)。

---

## 已知阻塞项

见 [`docs/02-engineering/00-known-issues.md`](docs/02-engineering/00-known-issues.md)。当前**无阻塞开发的项**：

| ID | 问题 | 状态 |
| :--- | :--- | :--- |
| BLK-001 | GitHub Actions 因账户计费无法启动 | 🔶 已绕过（本地钩子有效）；工作流已重建，**等学生认证权益到账** |
| BLK-002 | `D:\MatrixOS` 无写入权限 | ✅ 已解决（UAC 提权修复 ACL） |
| BLK-003 | Hindsight 记忆库额度耗尽 | ⚠️ 降级（不影响开发） |

> BLK-001 说明：`.github/workflows/verify.yml` 与 `sync-labels.yml` 已入库待生效，
> 但**至今一次都没成功运行过** —— 权益到账前，本地 pre-commit 钩子是唯一有效的强制门禁。

---

## 项目状态

| 项 | 状态 |
| :--- | :--- |
| Bundle 分析 | ✅ 已完成 |
| 工程规划 | ✅ 已完成（ADR-000/001 已裁决） |
| 协作仓库 | ✅ 已上线 |
| Stage 1 脚手架 | ✅ 9 个模块全部铺开 |
| Stage 1 业务逻辑 | 🔄 逻辑层完成，业务层待补（见[当前实现状态](#当前实现状态)） |
| CI 远端门禁 | 🔶 工作流已就绪，等 Actions 权益 |

---

## 参与协作

1. 先读 [`docs/01-plan/01-architecture.md`](docs/01-plan/01-architecture.md) 建立全局理解
2. 再读 [`docs/02-engineering/04-implementation-status.md`](docs/02-engineering/04-implementation-status.md) 弄清**现在到底有什么、缺什么**（别被"能构建"误导）
3. 遵循 [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) 的分支与提交规范
4. 从 [Issues](../../issues) 中挑选带 `good-first-issue` 或对应 Stage 标签的任务
5. 任务状态以 [Project 看板](../../projects) 为准

---

## 合规声明

- 本项目涉及高校综测申报、经费报销与学术伦理，所有对外功能须符合教育部及所在高校相关规定
- AI 辅助生成内容须标注，符合顶刊 AI 使用披露规范
- 课题组未发表数据仅在端侧/校内算力处理，禁止出境或上传第三方模型

---

<p align="center">
  <sub>MatrixOS v3.0 · 智轨星云 · Built for 拔尖创新人才</sub>
</p>
