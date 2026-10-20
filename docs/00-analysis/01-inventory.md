# 交付物清单与真实构成 · Bundle 解构

> **分析对象**：`bundle/`（6 个文件，共 3,411,854 字节）
> **核心结论（先说）**：**这是设计阶段交付物，不含任何可运行的产品代码。** Bundle 提供的是「架构决策 + 视觉规范 + 交互原型」三件套，其中唯一可执行的产物是一个**单文件 HTML 演示沙盘**——它能点、能拖滑块、能切换 Tab，但零网络请求、零持久化、无后端、无业务逻辑。18 个微站的真实业务能力**一个都没有实现**。
> **判据**：`fetch` / `XMLHttpRequest` / `localStorage` / `indexedDB` / `new WebSocket` 全部 **0 次**。

---

## 一、文件总账

| # | 文件 | 字节 | 类型 | 性质 |
| :-- | :--- | ---: | :--- | :--- |
| 1 | `MatrixOS_v3_完整交互规范与UI图谱_高清版.html` | 459,170 | 单页 HTML（含内联 CSS/JS） | 🟡 **可执行的原型**（交互沙盘） |
| 2 | `matrix_os_agent_execution_spec.md` | 9,588 | Markdown | ⚠️ **v2 历史旧稿**（见 §6） |
| 3 | `UI_Renders/UI_01_星轨与精密仪器双态合体总控台.jpg` | 718,284 | JPEG 1376×768 | 🔵 **AI 生成概念图** |
| 4 | `UI_Renders/UI_02_CurveLab荧光示波器与跨站虫洞环.jpg` | 820,121 | JPEG 1376×768 | 🔵 AI 生成概念图 |
| 5 | `UI_Renders/UI_03_星门五维星象仪与预职多重宇宙概率树.jpg` | 700,553 | JPEG 1376×768 | 🔵 AI 生成概念图 |
| 6 | `UI_Renders/UI_04_2.5D无级语义变焦星轨全景图.jpg` | 704,138 | JPEG 1376×768 | 🔵 AI 生成概念图 |

**分类总计**：

| 类别 | 数量 | 说明 |
| :--- | ---: | :--- |
| 🟢 **真实可交付代码** | **0** | 无任何应用源码、无 package.json 中的产品依赖、无构建产物 |
| 🟡 **可运行的工具性产物** | 1 | HTML 原型本身（它"能跑"，但不是产品） |
| 🔵 **设计概念稿** | 4 | 4 张 AI 渲染图 + 6 幅内联 SVG 蓝图 |
| ⚪ **纯文案规划** | 1 | Markdown 旧稿（且版本过时） |

> **重要区分**：仓库里确实存在**可运行的代码**，但它不是 Bundle 的一部分，而是 Lead 在 Bundle 之外建立的工程脚手架（`scripts/validate-specs.mjs`、`scripts/check-doc-links.mjs`、`package.json`）。这些是**校验工具**，不实现任何 MatrixOS 业务功能。Bundle 自身的 6 个文件中，可执行代码为 **0 行应用逻辑**。

---

## 二、HTML 真实构成：442,654 字符去哪了

文件大小 459,170 字节 → UTF-8 解码后 **442,654 字符 / 1,938 行**。

### 2.1 字符分布（这是最重要的一张表）

| 区段 | 行范围 | 字符数 | 占全文件 |
| :--- | :--- | ---: | ---: |
| `<head>` + `tailwind.config` + `<style>` | L1–64 | 2,653 | 0.6% |
| 顶部导航（6 Tab 按钮） | L66–107 | 3,772 | 0.9% |
| **Tab 1 · 核心UI视觉图谱** | L115–576 | **36,508** | 8.2% |
| **Tab 2 · 双态合体交互沙盘** | L581–891 | **23,001** | 5.2% |
| Tab 3 · 18+N微站矩阵全表 | L896–916 | **2,411** | 0.5% |
| Tab 4 · SDK插槽与模型预算 | L921–1115 | **13,095** | 3.0% |
| Tab 5 · 口袋小程序原型 | L1120–1198 | **4,985** | 1.1% |
| Tab 6 · Agent规范与一键复制 | L1203–1353 | **8,688** | 2.0% |
| 两个 Modal + Toast | L1355–1418 | 4,332 | 1.0% |
| 分隔/空行 | — | 1,478 | 0.3% |
| **markup 小计** | **L1–1418** | **100,923** | **22.8%** |
| **内联 JS 小计** | **L1419–1936** | **341,714** | **77.2%** |
| └ 其中：4 张图片 base64 | L1420–1425 | **313,552** | **70.8%** |
| └ 其中：**真实 JS 代码** | — | **28,162** | **6.4%** |

