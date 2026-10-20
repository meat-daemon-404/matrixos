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

**修复后的盒子链实测**（本地 `out/` 产物 + 本地静态服务器，点开胶囊后量）：

| 元素 | 修复前（线上基线） | 修复后（本地产物） |
| :--- | ---: | ---: |
| `.instrument-rack` | 81 px | **706 px** |
| `.rack-grid` | 44 px | **669 px** |
| `.panel-body` | **0 px** | **626 px** |
| `iframe.panel-iframe` | **0 px** | **626 px** |

面板从「视觉一片空白」变为 626 px 真实可见高度；同屏星轨（`.star-orbit` h=748、胶囊 18）与面板内容均正常渲染。

> 📌 **面板高度随视口变化**（做后续任何「内容是否装得下」的判断时必须注意，否则会低估真机能力）：

| 视口 | `.instrument-rack`（可分配） | `.panel-body`（实际给 iframe） |
| :--- | ---: | ---: |
| **1920×1080** | 887 px | **807 px** |
| 1600×900 | 707 px | 627 px |
| 1440×900 | 707 px | 627 px |

> 固定开销恒 **80 px**（`.rack-toolbar` 25 + `.panel-head` 42 + 间距 13），是功能区、不可回收。
> 本文档多数测量以 900 px 视口为基准，故记作 626/627 px；**1080p 下多出 180 px 可用空间**。

> 复现脚本：`.tmp/verify-hub-p4.mjs`（起本地 hub 静态服务 → 点胶囊 → 量盒子链）。
> ⚠️ 用 `127.0.0.1:3000` 端口，否则微站的 `frame-ancestors` 白名单会拦掉 iframe（会看到破损文档图标，那不是产品缺陷）。

**结论**：P4 是**真产品缺陷**（点开胶囊后面板不可见），已修并本地实证。原「不改」判定作废。

### P5 · 微站在 iframe 内过高 【判定：真缺陷，与 P4 同批修复；但原判据口径需更正】

iframe 内 `document.documentElement.scrollHeight > window.innerHeight` 为 true，说明微站内容**超出 iframe 可视高度**。

这与 ADR-08 的约定冲突：**iframe 内不滚，由 hub 控制外层**。

**根因**：嵌入模式下微站仍保留 `min-height: 100vh` / 容器自适应外边距 / 页脚留白 —— 这些是「微站替自己预留视口/留白」的行为，与「高度完全交给 hub」的约定相悖。

**修复**（已扇出 18 站 `globals.css`）：

```css
body[data-embedded='true'] { min-height: 0; }
body[data-embedded='true'] .site-root { min-height: 0; }
body[data-embedded='true'] .site-root { margin: 0 auto; }
body[data-embedded='true'] .site-footer { margin-top: 8px; padding: 8px 0; }
```

功能链路已核实**不是死代码**：每站 `src/components/site-shell.tsx` 都有
`document.body.dataset.embedded = isEmbedded ? 'true' : 'false'`（当 `window.parent !== window` 时置 `true`）。

#### ⚠️ 判据更正（两次）：不能用「scrollHeight > 视口高」判违反，但也**不能说 overflow:hidden 就合规**

这是本轮最容易误判的一条，前后更正了两次，两次都记录下来。

**第一次更正**（Lead 提出）：不能用「iframe 内 `scrollHeight > 视口高`」直接判 ADR-08 违反 —— 因为「内容比面板高」本身不是缺陷。

**第二次更正**（auditor 实测推翻 Lead）：Lead 进一步断言「hub 的 `.panel-body { overflow: hidden }` 会裁掉超出部分，所以 **iframe 内部不出现滚动条**」——**这条不成立**。

Lead 的独立复核（三种方法，与 auditor 各自独立测得同样结果）：

| 方法 | 实测 |
| :--- | :--- |
| 真实鼠标滚轮 ×5（指针移到面板中心） | iframe 内 `scrollTop` **0 → 499**；hub 外层 `window.scrollY` 保持 **0** |
| 程序化 `scrollTop=99999` 后跨两帧复读 | 稳定在 **499**（排除"读到同帧旧值"的时序假象） |
| iframe 内计算样式 | `<html>` 与 `<body>` 的 `overflow` 均为 **`visible`** |

**机制**：`.panel-body { overflow: hidden }` 只裁**父页面中 iframe 元素**超出部分；跨源 iframe 是**独立浏览上下文**，有自己的滚动容器 —— 父页面的 `overflow` 管不到子文档**内部**的滚动。两件事被混为一谈过。

**受控实验**（同一站只改 iframe 高度，说明内容固有高）：

| iframe 高 | scrollHeight | 溢出 | body min-height |
| ---: | ---: | ---: | :--- |
| 400 | 1125 | 725 | `0px` |
| 626 | 1125 | 499 | `0px` |
| 900 | 1125 | 225 | `0px` |
| **1400** | **1400** | **0** | `0px` |

该站**内容固有高 = 1125px**；iframe 高于 1125 时零溢出，且 `scrollHeight` 精确跟随视口 → 说明嵌入模式的紧凑布局**真实生效**（`min-height` 已归 0）。

