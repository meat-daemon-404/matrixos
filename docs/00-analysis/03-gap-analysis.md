# 差距分析 · 从四大原型到 v3 目标态

> **权威裁决**：[`ADR-000 · 规范权威性裁决`](../01-plan/00-adr-000-spec-authority.md) —— `bundle/MatrixOS_v3_*.html` 中的架构定义是**唯一权威源**；`bundle/matrix_os_agent_execution_spec.md`（v2 旧稿）已**降级为历史参考**，不得作为开发依据。本文件中所有"目标态"描述均以 v3 为准。
> **前置阅读**：[`01-inventory.md`](01-inventory.md)（Bundle 到底有什么）、[`02-requirements.md`](02-requirements.md)（产品要做成什么样）。
> **本文件回答三个问题**：现在有什么 → 目标是什么 → 中间差多少，以及**这个差是"实现难度"还是"规格缺失"**。

---

## 一、结论摘要（给决策者）

| 判断 | 结论 |
| :--- | :--- |
| **当前真实起点** | 4 个已上线可运行原型 + 1 个不可运行的设计原型 + 0 行产品代码 |
| **最本质的差距** | 不是"某个功能没做"，而是 **18 个微站的业务逻辑一个都没实现**，且**数据底座（DigitalTwinAssetGraph）完全没有设计** |
| **最大风险** | "文档完整度"制造"接近完成"的错觉（18 域名 / 5 TIER / ¥20,000 预算全都在，但 0 张数据库表） |
| **最需要立刻补的** | `02-requirements.md` §9 列出的 **R1–R10 十项规格缺口**——这些是"没有规格"而非"没有实现"，不补则 Stage 1 无法开工 |
| **可以放心继承的** | Wormhole 契约（含证据锚点必填的防幻觉设计）、18 站花名册、7 站闭环、Q1–Q5 决策、视觉 token |
| **必须重做的** | 虫洞拖拽（当前是点击弹窗）、CurveLab 拟合（当前 R² 是假公式）、跨端同步（当前是 Toast 文案） |

---

## 二、规范冲突：双规范的后果（**已裁决**）

### 2.1 事实

`bundle/` 里两份规范描述**两套互不兼容的架构**：

| 维度 | v2 旧稿（`matrix_os_agent_execution_spec.md`） | v3 图谱（HTML，权威） |
| :--- | :--- | :--- |
| 产品形态 | 42 工具挤在单一应用 | 18 个独立微站（各自子域名） |
| 目录结构 | `services/` + `core-agent/` + `clients/` | `apps/` + `packages/` + `services/`（Turborepo） |
| 调度模型 | 集中式中台状态机（5 步流水线） | 全局 Copilot + 去中心化虫洞投送 |
| 前端技术 | "React/Vue3 + Tailwind + Vite"（未定） | Next.js 15 + Turborepo（已定） |
| 账号体系 | 未提及 | MatrixID（OAuth2 + JWT） |
| 数据底座 | 未提及 | DigitalTwinAssetGraph（PostgreSQL + pgvector + IndexedDB） |
| 扩展机制 | 无 | `@matrixos/sdk` + `matrix-app.manifest.json` |
| 视觉体系 | 未描述 | 星轨引力场 + 精密仪器双态合体 |

v2 旧稿对 v3 关键词的命中率：`18`=0、`v3`=0、`orbital`=0、`wormhole`/`虫洞`=0、`Q1`-`Q5`=0、`Turborepo`=0、`Next.js`=0、`pgvector`=0、`MatrixID`=0、`DigitalTwin`=0、`群岛`=0、`微站`=0、`插槽`=0、`manifest`=0。

### 2.2 裁决（引用 ADR-000）

**v3 HTML 图谱为唯一权威源；v2 MD 降级为历史参考，保留归档但不得作为开发依据。** 详见 [`ADR-000`](../01-plan/00-adr-000-spec-authority.md) 的 Decision 与 Consequences 段。

### 2.3 如果误按 v2 开工，会踩什么坑

这一节是给"万一手滑按旧稿做了"的事后补救参考，也是 ADR-000 的执行检查点依据。

#### 坑 1 · 目录结构错，返工成本最高

v2 要求建：
```
matrix-os/
├── services/          # 42+ 原子微服务池
├── core-agent/        # 中台调度 Agent 状态机
│   ├── router/  models/  security/  state_machine.py
├── clients/
│   ├── miniprogram/       # 原生 WXML/WXSS/TS
│   └── webos-canvas/      # React/Vue3 + Tailwind + Vite
├── contracts/
└── deployment/
```

v3 要求建：
```
matrix-os-v3/
├── apps/
│   ├── orbital-hub/        # 双态合体总控台
│   ├── micro-sites/        # 18 个独立部署微站
│   │   └── 01-gpa-sandbox/ … 18-prejob-multiverse/
│   └── wechat-pocket/
├── packages/
│   ├── matrix-sdk/  instrument-ui/  twin-schema/
└── services/
    ├── copilot-router/  openalex-pat-worker/
```