### 2.2 三个反直觉的事实

**事实一：70.8% 的文件体积是图片。**

313,552 个 base64 字符（解码后约 235KB 二进制）全部属于 `UI_IMAGES` 常量（L1420–1425）。这意味着：
- 这个"HTML 规范文档"实际上是一个**图片容器**
- 如果剥离图片，文件从 459KB 降到约 **134KB**
- **真实 JS 逻辑只有 28,162 字符**——约相当于一个中等复杂度 React 组件的量

**事实二：内嵌图片是 4 张渲染图的降采样副本，不是额外素材。**

从 `UI_IMAGES` 解码出的 4 张 JPEG 全部为 **960×540**，而 `UI_Renders/` 里的原图是 **1376×768**。逐张做均值哈希（aHash 8×8）比对，配对关系 100% 明确：

| 内嵌图 key | 尺寸 | 解码字节 | 最佳匹配（aHash 相似度） |
| :--- | :--- | ---: | :--- |
| `render_hybrid` | 960×540 | 56,616 | `UI_01` = **0.969** |
| `render_curvelab` | 960×540 | 70,256 | `UI_02` = **1.000** |
| `render_mentor_career` | 960×540 | 53,840 | `UI_03` = **0.938** |
| `render_constellation` | 960×540 | 54,450 | `UI_04` = **1.000** |

> 所以 `UI_Renders/` 的 4 个 JPG 是**唯一图源**，HTML 内的 base64 是它们的低分辨率副本（用于离线自包含）。**没有第 5、6 张图**。Bundle 实际视觉素材 = 4 张图 + 6 幅内联 SVG。

**事实三：`<img src="">` 初始为空，靠 JS 在 `DOMContentLoaded` 时注入 base64。**

L165/201/237/269 四张卡片图的 `src` 属性都是空字符串，实际渲染依赖 L1926–1930 的注入脚本。**若 JS 被禁用或 CDN 不可达导致脚本未执行，Tab 1 的 4 张图全部空白。**

### 2.3 外部依赖（离线可用性风险）

| 依赖 | URL | 用途 | 失效后果 |
| :--- | :--- | :--- | :--- |
| Tailwind CSS | `https://cdn.tailwindcss.com/3.4.17` | **全部样式** | 🔴 **页面完全失去样式**（全站 class 均为 Tailwind 原子类） |
| Font Awesome | `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css` | 全部图标 | 图标显示为空白/方框 |
| Google Fonts | `fonts.googleapis.com`（Inter + JetBrains Mono） | 字体 | 回退系统字体 |

> 🔴 **这不是"自包含离线文档"**。尽管图片内嵌了，但**样式表完全依赖 CDN**。`bundle/README.md` 与 HTML 内文案（L19 "已内嵌离线高清图源"、L149）暗示离线可用，实际上**断网打开会得到一个无样式的裸 HTML**。Demo 给评审看之前务必验证网络。

---

## 三、6 个 Tab 的逐项解构

### Tab 1 · 核心UI视觉图谱（L115–576，36,508 字符，全文件最大 Tab）

**Part A：4 张 AI 概念渲染图**（L140–289）

每张图配 4 个元素：编号徽章、点击灯箱按钮、图片（`h-64 sm:h-72 object-cover`）、3~4 个要点说明卡。

