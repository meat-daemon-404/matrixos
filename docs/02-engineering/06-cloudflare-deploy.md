# Cloudflare Pages 部署

> **2026-10-21 起，19 个站点的生产入口已迁移到自有域名 `matrixos.cc.cd`（新专用账号）。**
> 下方第一节列出的是新域名；`mx-*.pages.dev` 那套旧地址仍属于旧账号，仅作历史参考。
> 迁移详情见第九节。

---

## 一、线上地址（生产，新账号 e6bf8ab2…）

| 站点 | 地址 |
| :--- | :--- |
| **总控台** | **https://matrixos.cc.cd** |
| 01 学阶 GPA | https://mx-gpa.matrixos.cc.cd |
| 02 星火组队 | https://mx-spark.matrixos.cc.cd |
| 03 经费液位 | https://mx-grant-audit.matrixos.cc.cd |
| 04 PAT-HOT | https://mx-pat-hot.matrixos.cc.cd |
| 05 引文声呐 | https://mx-lit-sonar.matrixos.cc.cd |
| 06 星门导师 | https://mx-mentor.matrixos.cc.cd |
| 07 套磁推演 | https://mx-cold-email.matrixos.cc.cd |
| 08 进组台账 | https://mx-lab-kanban.matrixos.cc.cd |
| 09 对比矩阵 | https://mx-matrix-cross.matrixos.cc.cd |
| 10 PDF 狙击 | https://mx-pdf-sniper.matrixos.cc.cd |
| 11 CurveLab | https://mx-curvelab.matrixos.cc.cd |
| 12 复现核验 | https://mx-repro-check.matrixos.cc.cd |
| 13 图表熔炉 | https://mx-chart-foundry.matrixos.cc.cd |
| 14 综述工坊 | https://mx-review-lab.matrixos.cc.cd |
| 15 撤稿声呐 | https://mx-retract-radar.matrixos.cc.cd |
| 16 云衡天平 | https://mx-yunheng.matrixos.cc.cd |
| 17 证据简历 | https://mx-evidence-cv.matrixos.cc.cd |
| 18 生涯决策 | https://mx-prejob.matrixos.cc.cd |

**验证状态（2026-10-21 实测）**：19/19 站 HTTP 200，全部带
`Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`。
hub 在 `https://matrixos.cc.cd` 内真实挂载 `mx-curvelab.matrixos.cc.cd` 成功
（iframe textLen=7281、标题正确、0 CSP 拦截，见 `.tmp/hub-mounted.png`）。

**canonical / og:url / CSP / SDK 白名单同步状态（2026-10-21 实测）**：

| 检查项 | 结果 |
| :--- | :--- |
| 18 站 `<link rel=canonical>` = `https://mx-<appId>.matrixos.cc.cd/` | **18/18** |
| 18 站 `og:url` 指向新域名 | **18/18** |
| 18 站 CSP `frame-ancestors` 含 `matrixos.cc.cd` | **18/18** |
| 18 站产物内 SDK `HUB_ORIGINS` 含新域名 | **18/18** |

### 旧地址（旧账号 002738a5…，迁移前）

`mx-orbital.pages.dev`、`mx-gpa.pages.dev` … `mx-prejob.pages.dev` 共 19 个，
仍可访问但已不是生产入口；新账号里同名项目被 Cloudflare 自动改名为
`mx-<appId>-<hash>.pages.dev`（如 `mx-curvelab-7r4`），该 hash 不可预测，不要写进任何产物。

---

## 二、为什么加 `mx-` 前缀

用户 Cloudflare 账号里已有这些 Pages 项目：

- `pat-hot`（2026-10-12，PAT-HOT 原型）
- `scholarmatrix`（2026-08-17）
- `xingmen-mentor`（2026-10-19）
- `infolit-ops`、`wallpaper-forge`、`ai-werewolf` 等

MatrixOS 的 04 站 appId 恰好也叫 `pat-hot`。**直接部署会覆盖既有原型**。

所以统一加前缀：Pages 项目名 = `mx-<appId>`，通过 `MATRIXOS_PAGES_PREFIX` 环境变量可改。

---

## 三、部署流程（迁移后的新流程）

### 1. 构建（一次性，约 20 分钟）

```bash
# 18 个微站（静态导出）
node scripts/build-static-site.mjs --all

# 总控台（静态导出）——必须带 --production，否则残留的
# NEXT_PUBLIC_MICROSITE_LOCAL_MODE=true 会被 DefinePlugin 静态替换进产物
node scripts/build-hub-static.mjs --production
```

