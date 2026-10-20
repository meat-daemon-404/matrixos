# 已知问题与阻塞项

> 本文档记录当前无法在代码层面解决的问题，需要人工介入。请勿把这些条目当作「待办任务」关闭。

---

## BLK-001 · GitHub Actions 无法启动（账户计费）

| 项 | 内容 |
| :--- | :--- |
| **状态** | 🔴 阻塞中，需人工处理 |
| **发现时间** | 2026-10-20 |
| **影响范围** | 所有 CI 工作流（`.github/workflows/validate.yml`） |
| **严重程度** | 中（不阻塞开发，但 PR 无法自动校验） |

### 现象

初始提交 `4e03f6b` 触发的工作流 `Specs & Docs 校验` 立即失败：

- 运行时长 4 秒，**计费耗时 0 ms**
- 任务未分配 runner（`runner_name` 为空），**零个步骤被执行**
- 拉取任务日志返回 `BlobNotFound`（日志根本没生成）

### 根因（GitHub 官方返回的注解）

```json
{
  "annotation_level": "failure",
  "message": "The job was not started because recent account payments have failed
              or your spending limit needs to be increased.
              Please check the 'Billing & plans' section in your settings"
}
```

**这是账户计费问题，不是工作流配置问题。**

已确认排除的其他可能：

| 检查项 | 结果 |
| :--- | :--- |
| Actions 是否启用 | ✅ `enabled: true` |
| 允许的 Action 范围 | ✅ `allowed_actions: all` |
| 工作流 YAML 语法 | ✅ 已本地跑通两个脚本，均通过 |
| 仓库是否私有 | ⚠️ 私有（私有仓消耗额度更快） |

### 影响

- PR 提交后不会自动跑契约校验与断链检查
- 合并前需**本地手动执行** `node scripts/validate-specs.mjs && node scripts/check-doc-links.mjs`
- 不影响代码开发本身

### 解决方案（需用户操作）

任选其一：

1. **补缴欠款/提高额度**（推荐）
   - 访问 https://github.com/settings/billing
   - 检查 Payment information 是否有失败支付
   - 检查 Spending limit 是否被设为 $0

2. **改用公开仓库**
   - 公开仓的标准 runner 完全免费，不消耗额度
   - 命令：`gh repo edit meat-daemon-404/matrixos --visibility public --accept-visibility-change-consequences`
   - ⚠️ 注意：转为公开后 `bundle/` 里的设计资料与全部规划文档将公开可见，需确认无敏感信息

3. **接入自托管 runner**（长期方案，成本高）

### 恢复后的验证方式

```bash
gh workflow run validate.yml
gh run list --limit 1
# 期望：completed / success，且步骤列表非空
```

### 在此之前的工作流

本地预检（提交前必跑）：

```bash
node scripts/validate-specs.mjs
node scripts/check-doc-links.mjs
```

这两个脚本与 CI 中执行的是**完全相同**的命令，本地通过即等于 CI 会通过（除环境差异外）。

---

## BLK-002 · 工作目录 `D:\MatrixOS` 无写入权限

| 项 | 内容 |
| :--- | :--- |
| **状态** | ⚠️ 已绕过，但需用户知晓 |
| **发现时间** | 2026-10-20 |
| **影响范围** | 仓库物理位置 |

### 现象

会话工作目录 `D:\MatrixOS` 无法写入：

```
New-Item : 对路径"_bundle_extracted"的访问被拒绝。
UnauthorizedAccessException
```

### 根因（Windows NTFS 权限，非 DSH 沙箱）

`D:\MatrixOS` 的访问控制列表：

| 身份 | 权限 |
| :--- | :--- |
| `BUILTIN\Administrators` | FullControl |
| `NT AUTHORITY\SYSTEM` | FullControl |
| `Everyone` | **仅 ReadAndExecute** |

当前会话以**非管理员**身份运行（`IsAdmin: False`），因此只能读不能写。

`D:\` 根目录同样受此限制，且当前用户对 `D:\MatrixOS` **无 `WRITE_DAC` 权限**，无法自行修复 ACL（`icacls /grant` 返回 Access is denied）。

### 实际处置

仓库建在 **`C:\Users\33352\Documents\MatrixOS`**（可写），已正常完成全部工作并推送至 GitHub。

`D:\MatrixOS` 保持为空目录，未使用。

### 如需迁回 D 盘（需用户以管理员身份操作）

```powershell
# 管理员 PowerShell
icacls "D:\MatrixOS" /grant "LAPTOP-V4659JNG\33352:(OI)(CI)F"
# 然后把 C:\Users\33352\Documents\MatrixOS 的内容移过去
```

---

## BLK-003 · Hindsight 记忆库额度耗尽

| 项 | 内容 |
| :--- | :--- |
| **状态** | ⚠️ 降级运行 |
| **发现时间** | 2026-10-20 |

### 现象

```
POST .../knowledge-base/pages -> 402
Insufficient credits. Balance: $-0.07, Estimated cost: $0.0500
```

### 影响

- 无法自动沉淀项目知识页与决策记忆
- 不阻塞开发，仅影响跨会话记忆能力
- 当前项目知识以仓库内文档为准（`docs/` 即为事实源，这是更好的实践）

---

## 跟踪表

| ID | 阻塞项 | 状态 | 需谁处理 |
| :--- | :--- | :--- | :--- |
| BLK-001 | GitHub Actions 计费 | 🔴 待处理 | 用户（账单/仓库可见性） |
| BLK-002 | D:\MatrixOS 权限 | ⚠️ 已绕过 | 用户（如需迁回） |
| BLK-003 | Hindsight 额度 | ⚠️ 降级 | 用户（如需记忆功能） |