| 大图 | 标题 | 声称锁定 | 图上徽标域名 | 说明卡要点 |
| :--- | :--- | :--- | :--- | :--- |
| 01 | 「星轨引力场 + 精密科研仪器双态合体总控台」 | Q4 | `matrixos.edu` | 左32%星轨罗盘 / 右68%折射仪器架 / 底部声波脉冲底座 |
| 02 | 「CurveLab 荧光示波器拟合站 + Agent 跨站虫洞环」 | Q1 & Q3 | `curvelab.matrixos.edu` | 硬件级示波器屏 / 阻尼旋钮与拨杆 / 跨站虫洞环投送 |
| 03 | 「星门五维星象仪 & 太空任务看板 + 预职多重宇宙概率树」 | — | `mentor / career.matrixos.edu` | 星门：天文星象雷达 / 预职：生涯多重宇宙 |
| 04 | 「7 轨全息星图与 18+ 实时动态数据胶囊微缩态」 | — | `Semantic Zoom 1.0x → 10.0x` | Live Mini-View / Semantic Zoom |

**Part B：6 幅矢量 UI 拆解图**（L291–576）

全部为**内联 SVG**，统一 `viewBox="0 0 340 165"` + `class="w-full h-40"`（渲染高度锁 160px）。**不是外部图片文件**，是可选中、可缩放的矢量，但元素结构相当简单：

| 图纸 | 目标微站 | 主题 | SVG 元素构成（实测） |
| :--- | :--- | :--- | :--- |
| 01 | `matrix-cross.matrixos.edu` | 跨论文对比矩阵 & 激光证据溯源 | rect 8 / circle 2 / line 5 / path 2 / text 16 |
| 02 | `retract-radar.matrixos.edu` | 撤稿声呐盘 & 学术合规扫描仪 | rect 3 / circle 8 / line 3 / path 1 / text 7 |
| 03 | `yunheng.matrixos.edu` | 云衡 · 数字天平综测核算台 | rect 4 / line 4 / polygon 1 / text 10 |
| 04 | `grant-audit.matrixos.edu` | 大创五科目经费液位压差计 | rect 10 / line 1 / text 11 |
| 05 | —（Pocket 小程序） | 晨间三卡流与桌面投送 | rect 8 / path 1 / polygon 1 / text 13 |
| 06 | —（@matrixos/sdk） | 高校实验室微站开放插槽协议 | rect 5 / circle 6 / path 1 / text 7 |

> **诚实评价**：这 6 幅图**是合格的"线框示意图"，不是"高保真 UI 结构拆解图"**。HTML 标题（L296）称"矢量级高保真 UI 结构拆解图"，但实际每幅只有 7–30 个图形元素、5–16 个 `<text>`，字号 6.8–8.5px（渲染后约 7–8.7px，见 `04-visual-system.md` §3.3）。它们表达了"信息区块的位置关系"，**没有表达组件规范、交互锚点、数据绑定方式**——尽管副标题（L298）声称"精准标注每一个核心微站的组件布局、交互锚点与数据绑定"。
>
> **对 Stage 3 的实际价值**：可作为"页面里有什么区块"的清单，但不能作为组件规格书。`packages/instrument-ui` 需要重新设计组件 API。

**每幅图纸下方还有一段「UI 交互规范」文字**，这是 Tab 1 里信息密度最高、对开发最有用的部分（例如 L356 明确了 `pdf_page + bbox` 坐标绑定、L130 明确了劳务费 ≤20% 硬件限位阀）。

### Tab 2 · 双态合体交互沙盘（L581–891，23,001 字符）

**这是整个 Bundle 里唯一"活着"的部分**，也是唯一能验证设计意图的东西。

**结构**：伪装成浏览器窗口的容器（`min-height: 680px`），含
- 顶栏：三色圆点 + 地址栏 `https://orbital.matrixos.edu/studio?mode=hybrid-split` + MatrixID 标识 + "本地 IndexedDB 隐私仓已加密"
- 左栏 32%（实为 `col-span-4`=33.33%）：**1 幅 320×320 交互式 SVG 星轨图**，7 个可点 `<g onclick>` 胶囊
- 右栏 68%：**3 台仪器面板**
  - `INSTRUMENT #08 · curvelab.matrixos.edu` — 唯一真实的 Canvas 图表 + 3 个滑块
  - `INSTRUMENT #05 · matrix-cross` — 3 行 HTML `<table>`，每行可点触发"激光溯源"
  - `INSTRUMENT #04 · mentor.matrixos.edu` — 三阶段看板 + "预览套磁信"按钮