**因此，ADR-08 的准确状态是**：

| 判据 | 结果 |
| :--- | :--- |
| ① 微站侧：`body`/`.site-root` 的 `min-height` 归 0（不替自己预留视口） | ✅ 成立（实测 `0px` / `0px`） |
| ② hub 侧：`.panel-body` 的 `overflow: hidden`（外层裁切） | ✅ 成立 |
| ③ **iframe 内部不出现滚动条** | ❌ **仍违反** —— 实测用户可在面板内滚动 499px |

即 **P5 的修复只完成了一半**：微站不再「替自己预留视口高」，但**仍然可滚**。要真正满足 ADR-08 的字面约定「iframe 内不滚」，**还需微站侧**在嵌入模式下让文档不可滚 —— 例如 `body[data-embedded='true'] { overflow: hidden; }`，或改为 `height: 100%` + 内部滚动容器。

> 这条**未修**，作为待办记录在 §「遗留待办」。
> 感谢 auditor 的坚持与三种独立证法 —— 若只信 Lead 的机制推演，这条会被误判为「已合规」。

---

## 修复优先级与处置结果

| 优先级 | 问题 | 处理 | 状态 |
| :--- | :--- | :--- | :--- |
| **P0** | P1 微站页面大量空白 | 压制 `.iu-sr-only` 表格（扇出 18 站） | ✅ **已修 + 线上实证**（curvelab 4410→900 px；sr-only 表 4164→1 px） |
| **P0** | P5 微站替自己预留视口高 / iframe 内可滚 | 紧凑布局 + `html`/`body` 双层 `overflow:hidden` 不可滚（扇出 18 站） | ✅ **已修 + 本地实证**（嵌入 `maxScroll`=0、独立仍可滚）；线上待复检 |
| **P0** | P4 hub 面板高度塌陷为 0 | `.instrument-rack { flex: 1 1 auto }` | ✅ **已修 + 线上实证**（413→0 变为 713→626 px） |
| P1 | P2 favicon 404 | 18 站补 `src/app/icon.svg` | ✅ **已修 + 线上实证**（控制台错误 1→0；`/icon.svg` 200） |
| — | P3 hub 检测误报 | 改脚本选择器为 hub 自身语汇 | ✅ 已修（脚本侧） |

### 线上复检实录（部署后，Lead 独立复核，非引用汇报）

| 指标 | 修复前（旧线上产物） | 修复后（线上） |
| :--- | ---: | ---: |
| curvelab 页面总高 | 4410 px | **900 px** |
| `.iu-sr-only` 计算样式 | `display:table`，实高 **4164 px** | `display:block` · `max-height:1px` · 实高 **1 px** |
| hub `.instrument-rack` h | 81 px | **706 px** |
| hub `.rack-grid` h | 44 px | **669 px** |
| hub `.panel-body` h | **0 px** | **626 px**（`overflow: hidden`） |
| hub `iframe.panel-iframe` h | **0 px** | **626 px** |
| iframe 内 `body` / `.site-root` min-height | `100vh` | **`0px` / `0px`** |
| 控制台错误（每站） | 1（favicon 404） | **0** |

复现脚本：`.tmp/verify-live-final.mjs`（Lead 独立复核）、`.tmp/verify-hub-p4.mjs`（本地 hub 盒子链）、
`.tmp/probe-adr08-criteria.mjs`（ADR-08 判据受控实验）。

> ⚠️ 关于 `/favicon.ico`：控制台已无 404，但**裸探针** `GET /favicon.ico` 仍返回 **404**（Cloudflare Pages 的 404 页）。
> 这**不是用户可见缺陷**：站点已声明 `<link rel="icon" href="/icon.svg">`，浏览器据此不再回退请求 `/favicon.ico`，
> 所以控制台干净。若要让裸探针也 200，需另加 `public/favicon.ico`；当前做法（App Router 的 `icon.svg` 约定）
> 已消除真实症状。这条要在报告里与本表的「控制台错误 0」并列写明，避免被读成「favicon 已完全消失」。

### 线上 18 站部署完整性（Lead 独立核验，`curl` + Playwright）

部署后逐站实测，**18/18 全部通过**：

| 项 | 结果 |
| :--- | :--- |
| HTTP 状态 | 18/18 = **200** |
| 控制台错误 | 18/18 = **0**（修复前每站 1 个 favicon 404） |
| `.iu-sr-only` 计算样式 | 出现该元素的 5 站（03/08/11/15/16）均为 `display: block` + 实高 **1 px**（修复前为 `display:table` + 4164 px） |
| 页面总高 | 全部落在 **900–1501 px**（修复前 curvelab 4410 px） |
| hub 胶囊数 | **18**，控制台错误 **0** |

逐站数字：

