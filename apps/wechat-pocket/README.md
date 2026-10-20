# 口袋微信小程序（wechat-pocket）

> 双端不对称协同中的**移动轻交互端**。桌面 WebOS 负责长周期深任务，口袋端负责高频碎片化：
> 08:00 晨间三卡早报、微目标打卡、进组/面试强提醒、学术名片、推入桌面队列。
>
> **铁律**：严禁把桌面重型功能（跨论文对比矩阵、30+ 回归台、综述推演）搬到移动端。

| 项 | 值 |
| :--- | :--- |
| 包名 | `@matrixos/wechat-pocket` |
| 源码 | 20 个文件 / 约 128 KB / 约 3,600 行 |
| 技术栈 | 原生小程序 + TypeScript（无运行时依赖，包体对冷启动敏感） |
| 冷启动预算 | `COLD_START_BUDGET_MS = 800` |
| 当前状态 | ⚠️ **逻辑层已就绪，视图层未落地 —— 现在无法在开发者工具里跑起来** |

---

## 0. 先读这一段：当前能不能跑

**不能。** 这不是配置问题，是文件缺失。

已完成的是「逻辑层」：鉴权、请求、缓存、mock 回落、跨端同步通道、二维码编码器，全部有实现且 `typecheck` 通过。
未完成的是「视图层」：**一个页面、一个组件、一张 tabBar 图标都没有**。

| 目录 | 状态 | 后果 |
| :--- | :--- | :--- |
| `miniprogram/pages/` | **空** | `app.json` 声明的 4 个主包页面全部不存在 |
| `miniprogram/pkg-queue/` | **空** | 分包声明的 2 个页面不存在 |
| `miniprogram/components/` | **空** | 无自定义组件 |
| `miniprogram/assets/tabbar/` | **空** | `app.json` 引用的 8 张图标全部缺失 |
| `mock-server/` | **空** | `package.json` 的 `mock:server` / `mock:check` 指向不存在的 `server.cjs` / `selftest.cjs` |
| `miniprogram/app.ts` / `app.js` | **不存在** | 没有应用入口 |

因此微信开发者工具打开后会直接报三类错：找不到 `app.js`、找不到页面路径、找不到 tabBar 图标。

补齐视图层需要的文件清单（目前全部待写）：

```
miniprogram/app.ts                 # 应用入口，调用 bindAppLifecycle()
miniprogram/app.wxss
miniprogram/pages/morning/index.{ts,wxml,wxss,json}
miniprogram/pages/checkin/index.{ts,wxml,wxss,json}
miniprogram/pages/mentor/index.{ts,wxml,wxss,json}
miniprogram/pages/card/index.{ts,wxml,wxss,json}
miniprogram/pkg-queue/queue/index.{ts,wxml,wxss,json}
miniprogram/pkg-queue/detail/index.{ts,wxml,wxss,json}
miniprogram/assets/tabbar/{morning,checkin,mentor,card}[-active].png
mock-server/server.cjs             # 本地 mock HTTP + WSS
mock-server/selftest.cjs
```

> 约定：页面只调 `api/index.ts`，不直接碰 `core/request.ts`；页面不写业务请求逻辑。

---

## 1. 在微信开发者工具里跑

前置：Node ≥ 20、微信开发者工具（稳定版，基础库 ≥ 3.5.8）。

```bash
# 1) 安装依赖（只需 TypeScript，仓库根已有则跳过）
pnpm install

# 2) 类型检查
pnpm --filter @matrixos/wechat-pocket typecheck

# 3) 打开微信开发者工具 → 导入项目
#    目录选：D:\MatrixOS\apps\wechat-pocket
#    它会读同目录下的 project.config.json
```

`project.config.json` 的关键设置（已配好，一般不用改）：

| 字段 | 值 | 说明 |
| :--- | :--- | :--- |
| `miniprogramRoot` | `miniprogram/` | 小程序代码根目录 |
| `compileType` | `miniprogram` | 非插件、非小游戏 |
| `libVersion` | `3.5.8` | 基础库版本 |
| `setting.useCompilerPlugins` | `["typescript"]` | 由开发者工具直接编译 `.ts`，**不需要**额外的 tsc 构建产物 |
| `setting.urlCheck` | `false` | 允许请求 `http://127.0.0.1` 本地后端 |
| `packOptions.ignore` | 含 `mock-server` / `scripts` / `types` / `*.ts` 源 | 不把开发期文件打进包 |