### 2. 部署到新账号

```bash
# 19 个目标（18 微站 + hub）→ 新账号 e6bf8ab2…
node scripts/deploy-new-account.mjs --all

# 只部 hub
node scripts/deploy-new-account.mjs --hub-only
```

`deploy-new-account.mjs` 与旧 `deploy-pages.mjs` 的关键差异：

| 项 | 旧脚本 | 新脚本 |
| :--- | :--- | :--- |
| 凭据 | 读 `D:\tmp\matrixos-cloudflare.env` 的 API Token | 用 wrangler **OAuth 登录态**（新账号），并主动 `delete CLOUDFLARE_API_TOKEN` |
| 账号 | 旧账号 002738a5… | 新账号 `e6bf8ab2cbb8475c1ba6d6570332c18d` |
| 上传 | `npx wrangler pages deploy` | 同左（`cf pages deploy` 不支持 `--project-name`） |

### 3. 绑定自有域名（迁移时一次性）

```bash
node scripts/bind-microsite-domains.mjs --all
```

做两件事：`cf pages domains create` 让 Pages 认领 `mx-<appId>.matrixos.cc.cd`，
再 `cf dns records create` 建橙云 CNAME 指向 `<pages-sub>.pages.dev`。
hub 直接用 apex `matrixos.cc.cd`。

### 4. 只改托管层配置时（快，约 1 分钟）

```bash
node scripts/redeploy-headers.mjs --all
```

### 5. 部署后验收（必做）

```bash
npm run verify:prod          # 或 node scripts/verify-prod.mjs
npm run verify:prod:json     # 机器可读，便于 CI
```

判据（任一不符即退出码 1）：19 站 200、HSTS 含 `includeSubDomains`+`preload`、
TLS 1.0/1.1 被拒且 1.2 可用、WAF 4 类探测被拦、apex 无 `error 1014`。

---

## 四、脚本职责

| 脚本 | 作用 |
| :--- | :--- |
| `build-static-site.mjs` | 微站静态导出。临时替换 config → 构建 → fixup 补产物 → 恢复 config |
| `build-hub-static.mjs` | hub 静态导出。额外临时移走 `/placeholder` 动态路由；`--production` 强制生产取值 |
| `fixup-static-export.mjs` | 补齐 Next 漏导出的 `index.html`（见下） |
| **`deploy-new-account.mjs`** | **【当前生产】用 wrangler OAuth 把 19 个目标部署到新账号**（`npm run deploy`） |
| **`bind-microsite-domains.mjs`** | **【当前生产】给 19 个站点绑定 `*.matrixos.cc.cd` 域名 + 橙云 CNAME**（`npm run deploy:domains`） |
| **`verify-prod.mjs`** | **【当前生产】19 站全量验收：可达 / HSTS / TLS 下限 / WAF / 1014**（`npm run verify:prod`） |
| **`migrate-site-origin.mjs`** | **【迁移一次性】把 18 份 `layout.tsx` 的 `SITE_ORIGIN` 从 pages.dev 改成 matrixos.cc.cd** |
| `deploy-hub.mjs` | 单独部 hub（`--production` 产物自检 + 前后置检查）；默认新账号，`--legacy-account` 回滚 |
| `redeploy-headers.mjs` | 只改 `_headers` 并重新部署，不重新构建；默认新账号 |
| **`deploy-pages.mjs`** | **【旧账号·已上锁】默认拒绝运行，必须显式 `--legacy-account`** |
| `gen-not-found.mjs` | 为 18 站生成按站定制的 `not-found.tsx` |

---

## 四之二、⚠️ 静默写错账号：一次真实事故与防线

**事故（2026-10-21 实测复现）**：账号迁移后跑 `node scripts/redeploy-headers.mjs --site=11-curvelab-fit`，
输出 `✓ 11-curvelab-fit https://mx-curvelab.pages.dev`、退出码 0、看起来完全成功。

实际结果：**产物写进了旧账号**。证据是旧账号 `mx-curvelab` 出现了
`short_id=462636e7 / created_on=2026-10-21T01:14:18Z` 的新部署，时间正是那次运行；
而新账号的最新部署时间未变。

**根因**：`redeploy-headers.mjs` / `deploy-hub.mjs` / `deploy-pages.mjs` 会从
`D:\tmp\matrixos-cloudflare.env` 读**旧账号** API Token 并写入
`process.env.CLOUDFLARE_API_TOKEN`。wrangler 的**环境变量优先于 OAuth**，
于是它用旧 token 认证，但 `--project-name=mx-curvelab` 在旧账号里恰好也存在
（迁移后旧项目保留未删），部署就「成功」落到了旧账号。

