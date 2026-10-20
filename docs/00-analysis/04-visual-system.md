# 视觉体系提炼 · MatrixOS v3.0

> **来源**：`bundle/MatrixOS_v3_完整交互规范与UI图谱_高清版.html`
> **提炼方式**：直接解析 HTML 源码中的 `tailwind.config`（L10–29）、`<style>` 块（L30–62）、以及全库 `class="..."` 属性与内联 SVG `fill`/`stroke` 取值的静态统计，非人工阅读转述。
> **定位**：本文件是**唯一权威 token 表**，`packages/instrument-ui` 的 `tokens.css` / `tailwind.preset.ts` 应按此实现，不要再从渲染图取色。
> **诚实声明**：渲染图（`bundle/UI_Renders/*.jpg`）是 AI 生成的概念图，**不可作为取色依据**——其主色调（如 UI_01 的 `#1c2e39`、UI_02 的 `#24686c`）与代码里的 token 并不一致。token 一律以代码为准。

---

## 一、结论速览（给前端 60 秒）

| 项 | 值 |
| :--- | :--- |
| 页面底色 | `#050814`（`obsidian`），正文色 `#f1f5f9` |
| 实际表面系统 | Tailwind 默认 `slate` 色阶（`slate-950/900/800/700`），**不是**自定义色 |
| 品牌主色 | `indigo` `#6366f1`（主 CTA）/ `cyan` `#06b6d4`（仪器与数据主色） |
| 正向色 | `emerald` `#10b981` |
| 字体 | `Inter`（UI）+ `JetBrains Mono`（所有数字/坐标/域名/代码） |
| 圆角 | `8px` / `12px` 两个值覆盖 52% 用量 |
| 视觉签名 | `.instrument-bezel` 内外双阴影 + `.glow-*` 彩色辉光 + `rgba` 透明边 |
| 唯一自定义动画 | `pulseSoft` 2.8s（呼吸球） |
| 响应式 | 只有 `sm`/`md`/`lg` 三档，无 `xl`/`2xl`，无移动端手势层 |

---

## 二、色彩 Token

### 2.1 表面层（Foundation）

| Token | 值 | 声明位置 | 实际用途 | 使用次数 |
| :--- | :--- | :--- | :--- | :--- |
| `obsidian` | `#050814` | `tailwind.config.colors.obsidian` | 页面底色、总控台容器 | 1 处（`bg-obsidian`）+ `body` 硬编码 |
| `panel` | `#0B1021` | `tailwind.config.colors.panel` | **声明但全库 0 处引用** | 0 |
| `--instrument-from` | `#0b1124` | `.instrument-bezel` | 仪器面板渐变起点 | 16 处继承 |
| `--instrument-to` | `#070b18` | `.instrument-bezel` | 仪器面板渐变终点 | 16 处继承 |
| `--glass-fill` | `rgba(13, 20, 38, 0.78)` | `.glass-panel` | 玻璃拟态面板填充 | 7 处继承 |
| `--body-fg` | `#f1f5f9` | `body { color }` | 正文文字色（= `slate-100`） | 全局 |

> ⚠️ **`panel` 是死 token。** 若 `instrument-ui` 直接照搬会得到一个永不生效的变量。建议 Stage 1 要么删除，要么把 `.instrument-bezel` 的渐变终点改回 `panel` 以兑现设计意图。

**真正承担表面职责的是 Tailwind 默认 `slate` 色阶**（按 class 出现次数排序）：

| 类 | 次数 | 语义 |
| :--- | ---: | :--- |
| `border-slate-800` | 77 | 全局分隔线（绝对主力） |
| `bg-slate-950` | 47 | 卡片/面板凹槽底 |
| `bg-slate-900` | 46 | 次级面板底 |
| `bg-slate-800` | 17 | 按钮底 / 内嵌块 |
| `border-slate-700` | 9 | 输入框边 |
| `bg-black` | 6 | 图片容器 |

slate 全家合计 334 次，是 6 个品牌色总和的 1.9 倍——**MatrixOS 的深色感 90% 来自 neutral 色阶，不是来自品牌色**。

