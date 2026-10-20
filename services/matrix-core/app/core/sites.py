"""站点花名册（scope 与 station_id 的唯一事实源）。

按 ADR 与 architecture §2.1：`specs/microsites.json` 是 18 站权威花名册，
本模块只做「读取 + 派生 site_key」，不复制维护第二份站点表。

关键派生规则：`site_key` = domain 的第一段标签。
- `curvelab.matrixos.edu` → `curvelab`
- `pat-hot.matrixos.edu` → `pat-hot`（注意目录名是 pat-radar，域名才是路由事实源）
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from app.core.config import SERVICE_ROOT


def _repo_spec_path() -> Path | None:
    """仓库根下的 ``specs/microsites.json``；取不到时返回 None。

    为什么不用 ``SERVICE_ROOT.parents[1]`` 直接索引：**容器里会炸**。
    镜像把服务放在 ``/app``（``WORKDIR /app`` + ``COPY . .``），此时
    ``SERVICE_ROOT`` 就是 ``/app``，而 ``Path('/app').parents`` 只有 ``['/']``
    一个元素——``parents[1]`` 抛 ``IndexError``，且是在**模块导入期**抛出，
    整个进程起不来。本地开发目录层级深，恰好永远踩不到这个雷。
    """
    parents = SERVICE_ROOT.parents
    if len(parents) > 1:
        return parents[1] / "specs" / "microsites.json"
    return None


# 仓库内的权威花名册（services/matrix-core → 上两级即仓库根）；
# 镜像里则通常在 /app/specs 或由 MATRIX_CORE_SPECS_DIR 挂载。
_SPEC_CANDIDATES = tuple(
    candidate
    for candidate in (
        _repo_spec_path(),
        SERVICE_ROOT / "specs" / "microsites.json",
        Path("/app/specs/microsites.json"),
    )
    if candidate is not None
)

# 兜底：仅在找不到花名册文件时使用（例如精简镜像）。内容与 specs/microsites.json 的
# domain 列逐条一致；任何差异以仓库里的 JSON 为准。
_FALLBACK_DOMAINS: tuple[str, ...] = (
    "gpa.matrixos.edu",
    "spark.matrixos.edu",
    "grant-audit.matrixos.edu",
    "pat-hot.matrixos.edu",
    "lit-sonar.matrixos.edu",
    "mentor.matrixos.edu",
    "cold-email.matrixos.edu",
    "lab-kanban.matrixos.edu",
    "matrix-cross.matrixos.edu",
    "pdf-sniper.matrixos.edu",
    "curvelab.matrixos.edu",
    "repro-check.matrixos.edu",
    "chart-foundry.matrixos.edu",
    "review-lab.matrixos.edu",
    "retract-radar.matrixos.edu",
    "yunheng.matrixos.edu",
    "evidence-cv.matrixos.edu",
    "prejob.matrixos.edu",
)

HUB_DOMAIN = "orbital.matrixos.edu"
HUB_SITE_KEY = "orbital"


def _load_domains() -> tuple[str, ...]:
    for candidate in _SPEC_CANDIDATES:
        try:
            raw = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        domains = tuple(
            item["domain"] for item in raw if isinstance(item, dict) and "domain" in item
        )
        if len(domains) == 18:
            return domains
    return _FALLBACK_DOMAINS


def site_key_of_domain(domain: str) -> str:
    """从域名取 site_key；非法输入返回空串（调用方据此拒绝）。"""
    if not domain or not isinstance(domain, str):
        return ""
    host = domain.split("/")[0].strip().lower()
    label = host.split(".")[0]
    if not label or not all(ch.isalnum() or ch == "-" for ch in label):
        return ""
    return label


@lru_cache(maxsize=1)
def known_site_keys() -> frozenset[str]:
    """全部合法 site_key（18 个微站 + hub）。"""
    return frozenset(site_key_of_domain(domain) for domain in _load_domains()) | {HUB_SITE_KEY}


@lru_cache(maxsize=1)
def domain_by_site_key() -> dict[str, str]:
    mapping = {site_key_of_domain(domain): domain for domain in _load_domains()}
    mapping[HUB_SITE_KEY] = HUB_DOMAIN
    return mapping


def is_known_site(site_key: str) -> bool:
    return site_key in known_site_keys()


def domain_for(site_key: str) -> str:
    return domain_by_site_key().get(site_key, f"{site_key}.matrixos.edu")


# scope 语法：station:<site_key>:<verb>，verb ∈ read | write | emit（architecture §4.5）
SCOPE_VERBS: tuple[str, ...] = ("read", "write", "emit")


def build_scope(site_key: str, verbs: tuple[str, ...] | list[str]) -> list[str]:
    return [f"station:{site_key}:{verb}" for verb in verbs if verb in SCOPE_VERBS]
