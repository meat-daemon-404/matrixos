# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# matrix-core 生产镜像
#
#   构建（**在仓库根目录执行**，因为需要把 specs/microsites.json 拷进镜像）：
#     docker build -f services/matrix-core/Dockerfile -t matrix-core:0.1.0 .
#
#   或直接用 compose（context 已设为仓库根）：
#     docker compose -f services/matrix-core/docker-compose.prod.yml build
#
#   本地试跑：
#     docker run --rm -p 8000:8000 --env-file .env.production matrix-core:0.1.0
#
# 设计取舍
#   1. **两阶段**：builder 装依赖到独立 venv，runtime 只拷 venv + 代码。
#      编译期工具链（gcc / libpq-dev / pip 缓存）不进最终层，镜像小且攻击面小。
#   2. **非 root**：uid/gid 固定 10001，避免用随机 UID 导致挂载卷权限漂移。
#   3. **不写死环境变量**：所有配置由运行时注入（见文末「环境变量清单」）。
#      镜像里**不含**任何密钥或 .env 文件。
#   4. **健康检查打 /v1/health**（存活探针，不查库）。就绪探针是 /v1/health/ready。
# ─────────────────────────────────────────────────────────────────────────────

ARG PYTHON_VERSION=3.12

# ═════════════════════════════════════════════════════════════════════════════
# Stage 1 · builder —— 只负责把依赖装进 /opt/venv
# ═════════════════════════════════════════════════════════════════════════════
FROM python:${PYTHON_VERSION}-slim-bookworm AS builder

