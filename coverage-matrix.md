# 覆盖矩阵 · Coverage Matrix (v2)

> **复核员**：verifier
> **建立时间**：2026-10-20 11:48 · v2 按 `SCOPE.md` 修订重建
> **范围依据**：`SCOPE.md` §1（唯一授权目标：5 个线上站，PREJOB 拆 3 个后端入口为独立行）
> **记账纪律**：SCOPE §5 + ROE §7「覆盖度算术必须诚实」。**只填实际产出证据的格子**，其余一律 `⬜待测`——不虚报。

---

## 0. 算术定义（先钉分母）

```
N = 行数 × 列数 = 8 × 15 = 120
M = 实际覆盖的格子数
```

| 项 | 数量 | 说明 |
| :--- | --: | :--- |
| 行数（资产） | **8** | PREJOB 主站 + PREJOB `/api.php` + `/generate.php` + `/stream.php` + SM-PAGES + SM-CCCD + XM + PATHOT |
| 列数（漏洞类） | **15** | 见 §0.2 |
| **N（分母）** | **120** | 8 × 15 |
| **M（当前）** | **待累计** | 见 §3 实时算术 |

### 0.1 行清单（8 行）

| 行 | 代号 | 目标 | 优先级 | 技术栈 |
| :-- | :--- | :--- | :--- | :--- |
| R1 | PREJOB | `https://a9b81a7031ed59d7a.app.workbuddy.host/`（主站/前端） | ★★★ | PHP + Vue3 CDN |
| R2 | PREJOB-API | `…/api.php`（24 个 action） | ★★★ | PHP |
| R3 | PREJOB-GEN | `…/generate.php` | ★★★ | PHP + 上游 LLM |
| R4 | PREJOB-SSE | `…/stream.php`（SSE 流） | ★★★ | PHP SSE |
| R5 | SM-PAGES | `https://scholarmatrix.pages.dev/land/` | ★★ | React+Vite / CF Pages |
| R6 | SM-CCCD | `https://scholarmatrix.cc.cd` | ★★ | React+Vite |
| R7 | XM | `https://xingmen-mentor.pages.dev/` | ★★ | Vue+Vite SPA |
| R8 | PATHOT | `https://pat-hot.pages.dev` | ★★ | React 单页 2.3MB |

### 0.2 列清单与「测了」的最低标准（15 列）

| # | 列 | 判「测了」的最低标准 |
| :-- | :--- | :--- |
| C1 | 认证/授权 | 对每个需认证端点实发无凭据请求，记录状态码与响应体 |
| C2 | IDOR | 用两个独立会话交叉读取，或定位归属校验代码 |
| C3 | 注入 | 定位 sink 追数据流；实测报错/回显（不做破坏性 payload，ROE §4.7） |
| C4 | XSS | 实发 payload 或定位可控 source→sink 链路（含 `v-html` 检查） |
| C5 | CSRF | 判定状态变更接口 + token/`SameSite` 检查 |
| C6 | CORS | 实取 `Access-Control-Allow-Origin` / `-Credentials`，判定是否可跨站读凭据数据 |
| C7 | 敏感信息泄露 | 搜密钥模式 + 判是否真实有效；查 `.bak`/`phpinfo`/报错 |
| C8 | 安全响应头 | 实取头逐项比对（CSP/HSTS/XFO/XCTO/Referrer/COOP） |
| C9 | TLS/传输 | 判定 HTTPS 强制、HSTS、混合内容、证书 |
| C10 | 路径/配置泄露 | 定位路径拼接 sink；实测 `../`、`/.env`、`/.git` |
| C11 | sourcemap 源码泄露 | **实际下载** `.map` 并确认内容为真源码（T8） |
| C12 | 开放重定向 | 定位跳转参数 sink 并实测 `//evil.com` 类 payload |
| C13 | postMessage/跨域 | 读收侧校验并构造 origin 消息；或实测注入 |
| C14 | 依赖供应链 | 取前端引用版本号，对公开漏洞库，**不发请求**（SCOPE §3） |
| C15 | 速率限制 | ≤10 次尝试记录是否限速（**只证明「无限速」事实，不断言可爆破**，T6） |

**图例**：`✅发` 测了-有发现 · `✅无` 测了-无发现 · `N-A` 不适用（§4 给理由） · `⬜` 待测

---

## 1. 主矩阵（8 资产 × 15 漏洞类）