已预置 5 个编译模式（`project.config.json` → `condition.miniprogram.list`），导入后可直接在工具栏下拉框切换：

| 模式名 | 路径 | 用途 |
| :--- | :--- | :--- |
| 晨间三卡早报 | `pages/morning/index` | 主包首屏 |
| 学业打卡 | `pages/checkin/index` | 主包 |
| 星门进组提醒 | `pages/mentor/index` | 主包 |
| 学术名片（扫码落地） | `pages/card/index?mx=MX-2026-8842&trace=...` | 模拟扫名片码，`scene=1011` |
| 桌面队列（分包） | `pkg-queue/queue/index` | 验证分包加载 |

### AppID 怎么配

`project.config.json` 里当前是 **`"appid": "touristappid"`**（游客/测试号占位）。三种情形：

| 场景 | 做法 |
| :--- | :--- |
| 只想本地看 UI | 保持 `touristappid` 即可。游客模式**不能**调 `wx.login`、不能真机预览、不能上传 |
| 要联调登录（`wx.login` → MatrixID exchange） | 换成自己的**测试号** AppID：开发者工具 → 详情 → 基本信息 → AppID → 修改 |
| 要真机预览 / 上传体验版 | 必须换成**已注册小程序**的真实 AppID，并把开发成员加入该小程序 |

> 个人隐私保护指引：`app.json` 的 `requiredPrivateInfos` 目前为 `[]`。若后续用到 `getLocation` 等隐私接口，必须同时在此声明并在小程序后台配置隐私协议，否则接口会静默失败。

**不要把真实 AppID 提交进仓库**：`project.config.json` 是入库文件。若需要保留个人 AppID，用 `project.private.config.json`（已提供 `.example` 模板，且该文件名通常被 `.gitignore` 忽略）。

---

## 2. 哪些接口是 mock

**结论：当前 13 个端点，13 个都是 mock。服务端一个都没实现。**

判定依据：在 `services/matrix-core` 全仓搜索 `pocket` —— **零命中**。`/v1/pocket/*` 路由尚不存在。

`api/index.ts` 文件头已自标注状态，逐条核对如下：

