# ADR-000 · 规范权威性裁决：v3 HTML 图谱 > v2 Markdown 旧稿

| 项 | 内容 |
| :--- | :--- |
| **状态** | ✅ 已采纳（Accepted） |
| **裁决人** | Tech Lead |
| **裁决日期** | 2026-10-20 |
| **相关** | 影响 Stage 1 全部任务 |

---

## Context · 背景

`bundle/` 里的两份规范文档存在**根本性冲突**，无法同时作为开发依据。

### 证据对比

对 `bundle/matrix_os_agent_execution_spec.md`（9,588 字节，142 行）做全文关键词扫描，结果如下：

| 关键词 | 出现次数 |
| :--- | ---: |
| `18`（18 微站） | **0** |
| `v3` | **0** |
| `orbital` | **0** |
| `wormhole` / `虫洞` | **0** |
| `Q1` ~ `Q5`（五大锁定决策） | **0** |
| `Turborepo` | **0** |
| `Next.js` | **0** |
| `pgvector` | **0** |
| `MatrixID` | **0** |
| `DigitalTwin` | **0** |
| `群岛` | **0** |
| `插槽` / `manifest` | **0** |
| `星轨` | 1（仅出现在一句比喻中） |

而 `bundle/matrix_os_agent_execution_spec.md` 中确实存在的，是另一套体系：

| 关键词 | 出现次数 |
| :--- | ---: |
| `42`（42 工具单页堆砌） | 3 |
| `core-agent`（中台状态机目录） | 1 |
| `services/`（集中式微服务） | 1 |

### 两套体系的实质差异

| 维度 | v2 旧稿（MD） | v3 图谱（HTML） |
| :--- | :--- | :--- |
| **产品形态** | 42 工具挤在单一应用 | 18 个独立微站，各有子域名 |
| **目录结构** | `services/` + `core-agent/` + `clients/` | `apps/` + `packages/` + `services/`（Turborepo） |
| **调度模型** | 集中式中台状态机（5 步流水线） | 全局 Copilot + 跨站虫洞（去中心化投送） |
| **前端技术** | 未指明（React/Vue3 + Tailwind + Vite） | Next.js 15 + Turborepo |
| **账号体系** | 未提及统一账号 | `MatrixID` 单点通行（OAuth2 + JWT） |
| **数据底座** | 未提及 | `DigitalTwinAssetGraph`（PostgreSQL + pgvector + IndexedDB） |
| **扩展机制** | 无 | `@matrixos/sdk` + `matrix-app.manifest.json` 插槽协议 |
| **视觉体系** | 未描述 | 星轨引力场 + 数字精密仪器双态合体 |

### 版本判定依据

1. **HTML 文档自称 v3.0**：`<title>智轨星云 (MatrixOS v3.0) - 全域群岛微站开发执行规范与核心 UI 视觉图谱</title>`
2. **用户交付物命名**：`MatrixOS_v3_HTML_UI_Bundle.zip`，明确标注 v3
3. **HTML 内含 Q1–Q5 锁定决策**：五项架构决策标注为「已锁定」，是经过苏格拉底式推演后的结论
4. **MD 内含过时信息**：其 §3 模型矩阵写入 "DeepSeek V4.1 Flash / Qwen 3.8"，与 HTML 的 TIER 分级路由（同为这些模型但组织方式不同）措辞同源但结构更旧
5. **MD 的数据库选型缺失**：完全没提向量库，而 v3 的 `DigitalTwinAssetGraph` 强依赖 pgvector

**结论：`matrix_os_agent_execution_spec.md` 是 v2 时代的遗留草稿，被误打包进 v3 Bundle。**

---

## Decision · 裁决

### 唯一权威源

**`bundle/MatrixOS_v3_完整交互规范与UI图谱_高清版.html`** 中的架构定义（Q1–Q5 + Wormhole Schema + Monorepo 结构 + 18 微站花名册）为**唯一权威架构依据**。

### 具体处置

