# @matrixos/instrument-ui

MatrixOS 数字精密科研仪器组件库 —— **旋钮族 / 图表族 / 雷达族 / 天平族**。

React 19 + Tailwind CSS 4 + Vite library mode。视觉语言对齐
`docs/00-analysis/04-visual-system.md`，仅提供受控展示组件（ADR-07：props in / events out）。

---

## 组件清单（10 个）

| 族 | 组件 | 一句话 |
| :--- | :--- | :--- |
| 旋钮族 | `DampedKnob` | 精密阻尼旋钮：拖动连续调节、金属倒角、方向键微调、双击输入精确值 |
| 图表族 | `OscilloscopeCanvas` | 荧光示波器：Canvas 渲染、降采样、线性拟合 + 置信带 |
| 雷达族 | `SonarDisc` | 360° 极坐标声呐盘：CSS 扫描扇区 + 红/黄/绿三级风险（颜色 + 形状双通道） |
| 雷达族 | `StarOrbit` | 2.5D 星轨引力场：语义缩放 1.0x → 10.0x 全由 CSS `calc()` 派生 |
| 雷达族 | `WormholeRing` | 跨站虫洞环：环张合走 CSS scale/opacity，校验失败整环转 rose |
| 天平族 | `PrecisionBalance` | 精密三盘电子天平：砝码堆叠、总分缓动、盘体浮沉纯 CSS |
| 天平族 | `FluidGaugeBank` | 多柱流体液位压差计：红线是一等公民，越线阻断 + `aria-live` 断言 |
| 其他 | `EvidenceLink` | 证据锚点徽章：三档校验等级 + bbox 悬停预览 + 无锚点时诚实降级 |
| 其他 | `CopilotWaveDock` | Copilot 波形坞：四种状态（idle/listening/thinking/speaking） |
| 其他 | `TaskKanban` | 航天任务控制看板：受控拖拽，是否真移动由调用方裁决 |

全部组件、类型、设计令牌工具均从 `src/index.ts` 统一导出。

---

## 安装与使用

本包是 workspace 私有包，源码直出（`exports['.'] → ./src/index.ts`），
下游用 `transpilePackages` 消费即可，**不需要先 build**。

```tsx
// 1. 样式只需在应用入口 import 一次（顺序有意义：tokens → base → 组件）
import '@matrixos/instrument-ui/styles.css';

// 2. 按需引入组件
import { DampedKnob, EvidenceLink, FluidGaugeBank } from '@matrixos/instrument-ui';
import { useState } from 'react';

export function FitPanel() {
  const [tau, setTau] = useState(1.24);

  return (
    <DampedKnob
      label="τ₁"
      unit="ns"
      value={tau}
      min={0}
      max={5}
      step={0.01}
      accent="cyan"
      hint="荧光衰减时间常数"
      onChange={setTau}                       // 拖动中高频触发
      onCommit={(v) => refit(v)}              // 松手才触发昂贵重算
      data-testid="knob-tau"
    />
  );
}
```

### 本地跑 demo

```bash
pnpm --filter @matrixos/instrument-ui dev     # http://localhost:3060
```

demo 直接消费 `src/index.ts`（源码直出），改组件 HMR 立即生效，不依赖先 build。
页面里 10 个组件全部可见，另有一块 **WCAG AA 对比度守卫面板**实时显示 13 个文字令牌对
五种表面的最差比值。

---

## 设计约束（改代码前必读）

### 1. 动效一律 CSS，不写 JS 逐帧

状态变化通过 **CSS 变量 + `transform` / `opacity`** 表达，React 只负责把数值写成
内联自定义属性（如 `--iu-total-fill: 62%`）。禁止在组件里用 `requestAnimationFrame`
驱动常驻动画。

有界的一次性缓动是**允许**的例外（`PrecisionBalance` 的总分推进，480ms 后自行停止），
但必须：① 有明确终止条件；② `prefers-reduced-motion` 下直接跳到终值。

### 2. `will-change` 只在动画期间挂载

常态挂 `will-change` 会让每个实例永久占用一个合成层。正确做法是用状态属性选择器：

```css
.iu-knob__needle        { will-change: auto; transition: transform 220ms; }
.iu-knob__dial[data-iu-dragging='true'] .iu-knob__needle { will-change: transform; transition: none; }
```