### 2.2 品牌六色（Brand）

| Token | 值 | 声明 | 实际 class 使用 | 语义归类（据使用场景归纳） |
| :--- | :--- | :--- | ---: | :--- |
| `brand.indigo` | `#6366f1` | `tailwind.config` | **0**（`brand-*` 前缀） | 主行动 / 默认选中 / 结构高亮 |
| `brand.cyan` | `#06b6d4` | 同上 | **0** | 仪器数据 / 拟合曲线 / 地址栏 |
| `brand.emerald` | `#10b981` | 同上 | **0** | 正向结果 / 合规通过 / 已挂载 |
| `brand.amber` | `#f59e0b` | 同上 | **0** | 热度 / 预算 / 待办 / 警告 |
| `brand.rose` | `#f43f5e` | 同上 | **0** | 危险 / 超限 / 撤稿风险 |
| `brand.violet` | `#8b5cf6` | 同上 | **0** | 开放生态 / SDK 插槽 |

> ⚠️ **`brand.*` 整个对象是死配置。** 六个值逐一比对，**恰好等于 Tailwind 默认调色板的 500 档**（`indigo-500 = #6366f1`、`cyan-500 = #06b6d4`、`emerald-500 = #10b981`、`amber-500 = #f59e0b`、`rose-500 = #f43f5e`、`violet-500 = #8b5cf6`）。所以全库 0 次 `brand-*` 而照样呈现出这六个颜色——走的是默认色阶。
>
> 对 Stage 1 的直接影响：**做设计系统时不要建 `brand-*` 命名空间**，直接接管 Tailwind 的 `indigo/cyan/emerald/amber/rose/violet` 六族，或把这六族重命名成语义名（`--color-action`、`--color-instrument`…）。否则会造出第二套并行且不被使用的 token。

**按实际 class 使用量排序**（决定页面的视觉重心）：

| 色族 | 次数 | 占品牌色总量 |
| :--- | ---: | ---: |
| cyan | 113 | 31.4% |
| indigo | 98 | 27.2% |
| emerald | 94 | 26.1% |
| amber | 27 | 7.5% |
| violet | 19 | 5.3% |
| rose | 9 | 2.5% |

> 🔴 **语义权重失衡（产品级问题，不只是视觉问题）**：rose 承担「撤稿预警 / 经费红线 / 劳务费超限 / 合规风险」四类最高危信息，却只有 9 处，是 cyan 的 1/12。而 emerald（正向）有 94 处。**风险信号在视觉上被严重稀释**，与 `03-gap-analysis.md` 里"合规是这个产品的核心卖点"直接矛盾。Stage 3 做仪器组件库时需重新分配：建议把风险态提到与 cyan 同量级，并引入 `--color-danger` 语义层。

### 2.3 文字色阶（按次数）

| 类 | 值 | 次数 | 用途 |
| :--- | :--- | ---: | :--- |
| `text-white` | `#ffffff` | 105 | 标题 / 主数值 |
| `text-slate-400` | `#94a3b8` | 71 | 说明文字（主力） |
| `text-emerald-400` | `#34d399` | 42 | 正向数值 |
| `text-slate-300` | `#cbd5e1` | 37 | 次级正文 |
| `text-cyan-400` | `#22d3ee` | 29 | 数据标签 |
| `text-cyan-300` | `#67e8f9` | 29 | 数据标签（亮） |
| `text-indigo-400` | `#818cf8` | 18 | 结构标签 |
| `text-amber-400` | `#fbbf24` | 14 | 热度/预算 |
| `text-slate-200` | `#e2e8f0` | 13 | 强调正文 |

### 2.4 透明边与浮层（Alpha 阶梯）

代码里高度规律的一组透明度，不是随手写的——**可提炼为设计规则**：

| 用途 | 透明度档 | 出现次数 |
| :--- | :--- | ---: |
| 浮层/玻璃面板填充 | `/90`、`/95` | 42 + 3 |
| 边框 / 底色 / 强调底 | `/20`、`/30`、`/40` | 28 + 37 + 21 |
| 分隔线 / 遮罩渐变 | `/60`、`/70`、`/80` | 14 + 2 + 5 |
| 轻量标记底 | `/15`、`/25` | 5 + 1 |