**为什么危险**：命令成功、URL 正确、退出码 0，唯独新账号线上没变。
只看日志完全看不出问题，属于最需要警惕的一类错误。

**防线（已落地）**：

| 脚本 | 现在的行为 |
| :--- | :--- |
| `redeploy-headers.mjs` | 默认 `delete CLOUDFLARE_API_TOKEN`，强制走新账号 OAuth；打印目标账号；URL 显示 `matrixos.cc.cd` |
| `deploy-hub.mjs` | 同上 |
| `deploy-new-account.mjs` | 本就如此 |
| `deploy-pages.mjs` | **默认直接拒绝运行**，必须显式 `--legacy-account` |

**通用教训**：凡是用 `CLOUDFLARE_API_TOKEN` 驱动的 Cloudflare 脚本，
在「有多账号 + 多环境」时必须**默认清空该变量**并显式选定账号，
否则环境变量会静默越过你以为在用 OAuth。

---

## 五、踩过的坑（都写进了脚本注释）

### 坑 1：`output: 'export'` 不支持 `headers()`

微站原本用 `next.config.ts` 的 `headers()` 设 CSP `frame-ancestors`。
静态导出不支持它，构建直接失败。

**解法**：构建时临时替换 config，CSP 改由 Cloudflare Pages 的 `out/_headers` 承担。

### 坑 2：Next 15.5.28 漏导出根路由 `index.html`

实测证据：

```
✓ Exporting (4/4)                      ← 声称全部成功
.next/server/app/index.html  37260 B   ← 内容确实生成了
.next/server/app/_not-found.html       8222 B
out/404.html                           8222 B  ← _not-found 成功导出
out/index.html                         缺失！  ← 根路由被跳过
```

同目录下 `_not-found` 能导出而 `index` 不能，排除权限/路径问题。

**解法**：`fixup-static-export.mjs` 在构建后从 `.next/server/app/` 把漏掉的 html 补到 `out/`。
脚本按 Next 的导出布局规则映射（`a.html → a/index.html`，`_not-found.html → 404.html`，route group 目录不进 URL）。

### 坑 3：构建不稳定（同一份代码时好时坏）

实测连续三次构建同一站点：第 1 次报 `Invariant: no direct app page entry found for /_not-found`，第 2、3 次成功。

判据是 `tsconfig.tsbuildinfo` 与 `.next` 的增量状态。

**解法**：每轮构建前清理 `.next` / `out` / `tsconfig.tsbuildinfo`，失败自动重试（最多 3 次）。
真失败会连报 3 次，不会掩盖问题。

### 坑 4：`NEXT_CONFIG_FILE` 环境变量不存在

第一版脚本想用 `NEXT_CONFIG_FILE=next.config.deploy.mjs npx next build`。
**Next.js 15 没有这个变量**（我记混了）。表现出来是「构建成功但 out/ 不生成」——因为读的仍是原配置。

**解法**：备份 → 替换 `next.config.ts` → 构建 → 恢复（逐字节校验）。

### 坑 5：`_not-found` invariant

App Router 在 `output:'export'` 下，若项目没有显式 `not-found.tsx`，会抛
`Invariant: no direct app page entry found for /_not-found`。

**解法**：`gen-not-found.mjs` 为每站生成定制 404 页。

### 坑 6：CSP 白名单漏了实际 hub 域名

第一版 `_headers` 写的白名单是 `https://orbital.pages.dev`，
但实际部署的 hub 域名是 `https://mx-orbital.pages.dev`，导致线上 iframe 被拦：

```
Framing 'https://mx-gpa.pages.dev/' violates the following
Content Security Policy directive: "frame-ancestors 'self' https://orbital.pages.dev ..."
```

**解法**：白名单现在覆盖生产域名 + 预览子域通配 `https://*.mx-orbital.pages.dev`。

> ⚠️ 这一条最容易再犯：**改项目名前缀时，必须同步改 CSP 白名单**。

### 坑 7：代理环境变量干扰 wrangler

本机 `HTTP_PROXY` / `HTTPS_PROXY` 指向 `127.0.0.1:7897`，
wrangler 会走它，导致 TLS 握手失败或连不上 Cloudflare API。

**解法**：`deploy-pages.mjs` 与 `redeploy-headers.mjs` 开头主动删除所有代理环境变量。

### 坑 8：wrangler 的 next bin 路径

