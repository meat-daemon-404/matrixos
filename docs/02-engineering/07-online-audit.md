# 线上体检报告（2026-10-20）

> 对已部署的 19 个站点做端到端体检，记录发现的真实缺陷。
> 体检脚本产物在 `.tmp/audit/`（截图）。

---

## 体检方法

用 Playwright（chromium channel）打开线上 URL，采集：

- HTTP 状态、页面标题、正文长度
- 关键 DOM 存在性（仪器容器、旋钮、canvas、svg）
- 计算样式（body 背景色）
- 视口高度 vs 内容高度 vs 可滚动性
- 失败请求（4xx/5xx）与控制台错误

---

## 发现的问题

### P1 · 微站页面下方大量空白

| 站点 | 页面总高 | 有效内容高 | 空白占比 |
| :--- | ---: | ---: | ---: |
| mx-curvelab | 4410 px | ~600 px | **约 86%** |
| mx-gpa | 3840 px | ~500 px | **约 87%** |

**现象**：内容渲染正常（CurveLab 的示波器、三个旋钮、状态栏都在），但页面被撑到 4000+ px，下方全是 `#050814` 空白。

**推测原因**：`globals.css` 里有 `min-height: 100vh` 或类似的容器高度设置，在静态导出 + 特定视口下被叠加放大。

**实测根因（2026-10-20 复核，与推测不同）**：撑高元凶是 `.iu-sr-only`（instrument-ui 的无障碍等价数据表类）与 `<table>` 布局算法的交互，**不是** `min-height: 100vh`：

`.iu-sr-only` 只给了 `width/height: 1px`，而 `<table>` 的 `display` 是 `table` —— **1px 对表格是「最小宽度」而不是上限**。CurveLab 的 180 行数据点把这张不可见的表撑成 **≈196 × 4164 px**；它虽被 `clip` 掉看不见，却照样计入文档的可滚动溢出区，把页面顶到 4410 px。

**修复**（已扇出到 18 站 `globals.css`）：把它压成硬上限并改用 `block`，打断表格布局算法；语义不变，读屏照读。

```css
.iu-sr-only {
  display: block;
  max-width: 1px;
  max-height: 1px;
  overflow: hidden;
}
```

> 说明：`packages/instrument-ui/src/styles/base.css` 里的原始 `.iu-sr-only` 未改动（它有 `clip` + `position:absolute`，对普通元素够用）；各站的覆盖是**宿主页面的必要补充**，因为「无障碍表被表格布局算法撑大」只在宿主文档流里显现。扇出脚本：`scripts/fanout-embedded-fix.mjs`（幂等，锚点定位）。

**影响**：用户打开看到半屏空白，观感差；iframe 内嵌时也会把面板撑得很高。

### P2 · 控制台 404（每站 1 个）

所有微站都有 1 个 404 请求。已定位为 favicon —— 微站没有 `src/app/icon.svg`（当时只有 hub 有）。

**修复**：18 站各补一个 `src/app/icon.svg`（App Router 约定，自动产出 `<link rel="icon">`，不需要 `public/`、不改 `next.config`）。图形按各站 UI 形态定制（推子 / 极坐标盘 / 五柱 / 瀑布 / 透镜 / 雷达 / 对抗栏 / 看板 / 网格 / 瞄准镜 / 示波器 / 检查单 / 曲线坐标 / 章节流 / 声呐 / 天平 / 徽章 / 分岔树），生成器为 `scripts/site-icons.mjs`（与 `scripts/gen-site.mjs` 共用同一事实源）。

**影响**：轻微，但会在审计工具里报错，也说明微站缺站点图标。

> ⚠️ 复检注意：`icon.svg` 是否**真的**消掉了 404，必须在**重新部署之后**按 `resourceType` 单独量 `favicon`/`ico` 类请求的状态码，而不是笼统看「失败请求 = 0」。

### P3 · hub 页面没有仪器容器 / canvas / svg 【判定：误报，已复核】

审计脚本对 `https://mx-orbital.pages.dev` 检测到：

```
仪器容器 ✗ · 旋钮 ✗ · canvas ✗ · svg 0
正文 1062 字符
```

**这是误报**：hub 的 DOM 语汇与微站完全不同 —— 星轨是 canvas 组件、仪器架用 `.instrument-rack`，而旧脚本拿的是微站的选择器（`.instrument` / `[role=slider]`），必然全 ✗。

**复核证据（盒子测量版脚本实测）**：

```
.star-orbit ✓ h=748 · 轨道环 7 · 胶囊 18
```

**结论**：hub 本身正常，是脚本选择器不适配。**已改脚本**（按 hub 自身语汇判定），不再产生此误报。

### P4 · iframe 内 `viewportH` 读到 0 【⚠️ 原判定错误，已推翻】

```
iframe https://mx-gpa.pages.dev/
  背景 rgb(5, 8, 20) · 高 1129.03/0 · 可滚动 true
```

原文判定「读取时机问题，不是产品缺陷」，依据是「正文 465 字符说明内容确实在」。**该依据是假阳性**：

- 跨源 iframe **即使外层盒子高度为 0**，`page.frames()` 仍能读到其内部 DOM，`textLength` 照样 > 0；
- 所以「DOM 里有文字」**不能**证明「视觉上看得见」。

**盒子测量实测（修复前，线上）**：