**实质差异**：
- v2 的 `core-agent/` **在 v3 里不存在**。v3 用 `packages/matrix-sdk`（前端 SDK 形态的虫洞环组件）+ `services/copilot-router`（纯路由网关）替代。若按 v2 建了 `core-agent/`，其"状态机"职责在 v3 里被拆散到 SDK 与 router 两处，**代码基本要重写**。
- v2 的 `clients/webos-canvas/` 是"一个画布应用"。v3 要求 **18 个独立的 `apps/micro-sites/*` 应用** + 1 个 `apps/orbital-hub`。**从 1 个 app 变 19 个 app**，构建配置、依赖管理、部署流水线全部不同。
- v2 无 `packages/` 层。而 v3 的三个 package（`matrix-sdk` / `instrument-ui` / `twin-schema`）是 18 个微站的共享基础——**如果不先建 packages，18 个站会各自复制一遍仪器组件，后期无法收敛**。
- v3 明确 **Turborepo**；v2 未提 monorepo 工具。选错工具链（如 Lerna/Nx/pnpm workspace 裸用）会导致后续迁移。

**返工成本估计（对照 `docs/01-plan/03-work-breakdown.md` 的任务粒度）**：Stage 1 的脚手架类任务（`S1-01`~`S1-06`）若按 v2 建，需全部重做，约占 Stage 1 工期的 **15–20%**。

#### 坑 2 · 调度模型错，越晚越痛

| | v2 集中式 | v3 去中心化 |
| :--- | :--- | :--- |
| 核心机制 | 中台 Agent 收意图 → 生成 DAG → 派发微服务 → 渲染画布 | 全局 Copilot（唯一）+ 用户在任意微站拖拽卡片 → 虫洞环 → 目标微站收货 |
| 数据流向 | **星型**（全部经过中台） | **网状**（微站 ↔ 微站，Copilot 只做意图识别） |
| 协议 | `MatrixOS_Dispatch_Contract`（trace_id / user_id / intent / station_id / workflow[]） | `MatrixOS_v3_Wormhole_Envelope`（trace_id / matrix_uid / source_app / target_app / payload_type / payload{data, evidence_anchors}） |
| 状态管理 | 中台状态机持有工作流状态 | 每站自治，投送即完（fire-and-forget + trace_id 追踪） |

**后果**：
- v2 的 5 步流水线（Intent Parse → Plan & Route → Specialist Dispatch → Microservice Invocation → Canvas Render）**要求把 18 个站的调用都收编到一个中央编排器**。这与 v3 的"用户在 A 站拖个卡片到 B 站"是**完全不同的交互范式**——后者根本不需要中台生成 DAG，用户自己就是编排器。
- 如果按 v2 实现了中央编排器，Q3 的"跨站虫洞拖拽"会变得**无法自然表达**：拖拽是一个纯前端手势，把数据直接从前端投到另一个前端；而 v2 的模型要求所有调用经过服务端编排。
- **两份契约的分层也不同**：Dispatch 是"意图 → 服务调用"；Wormhole 是"资产 → 资产搬运"。两者可共存（前者用于 Copilot 内部调度，后者用于跨站投送），但**不能互相替代**。v3 只定义了 Wormhole，Dispatch 属于 ADR-000 里"选择性继承"的第 1 条。

#### 坑 3 · 无向量库 → 三个核心功能直接缺失

v2 旧稿**完全没提向量库/embedding/pgvector**（`pgvector`=0）。而 v3 的 `DigitalTwinAssetGraph` 明确要求 PostgreSQL + pgvector。依赖向量检索的功能至少有：

| 功能 | 所属微站 | 依赖方式 |
| :--- | :--- | :--- |
| 导师匹配度量化（"张教授 94.2%"） | `06 mentor` | 需把导师画像与学生画像 embed 后算相似度 |
| 五源跨库语义检索（"可视化开山鼻祖与最新演进"） | `05 lit-sonar` | 语义召回 + 引文网络拓扑 |
| 文献按技术流派自动聚类（"生成带精准引文的综述初稿"） | `14 review-lab` | 论文 embedding 聚类 |
| TIER 04 "导师匹配度向量空间对齐" | 模型层 | v2 旧稿自己写了这条，但没建向量库 |

**后果**：按 v2 开工时若只建 PostgreSQL 关系表，到 Stage 2/3 才发现需要向量检索，则要**回填全部历史数据的 embedding + 重建索引**，且 `twin-schema` 的表设计要改（向量列、索引类型 HNSW/IVFFlat、维数决策）。这是典型的"越晚越痛"。

#### 坑 4 · 无扩展机制 → Q5 从第一天就偏离

v2 旧稿 `插槽`=0、`manifest`=0、`SDK` 无定义。v3 的 Q5 要求：核心团队维护 18 站，同时第三方实验室能通过 `matrix-app.manifest.json` 热插拔。

**后果**：如果 18 个站是按"写死的 18 个"来建的（没有 manifest 驱动的注册表、没有 `orbit_station` 挂载点、没有 `accepts`/`emits` 声明），那么加第 19 站就要改核心代码。**Q5 是"从架构第一天就要留的口子"**，不能后补。

### 2.4 v2 旧稿中仍可选择性继承的 4 条（引自 ADR-000 Decision 段）

| # | 内容 | 继承方式 |
| :-- | :--- | :--- |
| 1 | **五步执行流水线**（Intent Parse → Plan & Route → Specialist Dispatch → Microservice Invocation → Canvas Render & Asset Sync） | 作为 Copilot **内部**编排流程参考，但需改造为 v3 的虫洞投送模型（用户手势优先，而非中台 DAG 优先） |
| 2 | **四个垂直专席 Agent**（物理光电、生物医药、计算工程、人文法学） | v3 未提及，可保留为 `copilot-router` 的**路由维度**（`dispatch-contract.schema.json` 的 `intent.discipline` 字段已留位，示例值为「物理/光电/生物医药/计算工程/人文法学」） |
| 3 | **7 站状态枚举**（`study`/`spark`/`pat_hot`/`xingmen`/`workshop`/`cloud_balance`/`pre_job`） | 与 v3 **完全一致，无冲突**，直接使用（已落地于 `specs/contracts/*.schema.json`） |
| 4 | **双端不对称协同原则** | 两版一致，v3 表述更具体（冷启动 < 800ms、四卡结构） |