`node_modules/next/dist/bin/next` **没有 `.js` 扩展名**（package.json 的 `bin` 字段就这么写的）。
自作聪明加 `.js` 会得到 `MODULE_NOT_FOUND`。

**解法**：读 `node_modules/next/package.json` 的 `bin` 字段动态解析，别硬编码。

---

## 六、凭据管理

### 当前（生产，新账号）

| 项 | 位置 |
| :--- | :--- |
| `cf` CLI OAuth | `C:\Users\<user>\AppData\Roaming\xdg.config\cloudflare\config\default.enc` |
| wrangler OAuth | `C:\Users\<user>\AppData\Roaming\xdg.config\.wrangler\config\default.toml` |
| Account ID | `e6bf8ab2cbb8475c1ba6d6570332c18d`（写死在 `scripts/deploy-new-account.mjs`） |
| 邮箱 | `sunzihang39@gmail.com` |
| 是否入库 | ❌ 否，凭据只在用户目录 |

> 两条 OAuth 链**各自独立**：`cf auth login` 与 `npx wrangler login` 要分别做。
> `cf` 的凭据不复用 wrangler 的，反之亦然。

### 旧（旧账号，仅回滚用）

| 项 | 位置 |
| :--- | :--- |
| API Token | `D:\tmp\matrixos-cloudflare.env`（**仓库外**） |
| Account ID | `002738a579821a06c4ee9241babe99f0` |
| Token 权限 | Account · Cloudflare Pages · 编辑 |

**不要**把 token 写进 `.env.local` —— 该路径被 CC Safety Net 拦（secret 保护），且容易误提交。
放仓库外的固定路径、脚本读取即可。旧 token 对新账号 **403**，别混用。

---

## 七、已知限制

| 项 | 说明 |
| :--- | :--- |
| 域名 | 生产用 `matrixos.cc.cd` 下的 `mx-<appId>.matrixos.cc.cd`；`matrixos.edu` 不在用户账号 |
| 后端未部署 | `matrix-core` 仍在本地。hub/微站会请求 `https://api.matrixos.edu/v1/...`，该域未解析（`ERR_CONNECTION_CLOSED`），SSO/资产写入走本地 mock |
| DNSSEC | Cloudflare 侧 `pending`，需在 dnshe 注册商加 DS 记录 |
| 托管 WAF | ✅ 已启用 Managed Free Ruleset（`cf rulesets entrypoint update`，见 7.5.7） |
| `/placeholder` 路由 | 静态导出时被临时移走（它是动态路由）。线上由 `NEXT_PUBLIC_MICROSITE_PLACEHOLDER=false` 禁用 |
| 构建耗时 | 18 站串行约 20 分钟。并行会更慢（`.next` 目录竞态，见 safe-build.mjs） |
| 旧账号项目 | 19 个 `mx-*` 仍留在旧账号，未删除（可回滚，也仍可访问） |

---

## 七点五、matrixos.cc.cd 生产域名安全加固（2026-10-20）

> 账号：`Sunzihang39@gmail.com's Account`（id `e6bf8ab2cbb8475c1ba6d6570332c18d`，本项目专用新账号）
> Zone：`matrixos.cc.cd`（id `c60470db5b6318f340d938e712ecedee`，plan = Free Website）

### 7.5.1 加固前后对照

| 防护项 | 加固前 | 加固后 |
| :--- | :--- | :--- |
| TLS 最低版本 | 1.0 | **1.2**（1.0/1.1 握手被拒，已实测） |
| TLS 1.3 | on | on |
| 加密模式 | full | full |
| 强制 HTTPS | off | **on**（+ `automatic_https_rewrites` on） |
| HSTS（Cloudflare 侧） | 全 false | **enabled / max-age 31536000 / includeSubDomains / preload / nosniff** |
| 安全级别 | medium | **high** |
| 挑战 TTL | 1800 | 3600 |
| Early Hints | off | **on** |
| 爬虫防护 | 全关 | **fight_mode + enable_js + ai_bots_protection=block** |
| 自定义 WAF | 无 | **5 条 block 规则**（见 7.5.3） |
| 速率限制 | 无 | **10 秒 120 次/源 IP** |
| www 主机 | 灰云（绕过全部边缘防护） | **橙云 + 301 跳 apex** |
| CAA 记录 | 无 | **`0 issue "cloudflare.com"`** |
| DNSSEC | disabled | **pending**（DS 已生成，待注册商同步） |

### 7.5.2 DNS 记录现状（2026-10-21 迁移后）

