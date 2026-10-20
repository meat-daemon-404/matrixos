# 台账对账：open Issue × main 实际代码（2026-10-20）

> 基线提交：`df584df`（本表每一条都以 `git show origin/main:<path>` / `git ls-tree -r origin/main` 为准，**不以工作区文件为准**——见「前提」）
> 产生方式：#28 建立认领流程后做的第一轮对账。逐条判定来自只读审计，关键数字（扫描覆盖率 30/133、matrix-core 7 个测试文件、`IMPLEMENTED_SITES` 18 站）已由 Lead 独立复核。
> 配套工具：`node scripts/claim.mjs ls --deep` 可复现本表第「信号」列。

---

## 前提：为什么必须对着 git 判，不能对着目录判

同一工作目录 `D:\MatrixOS` 被用户另一个会话共用（见 [SECURITY.md](SECURITY.md) SEC-001）。它有一批**未提交**的工作：

```
services/matrix-core/app/{api/routes,models,schemas,services}/pocket.py
services/matrix-core/alembic/versions/0002_pocket.py
services/matrix-core/tests/test_pocket_{api,service,ws}.py   ← 59 个测试
packages/xz-knowledge/  packages/instrument-ui/test/  docs/03-xz-integration/
scripts/scrape-xz/  apps/wechat-pocket/mock-server/  18 个 globals.css 改动
```

在 `services/matrix-core` 里 `pytest --collect-only` 会收集到 **194** 个测试，但其中**只有 135 个在 main 上**。

> 两个方向的误判都会发生：对着目录判，会把 pocket 的工作算进 Issue 已完成（本表没有）；反过来把「135」读成「测试都绿了」也不对——那是 **collect-only（可收集）口径，不是 observed green（实测通过）**。本表凡用此口径处均已标注。

---

## 结论：台账不是「做完了没关」，是「开了票但没标已完成」

27 条判定（#28 已认领，排除在外）：

| 判定 | 条数 | Issue |
| :--- | ---: | :--- |
| **DONE** | **0** | — |
| **PARTIAL** | **16** | #1 #2 #4 #6 #8 #9 #10 #11 #12 #15 #16 #17 #18 #19 #21 #27 |
| **NOT_STARTED** | **7** | #3 #5 #7 #13 #14 #20 #22 |
| **决策类（代码无法关闭）** | **4** | #23 #24 #25 #26 |

这**推翻了立项目初的假设**。原本以为病是「活干完了票还开着」，实测是相反的失真：票确实都还开着，但它们**严重低报了 main 上已有的代码量**。

因此本轮的处理原则：

- **不重做**——PARTIAL 的代码是真实、已提交、多数带测试的。
- **不关闭**——每条 PARTIAL 都卡在**验收句里的某一个子句**，那才是真 backlog，而现在没有任何票写着它。
- 所以正确动作是**把缺的子句钉在票上**，不是改票的状态。

---

## 逐条：已有什么 / 缺什么

