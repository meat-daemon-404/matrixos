# MatrixOS 协作规范

本仓是 MatrixOS v3.0 的**唯一事实源**（Single Source of Truth）。所有设计决策、工程计划、代码实现都必须落在这里，不允许散落在个人目录或聊天记录中。

---

## 一、目录职责

| 目录 | 职责 | 谁可以改 |
| :--- | :--- | :--- |
| `bundle/` | 原始设计交付物归档，**只读** | 不可修改。需要更新时由 Lead 重新导入 |
| `specs/` | 机器可读契约（JSON Schema、微站花名册） | 架构负责人 + 评审 |
| `docs/00-analysis/` | Bundle 解构、需求、差距、视觉体系 | 分析负责人 |
| `docs/01-plan/` | 架构、路线图、WBS、ADR、风险 | 架构负责人 + 评审 |
| `docs/02-engineering/` | 开发约定、环境搭建、调试手册 | 各模块负责人 |
| `apps/` | 可运行应用（Stage 1 起逐步建立） | 按 CODEOWNERS |
| `packages/` | 共享库（SDK、UI 组件、数据契约） | 按 CODEOWNERS |

> **红线**：`bundle/` 是设计输入，不是代码。任何人不得把它当作「已完成的产品」来引用。

---

## 二、分支策略

```
main                  ← 受保护，所有改动经 PR 合入
 └── dev              ← 集成分支（可选，按团队规模启用）
      ├── feat/<scope>-<short-desc>      新功能
      ├── fix/<scope>-<short-desc>       缺陷修复
      ├── docs/<scope>-<short-desc>      文档
      └── chore/<scope>-<short-desc>     杂务/依赖升级
```

**规则**
- `main` 禁止直接 push，必须走 PR
- 分支名用小写短横线分隔，`scope` 优先用模块名或微站 id（如 `feat/11-curvelab-debounce-knob`）
- 一个 PR 只做一件事，超过 400 行 diff 请拆分
- 合并前必须 rebase 到最新 `main`，保持线性历史

---

## 三、提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

| type | 用途 |
| :--- | :--- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 仅文档变更 |
| `refactor` | 重构（不改行为） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `build` | 构建系统/依赖 |
| `ci` | CI 配置 |
| `chore` | 杂务 |
| `spec` | 契约/Schema 变更（需评审） |

**示例**

```
feat(curvelab): 实现阻尼旋钮 τ₁/τ₂ 实时重绘示波器

- 旋钮拖动 16ms 节流，避免拟合重算阻塞主线程
- 置信带用 95% 分位重采样绘制
- 拟合计算迁移到 Web Worker

Closes #42
```

**scope 约定**：`orbital` / `sdk` / `instrument-ui` / `twin-schema` / `copilot-router` / `pat-worker` / `wechat` / 微站 id（如 `11-curvelab`）

---

## 四、PR 规范

**标题**：与提交信息同格式

**必须包含**
- 变更动机（为什么改）
- 变更内容（改了什么）
- 验证方式（怎么证明改对了：截图 / 测试输出 / 手动步骤）
- 关联 Issue（`Closes #123`）

**评审要求**
- 至少 1 名 reviewer 批准
- CI 全绿
- 涉及 `specs/` 契约变更需架构负责人额外批准
- 涉及视觉变更需附前后对比截图

**禁止**
- ❌ 提交 `node_modules`、`.env`、构建产物
- ❌ 提交包含真实用户数据或未发表实验数据的文件
- ❌ 在代码里硬编码 API Key

---

## 五、Issue 规范

**标题格式**：`[模块] 简述`，例如 `[11-curvelab] 置信带绘制偏差`

**必须打标签**（见 `.github/labels.yml`）
- 类型：`type:feature` / `type:bug` / `type:docs` / `type:spec` / `type:infra`
- 阶段：`stage-1` ~ `stage-4`
- 轨道（微站相关）：`orbit-1` ~ `orbit-7`
- 优先级：`P0` / `P1` / `P2`

**缺陷报告**必须包含：环境、复现步骤、期望行为、实际行为、截图或日志。

---

## 六、契约变更流程（重要）

`specs/contracts/` 下的 JSON Schema 是跨微站的硬约束。变更流程：

1. 开 Issue，标签 `type:spec`，说明为什么要改、影响哪些微站
2. 提交 PR，同时更新 Schema 与受影响微站的兼容代码
3. 架构负责人评审，确认向后兼容策略
4. 若为 breaking change，必须在 `docs/02-engineering/CHANGELOG-contracts.md` 登记，并给出迁移窗口

**铁律**：任何 `evidence_anchors` 字段的弱化（比如允许为空）都是合规红线，不允许通过。

---

## 七、数据与合规红线

- 课题组**未发表实验数据**只能在端侧（IndexedDB）或校内算力（Qwen LoRA）处理，禁止上传到任何第三方模型 API
- 所有引用必须带 `evidence_anchors`，杜绝大模型学术幻觉
- AI 生成的文本须可追溯，符合教育部及顶刊 AI 披露规范
- 综测申报材料导出前须人工复核
- 测试数据一律使用脱敏样本，禁止把真实学号/身份证/成绩单提交到仓库

---

## 八、本地开发

见 [`docs/02-engineering/01-dev-setup.md`](../docs/02-engineering/01-dev-setup.md)（Stage 1 建立）。

**基础要求**
- Node.js ≥ 20（推荐 22 LTS）
- pnpm ≥ 9
- Python ≥ 3.11（后端）
- Git 提交前会跑 lint-staged（配置在 Stage 1 落地）

### 🔴 中文编码红线（有实际损失，务必遵守）

**中文 Markdown / JSON 一律用 `write` / `edit` 工具，不要走 PowerShell 文本管道。**

已发生过的两次事故：

| 事故 | 原因 | 后果 |
| :--- | :--- | :--- |
| 约 600 处中文损坏 | PowerShell 5.1 在 GBK 代码页下把 UTF-8 当 GBK 解码 | **静默损坏**：文件能打开、链接能解析，只有逐字节检查才发现 |
| `microsites.json` 解析失败 | `Set-Content -Encoding UTF8` 写入 BOM | `JSON.parse` 报 `Unexpected token '\ufeff'` |

**禁止**
- ❌ `Get-Content ... | Set-Content ...`（引入 BOM + 编码转换）
- ❌ `Out-File` 写中文
- ❌ 用 `-replace` 做中文批量替换后回写

**若必须用脚本处理**，显式指定无 BOM UTF-8：

```powershell
[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
```

**已加入自动化防线**：`scripts/validate-specs.mjs` 的第 6 项检查会扫描全库，发现 `U+FFFD` 或 BOM 即报错。本地 `pnpm check` 与 CI（计费恢复后）都会拦。

---

## 九、沟通

- 设计/架构争议 → 开 Discussion 或 Issue，不要在聊天里定
- 决策一旦定下，必须写入 `docs/01-plan/04-tech-decisions.md`（ADR）
- 口头结论不算数，落文档才算