| 类型 | 名称 | 内容 | 代理 |
| :--- | :--- | :--- | :--- |
| CNAME | `matrixos.cc.cd` | `mx-orbital-c6y.pages.dev`（新账号 hub） | ✅ 橙云 |
| CNAME | `www.matrixos.cc.cd` | `matrixos.cc.cd` | ✅ 橙云 |
| CNAME | `mx-<appId>.matrixos.cc.cd` ×18 | 各自 `<project>-<hash>.pages.dev` | ✅ 橙云 |
| CAA | `matrixos.cc.cd` | `0 issue "cloudflare.com"` | — |

> 迁移前 apex 指向旧账号的 `mx-orbital.pages.dev`（跨账号 → `error code: 1014`）。
> 现在 apex 指向新账号 pages.dev，且 `matrixos.cc.cd` 是新账号 `mx-orbital` 项目
> 的**自定义域名（status=active）**，因此 1014 的根因已消除——
> www 的 301 重定向规则从「绕过」变成「语义等价」。

### 7.5.3 自定义 WAF 规则（ruleset `bc165356ee3a4e3bb295b2f1876475d5`）

| 规则 | 匹配 | 动作 |
| :--- | :--- | :--- |
| 敏感路径 | path 含 `/.env` `/.git` `/.svn` `/backup` | block |
| CMS 后台 | path 含 `/wp-admin` `/wp-login` `xmlrpc.php` `/cgi-bin` | block |
| 危险方法 | method ∈ {TRACE, TRACK, DEBUG} | block |
| 路径穿越 | path 含 `..` | block |
| 扫描器探测 | path 含 `phpmyadmin` `eval-stdin.php` `shell.php` | block |

线上实测：`/.env`、`/.git/config`、`/wp-admin/index.php`、`/cgi-bin/test` → **403**；正常路径 → **200**。

### 7.5.4 跨账号 Pages 的 403 / error 1014

`matrixos.cc.cd` 的 CNAME 指向 `mx-orbital.pages.dev`，而该 Pages 项目建在**另一个** Cloudflare 账号里。
Cloudflare Pages 对不属于自己的自定义域名直接返回 `HTTP 403` + 正文 `error code: 1014`，
所以 `www`（以及任何非 Pages 自带主机名）一度完全不可用。

**解法（已生效）**：
1. `www` CNAME 改为指向 apex（`matrixos.cc.cd`），仍在橙云后面；
2. 建动态重定向 ruleset `436b45b9e40f4b88831e3ab3e3a0830f`（phase `http_request_dynamic_redirect`），
   规则 `http.host eq "www.matrixos.cc.cd"` → 301 到 `https://matrixos.cc.cd`。

实测：`https://www.matrixos.cc.cd/` → **301** `Location: https://matrixos.cc.cd/`。

> ⚠️ 这一节是 2026-10-20 的**临时**解法。2026-10-21 已完成账号迁移，
> `matrixos.cc.cd` 现在由新账号的 `mx-orbital` 项目正式认领（`status=active`），
> 1014 的根因已消除，www 的 301 规则保留但已不再是绕过手段。详见第九节。

### 7.5.5 DNSSEC（pending，需注册商操作）

Cloudflare 侧已开启，DS 记录：

```
matrixos.cc.cd. 3600 IN DS 2371 13 2 7BE09117A8C41896E368B87DDDC99CB91ADD8AF69E729A308E186E5B78F40604
```

父域 `cc.cd` 的 NS 在 dnshe（`a.ns.dnshe.org` / `b.ns.dnshe.org`），不是 Cloudflare，
所以必须在 **dnshe 后台**加这条 DS 记录。Cloudflare 侧状态会从 `pending` 变成 `active`。

### 7.5.6 新账号 Pages 曾为空（2026-10-21 已补上）

2026-10-20 晚查 `GET /accounts/{e6bf8ab2…}/pages/projects` 时新账号返回 **count 0**，
19 个 `mx-*` 站点那时仍全在旧账号（`002738a579821a06c4ee9241babe99f0`）。
2026-10-21 已把 19 个目标全部部署到新账号并绑定自有域名，详见**第九节**。

### 7.5.7 Free 套餐的硬限制（踩坑记录）

Cloudflare Managed Free Ruleset / DDoS L7 / Normalization 三个托管规则集在 zone 上**本来就有规则**。

**⚠️ 曾误判为「只能手动开」**：用 MCP OAuth token 调
`POST /zones/{Z}/rulesets/phases/http_request_firewall_managed/entrypoint` 会得到
`405 Method not allowed for this authentication scheme`。但这**不是套餐限制、也不是必须手动** ——
真实原因是那个 MCP OAuth token 缺 `zone-waf.write` scope。