**规则**：`bg-*` 走 `/90`~`/95`（几乎不透明，靠模糊而非透明度做层次）；`border-*` 与 `bg-*` 的强调块走 `/20`~`/40`。这个「90+ / 20-40」双峰分布是本设计体系最值得继承的特征。

### 2.5 WCAG 对比度实测

计算方式：WCAG 2.1 相对亮度公式，前景色对四种候选底色取最差值。

| 前景 | on `#050814` | on `#0B1021` | on `#0f172a` | 判定 |
| :--- | ---: | ---: | ---: | :--- |
| `#ffffff` white | 19.98 | 18.91 | 17.85 | AAA |
| `#cbd5e1` slate-300 | 13.45 | 12.74 | 12.02 | AAA |
| `#22d3ee` cyan-400 | 11.05 | 10.47 | 9.88 | AAA |
| `#34d399` emerald-400 | 10.39 | 9.84 | 9.29 | AAA |
| `#f59e0b` amber-500 | 9.30 | 8.81 | 8.31 | AAA |
| `#06b6d4` cyan-500 | 8.23 | 7.79 | 7.35 | AAA |
| `#10b981` emerald-500 | 7.87 | 7.46 | 7.04 | AAA |
| `#94a3b8` slate-400 | 7.79 | 7.38 | 6.96 | AAA / AA |
| `#f43f5e` rose-500 | 5.44 | 5.15 | 4.86 | **AA（仅正文级）** |
| `#8b5cf6` violet-500 | 4.72 | 4.47 | 4.22 | **AA-large only** |
| `#6366f1` indigo-500 | 4.47 | 4.23 | 4.00 | **AA-large only** |
| `#64748b` slate-500 | 4.20 | 3.97 | 3.75 | **AA-large only** |

**结论**：
- 深底色方案在对比度上**几乎全绿**，这是本视觉体系最扎实的部分。
- 但有 4 个颜色不达 4.5:1 正文标准：`slate-500`、`indigo-500`、`violet-500`、`rose-500`。其中 `slate-500` 被用作图标与占位文字（尚可），`indigo-500`/`violet-500` 已被用作小号文字（**需降级为 `indigo-400`/`violet-300` 或只用于 ≥18px**）。
- 由于 136 处字号 < 12px（见 §4.1），这些颜色实际处于「小字号 + 低对比」的双重不达标区间。

### 2.6 SVG 蓝图 / Canvas 专用色板

内联 SVG 与 `drawCurveLab()` 用的是**硬编码 hex**，独立于 Tailwind 体系，必须单独固化：

| 用途 | 值 | 出现次数 |
| :--- | :--- | ---: |
| SVG 面板底（深） | `#090d1c` | 20 |
| SVG 面板底（中） | `#0f172a` | 9 |
| SVG 仪器面板底 | `#091526` | 1 |
| SVG 声呐盘底 | `#04121a` | 1 |
| SVG 危险面板底 | `#1f0d1d` | 1 |
| SVG 网格线 | `#1e293b` / `#334155` / `#475569` | 9 / 13 / 3 |
| SVG 主文字 | `#cbd5e1` / `#f8fafc` / `#94a3b8` | 11 / 5 / 11 |
| Canvas 背景 | `#040814` | 1 |
| Canvas 网格 | `rgba(30, 41, 59, 0.75)` | 1 |
| Canvas 坐标轴 | `#475569` | 1 |
| Canvas 置信带 | `rgba(6, 182, 212, 0.14)` | 1 |
| Canvas 拟合曲线 | `#22d3ee` | 1 |
| Canvas 散点 | `#f59e0b` | 1 |
| Canvas 轴标签 | `#94a3b8` | 1 |

---

## 三、字体与排版

### 3.1 字体栈

```css
/* 来自 <style> L31-40，逐字照抄 */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.font-mono {
  font-family: 'JetBrains Mono', monospace;
}
```

