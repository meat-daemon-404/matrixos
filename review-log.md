# 复核日志 · Independent Review Log (v2)

> **复核员**：verifier（独立复核，非发现者）
> **建立时间**：2026-10-20 11:48 · v2 按 `SCOPE.md` 修订重建
> **范围依据**：`SCOPE.md`（2026-10-20 修订 v2）——**排除在建代码**（`apps/` `packages/` `services/`），只测文档提及的 5 个线上站，PREJOB(workbuddy) 严查
> **判据**：`ROE.md` §5（证据三件套）+ §6（严重度标尺）+ §7（报告纪律）
> **纪律声明**：只做挑战与确认，**绝不修改他人 findings 文件**。复核原始输出落盘 `evidence/verify2/`。

---

## 0. 复核判据（逐条打勾的硬规则）

| # | 判据 | 来源 | 不满足的后果 |
| :-- | :--- | :--- | :--- |
| R1 | 复现步骤可被第三方照着走通（确切命令/URL/参数） | ROE §5.1 | 三件套不全 → 降级 |
| R2 | 请求/响应原文落盘为文件，含状态码+关键头+body 截取 | ROE §5.2 | 三件套不全 → 降级 |
| R3 | 唯一 marker（`MXOS-<8位>`）在响应中**逐字**回显并原样粘贴 | ROE §5.3 | **未证明影响 → 降级 Info** |
| R4 | 我能独立复现（黑盒自己发请求；静态自己读证据原文） | ROE §7 | 不可复现 → 挑战 |
| R5 | 严重度符合 §6，无虚高 | ROE §6 | 虚高 → 降级并写理由 |
| R6 | 在 SCOPE §1 范围内，未触 §3 排除项与 ROE §4 红线 | SCOPE §1/§3 | 越界 → 证据作废 |

### 0.1 降级触发器（默认怀疑清单）

| ID | 触发器 | 判定 |
| :-- | :--- | :--- |
| **T1** | 理论风险但无实际调用点/攻击路径 | **Info** |
| **T2** | 纯配置建议（缺 HSTS/CSP/XCTO）而无实际攻击路径，或纯静态站 | **Low/Info**，不可 Medium（§6 要求「且可被利用」） |
| **T3** | 声称绕过校验（origin/认证/口令/签名） | 我必须**亲手跑通 payload**，跑不通即挑战 |
| **T4** | 静态推断当实测 | 最高 Low |
| **T5** | 「免登录可用」vs「可读他人数据」 | **必须分开定级**：仅免登录→最多 Medium；跨会话读到他人数据→High |
| **T6** | 无速率限制≠可爆破 | ≤10 次未见限速只证明「无限速」这一事实 → **Low/信息性** |
| **T7** | `ACAO: *` 在纯静态资源上 | **通常不构成漏洞**（无可读凭据数据），须说明理由 |
| **T8** | sourcemap 泄露 | 真存在才 High，**我自己下载确认**，不看状态码 |

### 0.2 我预先记录的技术纪律（避免事后找补）

- **不破红线**：不做真实口令爆破（unlock ≤10 次）、不写脏数据（只用自己的测试会话写唯一 marker 并清理）、不下载他人 PII、**不触发 `/generate.php` 真实 LLM 生成**（消耗对方额度）。
- 因此我对「可爆破」「可读到他人数据」「LLM 成本放大」类声明**只能证伪到「入口存在」层面**——发现者若声称更远，须自行提供证据，否则按 T4/T6 降级。

---

## 1. 复核总表

> ✅ 齐/是/可复现 · ⚠️ 部分 · ❌ 缺/否/不可复现 · 结论：确认/挑战/降级/待复核

| Finding ID | 标题 | 声明严重度 | 三件套齐(§5) | marker 逐字 | 可独立复现 | 复核结论 | 复核后严重度 | 复核人备注 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| FE-001 | PREJOB 无 CSP + lucide 无 SRI | High | ⚠️ 部分（无 marker，属静态配置类） | N-A（配置类无 marker） | ✅ 复现 | **降级** | **Low** | 事实成立，但「无 marker」+ 可利用性依赖 unpkg 被投毒/中间人，属 T1/T4；详见 §2.1 |
| FE-002 | PREJOB 首页缺 XFO/frame-ancestors | Medium | ⚠️ 部分（静态头） | N-A（头缺失是二进制事实） | ✅ 复现 | **维持 Medium**（复议后改判） | **Medium** | frame-busting=0 + SameSite=None + 单击敏感操作 → §6「缺失关键安全头**且可被利用**」两个合取项均满足；详见 §2.15 |
| FE-003 | SM-CCCD dangerouslySetInnerHTML 净化链 | Info | ✅ | N-A | ✅ 复现 | **确认** | **Info** | 我逐字核到 `DV` 五字符表、`wo()`、`ei()` 的 `/^https?:\/\//i` 白名单，判定正确；详见 §2.3 |
| FE-004 | PREJOB 解锁为纯前端门禁 | Medium→Info | ✅ | N-A | ✅ 复现 | **确认降级** | **Info** | 我独立实测 6 个 locked action 全部 403「模块未解锁」，服务端门禁真实；同意 Lead 降级；详见 §2.4 |
| FE-005 | PREJOB 写操作无 CSRF token | Medium | ❌（未实测，作者自认"我没有实测"） | ❌ | ❌ **我复现失败** | **挑战：不成立** | **Info** | **决定性反驳**：服务端强制 `application/json`，三种浏览器可发类型全 415；预检 405 且无 ACAO；GET 写操作 405。链路三处全断；详见 §2.5 |
| FE-006 | 敏感端点无速率限制 | Info | ✅ | N-A | ✅ 复现 | **确认** | **Info** | unlock 限速确实存在；但「AI 生成端点未见限速」未实测，我未跨红线验证；详见 §2.6 |
| F-01 | 端点无需认证 | Low/Info | ✅ | N-A | ✅ 复现 | **确认** | **Low** | 我复现：无 Cookie 200 + 空骨架 + 新发 PHPSESSID，确非「读他人数据」；详见 §2.7 |
| F-02 | ai_status 泄露 model | Info/Low | ✅ | N-A | ✅ 复现 | **确认** | **Info** | `masked` 为空串；仅泄露供应商+模型名，无攻击路径 |
| F-03 | action 白名单分发良好 | 正面 | ✅ | N-A | ✅ 复现 | **确认** | **Info（良好设计）** | 未知 action 404、`..`/`<script>` 403 |
| **F-04** | **job_type 中文变 `??` 乱码** | **Low** | ❌ | ❌ | ❌ **我复现失败** | **挑战：假阳性** | **撤回** | **决定性反驳**：我字节级证明是 PowerShell 5.1 客户端编码问题。curl.exe + 显式 UTF-8 三重复测，`全`=`E5 85 A8` 原样回显；详见 §2.8 |
| **F-05** | **写操作无 CSRF（`SameSite=None`+可跨站写）** | **Medium** | ❌（仅用自制请求，未验浏览器可达性） | ❌ | ❌ **我复现失败** | **挑战：不成立** | **Info** | 同 FE-005，同一根因；详见 §2.5 |
| F-06 | id 自增可预测 | 前置条件 | ✅ | N-A | ✅ 复现 | **确认** | **Info** | 非独立漏洞，作者自述正确 |
| F-07 | IDOR 防护有效（正面） | 正面 | ✅ | ✅（跨会话对照） | ✅ 复现 | **确认** | **Info（良好设计）** | 我双会话交叉验证：B 看不到 A 数据；详见 §2.9 |
| F-08 | unlock 有速率限制 | Low | ✅ | N-A | ✅ 复现 | **确认** | **Low** | 我实测第 6 次 429「593 秒」；换新会话回到 403，按会话计数可绕证实 |
| F-09 | 类型混淆被正确处理 | 正面 | ✅ | N-A | ✅ 复现 | **确认** | **Info（良好设计）** | 数组/true/0/null 全 403 |
| F-10 | 存储型 XSS 不成立 | 正面 | ✅ | N-A | ✅ 复现 | **确认** | **Info（良好设计）** | 我独立确认 `v-html` 命中 = **0** |
| F-11 | 无 CORS 头 | 正面 | ✅ | N-A | ✅ 复现 | **确认** | **Info（良好设计）** | 我实测 `/api.php` 无 ACAO；这条正是推翻 F-05 的关键之一 |
| F-12 | 响应头缺 CSP/XFO | Low~Medium | ✅ | N-A | ✅ 复现 | **确认降级** | **Low** | 事实与我实测一致 |
| LB-001 | PATHOT 缺4头+无frame-busting | Low | ✅ | N-A（主动封顶） | ✅ 复现 | **确认** | **Low** | 定级正确；与 FE-002 的差异见 §2.16.4 |
| LB-002 | XM 缺 HSTS | Low | ✅ | N-A | ✅ 复现 | **确认** | **Low** | 我实测 XM 确缺 HSTS；HTTP→301 缓解成立 |
| LB-003 | SM-PAGES CSP 放行 localhost:* | Info | ✅ | N-A | ✅ 复现 | **确认** | **Info** | 无注入点，风险不落地，定 Info 正确 |
| LB-004 | 暴露 workers.dev 后端 | Info | ✅ | N-A | ✅ 复现 | **确认** | **Info** | 真实攻击面；作者未越界发请求，纪律到位 |
| LB-005 | PATHOT 有后端 API 面 | Info | ✅ | N-A | ✅ 复现 | **确认（并纠正我自己的矩阵）** | **Info** | 我 OPTIONS 复核确认；我的 PATHOT×C1=N-A 已更正，见 §2.16.1 |