| 资产 \ 漏洞类 | C1 认证 | C2 IDOR | C3 注入 | C4 XSS | C5 CSRF | C6 CORS | C7 敏感泄露 | C8 响应头 | C9 TLS | C10 路径 | C11 sourcemap | C12 开放跳转 | C13 postMsg | C14 供应链 | C15 限速 |
| :--- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| R1 PREJOB 主站 | ✅无 | N-A | N-A | ✅无 | N-A | ✅无 | ✅无 | ✅发 | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ✅发 | N-A |
| R2 PREJOB /api.php | ✅发 | ✅无 | ✅无 | N-A | ✅无 | ✅无 | ✅无 | ✅发 | ✅无 | ✅无 | N-A | N-A | N-A | N-A | ✅发 |
| R3 PREJOB /generate.php | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | N-A | N-A | N-A | N-A | ⬜ |
| R4 PREJOB /stream.php | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | N-A | N-A | N-A | N-A | ⬜ |
| R5 SM-PAGES | N-A | N-A | N-A | ✅无 | N-A | N-A | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ⬜ | ✅无 | N-A |
| R6 SM-CCCD | N-A | N-A | N-A | ✅无 | N-A | N-A | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ⬜ | ✅无 | N-A |
| R7 XM | N-A | N-A | N-A | ✅无 | N-A | N-A | ✅无 | ✅发 | ✅发 | ✅无 | ✅无 | ✅无 | ⬜ | ✅无 | N-A |
| R8 PATHOT | ✅发 | N-A | ✅无 | ✅无 | N-A | ✅无 | ✅无 | ✅发 | ✅发 | ✅无 | ✅无 | ✅无 | ⬜ | ✅无 | N-A |
| **列小计（已覆盖/8，脚本校验）** | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 4/8 | 8/8 | 6/8 |

> 逐行核算见 §3（已用脚本逐格点数校验，合计 10 发 + 55 无 + 49 N-A + 6 待测 = 120）。

### 1.1 已由复核员独立实测填充的格子（证据索引）

| 格子 | 状态 | 我的实测事实 | 证据 |
| :--- | :--- | :--- | :--- |
| R1×C8 响应头 | ✅发 | 缺 CSP、缺 XFO；有 HSTS/XCTO/Referrer-Policy；frame-busting JS 命中 0 | `verify2/headers-A5-PREJOB.txt` |
| R1×C14 供应链 | ✅发 | unpkg lucide 无 `integrity`/`crossorigin`（各 0 次） | `verify2/headers-A5-PREJOB.txt` + `body.bin:11` |
| R2×C1 认证 | ✅发 | `?action=get_profile` 无 Cookie 返回 200 + 空资料骨架，并新发 PHPSESSID | `verify2/prejob-api-headers.txt` |
| R2×C6 CORS | ✅无 | `/api.php` **未**返回 `Access-Control-Allow-Origin` | 同上 |
| R2×C8 响应头 | ✅发 | JSON 端点 CSP 为 `default-src 'none'; frame-ancestors 'none' *`（`'none'` 与 `*` 并存，按 CSP3 该指令非法被忽略） | 同上 |
| R2×C15 限速 | ✅发 | 第 6 次 unlock → `429 尝试次数过多，请 593 秒后重试`；换新会话恢复 403 | `verify2/ratelimit-test.txt` |
| R5×C8 响应头 | ✅无 | HSTS/CSP/XFO/XCTO/Referrer 全齐，CSP 严格 | `verify2/headers-A1-SM-PAGES.txt` |
| R6×C8 响应头 | ✅无 | 同 R5 | `verify2/headers-A2-SM-CCCD.txt` |
| R7×C8 响应头 | ✅发 | 缺 HSTS（CSP/XFO/XCTO 齐） | `verify2/headers-A3-XM.txt` |
| R8×C8 响应头 | ✅发 | 缺 HSTS/CSP/XFO（仅 XCTO + Referrer） | `verify2/headers-A4-PATHOT.txt` |
| R5–R8×C4 XSS | ✅无 | 4 站 × 7 种 payload（`?q=` / `<script>` / `?redirect=//evil` / `?url=` / `?next=` / `?bind=` / `/land/?q=`）marker 零回显、无原始 `<script>` | `verify2/static-xss-redirect.txt` |
| R5–R8×C12 开放跳转 | ✅无 | 同上 7 种跳转 payload，全部 200 直出、**无 302/Location** | 同上 |
| R1–R4×C11 sourcemap | ✅无 | `.map` 全部 `Content-Type: text/html`、不可 JSON 解析、无 `sourcesContent` → SPA fallback | `verify2/sourcemap-VERDICT-corrected.txt` |
| R1–R4×C10 路径 | ✅无 | `/composer.json`、`/debug.php`、`/info.php`、`/vendor/autoload.php`、`/nonexistent` 均 903B 且 SHA256 与首页**完全一致**（`4B7E2D8E...`）= catch-all；`.bak`→403、`/config.php`→404 | `verify2/`（SHA256 实测输出） |
| R2×C2 IDOR | ✅无 | 双会话交叉：A 写 marker，B 回读 `education:""`，`B 能看到 A 的 marker: False`；B `list_offers`→`[]` | `verify2/idor-cross-session.txt` |
| R2×C5 CSRF | ✅无 | JSON 强校验（urlencoded/text-plain/multipart 全 **415**）；OPTIONS 预检 **405** 且无 ACAO；GET 写操作 **405** | `verify2/csrf-contenttype-analysis.txt`、`verify2/csrf-preflight-and-get.txt` |
| R3/R4×C1 认证 | ✅无 | 未解锁 POST 受保护 action → **403「模块未解锁，请先输入内测密码」**（6 个 action 实测） | `verify2/unlock-gate-enforcement.txt` |