| # | 判定 | main 上已有（文件路径） | 卡在哪个子句（真 backlog） |
| :-- | :-- | :--- | :--- |
| #1 S1-01 | PARTIAL | `pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`、24 个 workspace 包 | 票面点名 `contracts/` `e2e/` 目录**不存在**（契约实际在 `specs/contracts/`）；「新增包自动纳入且命中缓存」无证据 |
| #2 S1-02 | PARTIAL | `packages/twin-schema/`：162 个测试，红线 `缺 evidence_anchors → 失败` | AssetNode/Edge **无 Draft-07 schema**（只有 zod）；「TS 类型由**代码生成**保证一致」——无任何 codegen。⚠️ 需裁决：冻结的 4 份契约是否取代 WBS 点名的 3 份 |
| #3 S1-03e | NOT_STARTED | 无 | 需真实 CAS 测试账号 + 微信主体资质 → 非代码 |
| #4 S1-04 | PARTIAL | `matrix-sdk/src/contracts/schemas.ts` 是 `specs/contracts/*.json` 的逐字节镜像 | **护栏文件不存在**：`schemas.ts:9`、`types.ts:19/16` 都引用 `test/contracts.conformance.test.ts`，main 上没有 → **现在改 schema 不会变红**（票面要求「故意改一个字段必须红」） |
| #5 S1-05 | NOT_STARTED | 仅本地 `.turbo/cache` | `turbo.json` 无 `remoteCache`、无 `TURBO_TOKEN`；CI 不能跑（BLK-001） |
| #6 S1-06 | PARTIAL | 分层 + DI + 统一错误体 `{code,message,trace_id}`（有测试证明）+ Dockerfile | 「OpenAPI 快照导出到 `contracts/openapi/`」未做；`docker-compose.yml` 里 matrix-core 服务块仍被注释 |
| #7 S1-07e | NOT_STARTED | 只有 `02-prototype-status.md` 证明工具散在 3 种栈 4 个站 | `03-work-breakdown.md:300` 附录仍是空模板；42 工具零分级——需原型私有源码访问权 |
| #8 S1-08 | PARTIAL | `test_auth.py` 38 个测试，含 `test_replay_revokes_entire_family`、`test_logout_blacklists_jti`、PKCE/S256 强制 | `mx_rt` 30 天滑动仅在 `config.py:63`，**无测试断言**；G1 要的 E2E 录屏无 |
| #9 S1-09 | PARTIAL | `introspect`/`exchange` 路由 + `test_idt_exchange_is_single_use`、`test_idt_ttl_is_120_seconds` | 「有**并发**交换的单测」未做（无 ThreadPool/asyncio.gather）；120s 过期后返 401 只断言了配置值 |
| #10 S1-10 | PARTIAL | `0001_initial.py` 建 `asset_node/edge/chunk` + `Vector(1024)` + **HNSW 索引** + 完整 `downgrade()` | 无一次真实 `alembic upgrade head` 记录；`dev_init.py:8` 反而说该迁移在 SQLite 有问题。需人跑一次活库 |
| #11 S1-11 | PARTIAL | `assets.py` 全套 CRUD+search，35 个越权测试全拒 | 「top-5 在 **≥100 条标注集** 命中率 ≥80%」**完全未测**（无标注集、无 recall 工具）；「失败不留半条数据」无回滚测试 |
| #12 S1-12 | PARTIAL | `graph.py` 三种关系 + `trace_two_hops` + DB 层 `UniqueConstraint` 幂等 | **零功能测试**：`test_authz.py` 只断言越权拒绝，「2 跳内找到溯源」「重复跑不产生重复边」无演示 |
| #13 S1-13 | NOT_STARTED | 无 | 无迁移脚本、无「无法迁移清单」 |
| #14 S1-14 | NOT_STARTED | 无 | **`services/scholar-toolbox` 目录根本不存在** |
| #15 S1-15 | PARTIAL | `scripts/gen-site.mjs`（74 KB）+ `--force` 可重生 18 站 | 不产出票面要的「CI 配置」；新站的登录/资产写入未证实（后端未部署）；「≤1 人日由**未参与开发的工程师**实测」——单代理仓库无法自证 |
| #16 S1-16 | PARTIAL | 6 站齐备且远超骨架；19 站已上线、全 200、iframe 可嵌（见 [06-cloudflare-deploy.md](06-cloudflare-deploy.md)） | 「**登录状态跨站共享**」「每站能写入并读回自己的资产」未满足 |
| #17 S1-17 | PARTIAL | `initSSO`/`emitAsset`/CSRF 双提交注入/虫洞/manifest 校验齐全 | 「6 站全部通过 SDK 完成鉴权与资产写入」未满足；**`packages/matrix-sdk/README.md` 在 main 上不存在**；仅 1 个测试 |
| #18 S1-18 | PARTIAL | `[2/5]` 强制 18 站/id 连续/域名唯一；3/5/7/3 算术**写在生成器里**（`gen-site.mjs:378`） | 票面验收「删一站必须报出**轨道 X 站数不符**」达不到——`validate-specs.mjs` 只报「缺失 id 03 / 数量 17」，它从不按分组计数；而 `verify.mjs`/`gate.mjs` 调的是它，不是 gen-site |
| #19 S1-19 | PARTIAL | `verify.yml` 已入库（契约/链接/只读/密钥四类守卫） | 一次都没跑起来（BLK-001，8 次全失败）；typecheck/test/lint 三个 job **仍被注释**；无预览部署、无 branch protection（私有仓 403） |
| #20 S1-20 | NOT_STARTED | 手写 `X-Trace-Id` 关联（有测试） | `git grep -i opentelemetry\|otel\|jaeger origin/main` = **0 命中**。无 OTel SDK、无导出器、无 Jaeger、无 toolbox 服务 |
| #21 S1-21 | PARTIAL | `core/redaction.py`（MASK + 敏感键/payload 正则，structlog 预渲染处理器）；SDK 侧 `errors.ts` 剥离 token | 「脱敏规则**有单测**」未满足——测试里 grep `redact` = 0 命中，无 `test_redaction.py` |
| #22 S1-22 | NOT_STARTED | 无 | 无 G1 报告；且 G1 的 7 条里 #1/#3/#4/#5/#6 条分别被 #4/#11/#14/#15/#20 卡着。**注**：`04-implementation-status.md` §4 记的「全仓 build 默认并发 17–20/22、仅 `--concurrency=2` 达 22/22」使 G1 第 7 条本身存疑 |
| #23 决策 | NEEDS_HUMAN | ADR-001 已记初步裁定（列 Backlog） | 需项目负责人在 A/B/C 中选；选 B/C 会连带动 3/5/7/3 门禁与 `microsites.json` |
| #24 决策 | NEEDS_HUMAN | — | ¥1.5 vs ¥1.76 口径、逐月现金流、15000+6000 对应哪几条大创预算——财务事实，非代码 |
| #25 决策 | PARTIAL＋NEEDS_HUMAN | **可用性一半已答**：`02-prototype-status.md`（`e29be96`）实测四站全 200 + 框架判定 + 可复现命令 | 源码归属未答（预职仓库始终没找到、桌面版与网页版是否同库）；「更新 WBS 数字」只给了定性结论未落数 |
| #26 决策 | NEEDS_HUMAN | `05-risks.md §7` 七项全标「⬜ 待决」 | 七项负责人裁定；其中「A5 开放生态是否必须」决定 ADR-08 iframe vs Module Federation，会牵动 S2 |
| #27 工程 | PARTIAL | 约定已成文（CONTRIBUTING 中文编码红线）+ `[6/9]` U+FFFD/BOM 扫描 + 钩子强制 | 票面要求「扫描**全库** `*.md`/`*.json`」，实测 `SCAN_DIRS` 只覆盖 **30 / 133** 个 tracked 文件——`apps/`（18 份 manifest）、`packages/`、`services/`、根 `README.md` **全在未覆盖的 103 个里**。当前无损坏，但微站 manifest 被打坏会**一声不响过关** |

