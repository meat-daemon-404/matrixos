# 本地开发环境搭建

> 适用阶段：Stage 1 起。当前仓库处于规划阶段，本文档描述的是**目标环境**，随 Stage 1 落地会持续更新。

---

## 一、前置依赖

| 工具 | 版本要求 | 用途 | 安装检查 |
| :--- | :--- | :--- | :--- |
| **Node.js** | ≥ 20（推荐 22 LTS） | 前端 / 构建 / 工具链 | `node --version` |
| **pnpm** | ≥ 9 | monorepo 包管理 | `pnpm --version` |
| **Python** | ≥ 3.11 | 后端 / 数据处理 | `python --version` |
| **Git** | ≥ 2.40 | 版本控制 | `git --version` |
| **Docker Desktop** | 最新稳定版 | PostgreSQL + pgvector 本地实例 | `docker --version` |

**可选**
- `gh` CLI ≥ 2.40 — 命令行开 Issue / PR
- VS Code + 推荐插件（见 `.vscode/extensions.json`，Stage 1 提供）

### Windows 额外说明

本仓在 Windows 上开发时注意两点：

1. **行尾**：仓库已设 `core.autocrlf false`，请勿改成 `true`，否则 diff 会全文件飘红
2. **路径长度**：monorepo 嵌套较深，建议在工作区根目录启用长路径支持
   ```powershell
   # 需要管理员权限，执行一次即可
   git config --system core.longpaths true
   ```

---

## 二、快速开始

```bash
# 1. 克隆
git clone https://github.com/meat-daemon-404/matrixos.git
cd matrixos

# 2. 安装依赖（Stage 1 起才有 workspace 依赖）
pnpm install

# 3. 校验契约与文档链接
pnpm check

# 4. 启动本地 DB（Stage 1 起）
docker compose up -d postgres

# 5. 启动全部应用（Stage 1 起）
pnpm dev
```

> **当前阶段**：仓库里还没有 `apps/` 与 `packages/`，`pnpm install` 只会装根目录的工具链。`pnpm check` 现在就能跑，用来验证 `specs/` 契约与文档链接。

---

## 三、当前可跑的校验

不依赖任何第三方包，装完 Node 就能跑：

```bash
# 契约 + 微站花名册 + 归档完整性
node scripts/validate-specs.mjs

# Markdown 内部链接断链检查
node scripts/check-doc-links.mjs

# 两个一起
pnpm check
```

**这两个脚本在 CI 里也会跑**（`.github/workflows/validate.yml`）。本地先跑一遍能省一次往返。

### validate-specs.mjs 检查什么

| 检查项 | 说明 |
| :--- | :--- |
| Schema 结构 | `specs/contracts/*.schema.json` 必须是合法 JSON，且含 `$schema` / `title` / `type` |
| 微站数量 | 必须恰好 18 条 |
| id 连续性 | `01`..`18` 无缺口无重复 |
| 域名唯一 | 全部以 `.matrixos.edu` 结尾且不重复 |
| 字段完整 | 每条必须有 `orbit` / `orbitName` / `name` / `domain` / `source` / `uiStyle` / `ledger` / `desc` |
| 枚举一致性 | `matrix-app-manifest` 与 `dispatch-contract` 的 `orbit_station` 必须与 7 站一致 |
| **合规红线** | `evidence_anchors` 必须强制 `source_doi_or_url` + `verification_level`，三档不可缺 |
| 归档完整性 | `bundle/` 下 6 个交付物齐全 |

---

## 四、目标环境（Stage 1 建立后）

### 目录结构

```
matrix-os-v3/
├── apps/
│   ├── orbital-hub/           # 主入口：左32%星轨 + 右68%仪器架 + 底部声波坞
│   ├── micro-sites/           # 18 个独立微站
│   │   ├── 01-gpa-sandbox/
│   │   ├── 02-spark-teaming/
│   │   ├── ...
│   │   └── 18-prejob-multiverse/
│   └── wechat-pocket/         # 微信小程序伴侣端
├── packages/
│   ├── matrix-sdk/            # @matrixos/sdk 插槽协议 / SSO / 虫洞环
│   ├── instrument-ui/         # 精密仪器组件库
│   └── twin-schema/           # 数据契约
├── services/
│   ├── copilot-router/        # 模型分级路由网关
│   └── openalex-pat-worker/   # OpenAlex / arXiv 监听
└── specs/                     # 本仓现有，契约保持在此
```

### 端口约定（避免冲突）

| 服务 | 端口 |
| :--- | :--- |
| `orbital-hub` | 3000 |
| `micro-sites/*` | 3010 ~ 3027（按站点 id 递增） |
| `wechat-pocket` devtools | 无（微信开发者工具接管） |
| `copilot-router` | 8000 |
| `openalex-pat-worker` | 8001 |
| PostgreSQL | 5432 |

### 环境变量

复制模板后按需填写（Stage 1 提供 `.env.example`）：

```bash
cp .env.example .env.local
```

**关键变量**

| 变量 | 说明 | 是否必填 |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL 连接串（含 pgvector 扩展） | ✅ |
| `MATRIXID_JWT_SECRET` | MatrixID 签发密钥 | ✅ |
| `DEEPSEEK_API_KEY` | TIER 01 / TIER 03 模型 | ✅ |
| `QWEN_API_KEY` | TIER 02 校验层 | ✅ |
| `QWEN_LOCAL_ENDPOINT` | TIER 04 端侧 LoRA 服务地址 | ⬜ 可选 |
| `OPENALEX_MAILTO` | OpenAlex 礼貌池标识（提升限速配额） | ✅ |

> 🔴 **红线**：`.env*` 已在 `.gitignore` 中。任何情况下不得把真实 Key 提交入库。CI 会扫。

---

## 五、常见问题

### `pnpm check` 报 microsites.json 解析失败

该文件必须是 **UTF-8 无 BOM**。PowerShell 的 `Set-Content -Encoding UTF8` 会写入 BOM，导致 `JSON.parse` 失败。

```powershell
# 正确做法：显式使用无 BOM 编码
$json = Get-Content specs/microsites.json -Raw
[System.IO.File]::WriteAllText("$PWD/specs/microsites.json", $json, (New-Object System.Text.UTF8Encoding($false)))
```

### 文档链接检查报 `../../issues` 断链

GitHub 页面相对链接（指向 Issues / Projects 页）不对应本地文件，脚本已跳过 `(../)+<纯小写短横线名>` 形式。若仍有误报，检查链接是否指向了真实不存在的本地文件。

### Windows 上 git diff 显示整个文件都改了

行尾符问题。确认：

```bash
git config core.autocrlf false
```

仓库内已配置，若被本地全局配置覆盖会出问题。

---

## 六、下一步

1. 读 [`docs/01-plan/01-architecture.md`](../01-plan/01-architecture.md) 了解目标架构
2. 读 [`docs/01-plan/02-roadmap.md`](../01-plan/02-roadmap.md) 确认当前 Stage
3. 按 [`.github/CONTRIBUTING.md`](../../.github/CONTRIBUTING.md) 建分支开工
