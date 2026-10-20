# 仓库实现状态盘点

> 盘点日期：2026-10-20
> 方法：逐模块枚举文件、实际运行 typecheck / build / pytest / vitest，统计口径见文末「口径说明」。
> **本文档只记录实测结果。任何未经运行验证的数字都标 ⚠️。**

---

## ⚠️ 本文正文的判定已被 2026-10-20 晚间一轮实现推翻（增量更正见下，正文保留原貌备查）

一轮针对「P0/P1 双端协同」的落地改了本文多处判定。以下是**复核后**的增量：

| 本文原结论 | 现在的实测状态 | 复现命令 |
| :--- | :--- | :--- |
| matrix-core「零自动化测试」「无 pocket 路由」 | 新增 `app/{api/routes,models,schemas,services}/pocket*` 四层实现（13 端点 + 桌面扩展 `claim`/`done` + WS `/v1/pocket/stream`）；**196 passed**（基线 132 + 新增 64） | `cd services/matrix-core; .\.venv\Scripts\python.exe -m pytest tests` |
| wechat-pocket「视图层 0 个页面、无法启动」 | `app.ts` + 6 页面四件套（4 主包 + 2 分包）+ 2 复用组件 + 8 张 81×81 tabBar PNG；tsc **0 错误** | `cd apps/wechat-pocket; npx tsc -p tsconfig.json`；`node scripts/verify-view-layer.cjs` |
| `mock-server/` 整个不存在 | `server.cjs`（零依赖，16 端点 + 手写 RFC6455 WS）+ `selftest.cjs`（**63 条断言全绿**）+ README | `cd apps/wechat-pocket; node mock-server/selftest.cjs` |
| orbital-hub「无队列接收器」（全量搜 pocket/queue 零命中） | `src/lib/queue-client.ts`（fetch/WebSocket/timer 全注入）+ `components/QueueReceiver.tsx`，挂在 `app/page.tsx` 与 OrbitalHub 平级；**21 用例全绿** | `cd apps/orbital-hub; node --test src/lib/queue-client.test.mjs` |
| instrument-ui「test 指向不存在的 self-test.mjs，pnpm test 直接失败」 | 改用仓库既有约定 `node --test "test/**/*.test.ts"`；**77 用例**覆盖 math/stats/contrast | `cd packages/instrument-ui; node --test "test/**/*.test.ts"` |

**通过测试总数：385 → 679**（385 + instrument-ui 77 + matrix-core 196 + hub 21）。
mock-server 的 63 条是独立自测脚本，不经 turbo，未计入该总数。

两处**源码缺陷**是补测试过程中发现并修掉的，不是测试写错：

1. `inverseNormalCdf(p)` 在 `p = 0 / 1 / NaN` 时走到 `sqrt(-2·log(0)) = ∞` 再 `∞/∞ = NaN`。它喂给置信带宽度，NaN 等于让 Canvas **静默画不出**置信带——比画错更难排查。改法：退化端夹进 `[1e-12, 1−1e-12]`，开区间内取值一字节未动，`<1.15e-9` 精度承诺不受影响。
2. 小程序 `core/sync.ts` 的 `dispatch()` 漏了 `mentor.stage` 分支，而 `types.ts` 早就声明过这条下行——事件被 `default` 分支静默吞掉，表现是「桌面推进进组阶段后手机端不更新」。已补 `SyncEvent` 与 case。

顺带把两条「写在文档里但没落到脚本」的约定做实：

- `contrast.test.ts` 现在解析 `tokens.css` 的比值注释并断言其等于 `worstContrast(hex, SURFACE_LIST)`（实测 17/17 精确命中，最坏情况即最亮表面 `#0f172a`），并校验 `✓ AA/AAA` 站得住、`✗` 确实不过 4.5:1。这正是 `contrast.ts` 头注释自陈缺失的「可执行的守卫」。
- `scripts/safe-build.mjs` 兜底注入 `--concurrency=2`（显式指定则尊重），于是 §4 描述的 ENOENT 假红灯不再由 `pnpm build` 触发。