| 项 | 值 | 备注 |
| :--- | :--- | :--- |
| UI 字体 | `Inter` 300/400/500/600/700/800 | Google Fonts CDN |
| 等宽字体 | `JetBrains Mono` 400/500/600/700 | Google Fonts CDN |
| `font-mono` 使用次数 | **134** | 强约定：所有数字、坐标、DOI、域名、代码片段 |
| CJK 字体 | **无声明** | `PingFang` / `Microsoft YaHei` / `Noto Sans SC` 全部 0 处 |

> 🔴 **无中文回退字体**。本产品是纯中文界面（正文全中文），但字体栈只声明了西文。当前在 Windows 上靠浏览器 `sans-serif` 兜底到微软雅黑，字重与行高与 Inter 不匹配——同一段落里中英文基线会轻微错位。Stage 1 必须补：`'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC'` 插在 Inter 之后、`sans-serif` 之前。
>
> 另外 **Google Fonts CDN 在国内高校网络环境下不可达**是大概率事件（这也是 PAT-HOT/ScholarMatrix 用 `pages.dev` 而非国内域名同一类问题）。`instrument-ui` 应改为自托管 woff2 子集，至少保证 Inter 400/500/600 与 JetBrains Mono 400/500。

### 3.2 字号阶梯（实测使用分布）

| 实际字号 | 对应类 | 次数 | 排序 |
| :--- | :--- | ---: | ---: |
| 12px | `text-xs` | 85 | 1 |
| **10px** | `text-[10px]` | 76 | 2 |
| **11px** | `text-[11px]` | 57 | 3 |
| 14px | `text-sm` | 28 | 4 |
| 16px | `text-base` | 7 | 5 |
| 18px | `text-lg` | 5 | 6 |
| 20px | `text-xl` | 5 | 6 |
| 24px | `text-2xl` | 2 | 8 |
| **9px** | `text-[9px]` | 3 | 9 |
| 30px | `text-3xl` | 1 | 10 |

**分布特征**：`< 12px` 共 **136 处**，`≥ 18px` 只有 **13 处**，比值 **10.5 : 1**。

> ⚠️ **这不是排版，这是密度策略。** 整套 UI 把信息密度推到极限（10px 中文约等于 1.4mm 字高）。在 27" 1080p 上勉强可读，在 13" 笔记本或投屏答辩现场会明显吃力。
>
> 对大创答辩是实际问题：`bundle` 自述"直接面向前端开发与大创答辩评委"（L298），但答辩通常用投影 + 后排观看，10px 中文投影后基本不可辨。**建议 Stage 2 引入 `--text-density` 档位，答辩模式整体放大 1.25×。**

### 3.3 内联 SVG 字号

6 幅蓝图 SVG 统一 `viewBox="0 0 340 165"`，`class="w-full h-40"`（高度锁 160px）：

| `font-size` 属性值 | 次数 |
| :--- | ---: |
| 7.5 | 26 |
| 8 | 21 |
| 7 | 13 |
| 8.5 | 12 |
| 11 | 3 |
| 6.8 | 2 |
| 13 | 1 |

在 `lg:grid-cols-3`（`max-w-7xl` = 1280px，卡片宽约 380px）下，SVG 实际渲染宽度 ≈ 348px，缩放比 ≈ 1.02——**即 SVG 内文字实际只有 7–8.7px**。

> ⚠️ 蓝图里的中文标注（如"论文 / DOI"、"钝化配体"、"峰值 EQE"）在 340×165 里塞了 16 个 `<text>`（图纸 01）。这些**不可能在小尺寸下可读**，本质是"给静态图看的示意图"而非可读 UI。`instrument-ui` 复刻时不要照搬 SVG 视口尺寸，应按 CSS 像素 1:1 重画（视口至少 680×330 @2x）。

---

## 四、形状 / 圆角 / 阴影

### 4.1 圆角

| 类 | 值 | 次数 |
| :--- | ---: | ---: |
| `rounded-xl` | 12px | 59 |
| `rounded-lg` | 8px | 40 |
| `rounded` | 4px | 36 |
| `rounded-2xl` | 16px | 29 |
| `rounded-full` | 9999px | 19 |
| `rounded-3xl` | 24px | 1 |
| `rounded-[46px]` | 46px | 1（手机外框） |
| `rounded-[36px]` | 36px | 1（手机内屏） |

