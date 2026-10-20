# matrix-core 部署方案

> 状态：**方案已定，镜像与编排已就绪，尚未实际部署到公网**
> 最后更新：2026-10-20
> 相关：[06-cloudflare-deploy.md](06-cloudflare-deploy.md)（前端 19 站部署）、[00-known-issues.md](00-known-issues.md)

## 1. 现状

| 项 | 状态 |
| --- | --- |
| FastAPI 服务 | ✅ 可运行，196 个测试全绿 |
| `Dockerfile` | ✅ 两阶段构建，非 root，健康检查打 `/v1/health` |
| `docker-compose.prod.yml` | ✅ postgres + matrix-core 编排，资源限制与健康依赖齐备 |
| CORS 放行 `https://mx-*.pages.dev` | ✅ 已实现（`config.py` 走 `allow_origin_regex`，非精确白名单） |
| 生产 preflight 校验 | ✅ 必填项缺失/非法即拒绝启动 |
| 公网部署 | ❌ **尚未执行**，无生产 URL |

18 个微站与 hub 全部是**纯静态**（Cloudflare Pages），不依赖后端也能完整浏览。
后端只在需要 MatrixID 登录、资产图谱持久化、队列推送时才被调用。

## 2. 三方案对比

### 方案 A：Cloudflare Workers + Pyodide

把 Python 用 Pyodide 编译进 Worker，同域无跨域问题。

| 维度 | 评价 |
| --- | --- |
| 冷启动 | ❌ Pyodide 启动 1-2s，FastAPI 依赖（pydantic、asyncpg）多数无法编译 |
| 数据库 | ❌ 无原生 TCP，asyncpg 用不了；**pgvector 完全不可用** |
| WebSocket | ⚠️ Durable Objects 能做，但和 FastAPI 的 `@app.websocket` 是两套模型 |
| 成本 | ✅ 极低，免费额度够 |

**结论：不可行。** ADR-04 锁定了 pgvector 1024 维向量检索（语义检索是核心能力），Worker 环境跑不了 pgvector，这条直接否决。

### 方案 B：VPS + Docker Compose ✅ **推荐**

一台 2C4G 的 VPS，跑本仓库的 `docker-compose.prod.yml`，前面用 Caddy 自动签发 TLS。

| 维度 | 评价 |
| --- | --- |
| 能力完整度 | ✅ 原生 postgres + pgvector，WebSocket 原生支持，无裁剪 |
| 迁移成本 | ✅ 已有 Dockerfile 与 compose，`git pull && compose up` 即可 |
| 成本 | 2C4G 约 $5-12/月（Hetzner CX22 $4.5、Vultr $12、DigitalOcean $12） |
| 运维负担 | ⚠️ 需自己管系统更新、备份、监控、证书（Caddy 能自动管证书） |
| 扩展性 | ⚠️ 单机；要扩需自建负载均衡 + 多副本（限流器是进程内状态，见下） |

**为什么推荐**：本项目要的就是 pgvector + WebSocket + 完整 Python 生态，VPS 是唯一不裁剪能力的选项；且 Dockerfile 与 compose 已经写好，落地成本最低。

### 方案 C：Fly.io / Railway（PaaS）

| 维度 | 评价 |
| --- | --- |
| 部署体验 | ✅ `fly deploy` 一条命令 |
| pgvector | ✅ Fly Postgres 支持扩展 |
| WebSocket | ✅ 支持 |
| 成本 | ⚠️ 按量计费，难以预估；常驻 2 台小机型约 $10-20/月 |
| 锁定风险 | ⚠️ 平台专有配置（fly.toml / railway.json），换平台要重写 |
| 免费额度 | 两家都在收紧，不宜作为长期方案依赖 |

**结论：可作为方案 B 的替代**，适合不想碰 Linux 运维的情况。但要接受按量计费的不可预测性与平台配置锁定。

## 3. 推荐路径：方案 B

### 3.1 前置：密钥

私钥**绝不能进镜像、绝不能进 git**。在受控机器上生成一次：

```bash
python scripts/matrix-core-gen-keys.py --out ./services/matrix-core/keys
```

产物是 `keys/current/private.pem` + `public.pem`。`keys/` 已在 `.gitignore` 里。

密钥丢失 = 全员 token 失效（需重新签发，用户要重登）；密钥泄露 = 任何人都能签发合法 token。**离线备份到密码管理器**。

### 3.2 配置

在受控机器上创建 `services/matrix-core/.env.production`（**不进 git**，compose 通过 `env_file` 读它）。
**模板文件目前仓库里没有** —— 变量清单直接看本表，或看 `Dockerfile` 尾部的完整注释块。

必填项（缺一个就拒绝启动，这是 `preflight.py` 的设计）：