**仍然成立、本轮未动**：18 微站的业务完备度、copilot-router `api.py`/`api_models.py` 0% 覆盖、pat-worker 未接入 matrix-core、`pnpm test` 看不见三个 Python 服务。

---

## 一句话结论

**脚手架已经铺满 9 个模块，但"能构建"不等于"有功能"。**

- 逻辑层（类型契约、鉴权、SDK、设计系统、路由分发）**已实现且质量不错**
- 业务层（18 个微站的实际工具、小程序页面、pocket 接口）**基本是骨架**
- 有真实测试的只有 4 个模块，其中 3 个是纯函数/契约层

| 维度 | 实测 |
| :--- | :--- |
| 工作区包 | 23 个（3 packages + 19 apps + 1 非 workspace 的 wechat-pocket） |
| typecheck | **25/25 通过**（23 个包 + 2 个依赖前置 build） |
| build | **22/22 通过，但默认并发下不稳定**（详见 §4） |
| 自动化测试 | **385 个通过**，集中在 4 个模块 |
| Python 源码 | 96 文件语法全部正确 |
| 有测试的模块 | 4 / 9 |
| 能构建的模块 | 7 / 9（matrix-core、copilot-router、pat-worker 是 Python，无 turbo build） |

---

## 主表：9 个模块的完成度

| # | 模块 | 状态 | 源文件 | 代码文件 | 测试文件 | 通过测试 | 可构建 | 说明 |
| :-- | :--- | :--- | --: | --: | --: | --: | :-- | :--- |
| 1 | `packages/twin-schema` | ✅ **已实现** | 15 | 15 | 4 | **162** | ✅ | 三份契约 JSON Schema + zod 校验，测试覆盖充分 |
| 2 | `packages/matrix-sdk` | ✅ **已实现** | 20 | 20 | 1 | 1 | ✅ | SSO / 虫洞 / iframe 桥 / manifest 校验齐全，但只有 1 个 smoke 用例 |
| 3 | `packages/instrument-ui` | ✅ **已实现** | 46 | 45 | 0 | **0** | ✅ | 10 个仪器组件 + 设计 token，**零自动化测试** |
| 4 | `services/matrix-core` | 🔶 **部分实现** | 50 | 44 | 0 | **0** | n/a（Python） | 鉴权/资产/虫洞路由真实存在，**零测试**，无 pocket 接口 |
| 5 | `services/copilot-router` | ✅ **已实现** | 18 | 16 | 8 | **179** | n/a（Python） | 覆盖率 **81%**，9 个模块里测试最扎实的一个 |
| 6 | `services/openalex-pat-worker` | 🔶 **部分实现** | 32 | 27 | 2 | **43** | n/a（Python） | 有热度计算逻辑与测试，但**未接入 matrix-core** |
| 7 | `apps/orbital-hub` | 🔶 **部分实现** | 27 | 27 | 0 | 0 | ⚠️ 不稳定 | 总控台组件齐全，但**无队列接收器**，干跑 22 站数据 |
| 8 | `apps/wechat-pocket` | 🔶 **部分实现** | 20 | 20 | 0 | 0 | ❌ 无 build 任务 | 逻辑层完整，**视图层 0 个页面** |
| 9 | `apps/micro-sites`（18 站） | 🔶 **仅骨架** | 306 | 270 | 0 | 0 | ⚠️ 不稳定 | 18 站均由 `gen-site.mjs` 生成，页面是占位骨架 |

**合计通过测试：162 + 1 + 179 + 43 = 385。**

---

## 逐模块详述

### 1. `packages/twin-schema` — ✅ 已实现

| 项 | 值 |
| :--- | :--- |
| 源文件 / 代码行 | 15 / 约 2,050 行 |
| 测试 | 4 个文件，**162 个用例全部通过** |
| 构建 | ✅ `tsc` 通过 |

测试分布在四份契约上，粒度较细：