- 底栏：Global Copilot 声波坞（含输入框 + 发送按钮）

**7 个星轨胶囊**（L648–688）：`all`(Core) / `pathot` / `curvelab` / `xingmen` / `retract` / `career` / `gpa`

> ⚠️ **7 个胶囊 ≠ 7 条轨道**。胶囊命名混用了微站名（`pathot`、`curvelab`、`retract`）、轨道名（`xingmen`、`career`、`gpa`）和根节点（`all`）。其中 `career` **不对应任何 18 站里的域名**（花名册里是 `career` 出现在 UI_03 图内徽标与虫洞投送目标文案里，但花名册的预职站是 `prejob.matrixos.edu` 与 `evidence-cv.matrixos.edu`）。这是一个**命名漂移**：`career.matrixos.edu` 在 HTML 中出现 2 次（L240、L1399），但不是花名册成员。见 `03-gap-analysis.md` §6.1。

### Tab 3 · 18+N微站矩阵全表（L896–916，**仅 2,411 字符，全文件最小 Tab**）

这个 Tab 的 HTML **只有 21 行、2.4KB**——因为它全是容器，内容由 JS 动态渲染：

```html
<div id="orbitFilterGroup">  <!-- 5 个筛选按钮 -->
<div id="microSitesGrid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2"></div>
```

**5 个筛选按钮**：`all`（全部 18 旗舰站）、`1-2`（3 站）、`3-4`（5 站）、`5`（7 站）、`6-7`（3 站）。

> 计数正确：3+5+7+3 = 18 ✓。但**按钮只有 4 组 + all，无法按 7 站逐站筛选**（见 `02-requirements.md` §2 的粒度问题）。

卡片由 `renderMicroSitesDirectory()`（L1681–1716）用模板字符串生成，每张卡包含：`#id · orbitName`、`domain`、`name`、`desc`、`uiStyle`、`ledger`、`source`、`[↗ 进入独立微站]` 按钮。

> **这就是"18 微站矩阵全表"的全部实现**——一个 `Array.map()` 渲染卡片网格。没有任何业务逻辑。

### Tab 4 · SDK插槽与模型预算（L921–1115，13,095 字符）

三个独立 Section：

**Section A · SDK 插槽模拟器**（L922–979）
4 个表单输入（名称/域名/轨道下拉/接收类型）+ 1 个"校验 Manifest 并热插拔挂载"按钮 + 右侧状态输出区。
`mountCustomLabApp()`（L1728–1757）做了**真事**：读取 4 个输入 → `MICRO_SITES.push({...})` → 更新挂载计数徽章 → 渲染输出 HTML → 重渲染 Tab 3 卡片网格 → Toast。

> ✅ **这算是一段真实的（前端内存态）业务逻辑**：新的"第 19 号微站"确实会被加进内存数组并在 Tab 3 出现。但**刷新页面即丢失**（无 localStorage），且**没有任何 Manifest Schema 校验**——按钮文案说"校验 Manifest"，实际代码只是 `value.trim() || 默认值`，没有一处 JSON Schema 校验、没有 `pattern` 匹配、没有 `enum` 检查。

**Section B · 2026 四级模型路由**（L981–1012）
4 张纯静态卡片（TIER 01–04），无交互。含 2 个外链：`api-docs.deepseek.com`、`help.aliyun.com/zh/model-studio/`。

**Section C · ¥20,000 预算表 + 造血仿真器**（L1014–1114）
- 左：5 行 HTML `<table>`，数据自洽（见 `02-requirements.md` §7）
- 右：3 个 `<input type="range">` + 3 个输出数字
- `runFinanceSim()`（L1759–1781）**确实实时计算**并格式化输出，是本 Bundle 第二段真实逻辑

### Tab 5 · 口袋小程序原型（L1120–1198，4,985 字符）

左侧 3 条文案卡（晨报 / 进组提醒 / 学术名片），右侧 **1 个纯 CSS 手机构造**（`w-[350px] h-[690px] rounded-[46px]`，含刘海、状态栏、四 Tab 底栏 + 内容区）。