> #27 曾被本轮误关，已重开并在票上写明缺口。教训已写进 [CONTRIBUTING 2.5 节](../../.github/CONTRIBUTING.md)：`done --evidence` 的证据必须逐条对准验收句，不能只证明「做了一部分」。

---

## 系统性堵点：一次部署解开七条

[06-cloudflare-deploy.md](06-cloudflare-deploy.md) 记着一句决定性的话：

> 后端未部署 —— `matrix-core` 仍在本地。微站的 SSO / 资产写入走**本地 mock**

这一件事同时卡住 **#8 #9 #11 #15 #16 #17 #22**：代码已提交、测试已存在，但生产 URL（`*.mx-orbital.pages.dev`）够不着后端，所以「跨站登录共享」「资产写读回」永远无法认证。**部署 matrix-core（Workers 需换 Python 运行时，或上 VPS）不需要写新功能代码，却能把这七条从 PARTIAL 变成可证**。这是当前投入产出比最高的一步，且需要人做 hosting 决策。

---

## 没挂票的工作（不登记就会被重做）

main 上这些交付物**不对应任何 open Issue**——只看台账的人会当成没人做过：

| 提交 | 交付物 | 关键文件 |
| :--- | :--- | :--- |
| `156292d` | **19 站 Cloudflare Pages 生产部署**，全 200、iframe 可嵌、0 失败请求 | `deploy-pages.mjs`、`build-static-site.mjs`、`lib/pages-headers.mjs` |
| `ce8b6f0` `d9921cc` `357382a` | 线上安全头加固（CSP `frame-ancestors` 白名单 + HSTS）、metadata 单一事实源、18 站 icon | `site-icons.mjs`、`assert-config-restored.mjs`、`redeploy-headers.mjs` |
| `b2fe0d5` | 内置 Chromium + **原生 CDP 客户端**（绕开 Playwright↔Chrome 156 不兼容） | `scripts/cdp.mjs`、`cf-shell.mjs` |
| `7a019a1` `1675542` `f54e57e` | 健康门禁 `gate.mjs`（5 段）+ **构建串行锁**（`--concurrency` 竞态修复） | `gate.mjs`、`safe-build.mjs`、`doctor.mjs`、`install-hooks.mjs` |
| `0cf78fa` `be8a0b1` | #16 只票了 6 站，**多出来的 12 站接入真实仪器无人知晓** | `shared/src/index.ts`、`wire-instrument.mjs`、18 × `site-instrument.tsx` |
| `aefcefc` `df584df` `d9921cc` | 线上盒子测量审计套件（布局/P0 缺陷验证） | `audit-online.mjs`(50 KB)、`verify-hub-layout.mjs`、`measure-hub-layout.mjs` |
| `17b856c` | 并行会话隔离 + 源码混杂标记扫描（`[7/9]` `[8/9]`）、SEC-001 | `validate-specs.mjs`、`SECURITY.md` |
| `9efbc5a` `b1c1461` `1e0ae0d` | CI 移除→本地钩子迁移决策 + BLK-001/002/003 登记 | `verify.yml` 头部、`00-known-issues.md` |
| `4e03f6b` `6c9a8ca` | 协作底座：Issue/PR/标签模板、ADR-000/001、**以及造出 #1–#22 的那个导入器自己都没票** | `import-stage1-issues.mjs`、`.github/*` |

---

## 下一步（按此顺序做，别并行）

1. **修 [04-implementation-status.md](04-implementation-status.md)**（#30）——它是全仓被引用最多的状态入口，现在正主动误导人重写 matrix-core 的 135 个测试和 18 站的仪器接线。**这条优先于任何新功能开发**。
2. **补 #4 的护栏文件** `contracts.conformance.test.ts`——三处源码注释声称它存在，实际改 `specs/contracts/` 不会变红；这是合规红线的假门。
3. **决定 matrix-core 的部署方式**（负责人）——一次部署解开七条。
4. 把 #23 #24 #25 #26（+ #3 #5 #7 #19 的外部依赖）标 `blocked`，停止在台账里冒充待办。
5. 「没挂票的工作」表逐条补票或就地归档，否则下一轮仍会被重做。
6. 每条 PARTIAL 的「卡在哪个子句」应成为票上的显式勾选项——那是 Stage 1 真实剩余量，167 pd 的估时目前没有反映它。