```
.instrument-rack    h = 81px   ← 只剩工具栏
.rack-grid          h = 44px
.panel-body         h = 0px    ← 根因
iframe.panel-iframe h = 0px    ← 视觉上一片空白
```

**根因**（见 `apps/orbital-hub/src/app/hub-components.css` 注释）：`.instrument-rack` 在纵向 flex 里没有 `flex-grow`，被压到内容高度；`min-height: 0` 又允许它继续压缩；于是 `.rack-grid { flex: 1 }` 的 flex-basis 是 0%、父容器已无高度可分，连同 `.panel-body` 一起被压成 0。

**修复**：`.instrument-rack { flex: 1 1 auto; }` —— basis 用 `auto`，而不是 `flex: 1`（basis `0%`）才会被压到 0。

**结论**：P4 是**真产品缺陷**（点开胶囊后面板不可见），已修。原「不改」判定作废。

### P5 · 微站在 iframe 内可能过高 【判定：真缺陷，与 P4 同批修复】

iframe 内 `document.documentElement.scrollHeight > window.innerHeight` 为 true，说明微站内容**超出 iframe 高度**，会出现内部滚动条。

这与 ADR-08 的约定冲突：**iframe 内不滚，由 hub 控制外层**。

**根因**：嵌入模式下微站仍保留 `min-height: 100vh` / 容器自适应外边距 / 页脚留白，三者任一都会把内容撑出 iframe 可视区。

**修复**（已扇出 18 站 `globals.css`）：

```css
body[data-embedded='true'] { min-height: 0; }
body[data-embedded='true'] .site-root { min-height: 0; }
body[data-embedded='true'] .site-root { margin: 0 auto; }
body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }
```

功能链路已核实**不是死代码**：每站 `src/components/site-shell.tsx` 都有
`document.body.dataset.embedded = isEmbedded ? 'true' : 'false'`（当 `window.parent !== window` 时置 `true`）。

---

## 修复优先级与处置结果

| 优先级 | 问题 | 处理 | 状态 |
| :--- | :--- | :--- | :--- |
| **P0** | P1 微站页面大量空白 | 压制 `.iu-sr-only` 表格（扇出 18 站） | ✅ 已修（待线上复检） |
| **P0** | P5 iframe 内滚动违反 ADR-08 | 微站嵌入模式紧凑布局（扇出 18 站） | ✅ 已修（待线上复检） |
| **P0** | P4 hub 面板高度塌陷为 0 | `.instrument-rack { flex: 1 1 auto }` | ✅ 已修（待线上复检） |
| P1 | P2 favicon 404 | 18 站补 `src/app/icon.svg` | ✅ 已修（待线上复检） |
| — | P3 hub 检测误报 | 改脚本选择器为 hub 自身语汇 | ✅ 已修（脚本侧） |

> ⚠️ 上表「已修」指**源码已改并本地核验**；「待线上复检」指**尚未重新部署并实测量化判据**。
> 本报告 §「发现的问题」里修复前的数字是**旧线上产物**量到的基线，不能当作修复后的证据。
> 修复后的数字以盒子测量版 `scripts/audit-online.mjs` 的 `report.json` 为准。

---

## 方法论教训（比结论更重要）

这一轮体检暴露了**审计脚本自身**的三处方法论缺陷，值得单独记下：

1. **DOM 存在性 ≠ 视觉可见性**。旧脚本对 iframe 只读「正文长度 > 0」，于是把「面板高度 = 0、视觉全空」判成了「内容正常」（P4）。**跨源 iframe 即使外层高 0，内部 DOM 依然可读** —— 这类假阳性只有盒子测量（`getBoundingClientRect`）能戳破。
2. **选择器必须适配被测对象的语汇**。拿微站的选择器（`.instrument`）去判 hub，得到的是「hub 坏了」这种反向结论（P3）。判 hub 要用 `.star-orbit` / canvas / 胶囊数。
3. **「总量高」不等于「内容高」**。P1 的量化判据必须是「有效内容高 / 页面总高」的比值，而不是单看 `scrollHeight` 大不大 —— 否则无法区分「内容多」与「内容少但被撑高」。

后续所有线上体检一律**以盒子测量为准**，DOM 断言只作为辅助。

---

## 复现方式

```bash
node .tmp/audit.mjs
```

（脚本已归档到 `scripts/audit-online.mjs`，见下。）

---

## 附录：完整审计输出

```
【01-curvelab-standalone】https://mx-curvelab.pages.dev
  HTTP 200 · CurveLab 非线性拟合示波器 · MatrixOS
  正文 5082 字符 · 根节点 4 子元素
  仪器容器 ✓ · 旋钮 ✓ · canvas ✓ · svg 3
  背景 rgb(5, 8, 20)
  ✗ 控制台错误 1: Failed to load resource: 404

【02-gpa-standalone】https://mx-gpa.pages.dev
  HTTP 200 · 学分绩点动态配重台 · MatrixOS
  正文 500 字符 · 根节点 4 子元素
  仪器容器 ✓ · 旋钮 ✓ · canvas ✗ · svg 12
  背景 rgb(5, 8, 20)
  ✗ 控制台错误 1: Failed to load resource: 404

【03-hub】https://mx-orbital.pages.dev
  HTTP 200 · MatrixOS · 双态合体总控台
  正文 1062 字符
  胶囊数 18
  iframe https://mx-gpa.pages.dev/
    背景 rgb(5, 8, 20) · 高 1129.03/0 · 可滚动 true
    正文 465 字符
```