**规则**：8px 与 12px 合计 99 处 = **52%**，是本体系的基础圆角。16px 用于容器级卡片，4px 用于 SVG 内部块。

### 4.2 阴影与辉光（视觉签名核心）

```css
/* .glow-* 四个色 —— 唯一的"品牌辉光"配方 */
.glow-indigo  { box-shadow: 0 0 28px -5px rgba(99, 102, 241, 0.45); }  /* 3 处 */
.glow-cyan    { box-shadow: 0 0 28px -5px rgba(6,  182, 212, 0.45); }  /* 4 处 */
.glow-emerald { box-shadow: 0 0 28px -5px rgba(16, 185, 129, 0.45); }  /* 2 处 */
.glow-amber   { box-shadow: 0 0 28px -5px rgba(245, 158, 11, 0.45); }  /* 2 处 */
```

**配方**：`blur 28px` + `spread -5px` + `alpha 0.45`。三参数固定，只有色相变化——这是可直接参数化的 token：

```css
--glow-spread: 0 0 28px -5px;
--glow-alpha: 0.45;
/* 用法 */ box-shadow: var(--glow-spread) rgb(var(--accent-rgb) / var(--glow-alpha));
```

Tailwind 原生阴影使用：`shadow-lg` 9、`shadow-2xl` 4、`shadow-xl` 1、`shadow-md` 1、`shadow-sm` 1。另有 5 处带色投影：`shadow-cyan-500/25`、`shadow-indigo-500/30`、`shadow-indigo-600/30`、`shadow-cyan-500/20`、`shadow-violet-600/30`、`shadow-rose-600/30`。

---

## 五、两个可复用的样式配方（照抄即可用）

### 5.1 `.glass-panel` —— 玻璃拟态容器

```css
.glass-panel {
  background: rgba(13, 20, 38, 0.78);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(99, 102, 241, 0.22);  /* indigo / 22% */
}
```

使用 7 处，全部是 Tab 顶部的"大块介绍区/标题区"。

### 5.2 `.instrument-bezel` —— 仪器面板（本设计的核心资产）

```css
.instrument-bezel {
  background: linear-gradient(145deg, #0b1124 0%, #070b18 100%);
  border: 1px solid rgba(56, 189, 248, 0.25);   /* sky-400 / 25% */
  box-shadow:
    inset 0 1px 0 0 rgba(255, 255, 255, 0.08),  /* 顶部 1px 高光 = 金属倒角 */
    0 10px 30px -10px rgba(6, 182, 212, 0.25);  /* 青色外发光 = 屏幕辉光 */
}
```

**这是全库最能定义"数字精密科研仪器"观感的一条 CSS**，使用 **16 处**，是出现频次最高的自定义类。三个细节拆解：

1. `145deg` 对角渐变 → 模拟金属受光面
2. `inset 0 1px 0 rgba(255,255,255,.08)` → 1px 顶部高光，制造"倒角/折边"
3. 外发光用 **cyan 而非中性黑** → 面板像"在发光"，而非"被照亮"

`instrument-ui` 的面板组件应把这三条做成 default variant，并派生出 `--bezel-accent` 让外发光跟随微站主色。

### 5.3 `.custom-scrollbar` —— 6px 细滚动条

```css
.custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scrollbar::-webkit-scrollbar-track { background: rgba(5, 8, 20, 0.8); }
.custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(99, 102, 241, 0.45); border-radius: 4px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(6, 182, 212, 0.8); }
```

使用 7 处。**仅 `-webkit-` 前缀，无 Firefox `scrollbar-width`/`scrollbar-color`** —— Firefox 下会退化成系统默认宽滚动条，在密集面板里会破坏布局。

---

## 六、动效

### 6.1 唯一自定义 keyframes

```css
@keyframes pulseSoft {
  0%, 100% { opacity: 0.65; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.04); }
}
.pulse-orb { animation: pulseSoft 2.8s ease-in-out infinite; }
```