换 `cf` CLI（scope 里带 `zone-waf.write`）直接就能写：

```bash
cf rulesets entrypoint update http_request_firewall_managed \
  --zone matrixos.cc.cd --body @managed-entrypoint.json
```

body 内容（execute 托管规则集，`expression: "true"` 表示全量匹配）：

```json
{"rules":[{"action":"execute","description":"Execute Cloudflare Managed Free Ruleset",
  "enabled":true,"action_parameters":{"id":"77454fe2d30c4220b5701f6fdfb893ba"},
  "expression":"true"}]}
```

2026-10-21 已按此启用，entrypoint id `24ada2e011e94ad3ac038ef714e9d47c`，
规则 id `e29461cacaa540e5af7db61293a9ff61`。

实测：Log4j 特征（请求头 `X-Api-Version: ${jndi:ldap://...}` 与查询参数两种形态）
全部 **403**，正常路径仍 **200**，19 站复验无回归。

> **BOM 陷阱**：`cf ... --body @file` 要求文件**无 BOM**。
> PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，导致 `Invalid JSON in --body`。
> 必须用 `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`。

Free 套餐自定义 WAF 的限制：

| 限制 | 报错 |
| :--- | :--- |
| 只能用 `contains` / `eq` / `in` | `matches` → `not entitled: the use of operator Matches is not allowed, a Business plan or a WAF Advanced plan is required` |
| 不能用 `starts_with` / `ends_with` | `20127: … could not parse filter expression` |
| 速率限制不能放在 `http_request_firewall_custom` | `20131: ratelimit rules are not allowed in phase http_request_firewall_custom with kind zone` |
| 速率限制必须用 `action: 'block'` + 顶层 `ratelimit{}` | `action: 'throttle'` → `unknown variant for action: throttle` |
| `characteristics` 必须含 `cf.colo.id` | `20155: '[ip.src]' is not a valid value for characteristics …` |
| `period` 只能是 10 | `not entitled to use the period 60, can only use a period among [10]` |
| `mitigation_timeout` 只能是 10 | `not entitled to use a mitigation timeout different from 10` |
| 不能用 `counting_expression` | `not entitled: cannot use the counting expression, an higher Advanced Rate Limiting plan is required` |

### 7.5.8 其他 API 形状备忘

| 场景 | 正确形状 |
| :--- | :--- |
| 改 zone 设置 | `PATCH /zones/{Z}/settings`，body 必须是 `{ items:[{id,value}], result:{id,value} }`（漏 `items` → `1004: Missing 'items'`） |
| 改 HSTS | value 是嵌套的 `{ strict_transport_security: { enabled, max_age, include_subdomains, preload, nosniff } }`，不是平铺字段 |
| 建 CAA | body 必须带 `data: { flags, tag, value }`，否则 `9101: flags is a required data field.` |
| 开 DNSSEC | `POST /zones/{Z}/dnssec`，body **`{ status: 'active' }`**（空 body → `7000: Malformed request body`） |
| 建多条规则 | 先建 ruleset（1 条），再逐条 `POST /zones/{Z}/rulesets/{RS}/rules` |
| Bot 防护 | `PUT /zones/{Z}/bot_management`，body 要带 `fight_mode` + `enable_js`（只给 `fight_mode` → `10400: Bad Request`）；**每次 PUT 是全量覆盖**，要带的字段必须一次带齐 |
| `waf` 旧设置项 | `1027: WAF is deprecated for this zone, Managed Rulesets should be used instead` —— 别再用它，走 ruleset |

### 7.5.9 走哪条 API 通道

| 通道 | 能力 | 用途 |
| :--- | :--- | :--- |
| **`cf` CLI**（1.0.0-beta.19，OAuth） | 有 `pages:read/write`、`dns_records:edit`、`zone:read` 等 | **首选**：`cf pages list/domains`、`cf dns records`、`cf accounts ...` |
| **`npx wrangler`**（OAuth） | OAuth 覆盖 `pages:write` | 只能它带 `--project-name`：`wrangler pages deploy <dir> --project-name=<p>` |
| **MCP `execute`**（mcp-remote OAuth） | 全量 API，但 token 短期 | 会话里的临时查询；token 过期要重新授权 |

关键限制（都踩过）：