> 这 4 条之外的内容（`services/` 目录树、`core-agent/` 状态机、`clients/` 结构）**不继承**。

### 2.5 「42 工具 → 18 微站」的映射缺口（Stage 1 的真实工作量）

这是 ADR-000 明确指出的代价：v2 的 42 工具解耦清单**不能直接照搬**到 v3 的 18 微站。

**已知的映射关系**（据花名册 `source` 字段）：

| 来源 | 站数 | 站 ID |
| :--- | ---: | :--- |
| ScholarMatrix 拆解 / 核心 | 10 | 01, 02, 05, 09, 10, 11, 12, 13, 14, 15 |
| 预职 & ScholarMatrix（双源） | 1 | 16 |
| 星门（3 站） | 3 | 06, 07, 08 |
| 预职 WorkBuddy | 2 | 17, 18 |
| PAT-HOT | 1 | 04 |
| **MatrixOS 原创（无原型）** | 1 | 03 |

**缺口的三个具体表现**：

1. **42 个工具的名称/能力清单在 Bundle 中不存在。** v2 只说"42+ 工具"（`42` 出现 3 次），从未列举是哪 42 个。因此**无法验证"42 → 11 个 ScholarMatrix 微站"这个映射是否穷尽、是否重复**。Stage 1 的第一件事必须是去 `scholarmatrix.cc.cd` 盘点真实工具清单（这也是 `03-work-breakdown.md` 中 `S1-07e` 任务的由来）。

2. **平均压缩率 42 ÷ 11 ≈ 3.8 个工具/站，但不是均匀分布。** 轨道 5（工坊）扛了 7 站，其中 09（Matrix-Cross）与 11（CurveLab）是"核心"，其余 5 个是"拆解"。这意味着**部分微站要合并 5–6 个原工具的功能**，而 `10 pdf-sniper`、`12 repro-check` 这类可能只对应 1–2 个工具。**站与工具的对应是一对多，需要逐站定"这个站到底含哪些原工具"**。

3. **03（grant-audit）是原创站，无原型可拆。** 它的"大创五科目经费液位仪"需要从零设计（好在 Bundle 给了完整的 ¥20,000 预算表与 ≤20% 红线规则，规格相对清楚）。

**工作量口径**：ADR-000 已估"约 2 pd 做工具→微站归属映射"，并入 `S1-07e`。但**前提是能访问到 ScholarMatrix 的真实工具列表**——如果 `scholarmatrix.cc.cd` 已下线或不可访问（见 §4.1），这项工作会退化为"重新定义 42 个工具"，工作量翻倍。

---

## 三、设计稿 ≠ 可交付产品：四项硬证据

以下四项是"看起来真、实际假"的确凿证据。它们共同说明：**Bundle 的 Tab 2 沙盘是演示性质的一次性前端，不能作为产品代码的起点迭代，必须重做。**

### 3.1 证据一：Q3 的核心交互「虫洞拖拽」完全未实现

**承诺**（HTML L374，Q3 原文）：
> "在任意微站按住数据卡片拖拽，鼠标周围即刻张开全息**「Agent 跨站虫洞环 (`WormholeDropRing`)」**，松手即可携带结构化参数与 PDF 证据锚点空间翻转至目标微站。"

**实测**：

| API / 属性 | 出现次数 |
| :--- | ---: |
| `draggable` | **0** |
| `dragstart` | **0** |
| `dragover` | **0** |
| `dragend` | **0** |
| `dragenter` | **0** |
| `dataTransfer` | **0** |
| `pointerdown` | **0** |
| `mousedown` | **0** |
| `touchstart` | **0** |
| `WormholeDropRing` | **2**（均为纯文案） |

**实际实现路径**（`summonWormholeModal` L1664 → `executeWormholeTeleport` L1675）：
```
用户点击「拖入跨站虫洞」按钮
  → summonWormholeModal() 显示隐藏的 div#wormholeModal
  → 用户点击环上 3 个目标按钮之一
  → executeWormholeTeleport() 往 div#wormholeResultBanner 写入一句成功文案
  → showToast("虫洞空间翻转完成：数据已直达 XXX")
```

> **结论**：**从"拖拽手势 + 跟随鼠标的环 + 松手投送"退化成了"点击按钮 + 弹窗 + 点击目标 + 显示横幅"。**
>
> 这不是"实现不完整"，是**交互范式完全不同**。真正的 `WormholeDropRing` 需要：Pointer Events（而非 Mouse）、跟随光标的浮层渲染、拖拽源与目标站的命中检测、拖拽时的数据序列化、跨域投送的 postMessage/iframe 通道。当前代码里**一行都没有**，且现有的"弹窗"实现无法演化成拖拽实现——必须重写。

### 3.2 证据二：CurveLab 的 R² 是装饰性公式，不是真算的

**承诺**（微站 11 的 `desc`）："内置双指数衰减、洛伦兹峰拟合等 30+ 统计模型，**实时显示置信带与 R²**"。

**实测**（`drawCurveLab`, L1509）：
```js
const r2 = Math.max(0.912, (0.996 - noiseLvl * 0.0022)).toFixed(4);
```

