# Stage 1 开工指南

> 目标：完成 ScholarMatrix 42 工具解耦、封装为独立无状态 API、建立统一调度 JSON Schema、搭好 monorepo 脚手架。
> 周期：2 个月 · 22 个任务 · 167 人日

---

## 一、第一天做什么

```bash
# 1. 克隆
git clone https://github.com/meat-daemon-404/matrixos.git
cd matrixos

# 2. 环境自检（会告诉你缺什么）
node scripts/doctor.mjs

# 3. 装依赖 + 装钩子
pnpm install
pnpm setup

# 4. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local，填 DEEPSEEK_API_KEY 等

# 5. 生成 MatrixID 密钥
pnpm gen:keys

# 6. 起数据库
pnpm db:up

# 7. 再跑一次自检，应该全绿
node scripts/doctor.mjs
```

---

## 二、开工前必读（按顺序）

| # | 文档 | 为什么读 |
| :-- | :--- | :--- |
| 1 | [ADR-000 规范权威性裁决](../01-plan/00-adr-000-spec-authority.md) | Bundle 里两份规范冲突已裁决，别按错的那份干活 |
| 2 | [ADR-001 微站编号裁决](../01-plan/00-adr-001-microsite-numbering.md) | 18 微站的目录命名规则，脚手架必须照它 |
| 3 | [01-architecture.md](../01-plan/01-architecture.md) | 目标架构、鉴权流、资产图谱、模块边界 |
| 4 | [04-tech-decisions.md](../01-plan/04-tech-decisions.md) | 12 条 ADR，每条都写了代价 |
| 5 | [03-work-breakdown.md](../01-plan/03-work-breakdown.md) | 你领的任务在第几项、验收标准是什么 |

---

## 三、任务在 GitHub Issues 里

22 个 Stage 1 任务已全部导入 Issues（#1–#22），挂在 `Stage 1` 里程碑下。

挑任务的方式：

```bash
# 看所有 Stage 1 任务
gh issue list --label stage-1

# 按优先级
gh issue list --label "stage-1,P0"

# 按模块
gh issue list --label "stage-1,area:matrix-sdk"
```

**关键路径**（决定 Stage 1 能否按时交付）：

```
S1-02 (twin-schema) → S1-08 (MatrixID) → S1-11 (资产 API)
                                          ↓
S1-15 (脚手架) → S1-16 (首批 6 站) → S1-17 (SDK)
```

`S1-02` 是所有人依赖的地基——类型定不下来，别人没法并行。所以它排第一。

---

## 四、当前代码就绪度

| 模块 | 状态 | 说明 |
| :--- | :--- | :--- |
| Monorepo 地基 | ✅ 就绪 | turbo + pnpm workspace + tsconfig |
| 开发基础设施 | ✅ 就绪 | docker-compose、`.env.example`、doctor、keys |
| 校验体系 | ✅ 就绪 | pre-commit 钩子 + `pnpm check` |
| `packages/twin-schema` | 🚧 开发中 | 数据契约地基 |
| `packages/matrix-sdk` | 🚧 开发中 | 插槽协议 + SSO |
| `packages/instrument-ui` | 🚧 开发中 | 精密仪器组件库 |
| `services/matrix-core` | 🚧 开发中 | MatrixID + 资产图谱 |
| `services/copilot-router` | 🚧 开发中 | 四级模型路由 |
| `services/openalex-pat-worker` | 🚧 开发中 | 情报监听 |
| `apps/orbital-hub` | 🚧 开发中 | 双态合体总控台 |
| `apps/wechat-pocket` | 🚧 开发中 | 口袋小程序 |

---

## 五、开发约定（摘要）

完整版见 [`CONTRIBUTING.md`](../../.github/CONTRIBUTING.md)。

### 提交

```bash
git checkout -b feat/11-curvelab-debounce-knob
# ... 改动 ...
git commit -m "feat(curvelab): 实现阻尼旋钮 τ₁/τ₂ 实时重绘示波器"
```

`pre-commit` 钩子会自动跑校验，不过则拒绝提交。

### 🔴 中文编码红线

**中文 Markdown / JSON 一律用 `write` / `edit` 工具，不要走 PowerShell 文本管道。**

PowerShell 5.1 在 GBK 代码页下会把 UTF-8 中文静默损坏成 `U+FFFD`，文件仍能打开、链接仍能解析，只有逐字节检查才发现。已经踩过两次坑（见 [CONTRIBUTING](../../.github/CONTRIBUTING.md)）。

校验脚本第 6 项会扫全库，发现即报错。

### 契约不能擅自改

`specs/contracts/` 下三份 Schema 已冻结。要改必须：

1. 开 Issue，标签 `type:spec`，说明影响哪些微站
2. PR 同时更新 Schema 与受影响代码
3. 架构负责人批准

**任何弱化 `evidence_anchors` 必填性的改动都是合规红线，不允许通过。**

---

## 六、验收门禁 G1

Stage 1 结束时逐项验证（对应 `S1-22`）：

- [ ] `pnpm install && pnpm build && pnpm typecheck && pnpm lint` 四命令全绿
- [ ] 三套契约有正例/负例单测，每套 ≥ 8 例
- [ ] MatrixID 完整鉴权流 E2E 通过，refresh 重放被拒
- [ ] `/v1/assets` CRUD + 向量检索可用，越权读写全部被拒
- [ ] 6 个首批微站可独立部署、跨站登录共享
- [ ] 脚手架从生成到出 URL ≤ 1 人日（由未参与者实测）
- [ ] `trace_id` 能贯穿 hub → core → toolbox

---

## 七、遇到问题

| 情况 | 怎么办 |
| :--- | :--- |
| 环境报错 | `node scripts/doctor.mjs` 先自检 |
| 校验不过 | `pnpm check` 看详情；确认误报可用 `git commit --no-verify` |
| 契约要改 | 开 `type:spec` Issue，别直接改 |
| 架构疑问 | 开 Discussion，别在聊天里定 |
| 发现文档过期 | 直接提 PR 修文档，别让它继续骗下一个人 |
