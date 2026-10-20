# 四大原型线上现状核实

> 核实日期：2026-10-20 · 核实人：Tech Lead
> 方法：`Invoke-WebRequest` 实测 HTTP 状态与响应内容，抓取 HTML 判定技术栈

---

## 结论摘要

**四个原型全部可访问（HTTP 200），但至少涉及三种技术栈，解耦不能按统一方案推进。**

| 原型 | 可用性 | 框架 | 构建 | 托管 |
| :--- | :--- | :--- | :--- | :--- |
| ScholarMatrix | ✅ 200 | React | Vite | Cloudflare Pages |
| 星门 Xingmen | ✅ 200 | Vue | Vite | Cloudflare Pages |
| PAT-HOT | ✅ 200 | React | — | Cloudflare |
| 预职 PreJob | ✅ 200 | **Vue 3 (CDN)** | **无构建** | WorkBuddy Host |

---

## 详细实测

### 1. ScholarMatrix

| 项 | 值 |
| :--- | :--- |
| 地址 | `https://scholarmatrix.pages.dev/land/` |
| 镜像 | `https://scholarmatrix.cc.cd`（4136 B，疑似跳转页） |
| 状态 | 200 |
| 标题 | 学术星轨 ScholarMatrix · 一站式 AI 科研工作台｜网页版与桌面版下载 |
| 响应体 | 319,879 B |
| 框架线索 | React + Vite + Cloudflare |
| 脚本 | `./boot.js`、`./main.js` |

**注意**：标题提到「桌面版下载」，说明存在桌面端产物。需确认桌面版与网页版是否同一代码库——若不同，42 工具可能分散在两个代码库。

### 2. 星门 Xingmen

| 项 | 值 |
| :--- | :--- |
| 地址 | `https://xingmen-mentor.pages.dev/` |
| 状态 | 200 |
| 标题 | 星门 · 找导师，进组第一扇门 |
| 响应体 | **1,753 B（SPA 壳）** |
| 框架线索 | Vue + Vite |
| 脚本 | `/theme.js`、`/assets/index-nxWmJubH.js` |

**注意**：1,753 B 说明这是纯 SPA 壳，业务逻辑全在 hash 命名的 JS bundle 里。需抓取该 bundle 才能评估真实复杂度。

### 3. PAT-HOT

| 项 | 值 |
| :--- | :--- |
| 地址 | `https://pat-hot.pages.dev` |
| 状态 | 200 |
| 标题 | PAT-HOT · 物理·天文·光电热点 |
| 响应体 | 2,440,447 B（2.3 MB） |
| 框架线索 | React + Cloudflare |
| 脚本 | 无外链 `<script src>`（内联或动态加载） |

**注意**：2.3 MB 单页响应异常大，可能内联了数据或依赖。需确认是否有独立后端。

### 4. 预职 PreJob

| 项 | 值 |
| :--- | :--- |
| 地址 | `https://a9b81a7031ed59d7a.app.workbuddy.host/` |
| 状态 | 200 |
| 标题 | PreJob(求职版） |
| 响应体 | **903 B** |
| 框架线索 | Vue 3 全局构建（CDN） |
| 脚本 | `/assets/vue.global.prod.js`、`unpkg.com/lucide@0.469.0`、`/assets/app.js` |

**关键发现**：这是**裸 Vue CDN 单文件应用**——没有构建工具、没有模块打包、依赖 unpkg CDN。

含义：

| 影响 | 说明 |
| :--- | :--- |
| ✅ 解耦成本低 | `app.js` 里就是全部业务逻辑，没有复杂依赖图 |
| ⚠️ 无法直接复用 | 无组件化结构，重写为 Next.js 组件而非迁移 |
| ⚠️ CDN 依赖风险 | unpkg 在国内不稳定，必须本地化 |

---

## 对 WBS 的影响

| 任务 | 原假设 | 实测后调整 |
| :--- | :--- | :--- |
| `S1-07e` 42 工具耦合度扫描 | 假设同一代码库 | 工具散落在 **3 种技术栈、4 个站点**，扫描范围需覆盖全部 |
| `S1-13` 历史数据迁移 | 假设可统一迁移 | 需为 Vue / React 分别写适配器 |
| `S1-14` 20 个工具解耦 | — | 工作量与工具所在技术栈强相关，React 系成本低于 Vue-CDN 系 |
| `S1-16` 首批 6 微站 | — | 预职相关站（17/18）可从 `app.js` 直接移植逻辑，成本低于预期 |

**结论**：864 pd 总量不变，但内部配比需调整——React 系（ScholarMatrix / PAT-HOT）解耦成本低于预期，Vue-CDN 系（预职）需要重写而非迁移。

---

## 仍未确认

- [ ] ScholarMatrix「桌面版」与网页版是否同一代码库
- [ ] 各站是否有后端 API（还是纯前端 + 本地存储）
- [ ] 星门的 `index-nxWmJubH.js` 业务复杂度
- [ ] 预职 `app.js` 的实际代码量
- [ ] 四个项目的源码仓库归属（GitHub `meat-daemon-404` 下有 `scholarmatrix` / `xingmen-mentor` / `pat-hot`，但**预职未找到对应仓库**）

---

## 复现方式

```powershell
foreach ($u in @(
  "https://scholarmatrix.pages.dev/land/",
  "https://xingmen-mentor.pages.dev/",
  "https://pat-hot.pages.dev",
  "https://a9b81a7031ed59d7a.app.workbuddy.host/"
)) {
  $r = Invoke-WebRequest -Uri $u -TimeoutSec 15 -UseBasicParsing
  Write-Output ("{0} => {1} ({2} B)" -f $u, $r.StatusCode, $r.RawContentLength)
}
```

---

## 相关

- [03-gap-analysis.md](../00-analysis/03-gap-analysis.md) — 差距分析
- [03-work-breakdown.md](../01-plan/03-work-breakdown.md) — 任务分解
- [01-architecture.md](../01-plan/01-architecture.md) — 目标架构
- GitHub Issue #25 — 原型核实跟踪