| 测试文件 | 用例数 |
| :--- | --: |
| `asset-graph.test.ts` | 51 |
| `matrix-app-manifest.test.ts` | 47 |
| `dispatch-contract.test.ts` | 32 |
| `wormhole-envelope.test.ts` | 32 |

判定依据：这是唯一一个"实现 + 测试"都完整的模块，可作为其他模块的参考标准。

---

### 2. `packages/matrix-sdk` — ✅ 已实现

| 项 | 值 |
| :--- | :--- |
| 源文件 | 20 |
| 测试 | 1 个文件，**1 个用例**（`_smoke.test.ts`） |
| 构建 | ✅ `tsc -p tsconfig.build.json` 通过 |

实现了 `auth/sso`、`wormhole`、`iframe/bridge`、`contracts/validate`、`manifest/validate`、`http/client`、`security/origin`、`runtime/env` 等 8 个子域。

⚠️ **测试几乎为零**：只有 1 个 smoke 用例，而 `iframe/bridge` 与 `security/origin` 恰恰是最需要测试的安全敏感面（跨源消息校验）。这是风险点，不是完成度问题。

---

### 3. `packages/instrument-ui` — ✅ 已实现（但无可执行测试）

| 项 | 值 |
| :--- | :--- |
| 源文件 / 代码行 | 46 / 约 14,670 行（含 CSS） |
| 组件 | 10 个：`StarOrbit` `OscilloscopeCanvas` `DampedKnob` `FluidGaugeBank` `PrecisionBalance` `SonarDisc` `TaskKanban` `WormholeRing` `EvidenceLink` `CopilotWaveDock` |
| 构建 | ✅ `vite build` 通过 |
| 测试 | ❌ **0 个** |

`package.json` 的 `test` 脚本是：

```
"test": "node ../../scripts/self-test.mjs --package instrument-ui"
```

但 **`scripts/self-test.mjs` 不存在**（`scripts/` 下只有 9 个 .mjs，无此文件）。所以 `pnpm test` 在这个包上会直接失败。

底层数学工具 `lib/stats.ts`（约 8 KB）、`lib/math.ts`（约 7 KB）、`lib/contrast.ts` 都是纯函数，**本可以低成本补测试**，是目前性价比最高的补测点。

---

### 4. `services/matrix-core` — 🔶 部分实现

| 项 | 值 |
| :--- | :--- |
| 源文件 / 代码行 | 50 / 约 5,880 行 |
| 测试 | ❌ **0 个**（`pyproject.toml` 配了 `testpaths = ["tests"]`，但 `tests/` 目录不存在，pytest 直接报 "No files were found in testpaths"，退出码 1） |
| 构建 | n/a（Python 服务，无 turbo build 任务） |

已挂载的路由（`app/api/routes/__init__.py` 聚合 4 个 `APIRouter`）：

| 路由文件 | 端点 | 状态 |
| :--- | :--- | :--- |
| `health.py` | `GET ""` / `GET /ready` / `GET /detail` | ✅ 真实实现（存活/就绪/依赖明细） |
| `auth.py` | OAuth2 `authorize`、token 交换、refresh、`userinfo`、`logout`、`jwks`、`sites` 等约 15 个 | ✅ 真实实现（RS256、JWKS、jti 黑名单） |
| `assets.py` | 列表/详情/PATCH/DELETE + 约 5 个 POST（切片、关联等） | ✅ 真实实现（含乐观锁） |
| `wormhole.py` | 收据签发/查询等 4 个 | ✅ 真实实现 |
| **`pocket.py`** | **不存在** | ❌ 小程序需要的 10 条 `/v1/pocket/*` 全无 |
| **`pat.py`** | **不存在** | ❌ `openalex-pat-worker` 未通过本服务对外暴露 |

配套设施齐备：`alembic/versions/0001_initial.py` 初始迁移、`core/security/`（crypto/keys/passwords/scopes/tokens）、`core/ratelimit.py`、`core/tracing.py`、`core/redaction.py`。

