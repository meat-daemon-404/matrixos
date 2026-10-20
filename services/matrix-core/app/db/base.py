"""数据库公共设施：声明式基类、命名约定、可移植列类型。

为什么要「可移植」：生产与验收目标是 PostgreSQL 16 + pgvector，但开发机/CI
未必有 PostgreSQL。因此：
- 生产：``VectorType`` 落到原生 ``vector(1024)``，``JSONB`` 落到 ``jsonb``；
- 测试：自动降级为 ``TEXT``（存 JSON 数组）与 ``JSON``，同一套 ORM 与 SQL 逻辑可跑。

**降级不影响生产语义**：向量检索在 PostgreSQL 上走 ``<=>`` 的 SQL 排序（HNSW 索引生效），
在降级方言上走等价的 Python 余弦距离——结果口径一致，只是失去索引加速。
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Sequence

from sqlalchemy import JSON, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import TypeDecorator

from app.core.config import get_settings

# 统一的约束命名约定：让 Alembic 迁移可以稳定地按名字 drop/alter
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """全部 ORM 模型的基类。"""


Base.metadata.naming_convention = NAMING_CONVENTION  # type: ignore[assignment]


def jsonb() -> Any:
    """JSONB（PostgreSQL）→ JSON（其他方言）。"""
    return JSON().with_variant(JSONB(), "postgresql")


class VectorType(TypeDecorator):
    """pgvector 的 ``vector(dim)`` 列，非 PostgreSQL 方言降级为 TEXT(JSON 数组)。

    ``dim`` 默认取配置的 ``embedding_dim``（ADR-04 锁定为 1024）。
    """

    impl = Text
    cache_ok = True

    def __init__(self, dim: int | None = None) -> None:
        super().__init__()
        self.dim = dim or get_settings().embedding_dim

    def load_dialect_impl(self, dialect: Any) -> Any:
        if dialect.name == "postgresql":
            from pgvector.sqlalchemy import Vector

            return dialect.type_descriptor(Vector(self.dim))
        return dialect.type_descriptor(Text())

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        vector = _as_float_list(value)
        if dialect.name == "postgresql":
            # 交给 pgvector 的 Vector 类型继续处理
            return vector
        return json.dumps(vector, separators=(",", ":"))

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, str):
            return json.loads(value)
        # pgvector 返回 numpy.ndarray 或 list
        return _as_float_list(value)

    def copy(self, **kw: Any) -> VectorType:
        return VectorType(dim=self.dim)


def _as_float_list(value: Iterable[Any] | Sequence[Any]) -> list[float]:
    return [float(item) for item in value]


def vector_literal(vector: Sequence[float]) -> str:
    """把向量渲染成 pgvector 字面量（供 raw SQL 的 ``CAST(:q AS vector)`` 使用）。

    只接受数值，杜绝把外部字符串拼进 SQL。
    """
    return "[" + ",".join(f"{float(item):.8g}" for item in vector) + "]"


def is_postgres(session_or_bind: Any) -> bool:
    """判断当前会话绑定的方言是否为 PostgreSQL。"""
    try:
        bind = getattr(session_or_bind, "bind", session_or_bind)
        dialect = bind.dialect
    except AttributeError:
        return False
    return getattr(dialect, "name", "") == "postgresql"