分析：
- `noiseLvl` 是滑块的整数档位（1–15）
- 因此 **R² 严格是 noiseLvl 的线性函数**，且只与噪声档位有关
- **与 τ₁、τ₂ 完全无关** —— 即使把衰减常数拖到与散点毫不匹配，R² 依然是 0.99
- `Math.max(0.912, ...)` 只是把下界钳在 0.912，永不显示差拟合

对应关系（noiseLvl → 显示值）：

| 滑块档位 | 显示 R² |
| ---: | ---: |
| 1 | 0.9938 |
| 4（默认） | 0.9872 |
| 6 | 0.9828 |
| 15（最大噪声） | 0.9630 |

**同一函数里还有两个假数据**：

| 项 | 代码 | 问题 |
| :--- | :--- | :--- |
| 散点 | `Math.sin(i * 2.7 + tau1) * (noiseLvl * 1.2)` | **确定性正弦，非随机采样**。任何用户、任何刷新看到的"实验数据"完全相同 |
| 置信带 | `±(noiseLvl * 1.1)` **像素**偏移 | 恒定像素带宽，**不是统计置信区间**（真正的置信带要由协方差矩阵算） |

> **结论**：**这个微站的产品卖点（"实时显示置信带与 R²"）在演示中完全是假的。**
>
> 对答辩的具体风险：若评委拖动 slider 观察，会发现 R² 与曲线形状脱钩、且严格线性。真正的实现需要：接入 SciPy/`curve_fit` 或前端 `ml-levenberg-marquardt`、对实际残差算 R²、由参数协方差算置信带、支持真实的 30+ 模型。**Estimated 工作量：这个微站单站约 8–12 pd**（对照 `03-work-breakdown.md`），当前实现提供的是 0。

### 3.3 证据三：零网络、零持久化——没有后端，也没有数据

**实测关键词计数**：

| API | 次数 |
| :--- | ---: |
| `fetch(` | **0** |
| `XMLHttpRequest` | **0** |
| `new WebSocket` | **0** |
| `localStorage` | **0** |
| `sessionStorage` | **0** |
| `indexedDB` | **0** |
| `navigator.`（任意） | **0** |
| `crypto.` | **0** |

**因此以下所有承诺均为纯文案：**

| 承诺 | 出处 | 实际 |
| :--- | :--- | :--- |
| "本地 IndexedDB 隐私仓已加密" | L614 沙盘顶栏 | 无 IndexedDB 调用 |
| "已通过 WebSocket 推入电脑端待读队列" | L1884 Toast | 无 WebSocket；实际只是 `pocketQueueCount++` 改一个数字 |
| "每站独立持久化项目台账" | 18 站 `ledger` 字段 | 无任何持久化。**刷新页面 = 全部状态丢失** |
| "MatrixID (OAuth2 + JWT) 单点通行" | Q2 | 只有一行写死的文案 "MatrixID: 孙同学 (光电大三 · GPA 3.86)" |
| "全局 Copilot 跨站上下文记忆" | Q3 | `executeGlobalCopilot()` 把用户输入回显到状态行 |
| "Manifest 校验" | L962 按钮文案 | 无 Schema 校验代码，只做 `trim() || 默认值` |

**唯一的内存态"业务逻辑"**是 `mountCustomLabApp()`：把新站 `push` 进 `MICRO_SITES` 数组并重渲染。**刷新即失。**

### 3.4 证据四：4 张渲染图是 AI 生成，含大量伪造文字

技术取证与视觉取证详见 [`01-inventory.md`](01-inventory.md) §5。关键事实：

| 项 | 结果 |
| :--- | :--- |
| EXIF | 4 张全部**无** `Make`/`Model`/`Software`/`DateTime` |
| 伪文字实例 | `Hytothesis Lab`（Hypothesis）、`Enformatics`、`Ceiton Mareme`、`Caosed`（Closed）、`Statuss`、`Curvetab`（CurveLab）、`Xangmeu`（Xingmen）、`Knlt`、`Gos.`/`Dre.`/`Mon`/`Lak`（表格列头）、`Podtuk`、`Kadsmice` |
| 事实错误 | UI_01 头部写 **`Academic Workspace v3.8`**（应为 v3.0）；UI_04 写 **`CPU 122.38 GHz`**（物理不可能） |
| 与代码 token 的偏离 | UI_01 主色 `#1c2e39`/`#07101b`，UI_02 主色 `#24686c` —— 均**不等于**代码定义的 `obsidian #050814` |

**影响**：图可以表达"视觉方向"，但**不能作为取色依据、像素还原目标或组件规格**。答辩展示时需标注"AI 概念图"。

---

## 四、四大原型现状 vs v3 目标态

### 4.1 原型线上资产核查状态

| 原型 | v3 声明的线上地址 | 本次核查结果 |
| :--- | :--- | :--- |
| **ScholarMatrix** | `https://scholarmatrix.cc.cd`（备用 `scholarmatrix.pages.dev/land/`） | ⚠️ **未能核查**（见下） |
| **星门 Xingmen** | `https://xingmen-mentor.pages.dev/` | ⚠️ 未能核查 |
| **PAT-HOT** | `https://pat-hot.pages.dev` | ⚠️ 未能核查 |
| **预职 Pre-Job** | `https://a9b81a7031ed59d7a.app.workbuddy.host/` | ⚠️ 未能核查 |