**主要短板**：一个承载鉴权与资产的核心服务，**零自动化测试**。`pyproject.toml` 里连 `pytest`、`pytest-asyncio`、`pytest-cov`、`aiosqlite` 都已在 `[project.optional-dependencies].test` 里声明好了，只差用例。

---

### 5. `services/copilot-router` — ✅ 已实现（测试最扎实）

| 项 | 值 |
| :--- | :--- |
| 源文件 / 代码行 | 18 / 约 5,190 行 |
| 测试 | 8 个文件，**179 个用例全部通过** |
| 覆盖率 | **81%**（1,659 语句，308 未覆盖） |
| 耗时 | 约 0.6s（纯单元测试，无外部依赖） |

⚠️ **修正一条流传的数字**：此前有报告称「copilot-router 113 passed / 75% 覆盖率」。
**实测是 179 passed / 81%**，两个数都偏低，报告已过期。

覆盖率明细（未达标项）：

| 文件 | 覆盖率 | 说明 |
| :--- | --: | :--- |
| `api.py` | **0%** | 101 语句全未覆盖 —— FastAPI 路由层完全没测 |
| `api_models.py` | **0%** | 50 语句全未覆盖 |
| `providers/__init__.py` | 75% | 多 provider 适配 |
| `gateway.py` | 87% | |
| `billing.py` | 88% | |
| `config.py` | 88% | |
| `cache.py` | 95% | |
| `errors.py` | 89% | |
| `routing.py` | 92% | |
| `tokens.py` | 92% | |
| `sensitivity.py` | 98% | |
| `types.py` | 99% | |
| `budget.py` | 94% | |
| `degradation.py` | 100% | |

`api.py` 与 `api_models.py` 的 0% 是主要缺口：核心调度逻辑测得很细，但 HTTP 入口一行没测。

> 另注：`services/copilot-router` **不在 `pnpm-workspace.yaml` 里**（该文件只含 `apps/*`、`apps/micro-sites/*`、`packages/*`），目录下**没有 `pyproject.toml`**（只有 `.coverage`）。`turbo run test` 不会执行它的测试，必须手动 `cd services/copilot-router && python -m pytest tests`。

---

### 6. `services/openalex-pat-worker` — 🔶 部分实现

| 项 | 值 |
| :--- | :--- |
| 源文件 / 代码行 | 32 / 约 4,550 行 |
| 测试 | 2 个文件，**43 个用例全部通过** |
| 构建 | n/a（Python） |

有 `pyproject.toml`、`requirements.txt`、`README.md`、`.env.example`。核心是热度/脉冲计算（`tests/test_heat.py` 覆盖）。

⚠️ **未接入主链路**：`matrix-core` 的路由聚合里没有任何 `pat` 相关 router，`config.ts`（小程序侧）注释里写的「对外经 matrix-core 暴露 `/v1/pat/*`」**尚未实现**。所以这个服务目前是一个孤立的可运行单元。

---

### 7. `apps/orbital-hub` — 🔶 部分实现

| 项 | 值 |
| :--- | :--- |
| 源文件 / 代码行 | 27 / 约 4,720 行 |
| 测试 | ❌ 0 个 |
| 构建 | ⚠️ 能过，但默认并发下不稳定（见 §4） |

组件层相当完整：

| 文件 | 大小 | 作用 |
| :--- | --: | :--- |
| `OrbitalHub.tsx` | 23 KB | 总控台主组件 |
| `StarOrbitField.tsx` | 12 KB | 2.5D 星轨引力场 |
| `InstrumentPanel.tsx` | 11 KB | 仪器面板 |
| `WormholeRing.tsx` | 11 KB | 虫洞环 |
| `InstrumentRack.tsx` | 8 KB | 折射仪器架 |
| `CopilotWaveDock.tsx` | 6.5 KB | 底部声波脉冲底座 |
| `PerformanceProbePanel.tsx` | 3.4 KB | 性能探针 |

`lib/` 里有 `orbit-layout.ts`、`wormhole-contract.ts`、`performance-probe.ts`、`microsites.generated.ts`（15 KB，由 `gen-site.mjs` 生成的花名册）。