| 变量 | 说明 |
| --- | --- |
| `MATRIX_CORE_DATABASE_URL` | 必须以 `postgresql+asyncpg://` 开头；写 `postgresql://` 会被拒（同步驱动会让 async 端点静默退化为阻塞） |
| `MATRIX_CORE_KEYS_DIR` | 密钥目录 |
| `MATRIX_CORE_AUTO_GENERATE_KEYS` | 生产**必须** `false` |
| `MATRIX_CORE_APP_ENV` | `production`（触发全量校验） |
| `MATRIX_CORE_COOKIE_SECURE` | `true` |
| `MATRIX_CORE_JWT_ISSUER` | 真实域名；沿用出厂占位值会被拒 |
| `MATRIX_CORE_JWT_AUDIENCE` | `matrixos` |

**变量名必须带 `MATRIX_CORE_` 前缀**（`config.py` 的 `env_prefix`）。写成裸 `DATABASE_URL` 会被 pydantic 静默忽略、退回默认值 —— 这类降级最难查。

### 3.3 起服务

```bash
# 首次：迁移数据库（生产用 Alembic，不用 dev_init.py —— 后者用 create_all 且会播 demo 用户）
docker compose -f services/matrix-core/docker-compose.prod.yml build
docker compose -f services/matrix-core/docker-compose.prod.yml run --rm matrix-core alembic upgrade head

# 起服务
docker compose -f services/matrix-core/docker-compose.prod.yml up -d

# 验活
curl -fsS http://127.0.0.1:8000/v1/health
```

### 3.4 反向代理

compose 里 matrix-core 只绑 `127.0.0.1:8000`（不绑 0.0.0.0），TLS 由外层终结。Caddy 的最小配置：

```caddyfile
api.matrixos.example {
    reverse_proxy 127.0.0.1:8000
}
```

Caddy 自动申请并续期 Let's Encrypt 证书，无需额外配置。

### 3.5 上线后要改的前端配置

后端有真实域名后，前端才谈得上接。**注意环境变量名是 `NEXT_PUBLIC_MATRIX_API_BASE`**（不是 `NEXT_PUBLIC_API_BASE`），默认值为 `https://api.matrixos.edu`，定义在 `apps/orbital-hub/src/lib/queue-client.ts` / `QueueReceiver.tsx` 的 `defaultApiBase()`：

1. 构建时注入 `NEXT_PUBLIC_MATRIX_API_BASE=https://api.<真实域名>`
2. 若改用自有域名，同步改 `scripts/lib/pages-headers.mjs` 的 CSP `FRAME_ANCESTORS` 白名单，以及 `packages/matrix-sdk/src/security/origin.ts` 的来源校验表
3. `/v1/health/detail` 是给 hub 星轨三态（正常/降级/维护）用的端点

## 4. 已知约束

### 4.1 单 worker

Dockerfile 里特意**不写** `--workers N`：`core/ratelimit.py` 的限流器是**进程内状态**，多 worker 会让实际限额翻倍（N 个进程各算各的）。要扩容必须加副本数 + 前置负载均衡 + 把限流器换成共享存储（Redis），而不是加 `--workers`。

### 4.2 CORS 与 `pages.dev`

`https://mx-*.pages.dev` 只能走 `allow_origin_regex`：Starlette 的 `allow_origins` 是**精确串匹配**，不认通配。

安全提醒：`pages.dev` 是 Cloudflare 的共享租户域，任何 Cloudflare 用户都能在自己项目下用 `mx-xxx.pages.dev`。因此放行 `mx-*.pages.dev` 本质上是**对任意 Cloudflare 用户放行**。当前可接受（数据非敏感、鉴权在 token 层），但**一旦有敏感数据，必须换自有域名**（这也是买域名的实际理由之一）。

### 4.3 域名

`*.matrixos.edu` 是愿景名：`.edu` 需美国教育部认可的教育机构资质，个人无法注册。实际可买 `matrixos.app` / `mxos.dev`（RDAP 均未注册）。注意 Cloudflare Pages **不支持通配符自定义域名**，19 个站要逐个绑 —— 详见 [06-cloudflare-deploy.md](06-cloudflare-deploy.md)。

## 5. 备份与监控

| 项 | 做法 |
| --- | --- |
| 数据库备份 | `docker compose exec postgres pg_dump -U matrixos matrixos | gzip > backup-$(date +%F).sql.gz`，cron 每日，保留 14 天 |
| 恢复演练 | 至少做过一次：`gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U matrixos matrixos` |
| 健康监控 | 外部探针打 `/v1/health`（存活）；`/v1/health/ready` 查依赖连通性 |
| 日志 | json-file driver，单文件 10M 上限、保留 3 个（compose 已配） |
| 密钥轮换 | 换 `keys/current/` 后重启；旧 token 会全部失效（无 JWKS 多钥并存机制） |

## 6. 尚未做的事

- [ ] 真实 VPS 部署（当前只有本地验证）
- [ ] 域名购买与 DNS 落地
- [ ] 数据库迁移在真实 postgres 上跑过（本地用的是 SQLite + `dev_init.py`）
- [ ] 压测（并发上限、pgvector 检索延迟均无实测数据）
- [ ] 监控告警接入