**统计**：复核 **24 条**（frontend 6 + lead 12 + sites 5 + 复核员独有 1）→ 确认 17 条（含正面结论与 sites.md 的全部 5 条）、确认降级 1 条（FE-004）、挑战不成立/假阳性 3 条（FE-005、F-04、F-05）、降级 2 条（FE-001、F-12）。**FE-002 经复议由 Low 改判 Medium**（见 §2.15）。**另：sites.md 的 LB-005 使我发现并更正了自己矩阵的一处错误**（PATHOT×C1 原标 N-A，实有账号体系），见 §2.16.1。

---

## 2. 逐条复核详情

### 2.1 FE-001（High → Low）：无 CSP + lucide 无 SRI

**我的复核结论：事实成立，严重度降级为 Low。**

逐项核对：
- ✅ **事实部分我独立复现**：`body.bin` 第 11 行确有 `<script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>`；`integrity` 命中 **0**、`crossorigin` 命中 **0**（我自己跑的 Select-String）。
- ✅ 缺 CSP 也确实（我的响应头实测）。
- ❌ **但 High 不成立**，理由三条：
  1. **无 marker 证明影响发生**（ROE §5.3）。本类配置缺陷原则上可用 marker 证明——例如注入一个受控脚本证明无 CSP 时能执行——但本报告没有任何此类证据。按 R3 应降级。
  2. **可利用性依赖第三方被投毒**（unpkg 账号被接管 / CDN 劫持 / 中间人）。这是**供应链条件概率事件**，不是「输入即可打」的漏洞。ROE §6 的 High 判据是「越权访问他人数据 / 存储型 XSS / 鉴权绕过」——本条三者皆不满足。
  3. 作者自己写了「属于供应链与中间人场景，不是『直接输入就能打』的漏洞」——**这恰恰是 T1/T4 的自我承认**，却仍定 High，属严重度与自述矛盾。
- 另需指出：`https://unpkg.com` 在 **SCOPE §3 排除清单**里（第三方公共基础设施，无授权）。我**未向 unpkg 发任何请求**，也未验证其是否真返回恶意内容——这一步在本次授权内不可做，因此「投毒即控页」永远只是假设。
- **复核后：Low**（配置加固项，符合 §6「Low：配置加固项」）。若将来能证明 unpkg 返回被篡改内容，可回升。

### 2.2 FE-002（**维持 Medium** — 复议后改判，原判 Low 已作废）：缺 X-Frame-Options / frame-ancestors

> ⚠️ **本条我在第一轮判了 Low，经 Lead 质询后我重新核对 ROE §6，认为原判有误，改判 Medium。**
> 改判的完整论证见 **§2.15**。此处保留改判记录以免读者困惑。

**事实部分（两轮均确认，无争议）**：
- ✅ 我独立复现：PREJOB 首页 200 响应**无** `X-Frame-Options`、**无** `Content-Security-Policy`（是完全缺失，不是畸形）。
- ✅ 我两次独立验证无 frame-busting：`body.bin` **和** `app.js` 中 `top!==self` / `top.location` / `frameElement` / `ancestorOrigins` / `window.top` / `parent!==self` / `self!==top` **命中全部为 0**。

**我第一轮判 Low 的理由（现认为站不住）**：
1. 「需强诱导交互」——但 ROE §6 的 Medium 判据（「缺失关键安全头且可被利用」）**并未要求「无需交互」**。CSRF 同样需要受害者访问恶意页，而 §6 明确把 CSRF 列为 Medium。**我用了一个 §6 里不存在的附加条件来降级，这是判据误用。**
2. 「非高价值账户体系」——§6 没有「按资产价值再分档」的规则，这是我自己加的。
3. 「无数据外泄证明」——点击劫持的危害是**代用户执行操作**（含 `delete_offer` 删数据），不是外泄数据。用「无外泄」作降级理由，**类比对象错了**。

**改判 Medium 的完整判据**见 §2.15（含 §6 两个合取项的逐项验证、两个反向因素的诚实披露）。

**我仍坚持的一点**：若最终报告要求「可被利用」必须有 **marker 级浏览器 PoC**，则应保留 Low，但**必须同时撤掉「点击劫持可行」的表述**，改为纯「配置缺失」。**不能既声称可行、又定 Low**——那才是真正的判据不自洽。

**复核后：Medium**（附条件：缺浏览器端到端 PoC；Safari/Firefox 因 3P Cookie 阻断影响有限）。

### 2.3 FE-003（Info）：SM-CCCD 净化链 —— 确认

**完全确认，作者的「安全」判定正确。**

我逐字核对了原始 JS（`evidence/live/SM-CCCD/assets/assets_index-DeOWrzoz.js`）：
- `DV={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}` —— 五字符覆盖完整 ✅
- `function wo(e){return String(e).replace(/[&<>"']/g,t=>DV[t])}` ✅
- `function ei(e){...const o=fg(r);return/^https?:\/\//i.test(o)?`<a href="${wo(o)}" ...>`:n}` —— 协议白名单 + href 二次转义 ✅
- `dangerouslySetInnerHTML` 出现 **2** 次，与作者标注的 @876872 / @880381 一致 ✅
- `nE()` 入口即 `wo(String(e||""))` 全量转义 ✅

**这是本次审计里质量最高的一条**：作者没有因为 `dangerouslySetInnerHTML` 就报 XSS，而是逐层验证了净化链并给出「不可利用」结论，还附了防御性建议。这种「扫描器会报、人工核验后不报」的判断正是复审要保护的。

### 2.4 FE-004（Medium → Info）：解锁门禁 —— 确认降级

**我完全独立复现，并同意 Lead 的降级结论。**

我的实测（`verify2/unlock-gate-enforcement.txt`）——用**我自己的新会话**，先确认 `unlock_status` 返回 `{"unlocked":[]}`，然后 POST `/generate.php?action=<x>`：

```
career_plan     → 403 {"ok":false,"error":"模块未解锁，请先输入内测密码"}
intention_eval  → 403 同上
grad_compare    → 403 同上
offer_compare   → 403 同上
overseas_report → 403 同上
qa_answer       → 403 同上
```

我又独立读了 Lead 的 `gate/unlock-gate-verification.txt`，其 `/stream.php` 路径结论一致（9 个受保护 action 全 `event: error`）。

**结论**：服务端门禁**真实存在**。前端 `unlocked` 仅控制 tab 切换，属**纵深防御缺失**，不是安全边界突破。攻击者得不到任何未授权能力 → **Info 正确**。

补充两点我的独立判断：
1. 作者原报告写「从 `/api.php` 各 action 无需认证的既有事实看，可能性不低」——这是**推断而非证据**，若不复核就可能误报 Medium。这正是 T4（静态推断当实测）的典型，值得记录为方法论教训。
2. 对照组的 `ai:false` 是重要事实：**当前部署未接真实 LLM**，因此「消耗站长 DeepSeek 额度」的危害在当前环境**不成立**。但我在报告中保留一句限定：**若将来接入真实模型，该防护缺失会转化为真实成本风险**——这是有效的加固建议，不是当前漏洞。

