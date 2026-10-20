"""scope 判定：``station:<site_key>:<verb>``（architecture §4.5）。

越权防线在这一层收敛，所有 API 都必须走 ``require_scope``，禁止「登录即可写」。
"""

from __future__ import annotations

from app.core.errors import ErrorCode, MatrixError

SCOPE_PREFIX = "station:"
ADMIN_SCOPE = "admin:*"


def parse_scope(scope: str | list[str] | tuple[str, ...] | None) -> list[str]:
    """把任意形态的 scope 归一到字符串列表。"""
    if scope is None:
        return []
    if isinstance(scope, str):
        return [item for item in scope.replace(",", " ").split() if item]
    return [str(item) for item in scope if str(item)]


def normalize_scope(scope: str | list[str] | None) -> str:
    """归一并去重排序，落库用空格分隔（OAuth2 惯例）。"""
    return " ".join(sorted(set(parse_scope(scope))))


def station_scope(site_key: str, verb: str) -> str:
    return f"{SCOPE_PREFIX}{site_key}:{verb}"


def scopes_for_station(scope: str | list[str] | None, site_key: str) -> set[str]:
    """取出与某个站相关的 verb 集合。"""
    verbs: set[str] = set()
    prefix = f"{SCOPE_PREFIX}{site_key}:"
    for item in parse_scope(scope):
        if item.startswith(prefix):
            verbs.add(item[len(prefix) :])
    return verbs


def has_scope(scope: str | list[str] | None, required: str) -> bool:
    """是否具备某个具体 scope；``admin:*`` 视为全量（仅运维账号持有）。"""
    items = parse_scope(scope)
    return required in items or ADMIN_SCOPE in items


def has_station_scope(scope: str | list[str] | None, site_key: str, verb: str) -> bool:
    return has_scope(scope, station_scope(site_key, verb))


def can_read_station(scope: str | list[str] | None, site_key: str) -> bool:
    return has_station_scope(scope, site_key, "read")


def can_write_station(scope: str | list[str] | None, site_key: str) -> bool:
    return has_station_scope(scope, site_key, "write")


def can_emit_station(scope: str | list[str] | None, site_key: str) -> bool:
    return has_station_scope(scope, site_key, "emit")


def require_scope(scope: str | list[str] | None, required: str, *, action: str = "") -> None:
    if not has_scope(scope, required):
        suffix = f"（{action}）" if action else ""
        raise MatrixError(
            ErrorCode.INSUFFICIENT_SCOPE,
            f"缺少所需权限 {required}{suffix}",
            log_extra={"required_scope": required, "granted": parse_scope(scope)},
        )


def require_station_scope(
    scope: str | list[str] | None, site_key: str, verb: str, *, action: str = ""
) -> None:
    require_scope(scope, station_scope(site_key, verb), action=action)


def validate_scope_request(
    requested: list[str], allowed: list[str], *, site_keys: frozenset[str]
) -> list[str]:
    """校验请求的 scope 是否合法（用于 /authorize）。

    规则：
    - 语法必须匹配 ``station:<已知站>:<verb>``；
    - 客户端 manifest 的 ``allowed_scopes`` 必须覆盖（``*`` 表示不限制站点，但 verb 仍受约束）；
    - 未知站点直接拒绝（防止伪造第 19+ 站越权）。
    """
    from app.core.sites import SCOPE_VERBS

    normalized: list[str] = []
    for item in requested:
        parts = item.split(":")
        if len(parts) != 3 or parts[0] != "station":
            raise MatrixError(ErrorCode.INVALID_SCOPE, f"非法 scope 语法：{item}")
        site_key, verb = parts[1], parts[2]
        if verb not in SCOPE_VERBS:
            raise MatrixError(ErrorCode.INVALID_SCOPE, f"非法 scope 动词：{verb}")
        if site_key not in site_keys:
            raise MatrixError(ErrorCode.INVALID_SCOPE, f"未知站点：{site_key}")
        if allowed and f"station:{site_key}:*" not in allowed and item not in allowed:
            raise MatrixError(ErrorCode.INVALID_SCOPE, f"客户端未获授权使用该 scope：{item}")
        normalized.append(item)
    return normalized
