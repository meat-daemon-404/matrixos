# MatrixOS 协作规范

> **实测基线：仓库创建于 2026-10-20 10:33；本文原有实测数据写于 2026-10-20 20:09–22:24，个别条目已就地补测至 2026-10-21。**
> 本文件里的数字都是**量出来的，不是规定的**——它们会随仓库变化而失真。
> 看到本文的任何数字，先按该节标注的命令重测，别把昨天的测量当作今天的约束。
> **规范自身也会过期**：凡标注了「失效条件」的条目，条件达成时该条即作废，由**发现它成立的人**删除或改写。
> 不要因为「规范里写着」就继续执行一条已经过期的绕过方案——那正是本文件最想防的事。
> 时效性维护细则见 [第十节](#十本规范的时效性)。

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
| `apps/` | 可运行应用（Stage 1 起逐步建立） | 认领该模块 Issue 的人 |
| `packages/` | 共享库（SDK、UI 组件、数据契约） | 认领该模块 Issue 的人 |

> 本目录归属**没有 CODEOWNERS 文件强制**（私有仓 + 协作者很少，GitHub 也不会在服务端拦截）。真正的约束来自认领流程：改了别人正认领的模块，PR 评审会被退回。人多了再补 CODEOWNERS。
>
> 📅 **失效条件**：协作者数 ≥ 3，或任一目录出现两名以上并发认领者时，本节「人多了再补」到期——补 `CODEOWNERS`，别再靠自觉。
> 重测协作者：`gh api repos/meat-daemon-404/matrixos/collaborators --jq '.[].login'`（2026-10-20 实测 2 人）

> **红线**：`bundle/` 是设计输入，不是代码。任何人不得把它当作「已完成的产品」来引用。

---

## 二、开工认领与分支策略

### 2.1 铁律：不在台账上认领，就不开工

> **为什么立这条**（2026-10-20 实测，不是假想风险）：Issue #1–#22 导入后一天内，`main` 上 27 个提交里有 **26 个没挂任何 Issue 号**（唯一挂号的只有 BLK-002 那条文档提交）。也就是说这一天里绝大部分工作，在台账上**完全看不见**；同时 27 个 Issue 全部仍为 open、0 assignee、0 PR。任何人（或任何代理）查台账都会得出「这些还没人做」的结论，于是同一件事被写第二遍。重复动工的根因不是不努力，是**看不到别人在做什么**。
>
> 📅 **上面这组数字是 2026-10-20 20:09 的快照，会过时。重测：**
>
> ```bash
> node scripts/claim.mjs ls --deep        # 底部「近 N 天 main 有 X 个提交，其中 Y 个没挂 Issue 号」
> ```
>
> 该命令**退出码非 0 就表示台账仍落后于代码**，此时本节的结论依然成立；等到它退 0（盲提交归零）时，本节从「铁律」降级为「常态」——不必再把它当作每次开工的头号风险来念。
> ⚠️ **窗口陷阱**：`claim.mjs` 的统计窗口默认 `--days 3`（[`scripts/claim.mjs:255`](../scripts/claim.mjs)），可覆盖；但本仓 2026-10-20 才创建、至今不足一天——**任何 ≥1 天的窗口都等于「全部历史」**。所以在仓库满 3 天之前，这个数字只说明「历史总量」，不能用来判断「最近有没有变坏」。判断趋势前先比：窗口天数 vs `git log --reverse --format=%ad | Select-Object -First 1`。

开工三步，一步都不能跳：

```bash
# ① 看台账：什么已认领、什么在评审、什么真空着，以及台账是否落后于代码
node scripts/claim.mjs ls --deep

# ② 认领（写 assignee + status:claimed，并在 Issue 下留痕）
node scripts/claim.mjs claim 16 --note "先做 schema 生成"

# ③ 从认领项开独立 worktree 分支（不动别人正在改的工作区）
node scripts/claim.mjs branch 16 curvelab
cd .worktrees/feat/16-curvelab
```

`claim ls` 会明确打印「近 N 天 main 有多少提交没挂 Issue 号」。**它报红的时候，台账不能当依据**——先对账（见 2.5），否则你正在准备的活很可能已经在 `main` 上了。

规则：

| 情况 | 处置 |
| :--- | :--- |
| 目标已被别人认领（`status:claimed` 或有开着的 PR） | **停**。到该 Issue 下评论沟通；确需接手用 `claim --force`，并在评论里说明 |
| 台账里没有这件事 | 先开 Issue（哪怕只写三行），再认领，再动手。**先干活后补票 = 不可见工作，正是重复动工的源头** |
| 做着做上不做了 | `node scripts/claim.mjs release <编号>` 释放。挂着 `claimed` 却不推进，等于占坑让别人不敢动 |
| 顺手改的碎活（改错别字、补一行文档） | 不必开 Issue，但提交信息里注明是有意的小改动 |

### 2.2 分支策略

```
main                       ← 所有认领后的改动经 PR 合入
  ├── feat/<issue>-<desc>        新功能（编号 = 认领的 Issue）
  ├── fix/<issue>-<desc>         缺陷修复
  ├── docs/<issue>-<desc>        文档
  ├── spec/<issue>-<desc>        契约/Schema 变更（需架构评审）
  └── chore/<issue>-<desc>       杂务/依赖升级
```

**规则**
- 分支名必须带 Issue 编号，用 `node scripts/claim.mjs branch <编号> <slug>` 生成——这样「远端有什么分支」和「台账上谁在做什么」永远对得上
- `main` 禁止直接 push，必须走 PR
- 一个 PR 只做一件事，超过 400 行 diff 请拆分
- 合并前必须 rebase 到最新 `main`，保持线性历史

> ⚠️ **这条目前靠自觉**：本仓是私有仓，GitHub 的分支保护要求 Pro 或公开仓库（实测 API 返回 403），所以「禁止直接 push main」在服务端**没有强制**。在权益到位前，用两条本地约束兜住：提交前 `pre-commit` 钩子必跑（见第八节），以及认领流程让「谁在改什么」可见。**别因为仓库里有 workflow 文件就以为远端在保护你**（详见 `docs/02-engineering/00-known-issues.md` BLK-001）。
>
> 📅 **失效条件（这条会整段作废）**：仓库转为公开、或 Pro 权益到位后，服务端分支保护可用——**立刻配置并删除本段**。
> 重测（只读；返回 403 `Upgrade to GitHub Pro…` = 仍不可用；返回 200 = 权益已到，本段到期）：
>
> ```bash
> gh api repos/meat-daemon-404/matrixos/branches/main/protection
> ```
>
> 本段是**临时绕过方案**，不是制度。临时方案最容易被误读成制度——它被写下来的那天起就开始等人来删它。

### 2.3 多会话 / 多代理并行

同一工作目录 `D:\MatrixOS` 可能被多个会话同时使用（已有先例，见 `docs/02-engineering/SECURITY.md` SEC-001）。约定：

```bash
node scripts/claim.mjs branch 16 curvelab   # 自动开 .worktrees/ 下的独立工作区
```

| 约束 | 做法 |
| :--- | :--- |
| **不在主工作区直接改** | 认领后的活都在 `.worktrees/<branch>/` 里做，主工作区只用于查状态 |
| **构建串行** | 两边都要 build 时用 `node scripts/safe-build.mjs`（带文件锁），否则 `.next/` 竞态 |
| **不要 `git add -A`** | 并发时它会收进别的进程留下的临时文件（曾误提交 `pytest-of-*/`、`tmp*`）。用 `git add -u -- <明确路径>` 或逐项确认 |
| **发现陌生产物** | 默认假设是用户另一个会话的正常产物，**先隔离再询问**，不要定性、不要删除 |

### 2.4 PR 与合并

```bash
node scripts/claim.mjs pr 16      # 用当前分支开 PR，正文自动写 Closes #16
```

合并后 Issue 由 GitHub 自动关闭。**合并之前**：本地 `pnpm check` 必须过（CI 未生效，本地是唯一强制门禁）。

### 2.5 台账对账：让 open Issue 的条数有意义

Issue 挂着 open 但活已经做完 = 在下一个人面前放了一个诱饵。所以：

- **确认已完成的**：`node scripts/claim.mjs done <编号> --evidence "..."`。脚本强制要求证据（测试输出 / 提交号 / PR 链接 / 文档路径），没有证据不给关；关闭时自动摘掉 `status:claimed` / `status:in-review`。
- **PR 合并自动关单的**：GitHub 侧关单不经过本工具，认领标签可能残留——`claim ls` 会列进「已关闭但残留认领标签」兜底提示，看到就 `done <编号> --evidence "补记"` 顺手清掉（见 Issue #33）。
- **只完成一半的**：在该 Issue 下评论写清「已有什么、还缺什么」，别关也别放着当没看见。
- **纯决策类**（要项目负责人拍板、要外部账号资质）：`node scripts/claim.mjs block <编号> --note "等学生认证到账"`。`blocked` 不是待办，不要用写代码的方式去「关闭」它。

**证据必须逐条对准验收句，不能只证明「做了一部分」。** 本轮真实教训：#27 要求「扫描**全库** `*.md`/`*.json`」，我只验证了「U+FFFD + BOM 扫描存在」就关单，没验证覆盖率——实测扫描范围只覆盖 133 个 tracked 文件中的 30 个，`apps/` 的 18 份 manifest 全在门外。更糟的是我在关闭评论里写了「扫描 72 个文件」：**那个数字本身没错，但它是另一个口径**（全部扩展名），用一个不矛盾的数字掩盖了真缺口，比数字写错更有害。Issue 已重开。

判据：验收句里的每个限定词（**全库** / **并发** / **由未参与者实测** / **有单测**）都是一个独立的关闭条件。有一个没满足，就是 PARTIAL，就该评论 + 保持 open，而不是关。

每个 Stage 收口时跑一次全量对账：`claim ls --deep --days 30`，把报出来的不可见提交逐个归到 Issue 上。第一轮对账结果与逐条缺口见 [`docs/02-engineering/08-ledger-reconciliation.md`](../docs/02-engineering/08-ledger-reconciliation.md)。


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
- 提交前校验通过（`pre-commit` 钩子会自动跑，见下方「提交前校验」）
- 涉及 `specs/` 契约变更需架构负责人额外批准
- 涉及视觉变更需附前后对比截图
- **PR 必须关联认领的 Issue**（正文含 `Closes #<编号>`）；没有 Issue 的 PR 无法判断它算不算「重复动工」，会被直接退回

**禁止**
- ❌ 提交 `node_modules`、`.env`、构建产物
- ❌ 提交包含真实用户数据或未发表实验数据的文件
- ❌ 在代码里硬编码 API Key

---

## 五、Issue 规范

**标题格式**：`[模块] 简述`，例如 `[11-curvelab] 置信带绘制偏差`

**开 Issue 之前先查台账**（`node scripts/claim.mjs ls`）——重复 Issue 和重复动工是同一个病的两种症状。已有相近的，去那条下面补充或认领，别再开一条。

**必须打标签**（标签定义在 [`.github/labels.txt`](labels.txt)，由 `scripts/sync-labels.mjs` 同步到仓库）
- 类型：`type:feature` / `type:bug` / `type:docs` / `type:spec` / `type:infra`
- 阶段：`stage-1` ~ `stage-4`
- 轨道（微站相关）：`orbit-1` ~ `orbit-7`
- 优先级：`P0` / `P1` / `P2`
- 认领状态：`status:claimed`（有人在写）/ `status:in-review`（PR 评审中）/ `blocked`（被外部依赖卡住）—— 这三个由 `scripts/claim.mjs` 自动维护，一般不用手动打

**验收标准必须是可判定的句子**。写「优化性能」的 Issue 无法关闭，只会变成永远 open 的噪音。

**缺陷报告**必须包含：环境、复现步骤、期望行为、实际行为、截图或日志。

---

## 六、契约变更流程（重要）

`specs/contracts/` 下的 JSON Schema 是跨微站的硬约束，内容哈希锁在
`specs/contracts/.drift-lock.json`。变更流程：

1. 开 Issue，标签 `type:spec`，说明为什么要改、影响哪些微站
2. 提交 PR，**同一 PR 内**同步三处：Schema 本体、`packages/matrix-sdk/src/contracts/schemas.ts`
   内嵌副本、`packages/twin-schema` 的 zod 校验器（后者是语义子集，需人工判断，不能机械复制）
3. 跑 `node scripts/check-contract-drift.mjs --repair` 重新入锁，并把锁文件一起提交
   （不带这一步，pre-commit 直接拒签——这是设计，不是故障）
4. 架构负责人评审，确认向后兼容策略
5. 若为 breaking change，在 PR 中给出迁移窗口，并登记到 `docs/02-engineering/CHANGELOG-contracts.md`
   （该文件尚未创建，首次 breaking change 时由登记人新建）

**铁律**：任何 `evidence_anchors` 字段的弱化（比如允许为空）都是合规红线，不允许通过。
两道锁拦的是「没同步就改」，**拦不住**「三处一起弱化」——后者靠评审。已知缺口：
`validate-specs.mjs [4/5]` 只检查 `required` 与三档枚举，不检查 `minItems: 1`
（实测把 `minItems` 改成 0，`pnpm check` 依旧全绿），已另开 Issue 跟踪。

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
- 提交前校验靠 `pre-commit` 钩子（见下节）

### 提交前校验（当前唯一的强制门禁）

仓库里有两个工作流——`.github/workflows/verify.yml`（契约/文档/编码校验）与 `sync-labels.yml`（标签同步）。它们**已被推上 GitHub 并且每次 push 都会触发，但因账户计费问题全部失败**（实测 8 次运行，3–5 秒即挂，日志 `BlobNotFound`，零步骤执行）。用户已提交学生认证，权益到位后它们会自动开始真正生效。

> 📅 **「实测 8 次」写于 2026-10-20 20:09，已经过时——不要在汇报里引用这个数，用时现测：**
>
> ```bash
> gh run list --limit 100 --json conclusion \
>   --jq 'group_by(.conclusion) | map({(.[0].conclusion): length}) | add'
> ```
>
> 2026-10-21 08:03 实测：**35 次运行，35 次 failure**（全部 4–5 秒即挂，零步骤执行）。
> **失效条件**：出现第一条 `success` 或步骤数 > 0 的运行，即说明权益已到、CI 已真正生效——此时本节从「唯一强制门禁」降级为「本地快检」，`预提交钩子` 不再承担唯一门禁职责，并应删除本段。

所以现阶段**本地 `pre-commit` 钩子是唯一有效的强制门禁**。看到仓库里有 workflow 文件就以为 CI 在保护你，是最危险的一种误解（详见 [`docs/02-engineering/00-known-issues.md`](../docs/02-engineering/00-known-issues.md) BLK-001）。

权益到位前，标签同步在本地做：

```bash
node scripts/sync-labels.mjs --dry-run   # 看会改什么
node scripts/sync-labels.mjs             # 把 labels.txt 同步到仓库
```

装钩子（新克隆仓库后执行一次）：

```bash
node scripts/install-hooks.mjs
```

装好后每次 `git commit` 自动跑：

| 检查 | 脚本 |
| :--- | :--- |
| 契约 Schema + 18 微站花名册 + 编码完整性 | `scripts/validate-specs.mjs` |
| **契约漂移锁**（冻结 schema 内容 vs `.drift-lock.json` 哈希） | `scripts/check-contract-drift.mjs` |
| Markdown 内部链接断链 | `scripts/check-doc-links.mjs` |

外加 SDK 侧的一致性测试 `packages/matrix-sdk/test/contracts.conformance.test.ts`
——它被 `packages/matrix-sdk/package.json` 的 `test` 脚本（`node --test "test/**/*.test.ts"`）
通配收集，管「内嵌副本没跟上契约」这一类漂移。

不通过则**拒绝提交**。手动跑：`pnpm check`。需要跳过：`git commit --no-verify`（仅在确认误报时用）。

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

**已加入自动化防线**：`scripts/validate-specs.mjs` 的第 6 项检查会扫描全库，发现 `U+FFFD` 或 BOM 即报错。`pre-commit` 钩子会在每次提交前自动执行，拦下问题。

---

## 九、沟通

- 设计/架构争议 → 开 Issue 讨论（本仓 **Discussions 未启用**，`has_discussions: false`，别去找那个入口），不要在聊天里定
- 决策一旦定下，必须写入 `docs/01-plan/04-tech-decisions.md`（ADR）
- 口头结论不算数，落文档才算

---

## 十、本规范的时效性

本文件不是宪法，是**一份会过期的说明书**。它最多能坏在这四个地方，按坏的速度排序：

| 失效方式 | 长什么样 | 谁会踩 | 怎么发现 |
| :--- | :--- | :--- | :--- |
| **临时绕过变成永久制度** | 「权益到位前先这样」写下了，权益到了没人回来删 | 后来者以为这是设计，照着执行一套早已没有必要的约束 | 全文搜「目前 / 暂时 / 现阶段 / 等到…前」，逐条问「这个条件现在成立吗」 |
| **实测快照当常量** | 「27 个提交里 26 个没挂号」「实测 8 次运行」 | 引用过期数字做判断，甚至据此得出相反结论 | 每个数字旁边必须有一条**可复现它**的命令；没有命令的数字不得作论据 |
| **计数漂移** | 「18 站点」「4 个包」——组件增删后正文没改 | 按错的地图找路 | `node scripts/check-doc-code.mjs`（正查+反查+计数一致，见 `pnpm check:doc-code`） |
| **时间窗口大于仓库寿命** | 「近 30 天」「近 3 天」全部退化为「全部历史」 | 把累计值当趋势值，看不出是在变好还是变坏 | 拿窗口天数和 `git log --reverse` 的首个提交比大小 |

### 10.1 三条硬规矩

1. **数字必须带重测命令。** 写下任何实测值（次数、条数、人数、耗时）时，同一处附上能重新量出它的那条命令。做不到就别写数字，改写成「在 X 条件下会 Y」的定性表述——**定性描述不会过期，定量快照会**。
2. **绕过方案必须写失效条件。** 凡是因为「现在还没有 Pro / CI 还没生效 / 只有两个协作者」而做的妥协，都必须带一行 `📅 失效条件：<可观测的事件>`，并注明**由发现条件成立的人删除**。到期不删等于把临时脚手架浇成混凝土。
3. **规范改动的正确时机是「它刚变得不对」的那一刻**，不是定期体检。发现规则与现实不符的人，有权也有义务当场改掉本条——不需要等评审，不需要问负责人。**唯一的要求是把改的依据（一条命令的输出）写进提交信息。**

### 10.2 修改本文时

- 只改「已经不对」的那一条，别顺手重写隔壁——一份 diff 越大，别人越不会读
- 删掉过期的绕过段落，比在它上面叠加「（已失效）」更干净；历史归 git 管，不归本文管
- 改完跑 `pnpm check:docs`（内部链接不断）与 `pnpm check:doc-code`（计数与代码一致）