内容区由 `switchPocketView()`（L1784–1877）用模板字符串渲染 4 种视图。**没有任何真实的小程序代码**（无 WXML/WXSS/TS），**没有微信开发者工具工程**，纯 HTML 模拟。

> 值得肯定的是：这是全 Bundle 里**唯一体现"双端不对称"铁律的实物**——手机上只有 4 个卡片列表，没有强行塞拟合台。

### Tab 6 · Agent规范与一键复制（L1203–1353，8,688 字符）

- 1 个"一键复制全量规范"按钮
- 4 个"复制 Stage 1~4 指令"按钮
- 1 个 `<pre id="masterSpecPre">`：**4,642 字符的 Markdown 全文**，即 v3 蓝图的核心部分（五大公理 + Wormhole Schema + Monorepo 目录树）

`STAGE_PROMPTS` 常量（L1908–1913）里 4 段提示词，长度分别为 **182 / 175 / 145 / 123 字符**。

> ⚠️ **这 4 段"可直接投喂给 Cursor / Claude Code / Devin"的 Prompt 极短**（最长 182 字符 ≈ 一句话）。对比 `docs/01-plan/03-work-breakdown.md` 的实际任务粒度，这 4 段提示词不构成可执行的开发指令。它们的实际价值是"一句话说明 Stage 目标"。

**复制机制的实现**（L1887–1917）：`fallbackCopyText()` 用 `document.execCommand("copy")` + 隐藏 textarea。
> 注意：全库 `navigator.clipboard` **0 次**、`clipboard.writeText` **0 次**。`document.execCommand` 是**已废弃 API**，在部分浏览器/非安全上下文下会失败（代码里有 try/catch 降级为"请按 Ctrl+C"）。现代实现应改用 Clipboard API + 降级。

---

## 四、交互能力清单（Tab 2 沙盘 + 全站）

### 4.1 事件绑定总表

静态 markup（L1–1418）中：**18 个不同 handler / 61 处 `onclick`**。

| Handler | 次数 | 功能 | 真实度 |
| :--- | ---: | :--- | :--- |
| `mountScenario` | 11 | 切换右侧仪器挂载组合（改 2 处文案 + Toast） | 🟡 纯文案 |
| `switchMainTab` | 8 | 6 Tab 显隐切换 | 🟢 真实可用 |
| `openUiLightbox` | 8 | 打开大图灯箱 | 🟢 真实可用 |
| `filterMicroSites` | 5 | 按轨道筛选微站卡片 | 🟢 真实可用 |
| `switchPocketView` | 4 | 切换小程序 4 个视图 | 🟢 真实可用 |
| `copyStagePrompt` | 4 | 复制 Stage 提示词 | 🟡 依赖废弃 API |
| `enterSingleMicroSite` | 3 | 切到"独立专精态" + 改地址栏 | 🟡 仅改 DOM |
| `inspectEvidence` | 3 | "激光溯源"显示预设原文 | 🟡 硬编码文本 |
| `executeWormholeTeleport` | 3 | "虫洞投送"显示成功横幅 | 🟡 纯文案 |
| `summonWormholeModal` | 2 | 打开虫洞弹窗 | 🟢 真实可用 |
| `closeUiLightbox` | 2 | 关灯箱 | 🟢 真实可用 |
| `closeWormholeModal` | 2 | 关虫洞弹窗 | 🟢 真实可用 |
| `toggleStandaloneMode` | 1 | 双态 ↔ 专精态布局切换 | 🟢 真实可用 |
| `exportChartCode` | 1 | "生成 Nature 级绘图脚本" | 🔴 **纯 Toast，无任何生成** |
| `previewColdEmail` | 1 | 显示预设套磁信草稿 | 🟡 硬编码文本 |
| `executeGlobalCopilot` | 1 | 显示"已执行指令" | 🔴 **纯文案回显，无 AI 调用** |
| `mountCustomLabApp` | 1 | 挂载自定义微站 | 🟢 真实（内存态） |
| `copyMasterSpec` | 1 | 复制全量规范 | 🟡 依赖废弃 API |

**表单控件**：`<input>` 10 个（6 个 `range` + 4 个 `text`）、`<select>` 1 个、`<canvas>` 1 个、`<table>` 2 个、`<svg>` 7 个、`<button>` 45 个、`<img>` 5 个。