⚠️ **缺口**：
- **没有队列接收器** —— 在 `src/` 全量搜 `pocket` / `queue`：**零命中**。口袋端「推入电脑端队列」在桌面侧完全没有对端。
- 无测试。
- `page.tsx` 极薄（452 B），全部逻辑在 client component 里，SSR 首屏只有骨架。

---

### 8. `apps/wechat-pocket` — 🔶 部分实现（逻辑层完成，视图层为零）

| 项 | 值 |
| :--- | :--- |
| 源文件 / 代码行 | 20 / 约 3,600 行 |
| 测试 | ❌ 0 个 |
| 构建 | ❌ **没有 build 任务**（只有 `typecheck`），turbo 22 个 build 任务里不含它 |

| 层 | 状态 | 内容 |
| :--- | :--- | :--- |
| `core/` | ✅ 已实现 | auth / config / errors / logger / request / storage / sync（7 个文件，约 45 KB） |
| `api/` | ✅ 已实现 | index / types / mock（10 条 mock 路由，约 42 KB） |
| `utils/qr.ts` | ✅ 已实现且有自测 | 零依赖 QR 编码器，约 22 KB，version 1–10 |
| `pages/` | ❌ **空目录** | `app.json` 声明的 4 个主包页面全不存在 |
| `pkg-queue/` | ❌ **空目录** | 分包 2 个页面不存在 |
| `components/` | ❌ **空目录** | |
| `assets/tabbar/` | ❌ **空目录** | `app.json` 引用的 8 张图标全缺失 |
| `mock-server/` | ❌ **空目录** | `package.json` 的 `mock:server` / `mock:check` 指向不存在的文件 |
| 应用入口 | ❌ **不存在** | 无 `app.ts` / `app.js` |

**关键判断**：`tsconfig.json` 的 `include` 只覆盖 `miniprogram/**/*.ts` + `types/**/*.d.ts`。
所以 **`typecheck` 通过只证明逻辑层类型自洽，完全不能证明小程序能在开发者工具里跑起来**。
这是本模块最容易误判的地方 —— 上一轮「typecheck 通过」被当成「做得差不多了」。

详细说明见 [`apps/wechat-pocket/README.md`](../../apps/wechat-pocket/README.md)。

---

### 9. `apps/micro-sites`（18 站）— 🔶 仅骨架

| 项 | 值 |
| :--- | :--- |
| 站点数 | 18 |
| 每站源文件 | **17**（18 站完全同构） |
| 全站源文件 | 306 |
| 代码行 | 约 16,140 行（其中大量是重复的 shim 与 CSS） |
| 每站源码体积 | 约 39 KB |
| 测试 | ❌ 0 个 |
| 构建 | ⚠️ 能过，但不稳定 |

**18 个站点全部由 `scripts/gen-site.mjs`（74 KB）生成**，每个文件头都带：

```
⚠️ 自动生成 · scripts/gen-site.mjs
```

每站 17 个文件全是同一套模板：

| 文件 | 性质 |
| :--- | :--- |
| `src/app/page.tsx`（约 900 B） | 🟡 **占位骨架**，注释明写「微站入口页（骨架 / 占位）」 |
| `src/components/site-shell.tsx`（约 4.7 KB） | 🟡 渲染站名/域名/轨道 + 一组**占位柱状图**（确定性数组 `GAUGE_HEIGHTS`），挂 SSO 与虫洞接收器 |
| `src/lib/instrument-facade.tsx` / `sdk-facade.ts` | 🟡 对 instrumentation 与 SDK 的薄封装 |
| `src/lib/shims/*` | 🟡 三条 shim（instrument-ui / matrix-sdk） |
| `matrix-app.manifest.json` | ✅ 合规（`app_id` / `entry_url` / `orbit_station` / `accent_color` / `permissions`） |
| `site.config.ts` | ✅ 从花名册生成 |
| `layout.tsx` / `globals.css` / `next.config.ts` / `tsconfig.json` / `package.json` / `.env.example` | ✅ 构建配置 |

⚠️ 需要澄清的两个常见误读：