```
01 gpa          200  1204px   无 sr-only      错误 0
02 spark        200   900px   无 sr-only      错误 0
03 grant-audit  200   916px   block 1px       错误 0
04 pat-hot      200   900px   无 sr-only      错误 0
05 lit-sonar    200  1501px   无 sr-only      错误 0
06 mentor       200   900px   无 sr-only      错误 0
07 cold-email   200  1161px   无 sr-only      错误 0
08 lab-kanban   200   900px   block 1px       错误 0
09 matrix-cross 200   900px   无 sr-only      错误 0
10 pdf-sniper   200   903px   无 sr-only      错误 0
11 curvelab     200   900px   block 1px       错误 0
12 repro-check  200   900px   无 sr-only      错误 0
13 chart-foundry 200 1166px   无 sr-only      错误 0
14 review-lab   200   900px   无 sr-only      错误 0
15 retract-radar 200  900px   block 1px       错误 0
16 yunheng      200   900px   block 1px       错误 0
17 evidence-cv  200   900px   无 sr-only      错误 0
18 prejob       200   900px   无 sr-only      错误 0
```

复现：`.tmp/verify-live-18.mjs`（读花名册推导 appId → 逐站 Playwright 测量）。

### 线上安全头实测

| 站点 | CSP `frame-ancestors` | HSTS |
| :--- | :--- | :--- |
| `mx-gpa.pages.dev`（微站样本） | ✓ 精确放行 hub 三类来源 | ✓ `max-age=31536000; includeSubDomains` |
| `mx-curvelab.pages.dev`（微站样本） | ✓ | ✓ |
| `mx-orbital.pages.dev`（hub） | 无（**正确**：hub 是顶层页，无需限制自己被嵌） | ✓ **已补齐**（含 Permissions-Policy、COOP） |

> hub 的 `_headers` 原本由 `scripts/build-hub-static.mjs` 单独手写生成，与微站的
> `scripts/lib/pages-headers.mjs` **不同源**，因此曾漏掉 HSTS 与 Permissions-Policy。
> 这是「单一事实源」在 HTTP 头上的同类漏网（与 metadata 那次的形状一致），**已修**：
> 在 `build-hub-static.mjs` 内对齐同一套安全头（**刻意不加 `frame-ancestors`**，
> 并由 `scripts/assert-config-restored.mjs` 专门拦这一条），重新部署后 `curl` 实测已生效。

---

## 遗留待办

| ID | 事项 | 现状 | 影响 / 下一步 |
| :--- | :--- | :--- | :--- |
| **TODO-1** | ~~ADR-08「iframe 内不滚」被违反~~ | ✅ **已修 + 线上实证**：微站侧 `html`+`body` 双层 `overflow:hidden; height:100%`，18 站已扇出并部署 | 见下「E 线修复与终验」 |
| TODO-2 | `/favicon.ico` 裸探针仍 404 | 页面已声明 `/icon.svg`（200），浏览器不再回退请求 `/favicon.ico`，控制台已干净（18/18 站 0 错误） | 仅影响「浏览器/爬虫直接猜 `/favicon.ico`」的场景；如需覆盖可加 `public/favicon.ico` |
| TODO-3 | hub 静态产物未纳入统一 `_headers` 生成器 | 已在 `build-hub-static.mjs` 内联对齐 | 长期应抽成共享生成器的「无 CSP 变体」，避免再次分叉 |
| TODO-4 | `--inject-css` 参数解析曾静默忽略 `--name=value` | 已修 | 记录在案：审计脚本的参数解析本身也需要测试，否则会静默少跑站 |

### E 线修复：ADR-08「iframe 内不滚」真正落地

**修复**（18 站 `globals.css`，由 `scripts/fanout-embedded-fix.mjs` 幂等扇出）：

```css
/* ADR-08：iframe 内不滚 —— 必须同时压掉 html 与 body 两层滚动容器。
 * 只写 body{overflow:hidden} 不够：实测 <html> 的 overflow:visible 才是真正的
 * 滚动容器，maxScroll 仍为 142px（滚轮动不了，但可滚空间仍在，
 * 触控/键盘/scrollIntoView 仍能滚）。加上 html 的 overflow 与 height 才彻底归零。 */
html:has(body[data-embedded='true']) { overflow: hidden; height: 100%; }
body[data-embedded='true'] { overflow: hidden; height: 100%; }
```

**为什么 `height: 100%` 必需**（Lead 的候选方案对比实测，同一产物同一度量代码）：

| 方案 | `maxScroll` | 真实滚轮后 `scrollTop` | 判定 |
| :--- | ---: | ---: | :--- |
| 修复前 | 142 | 142 | ✗ 可滚 |
| 仅 `body{overflow:hidden}` | 142 | 0 | ✗ 可滚空间仍在 |
| `body` + `html{overflow:hidden}` | 142 | 0 | ✗ 同上 |
| **`html`+`body` 均 `overflow:hidden; height:100%`** | **0** | **0** | ✅ 不可滚 |

**Lead 独立终验** —— 分两层：本地产物 + 已部署的线上。

**第一层：本地产物**（双端口 harness，三个样本站覆盖有/无 sr-only 两类）：