**JS 侧**：24 个函数定义，引用 44 个 DOM id，**0 个 id 引用缺失**（代码卫生良好）。7 个 id 定义了但 JS 未引用（`coreGlow`、`lbBadge`、`pBtn-*` 四个、`studioSplitGrid`）。

### 4.2 唯一真实的图表：CurveLab Canvas

`drawCurveLab()`（L1494–1575）是全 Bundle **唯一一处真实的数据可视化代码**，约 80 行：

| 能力 | 实现 |
| :--- | :--- |
| 双指数衰减曲线 | `y(t) = 0.55·e^(-t/τ₁) + 0.45·e^(-t/τ₂)`，t ∈ [0, 200] ns |
| 参量调节 | τ₁ 滑块 5–40（默认 14.2）、τ₂ 滑块 45–160（默认 89.5） |
| 置信带 | 用 `±noiseLvl × 1.1` 像素偏移画上下包络后填充 `rgba(6,182,212,0.14)` |
| 散点 | 22 个点，偏移量 `Math.sin(i×2.7 + τ₁) × noiseLvl × 1.2` |
| 网格 / 坐标轴 / 轴标签 | 手绘 |
| R² 读数 | `max(0.912, 0.996 - noiseLvl × 0.0022)` |

> 🔴 **这是全 Bundle 最严重的"看起来真、实际假"的一处**（详见 `03-gap-analysis.md` §3.3）：
> 1. **R² 不是算出来的**，是一条凭噪声档位线性插值的装饰公式。真正的 R² 需要对实际散点做残差平方和计算。当前即使把 τ₁/τ₂ 拖到与散点完全不匹配，R² 仍然显示 0.99。
> 2. **"散点"是确定性正弦，不是随机采样**：`Math.sin(i×2.7 + τ₁)` 意味着任何一次刷新、任何用户，看到的"实验数据"完全相同。
> 3. **置信带不是置信区间**，只是恒定像素偏移。
>
> 对产品的威胁：这个微站（`11-curvelab.matrixos.edu`）的卖点是"实时显示置信带与 R²"，而演示里这两项都是假的。若答辩现场有人拖动滑块观察 R² 变化规律，会发现它是严格线性的。

### 4.3 完全缺失的交互（承诺 vs 实现）

| 承诺（文案出处） | 实现状态 | 证据 |
| :--- | :--- | :--- |
| **Q3 虫洞拖拽**："按住数据卡片拖拽，鼠标周围即刻张开全息虫洞环，松手投送"（L374） | 🔴 **完全未实现** | `draggable`=0、`dragstart`=0、`dragover`=0、`dragend`=0、`dragenter`=0、`dataTransfer`=0、`pointerdown`=0、`mousedown`=0、`touchstart`=0。仅有 `drop` 字符串 5 次（均为「虫洞」中文文案或注释）。`WormholeDropRing` 仅作为**文案**出现 2 次。实际实现是**点击按钮 → 弹窗 → 点目标 → 显示成功横幅** |
| **Semantic Zoom**："视距从 1.0x 平滑推进至 10.0x"（L59, L283） | 🔴 未实现 | 0 处 `wheel` 事件监听、0 处 `requestAnimationFrame` |
| **Live Mini-View**：胶囊上显示实时数据（L57, L278） | 🔴 未实现 | SVG 内 7 个胶囊的数值是**硬编码字面量**（`🔥 98.4 · 14篇`、`R²=0.987 激活`、`张教授 94.2%`…） |
| **WebSocket 跨端同步**（L501, L1884） | 🔴 未实现 | `new WebSocket` = 0 |
| **IndexedDB 隐私仓**（L614, L1269） | 🔴 未实现 | `indexedDB` = 0 |
| **全局 Copilot 真实调度**（L1652–1662） | 🔴 未实现 | 只把输入字符串回显到状态行 |
| **"生成 Nature 级 LaTeX/Python 绘图脚本"**（L772, L1642） | 🔴 未实现 | 只有一句 Toast |
| **Manifest Schema 校验**（L962） | 🔴 未实现 | 无 JSON Schema 校验代码 |