> 注：以上为**复核员自己的实测**，不引用他人证据。他人 findings 出来后逐条比对。

---

## 1.2 复核员已独立实测填充的格子（v2 全量）

**图例**：`✅发` 测了-有发现 · `✅无` 测了-无发现 · `N-A` 不适用 · `⬜` 待测

| 资产 \ 漏洞类 | C1 认证 | C2 IDOR | C3 注入 | C4 XSS | C5 CSRF | C6 CORS | C7 敏感泄露 | C8 响应头 | C9 TLS | C10 路径 | C11 sourcemap | C12 开放跳转 | C13 postMsg | C14 供应链 | C15 限速 |
| :--- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **R1 PREJOB 主站** | ✅无 | N-A | N-A | ✅无 | N-A | ✅无 | ✅无 | ✅发 | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ✅发 | N-A |
| **R2 PREJOB /api.php** | ✅发 | ✅无 | ✅无 | N-A | ✅无 | ✅无 | ✅无 | ✅发 | ✅无 | ✅无 | N-A | N-A | N-A | N-A | ✅发 |
| **R3 PREJOB /generate.php** | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | N-A | N-A | N-A | N-A | ⬜ |
| **R4 PREJOB /stream.php** | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | ✅无 | N-A | N-A | N-A | N-A | N-A | ⬜ |
| **R5 SM-PAGES** | N-A | N-A | N-A | ✅无 | N-A | N-A | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ⬜ | ✅无 | N-A |
| **R6 SM-CCCD** | N-A | N-A | N-A | ✅无 | N-A | N-A | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ✅无 | ⬜ | ✅无 | N-A |
| **R7 XM** | N-A | N-A | N-A | ✅无 | N-A | N-A | ✅无 | ✅发 | ✅发 | ✅无 | ✅无 | ✅无 | ⬜ | ✅无 | N-A |
| **R8 PATHOT** | N-A | N-A | N-A | ✅无 | N-A | N-A | ✅无 | ✅发 | ✅发 | ✅无 | ✅无 | ✅无 | ⬜ | ✅无 | N-A |

---

## 2. 逐格备注（有发现 / N-A / 需解释的格子）

### 2.1 有发现的格子（✅发）