使用 3 处：Tab2 底部的 Global Copilot 呼吸球（L871）、虫洞环中心按钮（L1389）、`.pulse-orb` 类定义本身。

### 6.2 Tailwind 原生动画

| 类 | 次数 | 位置 |
| :--- | ---: | :--- |
| `animate-pulse` | 2 | 头部状态点、MatrixOS Live 指示点 |
| `animate-ping` | 1 | INSTRUMENT #08 活动指示点 |
| `animate-bounce` / `animate-spin` | 0 | — |

### 6.3 过渡

| 模式 | 次数 / 位置 |
| :--- | :--- |
| `transition-all` | 25 |
| `transition-transform` | 4 |
| Toast 进出 | `translate-y-20 opacity-0` → `translate-y-0 opacity-100`，`duration-300`，`setTimeout 3200ms` 自动收起（`showToast`, L1455–1465） |
| 渲染图卡 hover | `group-hover:scale-105 transition-transform duration-500`（4 张图） |

### 6.4 动效缺失项

| 项 | 状态 | 影响 |
| :--- | :--- | :--- |
| `prefers-reduced-motion` | **0 处** | 无障碍缺失；`pulse-orb` 是无限循环动画，对前庭敏感用户不友好 |
| Semantic Zoom 缩放动画 | **未实现** | 文案承诺 `1.0x → 10.0x` 无级变焦（L59、L283），代码里 0 处 wheel/scroll 监听 |
| 虫洞环张开动画 | **未实现** | 完整交互见 `03-gap-analysis.md` §3.2 |
| 页面/Tab 切换过渡 | **无** | `switchMainTab` 直接 `classList.toggle("hidden")` 硬切 |
| 星轨旋转/粒子 | **无** | Tab2 的星轨是静态 SVG，无 `requestAnimationFrame`（全库 0 处） |

---

## 七、布局与网格

### 7.1 主容器

| 项 | 值 |
| :--- | :--- |
| 最大宽 | `max-w-7xl` = 1280px |
| 内边距 | `p-4 sm:p-6`（Tab 内容）/ `px-4 sm:px-6`（头部） |
| Tab 间距 | `space-y-8`（Tab1）/ `space-y-6`~`space-y-5`（其余） |
| 固定头部 | `sticky top-0 z-50`，`bg-slate-950/90` + `backdrop-blur-md` |

### 7.2 关键分栏比例

| 区域 | 代码 | 实际比例 | 文案声称 |
| :--- | :--- | ---: | :--- |
| Tab2 总控台 | `lg:grid-cols-12`，左 `lg:col-span-4` / 右 `lg:col-span-8` | **33.33% / 66.67%** | **32% / 68%**（L625、L1273 等多处文案） |
| Tab4 SDK 模拟器 | `lg:grid-cols-12`，`col-span-6` / `col-span-6` | 50% / 50% | — |
| Tab4 预算表+仿真器 | `lg:grid-cols-12`，`col-span-7` / `col-span-5` | 58.3% / 41.7% | — |
| Tab5 小程序 | `lg:grid-cols-12`，`col-span-5` / `col-span-7` | 41.7% / 58.3% | — |

> ⚠️ **32%/68% 是文案，33.33%/66.67% 是代码。** 差 1.33 个百分点。0.32 × 1280 = 409.6px，而 `col-span-4` 扣掉 gutter 后实际约 413px。影响可忽略，但**文档与实现对不上**这件事本身要在 ADR 里定口径（建议以 `4/12` 为准，把文案统一改成「左 1/3」）。

Tab2 容器另有 `style="min-height: 680px;"`。

### 7.3 栅格规则

| 区域 | 网格 | 断点行为 |
| :--- | :--- | :--- |
| 4 张渲染图 | `grid-cols-1 lg:grid-cols-2` | 大屏 2×2 |
| 6 幅 SVG 蓝图 | `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` | 大屏 3×2 |
| 18 微站卡片 | `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` | 大屏 3 列 |
| 模型四级 | `grid-cols-1 md:grid-cols-4` | 大屏 4 列 |
| Tab2 仪器组 | `grid-cols-1 md:grid-cols-2` | 大屏 2 列 |