---

## 五、4 张渲染图：确认为 AI 生成

### 5.1 技术取证

| 检查项 | 结果 |
| :--- | :--- |
| EXIF 元数据 | **无**（四张均只含 JFIF 基本头，无 `Make`/`Model`/`Software`/`DateTime`） |
| 量化表 | 全部为 `[1,1]`（最高质量），说明经二次转码而非相机/截图原始输出 |
| 尺寸 | 4 张统一 1376×768，宽高比 1.792（= **16:9**） |
| 亮度分布 | 均值 27.5–42.4，p05≈8–11，p95≈82–136（典型深色 UI 概念图） |

### 5.2 视觉取证：伪造文字（决定性证据）

逐张放大阅读，四张图均含**大量不可读的伪文字**，这是扩散模型生成文字失败的典型特征：

**UI_01（双态合体总控台）**
- 星轨节点标签：`Hytothesis Lab`（应为 Hypothesis）、`Enformatics`、`Ceiton Mareme`、`Gatton Mareme`、`Biointormatics`、`Enformatics`、`Kadsmar`
- 顶部副标题：小字号乱码段落
- 右上角写 **`Academic Workspace v3.8`** —— 与 v3.0 版本号不符
- 面板内小字：`NATURE (RET) (TIE)`、`ERROR LIEF SET TIES TIFO` 等

**UI_02（CurveLab + 虫洞环）**
- 表格列头：`Knlt`（Knlt?）、`Gos.`、`Dre.`、`Mon`、`Lak` —— 应为有意义列名
- 表格状态列：`Statuss`（拼写错误）、`Caosed`（应为 Closed）、`Statuss`
- 左侧旋钮标签：`Meter`、`VU`、`Anartal`、`Lam node`
- 滑块区：`Slider 1`~`Slider 4` 重复、`Mitt-VU`
- 底部：`Unasng`、`ODF`、`w-300`
- 虫洞环上的标签 `Matrix-Cross`、`Xingmen Mentor`、`Pre-Job CV` 是**正确的**（少数成功生成的部分）

**UI_03（星门 + 预职）**
- 星门卡片副标题：`Xingmen 导师星象雷达与太空舱进组台账`（部分正确）
- 雷达图轴标签：`已读概率`、`四阶段`、`论文质量`、`进组意愿`、`面试表现`（基本正确）
- 但小数标注混乱：`94.2%` 重复出现、`93.1%`、`94.7%`
- 预职侧：`直博 45%`、`保研 35%`、`名企研发 20%` 正确；下方 `预职概率` 标签重复
- 右侧徽章：`DOI 认证`、`GitHub 贡献` 正确，但小字描述为乱码

**UI_04（2.5D 星轨）**
- 左上 `System Telemetry` 面板：`CPU 122.38 GHz`（物理上不可能）、`Memory 1.9 GB`、`Upload 0.38 GB`、`Database 1.38 GB`、`Progress 3.38 GB`
- 中央输入框：`How can I help you, scholar?`（正确英文，但与本产品全中文 UI 不符）
- 胶囊标签：`PAT-HUB`、`Patnwb`、`CurveLab`、`Pre-Job`、`Xingmen 94.2%`
- 右下 `Academic Feeds`：`Racishou`（乱码）、`Curvetab`（应为 CurveLab）、`Xangmeu`（应为 Xingmen）
- 左下 `Recent Files`：`Podtuk`、`Comalie`、`Cunve.sod`（应为 Curve.so?）、`Kadsmice`、`Matelascot`

### 5.3 对项目的实际影响

| 影响 | 说明 |
| :--- | :--- |
| ✅ **可以做的事** | 传达视觉方向（深色、星轨、仪器感）、色彩氛围、布局意图；给评审看"我们想做成什么样" |
| ❌ **不能做的事** | 作为像素级还原目标；作为取色依据（主色与代码 token 不一致，见 `04-visual-system.md` §1）；作为组件规格；直接切图使用 |
| ⚠️ **答辩风险** | UI_01 头部写 `Academic Workspace v3.8`、UI_04 写 `CPU 122.38 GHz`、多处拼写错误（`Caosed`/`Statuss`/`Curvetab`）。**若在答辩中全屏放大展示，评委可能注意到**。建议使用前统一遮挡/重制标头，或明确标注"AI 概念图，非最终界面" |