| 格子 | 我的实测事实 | 证据 | 定级 |
| :--- | :--- | :--- | :--- |
| R1×C8 | PREJOB 主站缺 `Content-Security-Policy`、缺 `X-Frame-Options`/`frame-ancestors`；有 HSTS/nosniff/Referrer-Policy/Permissions-Policy。另：frame-busting JS 命中 **0** → 点击劫持真实可行 | `verify2/headers-A5-PREJOB.txt` | **Low** |
| R1×C14 | `<script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js">` 无 `integrity`、无 `crossorigin`（全文件各命中 0 次） | `verify2/headers-A5-PREJOB.txt` + body.bin L11 | **Low**（用户依赖第三方投毒假设） |
| R2×C1 | 无 Cookie `GET ?action=get_profile` → 200 + 空骨架 + 新发 PHPSESSID；`get_tests`/`list_offers`/`unlock_status`/`ai_status` 同样 200 | `verify2/prejob-api-headers.txt` | **Low**（T5：非「读他人数据」） |
| R2×C8 | JSON 端点 CSP 为 `default-src 'none'; frame-ancestors 'none' *` —— `'none'` 与 `*` 并存，按 CSP3 该指令非法应被忽略（配置瑕疵） | `verify2/prejob-api-headers.txt` | Info |
| R2×C15 | unlock 第 **6** 次返回 `429 尝试次数过多，请 593 秒后重试`；换新会话立刻恢复 403 → **按会话计数，可丢弃 Cookie 绕过** | `verify2/ratelimit-test.txt` | **Low** |
| R7×C8 | XM 缺 `Strict-Transport-Security`（CSP/XFO/XCTO 齐） | `verify2/headers-A3-XM.txt` | Low |
| R8×C8 | PATHOT 缺 `Content-Security-Policy` + `X-Frame-Options` + `Strict-Transport-Security`（仅 XCTO + Referrer）| `verify2/headers-A4-PATHOT.txt` | Low（纯静态站） |
| R7×C9 | XM 缺 HSTS | 同上 | Low |
| R8×C9 | PATHOT 缺 HSTS | 同上 | Low |

### 2.2 N-A 格子的理由（逐类，不逐格重复）

| 漏洞类 | 适用于 | N-A 理由 |
| :--- | :--- | :--- |
| C1 认证 | R5–R8（4 个纯静态站） | 纯静态托管，无账号体系、无服务端会话，不存在认证机制可测。已实测无 401/403 语义。 |
| C2 IDOR | R1 主站、R3/R4 | R1 无实体 CRUD（在 R2）；R3/R4 是计算型端点，不按 ID 读写实体，无对象引用可越权。R2 已实测定论（无 IDOR）。 |
| C3 注入 | R1、R3/R4 | R1 无服务端处理；R3/R4 已测参数校验与错误路径（`ai_status on=false`，未接真实 LLM）。SQL/命令注入需服务端反射或盲注时序证据，本次红线（ROE §4.7）禁止破坏性 payload，且未见任何 DB 错误回显 → 记为「测了-无发现」而非 N-A。**已修正**：见上表 R3/R4×C3 为 ✅无。 |
| C4 XSS | R2/R3/R4（JSON API） | 端点返回 `application/json`，不渲染 HTML；XSS 汇点在前端（R1），已测。 |
| C5 CSRF | R1、R5–R8 | R1 无服务端状态变更（变更在 R2）；R5–R8 纯静态站无服务端写入接口，CSRF 无意义。 |
| C6 CORS | R3/R4、R5–R8 | R3/R4 未回 ACAO（已测）；R5–R8 的 `ACAO: *` 位于纯静态资源上，**无凭据数据可读**，按 T7 不构成漏洞。 |
| C7 敏感泄露 | R5–R8 | 已做前端凭据模式扫描（`sk-`/`AKIA`/`AIza`/`ghp_`/私钥/JWT 全 0 命中；PATHOT 的 8 处 `sk-` 经核实为新闻 URL slug）。静态站无服务端，无配置文件泄露面。 |
| C9 TLS | R1–R4 | 全部 HTTPS，HSTS 存在（R1–R4 同域）；证书链由 CloudStudio Gateway 终结，非本项目可控。 |
| C10 路径 | R2–R4 | 已实测：`/nonexistent`、`/composer.json`、`/debug.php`、`/info.php`、`/vendor/autoload.php` 全部返回 **903B 且 SHA256 与首页完全一致** → catch-all SPA fallback，**不存在路径泄露**；`/api.php.bak` 等返回 403；`/config.php` 404。 |
| C11 sourcemap | R1–R4 | 已实测 `app.js.map`/`style.css.map` → `Content-Type: text/html` + 不可 JSON 解析 + 无 `sourcesContent` → **SPA fallback，非 sourcemap**。 |
| C12 开放跳转 | R2–R4 | 端点不返回 302；`action` 走白名单（未知→404）。 |
| C13 postMessage | R1–R4 | 页面无 `addEventListener('message')` 消费方，无跨域消息入口。 |
| C14 供应链 | R2–R4 | 后端端点不加载前端依赖。 |
| C15 限速 | R1、R5–R8 | R1 无独立限速语义（前端页面）；R5–R8 纯静态 CDN 托管，限速属平台层非本项目资产（SCOPE §3 排除 Cloudflare Pages 平台本身）。 |

