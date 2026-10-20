# Cloudflare Pages 部署

> 19 个站点（18 微站 + orbital-hub）已部署上线。
> 全部使用 `mx-` 前缀，避免覆盖用户账号里的历史 Pages 项目。

---

## 一、线上地址

| 站点 | 地址 |
| :--- | :--- |
| **总控台** | **https://mx-orbital.pages.dev** |
| 01 学阶 GPA | https://mx-gpa.pages.dev |
| 02 星火组队 | https://mx-spark.pages.dev |
| 03 经费液位 | https://mx-grant-audit.pages.dev |
| 04 PAT-HOT | https://mx-pat-hot.pages.dev |
| 05 引文声呐 | https://mx-lit-sonar.pages.dev |
| 06 星门导师 | https://mx-mentor.pages.dev |
| 07 套磁推演 | https://mx-cold-email.pages.dev |
| 08 进组台账 | https://mx-lab-kanban.pages.dev |
| 09 对比矩阵 | https://mx-matrix-cross.pages.dev |
| 10 PDF 狙击 | https://mx-pdf-sniper.pages.dev |
| 11 CurveLab | https://mx-curvelab.pages.dev |
| 12 复现核验 | https://mx-repro-check.pages.dev |
| 13 图表熔炉 | https://mx-chart-foundry.pages.dev |
| 14 综述工坊 | https://mx-review-lab.pages.dev |
| 15 撤稿声呐 | https://mx-retract-radar.pages.dev |
| 16 云衡天平 | https://mx-yunheng.pages.dev |
| 17 证据简历 | https://mx-evidence-cv.pages.dev |
| 18 生涯决策 | https://mx-prejob.pages.dev |

**验证状态**：18 站全部 HTTP 200 且含各站专属内容关键字；hub 可嵌入式加载微站（iframe 内容正常渲染，0 失败请求，0 控制台错误）。

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

## 三、部署流程

### 1. 构建（一次性，约 20 分钟）

```bash
# 18 个微站（静态导出）
node scripts/build-static-site.mjs --all

# 总控台（静态导出，需临时移走 /placeholder 动态路由）
node scripts/build-hub-static.mjs
```

### 2. 部署

```bash
node scripts/deploy-pages.mjs --all
```

凭据从 `D:\tmp\matrixos-cloudflare.env` 读取（**仓库外**，不入库）。

### 3. 只改托管层配置时（快，约 1 分钟）

改了 CSP 白名单之类不需要重新跑 Next 构建，直接：

```bash
node scripts/redeploy-headers.mjs --all
```

---

## 四、脚本职责

| 脚本 | 作用 |
| :--- | :--- |
| `build-static-site.mjs` | 微站静态导出。临时替换 config → 构建 → fixup 补产物 → 恢复 config |
| `build-hub-static.mjs` | hub 静态导出。额外临时移走 `/placeholder` 动态路由 |
| `fixup-static-export.mjs` | 补齐 Next 漏导出的 `index.html`（见下） |
| `deploy-pages.mjs` | 用 wrangler 批量创建项目 + 上传 out/ |
| `redeploy-headers.mjs` | 只改 `_headers` 并重新部署，不重新构建 |
| `gen-not-found.mjs` | 为 18 站生成按站定制的 `not-found.tsx` |

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

| 项 | 位置 |
| :--- | :--- |
| API Token | `D:\tmp\matrixos-cloudflare.env`（**仓库外**） |
| Account ID | 同上 |
| Token 权限 | Account · Cloudflare Pages · 编辑 |
| 是否入库 | ❌ 否，已确认 git status 无泄露 |

**不要**把 token 写进 `.env.local` —— 该路径被 CC Safety Net 拦（secret 保护），且容易误提交。
放仓库外的固定路径、脚本读取即可。

---

## 七、已知限制

| 项 | 说明 |
| :--- | :--- |
| 域名 | 当前用 `*.pages.dev`。`matrixos.edu` 不在用户账号，无法绑定 |
| `/placeholder` 路由 | 静态导出时被临时移走（它是动态路由）。线上由 `NEXT_PUBLIC_MICROSITE_PLACEHOLDER=false` 禁用，实际不影响 |
| 后端未部署 | `matrix-core` 仍在本地。微站的 SSO / 资产写入走本地 mock |
| 构建耗时 | 18 站串行约 20 分钟。并行会更慢（`.next` 目录竞态，见 safe-build.mjs） |

---

## 八、下一步

1. **后端部署**：`matrix-core` 可上 Cloudflare Workers（Python 需换 runtime）或 VPS
2. **域名绑定**：买可用域名后，在 Pages 项目里加 Custom Domain，并同步改 CSP 白名单
3. **CI 部署**：把 `deploy-pages.mjs` 接进 GitHub Actions（等 Actions 计费恢复）