> ⚠️ **诚实声明**：本次分析环境**无法发起外部 HTTPS 请求**（`Invoke-WebRequest` 在非交互模式下失败，且分析环境未授权网络出口）。因此**四原型的线上可用性、真实功能清单、代码资产量均为"Bundle 未覆盖 + 本次未核实"**，不作任何猜测。
>
> 这项核查是 Stage 1 的**前置阻塞项**：若原型已下线，则"解耦迁移"退化为"重新开发"。责任人应在 Stage 1 第一周完成核查并回填本表。

### 4.2 逐原型能力对照

**能力项来源**：`matrix_os_agent_execution_spec.md` §2 的"现有能力资产"列 + v3 花名册的 `source`/`desc` 字段。

#### ScholarMatrix（承载 11 站：01/02/05/09/10/11/12/13/14/15/16）

| v2 声明的现有能力 | v3 目标落点 | 差距性质 |
| :--- | :--- | :--- |
| "42+ 工具" | 拆解为 10–11 个独立微站 | 🔴 **规格缺失**：42 个工具的名称清单 Bundle 未覆盖，无法验证映射完整性 |
| "Cross-Paper 对比矩阵" | → `09 matrix-cross`（核心） | 🟡 需重构 UI（激光溯源网格 + `pdf_page/bbox` 绑定） |
| "统计拟合实验台" | → `11 curvelab`（核心） | 🟡 需重构 UI（示波器 + 阻尼旋钮）；且"30+ 模型"的具体清单 Bundle 未覆盖 |
| "综述初稿生成" | → `14 review-lab` | 🟡 需接 TIER 03 长上下文模型 |
| —（v2 未提） | → `05 lit-sonar`、`10 pdf-sniper`、`12 repro-check`、`13 chart-foundry`、`15 retract-radar` | 🔴 **v3 新增要求**：v2 仅有"42+ 工具"笼统表述，这 5 站的具体能力需回到原型盘点 |
| —（v2 未提） | → `01 gpa`、`02 spark` | 🔴 v3 新增（v2 完全未提 GPA 配重与双创组队） |

#### 星门 Xingmen（承载 3 站：06/07/08）

| v2 声明的现有能力 | v3 目标落点 | 差距性质 |
| :--- | :--- | :--- |
| "导师全景学术画像" | → `06 mentor`（五维星象仪） | 🟡 需接 **OpenAlex 导师图谱 API**；v2 提到 OpenAlex，v3 的 `openalex-pat-worker` 服务承担 |
| "自适应个性化套磁信推演" | → `07 cold-email`（双栏红蓝对抗） | 🟡 需接 TIER 03 |
| "进组进度台账管理" | → `08 lab-kanban`（航天任务看板） | 🟢 4 阶段状态机（已发信→已读→待面试→已进组）规格清楚 |
| — | 三站拆分的**边界** | 🔴 **规格缺失**：v2 把三者视为"星门一个原型的一个模块"，v3 拆成 3 个独立站 + 各自台账。共享的导师画像数据放哪一站、如何复用，Bundle 未定义 |

#### PAT-HOT（承载 1 站：04）

| v2 声明的现有能力 | v3 目标落点 | 差距性质 |
| :--- | :--- | :--- |
| "物理、天文、光电垂直学科 24h 流式情报监听" | → `04 pat-hot`（频谱瀑布流） | 🟡 需封装为 `openalex-pat-worker` 服务 |
| "热度评估算法" | 同上 | 🔴 **算法规格缺失**：Bundle 只给了展示值（热度 98.4），未定义热度如何计算 |
| "每日 08:00 定时推送结构化早报 JSON" | → 小程序晨间三卡 | 🔴 **早报 JSON 结构未定义**；且"三卡"与实装"两卡"不一致 |

#### 预职 Pre-Job（承载 3 站：16/17/18）

| v2 声明的现有能力 | v3 目标落点 | 差距性质 |
| :--- | :--- | :--- |
| "证据级学术智能简历" | → `17 evidence-cv`（绿标验真徽章台） | 🟡 需实现 DOI/GitHub 验真链 |
| "升学/考公/求职多维决策树" | → `18 prejob`（多重宇宙概率树） | 🔴 **期望收益模型规格缺失**："量化推演未来 5 年期望收益与风险"——Bundle 未给任何收益函数、概率来源、风险定义 |
| "成长档案" | → `16 yunheng`（数字天平）+ `17` | 🔴 **综测细则缺失**：各校差异极大，Bundle 未给任何一所学校的规则模板 |
| — | "自动生成符合高校'云衡'综测申报规范的格式化成果包" | 🔴 **申报格式规格缺失**：v2 说要符合规范，但规范本身未提供 |

### 4.3 差距性质的三分类（这比"功能对不上"更有用）

Stage 1 排期时，必须区分以下三类，因为它们的**应对方式完全不同**：

| 类别 | 含义 | 数量 | 应对 |
| :--- | :--- | ---: | :--- |
| **A · 规格缺失** | Bundle 没写清楚要做什么，不是做不出来 | **高** | 先写 ADR / 规格文档，不能直接派开发任务 |
| **B · 实现缺失** | 规格清楚，但代码 0 行 | **极高** | 正常开发排期 |
| **C · 实现错误** | 有代码，但实现路径与产品目标不符，需重写 | 3 项 | 重做，不要试图改造 |

**A 类详单**（= `02-requirements.md` §9 的 R1–R10，再加本节新发现的）：

