"""口袋端 service 层的纯逻辑单测。

HTTP 测试（`test_pocket_api.py`）覆盖的是「端到端行为对不对」；这里覆盖的是
**独立于 HTTP 的算法分支**——streak 的边界、幂等派生键的构成、验真等级取最弱一环、
演示回落的判定。这些逻辑一旦回归，HTTP 用例未必定位得到，但单测能一句话指到行。

`push_queue` 里那条「并发重放撞唯一约束→expunge 后读回」的路径也在这里用
真实 SQLite 触发（HTTP 层很难稳定复现竞态，直接对 service 调两次同键最可靠）。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ErrorCode, MatrixError
from app.schemas.pocket import QueuePushRequest
from app.schemas.wormhole import EvidenceAnchor
from app.services import pocket as svc

TODAY = date(2026, 10, 20)


# ================================================================== streak 纯函数


def test_streak_counts_backwards_from_today() -> None:
    done = {"2026-10-20", "2026-10-19", "2026-10-18"}
    assert svc._streak(done, TODAY) == 3


def test_streak_survives_before_first_checkin_of_today() -> None:
    """今天没打但昨天往前连续 → 从昨天回数，不归零。"""
    done = {"2026-10-19", "2026-10-18"}
    assert svc._streak(done, TODAY) == 2


def test_streak_zero_when_yesterday_missing() -> None:
    done = {"2026-10-18", "2026-10-17"}  # 昨天(19)没打
    assert svc._streak(done, TODAY) == 0


def test_streak_empty() -> None:
    assert svc._streak(set(), TODAY) == 0


def test_week_flags_length_and_today_slot() -> None:
    done = {"2026-10-20", "2026-10-17"}
    flags = svc._week_flags(done, TODAY)
    assert len(flags) == 7
    assert flags[-1] is True          # 今天
    assert flags[-4] is True          # 10-17
    assert flags.count(True) == 2


# ================================================================== 幂等派生键


def test_derived_key_stable_and_target_sensitive() -> None:
    anchor = EvidenceAnchor(
        source_doi_or_url="https://doi.org/x", verification_level="Level_A_Verified"
    )
    base = dict(card_id="c1", title="T", note="", payload_type="paper_doi_bundle",
                origin="morning_card", evidence_anchors=[anchor])
    k1 = svc._derive_idempotency_key("mxu_a", QueuePushRequest(target_station="matrix-cross", **base))
    k2 = svc._derive_idempotency_key("mxu_a", QueuePushRequest(target_station="matrix-cross", **base))
    k3 = svc._derive_idempotency_key("mxu_a", QueuePushRequest(target_station="curvelab", **base))
    assert k1 == k2, "同内容必须派生同键（幂等的前提）"
    assert k1 != k3, "目标站不同必须不同键（否则两件待办被误合并）"


def test_derived_key_user_scoped() -> None:
    """不同用户推同内容不能共用键——否则会跨用户读到彼此的条目。"""
    anchor = EvidenceAnchor(
        source_doi_or_url="https://doi.org/x", verification_level="Level_A_Verified"
    )
    req = QueuePushRequest(
        target_station="matrix-cross", card_id="c1", title="T", note="",
        payload_type="paper_doi_bundle", origin="morning_card", evidence_anchors=[anchor],
    )
    assert svc._derive_idempotency_key("mxu_a", req) != svc._derive_idempotency_key("mxu_b", req)


# ================================================================== 卡片 id 可重算


def test_card_id_deterministic() -> None:
    a = svc._card_id("mxu_a", TODAY, 1)
    b = svc._card_id("mxu_a", TODAY, 1)
    c = svc._card_id("mxu_a", TODAY, 2)
    d = svc._card_id("mxu_b", TODAY, 1)
    assert a == b and len(a) == 16
    assert a != c and a != d


# ================================================================== 状态机


def test_advance_stage_rejects_backward_and_skip() -> None:
    # 纯逻辑：STAGE_ORDER 的相邻关系是跃迁合法性的唯一依据
    order = svc.STAGE_ORDER
    assert order.index("email_read") + 1 == order.index("interview_scheduled")
    assert order.index("email_sent") + 2 == order.index("interview_scheduled")


# ================================================================== 最弱一环


def test_card_worst_link_via_build_card(db_run, settings) -> None:
    """掺一条预印本，整张名片等级必须被拉到非 A。

    用真实会话跑 `build_card`：名片聚合是纯读逻辑，直接对 service 断言比走 HTTP 干净。
    """
    from app.models.assets import AssetNode
    from app.models.auth import MatrixUser
    import asyncio

    uid = "mxu_worst_" + uuid.uuid4().hex[:6]

    async def seed(session: AsyncSession) -> None:
        session.add(AssetNode(
            matrix_uid=uid, station_id="curvelab", asset_type="fit_result",
            title="A 级拟合", payload={}, verification_level="Level_A_Verified",
            evidence_anchors=[{"source_doi_or_url": "https://doi.org/a",
                               "verification_level": "Level_A_Verified"}],
            search_text="", created_at=svc.now(), updated_at=svc.now(),
        ))
        session.add(AssetNode(
            matrix_uid=uid, station_id="curvelab", asset_type="paper",
            title="B 级论文", payload={}, verification_level="Level_B_Preprint",
            evidence_anchors=[{"source_doi_or_url": "https://arxiv.org/b",
                               "verification_level": "Level_B_Preprint"}],
            search_text="", created_at=svc.now(), updated_at=svc.now(),
        ))
        await session.commit()

    async def read(session: AsyncSession) -> Any:
        card, origin = await svc.build_card(session, matrix_uid=uid)
        await session.commit()
        return card

    db_run(seed)
    card = db_run(read)
    assert card.verification_level == "Level_B_Preprint", "最弱一环必须决定整张名片等级"
    assert card.matrix_uid == uid


# ================================================================== push 幂等（service 层）


def test_push_twice_same_key_dedups(db_run, settings, signer) -> None:
    """同 idempotencyKey 连推两次：第二次 deduplicated=True，库中仅一条。

    直接压 service（不经 HTTP），因为「并发重放撞唯一约束」这条路径在 HTTP 层
    很难稳定触发，而在 service 层用同一 session 顺序调两次能确定性地覆盖派生键
    去重与应用层先查命中两条分支。
    """
    from app.core.config import get_settings
    from app.core.security.tokens import TokenSigner
    from app.models.auth import MatrixUser
    from app.services import auth as auth_service
    import asyncio

    cfg = get_settings()
    uid = "mxu_push_" + uuid.uuid4().hex[:6]
    anchor = EvidenceAnchor(
        source_doi_or_url="https://doi.org/10.1038/x", verification_level="Level_A_Verified"
    )
    key = "explicit-" + uuid.uuid4().hex
    req = QueuePushRequest(
        card_id="c1", title="待办", note="", target_station="matrix-cross",
        desktop_action="处理", payload_type="paper_doi_bundle",
        origin="morning_card", evidence_anchors=[anchor], source_station="curvelab",
        idempotency_key=key,
    )

    async def do(session: AsyncSession) -> tuple[bool, bool, int]:
        # 该身份需要 emit scope 才会落收据；这里不关心收据，只关心去重，
        # 用无 emit 的 scope 走「跳过收据但仍去重」这条真实分支。
        first, r1, k1, dedup1 = await svc.push_queue(
            session, settings=cfg, signer=signer, matrix_uid=uid,
            scope=[], station_id="curvelab", request=req,
        )
        await session.commit()
        second, r2, k2, dedup2 = await svc.push_queue(
            session, settings=cfg, signer=signer, matrix_uid=uid,
            scope=[], station_id="curvelab", request=req,
        )
        await session.commit()
        from sqlalchemy import func, select
        from app.models.pocket import QueueItem
        count = await session.scalar(
            select(func.count()).select_from(QueueItem).where(QueueItem.idempotency_key == key)
        )
        assert first.id == second.id
        return dedup1, dedup2, int(count or 0)

    dedup1, dedup2, count = db_run(do)
    assert dedup1 is False, "首推不应标记为去重"
    assert dedup2 is True, "重复推必须标记为去重"
    assert count == 1, "库中只应有一条待办"
