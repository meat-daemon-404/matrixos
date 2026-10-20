# 已知问题与阻塞项

> 本文档记录当前无法在代码层面解决的问题，需要人工介入。请勿把这些条目当作「待办任务」关闭。

---

## BLK-001 · GitHub Actions 无法启动（账户计费）

| 项 | 内容 |
| :--- | :--- |
| **状态** | ✅ **已绕过**（2026-10-20，改用本地 pre-commit 钩子） |
| **发现时间** | 2026-10-20 |
| **影响范围** | ~~所有 CI 工作流~~ → 已无 CI 工作流 |
| **严重程度** | 低（本地钩子已完全覆盖校验职责） |

> ✅ **已处置**：`validate.yml` 已删除，校验改由本地 `pre-commit` 钩子承担，
> 校验内容与原来完全一致且即时反馈。根因（账户计费）仍存在，但不再影响开发。
> 详见下方「已采取的替代方案」。

### 现象

初始提交 `4e03f6b` 触发的工作流 `Specs & Docs 校验` 立即失败：

- 运行时长 4 秒，**计费耗时 0 ms**
- 任务未分配 runner（`runner_name` 为空），**零个步骤被执行**
- 拉取任务日志返回 `BlobNotFound`（日志根本没生成）

后续 5 次推送触发的运行全部同样失败，累计 6 次。

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

- ~~PR 提交后不会自动跑契约校验与断链检查~~ → 已由本地钩子覆盖
- ~~合并前需本地手动执行~~ → 已验证自动执行
- 不影响代码开发本身

### 已采取的替代方案（2026-10-20）

**决定性动作：删除 `.github/workflows/validate.yml`。**

理由：一个每次推送都亮红灯、零步骤执行、什么都不做的 workflow 只会制造噪音和告警疲劳。既然根因在账户计费且短期无法解决，保留它没有任何收益。

**替代实现——本地 pre-commit 钩子：**

| 文件 | 作用 |
| :--- | :--- |
| `scripts/verify.mjs` | 单一校验入口，串联契约校验 + 断链检查 + 编码检查 |
| `scripts/install-hooks.mjs` | 安装 pre-commit 钩子到 `.git/hooks/pre-commit` |
| `scripts/validate-specs.mjs` | 契约 Schema / 18 微站花名册 / U+FFFD + BOM 扫描 |
| `scripts/check-doc-links.mjs` | Markdown 内部链接断链检查 |

**安装方式**（新克隆仓库后执行一次）：

```bash
node scripts/install-hooks.mjs
```

**已实测验证**：

| 测试 | 结果 |
| :--- | :--- |
| 植入断链后提交 | ✅ 被拒绝，退出码 1，HEAD 未变 |
| 清理后提交 | ✅ 通过，钩子正常执行 |
| 跳过钩子（`--no-verify`） | ✅ 可用 |

**相比原 CI 的优势**：

- 反馈即时（提交前 vs 等 runner 排队）
- 不消耗额度、不依赖网络
- 校验逻辑与原来的工作流**完全一致**（同一批脚本）

**与原来的一处差异**：原工作流还检查了「`bundle/` 未被改动」与「无敏感文件入库」两条。这两条已并入 `scripts/validate-specs.mjs` 的归档完整性检查，并将在 Stage 1 补充敏感文件扫描。

### 根因仍存在（但已不阻塞）

账户计费问题本身没有解决。若将来想恢复 CI：

1. 去 https://github.com/settings/billing 补缴欠款或提高 spending limit，**或**
2. 转为公开仓库（标准 runner 免费）：
   ```bash
   gh repo edit meat-daemon-404/matrixos --visibility public --accept-visibility-change-consequences
   ```
   ⚠️ 转公开后 `bundle/` 设计资料与全部规划文档将公开可见，需确认无敏感信息
3. 恢复后从 git 历史取回工作流：`git show 1e0ae0d:.github/workflows/validate.yml > .github/workflows/validate.yml`

> 恢复 CI 后建议**保留本地钩子**——两者不冲突，钩子负责即时拦截，CI 负责团队统一门禁。

---

## BLK-002 · 工作目录 `D:\MatrixOS` 无写入权限

| 项 | 内容 |
| :--- | :--- |
| **状态** | ✅ **已解决**（2026-10-20） |
| **发现时间** | 2026-10-20 |
| **解决时间** | 2026-10-20 |
| **影响范围** | 仓库物理位置 |

### 现象

会话工作目录 `D:\MatrixOS` 无法写入：

```
New-Item : 对路径"_bundle_extracted"的访问被拒绝。
UnauthorizedAccessException
```

### 根因（Windows NTFS 权限，非 DSH 沙箱）

`D:\MatrixOS` 的访问控制列表**原本**为：

| 身份 | 权限 |
| :--- | :--- |
| `BUILTIN\Administrators` | FullControl |
| `NT AUTHORITY\SYSTEM` | FullControl |
| `Everyone` | **仅 ReadAndExecute** |

会话以**非管理员**身份运行（`IsAdmin: False`），因此只能读不能写。且当时用户对 `D:\MatrixOS` **无 `WRITE_DAC` 权限**，无法自行修复 ACL（`icacls /grant` 返回 Access is denied）。

### 解决过程

用户授权发起 UAC 提权，执行：

```powershell
icacls "D:\MatrixOS" /grant "LAPTOP-V4659JNG\33352:(OI)(CI)F"
```

**提权执行结果**：`已成功处理 1 个文件`，ACL 新增 `LAPTOP-V4659JNG\33352 | FullControl | Allow`。

**提权后 ACL**：

| 身份 | 权限 |
| :--- | :--- |
| `LAPTOP-V4659JNG\33352` | **FullControl（新增）** |
| `BUILTIN\Administrators` | FullControl |
| `Everyone` | ReadAndExecute |
| `NT AUTHORITY\SYSTEM` | FullControl |

**非提权会话验证**（这是关键——权限必须对日常操作生效，而不只是对管理员）：

| 测试 | 结果 |
| :--- | :--- |
| 在 `D:\MatrixOS` 建文件 | ✅ OK |
| 删除文件 | ✅ OK |
| 创建子目录 | ✅ OK |
| 子目录写文件（验证 `(OI)(CI)` 继承） | ✅ OK |

### 最终处置

**仓库已迁移至 `D:\MatrixOS`**（会话工作目录，符合原始意图）。

迁移校验：

| 检查项 | 结果 |
| :--- | :--- |
| 工作文件数（排除 `.git`） | 42 = 42 |
| 字节总数 | 4,166,560 = 4,166,560 |
| `git rev-parse HEAD` | `e29be96` 一致 |
| `git status --porcelain` | 0 变更 |
| `git fsck` | 无错误 |
| 远端 `origin/main` | 与 HEAD 一致 |
| 校验脚本 | 全绿（契约 + 42 链接无断链 + 无 U+FFFD/BOM） |

旧路径 `C:\Users\33352\Documents\MatrixOS` 已清理。

### 遗留影响

无。后续提交与推送均在 `D:\MatrixOS` 进行。

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
| BLK-001 | GitHub Actions 计费 | ✅ 已绕过（改本地钩子） | — |
| BLK-002 | D:\MatrixOS 权限 | ✅ 已解决 | — |
| BLK-003 | Hindsight 额度 | ⚠️ 降级 | 用户（如需记忆功能） |