# 关掉 .pyc 写入与 pip 缓存；PIP_NO_CACHE_DIR 让本层不会因为重装而膨胀
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# asyncpg / cryptography 在部分架构上没有预编译 wheel，需要编译器；
# libpq-dev 供 psycopg 系备用（当前用 asyncpg，纯 Python 协议实现，实际不需要，
# 但保留 libpq5 运行时库的成本极低，便于以后切驱动）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      libpq-dev \
      libffi-dev \
 && rm -rf /var/lib/apt/lists/*

# 独立 venv：拷到 runtime 阶段后路径仍然有效（/opt/venv）
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /build

# 只拷依赖清单先装依赖 —— 代码改动不会让这一层缓存失效
COPY services/matrix-core/pyproject.toml ./pyproject.toml
# pyproject 里 readme = "README.md"，hatchling 构建时需要它存在
RUN touch README.md

# 装运行时依赖（不装 [test] extra：生产镜像不带 pytest）
# `pip install .` 会先构建 wheel 再装，顺带验证包元数据可用
COPY services/matrix-core/app ./app
RUN pip install --upgrade pip \
 && pip install .

# ═════════════════════════════════════════════════════════════════════════════
# Stage 2 · runtime —— 精简镜像，非 root 运行
# ═════════════════════════════════════════════════════════════════════════════
FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

# 容器内默认值；生产请显式覆盖（尤其 DATABASE_URL / KEYS_DIR）。
#
# MATRIX_CORE_AUTO_GENERATE_KEYS 必须显式关掉：Settings 的出厂默认是 true（为方便本地
# 开发），而 MATRIX_CORE_APP_ENV=production 会触发严格校验——不覆盖的话 preflight 会以
# auto_generate_keys 直接拒绝启动（Dockerfile 与 preflight 自相矛盾）。
# 生产密钥一律由卷 / Secret 注入（见文末「密钥注入」）。
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PATH="/opt/venv/bin:${PATH}" \
    MATRIX_CORE_APP_ENV=production \
    MATRIX_CORE_LOG_JSON=true \
    MATRIX_CORE_AUTO_GENERATE_KEYS=false \
    PORT=8000

# 运行时只需要 libpq5 + curl（healthcheck 用）。curl 装完不删——
# HEALTHCHECK 每 30s 调一次，删了会一直失败。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libpq5 \
      curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 matrix \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin matrix

# 依赖 venv（含已安装的 matrix-core 包与其依赖）
COPY --from=builder /opt/venv /opt/venv

WORKDIR /app

# 应用代码与 Alembic 迁移
COPY --chown=root:root services/matrix-core/app ./app
COPY --chown=root:root services/matrix-core/alembic ./alembic
COPY --chown=root:root services/matrix-core/alembic.ini ./alembic.ini
COPY --chown=root:root services/matrix-core/dev_init.py ./dev_init.py

# 站点花名册：app/core/sites.py 会依次尝试 /app/specs、<repo>/specs。
# 不拷的话会退到内置的 _FALLBACK_DOMAINS（内容一致，但权威源是这份 JSON）。
COPY --chown=root:root specs/microsites.json ./specs/microsites.json

# 密钥目录：**只建空目录**，实际密钥由卷挂进来。
# 若镜像里带私钥，任何能拉镜像的人都拿到了签发能力。
RUN mkdir -p /var/lib/matrix-core/keys/current \
 && chown -R 10001:10001 /var/lib/matrix-core \
 && chmod 700 /var/lib/matrix-core/keys

USER 10001:10001

# 应用以非 root 运行，无法写 /app；把可写状态收敛到 /tmp 与密钥目录
ENV MATRIX_CORE_KEYS_DIR=/var/lib/matrix-core/keys \
    TMPDIR=/tmp

EXPOSE 8000

# 健康检查打 /v1/health（存活探针，不查库）。
# 用 /v1/health 而不是 /v1/health/ready：ready 会在库挂掉时也返回 200，
# 但语义上是「依赖是否就绪」，不适合作为容器重启依据（会掩盖真正的僵死）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/v1/health" || exit 1

# 单 worker 起步：matrix-core 的限流器是进程内的（见 core/ratelimit.py 的说明），
# 多 worker 会让实际限额翻倍。要扩就加副本 + 前置负载均衡，而不是加 --workers。
#
# --proxy-headers + --forwarded-allow-ips：让 uvicorn 信任反向代理传来的
# X-Forwarded-Proto/For，否则 request.url 会是 http，影响 redirect 与日志。
CMD ["sh", "-c", "exec uvicorn app.main:app \
      --host 0.0.0.0 \
      --port ${PORT} \
      --proxy-headers \
      --forwarded-allow-ips='*' \
      --no-access-log \
      --log-level info"]

# ─────────────────────────────────────────────────────────────────────────────
# 环境变量清单（全部由运行时注入，镜像里不含任何值）
#
# ── 必填（缺失或非法 → 启动前校验直接拒绝启动）────────────────────────────
#   MATRIX_CORE_DATABASE_URL        postgresql+asyncpg://user:pass@host:5432/db
#                                   ↑ 必须异步驱动；SQLite 会被拒绝
#   MATRIX_CORE_KEYS_DIR            密钥目录（默认 /var/lib/matrix-core/keys）
#                                   需含 current/private.pem + current/public.pem
#   MATRIX_CORE_AUTO_GENERATE_KEYS  生产必须 false
#   MATRIX_CORE_APP_ENV             production | staging（触发全量校验）
#   MATRIX_CORE_COOKIE_SECURE       true
#   MATRIX_CORE_JWT_ISSUER          https://...（写进每枚 token，改了=全员登出）
#   MATRIX_CORE_JWT_AUDIENCE        matrixos
#
# ── 建议显式设置 ─────────────────────────────────────────────────────────
#   MATRIX_CORE_CORS_ALLOWED_ORIGINS   JSON 数组，精确来源，不能带结尾斜杠
#   MATRIX_CORE_CORS_ALLOW_PAGES_DEV   true 时放行 https://mx-*.pages.dev
#   MATRIX_CORE_COOKIE_DOMAIN          .matrixos.edu（带前导点）
#   MATRIX_CORE_COOKIE_SAMESITE        lax | strict | none
#   MATRIX_CORE_LOG_LEVEL              INFO
#   MATRIX_CORE_LOG_JSON               true
#   MATRIX_CORE_DB_POOL_SIZE           10（pool_size × 副本数 < PG max_connections）
#   MATRIX_CORE_DB_MAX_OVERFLOW        20
#   MATRIX_CORE_WRITE_RATE_LIMIT_PER_MINUTE  120（0=关闭）
#   MATRIX_CORE_ACCESS_TOKEN_TTL_SECONDS     900
#   MATRIX_CORE_REFRESH_TOKEN_TTL_SECONDS    2592000
#   MATRIX_CORE_IDT_TTL_SECONDS              120
#   MATRIX_CORE_EMBEDDING_DIM                1024（ADR-04 锁定，改了要迁移）
#
# ── 密钥注入（三选一）────────────────────────────────────────────────────
#   1. Docker secret / 只读卷：
#        -v /host/keys:/var/lib/matrix-core/keys:ro
#   2. K8s Secret（挂成文件后 chmod 600，preflight 会检查权限位）
#   3. PaaS secret 文件（Fly secrets / Railway variables 存 base64，
#      启动脚本解码到 $MATRIX_CORE_KEYS_DIR 再 exec uvicorn）
#
#   生成密钥（受控机器上一次性）：
#     python scripts/matrix-core-gen-keys.py --out ./keys
#
# ── 数据库迁移 ───────────────────────────────────────────────────────────
#   生产用 Alembic，**不要**用 dev_init.py（它用 create_all，且会播种 demo 用户）：
#     docker compose -f services/matrix-core/docker-compose.prod.yml \
#       run --rm matrix-core alembic upgrade head
# ─────────────────────────────────────────────────────────────────────────────