| 判据 | 01-gpa | 11-curvelab | 15-retract-radar |
| :--- | ---: | ---: | ---: |
| 嵌入模式 `maxScroll` | **0** | **0** | **0** |
| 真实滚轮后 `scrollTop` | **0** | **0** | **0** |
| `html` / `body` 计算 overflow | hidden / hidden | hidden / hidden | hidden / hidden |
| `html` / `body` 计算 height | 626px / 626px | 626px / 626px | 626px / 626px |
| **standalone 仍可滚**（回归判据） | ✓ `scrollY`=304 | ✓ 无溢出 | ✓ 无溢出 |
| `.instrument-slot` 高度（未截断） | 955px | 598px | 516px |

**第二层：线上（部署后，Lead 独立复核）**：

| 判据 | 线上实测（`mx-orbital.pages.dev` 内挂载 `mx-gpa.pages.dev`） |
| :--- | :--- |
| iframe 内 `maxScroll` | **0** |
| 真实鼠标滚轮 ×5 后 `scrollTop` | **0 → 0** |
| 程序化 `scrollTop=99999` 跨两帧 / 250ms | **0 / 0** |
| `html` / `body` 计算 overflow | **hidden / hidden** |
| `html` / `body` 计算 height | **626px / 626px** |
| `CSS.supports('selector(html:has(body))')` | **true**（`html:has(...)` 规则确实命中） |
| **standalone 线上仍可滚**（回归） | ✓ `scrollY`=304（`maxScroll`=304） |
| 线上 CSS 含修复（遍历全部 5 个 `<link>`） | 4/4 样本站 ✓ |

即：**嵌入模式彻底不可滚、独立模式不受影响** —— ADR-08 的字面约定首次真正满足，且已在线上生效。

> ⚠️ **复核方法教训**：Lead 第一次复核线上时**只取了 HTML 里第一个 `<link>` 指向的 CSS**，便下了「线上仍无修复」的结论 —— **错**。Next 一次引用 **5 个** CSS 文件，修复在其中之一。**校验必须遍历全部引用的资源**，不能取首个匹配。这条已与 §「方法论教训」并列记录。

> ⚠️ 依赖 `:has()` 选择器（Chrome 105+ / Safari 15.4+ / Firefox 121+）。实测本会话 Chromium `CSS.supports('selector(html:has(body))') === true`。
> 但**仓库内无 browserslist / 目标浏览器基线声明**（`package.json`、`.browserslistrc`、ADR 文档均未声明），
> 因此「所有目标浏览器均支持」无法从仓库证实 —— 若将来要支持更低基线，应改用给 `<html>` 加类名的方案，避免 `html:has()` 整条**静默失效**。

#### ⚠️ E 线修复的**产品副作用**：面板外的内容变为不可达

ADR-08 字面达标带来一个必须让产品侧知道的后果。Lead 独立实测（iframe 高 `626px`，量各站 `.site-root` 内容高）：

| 站 | 内容高 | 超出面板（不可达） |
| :--- | ---: | ---: |
| 18-prejob-multiverse | 1802 px | **1176 px** |
| 05-lit-sonar | 1391 px | **765 px** |
| 01-gpa-sandbox | 1125 px | **499 px** |
| 07-cold-email-lab | 1082 px | **456 px** |
| 13-chart-foundry | 1075 px | **449 px** |
| 03-grant-audit | 837 px | 211 px |
| 10-pdf-sniper | 824 px | 198 px |
| 11-curvelab-fit | 768 px | 142 px |
| 02-spark-teaming | 752 px | 126 px |
| 12-repro-check | 726 px | 100 px |
| 04 / 15 / 14 / 06 | 687 / 686 / 669 / 647 | 61 / 60 / 43 / 21 px |
| 08 / 09 / 16 / 17 | 603 / 482 / 601 / 519 | **0**（全部可见） |

**共 14/18 站有不可达内容**。

**归因**：这**不是** E 线补丁引入的布局缺陷 —— A/B 实测（在 iframe 内临时撤销 ADR-08 规则再比各子元素高度）显示 `.site-root` 与全部子元素高度**前后完全一致**，补丁对布局零影响。
它是「原本可滚 → 现在锁死」的**行为变化**：修复前用户能在面板内滚到全部内容（但违反 ADR-08），修复后超出 `626px` 的部分**永远看不到**，除非点面板右上角 `↗ 全屏独立打开`。

**需要产品决策（四选一，未实施）**：
1. **增大 hub 面板高度** —— 最直接，但会挤压星轨区（左 32%）与「同屏 2–3 台」的布局目标；
2. **面板内允许滚动** —— 放弃 ADR-08 字面约定（需同步改 ADR 与本文档判据）；
3. **明确引导「全屏独立打开」** —— 成本最低，但等于承认面板只是「预览」；建议至少在面板底部加一句提示；
4. **微站提供真正的「嵌入模式紧凑布局」** —— 把内容压进面板（最符合 ADR-08 的初衷「iframe 内降级为紧凑布局」，见 `04-tech-decisions.md:349`）。

#### 解法分层（Lead 调研结论）

