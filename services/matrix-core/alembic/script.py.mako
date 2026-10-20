"""Alembic 迁移脚本模板。

新版迁移用 ``alembic revision -m "..."`` 生成，模板从这里取。
"""

from __future__ import annotations

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "${up_revision}"
down_revision: str | None = "${down_revision}"
branch_labels: str | Sequence[str] | None = "${branch_labels}"
depends_on: str | Sequence[str] | None = "${depends_on}"


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