1. **18 站 ≠ 18 个可用工具**。每站渲染的是同一套「占位仪器」——柱状图高度写死为 `[38, 62, 47, 81, 55, 70, 44, 92, 66, 51]`，与 GPA、经费、声呐等业务毫无关系。ADR-001 规定的 UI 形态（精密推子配重仪、五柱流体压差计、360° 极坐标声呐盘…）**一个都没实现**。
2. **`apps/micro-sites` 的 3,092 KB 里，约 2.1 MB 是 `.next` 构建产物**。真实源码只有 306 个文件。仓库"约 2MB 代码"的说法把构建产物算进去了。

命名符合 ADR-001：`01-gpa-sandbox` … `18-prejob-multiverse`，目录名用版本 B 的描述性词根，编号与站点归属用版本 A 的花名册，域名与目录名刻意可不同（如 `04-pat-radar` 对 `pat-hot.matrixos.edu`、`14-review-architect` 对 `review-lab.matrixos.edu`）。**这一点是对的。**

---

## 4. 构建稳定性：一个必须记录的事实

**结论：22/22 能全绿，但默认并发下会随机失败；`--concurrency=2` 时连续两次全绿。**

实测 4 次 `npx turbo run build`：

| 次序 | 命令 | 结果 | 失败包 | 错误 |
| --: | :--- | :--- | :--- | :--- |
| 1 | `turbo run build` | **20/22** | `orbital-hub` | `ENOENT: .next/server/app/_not-found/page.js.nft.json` |
| 2 | `turbo run build` | **17/22** | `microsite-09-matrix-cross` | `MODULE_NOT_FOUND`（next CLI） |
| 3 | `turbo run build --force` | **3/22** | `microsite-13`、`microsite-10` | `ENOENT: .next/build-manifest.json`、`ENOENT: .next/static/*/_ssgManifest.js` |
| 4 | `turbo run build --concurrency=2` | **22/22** ✅ | — | — |
| 5 | `turbo run build --concurrency=2` | **22/22** ✅ | — | — |

**特征**：失败包每次不同、错误全是 `.next/` 内部文件 `ENOENT`、降低并发即消失。
**判定**：这是**构建期文件竞争**（19 个 Next.js 应用同时读写各自 `.next/` 目录 + Windows 文件系统），不是代码缺陷。

**实践建议**：CI 与本地验收都用

```bash
npx turbo run build --concurrency=2
```

不要用默认并发，否则会得到假红灯。

> ⚠️ 此前「build 22/22 通过」的结论**在默认并发下不可复现**。这不是说结论造假，而是说它是在某次侥幸成功的运行上得出的，不能当作稳定基线。

---

## 5. 测试基础设施的缺口

除了"哪些模块没测试"，还有三个**工具链层面**的问题：

| # | 问题 | 影响 |
| :-- | :--- | :--- |
| 1 | `pnpm test` = `turbo run test`，但 23 个工作区包里只有 **3 个**声明了 `test` 脚本（twin-schema / matrix-sdk / instrument-ui） | 3 个 Python 服务 + orbital-hub + 18 微站 + wechat-pocket 完全不在 `pnpm test` 覆盖内 |
| 2 | `instrument-ui` 的 `test` 脚本指向 **不存在的** `scripts/self-test.mjs` | 该包跑测试直接失败 |
| 3 | `services/copilot-router` 没有 `pyproject.toml`、不在 workspace | 179 个测试只能手动跑，`pnpm test` 永远看不见 |

也就是说：**`pnpm test` 全绿 ≠ 仓库测试通过**，它只覆盖了 385 个用例中的 163 个（twin-schema 162 + matrix-sdk 1）。
另外 222 个（copilot-router 179 + pat-worker 43）需要手动 `python -m pytest`。

---

## 6. 与"事实依据"的偏差清单

任务简报里给了几条前提，实测有出入的列在这里，避免继续传播：