| ID | 规格缺口 | 阻塞对象 |
| :--- | :--- | :--- |
| R1 | 7 站枚举 ↔ 4 组 `orbit` 的映射 | Tab 3 筛选、全部微站的 `orbit_station` 归属 |
| R2 | `model_tier` 4 档（TIER）→ 3 档（`flash`/`pro`/`local`）的映射 | `copilot-router` |
| R3 | `DigitalTwinAssetGraph` 实体/关系模型 | **全部 18 站的数据层** |
| R4 | 18 站之间虫洞可达矩阵（`accepts`/`emits` × 5 payload_type） | `matrix-sdk`、全部站间联动 |
| R5 | `ledger` 台账的数据结构（18 条只有中文名） | 全部 18 站的持久化 |
| R6 | 综测细则 / 各校规则模板 | `16 yunheng` |
| R7 | `Level_A_Verified` 的可执行判定标准 | `15 retract-radar`、`17 evidence-cv`、Wormhole 契约的证据锚点校验 |
| R8 | 冷启动 <800ms 的度量口径 | 小程序验收 |
| R9 | "500+ 种子用户"获取方式 | Stage 3 试点 |
| R10 | `@matrixos/sdk` 的实际 API 签名（3 个方法名之外全空白） | Q5 全部，第三方接入 |
| **R11**（本次新增） | **42 个工具的清单**（v2 只说数字，从未列举） | Stage 1 全部解耦任务 |
| **R12**（本次新增） | PAT-HOT **热度算法**定义 | `04 pat-hot` |
| **R13**（本次新增） | "未来 5 年期望收益"的计算模型 | `18 prejob` |
| **R14**（本次新增） | 星门三站（06/07/08）的**数据边界**（导师画像存哪、如何共享） | `06`/`07`/`08` |
| **R15**（本次新增） | 早报 JSON 结构与"三卡 vs 两卡"的裁决 | `04`、小程序 |

**C 类详单**（必须重写，不可改造）：

| # | 组件 | 当前实现 | 为何不能改造 |
| :-- | :--- | :--- | :--- |
| C1 | `WormholeDropRing` 虫洞环 | 点击按钮 → 弹窗 → 点目标 → 显示横幅 | 交互范式不同（点击 vs 拖拽），且缺 Pointer Events / 命中检测 / 跨域通道，现有代码无法演化 |
| C2 | CurveLab 拟合与 R² | `max(0.912, 0.996 - noise*0.0022)` 装饰公式 + 正弦假散点 | 无真实拟合算法，需整体接入拟合库重写 |
| C3 | 跨端同步 | `pocketQueueCount++` + Toast 文案 | 无通信层，需从零建 WebSocket/推送通道 |

---

## 五、Bundle 本身未覆盖的部分（诚实清单）

### 5.1 后端与 API —— 完全没有

| 缺失项 | Bundle 现状 |
| :--- | :--- |
| 后端服务代码 | **0 行** |
| REST / gRPC API 定义 | **无**。v2 说"封装为标准化 REST/gRPC 协议工具池"，但**没有一个端点被定义**（无路径、无方法、无请求/响应体） |
| API 网关 / BFF | 无 |
| 鉴权服务 | 只有 "MatrixID (OAuth2 + JWT)" 一句描述，无 OAuth 流程、无 token 结构、无 scope 落地（Manifest 的 `permissions` 枚举了 6 个 scope 但无对应服务端校验逻辑） |

### 5.2 数据模型 —— 这是最大的空洞

| 缺失项 | Bundle 现状 |
| :--- | :--- |
| 数据库表结构 | **0 张表** |
| ER 图 | 无 |
| `DigitalTwinAssetGraph` 定义 | **只有名字**。Q2 说"PostgreSQL + pgvector + IndexedDB"，但**没有任何实体（论文/实验/软著/竞赛/导师/简历…）、关系或属性定义** |
| 向量 schema | 无（embedding 维度、索引类型、距离度量全部未定） |
| 18 个 `ledger` 的表结构 | 无（每条 `ledger` 只有一句中文描述） |
| 数据迁移 / seed 策略 | 无 |

> 🔴 **这是 Stage 1 的头号阻塞项。** 18 个微站每一个都需要持久化台账，但没有一张表的设计。`packages/twin-schema` 这个 package 在 v3 目录树里存在，但**里面的东西完全没定义**。

### 5.3 商业与运营数字 —— 三处不自洽

| # | 问题 | 证据 | 影响 |
| :-- | :--- | :--- | :--- |
| 1 | **单用户成本口径矛盾** | 页面标题宣称 `单用户年均 API 成本 < ¥1.5`（L984）；但财务仿真器用 `mau * 1.76` 作为年变动成本（L1768），即 **¥1.76/用户/年**，比目标高 17% | `1.76 < 1.5` 为 `false`。要么改目标要么改模型 |
| 2 | **"第 9 个月现金流转正"无依据** | L1023 宣称"第 9 个月实现现金流转正"；但全库 `逐月` **0 次**、`月度` **0 次**，仿真器只有**年度**口径 | 无法从年度数字推出月度转正点。要么补逐月模型，要么删掉这个宣称 |
| 3 | **仿真器的固定成本 ¥20,000 与预算表关系不明** | 仿真器固定项 `15000 + 6000 = ¥20,000`（L1768）；恰好等于**整个大创预算**。但预算表的 5 科目里**没有"研发人力 15,000"和"运维 6,000"这两项** | 两个 ¥20,000 是同一个钱还是两笔？若是同一笔，仿真器把大创经费用作"年研发运维支出"，与预算表科目无法对应。**答辩时若被追问会说不清** |

> 注：**预算表本身（¥6,800/¥4,500/¥2,700/¥3,500/¥2,500）算术完全正确**，五科目合计 ¥20,000、占比全对、劳务 12.5% ≤ 20% 红线满足。问题只出在仿真器与宣传口径，不在预算表。