### 2.5 FE-005 / F-05（Medium → 不成立）：CSRF —— **我的最重要挑战**

**这是本次复核中我推翻的最重的一条。两位发现者（frontend.md 与 lead-workbuddy-direct.md）都把 CSRF 定为 Medium，但实际攻击链在三个环节全部断裂。**

我的实测证据：`verify2/csrf-contenttype-analysis.txt`、`verify2/csrf-preflight-and-get.txt`

**测试设计**：用同一会话，分别以浏览器**跨站表单实际能发出的四种 Content-Type** 发起 `save_profile` 写操作，并带 `Origin: https://evil.example`、`Referer: https://evil.example/`：

| # | Content-Type | 浏览器跨站表单能否发出 | 服务端结果 |
| :-- | :--- | :--- | :--- |
| A | `application/json` | ❌ 不能（表单无此类型） | **200 写入成功**（但浏览器发不出） |
| B | `application/x-www-form-urlencoded` | ✅ 能（且无预检） | **415 `需要 Content-Type: application/json`** |
| C | `text/plain` | ✅ 能（且无预检） | **415 同上** |
| D | `multipart/form-data` | ✅ 能 | **415 同上** |

**三个断裂点**：
1. **Content-Type 强校验**：服务端只接受 `application/json`。浏览器 `<form>` 无法发出 `application/json`（HTML 规范只允许三种 enctype）。→ 传统表单 CSRF **直接被 415 挡死**。
2. **预检被拒**：若改用 `fetch()` 发 `application/json`，跨源会触发 CORS 预检。我实测 `OPTIONS` → **405**，且**无 `Access-Control-Allow-Origin`**。→ 预检失败，浏览器不发送实际请求。
3. **GET 不能写**：`save_profile` / `add_offer` / `delete_offer` / `save_test` 的 GET 请求全部 **405 `写操作仅允许 POST`**。→ 排除了 `<img src>` / `<script src>` 型 CSRF。

**因此**：`SameSite=None` 确实让 Cookie 可跨站携带（这点作者没说错），但**没有可用的写入通道**，Cookie 带过去也没用。CSRF **不成立**。

**对两位发现者的具体批评**：
- `frontend.md` FE-005 自己在第 326-327 行写了「标准 JSON-CSRF 被 CORS 挡住」「若服务端接受 urlencoded 表单则成立」——**它已经识别出关键变量，却没有去验证**，然后仍定 Medium。第 337 行自认「我没有实测」。`ROE §7` 明确「只报告已验证的问题；未验证的写进未确认线索」。→ 违反 §7，且严重度建立在未验证的假设上。
- `lead-workbuddy-direct.md` F-05 写「Post 携带 `Origin: https://evil.example` → 返回 200 且写入成功」——**这个测试本身是真的，但它证明的不是 CSRF**。它证明的是「服务端不校验 Origin」，而 CSRF 的成立条件还包括「攻击者能让受害者的浏览器发出这个请求」。Lead 用自制 HTTP 客户端直接发 JSON，绕过了浏览器同源策略这个决定性约束。**这是把「服务端不校验」误当成「浏览器可达」**——T4 的变体。

**复核后：三条合流为一条 Info 级观察**——「服务端不校验 Origin/Referer，且 Cookie 为 `SameSite=None`；但 Content-Type 强制 JSON + 无 CORS 头 + 写操作仅 POST 三重限制使标准 CSRF 不可行。建议补 CSRF token 作为纵深防御。」这是诚实的表述。

### 2.6 FE-006（Info）：速率限制 —— 确认

- ✅ 我独立复现：同会话连续 6 次错误口令，**第 6 次**返回 `429 {"ok":false,"error":"尝试次数过多，请 593 秒后重试"}`（`verify2/ratelimit-test.txt`）。
- ✅ 我独立复现了「按会话计数」：换全新会话后立刻回到 **403**（不是 429）→ 限速按 `PHPSESSID` 计，可丢弃 Cookie 绕过。
- ✅ 作者对 `SCOPE.md` §2.1「未见限速」的纠正**是正确的**，这个自我纠错值得肯定。
- ⚠️ 但「`/generate.php`、`/stream.php` 未见限速」这一条**作者未实测**，我也**未实测**——因为测试它会消耗对方 API 额度（SCOPE §2.3 红线）。按 T4，**未验证不得断言**。我把它保留为 Info 级「未确认线索」，明确标注「未测」。

### 2.7 F-01（Low/Info）：端点无需认证 —— 确认

- ✅ 我独立复现：无 Cookie `GET /api.php?action=get_profile` → **200** + `{"ok":true,"data":{"job_type":"全职","education":"","…"}}`，且响应 `Set-Cookie` **新发一个 PHPSESSID**。
- **关键定性**：返回的是**空骨架**，不是他人数据。这正是 T5 要区分的两件事——「不需要登录就能用」≠「能看到别人数据」。
- 作者定 Low/Info 且明说「不得报 High」，**判断正确**。
- 我的补充：这本质是**无账号体系的单用户工具**的设计取向，其真实风险仅在「资源滥用」（配合未接 LLM 的现状，当前无实际损失）。**Low 合适，Info 亦可接受**。

### 2.8 F-04（Low → 撤回）：job_type 乱码 —— **假阳性，必须撤回**

**这是我对 Lead 的直接挑战。**

Lead 报告 F-04：`POST save_profile {"job_type":"全职"}` → 回读得 `"job_type":"??"`，判定「服务端编码处理缺陷」，定 Low。

**我的实验结果**：同样的请求，我第一次也看到了 `"??"`。但作为复核员，我要求自己先怀疑**测量工具**而不是被测系统：

1. **第一次复现**（`verify2/idor-cross-session.txt`）：用 `Invoke-WebRequest -Body <字符串>` → 得到 `"job_type":"??"`。看似复现成功。
2. **但 PowerShell 5.1 的 `-Body <string>` 默认按 ASCII/Latin-1 编码发送**，中文在发出前就已损坏。
3. **自查实验**（`verify2/encoding-selfcheck.txt`）：改用 `[System.Text.Encoding]::UTF8.GetBytes($json)` 显式发字节，并**打印实际发出的 HEX**——确认 `全` 为 `E5 85 A8`（正确 UTF-8）。结果：`"job_type":"全职"` **原样回显**。再取响应**原始字节**：HEX 中 `6A 6F 62 5F 74 79 70 65 22 3A 22 E5 85 A8 E8 81 8C 22` = `"job_type":"全职"`，**无任何 `0x3F`（`?`）**。
4. **第三重确认**：改用 `curl.exe`（`--data-binary` + UTF-8 无 BOM 文件）→ POST 与回读**都正常显示中文**。

**结论**：`"??"` 是 **PowerShell 客户端编码造成的假阳性**，服务端 UTF-8 处理**完全正确**。Lead 与我用了同一套工具链（PowerShell 5.1），几乎必然踩同一个坑。

**判定：F-04 撤回。** 这不是数据完整性缺陷，服务端无此问题。若最终报告保留此条，将是**本次审计最典型的工具误报**。

### 2.9 F-07（正面）：IDOR 防护 —— 确认

- ✅ 我独立双会话验证（`verify2/idor-cross-session.txt`）：会话 A 写入唯一 marker `MXOS-IDOR-45RLZTIX`；会话 B 回读 `get_profile` → `education:""`，**看不到 A 的 marker**（`B 能看到 A 的 marker: False`）。
- ✅ 会话 B `list_offers` → `[]`，看不到 A 的数据。
- ⚠️ 我的 offer 完整链路测到一半：`add_offer` 返回 `400 {"ok":false,"error":"公司名称与岗位为必填"}`（字段名与 Lead 用的不同），故**未能亲自复现「B 删 A 的 offer → 404」这一步**。但「跨会话读不到」已足以否定「可读他人数据」类 IDOR。
- **判定：确认「对 get_profile / list_offers 无 IDOR」**；`delete_offer` 的归属校验我**未独立复现**，采信 Lead 的证据但标注「复核员未独立复现该子项」。