| 方法 | 路径 | 承载方（规划） | 服务端 | 数据来源 |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/v1/pocket/morning` | matrix-core | ❌ 未实现 | `api/mock/data.ts` |
| POST | `/v1/pocket/morning/dismiss` | matrix-core | ❌ 未实现 | 本地 storage 补丁 |
| GET | `/v1/pocket/checkin` | matrix-core | ❌ 未实现 | `api/mock/data.ts` |
| POST | `/v1/pocket/checkin` | matrix-core | ❌ 未实现 | 本地 storage 补丁 |
| DELETE | `/v1/pocket/checkin` | matrix-core | ❌ 未实现 | ⚠️ mock 层**未实现**该路由 |
| GET | `/v1/pocket/mentor` | matrix-core（聚合 pat-worker + lab-kanban） | ❌ 未实现 | `api/mock/data.ts` |
| POST | `/v1/pocket/mentor/ack` | matrix-core | ❌ 未实现 | 本地 storage 补丁 |
| GET | `/v1/pocket/card` | matrix-core（聚合 AssetGraph） | ❌ 未实现 | `api/mock/data.ts` |
| GET | `/v1/pocket/queue` | matrix-core | ❌ 未实现 | mock + 本地队列 |
| POST | `/v1/pocket/queue/push` | matrix-core（落虫洞收据） | ❌ 未实现 | **只写手机本地 storage** |
| DELETE | `/v1/pocket/queue?id=` | matrix-core | ❌ 未实现 | 本地 storage 补丁 |
| POST | `/v1/auth/wechat/exchange` | matrix-core | ❌ 未实现 | ⚠️ **无 mock**，见下 |
| POST | `/v1/auth/refresh` | matrix-core | ❌ 未实现 | ⚠️ **无 mock**，见下 |
| WSS | `/v1/pocket/stream` | matrix-core | ❌ 未实现 | 连不上 → 走轮询兜底 |

### mock 回落是怎么触发的

`core/request.ts` 的顺序是：**真实请求 → 404/网络/5xx 且允许 → mock 层 → 本地缓存 → 抛错**。

- `FALLBACK_TO_MOCK = true`（`core/config.ts`）
- 每个 mock 响应都带 `mock: true`，`api/index.ts` 把它映射为 `origin: 'mock'`
- **页面必须消费 `origin` 并显式标注「演示数据」**（ADR-09 禁止静默降级）。页面没写之前，这个字段无人使用。
- `POST /v1/pocket/queue/push` 的注释写着「写操作要求拿到确定的落库结果：不允许静默 mock 成功而不提示」，但实际调用传的是 `{ noMock: false }` —— **与注释相反，mock 成功会被静默接受**。视图层落地时必须靠 `origin` 提示，或把它改成 `noMock: true`。

### 两个没有 mock 的端点

`/v1/auth/wechat/exchange` 与 `/v1/auth/refresh` 在 `api/mock/index.ts` 的 `ROUTES` 里没有对应条目，因此：

- `request.ts` 里取 token 失败**不会阻断渲染**（catch 后打 warn，请求不带鉴权头继续发）
- 但任何显式调用 `ensureFreshToken()` 且不捕获的页面逻辑会拿到 `ApiError`
- `sync.ts` 的 `sendAuth()` 就是这种情况：拿不到 token → auth 帧永远发不出去 → 服务端（即便实现了）会拒绝该连接

视图层落地时要先决定：**给 auth 加 mock 兜底**，还是**让 mock 模式跳过鉴权**。

### 本地 mock 后端

`package.json` 声明了 `mock:server` / `mock:check`，但 `mock-server/` 是空目录，两个脚本都会失败。
建议实现内容（与 `api/mock/index.ts` 的 10 条路由对齐）：

- `server.cjs`：HTTP 服务监听 `127.0.0.1:8787`（与 `core/config.ts` 的 `local` 环境一致），外加 `ws` 升级处理 `/v1/pocket/stream`，支持 `auth` / `subscribe` / `ping` 帧
- `selftest.cjs`：对 10 条路由逐一断言形状，并校验 WSS 握手与 `pong`

---

## 3. 冷启动优化：哪些真做了

分级如实标注，不夸大。

| 优化项 | 声明位置 | 实现状态 | 结论 |
| :--- | :--- | :--- | :--- |
| **分包加载** | `app.json` → `subPackages` + `preloadRule` | 🔶 **仅声明** | `pkg-queue/` 目录为空。配置语法正确、可被开发者工具识别，但无内容可加载，**无法验证收益** |
| **代码按需注入** | `app.json` → `lazyCodeLoading: "requiredComponents"` | 🔶 仅声明 | 依赖自定义组件才有意义，`components/` 为空 |
| **图片懒加载** | — | ❌ **未实现** | 无页面、无组件、无图片。小程序 `<image lazy-load>` 需在 wxml 上显式开启 |
| **首屏骨架屏** | `core/config.ts` → `SKELETON_MIN_MS = 180` | 🔶 **仅常量** | 常量已定义（含"避免闪烁"的设计意图注释），但**没有任何代码引用它**，骨架屏组件不存在 |
| **接口缓存 / SWR** | `core/request.ts` + `api/index.ts` 的 `peekCache()` | ✅ **已实现** | 真优化。`peekCache()` 同步读 storage 先渲染，再后台刷新；TTL 分级（早报 6h、名片 24h、队列 2min） |
| **请求超时收紧** | `core/config.ts` → `REQUEST_TIMEOUT_MS = 6000` | ✅ 已实现 | 碎片化场景不留长等待 |
| **零运行时依赖** | `package.json` | ✅ 已实现 | 只有 `typescript` 一个 devDependency |
| **日志分级** | `core/logger.ts` | ✅ 已实现 | prod 下 `info`/`debug` 不输出，减少线上开销 |

### `< 800ms` 怎么度量

度量管道是**真的写了**，而且口径是自洽的。

`core/logger.ts`：

```
appStartAt = now()        // 模块加载时刻，作为 t0
mark(name)                // 记录阶段点，返回距 t0 的毫秒数
reportFirstPaint(route)   // 首屏可交互时调用
```

- `now()` 优先用 `wx.getPerformance().now()` 拿高精度时间，取不到退回 `Date.now()`
- `reportFirstPaint(route)` 超过 `COLD_START_BUDGET_MS`（800ms）就 `log.warn`，并尝试 `wx.reportEvent('pocket_cold_start_overrun', { route, ms })` 上报
- 未超预算则打 info 日志：`冷启动首屏 XXXms / 预算 800ms`

**但这条路目前一次都不会被触发**：`reportFirstPaint()` 需要页面在首屏可交互时调用，而页面不存在。所以在补齐视图层之前，「< 800ms」**既没有被验证，也无法被验证**。

口径注意（注释里已诚实说明）：`t0` 是模块加载时刻，**不等于**用户点开小程序的那一刻，中间还隔着微信容器启动与代码包下载。所以这个数是「同口径相对耗时」，适合做**回归对比**，不能对外宣称成端到端冷启动。

### 补齐视图层后的验收步骤

1. 每个页面 `onReady` 调 `reportFirstPaint('pages/xxx/index')`
2. 开发者工具 → 调试器 → Performance 面板，勾选「重新编译后自动运行」，记录首次渲染耗时
3. 真机预览（**必须**，开发者工具的数字不代表真机），iOS/Android 各测 3 次取中位数
4. 控制台搜 `[pocket][boot]` 看各阶段 `mark()` 的分段耗时，定位是哪一段吃掉预算
5. 反复 10 次冷启动（每次彻底杀掉小程序后台），确认无一次超 800ms

---

## 4. 跨端同步：「推入电脑端队列」通了吗

**没有通。** 客户端一侧写得很完整，但对端是空的。

### 客户端（已实现，`core/sync.ts`，373 行）

设计得相当扎实，三层传输：

1. **WSS 长连接**（首选）`/v1/pocket/stream`
   - 连上立刻发 `auth`（`mx_at` + `deviceId`），再发 `subscribe`（`queue` / `mentor` / `briefing`）
   - 每 20s 发 `ping`，服务端回 `pong`；**连续 2 个周期无 pong 判定假死**，主动 close 触发重连
   - 断线指数退避重连：`800 → 1600 → 3200 → 6400 → 12000 → 20000`（封顶）
2. **轮询兜底**（降级）：WSS 连续失败 3 次即启动 30s 轮询，发 `resync` 事件让页面自己拉数据；长连接恢复后自动退出轮询
3. **写路径不依赖长连接**：推入走 REST `POST /v1/pocket/queue/push`，长连接只负责下行增量通知

另外还有：页面级引用计数（`acquire()` / `release()`，全部页面离开才断开）、切后台 > 30s 断开省电、回前台 `reconnectNow()`、未知消息类型前向兼容。

### 服务端（未实现）

`services/matrix-core` 里搜不到任何 `pocket` 字样，`/v1/pocket/stream` 与 `/v1/pocket/queue/push` 都不存在。

推入时的实际链路：

```
点击「⚡ 推入电脑端」
  → POST /v1/pocket/queue/push
  → 404（matrix-core 无此路由）
  → mock 回落命中 postPushToQueue()
  → 写入手机自己的 storage（STORAGE_KEYS.queueLocal）
  → 返回 { desktopNotified: false }
