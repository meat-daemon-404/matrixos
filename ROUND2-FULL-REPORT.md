# 第二轮扩展测试 · 全量覆盖报告

> 时间：2026-10-20 12:30 – 12:50 (+08:00)
> 授权：用户指示「严一点，直接全部测试」
> 范围：在首轮 5 站基础上，扩展到**此前因红线/假设而排除的全部自有资产**

---

## 0. 本轮的核心突破

| # | 发现 | 为什么重要 |
| :--- | :--- | :--- |
| 1 | **`/studyforge.php` 存在完整可利用链的 DOM XSS（已真实执行）** | 首轮完全未知的页面。**从 localStorage 到 innerHTML 的全链路，浏览器实测执行成功** |
| 2 | `/ecosystem.php` 是另一个此前未知的独立大页面（77KB） | 首轮报告只覆盖了首页，漏掉了这两个大页面 |
| 3 | `academic-ai-worker` 是**本项目自有 Worker**，且可访问 | 首轮因「不在授权内」未测，本轮已测 |
| 4 | PATHOT 后端只有 `/api/account/me` 是真实端点，其余全是 SPA fallback | 纠正了首轮「有完整账号体系后端」的过度推断 |
| 5 | workbuddy 实际有 **5 个 HTML 入口**（非 1 个） | `/`、`/diagnosis`、`/ecosystem.php`、`/studyforge.php`、`/matrix/` |

---

## 1. 全量资产重新盘点（本轮新增）

### 1.1 workbuddy 站真实页面清单（5 个 HTML 入口，全部实测 200）

| 路径 | 大小 | 性质 | 安全头 | 首轮是否覆盖 |
| :--- | --: | :--- | :--- | :--- |
| `/` | 903B | SPA 壳（Vue3） | 无 CSP / 无 XFO / `SameSite=None` | ✅ |
| `/diagnosis` | 903B | SPA 路由（同壳） | 同上 | ⚠️ 仅测到可嵌入 |
| **`/ecosystem.php`** | **77,745B** | **独立大页面**（原生 JS） | **无 CSP / 无 XFO** | ❌ **首轮遗漏** |
| **`/studyforge.php`** | **27,911B** | **独立大页面**（原生 JS） | **无 CSP / 无 XFO** | ❌ **首轮遗漏** |
| `/matrix/` | 903B | SPA fallback | 同上 | ❌ |

### 1.2 其他自有资产（此前误判为「不在授权」）

| 资产 | 状态 | 本轮测试结果 |
| :--- | :--- | :--- |
| `academic-ai-worker.3335264558.workers.dev` | ✅ 200，`{"flags":{}}` | **真实自有 Worker**（Cloudflare）。暴露 `Access-Control-Allow-Headers: Content-Type`、`Allow-Methods: POST, OPTIONS`、`Expose-Headers: X-AI-Channel, X-AI-Notice, X-AI-Fallback-Reason`、`Vary: Origin`。见 §3 |
| PATHOT 后端 | `/api/account/me` 真实，其余 fallback | 见 §4 |

---

## 2. 🔴 本轮最重要发现：`/studyforge.php` 持久型 DOM XSS（已实测执行）

### 2.1 完整攻击链（全部代码逐字引自真实响应体）

```
① 用户输入        L339  function addCourse(){ const n=document.getElementById('cName').value.trim();
                                                                    S.courses.push(n);   ← 零转义入数组
② 持久化          L118  function save(){ localStorage.setItem('xgw_state', JSON.stringify(S)); }
③ 读取            L116  let S = JSON.parse(localStorage.getItem('xgw_state') || '{}');
④ 渲染汇点        L321  ${S.courses.length ? S.courses.map(c=>`<div class="tool"><b>${c}</b></div>`).join('') : ...}
                                                                    ↑ 拼接进 innerHTML，零转义
```

### 2.2 真实浏览器执行证据（Edge + CDP，非推理）

**测试方法**：下载真实 `/studyforge.php` 响应体 → 生成离线副本（**核心逻辑逐字未改**，仅把 `unpkg` 外链换成本地 stub，因为沙箱无外网）→ 用 Edge headless + Chrome DevTools Protocol 驱动 → 走真实入口 `go('me','study')` 进入 `#cName` 所在页 → 调用真实 `addCourse()`。

**载荷**（onerror 写 DOM，避免 alert 阻塞）：
```html
<img src="http://127.0.0.1:1/none.png" onerror="window.__EXEC__.push('onerror-handler-ran');document.title='XSS-CONFIRMED';var d=document.createElement('div');d.id='__pwned__';d.textContent='PWNED';document.body.appendChild(d)">
```

**执行结果**（`evidence/full/xss-proof-IRONCLAD.json`）：
```json
{
  "exec": ["onerror-handler-ran"],          ← 注入的 handler 被调用
  "onerr": [{"src":"http://127.0.0.1:1/none.png"}],  ← onerror 事件真实触发
  "title": "XSS-CONFIRMED",                 ← 页面 title 被注入代码改写
  "pwned": true,                            ← 注入代码创建了 #__pwned__ 元素
  "imgComplete": true
}
```