---

## 六、`matrix_os_agent_execution_spec.md` 的真实身份

**已裁决：这是 v2 时代遗留草稿，不是 v3 规范。**（权威裁决见 [`ADR-000`](../01-plan/00-adr-000-spec-authority.md)）

| 检验项 | 结果 |
| :--- | :--- |
| 文件大小 | 9,588 字节 / 142 行 / 5,842 字符（含换行） |
| 自称版本 | "智轨星云 (MatrixOS) - 面向工程 Agent 的系统级全域开发与执行规范"，**未标注版本号** |
| 对 v3 关键词的覆盖 | `18`=0、`v3`=0、`orbital`=0、`wormhole`/`虫洞`=0、`Q1`–`Q5`=0、`Turborepo`=0、`Next.js`=0、`pgvector`=0、`MatrixID`=0、`DigitalTwin`=0、`群岛`=0、`微站`=0、`插槽`=0、`manifest`=0 |
| 实际描述的是 | `42`=3 次、`services/` + `core-agent/` + `clients/` 的**集中式微服务架构**，含 5 步流水线状态机 |
| 协议定义 | 有 `MatrixOS_Dispatch_Contract`（已落地为 `specs/contracts/dispatch-contract.schema.json`，但与 v3 的 Wormhole 契约**不同层**） |

**技术影响面详见 [`03-gap-analysis.md`](03-gap-analysis.md) §2。** 选择性继承的 4 条内容见 ADR-000 的 Decision 段。

---

## 七、可交付物成熟度评级

| 维度 | 评级 | 依据 |
| :--- | :---: | :--- |
| **架构决策完整性** | 🟢 高 | Q1–Q5 五项锁定决策 + Wormhole Schema + Monorepo 结构 + Manifest 协议，全部有明确文本 |
| **信息架构清晰度** | 🟢 高 | 18 站花名册字段完整、域名唯一、来源可溯；7 站闭环逻辑自洽 |
| **视觉方向确定性** | 🟢 高 | 有完整 token 表（含色/字/圆角/阴影/动效）+ 4 张概念图 + 6 幅线框 |
| **交互原型保真度** | 🟡 中 | Tab 2 沙盘可操作、Tab 4/5 有真实渲染逻辑；但核心卖点（虫洞拖拽/语义变焦/Live Mini-View）全部缺失 |
| **业务逻辑实现度** | 🔴 **极低** | 18 站业务能力 **0 实现**；唯一"真实计算"是 3 个滑块的财务四则运算与 1 个装饰性曲线 |
| **后端 / 数据层** | 🔴 **无** | 无 API、无数据库 schema、无 ER 图、无数据模型。仅有一份 JSON Schema 契约（消息格式，非存储模型） |
| **可运行产品代码** | 🔴 **0** | 无应用源码。HTML 是演示壳 |
| **可直接接手程度** | 🟡 中 | 架构清楚，可以从 Stage 1 脚手架开始；但需先补 R1–R10 十项规格缺口（见 `02-requirements.md` §9） |

---

## 八、给决策者的三句话

1. **架构想清楚了，产品没开始做。** Q1–Q5 的决策质量相当高（特别是"证据锚点必填"这个防幻觉设计），值得直接采纳；但从「42 工具单页」到「18 独立微站 + 共享鉴权 + 跨站投送」的工程量，Bundle 里**一点都没动**。

2. **唯一能跑的东西证明了设计的可看性，也暴露了它的空心。** Tab 2 沙盘摆在答辩现场很好看——但它的核心卖点虫洞拖拽是点击弹窗、它的 R² 是假公式、它的"WebSocket 同步"是一句 Toast 文案。这些不是"没做完"，是**当前实现路径本身就是演示性质的**，不能顺着改，必须重做。

3. **最大的风险不是技术，是"看起来快完成了"的错觉。** 18 个域名、18 条台账、5 个 TIER、20,000 预算——文档层面的完整度会让人低估工作量。真实起点是：**0 个可运行微站，0 行业务代码，0 张数据库表。**