| 层 | 手段 | 收益 | 状态 |
| :--- | :--- | ---: | :--- |
| **① 消除无效占位** | 嵌入态隐藏 `.meta-grid`（3 张身份介绍卡）+ `.site-footer`（域名署名） | **149–150 px**（含连带消掉的 flex gap） | ✅ 已实现并部署（18 站） |
| **② iframe 高度自适应（主方案）** | 实现架构里已定义但从未落地的 `layout.resize` 协议：微站上报真实内容高，hub 决策 `iframe = max(内容高, 可用高)`，`.panel-body` 成为唯一滚动容器 | **解决全部超框**（内容 1300–1500px 也可完整呈现） | ✅ 已实现并部署（SDK+hub 双侧） |
| ③ 引导降级 | 面板内提示「内容较长，点 ↗ 全屏独立打开」 | 体验兜底 | 待决策 |
| ④ 放弃字面 | 面板内允许滚动（iframe 内可滚） | 内容全可见但违反 ADR-08 | 已用 ② 取代，不再需要 |

**① 已落地**：18 站 `globals.css` 增加
```css
/* ADR-08 原文要求「iframe 内降级模式（隐藏自身导航，适配紧凑布局）」 */
body[data-embedded='true'] .meta-grid { display: none; }
body[data-embedded='true'] .site-footer { display: none; }
```
Lead 独立实测（18 站全量，产物含该规则）：嵌入态两者高度 **0 / 0**；standalone 态 **60 / 46**（正确保留，独立页仍是完整站）；`.instrument-slot` 与 `.status-row` 未受影响；`maxScroll` 仍为 **0**。
净收益实测 **149–150 px**（比粗算的 94px 多，因 `display:none` 连带消掉两处 flex `gap` 的间距）；A/B 逐站验证「仅 meta/footer 两项变化、其他子元素高度逐项不变」。

**② 是主方案，不是补充** —— 这一点在实施后才看清。原因：

并行会话在 22:27 起给 18 站加了 `.mx-wb`（`SiteWorkbench`），文件头自述：
> 「账本增删改、导出、虫洞投送/接收的**全部逻辑**都在 `./workbench-impl` 里，18 站共用同一份字节相同的实现」

即它是**核心业务工作台**，不是可隐藏的装饰。实测它占 **557–930px**，比仪器本体还高：

| 站 | 内容高 | 移除 `.mx-wb` 后 | 仪器本体 | `.mx-wb` 占 |
| :--- | ---: | ---: | ---: | ---: |
| 01-gpa | 1480 | 913 | 903 | **557** |
| 05-lit-sonar | 1309 | 693 | 683 | **606** |
| 08-lab-kanban | 1383 | 443 | 433 | **930** |

**所以必须区分**：

| 区块 | 内容 | 嵌入态该藏吗 |
| :--- | :--- | :--- |
| `.meta-grid` | 「UI 形态 / 独立台账 / 原型来源」静态介绍卡 | ✅ 该藏（纯说明） |
| `.site-footer` | 域名 + 生成器署名 | ✅ 该藏（纯署名） |
| **`.mx-wb`** | **账本 CRUD / 导出 / 虫洞投送接收** | ❌ **绝不能藏**（核心功能） |

「移除 `.mx-wb` 后 08 站 1383→443 不再超框」这个数据，证明的是**不能让用户在 hub 里丢掉工作台**，而不是「应该隐藏它」。
既然它是核心功能，内容高就必然在 1300–1500px 量级，而面板只有 627px —— **只能靠 ② iframe 高度自适应解决**。

**② 的实现要点（关键推导，与直觉相反）**：

错误的做法是「内容高 > 可用高 → iframe 设成可用高」。因为 `.panel-body` 是滚动**视口**、iframe 是它的**内容**：若 iframe=627 而 `.panel-body` 也=627，滚动范围 = 0，**滚不动**；而 iframe 内部又被 `overflow:hidden` 压着（已达标项）→ 内容依旧不可达，只是把「静默裁掉」换成「裁掉 + 一个滚不动的滚动条」。

正确组合是**两个变量同时满足**：
```
iframe 高度 = max(内容高, 可用高)       // 必须 >= 内容高，否则 iframe 内部会裁
.panel-body = 可用高 + overflow-y:auto  // 唯一滚动容器在 hub 侧
```
→ 实测 `.panel-body` 滚动范围 838px（真实可滚），iframe 视口 = 内容高 → **内部 `maxScroll` 仍是 0**（ADR-08 不被破坏）。

