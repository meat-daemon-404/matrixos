"""资产路由的公共鉴权依赖。

**为什么单独一层**：access token 的 JWT 校验只证明「签名有效」，不证明
「该用户没被全局登出」。``require_identity`` 把两件事合起来：

1. 验签（``get_current_token``）；
2. 二次判定：``jti`` 黑名单 + 用户 ``auth_epoch`` + 用户仍激活
   （``auth_service.assert_access_token_live``）。

所有 ``/v1/assets`` 与 ``/v1/wormhole`` 的端点都必须走它，不允许只验签就放行。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends

from app.api.deps import CurrentToken, SessionDep
from app.core.security.tokens import TokenClaims
from app.core.tracing import get_trace_id
from app.models.auth import MatrixUser
from app.services import auth as auth_service


@dataclass(frozen=True)
class Identity:
    """一次请求的完整身份视图。"""

    claims: TokenClaims
    user: MatrixUser

    @property
    def matrix_uid(self) -> str:
        return self.user.matrix_uid

    @property
    def scope(self) -> list[str]:
        return list(self.claims.scope)

    @property
    def station_id(self) -> str | None:
        return self.claims.station_id

    @property
    def trace_id(self) -> str:
        return self.claims.trace_id or get_trace_id()


async def require_identity(session: SessionDep, claims: CurrentToken) -> Identity:
    """验签 + 吊销状态 + epoch + 用户激活状态，四道全过才返回身份。"""
    user = await auth_service.assert_access_token_live(session, claims)
    return Identity(claims=claims, user=user)


IdentityDep = Annotated[Identity, Depends(require_identity)]

__all__ = ["Identity", "IdentityDep", "require_identity"]