### 2.10 关于 SHA256 SPA-fallback 的独立验证 —— 完全确认 Lead

我独立重算了 SHA256（`verify2/` 输出）：

```
/                       200  903B  4B7E2D8E08A3BB27E3006FC4
/composer.json          200  903B  4B7E2D8E08A3BB27E3006FC4  => IDENTICAL
/debug.php              200  903B  4B7E2D8E08A3BB27E3006FC4  => IDENTICAL
/info.php               200  903B  4B7E2D8E08A3BB27E3006FC4  => IDENTICAL
/vendor/autoload.php    200  903B  4B7E2D8E08A3BB27E3006FC4  => IDENTICAL
/nonexistent-MXOS-9999  200  903B  4B7E2D8E08A3BB27E3006FC4  => IDENTICAL  ← 关键：连不存在的路径也是同哈希
```

**确认 Lead 的方法论提醒完全正确**：该站是 catch-all SPA fallback，任何未命中的路径都返回首页。`/nonexistent` 与首页同哈希是决定性佐证——**不存在敏感文件泄露，不得报路径泄露**。

我同时把这个判据用在了 **sourcemap** 上，见 §2.11。

### 2.11 我发现的另一个同类陷阱：sourcemap 全部假阳性

我自己最初写的探测脚本以「HTTP 200 + 响应体非空」判为 sourcemap 存在，结果 4 个站全部「命中」——**这个判定是错的，我当场修正了**。

正确判据（`verify2/sourcemap-VERDICT-corrected.txt`）：

| 站 | 状态码 | Content-Type | 可 JSON 解析 | 含 sourcesContent | 判定 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| SM-PAGES | 200 | `text/html` | ❌ | ❌ | **非 sourcemap**，SPA fallback |
| XM | 200 | `text/html` | ❌ | ❌ | **非 sourcemap**，SPA fallback |
| SM-CCCD | 200 | `text/html` | ❌ | ❌ | **非 sourcemap**，SPA fallback |
| PREJOB | 200 | `text/html` | ❌ | ❌ | **非 sourcemap**，SPA fallback |

**结论：5 个站均不存在 sourcemap 泄露。** 这是我用差点误报的一次经历，反过来印证 T8 的必要性——**只看 200 就是误报**。

---

### 2.12 F-03 / F-10 补充实测（我做得比原报告更细）

**F-03 action 白名单 —— 确认，且无 PHP 报错泄露**（`verify2/action-whitelist-errors.txt`）：

| 输入 action | 状态 | 响应 |
| :--- | :--- | :--- |
| 空 | 404 | `{"ok":false,"error":"未知操作"}` |
| `nonexistent_xyz` | 404 | 同上 |
| `../etc/passwd` | **403** | 空 |
| `../../../../etc/passwd` | **403** | 空 |
| `%00` | 404 | 未知操作 |
| `<script>alert(1)</script>` | **403** | 空 |
| `action` | 404 | 未知操作 |

**我额外验证了报错是否泄露**：全部响应中 `Fatal error` / `Warning:` / `Stack trace` / `/var/www` / `/home/` / `.php on line` **命中 0** → 无 PHP 错误/路径泄露。这是原报告没做的检查，**结论是正面的**。

**F-10 存储型 XSS —— 确认不成立，且我给出了比原报告更精确的归因**（`verify2/xss-waf-test.txt`）：

| payload | 写入结果 | 回读 |
| :--- | :--- | :--- |
| `<img src=x onerror=alert(document.domain)>` | **403 腾讯云 WAF 拦截页**（含「WAF拦截页面」标题 + 请求 UUID） | 未落库，`self_eval:""` |
| `<script>alert(1)</script>` | **403 WAF 拦截页** | 未落库 |
| `<svg onload=alert(1)>` | **403 WAF 拦截页** | 未落库 |
| **对照**：`MXOS-XSS-CONTROL-9a3f`（纯文本） | **200 写入成功** | **逐字回显** |
| **对照**：`正常文本测试`（中文） | **200 写入成功** | **逐字回显** |

**这组对照非常关键**——它证明：
1. **写入通道本身完全正常**（对照组 200 且逐字回显），所以 403 确实来自内容检测而不是接口坏掉。
2. 拦截者是**腾讯云 WAF**（`<title>WAF拦截页面</title>`、`api.waf.qq.com/waf-attack-feedback`、请求 UUID），**不是应用层代码**。原报告只说「被 WAF 拦截」，我确认了**是哪个 WAF**。
3. 这让结论从「我试了被拦」升级为「**我证明了写入正常，而内容被 WAF 拦**」——证据强度更高。

**我保留一句限定**：WAF 拦截意味着**当前可用 payload 被特征匹配**，不等于「XSS 不可能存在」。若 WAF 规则被绕过（编码变形、非常规标签、Unicode 转义等），仍需依赖前端转义兜底。而 `v-html` 命中 **0**（我独立确认 = 0），Vue `{{ }}` 默认转义 → **纵深防御完整**。这是正面结论。

### 2.13 一次我自己的测量故障（诚实记录）

跑 F-10 时 PowerShell 首次抛 `未能解析此远程名称` + `操作超时`。我**没有直接记成「目标不可达」**，而是先诊断：
- `Resolve-DnsName` → 正常解析到 `49.233.240.214`（腾讯云 CLB）
- `curl` 直连 → **200**，DNS 耗时 0.000047s
- 其余 4 站 → 全部 200
- `Test-Connection` → 49ms

**结论：瞬时网络故障，非目标下线。** 改用 `curl.exe` 重跑成功。记此一笔是因为——**若不做诊断，就可能误报「目标不可用」或漏测**。这与 F-04 是同一类教训：**先怀疑测量工具，再怀疑被测系统**。

### 2.14 【重要更正】响应头差异的真正归因：**按状态码分支，不是按文件**

Lead 提出「同一主机 cookie 策略不一致：`/` 和 `/api.php` 是 `SameSite=None`，而 `/generate.php` 是 `SameSite=Lax` + `X-Frame-Options: SAMEORIGIN`」，并据此推断「不是团队不懂，是首页和 api/stream 漏配」。

**我独立复测后认为这个归因不成立**，真正规律是**按 HTTP 状态码分支**。各采样 3 次，结果 100% 稳定（`verify2/header-stability.txt`、`verify2/header-by-branch.txt`）：

| 请求 | 状态码 | SameSite | X-Frame-Options | CSP `frame-ancestors` |
| :--- | :--- | :--- | :--- | :--- |
| `/`（首页 HTML） | **200** | `None` | **无** | **完全无 CSP** |
| `/api.php?action=get_profile` | **200** | `None` | **无** | **`'none' *`（畸形）** |
| `/api.php?action=save_profile` POST | **200** | `None` | **无** | **`'none' *`（畸形）** |
| **`/generate.php?action=advice` POST** | **200** | **`None`** | **无** | **`'none' *`（畸形）** |
| `/stream.php?action=career_plan` POST | **200**（SSE） | `None` | **无** | **`'none' *`（畸形）** |
| `/api.php` 未知 action | 404 | `Lax` | **有** `SAMEORIGIN` | 正常 `'none'` |
| `/api.php` 写 action 用 GET | 405 | `Lax` | **有** `SAMEORIGIN` | 正常 `'none'` |
| `/api.php` POST 坏 Content-Type | 415 | `Lax` | **有** `SAMEORIGIN` | 正常 `'none'` |
| `/generate.php?action=career_plan` 未解锁 | 403 | `Lax` | **有** `SAMEORIGIN` | 正常 `'none'` |

**结论（三点，都比 Lead 的原判断更准确）**：

1. **`/generate.php` 并没有"配对正确"**。Lead 观察到它有 `XFO + Lax`，是因为他那次发的是 **GET → 405 错误分支**。走 **200 成功分支**时，`/generate.php` 与 `/api.php`、`/stream.php`、首页**完全一样**：`SameSite=None`、无 XFO、CSP 畸形。→ 「团队已知修复方式，只是漏配两处」这个推断**缺乏依据**。

2. **真正的缺陷是结构性的：安全响应头只挂在错误处理分支上，成功分支全部缺失。** 这是一个单点代码结构问题（多半是把安全头写进了错误处理器/异常分支），不是"漏配三个文件"。→ 修复建议应改为「把安全头移到统一出口（before-send 钩子/中间件），确保所有状态码路径都下发」，比"给首页补 XFO"更对症。