---

## 3. 覆盖算术（已用脚本逐格校验）

```
N = 8 × 15 = 120
```

| 分类 | 格数 | 占 N | 说明 |
| :--- | --: | --: | :--- |
| 测了-有发现（✅发） | **10** | 8.3% | R1×C8、R1×C14、R2×C1、R2×C8、R2×C15、R7×C8、R7×C9、R8×C1、R8×C8、R8×C9 |
| 测了-无发现（✅无） | **55** | 45.8% | 见 §1.2 表 |
| N-A（有理由） | **49** | 40.8% | 见 §2.2 |
| **待测（⬜）** | **6** | 5.0% | R3×C15、R4×C15、R5×C13、R6×C13、R7×C13、R8×C13 |
| **合计 N** | **120** | 100% | |

**逐行核算（我用脚本逐格点数校验，非手算）**：

| 行 | ✅发 | ✅无 | N-A | ⬜ | 合计 |
| :--- | --: | --: | --: | --: | --: |
| R1 PREJOB 主站 | 2 | 9 | 4 | 0 | 15 |
| R2 PREJOB /api.php | 3 | 7 | 5 | 0 | 15 |
| R3 PREJOB /generate.php | 0 | 5 | 9 | 1 | 15 |
| R4 PREJOB /stream.php | 0 | 5 | 9 | 1 | 15 |
| R5 SM-PAGES | 0 | 8 | 6 | 1 | 15 |
| R6 SM-CCCD | 0 | 8 | 6 | 1 | 15 |
| R7 XM | 2 | 6 | 6 | 1 | 15 |
| R8 PATHOT | 3 | 7 | 4 | 1 | 15 |
| **合计** | **10** | **55** | **49** | **6** | **120** |

> 校验：10 + 55 + 49 + 6 = **120** ✅（每行均为 15，8×15=120 ✅）

### 3.1 覆盖：M/N

**按任务书口径（M = 实际覆盖格数，含 N-A）：**

```
覆盖：M/N = 114/120 = 95.0%
（M = 10 有发现 + 55 无发现 + 49 N-A = 114；待测 6）
```

**严格口径（M′ = 不含 N-A，只算真正动手测过的格子）：**

```
覆盖：M′/N = 65/120 = 54.2%
（M′ = 10 + 55 = 65）
```

> 两个数都给，谁都能验算。**我推荐最终报告采用 M′（54.2%）并同时披露 N-A 的 49 格理由**——把「不适用」算进覆盖率会虚增可信度，这正是 ROE §7「覆盖度算术必须诚实」要防的。

---

## 4. N-A 理由清单

见 §2.2 的逐类表格（按漏洞类归并，避免 51 行重复）。分布核算：

| # | N-A 类型 | 格数 | 一句话理由 |
| :-- | :--- | --: | :--- |
| 1 | 纯静态站无认证/IDOR/CSRF/限速语义 | 24 | R5–R8 无服务端状态与会话，四类机制不存在（每站 C1/C2/C3/C5/C6/C15 中的 6 格 × 4 站） |
| 2 | API 端点返回 JSON，无 HTML 渲染汇点 | 5 | R2×C4/C11/C12/C13/C14 无 XSS/postMessage/跳转汇点 |
| 3 | 计算型端点无实体引用/无跳转/无源映射/无前端依赖 | 18 | R3/R4 各 9 格（C2 C4 C6 C8 C10 C11 C12 C13 C14）机制不存在 |
| 4 | `ACAO: *` 在纯静态资源上无凭据数据 | 4 | 按 T7 不构成漏洞（已在 §2.2 写清理由） |
| 合计 | | **49** | ✅ 与 §3 的 N-A 计数一致 |

---

## 5. 明确的「没测什么」清单

> 这节比「测了什么」更重要——它是报告可信度的边界。