| 简报说法 | 实测 | 说明 |
| :--- | :--- | :--- |
| 全仓 typecheck 25/25 | ✅ **属实** | 25 = 23 个 typecheck 任务 + 2 个依赖前置 build（instrument-ui、matrix-sdk） |
| 全仓 build 22/22 | ⚠️ **需限定条件** | 默认并发下实测 17–20/22，`--concurrency=2` 才稳定 22/22 |
| Python 96 文件语法正确 | ✅ **属实** | `ast.parse` 全量校验，96 个文件 0 失败 |
| 18 微站已生成，命名遵循 ADR-001 | ✅ 属实（但要补一句） | 生成的是**骨架**，不是可用工具 |
| copilot-router 113 passed / 75% | ❌ **过期** | 实测 **179 passed / 81%** |
| wechat-pocket 48 文件 / 543KB | ❌ **含开发产物** | 真实源文件 **20 个 / 128 KB**；543 KB 里 ~300 KB 是 `.qr-selftest/*.pbm` 位图 |

---

## 7. 优先级建议

按"解锁后续工作的收益 / 成本"排序：

| 优先级 | 事项 | 理由 |
| :--- | :--- | :--- |
| **P0** | `matrix-core` 补 `tests/` | 承载鉴权与资产的核心服务零测试，且测试依赖已在 `pyproject.toml` 声明好，只差用例 |
| **P0** | `wechat-pocket` 补 `app.ts` + 6 个页面 + 8 张 tabBar 图标 | 不补则小程序**完全无法启动**，逻辑层写再好也看不见 |
| **P1** | `matrix-core` 补 `/v1/pocket/*` 10 条 REST + WSS | 小程序当前 13 个端点**全是 mock**，跨端同步完全不通 |
| **P1** | CI/文档固定写 `--concurrency=2` | 消除假红灯，让"build 通过"成为可信信号 |
| **P2** | 修 `scripts/self-test.mjs` 缺失 / 或改 instrument-ui 的 test 脚本 | 让 `pnpm test` 不再撒谎 |
| **P2** | `copilot-router` 补 `api.py` / `api_models.py` 测试 | 两个文件 0% 覆盖，是 81% 的主要拖累 |
| **P2** | 给 `instrument-ui` 的 `lib/stats.ts` / `math.ts` 补测试 | 纯函数，成本极低 |
| **P3** | 18 微站接入真实业务逻辑 | 当前是占位骨架，需先定各站的数据模型 |
| **P3** | `orbital-hub` 补队列接收器 | 跨端协同的桌面半边 |

---

## 口径说明

| 项 | 定义 |
| :--- | :--- |
| **源文件** | 排除 `node_modules`、`.next`、`dist`、`.turbo`、`.venv`、`__pycache__`、`.pytest_cache`、`*.tsbuildinfo`、`*.pyc`、`.coverage` |
| **代码文件** | 源文件中扩展名为 `.ts/.tsx/.py/.js/.mjs/.cjs/.css/.json` 者 |
| **测试文件** | 匹配 `*.test.*`、`*.spec.*`、`test_*.py`、`*_test.py`、`conftest.py` |
| **通过测试** | 实际执行 `pytest` / `vitest run` / `node --test` 的 passed 计数，不采信报告 |
| **可构建** | 该包声明了 `build` 脚本且实际执行成功 |

**复现命令**

```bash
# typecheck（25/25）
npx turbo run typecheck

# build（必须降并发，否则假红灯）
npx turbo run build --concurrency=2

# JS 测试
cd packages/twin-schema && npx vitest run
cd packages/matrix-sdk  && node --test "test/**/*.test.ts"

# Python 测试
cd services/copilot-router     && python -m pytest tests -q --cov=copilot_router
cd services/openalex-pat-worker && python -m pytest tests -q
```

---

## 相关

- [已知问题](./00-known-issues.md)
- [开发环境搭建](./01-dev-setup.md)
- [小程序 README](../../apps/wechat-pocket/README.md)
- [架构设计](../01-plan/01-architecture.md)
- [ADR-001 · 微站编号与命名](../01-plan/00-adr-001-microsite-numbering.md)