3. **200 分支的 CSP 是畸形的**：`frame-ancestors 'none' *`。按 CSP3，`'none'` 必须独占，与其他源并列则**该指令被丢弃**。所以 200 分支上 `frame-ancestors` **实际不生效**；而非 200 分支是合法的 `frame-ancestors 'none'`，**生效**。→ 讽刺的是：**防护只存在于攻击者不太关心的错误页上**。

**顺带一个「歪打正着」的意外缓解**：同一主机对同一个 `PHPSESSID` 在 200 时发 `SameSite=None`、非 200 时发 `SameSite=Lax`。浏览器收到后者**会更新该 Cookie 的属性**。即受害者只要触发任一错误响应（404/405/415），其 `PHPSESSID` 就被改写为 `Lax`，**临时削弱跨站携带条件**。但这不稳定、不可依赖，反而说明 Cookie 下发逻辑分散在至少两处——**这本身是需要修的代码质量问题**。

**我同意 Lead 的一点**：`/api.php` 的 JSON 响应即使 `frame-ancestors` 畸形也不构成实际危害（`Content-Type: application/json` + `default-src 'none'`，浏览器不渲染为页面，iframe 嵌 JSON 无渲染汇点）。所以 **R2×C8 保持 Info 是对的**，但理由写「JSON 无渲染汇点」，不写「CSP 非法所以危险」。

**但首页不同**：`200 text/html` + 无 XFO + 完全无 CSP + frame-busting = 0 → **有渲染汇点、可被嵌入**。见 §2.15。

### 2.15 FE-002 严重度：**我建议升 Medium**（给出 ROE §6 判据）

Lead 倾向保持 Low，并请我在有异议时给出 §6 对应判据。**我有异议，建议 Medium。**

**ROE §6 原文**：

> | Medium | 反射型 XSS、CSRF、敏感信息泄露、**缺失关键安全头且可被利用** |
> | Low | 配置加固项、信息性泄露、低影响头缺失 |

§6 的 Medium 判据是**合取式**：「缺失关键安全头」**且**「可被利用」。逐项验证：

| 合取项 | 我的实测证据 | 是否满足 |
| :--- | :--- | :--- |
| ① 缺失**关键**安全头 | 首页 200 响应**无** `X-Frame-Options`、**无** `Content-Security-Policy`（是完全没有，不是畸形） | ✅ |
| ② **可被利用** | ①无 frame-busting：`top!==self`/`top.location`/`frameElement`/`ancestorOrigins`/`window.top` 在 `body.bin` **和** `app.js` 中命中**全部为 0**（我独立跑了两遍）②`SameSite=None` 使跨站 iframe 携带会话 ③被保护动作是**单击即可触发**的敏感操作：`save_profile`（覆盖简历）、`add_offer`/`delete_offer`（增删 Offer，**含数据删除**）、触发 AI 生成 | ✅ |

**为什么不能套用「纯静态站→Low」的规则**：Lead 早前的原则是「纯静态站缺 HSTS/CSP → Low/Info」。但 **PREJOB 是本次唯一的服务端资产**，有会话 Cookie、有状态变更接口、有数据删除能力。它不是纯静态站，该规则不适用。

**为什么不算「低影响头缺失」**：`X-Frame-Options`/`frame-ancestors` 在**承载会话的 HTML 页面**上属高影响类——它直接决定「第三方能否把你的已认证界面伪装成自己的界面」。这与「缺 HSTS 但已 301」「缺 XCTO 但无上传」性质不同。

**我必须诚实披露的两个反向因素**（这是判 Medium 而非 High 的理由）：

1. **无浏览器端到端 PoC**：Lead 提供了 `clickjacking-poc.html`（iframe + 透明覆盖层，构造正确），但**没人用真实浏览器跑通并产生 marker**。按 ROE §5.3，「可被利用」这一半只有**配置层证据 + 标准攻击手法推论**，缺运行证据 → 不能 High。
2. **现代浏览器第三方 Cookie 阻断**：Safari（ITP）与 Firefox（ETP）默认阻断第三方 Cookie，跨站 iframe 里不带 `PHPSESSID`，受害者看到空会话界面，劫持价值大幅下降。Chrome/Edge 仍在灰度淘汰 3P Cookie → 也不支持 High。

**我的建议（二选一，不能含糊）**：
- **面向「配置正确性 + 攻击面评估」→ 定 Medium**，理由「§6 Medium 的两个合取项均满足」，注明「未做浏览器端到端 PoC；Safari/Firefox 因 3P Cookie 阻断影响有限」。
- **若要求「可被利用」必须有 marker 级运行证据 → 可保持 Low**，但**必须把该条定性为「frame-ancestors/XFO 配置缺失」，不能再声称「点击劫持可行」**。不能既说可行又定 Low。

**我倾向 Medium**：「配置缺失」本身是 100% 确定性事实（响应头是二进制事实，不需要 marker 证明它缺失），而第二项「可被利用」已由「无 frame-busting + SameSite=None + 单击敏感操作」三要素支撑。

> **若采纳 Medium，最终清单变为：Critical 0 / High 0 / Medium 1 / Low 4 / Info 11。** 此变化影响报告 headline，必须明确。

### 2.16 `sites.md`（4 站黑盒）复核 —— 质量高于本批平均，但纠正 1 处判据 + 我方矩阵 1 处错误

**复核结论：5 条 finding 全部认可其定级（Low×2 / Info×3），无一条需降级或推翻。** 但发现两件事：

#### 2.16.1 ✅ PATHOT 有真实后端 API 面 —— 我独立确认，且**这推翻了我自己的矩阵**

sites.md LB-005 声称 PATHOT 存在 `/api/account/*` 与 `/api/summarize`。我用 OPTIONS + 三组随机对照独立验证：

```
OPTIONS /api/summarize          -> 204   ← 存在
OPTIONS /api/account/login      -> 204   ← 存在
OPTIONS /api/account/me         -> 204   ← 存在
OPTIONS /api/account/register   -> 204   ← 存在
OPTIONS /api/hot                -> 405   ← 不存在
OPTIONS /api/mxos-random-9284   -> 405   ← 我加的随机控制组
OPTIONS /definitely-not-a-route -> 405   ← 我加的随机控制组
```

**204/405 有明确区分性 → sites.md 的结论成立，我确认。**

**但这条同时暴露我自己的错误**：我在 `coverage-matrix.md` 里把 **PATHOT×C1(认证) 标为 N-A**，理由是「纯静态站无账号体系」。**这是错的。** 已更正为「测了-有发现」，并连带把 PATHOT×C3 由 N-A 改为 ✅无。

更正后覆盖算术由 `9发+54无+51N-A` 变为 **`10发+55无+49N-A`**，M′ 由 63/120(52.5%) 变为 **65/120(54.2%)**。全表已同步重算。

**我额外补了一条 sites.md 漏掉的正面证据**：`GET /api/account/me`（无凭据）→ `200 {"ok":false,"reason":"NO_SESSION"}`。**这是正确的认证设计**——明确拒绝、不泄露数据、语义清晰。sites.md 只测了 OPTIONS 没测 GET，漏了这个正面结论。

#### 2.16.2 ⚠️ 「OPTIONS 204 = 路由存在」这一判据**站间不可移植**

sites.md 用「`/api/` → 204」论证 SM-CCCD 有服务端逻辑。我实测各站的区分性：

| 站 | 真实路由 | 保证不存在的路径 | 可否区分 |
| :--- | :--- | :--- | :--- |
| PATHOT | 204 | 405 | ✅ **可区分** |
| SM-PAGES | 204 | **200**（fallback） | ⚠️ 弱 |
| SM-CCCD | 204 | **204** | ❌ **不可区分，204 是通配** |
| XM | **405** | 405 | ❌ 全 405，无 `/api` 面 |

→ 对 **SM-CCCD 是过度推断**。不过其**结论**（SM-CCCD 有服务端逻辑）仍成立——因为 `/api/` 确实返回真实 JSON `{"ok":true}`（11 字节，我在 SM-PAGES 上复现了同样结果）。**这里错的是论证方法，不是结论**。已写入 `verify2/sites-204-verdict.txt` 建议改写。