### 7.4 响应式断点使用量

| 断点 | 次数 |
| :--- | ---: |
| `sm:` | 21 |
| `md:` | 8 |
| `lg:` | 17 |
| `xl:` | 0 |
| `2xl:` | 0 |

**三档断点、无 `xl`/`2xl`** —— 意味着 1920px 以上不再扩张，内容宽度锁死在 1280px。对于"桌面 WebOS 重型攻坚端"的定位，**没有利用大屏空间**（例如 1440p/4K 上左右分栏本可容纳 4 台仪器而非 2~3 台）。

---

## 八、图标与装饰

| 项 | 值 |
| :--- | :--- |
| 图标库 | Font Awesome 6.5.1（CDN `cdnjs.cloudflare.com`） |
| 用法 | `fa-solid` 为主，`fa-brands fa-weixin` 用于微信 |
| 图标总数 | 见于全库 `<i class="fa-...">` |
| Emoji | 30 个字形 / 11 种：`✓`(10)、`📋`(5)、`🔥`(4)、`⚡`(4)、`★`、`⚠`、`🔔`、`💻`、`📦`、`🪐`、`📱` |

> ⚠️ **图标双轨制**：同一按钮体系里混用 Font Awesome 图标与 Emoji（`📋 复制 Stage 1 指令`、`⚡ 推入电脑端`）。Emoji 跨平台渲染不一致（Windows 用 Segoe UI Emoji、macOS 用 Apple Color Emoji），且无法跟随文字色。`instrument-ui` 应统一为 SVG 图标组件。

依赖 CDN 的清单（**离线环境下会全部失效**）：

| 资源 | URL |
| :--- | :--- |
| Tailwind | `https://cdn.tailwindcss.com/3.4.17` |
| Font Awesome | `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css` |
| Google Fonts | `https://fonts.googleapis.com/css2?family=Inter...&family=JetBrains+Mono...` |

---

## 九、可直接落地的 Token 定义

以下为建议的 `packages/instrument-ui/tokens.css`，**值全部来自上文的实测**（非发明）。标注 `[推导]` 的条目是在实测基础上的命名/结构化建议。