### 3. WCAG AA 是硬门槛（正文 ≥ 4.5:1）

`--iu-text-faint` 曾长期是 `#64748b`（对最差表面 **3.75:1**），且被 18 处当作 8–9px
正文使用——文档里标了「禁止正文」，但没有任何可执行约束，于是回归隐形。现为
**`#7d8ba1`（5.17:1）**。

> **新增任何文字色时**，必须同步登记到 `demo/App.tsx` 的 `TEXT_TOKENS` 清单，
> 否则守卫面板不会验它。清单外的颜色 = 没有守卫的颜色。

四处定义必须**同步修改**，否则用 Tailwind 类名的页面会绕过修正：

| 文件 | 令牌 |
| :--- | :--- |
| `src/tokens.css` | `--iu-text-faint` |
| `src/theme.tailwind4.css` | `--color-ink-faint` |
| `tailwind.preset.js` | `colors.ink.faint` |
| `tailwind.preset.cjs` | `colors.ink.faint` |

> ⚠️ 改 `src/styles/base.css` 的注释时注意：注释里出现 `aria-` + `*` + `/` 会**提前终止
> CSS 块注释**，导致后续规则被吞、next build 挂掉。不要在注释里写 `aria-*/` 这种组合。

### 4. `prefers-reduced-motion` 必须覆盖

每个组件的样式表都有显式的 `@media (prefers-reduced-motion: reduce)` 块，
`tokens.css` 另有全局兜底（把 `--iu-dur-*` 压到 `0.01ms`）。
新增动画时两处都要顾及：全局兜底只处理走令牌的时长，硬编码时长需自行关闭。

### 5. 颜色只用令牌

组件样式里不写死色值，一律 `var(--iu-*)` 或 `rgb(var(--iu-*-rgb) / α)`。
这样 `data-iu-density="presentation"`、`forced-colors: active`、以及未来的主题切换才能生效。

---

## 无障碍要点

- **颜色不是唯一通道**：声呐风险点用「颜色 + 形状（圆/三角/菱形）」双编码；
  证据等级用「颜色 + 字母标记（A / B / !）」，满足 WCAG 1.4.1。
- **数值控件走 `role="slider"`**：`DampedKnob` 暴露 `aria-valuemin/max/now/valuetext`，
  键盘支持 `↑↓`（±step）、`Shift+↑↓` 与 `PageUp/Down`（±10×step）、`Home/End`（极值）。
- **图表有等价表格**：`SonarDisc` / `PrecisionBalance` 内置 `<table class="iu-sr-only">`，
  屏幕阅读器可以读到与图形等价的数据。
- **动态状态有断言**：`FluidGaugeBank` 的阻断横幅是 `role="alert"` + `aria-live`。

---

## 目录结构

```
src/
  index.ts                 统一导出（唯一对外入口）
  tokens.css               设计令牌（颜色/字号/间距/动效/层级）
  tokens.compat.css        旧命名兼容层
  theme.tailwind4.css      Tailwind 4 @theme 映射
  styles.css               样式总入口（tokens → base → 各组件）
  styles/
    base.css               原子类与 shell（.iu-root / .iu-label / .iu-readout / .iu-focus）
    components/*.css       每个组件一个文件，含各自的 reduced-motion 块
  components/*.tsx         10 个组件
  lib/
    accent.ts              六色强调色与 tone 映射
    contrast.ts            WCAG 2.1 对比度计算（demo 守卫面板的数据源）
    hooks.ts               usePrefersReducedMotion / useElementSize / useUid ...
    math.ts                插值、刻度、极坐标、降采样
    stats.ts               线性拟合、置信区间、t 分位（数值已验证，勿轻改）
    useDialDrag.ts         旋钮拖拽交互（垂直位移 + 角度累积）
demo/                      演示站（端口 3060）
```

---

## 验证

```bash
npx turbo run typecheck --filter=@matrixos/instrument-ui
npx turbo run build     --filter=@matrixos/instrument-ui
```

`build` 产物在 `dist/`：`matrixos-instrument-ui.mjs` + `instrument-ui.css` + `*.d.ts`。
构建产物用于发布私有包、类型快照与视觉回归基线；**日常工作流不需要 build**。
