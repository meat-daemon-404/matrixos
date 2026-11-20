# 口袋微信小程序（wechat-pocket）

> 双端不对称协同中的**移动轻交互端**。桌面 WebOS 负责长周期深任务，口袋端负责高频碎片化：
> 08:00 晨间三卡早报、微目标打卡、进组/面试强提醒、学术名片、推入桌面队列。
>
> **铁律**：严禁把桌面重型功能（跨论文对比矩阵、30+ 回归台、综述推演）搬到移动端。

| 项 | 值 |
| :--- | :--- |
| 包名 | `@matrixos/wechat-pocket` |
| 源码 | 68 个文件（miniprogram 56 个）/ 58 个文本文件约 10,200 行 |
| 技术栈 | 原生小程序 + TypeScript（无运行时依赖，包体对冷启动敏感） |
| 冷启动预算 | `COLD_START_BUDGET_MS = 800` |
| 当前状态 | ✅ **视图层已落地**：6 个页面 + 2 个组件 + 8 张 tabBar 图标齐全，mock-server 自测全绿；matrix-core `/v1/pocket/*` REST + WSS 已实现 |

---

## 0. 先读这一段：当前能不能跑

**能跑。** 视图层已落地，逻辑层、视图层、mock 后端、服务端 pocket 路由都齐了。

| 目录 | 状态 | 说明 |
| :--- | :--- | :--- |
| `miniprogram/pages/` | ✅ 4 个主包页面 | morning / checkin / mentor / card，每页四件套（ts+wxml+wxss+json） |
| `miniprogram/pkg-queue/` | ✅ 2 个分包页面 | queue / detail，分包预载规则已在 `app.json` 声明 |
| `miniprogram/components/` | ✅ 2 个组件 | `panel-state`（loading/empty/error 三态）、`data-origin-badge`（降级角标） |
| `miniprogram/assets/tabbar/` | ✅ 8 张图标 | 4 个 tab × 常态/选中，由 `scripts/gen-tabbar-icons.cjs` 生成 |
| `mock-server/` | ✅ 已实现 | `server.cjs`（HTTP + WSS）+ `selftest.cjs`（63 断言全绿） |
| `miniprogram/app.ts` / `app.wxss` | ✅ 已实现 | 入口含环境解析、身份预热、全局错误兜底、跨端同步绑定 |

微信开发者工具导入 `apps/wechat-pocket` 后可直接运行，编译模式在 `project.config.json` 里已预置 5 个。

### 视图层验收脚本

```bash
node apps/wechat-pocket/scripts/verify-view-layer.cjs
```

它断言：6 个页面四件套齐备、8 张 tabBar PNG 尺寸与落墨像素、12 处 `usingComponents` 注册。

### 已知的降级语义（ADR-09：降级不可静默）

所有页面都通过 `data-origin-badge` 组件显式标注数据来源：`live`（实时）/ `mock`（演示数据）/ `cache`（缓存，附「N 分钟前」）/ `local`（仅本机）。缓存降级时**保留已渲染内容**、只改角标，不清屏。

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

**结论：14 条 pocket REST + 1 条 WSS 全部有服务端实现，mock 只是断网/后端未起时的回落路径；但 auth 侧还有一条真实缺口（见下）。**

服务端在 `services/matrix-core/app/api/routes/pocket.py`（`APIRouter(prefix="/pocket")`，挂在 `api_prefix="/v1"` 下），配套 `app/models/pocket.py`、`app/schemas/pocket.py`、`app/services/pocket.py`、迁移 `alembic/versions/0002_pocket.py`，测试 3 个文件（`test_pocket_api.py` / `test_pocket_service.py` / `test_pocket_ws.py`）。

逐条核对（依据 `api/index.ts` 与 `core/auth.ts` 的实际调用，对照 `pocket.py` / `auth.py` 的路由装饰器）：