**判定：`DOM_XSS_EXECUTED_CONFIRMED`** —— 注入的 JavaScript 在真实浏览器中执行并产生了可观测副作用。

### 2.3 定性与严重度

| 项 | 判定 |
| :--- | :--- |
| **类型** | **持久型 DOM XSS**（localStorage → innerHTML → 执行） |
| **持久性** | ✅ 载荷写入 `localStorage['xgw_state']`，**每次访问该页都会执行**，非一次性 |
| **跨用户触达** | ❌ **无**。该页 `location.search`/`location.hash`/`URLSearchParams`/`document.referrer`/`postMessage` 读取点**实测全为 0**，攻击者无法主动投递载荷给他人 |
| **可利用路径** | 仅 self-XSS（用户对自己输入） |
| **但放大因素** | ①持久化：写入后长期驻留，所有后续访问都执行<br>②**同站还有另一个 DOM XSS 汇点**（`/ecosystem.php` L1114/L1129），若两者组合或未来新增 URL 入口，立即升级为反射型<br>③该页**无 CSP**，无任何兜底 |
| **严重度** | **Low**（self-XSS 按 ROE §6 不足以 Medium；但持久性 + 无 CSP + 同站第二个汇点，属**必须修**的加固项） |

### 2.4 汇点清单（`/studyforge.php` 共 16 处 innerHTML）

| 位置 | 是否接用户输入 | 风险 |
| :--- | :--- | :--- |
| **L321** `${c}`（courses 渲染） | ✅ 是（`addCourse` → localStorage） | **🔴 已实测可利用** |
| **L120** `toast(t)` | ⚠️ 汇点脆弱，但**全部 18 个调用点均为硬编码字面量** | 🟡 潜在（未来若传入动态值即成 XSS） |
| L133/L144/L204/L236/L244/L267/L286/L300/L306/L311/L325/L345/L355 | ❌ 否（静态模板） | 安全 |

> **注意 L120 `toast()`**：`o.innerHTML='<div class="toast">'+t+'</div>'` 是零转义拼接。当前 18 个调用点全部传字面量，故不构成漏洞，但它是一个**等待被点燃的引信**——任何未来把用户输入传给 `toast()` 的改动都会立即变成 XSS。

### 2.5 修复建议

```js
// 方案 A（推荐，最小改动）：课程名渲染用 textContent 而非 innerHTML
// L321 改为 DOM 构建
S.courses.forEach(c => {
  const div = document.createElement('div');
  div.className = 'tool';
  const b = document.createElement('b');
  b.textContent = c;              // ← 自动转义
  div.appendChild(b);
  page.appendChild(div);
});

// 方案 B：统一转义函数
function esc(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
// L321：`<b>${esc(c)}</b>`
// L120：`'<div class="toast">' + esc(t) + '</div>'`
```

---

## 3. `academic-ai-worker`（本轮新增覆盖）

### 3.1 实测事实

```
GET /                                    → 200  {"flags":{}}
Content-Type: application/json
Cache-Control: public, max-age=60
Vary: Origin                              ← 说明做 Origin 区分（CORS 白名单机制）
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Expose-Headers: X-AI-Channel, X-AI-Notice, X-AI-Fallback-Reason
Server: cloudflare
```

### 3.2 判读

| 观察 | 判定 |
| :--- | :--- |
| 根路径返回 `{"flags":{}}` | 可能是 feature-flag 端点，无敏感信息 |
| **`Vary: Origin` 但无 `Access-Control-Allow-Origin`** | 说明它对 Origin 做了判断，但**默认不放行任意源** → **CORS 设计正确** |
| `Expose-Headers: X-AI-Channel, X-AI-Notice, X-AI-Fallback-Reason` | 暴露了内部路由/降级机制的设计（channel / fallback reason），**信息性泄露 Low** |
| `Allow-Methods: POST, OPTIONS` | 只允许 POST，无 GET 读取面 |

**未构造 POST 请求**：SCOPE 明确该 Worker 会调用真实 LLM（消耗额度），且其前端调用逻辑在 SM-PAGES 的 JS 里，需构造合法 payload 才能测。**本轮仅做被动探测**，未发 POST。

**建议**：该 Worker 属本项目自有资产，应纳入正式授权范围做专项（特别是 prompt injection、SSRF、额度滥用、Origin 绕过后端逻辑）。

---

## 4. PATHOT 后端复核（纠正首轮结论）

### 4.1 全路由实测矩阵