- `cf pages deploy` **没有** `--project-name` 参数 → 上传产物必须用 wrangler。
- `cf pages list` **每页固定 10 条**，`--per-page` 传 20/50 会 `8000024 Invalid list options`；
  必须 `--page 1..N` 翻页，否则后 9 个站点被误判为「项目不存在」。
- 新账号 `pages.project.subdomain` 字段**已含 `.pages.dev`**，拼接 CNAME 时要先剥后缀，
  否则会写进 `xxx.pages.dev.pages.dev`（解析失败 → 403/522）。
- node 脚本里 `execFileSync('cf', ...)` 的 **stdout 是纯 JSON、噪声在 stderr**；
  用 `2>&1` 合并后必须过滤 `node.exe|DeprecationWarning|CategoryInfo|所在位置` 等行再解析。
- 旧账号 API Token（`D:\tmp\matrixos-cloudflare.env`）对新账号 **403**；
  用它跑 `cf auth whoami` 会显示 `authenticated: true` 但 `accounts: []` —— 别被骗。
- `cf` CLI 的 keyring 依赖 `@napi-rs/keyring`，已 `npm install -g @napi-rs/keyring@1.3.0`；
  `cf auth login` 设备码 5 分钟过期。

---

## 八、下一步

1. **后端部署**：`matrix-core` 可上 Cloudflare Workers（Python 需换 runtime）或 VPS
   —— 目前 hub/微站前端仍会请求 `https://api.matrixos.edu/v1/...`，该域名未解析（`ERR_CONNECTION_CLOSED`）
2. **DNSSEC 收尾**：在父域注册商 dnshe 后台添加 DS 记录
   （`matrixos.cc.cd. 3600 IN DS 2371 13 2 7BE09117A8C41896E368B87DDDC99CB91ADD8AF69E729A308E186E5B78F40604`），
   Cloudflare 侧状态才会从 `pending` 转 `active`
3. **~~托管 WAF 手动开启~~ ✅ 已完成**：见 7.5.7。cf CLI 可直接写 entrypoint，
   无需 Dashboard；先前「只能手动」的判断是 MCP token 缺 scope 导致的误判。
4. **CI 部署**：把 `deploy-new-account.mjs` + `bind-microsite-domains.mjs` 接进 GitHub Actions
   （需要把新账号 token 存成 secret；注意不要复用旧账号 token）

---

## 九、账号迁移记录（2026-10-21）

### 9.1 起因

`matrixos.cc.cd` 的 CNAME 指向 `mx-orbital.pages.dev`，而该 Pages 项目在**旧账号**，
Cloudflare Pages 对不属于自己的主机名返回 `403 error code: 1014`。
加上用户要求「新账号专门部署本项目」，于是把 19 个站点整体迁到新账号。

### 9.2 账号对照

| | 旧账号 | 新账号（本项目专用） |
| :--- | :--- | :--- |
| Account ID | `002738a579821a06c4ee9241babe99f0` | **`e6bf8ab2cbb8475c1ba6d6570332c18d`** |
| 邮箱 | `3335264558@qq.com` | **`sunzihang39@gmail.com`** |
| 认证方式 | API Token（`D:\tmp\matrixos-cloudflare.env`） | **OAuth**（`cf auth login` + `wrangler login`） |
| 凭据文件 | 仓库外 env 文件 | `~/.config/cloudflare/config/default.enc`（cf）<br>`~/.config/.wrangler/config/default.toml`（wrangler） |

### 9.3 迁移步骤（可复现）

```bash
# 0) 新账号登录（两条链各自独立，都要做）
cf auth login            # 设备码：浏览器 https://dash.cloudflare.com/oauth2/device/verify
npx wrangler login       # 浏览器 OAuth

# 1) 构建
node scripts/build-static-site.mjs --all
node scripts/build-hub-static.mjs --production

# 2) 部署 19 个目标到新账号
node scripts/deploy-new-account.mjs --all

# 3) 绑定自有域名（Pages 认领 + 橙云 CNAME）
node scripts/bind-microsite-domains.mjs --all

# 4) 验证
node .tmp/verify-new-account.mjs
```

### 9.4 结果

