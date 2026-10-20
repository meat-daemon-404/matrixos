"""启动前配置校验（``core/preflight.py``）回归测试。

背景：``preflight`` 是「fail fast，不带病启动」的守门人——它区分 ERROR（阻断启动）与
WARNING（仅记日志）。这份文件锁死三个最容易被改坏的性质：

1. **不误伤开发**：``development`` / ``test`` 只跑极少的硬性检查，本地
   ``auto_generate_keys=true``（缺密钥时自动生成）**不得**被判成 ERROR；
2. **严格环境真的收紧**：``production`` 下 SQLite DSN、``auto_generate_keys=true``、
   HS256、refresh ≤ access 等组合约束必须产出 ERROR，且 ``assert_startable`` 抛
   ``ConfigError``；
3. **一次报全**：一份同时违反多条约束的配置，返回值里要含**全部**对应 Issue，
   而不是第一个就停——否则运维会陷入「改一条、重启一次、再发现下一条」的循环。

另一个必须钉死的点：``app/main.py`` 的 lifespan 里 ``assert_startable`` 是**无条件**
调用的（不是只在 strict 环境才进）。因此这里专门有一个用例走 ``create_app`` +
``TestClient``，证明配置非法时进程根本起不来——这是「preflight 真的在启动路径上」的
端到端证据，而不是只测了纯函数。

密钥对用例造的是**真 PEM**（用 ``app.core.security.keys.generate_keypair`` 生成），
所以「私钥推导出的公钥 != public.pem」这条能走真实解析路径；Windows 上私有文件的
权限位检查会被跳过（``os.name != "posix"``），因此这里只断言「不配对」这一条。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.config import DEFAULT_JWT_ISSUER, Settings
from app.core.preflight import ConfigError, assert_startable, check_settings
from app.core.security.keys import generate_keypair

# ---------------------------------------------------------------- 常量与帮助

# 一个合法的生产配置基线：任何"只差一项"的用例都从这里覆盖单个字段，
# 避免别的字段顺手带出无关 ERROR 干扰断言。
PROD_ISSUER = "https://core.matrixos.edu"
PROD_DSN = "postgresql+asyncpg://matrixos:s3cret@db:5432/matrixos"


def prod_settings(**overrides: object) -> Settings:
    """生产环境基线配置（合法），用 overrides 精确注入单个缺陷。"""
    base: dict[str, object] = {
        "app_env": "production",
        "database_url": PROD_DSN,
        "jwt_issuer": PROD_ISSUER,
        "cookie_secure": True,
        "log_json": True,
        # Settings 的出厂默认是 True（方便本地开发），但严格环境必须显式关掉——
        # 基线不带上它，每个"只差一项"的用例都会被这条无关 ERROR 污染。
        "auto_generate_keys": False,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def write_keypair(keys_dir: Path, private_pem: bytes, public_pem: bytes) -> Path:
    """把密钥写进 ``keys_dir/current``（与 KeyStore 读取的布局一致）。"""
    current = keys_dir / "current"
    current.mkdir(parents=True, exist_ok=True)
    (current / "private.pem").write_bytes(private_pem)
    (current / "public.pem").write_bytes(public_pem)
    return current


@pytest.fixture()
def paired_keys_dir(tmp_path: Path) -> Path:
    """一对**配对**的真实 RSA 密钥（合法基线）。"""
    dir_ = tmp_path / "keys-ok"
    write_keypair(dir_, *generate_keypair())
    return dir_


@pytest.fixture()
def mismatched_keys_dir(tmp_path: Path) -> Path:
    """私钥与公钥**不配对**：私钥来自 A，公钥来自 B。"""
    dir_ = tmp_path / "keys-bad"
    private_pem, _ = generate_keypair()
    _, other_public_pem = generate_keypair()
    write_keypair(dir_, private_pem, other_public_pem)
    return dir_


def settings_of(report) -> set[str]:
    """报告里出现过的 setting 名集合（便于「某条 Issue 在不在」的断言）。"""
    return {issue.setting for issue in report.issues}


def errors_of(report) -> list[str]:
    return [issue.render() for issue in report.errors]


# ─────────────────────────────────────────────────────────────
# 1. 不误伤开发环境
# ─────────────────────────────────────────────────────────────


def test_development_allows_auto_generate_keys(paired_keys_dir: Path) -> None:
    """development + auto_generate_keys=true + 合法配置 → ok，且没有任何 ERROR。

    ``auto_generate_keys`` 的默认值就是 ``true``，本地开发靠它免去手动生成密钥。
    若它被无条件判成 ERROR，``python -m uvicorn app.main:app`` 会直接起不来——
    这是最典型的"误伤开发"。
    """
    settings = Settings(
        app_env="development",
        auto_generate_keys=True,
        database_url="sqlite+aiosqlite:///./dev.db",
    )

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert report.ok is True, f"开发环境被误伤：{errors_of(report)}"
    assert report.errors == []


def test_development_without_keys_still_startable(tmp_path: Path) -> None:
    """development 下即使密钥还没生成，也只是 WARNING（lifespan 会真的生成）。"""
    settings = Settings(
        app_env="development",
        auto_generate_keys=True,
        database_url="sqlite+aiosqlite:///./dev.db",
    )

    report = check_settings(settings, keys_dir=tmp_path / "empty-keys")

    assert report.ok is True, f"缺密钥不该阻断开发启动：{errors_of(report)}"
    assert "keys_dir" in settings_of(report)  # 有提示，但只是 WARNING


def test_test_env_is_not_strict() -> None:
    """``test`` 环境与 ``development`` 同级：不启用严格检查。"""
    settings = Settings(app_env="test", database_url="sqlite+aiosqlite:///./t.db")

    assert settings.is_strict is False
    assert settings.is_production is False


# ─────────────────────────────────────────────────────────────
# 2. 生产环境真的收紧（每条 → ERROR + ConfigError）
# ─────────────────────────────────────────────────────────────


def test_production_rejects_sqlite(paired_keys_dir: Path) -> None:
    """生产环境 + SQLite DSN → ERROR，且 assert_startable 抛 ConfigError。

    SQLite 无法承载 pgvector 的 HNSW 索引，也没有真正的并发写。
    """
    settings = prod_settings(database_url="sqlite+aiosqlite:///./prod.db")

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "database_url" for issue in report.issues
    ), errors_of(report)
    assert report.ok is False

    with pytest.raises(ConfigError) as excinfo:
        assert_startable(settings, keys_dir=paired_keys_dir)
    assert "database_url" in str(excinfo.value)


def test_production_rejects_auto_generate_keys(paired_keys_dir: Path) -> None:
    """生产环境 + auto_generate_keys=true → ERROR。

    多副本各自生成会得到不同的 kid，A 副本签发的 token 在 B 副本验签失败；
    容器重建还会丢掉私钥，把所有人强制登出。
    """
    settings = prod_settings(auto_generate_keys=True)

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "auto_generate_keys"
        for issue in report.issues
    ), errors_of(report)


def test_production_rejects_sync_postgres_dsn(paired_keys_dir: Path) -> None:
    """生产必须用 asyncpg：同步驱动会在事件循环里阻塞整个进程。"""
    settings = prod_settings(database_url="postgresql+psycopg://u:p@db:5432/x")

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "database_url" for issue in report.issues
    ), errors_of(report)


def test_symmetric_jwt_algorithm_rejected_on_production(paired_keys_dir: Path) -> None:
    """jwt_algorithm='HS256' → ERROR（对称算法无法把公钥安全分发给 18 个微站）。"""
    settings = prod_settings(jwt_algorithm="HS256")

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "jwt_algorithm" for issue in report.issues
    ), errors_of(report)


def test_symmetric_jwt_algorithm_rejected_in_any_env() -> None:
    """HS* 属于 ``_check_always``：连开发环境也不允许，别等上线才发现。"""
    settings = Settings(app_env="development", jwt_algorithm="HS256")

    report = check_settings(settings, keys_dir=None)

    assert any(
        issue.level == "ERROR" and issue.setting == "jwt_algorithm" for issue in report.issues
    ), errors_of(report)


def test_refresh_must_outlive_access(paired_keys_dir: Path) -> None:
    """refresh_token_ttl <= access_token_ttl → ERROR（ADR-03 设计前提不成立）。"""
    settings = prod_settings(
        access_token_ttl_seconds=3600, refresh_token_ttl_seconds=3600
    )

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "refresh_token_ttl_seconds"
        for issue in report.issues
    ), errors_of(report)


def test_production_requires_secure_cookie(paired_keys_dir: Path) -> None:
    """生产 + cookie_secure=false → ERROR（mx_at/mx_rt 会经明文 HTTP 发送）。"""
    settings = prod_settings(cookie_secure=False)

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "cookie_secure" for issue in report.issues
    ), errors_of(report)


def test_plain_http_issuer_rejected(paired_keys_dir: Path) -> None:
    """生产 + http:// 的 issuer → ERROR（iss 会写进每枚 token）。"""
    settings = prod_settings(jwt_issuer="http://core.matrixos.edu")

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "jwt_issuer" for issue in report.issues
    ), errors_of(report)
    # 出厂占位值那条 WARNING 不该混进来：这里 issuer 是自定义域名，只是协议不对
    assert not any(
        issue.level == "WARNING" and issue.setting == "jwt_issuer" for issue in report.issues
    ), errors_of(report)


