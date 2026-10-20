# Bundle 分析总览 · MatrixOS v3.0

> 对 `bundle/` 六个交付物的解构结论。分析日期 2026-10-20。详细论证见本目录四份分文档。

---

## 一句话结论

**这是设计阶段交付物，不含可运行的产品代码。** 架构想清楚了，产品没开始做——18 个微站的业务逻辑 **0 实现**，数据库 **0 张表**，核心卖点「虫洞拖拽」**0 行拖拽代码**。

---

## 交付物定性

| 类别 | 数量 | 内容 |
| :--- | ---: | :--- |
| 🟢 真实可交付代码 | **0** | 无应用源码 |
| 🟡 可运行的原型 | 1 | 单文件 HTML 交互沙盘（能点能拖滑块，但零网络零持久化） |
| 🔵 设计概念稿 | 10 | 4 张 AI 渲染图 + 6 幅内联 SVG 线框 |
| ⚪ 纯文案规划 | 1 | Markdown（**v2 旧稿**，非 v3） |

HTML 共 442,654 字符，其中 **313,552 字符（70.8%）是 4 张图片的 base64**；剥离后真实 JS 逻辑仅 **28,162 字符**。

---

## 五条关键结论

**1. 架构质量高，值得直接采纳。** Q1–Q5 五项锁定决策清楚，Wormhole 契约强制 `evidence_anchors`（DOI + PDF 页码 + bbox 坐标）必填——**从契约层杜绝大模型幻觉**，是整个 Bundle 最有价值的单个设计。18 站花名册字段完整、域名唯一。

**2. Bundle 内部两份规范互相冲突（已裁决）。** `matrix_os_agent_execution_spec.md` 是 v2 旧稿，对 `18`/`v3`/`orbital`/`虫洞`/`Q1-Q5`/`Turborepo`/`pgvector`/`MatrixID` 等关键词命中率**全部为 0**，描述的是另一套集中式架构。已裁决 v3 HTML 为唯一权威源（[ADR-000](../01-plan/00-adr-000-spec-authority.md)），旧稿降级历史参考。

**3. 核心交互是演示性质，必须重写而非改造。** Q3 宣称「按住数据卡片拖拽→鼠标周围张开虫洞环→松手投送」，但 `draggable`/`dragstart`/`dragover`/`dataTransfer` 全部 **0 次**；实际实现是"点击按钮→弹窗→点目标→显示成功文案"。CurveLab 的 R² 是装饰公式 `max(0.912, 0.996 - noise×0.0022)`，与拟合曲线**完全无关**；"散点"是确定性正弦而非随机采样。

**4. 最大的空洞是数据模型。** `DigitalTwinAssetGraph` 只有名字——PostgreSQL + pgvector + IndexedDB 一句话，**没有一个实体、一条关系、一张表、一个向量维度定义**。而 18 个微站每个都需要持久化台账（`ledger` 字段只有中文描述名，无字段定义）。这是 Stage 1 的头号阻塞项。

**5. 真正棘手的是「规格缺失」而非「实现难度」。** 已识别 **15 项规格缺口**（R1–R15）：7 站枚举↔4 组 `orbit` 无映射、`model_tier` 4 档→3 档无映射、42 工具清单根本不存在（v2 只写了数字）、综测细则、热度算法、期望收益模型……**这些是"不知道该做什么"，不是"做不出来"**。不补则 Stage 1 无法开工。

---

## 需要决策者拍板的三件事

| # | 事项 | 建议 |
| :-- | :--- | :--- |
| 1 | Tab 6 目录树含 `15-journal-compass`（投稿罗盘），但花名册**无此站**；且目录树把"导师+进组"合并、花名册拆成两站，从 06 起整体错位 | ✅ **已裁决**：以 `specs/microsites.json` 为准，目录树仅借其描述性命名；`journal-compass` 列为 Backlog，若要做走第 19 号 SDK 插槽。见 [ADR-001](../01-plan/00-adr-001-microsite-numbering.md)。**`journal-compass` 去留仍需业务方确认** |
| 2 | 商业数字三处不自洽：单用户成本宣称 `<¥1.5` 但仿真器用 `¥1.76`；"第 9 个月转正"无逐月模型；仿真器固定成本 ¥20,000 与预算表科目对不上 | 答辩前必须统一口径，否则易被追问 |
| 3 | 4 张渲染图含伪造文字（`Hytothesis Lab`/`Caosed`/`Statuss`/`Curvetab`）与版本号错误（`Academic Workspace **v3.8**`）、物理错误（`CPU 122.38 GHz`） | 答辩展示前标注"AI 概念图"，或遮挡重制标头 |
| 4 | 四个原型线上可用性 | ✅ **已核实（Lead 2026-10-20）**：四个地址全部 HTTP 200 可访问。详见 [02-prototype-status.md](../02-engineering/02-prototype-status.md)。**遗留**：预职源码仓库未找到；四站涉及 React/Vue-Vite/Vue-CDN 三种技术栈，解耦不能按统一方案推进 |

---

## 可以放心继承的资产

- **Wormhole 契约**（含证据锚点必填）— 已落地为 `specs/contracts/wormhole-envelope.schema.json`
- **18 站花名册** — `specs/microsites.json`，字段完整可校验
- **7 站生涯闭环** — 逻辑自洽，两版规范一致
- **Q1–Q5 架构决策** — 质量高，不需重议
- **视觉 token 表** — 色/字/圆角/阴影/动效完整，见 [04-visual-system.md](04-visual-system.md)
- **¥20,000 预算表** — 五科目合计与占比**算术完全正确**，劳务 12.5% ≤ 20% 合规

---

## 分文档索引

| 文档 | 内容 |
| :--- | :--- |
| [01-inventory.md](01-inventory.md) | 6 Tab 逐项解构、442K 字符去向、交互能力清单、4 图 AI 生成取证 |
| [02-requirements.md](02-requirements.md) | 7 站闭环、18 站完整花名册、Q1–Q5、双端不对称、模型分级、预算 |
| [03-gap-analysis.md](03-gap-analysis.md) | 规范冲突影响面、四项硬证据、四原型差距、技术债 20 项、Stage 1 前置检查 |
| [04-visual-system.md](04-visual-system.md) | Token 表（含死 token 判定）、WCAG 对比度实测、可直接落地的 `tokens.css` |

**相关**：[ADR-000 规范权威性裁决](../01-plan/00-adr-000-spec-authority.md) · [ADR-001 微站编号裁决](../01-plan/00-adr-001-microsite-numbering.md) · [工程规划](../01-plan/) · [Bundle 归档说明](../../bundle/README.md)