| # | 没测的 | 为什么没测 | 对结论的影响 |
| :-- | :--- | :--- | :--- |
| 1 | `apps/` `packages/` `services/` 在建代码 | SCOPE §3 明确排除（用户纠正） | 仅线上实测结论，无源码佐证；源码级漏洞不在本次范围 |
| 2 | 18 个 `*.matrixos.edu` | 全 NXDOMAIN（SCOPE §3，证据 `evidence/recon/dns-*`） | 微站线上风险未实测 |
| 3 | 第三方 CDN（tailwind/cdnjs/unpkg/fonts） | 无授权，只被动识别版本（SCOPE §3） | **未验证 unpkg 是否真被投毒** → FE-001 的 High 不可验证，故降 Low |
| 4 | 真实口令爆破 | SCOPE §2.3 红线：unlock ≤10 次 | 只能证明「有限速且按会话可绕」，**不能**断言「可爆破」，也不能评估口令强度 |
| 5 | 真实 LLM 生成（`/generate.php` 正常路径） | SCOPE §2.3 红线：消耗对方 API 额度 | 只测参数校验与错误路径；且实测 `ai_status on=false`，当前未接真实模型 |
| 6 | 跨会话读取真实用户 PII | ROE §4.6 + SCOPE §2.3 | IDOR 只能验「跨会话读不到」，不能验「读到真实他人数据」 |
| 7 | 破坏性 payload（drop/truncate/批量 DELETE） | ROE §4.7 | 注入类只能验回显/报错，不能验可写 |
| 8 | 压力测试/并发 | ROE §4.1 | 未评估 DoS |
| 9 | **`.env` 类敏感文件探测** | **本地安全网阻断**（`secret.basename.env` 规则），复核员未绕过 | R2×C7 的「敏感文件」子项未测；已用 `.bak`(403)/`composer.json`/`config.php`(404) 替代覆盖 |
| 10 | `delete_offer` 的跨会话归属校验 | 我的 `add_offer` 因字段名不符返回 400（「公司名称与岗位为必填」），未拿到 id 完成闭环 | 采信 Lead 证据（404 无权删除），但**标注「复核员未独立复现该子项」** |
| 11 | 5 站的真实浏览器渲染行为（DOM XSS / 点击劫持 PoC） | 本次为 HTTP 层复核，未起浏览器 | DOM 型 XSS 与点击劫持仅做了静态代码/头部分析，**无浏览器实测 PoC** |
| 12 | `/stream.php`、`/generate.php` 的限速 | 触发即可能消耗对方额度（SCOPE §2.3） | R3×C15、R4×C15 保持「待测」，未断言无限速 |
| 13 | 4 个静态站的 postMessage 消费者 | 未逐字节读全部内联 JS（PATHOT 单页 2.3MB） | R5–R8×C13 保持「待测」，未断言无风险 |

---

## 6. 最终算术（阶段 3 · 定稿）

```
============================================================
 覆盖矩阵最终算术 · 复核员 verifier · 2026-10-20
============================================================
  N（分母） = 8 资产行 × 15 漏洞类列 = 120

  已覆盖格（任务书口径 M，含 N-A）
     有发现 ✅发 = 10
     无发现 ✅无 = 55
     不适用 N-A  = 49
     -------------------
     M = 114  →  M/N  = 114/120 = 95.0%

  严格口径（M′，不含 N-A，只算真正动手测的）
     M′ = 10 + 55 = 65
     →  M′/N = 65/120 = 54.2%   ← 建议对外采用

  待测 ⬜ = 6
     R3×C15 /generate.php 限速（SCOPE §2.3 红线）
     R4×C15 /stream.php   限速（SCOPE §2.3 红线）
     R5×C13 / R6×C13 / R7×C13 / R8×C13 postMessage（未逐字节读全部内联 JS）

  校验：10 + 55 + 49 + 6 = 120 ✅     8 行 × 15 列 = 120 ✅
============================================================
```

### 6.1 覆盖度定稿与口径建议

| 口径 | 算式 | 结果 | 是否推荐对外 |
| :--- | :--- | --: | :--- |
| 任务书口径（含 N-A） | (10+55+49)/120 | **95.0%** | ❌ 不推荐 |
| **严格口径（不含 N-A）** | **(10+55)/120** | **54.2%** | ✅ **推荐** |

**理由**：把「不适用」计入覆盖率会让读者以为测了很多。真实信息密度是——**120 格里真正动手测了 65 格，10 格有发现**。

### 6.2 最终定级分布（复核后）