### 5.4 部署与运维

| 缺失项 | Bundle 现状 |
| :--- | :--- |
| 部署方案 | v2 提到 `deployment/`（Dockerfile / K8s / CI-CD），v3 目录树**没有 deployment 目录** |
| 18 个微站的部署拓扑 | 无（18 个独立部署怎么管？一个 K8s 还是 18 个？子域名证书怎么发？） |
| CI/CD | 无 |
| 监控 / 日志 | 无 |
| 环境隔离（dev/staging/prod） | 无 |

### 5.5 合规、法律与伦理

| 缺失项 | Bundle 现状 |
| :--- | :--- |
| 学术伦理规范 | 只有"AI 学术伦理声明自动生成"功能描述（`15 retract-radar`），无生成规则 |
| 教育部 AI 披露规范的具体条款 | 提到"符合教育部及顶刊 AI 披露规范"，**未附条款** |
| 数据隐私（课题组未发表数据） | 只提"端侧 IndexedDB 隔离"，无威胁模型、无加密方案、无合规声明 |
| 高校综测规则的合法性 | 无 |
| 用户协议 / 隐私政策 | 无 |
| 软件著作权登记材料 | Stage 4 要交付 3 件软著，但**无清单、无代码归属划分**（18 个微站怎么拆成 3 件软著？） |

### 5.6 测试与质量

| 缺失项 | Bundle 现状 |
| :--- | :--- |
| 测试策略 | 无 |
| 验收标准（可执行） | Stage 1–4 只有一句话目标，无逐项验收条件（`docs/01-plan/02-roadmap.md` 已补） |
| 性能基准 | 只有"冷启动 < 800ms"一项，其余无 |
| 无障碍要求 | 无（且当前 HTML 的 `aria-*` = 0、`role=` = 0，见 `04-visual-system.md` §10-V5） |

---

## 六、命名与一致性问题（技术债）

### 6.1 域名命名漂移

| 域名 | 出现次数 | 在花名册？ | 问题 |
| :--- | ---: | :--- | :--- |
| `career.matrixos.edu` | 2（L240、L1399） | ❌ **不在** | 花名册的预职站是 `prejob.matrixos.edu` 与 `evidence-cv.matrixos.edu`。`career` 无主 |
| `orbital.matrixos.edu` | 3 | —（基础设施） | 总控台域名，合理，不在 18 站内 |
| `curvelab.matrixos.edu` | 7 | ✅ `11` | 出现最多，合理（Tab 2 主力演示站） |
| `bioseq.lab.matrixos.edu` | 1 | —（示例） | SDK 示例值，合理 |
| `custom.lab.matrixos.edu` | 1 | —（默认值） | JS 缺省值，合理 |

> 建议：Stage 1 统一为 `career` 是 `prejob` 的别名或直接删除。

### 6.2 蓝图目录树 vs 花名册（Tab 6 的 `masterSpecPre` 内部矛盾）

Tab 6 展示的 Monorepo 目录树（L1320–1350）与 Tab 3 的花名册**不完全对应**：

| 差异 | 目录树（Tab 6） | 花名册（Tab 3 / `specs/microsites.json`） |
| :--- | :--- | :--- |
| PAT-HOT | `04-pat-radar/` | `pat-hot.matrixos.edu` |
| 星门 | `05-xingmen-mentor/`（导师+进组**合并**） | `06 mentor` + `08 lab-kanban`（**分开**） |
| 套磁 | `06-cold-email-lab/` | `07 cold-email` |
| 文献检索 | `07-lit-sonar/` | `05 lit-sonar` |
| 综述 | `13-review-architect/` | `14 review-lab` |
| 投稿罗盘 | `15-journal-compass/` ← **花名册中无此站** | — |
| 撤稿声呐 | `14-retract-radar/` | `15 retract-radar` |
| 云衡 | `16-yunheng-scale/` | `16 yunheng` |
| 进组台账 | **目录树里没有** | `08 lab-kanban` |

**实质问题**：
1. **目录树有 `15-journal-compass`（期刊投稿罗盘），花名册里没有这一站**。花名册的 15 是 `retract-radar`。这是一处**真实的功能集合差异**——投稿罗盘这个能力到底做不做？
2. **目录树把"导师"与"进组"合并为一站（`05-xingmen-mentor`），花名册拆成两站（`06` + `08`）**，因此目录树从 06 起编号整体错位 1 位。
3. 因此**目录树的 18 个目录 ≠ 花名册的 18 个站**。

> **裁决依据**：ADR-000 已明确 `specs/microsites.json` 是权威花名册（从 HTML 内嵌 JS 的 `MICRO_SITES` 常量解析）。**目录树是蓝图里的示意，应以花名册为准，并修正目录树。**
>
> 需业主确认：`journal-compass`（投稿罗盘）**做还是不做**？若做，是第 19 站还是替换某站？这是 `02-requirements.md` R 系列之外的第 16 项规格缺口。

### 6.3 其他一致性缺陷

| # | 问题 | 证据 |
| :-- | :--- | :--- |
| 1 | README 来源归属算术错误 | README 称 ScholarMatrix "12 个站"，实际 11 个（且 03 是原创）。详见 `02-requirements.md` §3.2 |
| 2 | "晨间三卡"承诺 3 张，实装 2 张 | 文案 L1133/L136 vs `switchPocketView('brief')` 只渲染 2 张卡 |
| 3 | 32%/68% 文案 vs `col-span-4/8` = 33.33%/66.67% | L625 文案 vs L619 代码 |
| 4 | `model_tier` 枚举 3 档 vs TIER 表 4 档 | `dispatch-contract.schema.json` vs HTML L981–1012 |
| 5 | 7 站枚举 vs 花名册 4 组 `orbit` | `specs/contracts/*` vs `specs/microsites.json` |

