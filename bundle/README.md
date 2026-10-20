# bundle/ · 原始设计交付物归档

> ⚠️ **本目录为只读归档，请勿修改。**
>
> 这里的文件是产品方交付的**设计输入**，不是可运行的产品代码。CI 会检查本目录未被改动。

---

## 目录内容

| 文件 | 大小 | 性质 | 权威性 |
| :--- | ---: | :--- | :--- |
| `MatrixOS_v3_完整交互规范与UI图谱_高清版.html` | 459 KB | 设计图谱（单页应用） | ✅ **v3 唯一权威架构源** |
| `matrix_os_agent_execution_spec.md` | 9.6 KB | 系统执行规范 | ⚠️ **v2 时代旧稿，仅供参考** |
| `UI_Renders/UI_01_星轨与精密仪器双态合体总控台.jpg` | 718 KB | AI 生成概念渲染图 | 视觉参考 |
| `UI_Renders/UI_02_CurveLab荧光示波器与跨站虫洞环.jpg` | 820 KB | AI 生成概念渲染图 | 视觉参考 |
| `UI_Renders/UI_03_星门五维星象仪与预职多重宇宙概率树.jpg` | 700 KB | AI 生成概念渲染图 | 视觉参考 |
| `UI_Renders/UI_04_2.5D无级语义变焦星轨全景图.jpg` | 704 KB | AI 生成概念渲染图 | 视觉参考 |

---

## 🔴 重要：两份规范互相冲突

**`matrix_os_agent_execution_spec.md` 是 v2 遗留草稿，与 v3 图谱架构不兼容。**

关键词扫描证据（详见 [`docs/01-plan/00-adr-000-spec-authority.md`](../docs/01-plan/00-adr-000-spec-authority.md)）：该 MD 文件中 `18` / `v3` / `orbital` / `wormhole` / `Q1-Q5` / `Turborepo` / `Next.js` / `pgvector` / `MatrixID` 出现次数**全部为 0**。

| 维度 | MD 旧稿（v2） | HTML 图谱（v3）✅ |
| :--- | :--- | :--- |
| 产品形态 | 42 工具单页堆砌 | 18 独立微站 |
| 目录结构 | `services/` + `core-agent/` | `apps/` + `packages/` + `services/` |
| 调度模型 | 集中式中台状态机 | 全局 Copilot + 跨站虫洞 |
| 账号 | 未提及 | `MatrixID` 单点通行 |

**裁决：以 HTML 图谱为准。** MD 文件保留仅作历史追溯。

---

## HTML 图谱的真实构成

| 项 | 数值 |
| :--- | :--- |
| 总字符数 | 442,654 |
| 总行数 | 1,938 |
| markup 段（L1–1418） | 100,923 字符 |
| 内联 JS 段（L1419–1936） | 341,714 字符 |
| 其中 base64 图片数据 | **313,552 字符（占全文件 70.8%）** |
| JS 去掉 base64 后的真实逻辑 | 28,162 字符 |

**6 个 Tab**

1. 核心 UI 视觉图谱（4 张渲染图 + 6 幅 SVG 蓝图）
2. 双态合体交互沙盘
3. 18+N 微站矩阵全表
4. SDK 插槽与模型预算
5. 口袋小程序原型
6. Agent 规范与一键复制中心

---

## ⚠️ 关于「可交互」的诚实说明

HTML 图谱看起来能交互（点击胶囊切换、拖动曲线滑块、触发虫洞环弹窗），但它是一个**设计演示页**，不是产品原型：

| 检查项 | 实际情况 |
| :--- | :--- |
| 网络请求（`fetch` / `XHR`） | **0 处** |
| 本地持久化（`localStorage` / `indexedDB`） | **0 处** |
| 真实拖拽（`draggable` / `dragstart` / `dataTransfer`） | **0 处** |
| Q3 核心交互「拖拽即张开虫洞环」 | **未实现**，仅有点击弹窗 + 文案 |
| CurveLab 的 R² 值 | 装饰性公式 `max(0.912, 0.996 - noise*0.0022)`，非真实拟合计算 |

**结论：这是设计交付物，产品代码从 Stage 1 开始写。**

---

## 4 张渲染图的真实性

- 均为 1376×768 JPG，**AI 生成**
- 无 EXIF / Software 字段
- 含明显伪造文字：`Hytothesis Lab`、`Enformatics`、`Ceiton Mareme`、`Caosed`、`Knlt`、`Academic Workspace v3.8`

**用途**：作为视觉方向参考（配色、质感、信息密度），**不可**当作像素级还原目标。

HTML 内嵌的 4 张 base64 图是这 4 张图的 960×540 降采样副本（aHash 相似度 0.938~1.000），非额外素材。

---

## 如何使用本目录

| 目的 | 做法 |
| :--- | :--- |
| 查架构决策 | 读 HTML 的 Q1–Q5 段落，或看 [`docs/01-plan/00-adr-000-spec-authority.md`](../docs/01-plan/00-adr-000-spec-authority.md) |
| 查微站花名册 | 直接读 [`specs/microsites.json`](../specs/microsites.json)（已解析好） |
| 查视觉 token | 读 [`docs/00-analysis/04-visual-system.md`](../docs/00-analysis/04-visual-system.md) |
| 查纯文本内容 | 读 [`docs/source-spec-plaintext.txt`](../docs/source-spec-plaintext.txt)（注意：只覆盖 Tab 1/2，Tab 3 的微站表是 JS 渲染的，抽不到） |
| 看视觉方向 | 打开 `UI_Renders/` 里的图 |

---

## 更新流程

若产品方提供新版本 Bundle：

1. 联系 Lead，**不要**直接覆盖本目录
2. Lead 会在新分支重新导入完整 Bundle 并保留旧版对比
3. 更新本 README 与 ADR-000
4. 走 PR 评审