| 对象 | 处置 |
| :--- | :--- |
| HTML 图谱 | ✅ 权威源。所有架构决策以它为准 |
| `matrix_os_agent_execution_spec.md` | ⚠️ **降级为历史参考**。保留在 `bundle/` 供追溯，但不得作为开发依据 |
| `specs/microsites.json` | ✅ 已从 HTML 内嵌 JS 解析，是权威花名册 |
| `specs/contracts/*.schema.json` | ✅ 已按 HTML 的 Wormhole / Manifest 定义落地 |
| `docs/01-plan/*` | ✅ 已按 v3 体系撰写（orbital-hub / twin-schema / matrix-sdk / copilot-router / openalex-pat-worker） |

### 但 v2 旧稿中仍有价值的部分

以下内容 v3 图谱未明确覆盖，**选择性继承**：

1. **五步执行流水线**（Intent Parse → Plan & Route → Specialist Dispatch → Microservice Invocation → Canvas Render & Asset Sync）——可作为 Copilot 内部编排流程参考，但需改造为 v3 的虫洞投送模型
2. **四个垂直专席 Agent**（物理光电、生物医药、计算工程、人文法学）——v3 未提及，可保留为 Copilot 的路由维度
3. **7 站状态枚举**（`study`/`spark`/`pat_hot`/`xingmen`/`workshop`/`cloud_balance`/`pre_job`）——与 v3 完全一致，无冲突
4. **双端不对称协同原则**——两版一致，v3 表述更具体（冷启动 < 800ms）

---

## Consequences · 影响

### 正面

- Stage 1 开工前消除歧义，避免团队按两套目录结构各干各的
- `specs/` 下的契约与花名册已按 v3 落地，与裁决一致，无需返工
- 规划文档（architecture / WBS / ADR）已按 v3 撰写，无需重写

### 负面 / 代价

- v2 旧稿中"42 工具"的解耦清单需要重新映射到 18 微站，不能直接照搬
- 需在 Stage 1 额外投入约 2 pd 做工具→微站的归属映射（已并入 `S1-07e`）
- `bundle/` 中两份文档冲突的状态会持续存在（保留归档价值，不删除）

### 风险

| 风险 | 缓解 |
| :--- | :--- |
| 后续有人误用 v2 旧稿 | 本 ADR + `bundle/README.md` 显式标注「旧稿仅供参考」 |
| v3 图谱本身有未覆盖项（如具体 API 路径） | 由 Stage 1 的 ADR 流程补充决策，不回头找 v2 |

---

## Alternatives · 备选方案

| 方案 | 否决理由 |
| :--- | :--- |
| **以 MD 旧稿为准** | 与用户交付物命名（v3）、HTML 锁定决策（Q1-Q5）、已完成的花名册与契约全部冲突，返工成本极高 |
| **两版折中合并** | 目录结构与调度模型不可调和，折中会产生"四不像"架构，比选错更糟 |
| **暂不裁决，先做原型** | 会导致首批微站按错误结构搭建，后期迁移成本呈指数上升 |
| **重新向产品方确认** | 用户已明确交付 v3 Bundle，且 HTML 自述 v3.0，证据充分，无需再问 |

---

## 执行检查点

Stage 1 启动时逐项确认：

- [ ] 团队全员已读本 ADR
- [ ] `bundle/matrix_os_agent_execution_spec.md` 文件头已加「历史参考」标注
- [ ] `docs/01-plan/01-architecture.md` 的目录结构采用 v3（已确认）
- [ ] 首个微站脚手架按 `apps/micro-sites/` 而非 `services/` 创建
- [ ] `specs/contracts/` 三份 Schema 作为跨站契约基线（已落地并通过校验）

---

## 附录 · 证据复现方式

任何人可复现上述关键词统计：

```powershell
$md = Get-Content "bundle\matrix_os_agent_execution_spec.md" -Raw -Encoding UTF8
foreach ($k in @('18','v3','orbital','wormhole','虫洞','Q1','Turborepo','Next.js','pgvector','MatrixID')) {
  Write-Output ("$k = " + ([regex]::Matches($md, [regex]::Escape($k))).Count)
}
```

预期输出全部为 `0`。