---

## 七、技术债清单（按优先级）

| P | ID | 债务项 | 类型 | 影响面 | 建议处置 |
| :-- | :--- | :--- | :--- | :--- | :--- |
| **P0** | TD-01 | `DigitalTwinAssetGraph` 无任何数据模型定义 | A 规格缺失 | **全部 18 站** | Stage 1 第一交付物，先写 schema ADR |
| **P0** | TD-02 | 42 工具清单不存在，无法验证 →18 站映射 | A | Stage 1 全部解耦 | Stage 1 第 1 周核查原型并盘点 |
| **P0** | TD-03 | 双规范冲突（已裁决，但 v2 文件仍在） | 已缓解 | 团队认知 | ADR-000 + `bundle/README.md` 标注已完成 |
| **P0** | TD-04 | 虫洞拖拽未实现（C1） | C 需重写 | Q3 全部 | Stage 2 用 Pointer Events 重写 |
| **P1** | TD-05 | 7 站 ↔ 4 组 `orbit` 无映射 | A 规格缺失 | 筛选、路由、归属 | 补 `station` 字段 |
| **P1** | TD-06 | 18 站虫洞可达矩阵未定义 | A | 站间联动 | 补可达性矩阵 |
| **P1** | TD-07 | `ledger` 18 条无字段定义 | A | 全部持久化 | 随 TD-01 一起做 |
| **P1** | TD-08 | 目录树与花名册不一致（含 journal-compass 疑站） | B/C | Stage 1 脚手架 | 业主确认后修正 |
| **P1** | TD-09 | `model_tier` 4→3 档映射未定义 | A | `copilot-router` | 写 ADR |
| **P1** | TD-10 | 综测细则缺失 | A | `16 yunheng` | 至少先做 1 所试点校模板 |
| **P2** | TD-11 | CurveLab R² 是装饰公式（C2） | C 需重写 | 微站 11 | Stage 3 接真实拟合库 |
| **P2** | TD-12 | 跨端同步无通信层（C3） | C 需重写 | 小程序协同 | Stage 2 建 WebSocket |
| **P2** | TD-13 | `Level_A_Verified` 无判定标准 | A | 合规红线 | 写判定规则 ADR |
| **P2** | TD-14 | `@matrixos/sdk` 无 API 签名 | A | Q5 全部 | 写 SDK 接口文档 |
| **P2** | TD-15 | 单用户成本口径矛盾（¥1.5 vs ¥1.76） | 文档缺陷 | 商业叙事 | 统一口径 |
| **P2** | TD-16 | "第 9 个月转正"无逐月模型 | 文档缺陷 | 商业叙事 | 补模型或删宣称 |
| **P3** | TD-17 | 视觉层 14 项缺陷（死 token / 无 CJK / 无 a11y 等） | B | 前端质量 | 见 `04-visual-system.md` §10 |
| **P3** | TD-18 | 三处 CDN 强依赖（断网即裸 HTML） | B | 演示可靠性 | 自托管 |
| **P3** | TD-19 | `document.execCommand` 已废弃 | B | 复制功能 | 改 Clipboard API |
| **P3** | TD-20 | 4 张渲染图含伪造文字与版本号错误（v3.8） | 素材缺陷 | 答辩风险 | 标注或重制 |

---

## 八、给 Stage 1 的前置检查清单

开工前必须逐项确认（建议作为 `S1-00` 门禁）：

- [ ] **原型可用性**：4 个原型（ScholarMatrix / 星门 / PAT-HOT / 预职）线上可访问，且完成真实能力盘点（解 §4.1 的未核查项）
- [ ] **42 工具清单**：产出可核对的 42 个工具名称 + 归属微站的映射表（TD-02）
- [ ] **数据模型 ADR**：`DigitalTwinAssetGraph` 的实体/关系/向量 schema 定稿（TD-01 / TD-07）
- [ ] **7 站映射**：补 `microsites.json` 的 `station` 字段，建立 7 站 ↔ 4 组映射（TD-05）
- [ ] **可达矩阵**：18 站 × 5 payload_type 的 `accepts`/`emits` 矩阵（TD-06）
- [ ] **目录树修正**：确认 `journal-compass` 去留，修正 Tab 6 目录树与花名册的错位（TD-08）
- [ ] **SDK 接口定义**：`initSSO` / `onWormholeDrop` / `emitAsset` 的入参出参错误码（TD-14）
- [ ] **团队已读 ADR-000**，且 `bundle/matrix_os_agent_execution_spec.md` 文件头已加"历史参考"标注

---

## 九、一句话总结

> **差距不在"功能少"，而在"地基没打"。** 18 个微站的业务逻辑 0 实现、数据模型 0 张表、虫洞拖拽 0 行拖拽代码——但更棘手的是 **15 项规格缺口（R1–R15）**，这些是"不知道该做什么"而非"做不出来"。Stage 1 应先花 1–2 周补规格，再动工脚手架；否则会在错误的地基上盖 18 层楼。
>
> 好消息是：**架构决策质量高、契约设计有真东西（证据锚点必填的防幻觉机制值得保留）、预算表算术自洽、视觉 token 可提炼**。这不是一个需要推倒重来的方案，是一个**需要先补完规格再开工**的方案。