```

**所以「推入电脑端队列」在 mock 模式下只是把条目写进了手机自己的本地存储**，桌面端永远收不到。`desktopNotified: false` 这个字段倒是诚实地反映了这一点。

### 桌面端（未实现）

`apps/orbital-hub/src` 里搜 `pocket` / `queue` —— **零命中**。总控台没有队列接收器，也没有唤醒微站的逻辑。

### 判定

| 环节 | 状态 |
| :--- | :--- |
| 客户端长连接 + 心跳 + 重连 + 轮询兜底 | ✅ 已实现（质量好，有注释说明设计权衡） |
| 客户端推入写路径 | ✅ 已实现（但 noMock 语义与注释矛盾） |
| `matrix-core` 的 `/v1/pocket/*` 10 条 REST 路由 | ❌ 未实现 |
| `matrix-core` 的 `/v1/pocket/stream` WSS | ❌ 未实现 |
| `orbital-hub` 队列接收器 + 微站唤醒 | ❌ 未实现 |
| **端到端可用性** | ❌ **不通** |

打通需要三件事：matrix-core 补 pocket 路由与 WSS、orbital-hub 补队列消费、把 `pushToDesktop` 的 `noMock` 决策定下来。

---

## 5. 五个页面的渲染状态

`app.json` 声明了 6 个页面路径，**实际存在 0 个**。

| # | 页面 | 路径 | 包 | 图标（wxml/ts） | 状态 |
| :-- | :--- | :--- | :--- | :--- | :--- |
| 1 | 晨间三卡早报 | `pages/morning/index` | 主包 | — | ❌ 不存在 |
| 2 | 学业打卡 | `pages/checkin/index` | 主包 | — | ❌ 不存在 |
| 3 | 进组提醒 | `pages/mentor/index` | 主包 | — | ❌ 不存在 |
| 4 | 学术名片 | `pages/card/index` | 主包 | — | ❌ 不存在 |
| 5 | 桌面队列 | `pkg-queue/queue/index` | 分包 | — | ❌ 不存在 |
| 6 | 队列详情 | `pkg-queue/detail/index` | 分包 | — | ❌ 不存在 |

每个页面目录需要四个文件：`index.ts`（Page 逻辑）、`index.wxml`（结构）、`index.wxss`（样式）、`index.json`（页面配置，要注册组件和 `navigationBarTitleText`）。

**页面要用的 API 全部已就绪**，视图层只需消费：

| 页面 | 可直接调用的 API | 冷启动首屏可用 |
| :--- | :--- | :--- |
| morning | `morningApi.peekCache()` → 渲染 → `morningApi.load()` 刷新；`dismiss()`；`pushToDesktop()` | ✅ `peekCache()` 同步读缓存 |
| checkin | `checkinApi.peekCache()` / `load()` / `toggle()` | ✅ |
| mentor | `mentorApi.peekCache()` / `load()` / `acknowledge()`；`sync.on()` 订阅 `mentor.read` | ✅ |
| card | `cardApi.peekCache()` / `load()`；`cardApi.qrPayloadOf()` → `utils/qr.ts` 生成二维码 | ✅ |
| queue | `queueApi.peekCache()` / `load()` / `remove()`；`sync.on()` 订阅 `queue.*` | ✅ |

---

## 6. 二维码编码器（唯一有自测的模块）

`miniprogram/utils/qr.ts`（约 22 KB）是一个零依赖的 QR 编码器，支持 version 1–10、四档纠错（L/M/Q/H）、自动选 mask。

自测：

```bash
node scripts/qr-selftest.cjs
```

它用 TypeScript 编译器把 `qr.ts` 转成 CJS，生成 24 个用例的 **PBM 位图**（`.qr-selftest/`），并写一份 `manifest.json` 记录每个用例的 version / mask / 尺寸。位图的用途是交给 Python + OpenCV 解码回验 —— **不是「画出来就算」，而是要真的能被扫码器读出来**。

最近一次结果：**24 个用例中 22 个成功，2 个按设计报错**。

| 用例 | 纠错 | 结果 |
| :--- | :--- | :--- |
| case-23 | Q | ⚠️ 报错「内容过长（494 字节），超出本编码器支持的版本 10」 |
| case-24 | H | ⚠️ 报错同上 |

这两个用例的内容是「接近版本上限的长串」，报错说明**长度校验生效了**，属于预期行为，不是 bug。若要让它们通过，需要把编码器扩展到 version 11+。

输出文件：`.qr-selftest/` 目录（22 个 `.pbm` + `manifest.json` + `demo-ascii.txt` + 转译产物 `qr.cjs`）。该目录是开发期产物，不需要入库。

---

## 7. 目录结构

```
apps/wechat-pocket/
├── miniprogram/
│   ├── app.json                  # 页面/分包/tabBar 声明（引用的目标多数尚不存在）
│   ├── sitemap.json
│   ├── core/                     # ✅ 逻辑层，全部已实现
│   │   ├── auth.ts               # MatrixID 令牌：wx.login → exchange，并发刷新合并
│   │   ├── config.ts             # 环境/端点/超时/退避/冷启动预算
│   │   ├── errors.ts             # ApiError 归一
│   │   ├── logger.ts             # 分级日志 + 冷启动打点
│   │   ├── request.ts            # 请求层：鉴权头/401 重试/mock 回落/缓存
│   │   ├── storage.ts            # storage 封装（带过期）
│   │   └── sync.ts               # 跨端同步：WSS + 心跳 + 退避 + 轮询兜底
│   ├── api/
│   │   ├── index.ts              # 页面唯一入口（每个域一个 API 对象）
│   │   ├── types.ts              # 与后端契约对应的 TS 类型
│   │   └── mock/                 # 🔶 mock 实现
│   │       ├── data.ts           # 基线数据
│   │       └── index.ts          # 10 条路由 + 本地补丁
│   ├── utils/qr.ts               # ✅ 零依赖 QR 编码器
│   ├── pages/                    # ❌ 空
│   ├── components/               # ❌ 空
│   ├── pkg-queue/                # ❌ 空
│   └── assets/tabbar/            # ❌ 空
├── types/wx.d.ts                 # 小程序 API 类型声明（手写）
├── scripts/qr-selftest.cjs       # QR 自测
├── mock-server/                  # ❌ 空（package.json 引用了它）
├── project.config.json           # 开发者工具项目配置（appid 占位）
├── project.private.config.example.json
├── tsconfig.json
└── package.json
```

`tsconfig.json` 的 `include` 只覆盖 `miniprogram/**/*.ts` 和 `types/**/*.d.ts`，`exclude` 掉了 `mock-server`。所以 `typecheck` 通过**只证明逻辑层类型自洽，不证明小程序能渲染** —— 这是本模块最容易误判的地方。

---

## 8. 命令

```bash
pnpm --filter @matrixos/wechat-pocket typecheck    # tsc -p tsconfig.json
node apps/wechat-pocket/scripts/qr-selftest.cjs    # QR 编码器自测
```

以下两个脚本**当前会失败**（目标文件不存在）：

```bash
pnpm --filter @matrixos/wechat-pocket mock:server  # → mock-server/server.cjs 缺失
pnpm --filter @matrixos/wechat-pocket mock:check   # → mock-server/selftest.cjs 缺失
```

---

## 9. 待办（按解锁顺序）

1. **补 `app.ts` + 8 张 tabBar 图标** —— 不补则开发者工具无法启动
2. **补 6 个页面**（morning / checkin / mentor / card / queue / detail）—— 这是"能不能看"的分水岭
3. 页面消费 `origin` 字段，显式渲染「演示数据」角标
4. 每页 `onReady` 调 `reportFirstPaint()`，打通冷启动度量
5. 实现 `mock-server/`（HTTP + WSS），让 `mock:server` / `mock:check` 可用
6. 决定 auth 的 mock 策略（加 mock 兜底 或 mock 模式跳过鉴权）
7. 修 `pushToDesktop` 的 `noMock` 语义（当前注释说"不允许静默 mock"，代码传 `false` 允许了）
8. matrix-core 补 `/v1/pocket/*` 10 条 REST + `/v1/pocket/stream` WSS
9. orbital-hub 补队列接收器与微站唤醒

1–2 是硬阻塞，3–5 是质量项，8–9 才能让跨端同步真的通。

---

## 相关

- [仓库实现状态](../../docs/02-engineering/04-implementation-status.md)
- [开发环境搭建](../../docs/02-engineering/01-dev-setup.md)
- [架构设计 §3.3 接口约定](../../docs/01-plan/01-architecture.md)
- [已知问题](../../docs/02-engineering/00-known-issues.md)