#### 2.16.3 我认可 sites.md 的四处高质量做法

1. **控制组法比我的更强**：它用「保证不存在的随机路径」取 fallback 指纹，而我的 §2.11 只比对了首页 SHA256。它的方法能防「首页与 fallback 因 A/B 或 UA 嗅探而不同」的情况。**这一点我采信并记录其优越性。**
2. **主动记录无效轮次**：§6.4 自曝 PowerShell 变量插值缺陷（`"$CANARY?mxos=1"` 中 `?` 被当作变量名字符，导致 canary 被截断成 `=1`），识别出 `%3D1` 异常后废弃整轮重跑。**这与我的 F-04 假阳性完全同类**——它自己发现了并写进报告，透明度高。
3. **拒绝凑数**：`ACAO: *` 判非漏洞并给三条理由（内容本就公开 / 与 ACAC 互斥 / 平台默认），还额外**实测出正面证据**——SM-PAGES `/api/` 是真 CORS 白名单：逐字反射合法 Origin、拒绝 `mxos-evil.example`、拒绝 `null`、**拒绝后缀欺骗 `xingmen-mentor.pages.dev.mxos-evil.example`**。这是本次少见的正面验证。
4. **未触碰越界资产**：发现 `academic-ai-worker.3335264558.workers.dev`（真实 Workers 后端，账号 ID 暴露）但**一次请求都没发**，只记录为攻击面并建议单独授权。**纪律执行到位。**

#### 2.16.4 一条必须在最终报告里解释清楚的差异

sites.md 的 LB-001（PATHOT 缺 4 头 + 无 frame-busting）定 Low 并主动封顶。**我认可这个封顶**——但它与我的 FE-002（PREJOB 点击劫持定 Medium）之间的差异必须解释，否则报告会显得自相矛盾：

| 维度 | FE-002 (PREJOB) | LB-001 (PATHOT) |
| :--- | :--- | :--- |
| 被保护会话 | ✅ 有 `PHPSESSID`，且 `SameSite=None` 跨站可携带 | ❌ 无会话 Cookie 证据 |
| 可被劫持的敏感操作 | ✅ `save_profile` / `delete_offer`（含删除） | ⚠️ 有登录表单，但**未证明登录态下可执行敏感操作** |
| 无 frame-busting | ✅ 命中 0 | ✅ 命中 0 |
| 结论 | **Medium** | **Low** |

**差异的正当理由**：PREJOB 有「已认证 + SameSite=None + 单击即删数据」三要素；PATHOT 只证明了「可被 iframe」，**没证明劫持后能干什么**。这不是双重标准，而是「可被利用」这一半的证据强度不同。**建议最终报告显式写出这张对照表**，避免读者质疑定级不一致。

---

## 3. 我的独立实测基线（基准尺，冲突时以可复现方为准）

证据目录：`pentest/evidence/verify2/`

### 3.1 五站响应头（我自己发的请求）

| 资产 | HTTP | HSTS | CSP | XFO | XCTO | Referrer-Policy | ACAO |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| SM-PAGES | 200 | ✅ `max-age=31536000; includeSubDomains; preload` | ✅ 严格，`frame-ancestors 'none'` | ✅ DENY | ✅ nosniff | ✅ strict-origin-when-cross-origin | `*` |
| SM-CCCD | 200 | ✅ 同上 | ✅ 同上 | ✅ DENY | ✅ nosniff | ✅ 同上 | `*` |
| XM | 200 | ❌ **缺** | ✅ 有，`frame-ancestors 'none'` | ✅ DENY | ✅ nosniff | ✅ 同上 | `*` |
| PATHOT | 200 | ❌ **缺** | ❌ **缺** | ❌ **缺** | ✅ nosniff | ✅ 同上 | `*` |
| PREJOB | 200 | ✅ `max-age=31536000; includeSubDomains` | ❌ **缺（主站）** | ❌ **缺** | ✅ nosniff | ✅ 同上 | **无** |

### 3.2 PREJOB `/api.php` 实测（重点）

| 项 | 我的实测结果 | 证据 |
| :--- | :--- | :--- |
| 响应头 | `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Strict-Transport-Security`、`Referrer-Policy`、`Set-Cookie: PHPSESSID=…; HttpOnly; Secure; SameSite=None`、`Server: CloudStudio Gateway` | `verify2/prejob-api-headers.txt` |
| **无 Cookie 请求 `get_profile`** | **200**，返回空资料骨架 `{"ok":true,"data":{"job_type":"全职","education":"",…}}`，并**新发一个 PHPSESSID** | 同上 |
| CORS | `/api.php` **未返回** `Access-Control-Allow-Origin`（与主站不同） | 同上 |
| CSP（JSON 端点） | `default-src 'none'; frame-ancestors 'none' *` ← **注意：`'none'` 与 `*` 并存，按 CSP3 该指令非法应被忽略**，属配置瑕疵 | 同上 |

> **关键定性（我的独立判断）**：`get_profile` 无 Cookie 返回 200 且返回**空骨架**，说明这是「按 PHPSESSID 隔离 + 新会话无数据」，**不是**「匿名可读他人数据」。这是 T5 的典型情形——「不需要登录就能用」≠「能看到别人数据」。任何把它报成 High 都好，须由发现者证明存在跨会话读取路径。

---

## 4. 复核汇总（阶段 3）

### 4.1 总数

| 项 | 数 |
| :--- | --: |
| 复核 finding 总数 | **19** |
| 确认（含正面结论，维持原级） | **11** |
| 确认降级（事实成立、严重度下调） | **2**（FE-004、F-12） |
| 降级（事实成立但不构成漏洞） | **2**（FE-001、FE-005/F-05 合流） |
| 挑战：假阳性 / 不成立 | **3**（F-04 撤回、FE-005、F-05） |
| 因证据不足降级者 | FE-005/F-05（未实测）、FE-001（无 marker） |

### 4.2 按严重度重排后的**最终清单**（我认可的版本）

| 级别 | ID | 说明 | 我的态度 |
| :--- | :--- | :--- | :--- |
| **High** | — | **本次无 High** | 没有一条 finding 达到 ROE §6 的 High 判据 |
| **Medium** | — | **本次无 Medium** | CSRF/门禁/XSS 三条候选均被我推翻或降级 |
| **Low** | FE-001 | 无 CSP + 第三方脚本无 SRI（供应链前提条件） | 证据扎实，但不可利用 |
| **Medium** | FE-002 | 首页缺 XFO/frame-ancestors，点击劫持可行 | 复议后升 Medium（§2.15）；缺浏览器端到端 PoC |
| **Low** | F-01 | 端点无认证（PHPSESSID 隔离，读不到他人数据） | 证据扎实 |
| **Low** | F-08 | unlock 限速按会话可绕（需先有口令强度问题） | 证据扎实 |
| **Low** | F-12 | 安全响应头缺失（并入 FE-001/FE-002 更好，避免重复计数） | 证据扎实 |
| **Info** | FE-003 | SM-CCCD 净化链完整 | **良好设计** |
| **Info** | FE-004 | 前端守卫可绕，服务端兜住 | **纵深防御建议** |
| **Info** | FE-006 | unlock 限速存在；AI 端点限速未测 | 部分未验证 |
| **Info** | F-02 | ai_status 泄露模型名 | 低价值信息 |
| **Info** | F-03 | action 白名单良好 | **良好设计** |
| **Info** | F-06 | id 自增（前置条件） | 非漏洞 |
| **Info** | F-07 | IDOR 防护有效 | **良好设计** |
| **Info** | F-09 | 类型混淆被正确处理 | **良好设计** |
| **Info** | F-10 | XSS 不成立（WAF + v-html=0） | **良好设计** |
| **Info** | F-11 | 无 CORS 头（限制攻击面） | **良好设计** |
| **撤回** | **F-04** | job_type 乱码 | **假阳性，工具误报** |
| **不成立** | **FE-005 / F-05** | CSRF | **三重阻断，攻击链不成立** |

> **合并建议**：F-12 与 FE-001/FE-002 内容重叠（都是响应头），建议合并为一条，避免同一致因被计三次而虚增发现数。

### 4.3 最扎实 / 最弱的发现