| 方法 | 路径 | 客户端调用点 | 服务端 | mock 数据来源 |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/v1/pocket/morning` | `api/index.ts:75` | ✅ 已实现 | `api/mock/data.ts` |
| POST | `/v1/pocket/morning/dismiss` | `api/index.ts:83` | ✅ 已实现 | 本地 storage 补丁 |
| GET | `/v1/pocket/checkin` | `api/index.ts:124` | ✅ 已实现 | `api/mock/data.ts` |
| POST | `/v1/pocket/checkin` | `api/index.ts:133` | ✅ 已实现 | 本地 storage 补丁 |
| DELETE | `/v1/pocket/checkin` | `api/index.ts:136` | ✅ 已实现 | ⚠️ mock 层**未实现**该路由 |
| GET | `/v1/pocket/mentor` | `api/index.ts:151` | ✅ 已实现 | `api/mock/data.ts` |
| POST | `/v1/pocket/mentor/ack` | `api/index.ts:159` | ✅ 已实现 | 本地 storage 补丁 |
| POST | `/v1/pocket/mentor/stage` | **客户端未调用**（服务端专供桌面/lab-kanban） | ✅ 已实现 | ❌ 无 mock |
| GET | `/v1/pocket/card` | `api/index.ts:173` | ✅ 已实现 | `api/mock/data.ts` |
| GET | `/v1/pocket/queue` | `api/index.ts:200` | ✅ 已实现 | mock + 本地队列 |
| POST | `/v1/pocket/queue/push` | `api/index.ts:96` | ✅ 已实现 | **只写手机本地 storage** |
| POST | `/v1/pocket/queue/claim` | **客户端未调用**（`orbital-hub` 的 `QueueReceiver.tsx` 调用） | ✅ 已实现 | ❌ 无 mock |
| POST | `/v1/pocket/queue/done` | **客户端未调用**（同上） | ✅ 已实现 | ❌ 无 mock |
| DELETE | `/v1/pocket/queue?id=` | `api/index.ts:208` | ✅ 已实现 | 本地 storage 补丁 |
| WSS | `/v1/pocket/stream` | `core/sync.ts:147` | ✅ 已实现 | 连不上 → 走轮询兜底 |

### mock 回落是怎么触发的

`core/request.ts` 的顺序是：**真实请求 → 404/网络/5xx 且允许 → mock 层 → 本地缓存 → 抛错**。

- `FALLBACK_TO_MOCK = true`（`core/config.ts`）
- 每个 mock 响应都带 `mock: true`，`api/index.ts` 把它映射为 `origin: 'mock'`
- **页面必须消费 `origin` 并显式标注「演示数据」**（ADR-09 禁止静默降级）—— 6 个页面全部通过 `data-origin-badge` 组件消费了这个字段。
- `POST /v1/pocket/queue/push` 的注释写着「写操作要求拿到确定的落库结果：不允许静默 mock 成功而不提示」，但实际调用传的是 `{ noMock: false }` —— **与注释相反，mock 成功会被静默接受**。目前靠返回体的 `desktopNotified: false` 显式提示兜底，语义本身仍待定（见 §9）。

### 三层数据源的定位

混着说会得出错误结论，先分清层：

| 层 | 载体 | pocket 端点 | auth 端点 |
| :--- | :--- | :--- | :--- |
| **生产** | `services/matrix-core`（FastAPI + PostgreSQL） | 14 REST + 1 WSS ✅ | `/v1/auth/refresh` ✅；`/v1/auth/wechat/exchange` ❌ **不存在** |
| **开发 HTTP 服务** | `apps/wechat-pocket/mock-server/server.cjs` | 14 REST + 1 WSS ✅ | 两条都 ✅（`code` 可用 `uid:<x>` / `mock-token-<x>` 指名用户） |
| **端内回落层** | `miniprogram/api/mock/index.ts`（`FALLBACK_TO_MOCK`） | 10 条 ✅ | 两条都 ❌ |

### 🔴 auth 侧的真实缺口（这条不是 mock 问题，是服务端没有）

客户端 `core/auth.ts:233` 打的是 `${apiBase}/v1/auth/wechat/exchange`，但 `services/matrix-core` 全仓搜 `wechat` / `jscode2session` **零命中**——服务端只有 `/v1/auth/exchange`，语义是「用 `mx_idt` 换 `mx_at`」的 iframe 场景，不是「用微信 `code` 换 token」。

也就是说：**`wx.login` 拿到的 code 在生产环境无处可换**，微信登录的服务端半边还没写。这与 mock 无关——mock-server 里已有 `auth.wechat.exchange` 路由（`code` 用 `uid:<x>` 指名用户），所以**本地开发不受影响**；受影响的是真机联调与线上登录。

后果：

- `request.ts` 里取 token 失败**不会阻断渲染**（catch 后打 warn，请求不带鉴权头继续发）
- 但任何显式调用 `ensureFreshToken()` 且不捕获的页面逻辑会拿到 `ApiError`
- `sync.ts` 的 `sendAuth()` 就是这种情况：拿不到 token → auth 帧永远发不出去 → 服务端会拒绝该连接

要决定：**微信登录的服务端半边（`code → mx_at`）做不做、什么时候做**。端内 mock 层要不要补 auth 兜底只影响「不打 mock-server」的形态，优先级低。

### 本地 mock 后端

`mock-server/` 已实现，`package.json` 的 `mock:server` / `mock:check` 可直接用：

- `server.cjs`：HTTP 服务监听 `127.0.0.1:8787`（与 `core/config.ts` 的 `local` 环境一致），`ROUTES` 17 条（14 条 pocket + 2 条 auth + 1 条 health），WSS `/v1/pocket/stream` 由 `WS_PATH` 单独处理，支持 `auth` / `subscribe` / `ping` 帧
- `selftest.cjs`：逐条断言响应形状，并校验 WSS 握手、`pong`、按 uid 的消息隔离、非法 token 关闭码 4401

实测结果：**pass=63 fail=0**。

```bash
node apps/wechat-pocket/mock-server/selftest.cjs
```

---

## 3. 冷启动优化：哪些真做了

分级如实标注，不夸大。

| 优化项 | 声明位置 | 实现状态 | 结论 |
| :--- | :--- | :--- | :--- |
| **分包加载** | `app.json` → `subPackages` + `preloadRule` | ✅ **已实现** | `pkg-queue/` 有 2 个页面，`preloadRule` 在 morning 页按 network=all 预载队列分包 |
| **代码按需注入** | `app.json` → `lazyCodeLoading: "requiredComponents"` | ✅ 已生效 | `panel-state` / `data-origin-badge` 走 `usingComponents` 按需注入，6 页共 12 处注册 |
| **图片懒加载** | — | ❌ **未实现** | 小程序 `<image lazy-load>` 需在 wxml 上显式开启；当前页面无图片资源 |
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

**调用点已接上**：6 个页面各自在 `onReady` 里调一次 `reportFirstPaint(route)`，route 取页面路径（`pages/morning/index`、`pages/checkin/index`、`pages/mentor/index`、`pages/card/index`、`pkg-queue/queue/index`、`pkg-queue/detail/index`）。

注意：**「< 800ms」还没有被真机验证过**——度量点已就位，但数字要在真机预览下测（见下方验收步骤）。

口径注意（注释里已诚实说明）：`t0` 是模块加载时刻，**不等于**用户点开小程序的那一刻，中间还隔着微信容器启动与代码包下载。所以这个数是「同口径相对耗时」，适合做**回归对比**，不能对外宣称成端到端冷启动。

### 冷启动验收步骤

1. ~~每个页面 `onReady` 调 `reportFirstPaint('pages/xxx/index')`~~ ✅ 已完成（6/6 页面已接上）
2. 开发者工具 → 调试器 → Performance 面板，勾选「重新编译后自动运行」，记录首次渲染耗时
3. 真机预览（**必须**，开发者工具的数字不代表真机），iOS/Android 各测 3 次取中位数
4. 控制台搜 `[pocket][boot]` 看各阶段 `mark()` 的分段耗时，定位是哪一段吃掉预算
5. 反复 10 次冷启动（每次彻底杀掉小程序后台），确认无一次超 800ms

---

## 4. 跨端同步：「推入电脑端队列」通了吗

**服务端与桌面端都已实现**，全链路打通（`ac4d94d` 打通双端协同全链路）。

### 客户端（已实现，`core/sync.ts`，373 行）

设计得相当扎实，三层传输：

1. **WSS 长连接**（首选）`/v1/pocket/stream`
   - 连上立刻发 `auth`（`mx_at` + `deviceId`），再发 `subscribe`（`queue` / `mentor` / `briefing`）
   - 每 20s 发 `ping`，服务端回 `pong`；**连续 2 个周期无 pong 判定假死**，主动 close 触发重连
   - 断线指数退避重连：`800 → 1600 → 3200 → 6400 → 12000 → 20000`（封顶）
2. **轮询兜底**（降级）：WSS 连续失败 3 次即启动 30s 轮询，发 `resync` 事件让页面自己拉数据；长连接恢复后自动退出轮询
3. **写路径不依赖长连接**：推入走 REST `POST /v1/pocket/queue/push`，长连接只负责下行增量通知

另外还有：页面级引用计数（`acquire()` / `release()`，全部页面离开才断开）、切后台 > 30s 断开省电、回前台 `reconnectNow()`、未知消息类型前向兼容。

### 服务端（已实现）

`services/matrix-core/app/api/routes/pocket.py` 提供 14 条 REST 路由 + `@router.websocket("/stream")`；`app/services/pocket.py` 是业务层，配套模型、schema、迁移与 3 个测试文件。

推入时的实际链路（服务端在线时）：

```
点击「⚡ 推入电脑端」
  → POST /v1/pocket/queue/push
  → matrix-core 落库 + 回执（receiptId）
  → WSS 广播 queue.count
  → 桌面端 QueueReceiver 收到并显示