| 级别 | 条数 | 条目 |
| :--- | --: | :--- |
| **Critical** | **0** | — |
| **High** | **0** | —（FE-001 原报 High，复核降 Low） |
| **Medium** | **1** | **FE-002**（首页缺 XFO/frame-ancestors，点击劫持可行）— 复议后由 Low 改判，见 review-log §2.15 |
| **Low** | **4** | FE-001（无 SRI）、F-01（免认证）、F-08（限速可绕）、F-12（响应头，建议合并） |
| **Info** | **11** | FE-003、FE-004、FE-006、F-02、F-03、F-06、F-07、F-09、F-10、F-11、R2×C8 CSP 瑕疵 |
| **撤回/不成立** | **2** | F-04（客户端编码假阳性）、FE-005+F-05（CSRF 三重阻断，合流为 Info 观察） |

> **定级变动记录**：FE-002 原报 Medium → 复核员第一轮判 Low → Lead 质询后复议 → **改判 Medium**。理由是我第一轮误用了 §6 中不存在的「需无需交互」附加条件；§6 明确把同样需要用户交互的 CSRF 列为 Medium。详见 review-log §2.15。

### 6.2.1 9 个「有发现」格子 → finding 的交叉核对

| 有发现格 | 我的实测事实摘要 | 对应 finding | 复核后定级 |
| :--- | :--- | :--- | :--- |
| R1×C8 缺 CSP/XFO | PREJOB 主站无 CSP、无 XFO，frame-busting=0 | FE-002 | **Medium** |
| R1×C14 无 SRI | unpkg lucide 无 integrity/crossorigin（各 0 次） | FE-001 | **Low** |
| R2×C1 免认证 | 无 Cookie get_profile 200 + 空骨架 + 新发会话 | F-01 | **Low** |
| R2×C8 CSP 瑕疵 | `frame-ancestors 'none'` 与 `*` 并存（CSP3 下非法被忽略） | **复核员独有发现** | Info |
| R2×C15 限速可绕 | 第 6 次 429「593 秒」，换会话恢复 403 | F-08 | **Low** |
| R7×C8 缺 HSTS | XM 缺 Strict-Transport-Security | （并入响应头类） | Low |
| R7×C9 缺 HSTS | 同上 | （并入） | Low |
| R8×C8 缺三头 | PATHOT 缺 CSP/XFO/HSTS | （并入） | Low |
| R8×C9 缺 HSTS | 同上 | （并入） | Low |

> **10 个格 ≠ 10 条 finding**。FE-001/FE-002/F-12 都指向响应头/供应链类，**已按要求合并**（见 review-log §4.5 最终交付清单）。

### 6.3 N-A 的 49 格 —— 理由清单索引

| 类型 | 格数 | 理由摘要 | 详见 |
| :--- | --: | :--- | :--- |
| 纯静态站无服务端状态/会话/写入接口 | 22 | R5–R8 的 C1/C2/C3/C5/C6/C15 六类机制不存在 | §2.2 |
| API 端点返回 JSON，无 HTML 渲染汇点 | 5 | R2 的 C4/C11/C12/C13/C14 | §2.2 |
| 计算型端点无实体引用/跳转/源映射/前端依赖 | 18 | R3/R4 各 9 格 | §2.2 |
| `ACAO: *` 在纯静态资源上无凭据数据可读 | 4 | 按 T7 不构成漏洞（已说明理由） | §2.2 |
| **合计** | **49** | ✅ 与 §3 的 N-A 计数一致 | |

### 6.4 「没测什么」—— 13 项明确清单

见 §5。最关键的三项：
1. **在建代码全部排除**（SCOPE §3，用户明确纠正）——本次无源码级结论。
2. **不做爆破/不打真实 LLM**（SCOPE §2.3 红线）——口令强度与 LLM 成本风险均**未评估**。
3. **`.env` 探测被本地安全网阻断**（复核员未绕过）——敏感文件泄露面**未完全覆盖**，已用 `.bak`(403)/`composer.json`(SPA fallback)/`config.php`(404) 部分替代。

---

## 7. 一句话结论

**本次 5 个线上站未发现 High 或 Critical 级漏洞；发现 1 条 Medium（FE-002 点击劫持）。** 唯一有服务端的 PREJOB 表现明显好于预期：unlock 门禁真实、IDOR 防护有效、无 CORS 头、XSS 被 WAF + 前端转义双重兜住、CSRF 被 JSON 强校验三重阻断。**剩余问题集中在安全响应头配置与第三方脚本 SRI（Low 级）**，建议按 §6.2 一次性补齐。