**最扎实（证据质量最高）**：
1. **FE-003**（SM-CCCD 净化链）—— 唯一给出完整净化链三要素 + 精确字节偏移 + 明确「不可利用」结论的条目。作者抵抗了「扫描器报 XSS」的诱惑，方法论正确。
2. **F-07**（IDOR 防护）—— 给出了完整跨会话对照实验（A 建 → B 删 → 404 → A 复查仍在 → A 自删清理），这是**教科书级的阴性结果证明**。
3. **F-10**（XSS 不成立）—— WAF 拦截 + `v-html` 计数 = 0 双重证据。

**最弱（必须整改）**：
1. **F-04**（job_type 乱码）—— **纯粹的客户端编码假阳性**，最弱的一条。用错了测量工具却未自查。
2. **FE-005 / F-05**（CSRF）—— 证据链**在浏览器可达性这个决定性环节完全缺失**。两位作者分别自认「未实测」和「用自制客户端测」，都把「服务端不校验」当成「浏览器能发」。这是**把服务端属性误当攻击可行性**，是本次最危险的误报模式（若被采纳为 Medium，会误导修复优先级并损害报告可信度）。
3. **FE-001**（High 定级）—— 事实对但严重度虚高两级；且其核心危害依赖对 **SCOPE §3 排除域（unpkg）** 的假设，而该假设在本次授权内**不可验证**。

### 4.4 我给最终报告的整改建议

1. **删掉 F-04**，或改写为「复核员实测证明服务端 UTF-8 正常，原报为客户端编码误报」。
2. **CSRF 三条合流为一条 Info**，明确写清三重阻断（JSON 强校验 / 预检 405 无 ACAO / GET 写 405），并说明「若未来放宽 Content-Type 校验则 CSRF 立即复活」——这才是对客户有价值的表述。
3. **FE-001 降到 Low**，并在措辞上明确「供应链投毒为假设前提，本次授权内无法验证 unpkg」。
4. **合并 F-12 进 FE-001/FE-002**，避免同一响应头缺陷被计三次。**FE-002 建议定 Medium**（见 §2.15 的 §6 判据论证）。
5. **保留并强调全部正面结论**（FE-003、F-03、F-07、F-09、F-10、F-11）——本次审计的真正价值在于「这些地方我们验过是安全的」，而不是凑发现数。
6. **SCOPE §2.1 的「4 次尝试未见限速」应更正**为「unlock 存在按会话的滑动窗口限速（约 5 次后 429，窗口约 600s），可按会话绕过」。

---

## 5. 最终交付清单（可直接抄进最终报告）

> **合并原则**：一条 finding = 一个根因。同因条目已合并，避免同一缺陷被计多次。
> **合并映射**：F-12（响应头缺失）并入 FE-001/FE-002；F-05 并入 FE-005→CSRF 观察；F-02 并入 FE-006 类的信息泄露观察（保留独立编号但同属「低价值信息」）。

### 5.1 LOW / MEDIUM 级（需要动手修的）

| 编号 | 标题 | 严重度 | 资产 | 一句话影响 | 证据路径 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **MX-01** | 首页缺 `frame-ancestors`/`X-Frame-Options`，点击劫持可行 | **Medium** | PREJOB `a9b81a7031ed59d7a.app.workbuddy.host` | 第三方可把已登录界面嵌入透明层诱导点击，触发 `save_profile`（覆盖简历）/`delete_offer`（删数据）等**单击即生效**的敏感操作；`SameSite=None` 使跨站 iframe 携带会话 | `verify2/headers-A5-PREJOB.txt`、`verify2/cookie-and-csp.txt`、lead `deep/clickjacking-poc.html` |
| **MX-02** | 第三方脚本无 SRI + 全站无 CSP | **Low** | PREJOB | `<script src="https://unpkg.com/lucide@0.469.0/...">` 无 `integrity`/`crossorigin`（各 0 次），且无 CSP 兜底；若 unpkg 被投毒/劫持，脚本可在本站源执行。**前提为第三方投毒，本次授权内无法验证** | `verify2/headers-A5-PREJOB.txt`、`evidence/live/PREJOB/baseline/body.bin:11` |
| **MX-03** | unlock 限速按会话计数，可丢弃 Cookie 绕过 | **Low** | PREJOB `/api.php?action=unlock` | 第 6 次触发 `429 请 593 秒后重试`，但换新 `PHPSESSID` 立即恢复 403 → 限速可绕；**但因未评估口令强度，不构成「可爆破」结论** | `verify2/ratelimit-test.txt` |
| **MX-04** | 敏感响应头只挂在错误分支，成功分支全部缺失 | **Low** | PREJOB 全部端点 | **本次最需修的代码结构问题**：200 分支 `SameSite=None` 且无 XFO、CSP 为畸形 `frame-ancestors 'none' *`（CSP3 下该指令被丢弃）；非 200 分支才是 `Lax`+`XFO: SAMEORIGIN`+合法 CSP。→ 防护只存在于错误页 | `verify2/header-by-branch.txt`、`verify2/header-stability.txt` |
| **MX-05** | 跨站读取面：`/api.php` 所有 action 无需认证即可调用 | **Low** | PREJOB `/api.php` | 无 Cookie 请求 `get_profile`/`get_tests`/`list_offers`/`unlock_status`/`ai_status` 均 200。**但数据按 `PHPSESSID` 隔离，新会话只得空骨架，读不到他人数据**；且无 CORS 头使跨站读取不可行 → 止步于「免登录可用」 | `verify2/prejob-api-headers.txt`、`verify2/idor-cross-session.txt` |
| **MX-06** | PATHOT 安全头四项全缺 + 无 frame-busting | **Low** | PATHOT `pat-hot.pages.dev` | 缺 CSP/HSTS/XFO/Permissions-Policy，页面零 frame-busting，可被任意 iframe 嵌入。**但未证明登录态下可执行敏感操作**，故 Low 而非 Medium（与 MX-01 的差异理由见 §2.16.4） | `evidence/live/PATHOT/baseline/headers.txt` |
| **MX-07** | XM 缺 HSTS | **Low** | XM `xingmen-mentor.pages.dev` | 首访存在 SSL-strip 窗口；**已实测 HTTP→301 强制跳转 + CSP `upgrade-insecure-requests`，缓解成立** | `verify2/headers-A3-XM.txt` |

### 5.2 INFO 级（观察项 / 攻击面记录 / 正面结论）

| 编号 | 标题 | 严重度 | 资产 | 一句话影响 | 证据路径 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **MX-08** | CSRF 不可行（三重阻断） | **Info** | PREJOB 全部写 action | 三种浏览器可发表单类型全 **415**（强制 JSON）；预检 **405 且无 ACAO**；GET 写操作 **405**。**若将来放宽 Content-Type 校验，CSRF 立即复活** | `verify2/csrf-contenttype-analysis.txt`、`verify2/csrf-preflight-and-get.txt` |
| **MX-09** | 前端守卫可绕，服务端兜住 | **Info** | PREJOB 前端 `app.js` | `unlocked` 仅控制 tab 切换；但 `/generate.php`/`/stream.php` **服务端独立校验**，6 个受保护 action 未解锁全 **403「模块未解锁」** → 纵深防御缺失，非边界突破 | `verify2/unlock-gate-enforcement.txt` |
| **MX-10** | CSP 放行 `http://127.0.0.1:*`/`localhost:*` 任意端口 | **Info** | SM-PAGES / SM-CCCD | 桌面桥设计意图；仅在有注入点时才能探测本机端口，**本次未发现任何注入点** | `evidence/sites/` LB-003 |
| **MX-11** | CSP 暴露真实后端 `academic-ai-worker.3335264558.workers.dev` | **Info** | SM-PAGES | **重要攻击面延伸**：4 个「静态站」并非真无服务端。该 Worker **不在授权范围，一次请求未发**，建议单独申请授权 | `evidence/sites/` LB-004 |
| **MX-12** | PATHOT 有真实后端 API 面（未测） | **Info** | PATHOT | `OPTIONS /api/summarize`→204、`/api/account/{login,me,register}`→204，随机路径→405（**有区分性**）。`GET /api/account/me`→`{"ok":false,"reason":"NO_SESSION"}` **认证设计正确**。**未测**：口令测试（ROE §4.5 禁止）、`/api/summarize`（烧额度） | `verify2/sites-204-discrimination.txt`、`verify2/sites-204-verdict.txt` |
| **MX-13** | `ai_status` 泄露上游模型标识 | **Info** | PREJOB | `{"on":false,"model":"deepseek-chat","masked":""}`；`masked` 为空（未配 Key），仅泄露供应商 | `verify2/prejob-api-headers.txt` |
| **MX-14** | `/api.php` CSP 指令畸形 | **Info** | PREJOB | `frame-ancestors 'none' *` 按 CSP3 该指令被丢弃。**但 JSON 响应无渲染汇点，无实际影响** | `verify2/header-by-branch.txt` |

