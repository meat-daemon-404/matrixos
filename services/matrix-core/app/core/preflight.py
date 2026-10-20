"""启动前配置校验（fail fast，不带病启动）。

为什么单独一个模块而不是塞进 ``Settings``：
``Settings`` 的字段校验器只管「单个字段是否合法」；而真正会让生产出事故的是
**字段之间的组合约束**——例如「生产环境 + SQLite」「生产环境 + 自动生成密钥」
「生产环境 + 明文 Cookie」。这类判断需要看整个配置对象，且它们的失败代价极高
（要么数据丢失，要么多副本签发的 token 互不认账），因此集中在这里、一次全查、
一次性把所有问题报出来，而不是启动到一半才发现第二个。

设计原则：
1. **错误分级**：``ERROR`` 阻断启动，``WARNING`` 只记日志。区分标准是
   「是否会导致数据损坏 / 鉴权失效 / 安全事故」——会，就是 ERROR。
2. **一次报全**：收集完所有问题再抛，避免运维改一个、重启一次、再发现下一个。
3. **不误伤开发**：开发与测试环境只跑极少数硬性检查（见 ``_check_always``），
   本地 ``python -m uvicorn app.main:app`` 的体验不做任何改变。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from app.core.config import DEFAULT_JWT_ISSUER, Settings

# 生产环境禁止使用的 SQLite 方言前缀。SQLite 无法承载 pgvector 的 HNSW 索引，
# 也没有真正的并发写——「生产跑 SQLite」几乎总是漏配 DSN 的结果。
_SQLITE_PREFIXES = ("sqlite", "sqlite+aiosqlite")

# asyncpg 是唯一实测过的生产驱动（连接池参数、pool_pre_ping 都按它调过）。
_POSTGRES_ASYNC_PREFIX = "postgresql+asyncpg://"

# 生产密钥目录里必须存在的文件（KeyStore.load 会读这两个）。
_REQUIRED_KEY_FILES = ("private.pem", "public.pem")


@dataclass
class Issue:
    """一条配置问题。``ERROR`` 阻断启动，``WARNING`` 仅提示。"""

    level: str  # "ERROR" | "WARNING"
    setting: str
    detail: str

    def render(self) -> str:
        return f"[{self.level}] {self.setting}: {self.detail}"


@dataclass
class PreflightReport:
    """校验结果集合。"""

    env: str
    issues: list[Issue] = field(default_factory=list)

    @property
    def errors(self) -> list[Issue]:
        return [item for item in self.issues if item.level == "ERROR"]

    @property
    def warnings(self) -> list[Issue]:
        return [item for item in self.issues if item.level == "WARNING"]

    @property
    def ok(self) -> bool:
        return not self.errors

    def summary(self) -> str:
        lines = [f"环境 {self.env}：{len(self.errors)} 个错误，{len(self.warnings)} 个告警"]
        lines.extend(item.render() for item in self.issues)
        return "\n".join(lines)


class ConfigError(RuntimeError):
    """启动前校验未通过。消息里带全部问题，便于一次性修完。"""

    def __init__(self, report: PreflightReport) -> None:
        self.report = report
        body = "\n".join(f"  {item.render()}" for item in report.errors)
        super().__init__(
            "启动前配置校验失败（拒绝带病启动）。请修正以下配置后重试：\n"
            f"{body}\n"
            "提示：完整环境变量清单见 services/matrix-core/.env.production.example，"
            "部署步骤与平台选型见 docs/02-engineering/09-backend-deploy.md"
        )


def check_settings(settings: Settings, *, keys_dir: Path | None = None) -> PreflightReport:
    """对配置做全量校验，返回报告（不抛异常，便于测试与 /health/detail 复用）。"""
    report = PreflightReport(env=settings.app_env)

    _check_always(settings, report)
    if settings.is_strict:
        _check_strict(settings, report)

    # 密钥文件检查依赖运行时的 keys_dir（可能被 env 覆盖），因此单独传
    target = keys_dir or settings.keys_dir
    _check_keys(settings, report, target)
    return report


def assert_startable(settings: Settings, *, keys_dir: Path | None = None) -> PreflightReport:
    """校验并在有 ``ERROR`` 时抛 ``ConfigError``。返回报告供调用方记日志。"""
    report = check_settings(settings, keys_dir=keys_dir)
    if not report.ok:
        raise ConfigError(report)
    return report


# ---------------------------------------------------------------- 各层检查


def _check_always(settings: Settings, report: PreflightReport) -> None:
    """任何环境都成立的硬约束（包括开发机）。"""

    # JWT 校验依赖 iss/aud 断言；空值会让 ``jwt.decode`` 直接抛异常或在关闭校验时
    # 悄悄放行，两种都不该出现在任何环境。
    if not settings.jwt_issuer.strip():
        report.issues.append(
            Issue("ERROR", "jwt_issuer", "不能为空：签发的 token 缺少 iss 声明，微站验签会失败")
        )
    if not settings.jwt_audience.strip():
        report.issues.append(Issue("ERROR", "jwt_audience", "不能为空：token 缺少 aud 声明"))

    if settings.jwt_algorithm not in {"RS256", "RS384", "RS512"}:
        report.issues.append(
            Issue(
                "ERROR",
                "jwt_algorithm",
                f"必须是 RS256/RS384/RS512 之一（当前 {settings.jwt_algorithm!r}）。"
                "对称算法（HS*）无法把公钥安全地分发给 18 个微站",
            )
        )

    # 令牌有效期：access 必须显著短于 refresh，否则「短命 access + 长命 refresh」
    # 的设计前提（ADR-03）不成立，被窃取的 access token 危害被放大。
    if settings.access_token_ttl_seconds <= 0:
        report.issues.append(
            Issue("ERROR", "access_token_ttl_seconds", "必须大于 0")
        )
    if settings.refresh_token_ttl_seconds <= settings.access_token_ttl_seconds:
        report.issues.append(
            Issue(
                "ERROR",
                "refresh_token_ttl_seconds",
                f"必须大于 access_token_ttl_seconds"
                f"（当前 refresh={settings.refresh_token_ttl_seconds}, "
                f"access={settings.access_token_ttl_seconds}）",
            )
        )

    if settings.embedding_dim <= 0:
        report.issues.append(Issue("ERROR", "embedding_dim", "必须大于 0"))
    if settings.embedding_dim != 1024:
        # ADR-04 把向量维度锁死在 1024，改维度必须配迁移重建列与 HNSW 索引。
        report.issues.append(
            Issue(
                "WARNING",
                "embedding_dim",
                f"ADR-04 锁定为 1024，当前为 {settings.embedding_dim}；"
                "变更维度需要同步 Alembic 迁移与 HNSW 索引重建",
            )
        )

    # 来源正则必须能编译，否则会在第一次跨域请求时才炸。
    pattern = settings.cors_origin_regex
    if pattern:
        try:
            re.compile(pattern)
        except re.error as exc:
            report.issues.append(
                Issue("ERROR", "cors_allowed_origin_regex", f"正则无法编译：{exc}")
            )


def _allows_pages_dev_origins(settings: Settings) -> bool:
    """配置是否放行了 ``https://mx-*.pages.dev`` 来源。

    「放行 pages.dev」在配置层有**三个**互相独立的表达方式，三者都算放行——漏掉任何
    一个，跨站 Cookie 告警都会静默失效（这正是本函数存在的唯一理由）：

    1. ``cors_allow_pages_dev=True``：布尔开关，**线上正在用的就是这条**
       （18 个微站全量部署在 ``mx-*.pages.dev``）。它不直接出现在
       ``cors_origin_regex`` 的比较里，而是由 ``Settings.cors_origin_regex``
       这个 property 派生出 ``MATRIXOS_PAGES_ORIGIN_REGEX``。
    2. ``cors_allowed_origin_regex``：手写正则。**注意点通常被转义成 ``\\.``**，
       所以绝不能用 ``"pages.dev" in regex`` 直接判断——正则里的字面量是
       ``pages\\.dev``，那种子串判断恒为 False（本检查原先就踩了这个坑）。
    3. ``cors_allowed_origins``：精确白名单，可以逐条列出 pages.dev 来源。

    这里刻意做成「宁可多报」：跨站 Cookie 只是 WARNING，多报一条运维看一眼即可；
    而漏报的表现是「前端已登录却一直 401」，且 Bearer 链路完全正常，单测与 e2e 都
    发现不了，只有在真实浏览器里才炸。
    """
    if settings.cors_allow_pages_dev:
        return True

    regex = settings.cors_origin_regex
    if regex:
        # 正则里的点写成 ``\.``（MATRIXOS_PAGES_ORIGIN_REGEX 就是
        # ``^https://mx-[a-z0-9-]+\.pages\.dev$``）。先归一化去掉转义反斜杠，
        # 再做子串判断；否则 ``"pages.dev" in "…pages\\.dev…"`` 永远为 False。
        if "pages.dev" in regex.replace("\\.", "."):
            return True

    return any("pages.dev" in origin for origin in settings.cors_allowed_origins)


def _check_strict(settings: Settings, report: PreflightReport) -> None:
    """staging / production 额外要求。"""

    if settings.debug:
        report.issues.append(
            Issue("ERROR", "debug", "严格环境必须关闭 debug（会泄漏内部堆栈与 SQL）")
        )

    # ---- 数据库 ----
    dsn = settings.database_url
    if dsn.startswith(_SQLITE_PREFIXES):
        report.issues.append(
            Issue(
                "ERROR",
                "database_url",
                "严格环境不允许 SQLite：无法使用 pgvector 的 HNSW 索引，"
                "且没有真正的并发写。请指向 PostgreSQL 16 + pgvector",
            )
        )
    elif not dsn.startswith(_POSTGRES_ASYNC_PREFIX):
        report.issues.append(
            Issue(
                "ERROR",
                "database_url",
                f"生产必须使用异步驱动 {_POSTGRES_ASYNC_PREFIX}（当前 {dsn.split('://')[0]}://…）。"
                "同步驱动会在事件循环里阻塞整个进程",
            )
        )
    if dsn.startswith(_POSTGRES_ASYNC_PREFIX) and "@" not in dsn:
        report.issues.append(
            Issue("ERROR", "database_url", "缺少用户名/口令：形如 postgresql+asyncpg://user:pass@host:5432/db")
        )

    if settings.db_pool_size <= 0:
        report.issues.append(Issue("ERROR", "db_pool_size", "必须大于 0"))
    if settings.db_echo:
        report.issues.append(
            Issue("WARNING", "db_echo", "严格环境建议关闭：会把全部 SQL 打进日志（含参数）")
        )

    # ---- 密钥 ----
    if settings.auto_generate_keys:
        report.issues.append(
            Issue(
                "ERROR",
                "auto_generate_keys",
                "严格环境必须设为 false。多副本各自生成会得到不同的 kid，"
                "导致 A 副本签发的 token 在 B 副本验签失败；"
                "且容器重建即丢失私钥，所有用户被强制登出",
            )
        )

    # ---- JWT ----
    if settings.jwt_issuer == DEFAULT_JWT_ISSUER:
        report.issues.append(
            Issue(
                "WARNING",
                "jwt_issuer",
                f"仍是出厂占位值 {DEFAULT_JWT_ISSUER}；"
                "请改成实际对外域名（微站本地验签会断言 iss）",
            )
        )
    if not settings.jwt_issuer.startswith("https://"):
        report.issues.append(
            Issue(
                "ERROR",
                "jwt_issuer",
                f"必须使用 https（当前 {settings.jwt_issuer!r}）：iss 会写进每枚 token，"
                "明文 http 既不可信也会被微站的 CSP 拦下",
            )
        )

    # ---- Cookie ----
    if not settings.cookie_secure:
        report.issues.append(
            Issue(
                "ERROR",
                "cookie_secure",
                "严格环境必须为 true：否则 mx_at/mx_rt 会经明文 HTTP 发送",
            )
        )
    if settings.cookie_samesite not in {"lax", "strict", "none"}:
        report.issues.append(
            Issue("ERROR", "cookie_samesite", f"非法值 {settings.cookie_samesite!r}（lax/strict/none）")
        )
    if settings.cookie_samesite == "none" and not settings.cookie_secure:
        report.issues.append(
            Issue("ERROR", "cookie_samesite", "SameSite=None 必须同时 cookie_secure=true")
        )

    # ---- 跨站 Cookie：微站在 pages.dev、API 在自有域名，属于**跨站**请求 ----
    # 浏览器对跨站 fetch/XHR 只携带 SameSite=None 的 Cookie。lax/strict 下 mx_at 不会
    # 被带上，deps.get_current_token 的 Cookie 兜底于是静默失效：表现是「前端明明已登录
    # 却一直是 401」，且没有任何报错。Authorization: Bearer 链路正常，所以单测与 e2e
    # （都走 Bearer）发现不了这个问题，只有真实浏览器里才炸——因此在这里显式提醒。
    # 刻意不判 ERROR：纯 Bearer 架构（iframe SDK 把 token 放请求头）在 lax 下完全可用。
    if settings.cookie_samesite in {"lax", "strict"} and _allows_pages_dev_origins(settings):
        report.issues.append(
            Issue(
                "WARNING",
                "cookie_samesite",
                f"当前 {settings.cookie_samesite!r} 且放行了 pages.dev 来源：跨站 fetch 不会携带 "
                f"{settings.access_cookie_name}/{settings.refresh_cookie_name} Cookie，依赖 Cookie "
                "的页面会一直 401。前端若用 Authorization: Bearer 则不受影响；"
                "要走 Cookie 必须 cookie_samesite=none（cookie_secure 已是硬要求）",
            )
        )

    if settings.cookie_domain and not settings.cookie_domain.startswith("."):
        report.issues.append(
            Issue(
                "WARNING",
                "cookie_domain",
                f"建议写成带前导点的父域（.{settings.cookie_domain}），"
                "否则 Cookie 不会下发到各子域微站",
            )
        )

    # ---- CORS ----
    if settings.cors_allow_pages_dev:
        report.issues.append(
            Issue(
                "WARNING",
                "cors_allow_pages_dev",
                "已放行 https://mx-*.pages.dev。该域由 Cloudflare 共享，"
                "任何用户都能注册同形状项目——微站绑定自有域名后请关闭此项",
            )
        )
    if not settings.cors_enabled:
        report.issues.append(
            Issue(
                "WARNING",
                "cors_allowed_origins",
                "未配置任何来源：浏览器直连的跨域请求会被全部拒绝。"
                "若走同域反向代理可忽略",
            )
        )
    if "http://localhost" in " ".join(settings.cors_allowed_origins):
        report.issues.append(
            Issue(
                "WARNING",
                "cors_allowed_origins",
                "白名单里含 localhost，生产环境建议移除",
            )
        )

    # ---- 可观测性 ----
    if not settings.log_json:
        report.issues.append(
            Issue("WARNING", "log_json", "严格环境建议开启：纯文本日志无法被采集器结构化解析")
        )
    if settings.log_level.upper() == "DEBUG" and not settings.debug:
        report.issues.append(
            Issue("WARNING", "log_level", "DEBUG 级别在生产会产生大量日志与开销")
        )

    # ---- 限流 ----
    if settings.write_rate_limit_per_minute == 0:
        report.issues.append(
            Issue(
                "WARNING",
                "write_rate_limit_per_minute",
                "写限流已关闭（0）：脚本刷库没有任何阻拦。"
                "另外该限流是进程内的，多副本时按副本各自计数",
            )
        )


def _check_keys(settings: Settings, report: PreflightReport, keys_dir: Path) -> None:
    """密钥目录检查：生产必须**预先注入**，不能靠启动时生成。"""

    current = keys_dir / "current"
    missing = [name for name in _REQUIRED_KEY_FILES if not (current / name).exists()]

    if missing:
        if settings.auto_generate_keys and not settings.is_strict:
            # 开发环境允许自动生成，这里只提示（lifespan 会真的生成）
            report.issues.append(
                Issue(
                    "WARNING",
                    "keys_dir",
                    f"{current} 缺少 {', '.join(missing)}；"
                    "auto_generate_keys=true，启动时将自动生成（仅限开发）",
                )
            )
        else:
            report.issues.append(
                Issue(
                    "ERROR",
                    "keys_dir",
                    f"{current} 缺少 {', '.join(missing)}。"
                    "生产必须通过密钥卷/Secret 预注入 current/private.pem 与 current/public.pem"
                    "（可用 scripts/matrix-core-gen-keys.py 在受控环境生成后分发）",
                )
            )
        return

    # 私钥权限：容器里通常以非 root 运行，权限放宽会让同 Pod 的其他容器读到。
    # 只在 POSIX 上判断——Windows 的 st_mode 不反映 ACL，按位判断会恒告警。
    private_key = current / "private.pem"
    if os.name == "posix":
        try:
            mode = private_key.stat().st_mode & 0o777
        except OSError:  # pragma: no cover - 文件刚被删
            report.issues.append(
                Issue("ERROR", "keys_dir", f"无法读取 {private_key} 的权限位")
            )
            return

        if mode & 0o077:
            report.issues.append(
                Issue(
                    "ERROR" if settings.is_strict else "WARNING",
                    "keys_dir",
                    f"{private_key} 权限过宽（{oct(mode)}）：组/其他用户可读。请 chmod 600",
                )
            )

    # 私钥内容与公钥必须配对：不配对时签发的 token 永远验不过，
    # 而这个错误在启动时看不出来、要到第一个登录请求才暴露。
    try:
        from cryptography.hazmat.primitives import serialization

        private_pem = private_key.read_bytes()
        public_pem = (current / "public.pem").read_bytes()
        derived = (
            serialization.load_pem_private_key(private_pem, password=None)
            .public_key()
            .public_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        )
        if derived.strip() != public_pem.strip():
            report.issues.append(
                Issue(
                    "ERROR",
                    "keys_dir",
                    f"{current} 的私钥与公钥不配对：签发的 token 将无法被任何微站验签",
                )
            )
    except Exception as exc:  # noqa: BLE001 - 任何解析失败都说明密钥不可用
        report.issues.append(
            Issue("ERROR", "keys_dir", f"密钥无法解析（{type(exc).__name__}）：{exc}")
        )


__all__ = [
    "ConfigError",
    "Issue",
    "PreflightReport",
    "assert_startable",
    "check_settings",
]