| 路径 | GET 状态 | 大小 | 类型 | 判定 |
| :--- | ---: | --: | :--- | :--- |
| `/api/account/me` | 200 | **34** | `application/json` | ✅ **真实端点** `{"ok":false,"reason":"NO_SESSION"}` |
| `/api/account/login` | 200 | 2,440,447 | `text/html` | ❌ **SPA fallback** |
| `/api/account/register` | 200 | 2,440,447 | `text/html` | ❌ fallback |
| `/api/account/logout` | 200 | 2,440,447 | `text/html` | ❌ fallback |
| `/api/summarize` | 200 | 2,440,447 | `text/html` | ❌ fallback |
| `/api/health` | 200 | 727,145 | `text/html` | ❌ fallback |
| `/api/subscribe` | 200 | 958,035 | `text/html` | ❌ fallback |

### 4.2 结论修正

**首轮报告 §6.2 说「PATHOT 有完整账号体系后端（login/register/me）」是过度推断。**
本轮用 **Content-Length + Content-Type 双判据**（34B JSON vs 2.4MB HTML）确认：

- **只有 `/api/account/me` 是真实端点**，其余 6 条均为 SPA catch-all fallback
- 首轮用「OPTIONS 204 vs 405」推断路由存在，**该方法在 PATHOT 上不可靠**（复核员 early 已提示「204 判据站间不可移植」）
- `login`/`register` 是否真实存在，需用 **POST** 验证（GET 全是 fallback，无法判定）

**更正**：PATHOT 攻击面比首轮描述的小，仅确认一个已正确实现认证的只读端点。

---

## 5. 本轮新增/修正的 finding 汇总

| 编号 | 标题 | 严重度 | 状态 |
| :--- | :--- | :--- | :--- |
| **MX-18** | `/studyforge.php` 持久型 DOM XSS（localStorage → innerHTML，**已浏览器实测执行**） | **Low** | 🆕 新增 |
| **MX-19** | `/studyforge.php` 的 `toast()` 是零转义 innerHTML 汇点，18 个调用点当前均为字面量（引信） | **Info** | 🆕 新增 |
| **MX-20** | `/ecosystem.php`、`/studyforge.php` 两个大页面**均无 CSP / 无 XFO**，且可被 iframe 嵌入 | **Low** | 🆕 扩面（原 MX-01 只覆盖首页） |
| **MX-21** | `academic-ai-worker` 通过 `Expose-Headers` 泄露内部机制（channel / fallback-reason） | **Info** | 🆕 新增 |
| 修正 | PATHOT 后端只有 `/api/account/me` 一个真实端点（非「完整账号体系」） | — | ✅ 纠正 |
| 修正 | workbuddy 有 **5 个 HTML 入口**，原报告只覆盖首页 | — | ✅ 扩面 |

---

## 6. 覆盖度更新

| 项 | 首轮 | 本轮 | 变化 |
| :--- | --: | --: | :--- |
| 已测 HTML 入口（workbuddy） | 2 | **5** | +3 |
| 已测自有域 | 5 站 | **6 站**（+ `academic-ai-worker`） | +1 |
| PATHOT 后端路由核实 | 推断 | **7 条实测** | 纠正 |
| workbuddy innerHTML 汇点 | 未统计 | **23 处**（ecosystem 7 + studyforge 16） | 新增统计 |
| **发现的 XSS 汇点** | 0 | **2 个可利用 + 1 个引信** | 新增 |

**覆盖度算术（更新）**：
```
N = 9 资产行（原 8 + academic-ai-worker）× 15 漏洞类 = 135
实测覆盖 M′ = 78
M′/N = 78/135 = 57.8%
```

---

## 7. 本轮测试纪律自查

| 项 | 状态 |
| :--- | :--- |
| 是否对第三方 CDN 发请求 | ❌ 零请求（`unpkg`/`cloudflare`/`googleapis` 全部未访问） |
| XSS 测试是否在目标站真实环境 | ❌ 用**本地离线副本**（保护目标站，避免写入脏数据） |
| 离线副本是否改动核心逻辑 | ❌ **未改**（逐字比对 `S.courses.push(n)`、`<b>${c}</b>`、`toast` 拼接三处均一致），仅替换外链 |
| 是否触发真实 LLM | ❌ 未触发（`academic-ai-worker` 仅 GET 根路径） |
| 是否爆破 | ❌ 未爆破 |
| 目标站数据 | ✅ 未写入（所有 XSS 测试在本地副本） |

---

## 8. 证据索引（本轮）

| 证据 | 路径 |
| :--- | :--- |
| **XSS 确凿证明（最关键）** | `evidence/full/xss-proof-IRONCLAD.json` |
| XSS 浏览器执行过程（前序） | `evidence/full/xss-browser-proof-v2.json` |
| `studyforge.php` 真实响应体 | `evidence/full/studyforge.html` |
| `ecosystem.php` 真实响应体 | `evidence/full/eco.html`（77,745B） |
| 离线测试副本（逐字未改逻辑） | `evidence/full/studyforge-noblock.html` |
| XSS 静态分析 PoC | `evidence/full/poc-studyforge-xss.mjs` |
| 浏览器验证脚本 | `evidence/full/browser-xss-ironclad.mjs` |
| ecosystem 内部引用 | `evidence/full/eco-internal-refs.txt` |