def test_staging_shares_strict_rules(paired_keys_dir: Path) -> None:
    """staging 与 production 共用严格校验，避免「预发能跑、生产炸」。"""
    settings = Settings(app_env="staging", database_url="sqlite+aiosqlite:///./s.db")

    assert settings.is_strict is True
    assert settings.is_production is False

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "database_url" for issue in report.issues
    ), errors_of(report)


def test_prod_and_production_normalize_to_same_env() -> None:
    """``prod`` / ``PROD`` 归一成 ``production``，否则 is_strict 会静默失效。"""
    assert Settings(app_env="prod").app_env == "production"
    assert Settings(app_env="PROD").is_strict is True


def test_default_issuer_warns_but_does_not_block(paired_keys_dir: Path) -> None:
    """沿出厂占位 issuer 只是 WARNING：它会登出所有人，但不该阻断启动。"""
    settings = prod_settings(jwt_issuer=DEFAULT_JWT_ISSUER)

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert report.ok is True, errors_of(report)
    assert any(
        issue.level == "WARNING" and issue.setting == "jwt_issuer" for issue in report.issues
    )


# ─────────────────────────────────────────────────────────────
# 3. 一次报全
# ─────────────────────────────────────────────────────────────


def test_reports_all_issues_at_once(mismatched_keys_dir: Path) -> None:
    """一份同时踩四条约束的配置 → 四条 Issue 全在，不是第一个就停。

    刻意用**不配对**的密钥目录，顺带把密钥检查也一起报出来。
    """
    settings = prod_settings(
        database_url="sqlite+aiosqlite:///./prod.db",
        auto_generate_keys=True,
        jwt_algorithm="HS256",
        access_token_ttl_seconds=7200,
        refresh_token_ttl_seconds=60,
    )

    report = check_settings(settings, keys_dir=mismatched_keys_dir)
    seen = settings_of(report)

    for expected in (
        "database_url",
        "auto_generate_keys",
        "jwt_algorithm",
        "refresh_token_ttl_seconds",
        "keys_dir",
    ):
        assert expected in seen, f"缺少 {expected} 的 Issue——校验提前中断了：{seen}"
    assert len(report.errors) >= 5, errors_of(report)

    # 抛出的异常里要能一次看到全部问题（运维读一条就能一次改完）
    with pytest.raises(ConfigError) as excinfo:
        assert_startable(settings, keys_dir=mismatched_keys_dir)
    message = str(excinfo.value)
    for expected in (
        "database_url",
        "auto_generate_keys",
        "jwt_algorithm",
        "refresh_token_ttl_seconds",
        "keys_dir",
    ):
        assert expected in message, f"ConfigError 消息缺 {expected}"

    # 报告对象本身也要能从异常里取回，供调用方记日志（main.py 会把 warnings 打进日志）
    assert excinfo.value.report.errors, "ConfigError 应携带完整报告"