**实现与验证**（详见提交 `bcdbaf4`）：
- SDK 发送侧 `packages/matrix-sdk/src/iframe/resize.ts`（750 行）—— 测量学上**不能用 `documentElement.scrollHeight`**（被 `html{height:100%}` 压平成视口高，实测 626），也**不能用 `body.scrollHeight`**（矮内容站会虚高：08 站真实 443 却报 626）；最终用「body 子元素底边最大值」，`scrollHeight` 仅作无可量元素时的兜底。
- hub 决策侧 `apps/orbital-hub/src/lib/panel-resize.ts` + `use-panel-resize.ts` + `InstrumentPanel.tsx` 接线。
- 三重防自激（阈值 2px / 静默窗 160ms / 增长连击熔断 4 次）+ 上限 3000px。
- `.panel-iframe` 从 `inset: 0` 改为只锁 `top/left`+`width:100%` —— `inset:0` 的 `bottom:0` 会与内联 `height` 竞争、把高度拉回容器高（实测陷阱）。
- 单测 `packages/matrix-sdk/test/resize.test.ts`：**20 passed / 0 fail**，含 4 条 origin 负样本（伪造 origin / 版本不匹配 / `origin='null'` / **形如「evil-」前缀的近似域名（仅测试用伪造值，非花名册条目）** 均被丢弃）。
- 真实 hub 端到端实测：iframe **627→1465**、`.panel-body` 滚动 **838px 真实可滚**、iframe 内 `maxScroll=0`。
- 视口耦合已排除（固定 iframe 高 627→2000 扫 5 档，内容高恒定不变）→ 当前不存在「撑高→再变高」的发散风险。

**② 顺带修复了两个既有 SDK bug**（不修则协议不通，且影响面超出布局）：
- Bug A：host 侧 `post()` 的 `target = parent ?? win` 在 host 角色下 `parent===null` → **永远发给自己**，`hello.ack` 到不了子站；
- Bug B：`DocumentLike` 只声明 `cookie`、`env.ts` 只拷贝 `cookie` → `readReferrer()` 恒 `null` → tenant 的 `hello` 永久卡队列。
→ 这两个 bug 也是 **mx_idt SSO 交换不通**的原因（详见 §「重大发现：hub 内嵌态的 SSO 当前是断的」）。

**效果（两基准对比，实测）**：

| 基准 | 面板可用高 | 修复前超框 | 修复后超框 |
| :--- | ---: | ---: | ---: |
| 900 px 视口 | 627 px | 14/18 | **13/17** |
| **1080p 视口** | **807 px** | — | **7/17** |

> 剩余超框站（1080p 基准下 7 站）是**仪器本体本身就高于面板**：01-gpa 965px、05-lit-sonar 1391px、07-cold-email 1082px、13-chart-foundry 1075px、03-grant-audit 837px、10-pdf-sniper 824px、18-prejob 1802px。
> 这部分 **CSS 隐藏解决不了**，只能靠 ② iframe 高度自适应或 ③/④ 兜底。

> 现状记录：当前实现选了「字面满足 ADR-08 + 紧凑布局①」，上表剩余 7 站仍有内容裁切。**是否接受**属产品判断，Lead 不代为决定。

---

## 🔴 重大发现：hub 内嵌态的 SSO（mx_idt 交换）当前是断的

这是本轮调查 `layout.resize` 时**顺带挖出的真产品缺陷**，影响面超出布局问题，单独成节。

### 现象（线上实测）

在线上 hub 点开任一微站，读 iframe 内状态胶囊：

```
["MatrixID · offline", "iframe 内嵌", "面板 · local", "SDK · 未就位", "通道自检"]
→ MatrixID ready? false   offline? true
```

即 **hub 内嵌态下微站从未进入 `ready`**。

### 归因：`HostBridge` 的两个既有缺陷（代码级证据）

**Bug A —— host 侧的 `post()` 把消息发给了自己，永远到不了 iframe**

`packages/matrix-sdk/src/iframe/bridge.ts`（HEAD 版本 `:149-150`、`:324`）：
```js
const parent = role === 'tenant' ? win?.parent ?? null : null;
const target = parent ?? win;      // host 角色 → parent === null → target = win
```
host（hub）角色下 `target` 恒为自身 `window` → `window.postMessage` 打到自己 →
`bridge.hello.ack` 永远到不了子站 → 子站 `connected` 永远 `false`、学不到宿主能力。

**Bug B —— tenant 侧永远解析不出 host origin，`hello` 永久卡在队列**

- `packages/matrix-sdk/src/types.ts` 的 `DocumentLike` **只声明了 `cookie`**，没有 `referrer`；
- `packages/matrix-sdk/src/runtime/env.ts` `:51-52`：
  ```js
  const doc = candidate as { cookie?: unknown };
  return typeof doc.cookie === 'string' ? { cookie: doc.cookie } : null;  // 只拷贝 cookie
  ```
  → `referrer` 从未被保留；
- 而 `bridge.ts:422` 的 `readReferrer()` 读的正是 `doc.referrer` → **恒返回 `null`** →
  `resolveTargetOrigin()` 失败（SDK 刻意不退化到 `'*'`）→ `bridge.hello` 一直排在队列里不 flush。

### 为什么这很重要

`docs/01-plan/04-tech-decisions.md` 里 ADR-02/03 把 mx_idt 交换称为「**必做项不是优化项**」；
`docs/01-plan/05-risks.md` 的 **R-T04** 甚至已经预言了这个场景：
> 「hub 里能看到仪器面板，但一点就要求重新登录」

**它已经发生了。**

代码链印证：`packages/matrix-sdk/src/auth/sso.ts:361` `await bridge.request('sso.idt.request', …)`（tenant 请求）
与 `:588` `bridge.on('sso.idt.request', …)`（host 回复）—— **全程走这套桥**。桥不通 → mx_idt 交换不通 → 内嵌态永远 offline。

