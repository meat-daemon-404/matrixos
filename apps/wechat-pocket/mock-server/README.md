# mock-server — 口袋端本地 mock 后端

> ⚠️ **这是 mock，不是生产实现。**
> 生产的 `/v1/pocket/*` 在 `services/matrix-core`（FastAPI + PostgreSQL，
> 见 `services/matrix-core/app/api/routes/pocket.py`，由 `tests/test_pocket_*.py` 守着）。
> 本目录的存在只有一个理由：**本机没有微信开发者工具**，而小程序的 13 个端点
> 需要一份「能真起服务、真发请求、真断言」的可执行证据，否则口袋端的全部
> 验收都只能停留在纸面。

## 运行

```bash
node mock-server/server.cjs        # 默认 127.0.0.1:8787
PORT=8791 node mock-server/server.cjs
MOCK_VERBOSE=1 node mock-server/server.cjs   # 逐行打印路由
node mock-server/selftest.cjs      # 63 条断言，全过 exit 0 / 有 FAIL exit 1
# 或经 pnpm：
pnpm mock:server
pnpm mock:check
```

零依赖：只用 `node:http` / `node:net` / `node:crypto`。数据存内存 Map，
进程重启即清空。

## 鉴权约定

不验签（mock），但 token 必须形如 `mock-token-<uid>`，服务端从中解析 uid
做**数据隔离**——`mock-token-alice` 与 `mock-token-bob` 看到的是两份队列。
这条约定不是偷懒：跨用户隔离恰恰是 `/v1/pocket/*` 最容易写错的安全面，
mock 把它做成可执行断言（selftest 的 H 组），而不是留给「反正生产有」。

## 端点表（与 matrix-core 的路径/形状逐字一致）

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/v1/pocket/morning` | 当日三卡早报（无本人数据时回落演示语料，`x-matrix-data-origin: mock`） |
| POST | `/v1/pocket/morning/dismiss` | 忽略卡片 `{cardId}`（幂等，忽略态跨 GET 存活） |
| GET | `/v1/pocket/checkin?day=` | 打卡视图（首次访问播种默认微目标） |
| POST | `/v1/pocket/checkin` | 打卡 `{goalId,date,done}` |
| DELETE | `/v1/pocket/checkin?goalId=&date=` | 取消打卡（与 POST 对称可逆） |
| GET | `/v1/pocket/mentor` | 进组看板 |
| POST | `/v1/pocket/mentor/ack` | 确认提醒 `{reminderId}` |
| POST | `/v1/pocket/mentor/stage?reminderId=&stage=` | 状态机前进一步（跳步 409） |
| GET | `/v1/pocket/card` | 学术名片（验真等级 = 最弱一环） |
| GET | `/v1/pocket/queue` | 队列快照 `{items,pendingCount,desktopOnline,syncedAt}` |
| POST | `/v1/pocket/queue/push` | 推入待办；首推 201 / 幂等重放 200 同 `receiptId`；不存在或已推过的 `cardId` 拒绝 |
| POST | `/v1/pocket/queue/claim` | 桌面认领 `{itemId}`（重复 claim 幂等） |
| POST | `/v1/pocket/queue/done` | 完成 `{itemId}`；`pending→done` 直跳被拒 409 |
| DELETE | `/v1/pocket/queue?id=` | 移除条目 |
| POST | `/v1/auth/wechat/exchange` | 登录糖：`code` 可为 `uid:<x>` / `mock-token-<x>` 以指名用户 |
| POST | `/v1/auth/refresh` | refresh 轮转，重放触发族失效 401 |
| WS | `/v1/pocket/stream` | `hello → auth → resync`；`ping→pong`；push/claim/done 后按 uid 广播 `queue.*`；非法 token 以 4401 关闭 |
| GET | `/v1/health` | 存活 + 在线用户/连接数 |

错误体恒为 `{code, message, trace_id}`，错误码与
`services/matrix-core/app/core/errors.py` 同一词表。

## 与生产的刻意差异（别在 mock 上验证这些）

| 差异 | mock 的做法 | 生产 |
| :--- | :--- | :--- |
| 收据号格式 | `rcpt_<sha256 前 16 位>` | UUID（`wormhole_receipt.receipt_id`）；无 emit 权限时为空串 |
| token | 前缀解析 uid，不验签 | RS256 验签 + jti 黑名单 + auth_epoch |
| 数据 | 内存，重启即空 | PostgreSQL（micro_goal / checkin_record / mentor_reminder / queue_item / morning_dismissal） |
| WS 广播 | 单进程内 Map | 单进程内 Hub（多副本需 Redis pub/sub，见 matrix-core 的注释） |

## 让小程序指向本 mock

改 `miniprogram/core/config.ts` 的 `apiBase`，或用其支持的环境变量指向
`http://127.0.0.1:8787`。开发者工具的「不校验合法域名」需打开
（本机 http 域名不在微信白名单内）。**这只对开发者工具生效，生产构建的
baseUrl 必须指回 matrix-core。**