```css
:root {
  /* ---------- Surface ---------- */
  --color-bg:              #050814;            /* obsidian */
  --color-bg-panel:        #0b1124;            /* instrument-bezel 起 */
  --color-bg-panel-end:    #070b18;            /* instrument-bezel 止 */
  --color-bg-sunken:       #020617;            /* slate-950 */
  --color-bg-raised:       #0f172a;            /* slate-900 */
  --color-glass:           rgba(13, 20, 38, 0.78);

  /* ---------- Border ---------- */
  --color-border:          #1e293b;            /* slate-800，主力 */
  --color-border-strong:   #334155;            /* slate-700 */
  --color-border-accent:   rgba(99, 102, 241, 0.22);

  /* ---------- Text ---------- */
  --color-text:            #f1f5f9;            /* slate-100 */
  --color-text-strong:     #ffffff;
  --color-text-secondary:  #cbd5e1;            /* slate-300 */
  --color-text-muted:      #94a3b8;            /* slate-400，主力说明文字 */
  --color-text-faint:      #64748b;            /* slate-500，仅图标/占位 */

  /* ---------- Accent（六色，取自 Tailwind 500 档） ---------- */
  --color-action:          #6366f1;   /* indigo  —— 主 CTA    */
  --color-action-hover:    #4f46e5;   /* indigo-600           */
  --color-instrument:      #06b6d4;   /* cyan    —— 仪器/数据 */
  --color-instrument-bright: #22d3ee; /* cyan-400            */
  --color-positive:        #10b981;   /* emerald —— 正向/合规 */
  --color-positive-bright: #34d399;   /* emerald-400          */
  --color-warning:         #f59e0b;   /* amber   —— 热度/预算 */
  --color-danger:          #f43f5e;   /* rose    —— 风险/超限 */
  --color-ecosystem:       #8b5cf6;   /* violet  —— SDK/生态  */

  /* ---------- Glow ---------- */
  --glow-spread: 0 0 28px -5px;
  --glow-alpha:  0.45;

  /* ---------- Radius ---------- */
  --radius-xs: 4px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --radius-pill: 9999px;

  /* ---------- Typography ---------- */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI',
               'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif; /* [推导] 补 CJK */
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  --text-2xs: 10px;   /* 实测最高频，慎用 */
  --text-xs:  12px;
  --text-sm:  14px;
  --text-base:16px;
  --text-lg:  18px;
  --text-xl:  20px;
  --text-2xl: 24px;

  /* ---------- Motion ---------- */
  --dur-fast:   150ms;
  --dur-base:   300ms;
  --dur-slow:   500ms;
  --ease-base:  ease-in-out;
  --pulse-duration: 2.8s;
}

@media (prefers-reduced-motion: reduce) {   /* [推导] 原设计缺失 */
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 十、必须修正的问题（转交 Stage 1）

| # | 问题 | 证据 | 建议处置 |
| :-- | :--- | :--- | :--- |
| V1 | `panel` token 死代码 | `colors.panel` 定义 1 次，`bg-panel` 使用 0 次 | 删或接线 |
| V2 | `brand.*` 六色整体死代码 | 全部 0 次 `brand-*` 引用；值恰等于 Tailwind 默认 500 档 | 不建 `brand-*` 命名空间 |
| V3 | 无 CJK 字体回退 | `PingFang`/`Microsoft YaHei`/`Noto Sans SC` 均 0 处 | 补字体栈（见 §9） |
| V4 | 无 `prefers-reduced-motion` | 0 处，但存在无限循环 `pulse-orb` | 补媒体查询 |
| V5 | 可访问性基线全缺 | `aria-*` 0、`role=` 0、`tabindex` 0、`<label for>` 0 | 组件库强制带 |
| V6 | 4 个颜色不达正文对比度 | `slate-500` 4.20、`indigo-500` 4.47、`violet-500` 4.72、`rose-500` 5.44 | 小字号场景换 400/300 档 |
| V7 | `rose`（危险语义）仅 9 处 | vs cyan 113 / emerald 94 | 重分配风险态视觉权重 |
| V8 | 136 处字号 < 12px | 10.5:1 于 ≥18px | 引入 density 档位；答辩模式放大 |
| V9 | Emoji 与 FA 图标混用 | 11 种 emoji 共 30 处 | 统一为 SVG 图标 |
| V10 | 三处 CDN 强依赖 | tailwindcdn / cdnjs / Google Fonts | 自托管；至少字体必须自托管 |
| V11 | 仅 `-webkit-` 滚动条样式 | 无 `scrollbar-width`/`scrollbar-color` | 补 Firefox 属性 |
| V12 | 32%/68% 文案与 4/12 代码不符 | L625 vs L619 | 统一口径 |
| V13 | 无 `xl`/`2xl` 断点 | 各 0 次 | 大屏 4 仪器布局留白浪费 |
| V14 | SVG 蓝图字号 6.8–8.5，视口 340×165 | §3.3 | 重画为 CSS 像素 1:1 |

---

## 附：本文件的数据可复现方式

均可用 grep/正则对 `bundle/MatrixOS_v3_完整交互规范与UI图谱_高清版.html` 复算：

| 指标 | 复算方式 |
| :--- | :--- |
| token 定义 | 读 L10–29（`tailwind.config`）与 L30–62（`<style>`） |
| class 频次 | 提取所有 `class="..."` 后按空格切词计数 |
| 死 token 判定 | 对 `bg-panel` / `bg-brand-indigo` 等模式串做全库匹配，计数为 0 |
| 对比度 | WCAG 2.1 相对亮度公式，对 `#050814` / `#0B1021` / `#0f172a` / `#020617` 取最差值 |
| SVG 字号 | `font-size="..."` 属性分布 |
| 断点使用 | 统计带 `sm:`/`md:`/`lg:` 前缀的 class token 数 |