| 项 | 结果 |
| :--- | :--- |
| 新账号 Pages 项目 | **19 个**（18 微站 + mx-orbital） |
| 部署成功率 | **19/19**（分两批：先 18/19，06 站补建后单独补部；16 站补建后单独补部） |
| 自有域名绑定 | **19/19**（`mx-<appId>.matrixos.cc.cd` ×18 + apex） |
| 线上可达 | **19/19 HTTP 200**，全带 HSTS preload |
| canonical / og:url | **18/18** 指向 `mx-<appId>.matrixos.cc.cd` |
| CSP frame-ancestors | **18/18** 含 `matrixos.cc.cd` |
| SDK HUB_ORIGINS | **18/18** 产物注入新域名 |
| hub 跨源内嵌 | ✅ 实测挂载 `mx-curvelab.matrixos.cc.cd`，`textLen=7281`，0 CSP 拦截 |
| WAF 自定义 5 规则 | 敏感路径 / CMS / 危险方法 / 路径穿越 / 扫描器探测 全部 403 |
| WAF 托管规则集 | ✅ 已启用，Log4j 特征 403，19 站复验无回归 |
| 旧账号处置 | **保留不删**（回滚退路，不产生费用）；新站已确认无产物引用旧域名 |
| 遗留 | `api.matrixos.edu` 未解析（后端未部署）；DNSSEC pending 待注册商加 DS |

### 9.5 产物 URL 模板变更（三处）

| 文件 | 常量 / 位置 | 旧值 → 新值 |
| :--- | :--- | :--- |
| `scripts/build-hub-static.mjs` | `PROD_MICROSITE_TEMPLATE` | `https://mx-{appId}.pages.dev` → `https://mx-{appId}.matrixos.cc.cd` |
| `scripts/build-static-site.mjs` | `NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE` | `https://{appId}.pages.dev` → `https://mx-{appId}.matrixos.cc.cd` |
| `scripts/site-icons.mjs` | `PROD_SITE_ORIGIN_TEMPLATE`（生成 `layout.tsx` 的 `SITE_ORIGIN`） | `...pages.dev` → `...matrixos.cc.cd` |

全部可用 `MATRIXOS_MICROSITE_TEMPLATE` / `MATRIXOS_SITE_ORIGIN_TEMPLATE` 覆盖。

原因：新账号里 `mx-<appId>.pages.dev` 已被旧账号占用，Cloudflare 会自动改名成
`mx-<appId>-<hash>.pages.dev`，hash 不可预测且随时可能变，不能写进产物。

**⚠️ `layout.tsx` 是生成产物，改生成器不会自动更新已存在的文件** ——
所以补了 `scripts/migrate-site-origin.mjs` 做一次性批量改写（幂等，已新版自动跳过）。
只改生成器会导致「下次重新生成才对，但线上已部署的 18 份还是旧值」。

### 9.6 CSP / SDK 白名单变更

`scripts/lib/pages-headers.mjs` 的 `HUB_ORIGINS` 重排：

- **提到最前**：`https://matrixos.cc.cd`、`https://www.matrixos.cc.cd`、`https://*.matrixos.cc.cd`
- **新增**：`https://mx-orbital-c6y.pages.dev`、`https://*.mx-orbital-c6y.pages.dev`
  （新账号 hub 的真实 pages.dev 主机名 —— hash 不可预测，必须显式列出）
- **降级为兼容项**：`mx-orbital.pages.dev`、`*.mx-orbital.pages.dev`、`orbital.pages.dev`、
  `orbital-hub.pages.dev`（旧账号域名，旧站仍在线可回滚）
- 同步产物：`FRAME_ANCESTORS`（微站 CSP）与 `HUB_ORIGINS_FOR_SDK`（SDK 白名单）都由它派生

### 9.7 尚未迁移的部分

- **旧账号的 19 个项目没有删除**，仍可访问（`mx-*.pages.dev`）。确认新站稳定后可清理。
- 旧账号里还有用户的历史项目（`pat-hot`、`scholarmatrix`、`xingmen-mentor` 等），**保持原样**，
  它们不是 MatrixOS 的产物。
- `scripts/deploy-pages.mjs` 保留，仅用于回滚到旧账号。

### 9.8 迁移期间踩到的并发问题（重要）

本仓库有**并行会话**在同时跑构建（`.tmp/verify-batch.mjs`、`microsite-verify.mjs` 等）。
它们会清空同一个站的 `.next` / `out`，导致：

| 现象 | 原因 |
| :--- | :--- |
| `next build` 报成功但 `out/` 空 | 另一个进程在 build 与 export 之间删了 `.next` |
| `ENOENT: .next/export/500.html` | `next dev -p 3025` 占用 `.next`，与 build 争同一目录 |
| 部署时报「out/index.html 不存在」 | 产物刚被并行会话清掉 |

**做法**：批量构建/部署前先查并发进程，构建完立刻回读 `out/index.html` 的 canonical 确认；
发现站点被清空就单独重跑该站（脚本本身是幂等的）。