def test_summary_counts_errors_and_warnings(paired_keys_dir: Path) -> None:
    """summary() 给人看：环境、错误数、告警数、逐条渲染。"""
    settings = prod_settings(jwt_issuer=DEFAULT_JWT_ISSUER)

    report = check_settings(settings, keys_dir=paired_keys_dir)
    text = report.summary()

    assert "环境 production" in text
    assert "jwt_issuer" in text


# ─────────────────────────────────────────────────────────────
# 4. 密钥目录
# ─────────────────────────────────────────────────────────────


def test_missing_key_files_error_on_production(tmp_path: Path) -> None:
    """严格环境 + keys_dir 里两个文件都没有 → ERROR。"""
    settings = prod_settings()

    report = check_settings(settings, keys_dir=tmp_path / "no-keys-here")

    assert any(
        issue.level == "ERROR" and issue.setting == "keys_dir" for issue in report.issues
    ), errors_of(report)


def test_mismatched_keypair_error_on_production(mismatched_keys_dir: Path) -> None:
    """私钥与公钥不配对 → ERROR（签发的 token 永远验不过，要到登录才暴露）。"""
    settings = prod_settings()

    report = check_settings(settings, keys_dir=mismatched_keys_dir)

    assert any(
        issue.level == "ERROR" and issue.setting == "keys_dir" for issue in report.issues
    ), errors_of(report)
    mismatch = [
        issue
        for issue in report.errors
        if issue.setting == "keys_dir" and "不配对" in issue.detail
    ]
    assert mismatch, [issue.detail for issue in report.errors]