### 处置状态

| 项 | 状态 |
| :--- | :--- |
| Bug A / Bug B 定位 | ✅ 已定位（代码级，见上） |
| 修复 | 🔧 进行中（`HostBridgeOptions.tenantWindow` + `DocumentLike.referrer`） |
| 线上验证 | ⏳ 待修复部署后复验 |
| 微站侧 `SDK · 未就位` | ⚠️ **另有原因**：微站 `src/lib/sdk-facade.ts` 的 `resolveSdk()` 拿不到 SDK 实例（该文件正被另一会话重构，引入了新包 `@matrixos/microsite-data`）。**不要把它与 Bug A/B 混为一谈** |

> ⚠️ 复验方法：**不要用线上微站判断桥是否修好** —— 线上还受「微站侧 SDK 未就位」干扰。
> 应在**双端口 harness**（真实 `createHostBridge` + 真实握手）里验证「桥层握手已通」，
> 并单独说明「线上微站 SSO 仍 offline 是微站侧 SDK 集成问题」。

---

## 方法论教训（比结论更重要）

这一轮体检暴露了**审计脚本自身**的三处方法论缺陷，以及**复核者（Lead）的多处判断错误**，都值得单独记下：

1. **DOM 存在性 ≠ 视觉可见性**。旧脚本对 iframe 只读「正文长度 > 0」，于是把「面板高度 = 0、视觉全空」判成了「内容正常」（P4）。**跨源 iframe 即使外层高 0，内部 DOM 依然可读** —— 这类假阳性只有盒子测量（`getBoundingClientRect`）能戳破。
2. **选择器必须适配被测对象的语汇**。拿微站的选择器（`.instrument`）去判 hub，得到的是「hub 坏了」这种反向结论（P3）。判 hub 要用 `.star-orbit` / canvas / 胶囊数。
3. **「总量高」不等于「内容高」**。P1 的量化判据必须是「有效内容高 / 页面总高」的比值，而不是单看 `scrollHeight` 大不大 —— 否则无法区分「内容多」与「内容少但被撑高」。**更要命的是**：把「撑高页面的元凶」也计入「有效内容」，会让空白占比恒为 0、彻底失去鉴别力（修复前后都是 0）。
4. **⚠️ 机制推演不能替代实测（本轮 Lead 犯的错）**。Lead 曾断言「hub 的 `.panel-body{overflow:hidden}` 会裁掉超出部分，所以 iframe 内部不出现滚动条」，并据此判定 ADR-08 已合规。**这是错的**：
   - `.panel-body` 只裁**父页面中 iframe 元素**的溢出；
   - 跨源 iframe 是**独立浏览上下文**，有自己的滚动容器，父页面的 `overflow` 管不到子文档**内部**。
   - 实测（真实滚轮 + 程序化滚动跨帧复读 + 计算样式）三种方法一致证明 **iframe 内仍可滚**。

   **教训**：跨边界（iframe / worker / 进程 / 网段）的样式与行为，**父侧属性推不出子侧结论**，必须进到子侧实测。「裁切了外观」与「禁止了滚动」是两件事。

5. **校验资源必须遍历全部引用，不能取首个匹配**。Lead 复核线上是否含新 CSS 时，用正则只取了 HTML 里**第一个** `<link>` 就下结论「线上仍无修复」——**错**。Next 一次引用 **5 个** CSS 文件，修复在其中之一。同类坑在批量复检里还有一个变体：fixer-css 18 站连扫时 `mx-spark`/`mx-curvelab` 报 ✗，单独重测即 ✓ —— 是并发扫描下的 CDN/连接抖动。**批量复检必须「遍历全部资源 + 带重试」**，否则会同时产出假红与假绿。

7. **测量前必须把「测量环境」本身清理干净**（本轮最新踩到）。Lead 在真实 hub 里连续点开多个面板后测 `maxScroll`，得到 `03-pat-hot = 139px`，一度判定「E 线有站漏修」。**重测（单面板、先移除引导层）得到 `maxScroll=0`、滚轮 `0→0`、`html/body overflow=hidden`、且逐元素扫描确认「无自身可滚的子元素」**。
   - 差异来源：**多面板叠加**改变了可用高度；且 hub 首次访问有 `.onb-layer` 引导遮罩会拦截指针事件。
   - **教训**：`maxScroll` 这类量对「同屏几个面板」「遮罩是否在场」极其敏感。**测滚动必须：单面板 + 先关引导层 + 明确写出被测面板是哪一个**。同一页面连测多面板时，每测完一个要关闭再测下一个，否则数字不可比。