```

服务端不可用时回落 mock，写入手机本地 storage，返回 `desktopNotified: false` —— **降级状态是显式回报的**，不静默假装成功。

### 桌面端（已实现）

`apps/orbital-hub/src/components/QueueReceiver.tsx`（+ `queue-receiver.css`）是总控台上的队列接收器，由 `apps/orbital-hub/src/app/page.tsx` 引入。它调 `POST /v1/pocket/queue/claim` 认领、`POST /v1/pocket/queue/done` 完成。

### 判定

| 环节 | 状态 |
| :--- | :--- |
| 客户端长连接 + 心跳 + 重连 + 轮询兜底 | ✅ 已实现（质量好，有注释说明设计权衡） |
| 客户端推入写路径 | ✅ 已实现（但 noMock 语义与注释矛盾） |
| `matrix-core` 的 `/v1/pocket/*` REST 路由 | ✅ 已实现（14 条） |
| `matrix-core` 的 `/v1/pocket/stream` WSS | ✅ 已实现（`@router.websocket("/stream")`） |
| `orbital-hub` 队列接收器 | ✅ 已实现（`QueueReceiver.tsx`） |
| **端到端可用性** | ✅ **通**（前提：matrix-core 在线；离线时降级为 mock + 显式 `desktopNotified: false`） |

仍欠的两笔：把 `pushToDesktop` 的 `noMock` 语义定下来（当前传 `false`，与注释「不允许静默 mock」矛盾），以及微站唤醒逻辑（队列接收器已有，唤醒微站尚未接）。

---

## 5. 六个页面的渲染状态

`app.json` 声明的 6 个页面路径**全部存在**，每页四件套（`index.ts` / `index.wxml` / `index.wxss` / `index.json`）齐备。

| # | 页面 | 路径 | 包 | 状态 |
| :-- | :--- | :--- | :--- | :--- |
| 1 | 晨间三卡早报 | `pages/morning/index` | 主包 | ✅ 已实现（热力条、证据、忽略、推入桌面） |
| 2 | 学业打卡 | `pages/checkin/index` | 主包 | ✅ 已实现（乐观更新 + 回滚、桌面专属项标注） |
| 3 | 进组提醒 | `pages/mentor/index` | 主包 | ✅ 已实现（倒计时 ticker、5 段状态机、答辩提纲） |
| 4 | 学术名片 | `pages/card/index` | 主包 | ✅ 已实现（Canvas 2D 二维码 + 证据 ref 复制） |
| 5 | 桌面队列 | `pkg-queue/queue/index` | 分包 | ✅ 已实现（相对时间、收据、离线「重连」入口） |
| 6 | 队列详情 | `pkg-queue/detail/index` | 分包 | ✅ 已实现（证据锚点区、复制 ref、时间格式化） |

页面消费的 API：

| 页面 | 调用的 API | 冷启动首屏可用 |
| :--- | :--- | :--- |
| morning | `morningApi.peekCache()` → 渲染 → `morningApi.load()` 刷新；`dismiss()`；`pushToDesktop()` | ✅ `peekCache()` 同步读缓存 |
| checkin | `checkinApi.peekCache()` / `load()` / `toggle()` | ✅ |
| mentor | `mentorApi.peekCache()` / `load()` / `acknowledge()`；`sync.on()` 订阅 `mentor.read` / `mentor.stage` | ✅ |
| card | `cardApi.peekCache()` / `load()`；`cardApi.qrPayloadOf()` → `utils/qr.ts` 生成二维码 | ✅ |
| queue | `queueApi.peekCache()` / `load()` / `remove()`；`sync.on()` 订阅 `queue.count` / `claimed` / `done` | ✅ |
| detail | `queueApi.load()`（从快照按 id 取条目） | ✅ |

**降级处理**：网络/超时失败且已有渲染内容时，页面保留内容、只把 `origin` 改为 `cache` 并让角标显示「N 分钟前」——不静默清屏（ADR-09）。

---

## 6. 二维码编码器（自测覆盖最严的模块）

`miniprogram/utils/qr.ts`（约 22 KB）是一个零依赖的 QR 编码器，支持 version 1–10、四档纠错（L/M/Q/H）、自动选 mask。

自测：

```bash
node apps/wechat-pocket/scripts/qr-selftest.cjs
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
│   ├── app.json                  # 页面/分包/tabBar 声明（引用的目标全部存在）
│   ├── app.ts                    # ✅ 应用入口：环境解析、身份预热、错误兜底、同步绑定
│   ├── app.wxss                  # ✅ 全局样式（mx- 前缀 token 类）
│   ├── sitemap.json
│   ├── core/                     # ✅ 逻辑层，全部已实现
│   │   ├── auth.ts               # MatrixID 令牌：wx.login → exchange，并发刷新合并
│   │   ├── config.ts             # 环境/端点/超时/退避/冷启动预算
│   │   ├── errors.ts             # ApiError 归一
│   │   ├── logger.ts             # 分级日志 + 冷启动打点（reportFirstPaint）
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
│   ├── pages/                    # ✅ 4 个主包页面
│   │   ├── morning/  checkin/  mentor/  card/
│   ├── components/               # ✅ 2 个组件
│   │   ├── panel-state/          # loading/empty/error 三态
│   │   └── data-origin-badge/    # 数据来源角标（live/mock/cache/local）
│   ├── pkg-queue/                # ✅ 2 个分包页面
│   │   ├── queue/  detail/
│   └── assets/tabbar/            # ✅ 8 张图标（4 tab × 常态/选中）
├── types/wx.d.ts                 # 小程序 API 类型声明（手写）
├── scripts/
│   ├── qr-selftest.cjs           # QR 自测
│   ├── gen-tabbar-icons.cjs      # tabBar 图标生成（零依赖手写 PNG）
│   └── verify-view-layer.cjs     # 视图层完整性断言
├── mock-server/                  # ✅ 本地 mock 后端
│   ├── server.cjs                # HTTP + WSS
│   ├── selftest.cjs              # 63 断言
│   └── README.md
├── project.config.json           # 开发者工具项目配置（appid 占位）
├── project.private.config.example.json
├── tsconfig.json
└── package.json
```

`tsconfig.json` 的 `include` 只覆盖 `miniprogram/**/*.ts` 和 `types/**/*.d.ts`，`exclude` 掉了 `mock-server`。所以 `typecheck` 通过**只证明类型自洽，不证明小程序能渲染** —— 渲染的完整性由 `scripts/verify-view-layer.cjs` 单独断言。

---

## 8. 命令

```bash
pnpm --filter @matrixos/wechat-pocket typecheck    # tsc -p tsconfig.json
node apps/wechat-pocket/scripts/qr-selftest.cjs    # QR 编码器自测
node apps/wechat-pocket/scripts/verify-view-layer.cjs  # 视图层完整性断言
node apps/wechat-pocket/mock-server/selftest.cjs   # mock 后端自测（63 断言）
```

本地起 mock 后端：

```bash
pnpm --filter @matrixos/wechat-pocket mock:server  # → mock-server/server.cjs
pnpm --filter @matrixos/wechat-pocket mock:check   # → mock-server/selftest.cjs
```

---

## 9. 待办

**已关闭的欠账**：

1. ~~补 `app.ts` + 8 张 tabBar 图标~~ ✅（`ac4d94d`）
2. ~~补 6 个页面~~ ✅（`ac4d94d`）
3. ~~页面消费 `origin` 字段，显式渲染「演示数据」角标~~ ✅（`ac4d94d`）
4. ~~每页 `onReady` 调 `reportFirstPaint()`~~ ✅（本次 PR）
5. ~~实现 `mock-server/`（HTTP + WSS）~~ ✅（`ac4d94d`）
6. ~~matrix-core 补 `/v1/pocket/*` REST + `/v1/pocket/stream` WSS~~ ✅（`ac4d94d`）
7. ~~orbital-hub 补队列接收器~~ ✅（`ac4d94d`）

**仍然欠着**：

8. 决定 auth 的 mock 策略（加 mock 兜底 或 mock 模式跳过鉴权）—— `/v1/auth/wechat/exchange` / `refresh` 无 mock 兜底
9. 修 `pushToDesktop` 的 `noMock` 语义（当前注释说"不允许静默 mock"，代码传 `false` 允许了）
10. mock 层补 `DELETE /v1/pocket/checkin` 路由
11. 真机测冷启动数字（度量点已就位，`< 800ms` 尚未被真机验证）
12. 微站唤醒（队列接收器已有，唤醒微站未接）
13. 骨架屏组件（`SKELETON_MIN_MS` 常量仍无人引用）
14. `data-origin-badge` 的映射逻辑目前嵌在组件里，缺单测

---

## 相关

- [仓库实现状态](../../docs/02-engineering/04-implementation-status.md)
- [开发环境搭建](../../docs/02-engineering/01-dev-setup.md)
- [架构设计 §3.3 接口约定](../../docs/01-plan/01-architecture.md)
- [已知问题](../../docs/02-engineering/00-known-issues.md)
