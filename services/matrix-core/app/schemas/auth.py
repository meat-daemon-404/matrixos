"""鉴权相关的请求/响应契约（S1-08 / S1-09）。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class AuthorizeQuery(BaseModel):
    """/v1/auth/authorize 的查询参数（OAuth2 授权码 + PKCE）。"""

    response_type: str = Field(default="code", pattern="^code$")
    client_id: str
    redirect_uri: str
    scope: str = ""
    state: str | None = None
    code_challenge: str | None = None
    code_challenge_method: str | None = Field(default=None, pattern="^(S256|plain)$")


class LoginRequest(BaseModel):
    """统一登录页提交（兜底凭据体系；CAS 场景由 /authorize 直接带 ticket）。"""

    client_id: str
    redirect_uri: str
    scope: str = ""
    state: str | None = None
    code_challenge: str | None = None
    code_challenge_method: str | None = None
    email: str
    password: str


class TokenExchangeRequest(BaseModel):
    """POST /v1/auth/token（grant_type=authorization_code | refresh_token）。"""

    grant_type: str = Field(pattern="^(authorization_code|refresh_token)$")
    code: str | None = None
    redirect_uri: str | None = None
    client_id: str | None = None
    code_verifier: str | None = None
    refresh_token: str | None = None


class RefreshRequest(BaseModel):
    """POST /v1/auth/refresh 的请求体。

    **刻意不复用 ``TokenExchangeRequest``**：那个模型要求 ``grant_type``，
    但 ``/refresh`` 这个端点本身就是 refresh 语义，再让调用方填一次
    ``grant_type="refresh_token"`` 属于冗余契约，且会让
    ``{"refresh_token": "..."}`` 这种最自然的请求 422。
    """

    model_config = ConfigDict(extra="forbid")

    refresh_token: str | None = None


class TokenResponse(BaseModel):
    """令牌响应（RFC 6749 形态 + MatrixOS 扩展字段）。"""

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "access_token": "mxat_...",
                    "token_type": "Bearer",
                    "expires_in": 900,
                    "refresh_token": "mxrt_...",
                    "refresh_expires_in": 2592000,
                    "scope": "station:curvelab:read station:curvelab:write",
                    "matrix_uid": "mxu_01H8Z9K2",
                }
            ]
        }
    )

    access_token: str
    token_type: str = "Bearer"
    expires_in: int = Field(description="mx_at 有效期（秒），固定 900 = 15 min")
    refresh_token: str
    refresh_expires_in: int = Field(description="mx_rt 有效期（秒），30 d 滑动")
    scope: str
    matrix_uid: str
    station_id: str | None = None


class IntrospectRequest(BaseModel):
    """POST /v1/auth/introspect：微站校验并读取令牌能力。"""

    model_config = ConfigDict(extra="forbid")

    token: str
    # 目标站 site_key：用于判定该令牌是否被允许在此站使用
    audience: str | None = None


class IntrospectResponse(BaseModel):
    """RFC 7662 风格 + MatrixOS 字段。"""

    active: bool
    matrix_uid: str | None = None
    scope: list[str] = Field(default_factory=list)
    client_id: str | None = None
    station_id: str | None = None
    exp: int | None = None
    iat: int | None = None
    typ: str | None = None
    # 该令牌在 audience 站上的有效 verb（含 admin:* 派生）
    stations: dict[str, list[str]] = Field(default_factory=dict)
    # 若 audience 给定但无权限，这里给出原因（active 仍为 true 表示令牌本身有效）
    audience_allowed: bool = True


class ExchangeRequest(BaseModel):
    """POST /v1/auth/exchange：用 mx_idt 换一次 mx_at（iframe 场景，A4/ADR-03）。"""

    model_config = ConfigDict(extra="forbid")

    mx_idt: str
    # 明确声明期望的目标站，服务端会与 idt 内绑定的目标站比对（IDT_STATION_MISMATCH）
    station_id: str | None = None


class ExchangeResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    scope: str
    matrix_uid: str
    station_id: str
    trace_id: str


class UserInfoResponse(BaseModel):
    """/v1/auth/userinfo：hub 首页展示所需的最小身份信息。"""

    matrix_uid: str
    display_name: str
    entitlements: list[str] = Field(default_factory=list)
    scope: list[str] = Field(default_factory=list)
    station_id: str | None = None
    epoch: int = 1


class LogoutResponse(BaseModel):
    revoked: int = 0
    epoch: int | None = None
    message: str = "已登出"


class JwksResponse(BaseModel):
    keys: list[dict] = Field(default_factory=list)


class IdtIssueRequest(BaseModel):
    """内部/SDK 用：为 iframe 主动签一枚 mx_idt（供 hub 调）。

    注意：正常路径是 hub 从 /v1/wormhole/receipt 拿到 mx_idt；此端点用于
    「打开非虫洞的普通 iframe 微站」时的一次性身份交接。
    """

    model_config = ConfigDict(extra="forbid")

    target_station: str
    trace_id: str | None = None
    scope: list[str] | None = None


class IdtIssueResponse(BaseModel):
    mx_idt: str
    expires_in: int
    target_station: str
    trace_id: str