8. **正则扫描压缩后的 CSS 会误报「畸形规则」**。Lead 见线上 CSS 出现 `body[data-embedded=true]){...}` 以为是「多了一个 `)` 的畸形选择器」，据此怀疑修复失效。实际那是 `html:has(` + `body[data-embedded=true]){...}` 的**连续文本**——`)` 属于 `:has(` 的闭合，**CSS 完全正确**。是我的正则把半个选择器当成了独立规则。
   - **教训**：对**压缩后**的 CSS/JS 做模式匹配时，边界字符（`)`、`{`、`}`）会被相邻规则共享，正则必须带上足够上下文（或先格式化再匹配）。这类「工具误判」我本轮犯了 3 次（首个 link、`:has` 误读、括号误读）——**共同点都是用不够严格的正则去解读压缩产物**。

6. **「测试红」要先分清是「已入库回归」还是「未提交在制品」，且**归因必须实测而不能靠读代码推断**。本轮 `pytest` 出现 1 条红（`test_lax_cookie_with_pages_dev_cors_warns`），初看像回归；用 `git show HEAD:<file>` 一查发现该用例与其实现**都不在 HEAD** —— 是工作区里另一会话未提交的半成品，不是已入库代码的回归。

   **Lead 的第一版归因是错的**，值得完整记录：
   - **错误归因**：「`cors_allow_pages_dev` 与 `cors_origin_regex` 是两条独立配置路径，实现只认后者」。
   - **实际根因**：`cors_origin_regex` 在 `config.py:195` 是 **property**，`cors_allow_pages_dev=True` 时它**就返回** `MATRIXOS_PAGES_ORIGIN_REGEX` —— 两者**并非独立**。真正致红的是**正则转义**：常量是 `r"^https://mx-[a-z0-9-]+\.pages\.dev$"`，点是转义的（`pages\.dev`），所以 `"pages.dev" in regex` **恒为 False**。
   - **实测证据**：`"pages.dev" in R` → `False`；`"pages.dev" in R.replace("\\.", ".")` → `True`。
   - **后果差异**：按错误归因给出的 `settings.cors_allow_pages_dev or (...)` 方案只能救回 flag 一条，**手写转义正则与精确白名单两条仍会漏报**。「放行 pages.dev」在配置层有**三个**独立表达方式（flag / 手写正则 / 精确白名单），只补一条等于换个地方继续漏。

   **修正后的实现**：新增 `_allows_pages_dev_origins()` 覆盖三条路径（flag → 正则经 `replace("\\.", ".")` 归一化 → 扫 `cors_allowed_origins`），并加两条反例防误报。Lead 独立核验 6/6 符合预期（3 条正例 + 3 条不应误报的负例）。

   **教训**：读代码得出的「配置层结构」推断，必须用运行时值验证（本例一行 `in` 就能戳破）；**「两个配置项看起来独立」不等于派生关系不存在**。

> 第 4 条是本轮最重要的收获：它差点让一个真实缺陷被写成「已修复」。**发现它靠的是复核者不迷信 Lead 的结论、坚持用三种独立方法实测** —— 这种对抗性验证应当成为惯例。

后续所有线上体检一律**以盒子测量为准**，DOM 断言只作为辅助；**涉及跨边界的结论必须以子侧实测为准**。

---

## 复现方式

```bash
# 全站体检（盒子测量版）
node scripts/audit-online.mjs                       # 线上
node scripts/audit-online.mjs --local-static        # 本地 out/ 产物
node scripts/audit-online.mjs --inject-css          # 还原修复前 CSS 做 A/B

# 构建后配置断言（防 next.config.ts 被留在 export 模式）
node scripts/assert-config-restored.mjs             # 断言
node scripts/assert-config-restored.mjs --repair    # 从 .deploybak 自动恢复

# 生成器与生成物同源性（模板 === 磁盘产物，逐字节）
node scripts/gen-site-assets.mjs --check
```

Lead 本轮用过的独立复核脚本（在 `.tmp/`，未入库，可按需重建）：

| 脚本 | 用途 |
| :--- | :--- |
| `.tmp/verify-live-18.mjs` | 线上 18 站逐站 HTTP / 控制台错误 / `.iu-sr-only` 压制 / 页面总高 |
| `.tmp/verify-adr08-live.mjs` | 线上 hub 内 iframe 是否可滚（真实滚轮 + 程序化 + 计算样式） |
| `.tmp/verify-adr08-final.mjs` | 本地产物双端口，验证嵌入不可滚 + standalone 回归 |
| `.tmp/verify-hub-p4.mjs` | 本地 hub 盒子链（rack/grid/panel-body/iframe 高度） |
| `.tmp/verify-unreachable.mjs` | ADR-08 副作用：各站内容超出面板的「不可达」量 |
| `.tmp/verify-fanout.mjs` | 脚手架模板 vs 磁盘产物逐行比对 |

> **两个 harness 陷阱（都实际踩过）**：
> 1. **静态产物不能挂子路径**：Next 导出的资源是根绝对路径（`/_next/static/...`），挂在 `/site/` 前缀下会让 CSS 全 404，伪造出「页面被撑到 13216px」的假象。必须挂根路径（用双端口或多服务器）。
> 2. **hub 的 iframe 受 CSP `frame-ancestors` 约束**：白名单只放行 `127.0.0.1:3000` / `localhost:3000`，用随机端口会看到破损文档图标 —— 那不是产品缺陷，是 CSP 拦了。

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