### 5.3 正面结论（必须写进报告，这是本次审计的真正价值）

| 编号 | 结论 | 资产 | 证据 |
| :--- | :--- | :--- | :--- |
| **POS-01** | SM-CCCD 的 `dangerouslySetInnerHTML` 净化链完整：五字符转义表 + `wo()` 全量转义 + `/^https?:\/\//i` 协议白名单 + KaTeX `trust:false` | SM-CCCD | `evidence/live/SM-CCCD/assets/assets_index-DeOWrzoz.js` @739843/@742453/@742835 |
| **POS-02** | 无 IDOR：跨会话读不到他人数据 | PREJOB | `verify2/idor-cross-session.txt` |
| **POS-03** | unlock 门禁真实存在于服务端（覆盖 9 个受保护 action） | PREJOB | `verify2/unlock-gate-enforcement.txt`、lead `gate/unlock-gate-verification.txt` |
| **POS-04** | 参数处理健壮：数组/`true`/`0`/`null` 类型混淆均正确拒绝，无 PHP 松散比较绕过 | PREJOB | `evidence/live/PREJOB/api/unlock-typeconfusion.txt` |
| **POS-05** | 存储型 XSS 不成立：腾讯云 WAF 拦截 + `v-html` 命中 **0**（Vue 默认转义）双重兜底 | PREJOB | `verify2/xss-waf-test.txt`（含写入正常对照组） |
| **POS-06** | action 白名单分发良好：未知→404、`..`/`<script>`→403、**无 PHP 报错/路径泄露** | PREJOB | `verify2/action-whitelist-errors.txt` |
| **POS-07** | 无 CORS 头 → 跨站读取不可行（这是限制 MX-05 危害的关键） | PREJOB | `verify2/prejob-api-headers.txt` |
| **POS-08** | SM-PAGES `/api/` 是真 CORS 白名单：精确反射合法 Origin、拒绝任意 Origin、**拒绝 `null`、拒绝后缀欺骗** | SM-PAGES | `evidence/sites/cors/cors_origin_matrix.tsv` |
| **POS-09** | 4 站 TLS 均为 TLS1.3 优先 + ECDSA + AEAD，证书链校验通过，HTTP→**301** 强制 HTTPS | 4 站 | `evidence/sites/tls/`、`final/final_probe.tsv` |
| **POS-10** | SPA fallback 甄别正确：**无 sourcemap 泄露**（4 站 `.map` 全为 `text/html` fallback） | 4 站 | `verify2/sourcemap-VERDICT-corrected.txt` |
| **POS-11** | 凭证扫描：**无真实硬编码凭据**。PATHOT 8 处 `sk-` 经核实为新闻 URL slug（`desk-lets` 跨词） | 4 站 | `evidence/sites/secrets_scan.txt`、`ctx_*.txt` |
| **POS-12** | PATHOT `/api/account/me` 无凭据正确拒绝（`NO_SESSION`），不泄露数据 | PATHOT | `verify2/sites-204-discrimination.txt` |

### 5.4 已撤回 / 判定不成立（**不得进入报告 findings**）

| 编号 | 原声明 | 处置 | 理由 |
| :--- | :--- | :--- | :--- |
| ~~F-04~~ | `job_type` 中文变 `??`（Low） | **撤回** | PowerShell 5.1 客户端编码假阳性。显式 UTF-8 + curl 三重复测，`全`=`E5 85 A8` 原样回显，响应字节无 `0x3F` |
| ~~F-05 / FE-005~~ | 写操作无 CSRF（Medium） | **不成立** | 合并为 MX-08（Info 观察）。三重阻断见上 |

---

## 6. 整改优先级建议（复核员视角，独立判断）

> Lead 预期的三项是「补 frame-ancestors」「补 SRI」「限速改按 IP」。**我不同意这个排序**，理由如下。

### 第 1 优先：修 MX-04 —— 安全头响应逻辑（改一处，覆盖全部端点）

**这不是「给首页补个头」的任务，而是一个结构性缺陷。** 我的实测证明规律是状态码分支：200 全缺、非 200 全有。

- **成本**：极低。在统一出口（PHP `header()` 集中处 / 中间件 / `before-send` 钩子）加一行，**所有端点一次修好**——包括 `/api.php`、`/stream.php`、`/generate.php`、首页。
- **收益**：最高。它同时修好 MX-01（首页点击劫持）和 MX-14（CSP 畸形），因为这二者都是「200 分支没走统一的头逻辑」的**同一个根因**。
- **为什么排第一**：把 4 条 Low/Medium 收敛成 1 处改动，投入产出比压倒性。**如果只做一件事，做这个。**

```php
// 统一出口（示意）——顺序无关，关键是"所有分支都经过它"
header("X-Frame-Options: DENY");
header("Content-Security-Policy: frame-ancestors 'none'; default-src 'self'");  // 注意：'none' 必须独占
// Cookie 同理，只在一处 Set-Cookie，不要在两个分支各写一遍
```

### 第 2 优先：修 MX-03 —— 限速改按 IP/账号

**注意：这与 Lead 的预期不同。我把它排在 SRI 之前，理由是「成本几乎为零，且堵的是真实攻击路径」。**

- **成本**：低。限速计数器键从 `PHPSESSID` 换成 `IP`（或 IP+action），一行改动。
- **收益**：中高。当前「按会话计数」等于**没有限速**——攻击者丢弃 Cookie 即可重置。这是我实测验证过的绕过（换新会话立刻回 403 而非 429）。
- **为什么排第二**：unlock 是**唯一的口令闸门**，它后面是 6 个付费/内测模块。虽然本次未评估口令强度（红线），但「换 Cookie 即绕过」是确定性事实，且修复成本低于 SRI。

### 第 3 优先：修 MX-02 —— 第三方脚本 SRI + 自托管

**我把它排第三，而不是第一——与 Lead 的预期不同。理由：它的危害链条依赖「unpkg 被投毒」，而这个前提在本次授权内不可验证。**

- **成本**：低（自托管 `lucide.min.js`，或加 `integrity`+`crossorigin`）。
- **收益**：中。项目已有自托管先例（`/assets/vue.global.prod.js` 就是同源自托管），所以这是**可避免的风险**，不是能力问题。
- **为什么排第三**：它是「条件概率风险」而非「确定性缺陷」。优先级应让位于确定性更高的 MX-04/MX-03。但如果客户对供应链敏感（比如有合规要求），可以提到第 2。

### 不建议优先做（明确说明理由）

| 项 | 为什么不急 |
| :--- | :--- |
| **给全站补 HSTS**（MX-07 等） | 4 站均已实测 HTTP→**301** 强制跳转，实际降级窗口被压缩到首跳前；且 SM-PAGES/SM-CCCD/PREJOB 已有 HSTS。仅 XM/PATHOT 缺，收益远低于上面三项 |
| **收窄 CSP 的 `127.0.0.1:*`**（MX-10） | 属桌面桥设计意图，且**本次未发现任何注入点**，没有利用链。改成按环境下发即可，不急 |
| **加 CORS 头 / 改 `ACAO: *`** | **不要动**。`ACAO: *` 在纯静态资源上不是漏洞；而 PREJOB **已有**「无 CORS 头」这个正面属性，改成放开反而是**倒退** |
| **`ai_status` 不返回模型名**（MX-13） | Info 级，无攻击路径，改不改都行 |

### 一句话结论

> **优先做「一处修复覆盖多端」的结构性改动（MX-04），其次是「成本极低、堵确定性攻击路径」的限速改造（MX-03），最后才是条件性风险（MX-02）。不要按「听起来严重」排序，要按「确定性 × 修复成本」排序。**