def test_matched_keypair_is_clean(paired_keys_dir: Path) -> None:
    """配对正确的密钥不该产生 ``keys_dir`` 的 ERROR（否则上面那条断言就是假的）。"""
    settings = prod_settings()

    report = check_settings(settings, keys_dir=paired_keys_dir)

    assert not [
        issue
        for issue in report.errors
        if issue.setting == "keys_dir"
    ], errors_of(report)


def test_unparseable_key_files_error(tmp_path: Path) -> None:
    """两个文件都在、但内容不是 PEM → ERROR（解析失败也算密钥不可用）。"""
    dir_ = tmp_path / "garbage-keys"
    write_keypair(dir_, b"not-a-pem", b"also-not-a-pem")
    settings = prod_settings()

    report = check_settings(settings, keys_dir=dir_)

    assert any(
        issue.level == "ERROR" and issue.setting == "keys_dir" for issue in report.issues
    ), errors_of(report)


def test_mismatch_only_checked_when_both_files_exist(tmp_path: Path) -> None:
    """只有一个文件时走「缺文件」分支，不去解析——不会连带报「不配对」。"""
    dir_ = tmp_path / "half-keys"
    current = dir_ / "current"
    current.mkdir(parents=True)
    private_pem, _ = generate_keypair()
    (current / "private.pem").write_bytes(private_pem)  # 只有私钥

    settings = prod_settings()
    report = check_settings(settings, keys_dir=dir_)

    details = [issue.detail for issue in report.errors if issue.setting == "keys_dir"]
    assert details, errors_of(report)
    assert any("缺少" in detail for detail in details), details
    assert not any("不配对" in detail for detail in details), details


# ─────────────────────────────────────────────────────────────
# 5. 启动路径（端到端）：配置非法 → 进程根本起不来
# ─────────────────────────────────────────────────────────────


def test_lifespan_refuses_to_start_on_invalid_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """走真实 ``create_app`` + lifespan：非法配置时启动直接抛 ConfigError。

    这条是「preflight 真的在启动路径上被调用」的证据——``assert_startable`` 是
    **无条件**调用的（不是只在 strict 环境才进），因此生产配置错误一定拦得住。
    """
    from fastapi.testclient import TestClient

    from app.core.config import clear_settings_cache
    from app.main import create_app

    monkeypatch.setenv("MATRIX_CORE_APP_ENV", "production")
    monkeypatch.setenv("MATRIX_CORE_AUTO_GENERATE_KEYS", "false")
    monkeypatch.setenv("MATRIX_CORE_KEYS_DIR", str(paired_key_dir(monkeypatch, tmp_path)))
    clear_settings_cache()

    # 通过 Settings 显式注入非法 DSN（init 参数优先级高于 env）
    settings = Settings(
        app_env="production",
        database_url="sqlite+aiosqlite:///./definitely-not-prod.db",
        jwt_issuer=PROD_ISSUER,
        cookie_secure=True,
        log_json=True,
        auto_generate_keys=False,
        keys_dir=paired_key_dir(monkeypatch, tmp_path),
    )

    app = create_app(settings)

    with pytest.raises(ConfigError):
        with TestClient(app):
            pass  # pragma: no cover - 不该走到这里


def test_lifespan_starts_and_exposes_preflight_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """合法配置 → 起得来，且 ``app.state.preflight`` 被填上（/health/detail 依赖它）。"""
    from fastapi.testclient import TestClient

    from app.core.config import clear_settings_cache
    from app.main import create_app

    keys = paired_key_dir(monkeypatch, tmp_path)
    monkeypatch.setenv("MATRIX_CORE_KEYS_DIR", str(keys))
    clear_settings_cache()

    settings = Settings(
        app_env="development",
        database_url="sqlite+aiosqlite:///./dev-start.db",
        auto_generate_keys=False,
        keys_dir=keys,
        write_rate_limit_per_minute=0,
    )

    app = create_app(settings)
    with TestClient(app) as client:
        report = client.app.state.preflight
        assert report is not None
        assert report.ok is True

        detail = client.get("/v1/health/detail")
        assert detail.status_code == 200
        body = detail.json()
        # /health/detail 复用了同一份报告对象：合法配置下告警列表为空
        assert "config_warnings" in body
        assert body["config_warnings"] == []


def paired_key_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """给启动路径用例准备一对真实密钥。"""
    dir_ = tmp_path / "startup-keys"
    if not (dir_ / "current" / "private.pem").exists():
        write_keypair(dir_, *generate_keypair())
    return dir_
