"""口袋端 `/v1/pocket/*` 的 HTTP 行为测试。

**为什么这批测试重要**：口袋端此前 13 个端点全是前端 mock，`typecheck` 能过但
「手机推一条 → 桌面收一条」这条双端链路从来没被真正验证过。这里把它变成可执行证据。

断言口径与 `types.ts` / `api/index.ts` 对齐：
- 请求/响应用 **camelCase**（外层），嵌套锚点用 **snake_case**（虫洞契约原样）；
- `DELETE /checkin` 与 `DELETE /queue` 用 **query 别名**（goalId / id），照客户端实际发的来。

WS 相关用例在 `test_pocket_ws.py`。
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from .conftest import ALICE, BOB, CURVELAB


def _today() -> str:
    from app.services.pocket import today

    return today().isoformat()


def _shift(days: int) -> str:
    from app.services.pocket import today

    return (today() + timedelta(days=days)).isoformat()


def _push_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "cardId": "card-1",
        "title": "把这批样本加进对比矩阵",
        "note": "5 个衰减曲线，含 2026-10 新数据",
        "targetStation": "matrix-cross",
        "desktopAction": "在 Matrix-Cross 里建对比行",
        "payloadType": "paper_doi_bundle",
        "evidenceAnchors": [
            {
                "source_doi_or_url": "https://doi.org/10.1038/s41566-024-01430-1",
                "verification_level": "Level_A_Verified",
                "pdf_page": 3,
                "bbox": [72.0, 210.5, 540.0, 268.0],
            }
        ],
        "sourceStation": CURVELAB,
    }
    body.update(overrides)
    return body


def _one_goal(client: TestClient, headers: dict[str, str]) -> dict[str, Any]:
    """先 GET 一次（会播种默认目标），返回第一个微目标的视图。"""
    response = client.get("/v1/pocket/checkin", headers=headers)
    assert response.status_code == 200, response.text
    goals = response.json()["goals"]
    assert goals, "首次访问应播种出至少一个微目标"
    return goals[0]


def _goal_done(day: dict[str, Any], goal_id: str) -> bool:
    return next(g["done"] for g in day["goals"] if g["id"] == goal_id)


# ================================================================== 鉴权


@pytest.mark.parametrize(
    "path",
    [
        "/v1/pocket/morning",
        "/v1/pocket/checkin",
        "/v1/pocket/mentor",
        "/v1/pocket/card",
        "/v1/pocket/queue",
    ],
)
def test_pocket_endpoints_require_auth(client: TestClient, path: str) -> None:
    """未带 token 一律 401，错误体是统一三键。"""
    response = client.get(path)
    assert response.status_code == 401, response.text
    body = response.json()
    assert set(body) == {"code", "message", "trace_id"}
    assert body["code"] == "auth.login_required"


def test_push_requires_auth(client: TestClient) -> None:
    """写端点同样不能匿名——否则队列会被污染。"""
    response = client.post("/v1/pocket/queue/push", json=_push_body())
    assert response.status_code == 401


# ================================================================== 队列：推送 + 幂等


def test_push_creates_item_and_receipt(client: TestClient, auth) -> None:
    """首推 → 201，带 receipt_id（emit scope 具备时落虫洞收据），桌面离线。"""
    headers = auth()
    response = client.post("/v1/pocket/queue/push", json=_push_body(), headers=headers)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["item"]["status"] == "pending"
    assert body["item"]["targetStation"] == "matrix-cross"
    anchor = body["item"]["evidenceAnchors"][0]
    assert anchor["source_doi_or_url"].startswith("https://doi.org")
    assert anchor["verification_level"] == "Level_A_Verified"
    assert len(body["receiptId"]) == 36  # uuid
    assert body["desktopNotified"] is False  # 没有 WS 连接在线
    assert body["idempotencyKey"]


def test_push_idempotent_same_key_returns_200_same_receipt(client: TestClient, auth) -> None:
    """显式幂等键：第二次 200（非 201）、同 receipt_id、不产生第二条待办。"""
    headers = auth()
    key = "idem-" + str(uuid.uuid4())
    first = client.post(
        "/v1/pocket/queue/push", json=_push_body(idempotencyKey=key), headers=headers
    )
    assert first.status_code == 201, first.text
    second = client.post(
        "/v1/pocket/queue/push", json=_push_body(idempotencyKey=key), headers=headers
    )
    assert second.status_code == 200, second.text
    assert second.json()["receiptId"] == first.json()["receiptId"]
    assert second.json()["item"]["id"] == first.json()["item"]["id"]

    snapshot = client.get("/v1/pocket/queue", headers=headers).json()
    matches = [i for i in snapshot["items"] if i["id"] == first.json()["item"]["id"]]
    assert len(matches) == 1


def test_push_derived_key_dedups_same_content(client: TestClient, auth) -> None:
    """不带幂等键时按内容派生：同卡同站重复推仍去重。"""
    headers = auth()
    body = _push_body(cardId="same-card")
    body.pop("idempotencyKey", None)
    first = client.post("/v1/pocket/queue/push", json=body, headers=headers)
    second = client.post("/v1/pocket/queue/push", json=body, headers=headers)
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["idempotencyKey"] == first.json()["idempotencyKey"]


def test_push_same_card_different_target_not_deduped(client: TestClient, auth) -> None:
    """同一张卡推给两个站点是两件不同的待办——派生键必须区分目标站。"""
    headers = auth()
    a = client.post(
        "/v1/pocket/queue/push",
        json=_push_body(cardId="c1", targetStation="matrix-cross"),
        headers=headers,
    )
    b = client.post(
        "/v1/pocket/queue/push",
        json=_push_body(cardId="c1", targetStation="curvelab"),
        headers=headers,
    )
    assert a.status_code == 201 and b.status_code == 201
    assert a.json()["item"]["id"] != b.json()["item"]["id"]


# ================================================================== 队列：契约红线 422


def test_push_missing_verification_level_rejected(client: TestClient, auth) -> None:
    """锚点缺 verification_level → 422（虫洞 W1/枚举红线的入口版）。"""
    headers = auth()
    body = _push_body()
    body["evidenceAnchors"][0].pop("verification_level")
    response = client.post("/v1/pocket/queue/push", json=body, headers=headers)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation.failed"


def test_push_empty_evidence_rejected(client: TestClient, auth) -> None:
    """空锚点数组 → 422（min_length=1）。"""
    headers = auth()
    response = client.post(
        "/v1/pocket/queue/push", json=_push_body(evidenceAnchors=[]), headers=headers
    )
    assert response.status_code == 422, response.text


def test_push_whitespace_doi_rejected(client: TestClient, auth) -> None:
    """source_doi_or_url 为空白 → 422（校验器兜住 min_length 放过的空格串）。"""
    headers = auth()
    body = _push_body()
    body["evidenceAnchors"][0]["source_doi_or_url"] = "   "
    response = client.post("/v1/pocket/queue/push", json=body, headers=headers)
    assert response.status_code == 422, response.text


def test_push_bad_payload_type_rejected(client: TestClient, auth) -> None:
    """payload_type 不在闭枚举内 → 422（不得擅自扩展枚举）。"""
    headers = auth()
    response = client.post(
        "/v1/pocket/queue/push",
        json=_push_body(payloadType="not_a_real_type"),
        headers=headers,
    )
    assert response.status_code == 422, response.text


# ================================================================== 队列：状态机


def test_claim_then_done_full_cycle(client: TestClient, auth) -> None:
    headers = auth()
    item_id = client.post(
        "/v1/pocket/queue/push", json=_push_body(), headers=headers
    ).json()["item"]["id"]

    claimed = client.post(
        "/v1/pocket/queue/claim", json={"itemId": item_id}, headers=headers
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["item"]["status"] == "claimed"
    assert claimed.json()["claimedAt"]

    # 重复认领幂等，仍是 claimed 且不报错
    again = client.post(
        "/v1/pocket/queue/claim", json={"itemId": item_id}, headers=headers
    )
    assert again.status_code == 200
    assert again.json()["item"]["status"] == "claimed"

    done = client.post(
        "/v1/pocket/queue/done", json={"itemId": item_id}, headers=headers
    )
    assert done.status_code == 200, done.text
    assert done.json()["item"]["status"] == "done"


def test_pending_to_done_rejected(client: TestClient, auth) -> None:
    """pending 直接 done 被拒（409）——待办必须先被桌面认领。"""
    headers = auth()
    item_id = client.post(
        "/v1/pocket/queue/push", json=_push_body(), headers=headers
    ).json()["item"]["id"]
    response = client.post(
        "/v1/pocket/queue/done", json={"itemId": item_id}, headers=headers
    )
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "pocket.bad_transition"


def test_claim_after_done_rejected(client: TestClient, auth) -> None:
    """done 之后再 claim 被拒（终态不可回退认领）。"""
    headers = auth()
    item_id = client.post(
        "/v1/pocket/queue/push", json=_push_body(), headers=headers
    ).json()["item"]["id"]
    client.post("/v1/pocket/queue/claim", json={"itemId": item_id}, headers=headers)
    client.post("/v1/pocket/queue/done", json={"itemId": item_id}, headers=headers)
    response = client.post(
        "/v1/pocket/queue/claim", json={"itemId": item_id}, headers=headers
    )
    assert response.status_code == 409, response.text


def test_queue_snapshot_pending_count(client: TestClient, auth) -> None:
    headers = auth()
    for index in range(3):
        client.post(
            "/v1/pocket/queue/push",
            json=_push_body(cardId=f"c{index}", targetStation="matrix-cross"),
            headers=headers,
        )
    # 认领一个 → pending 少一
    snapshot = client.get("/v1/pocket/queue", headers=headers).json()
    assert snapshot["pendingCount"] == 3
    first_id = snapshot["items"][-1]["id"]
    client.post("/v1/pocket/queue/claim", json={"itemId": first_id}, headers=headers)
    after = client.get("/v1/pocket/queue", headers=headers).json()
    assert after["pendingCount"] == 2


def test_remove_item(client: TestClient, auth) -> None:
    headers = auth()
    item_id = client.post(
        "/v1/pocket/queue/push", json=_push_body(), headers=headers
    ).json()["item"]["id"]
    response = client.delete(f"/v1/pocket/queue?id={item_id}", headers=headers)
    assert response.status_code == 200, response.text
    snapshot = client.get("/v1/pocket/queue", headers=headers).json()
    assert all(i["id"] != item_id for i in snapshot["items"])


# ================================================================== 越权隔离


def test_queue_is_per_user(client: TestClient, auth) -> None:
    """Bob 看不到、也认领不了 Alice 的待办（跨用户一律 404，不泄漏存在性）。"""
    alice = auth(matrix_uid=ALICE)
    bob = auth(matrix_uid=BOB)
    item_id = client.post(
        "/v1/pocket/queue/push", json=_push_body(), headers=alice
    ).json()["item"]["id"]

    assert client.get("/v1/pocket/queue", headers=bob).json()["items"] == []
    response = client.post(
        "/v1/pocket/queue/claim", json={"itemId": item_id}, headers=bob
    )
    assert response.status_code == 404, response.text
    assert response.json()["code"] == "pocket.item_not_found"


def test_bad_item_id_is_404(client: TestClient, auth) -> None:
    """非法 UUID 也返回 404，而不是 500。"""
    headers = auth()
    response = client.post(
        "/v1/pocket/queue/claim", json={"itemId": "not-a-uuid"}, headers=headers
    )
    assert response.status_code == 404, response.text


# ================================================================== 早报


def test_morning_briefing_shape_and_origin_header(client: TestClient, auth) -> None:
    """无本人资产时回落演示语料，origin 头必须是 mock（ADR-09 不可静默降级）。"""
    headers = auth()
    response = client.get("/v1/pocket/morning", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["x-matrix-data-origin"] == "mock"
    body = response.json()
    assert len(body["cards"]) == 3
    assert body["cards"][0]["index"] == 1
    assert body["desktopQueueCount"] == 0
    for card in body["cards"]:
        assert card["evidenceAnchors"], "每张卡都至少一个证据锚点（W1）"


def test_morning_dismiss_marks_card_and_persists(client: TestClient, auth) -> None:
    """忽略幂等，且忽略状态跨刷新存活。"""
    headers = auth()
    cards = client.get("/v1/pocket/morning", headers=headers).json()["cards"]
    card_id = cards[0]["id"]

    first = client.post(
        "/v1/pocket/morning/dismiss", json={"cardId": card_id}, headers=headers
    )
    assert first.status_code == 200, first.text
    # 再忽略一次不报错
    client.post(
        "/v1/pocket/morning/dismiss", json={"cardId": card_id}, headers=headers
    )

    refreshed = client.get("/v1/pocket/morning", headers=headers).json()["cards"]
    dismissed = [c for c in refreshed if c["id"] == card_id]
    assert dismissed and dismissed[0]["dismissed"] is True


def test_card_ids_are_stable_within_a_day(client: TestClient, auth) -> None:
    """卡 id 必须可重算（否则忽略态第二天对不上）。"""
    headers = auth()
    a = [c["id"] for c in client.get("/v1/pocket/morning", headers=headers).json()["cards"]]
    b = [c["id"] for c in client.get("/v1/pocket/morning", headers=headers).json()["cards"]]
    assert a == b


def test_morning_uses_assets_when_present(client: TestClient, auth, make_asset) -> None:
    """本人资产够 3 条 → origin=live，卡片来自真实资产而非演示语料。"""
    headers = auth()
    for index in range(3):
        make_asset(headers, title=f"资产 {index}")
    response = client.get("/v1/pocket/morning", headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["x-matrix-data-origin"] == "live"


# ================================================================== 打卡


def test_checkin_seeds_goals_and_is_reversible(client: TestClient, auth) -> None:
    """首次 GET 播种目标；POST 打卡、DELETE 取消，视图对称可逆。"""
    headers = auth()
    goal = _one_goal(client, headers)

    done = client.post(
        "/v1/pocket/checkin",
        json={"goalId": goal["id"], "date": _today(), "done": True},
        headers=headers,
    )
    assert done.status_code == 200, done.text
    assert _goal_done(done.json(), goal["id"]) is True
    assert done.json()["streak"] >= 1

    undone = client.delete(
        f"/v1/pocket/checkin?goalId={goal['id']}&date={_today()}", headers=headers
    )
    assert undone.status_code == 200, undone.text
    assert _goal_done(undone.json(), goal["id"]) is False
    assert undone.json()["streak"] == 0


def test_checkin_streak_counts_consecutive_days(client: TestClient, auth) -> None:
    headers = auth()
    goal = _one_goal(client, headers)
    client.post(
        "/v1/pocket/checkin",
        json={"goalId": goal["id"], "date": _shift(-1), "done": True},
        headers=headers,
    )
    client.post(
        "/v1/pocket/checkin",
        json={"goalId": goal["id"], "date": _today(), "done": True},
        headers=headers,
    )
    day = client.get(f"/v1/pocket/checkin?day={_today()}", headers=headers).json()
    assert day["streak"] == 2


def test_checkin_streak_not_zeroed_before_first_checkin_today(
    client: TestClient, auth
) -> None:
    """今天还没打卡但从昨天往前连续：streak 不归零（08:00 打开不该看到 0）。"""
    headers = auth()
    goal = _one_goal(client, headers)
    client.post(
        "/v1/pocket/checkin",
        json={"goalId": goal["id"], "date": _shift(-1), "done": True},
        headers=headers,
    )
    day = client.get(f"/v1/pocket/checkin?day={_today()}", headers=headers).json()
    assert day["streak"] == 1


def test_checkin_streak_breaks_on_gap(client: TestClient, auth) -> None:
    """断签（前天打过、昨天没打）→ streak 归零。"""
    headers = auth()
    goal = _one_goal(client, headers)
    client.post(
        "/v1/pocket/checkin",
        json={"goalId": goal["id"], "date": _shift(-3), "done": True},
        headers=headers,
    )
    day = client.get(f"/v1/pocket/checkin?day={_today()}", headers=headers).json()
    assert day["streak"] == 0


def test_checkin_week_flags_len_seven(client: TestClient, auth) -> None:
    """近 7 天布尔（旧→新），打卡今天应点亮最后一格。"""
    headers = auth()
    goal = _one_goal(client, headers)
    client.post(
        "/v1/pocket/checkin",
        json={"goalId": goal["id"], "date": _today(), "done": True},
        headers=headers,
    )
    day = client.get("/v1/pocket/checkin", headers=headers).json()
    assert len(day["week"]) == 7
    assert day["week"][-1] is True
    assert day["termTarget"] >= 1


def test_checkin_duplicate_done_is_idempotent(client: TestClient, auth) -> None:
    """同一天同一目标重复打卡不产生第二条、不报错（DB 唯一约束兜底）。"""
    headers = auth()
    goal = _one_goal(client, headers)
    body = {"goalId": goal["id"], "date": _today(), "done": True}
    first = client.post("/v1/pocket/checkin", json=body, headers=headers)
    second = client.post("/v1/pocket/checkin", json=body, headers=headers)
    assert first.status_code == 200 and second.status_code == 200
    assert second.json()["streak"] == first.json()["streak"]


def test_checkin_bad_date_rejected(client: TestClient, auth) -> None:
    headers = auth()
    goal = _one_goal(client, headers)
    response = client.post(
        "/v1/pocket/checkin",
        json={"goalId": goal["id"], "date": "2026/10/20", "done": True},
        headers=headers,
    )
    assert response.status_code == 422, response.text


def test_checkin_unknown_goal_404(client: TestClient, auth) -> None:
    headers = auth()
    response = client.post(
        "/v1/pocket/checkin",
        json={"goalId": str(uuid.uuid4()), "date": _today(), "done": True},
        headers=headers,
    )
    assert response.status_code == 404, response.text


# ================================================================== 名片


def test_card_weakest_link(client: TestClient, auth, make_asset) -> None:
    """名片验真等级 = 最弱一环：掺一条预印本，整张名片不能是 A 级。"""
    headers = auth()
    make_asset(headers, verification_level="Level_A_Verified")
    make_asset(
        headers,
        verification_level="Level_B_Preprint",
        evidence_anchors=[
            {
                "source_doi_or_url": "https://arxiv.org/abs/2405.11234",
                "verification_level": "Level_B_Preprint",
            }
        ],
    )
    card = client.get("/v1/pocket/card", headers=headers).json()
    assert card["verificationLevel"] != "Level_A_Verified"
    assert card["matrixUid"] == ALICE
    assert card["qrPayload"].endswith(ALICE)


def test_card_empty_graph_still_200(client: TestClient, auth) -> None:
    """没有任何资产时，名片指标为 0 但仍 200（不假装成功，也不 500）。"""
    headers = auth()
    response = client.get("/v1/pocket/card", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["metrics"][0]["value"] == "0"


# ================================================================== 导师状态机


def test_mentor_board_seeded_and_origin(client: TestClient, auth) -> None:
    headers = auth()
    response = client.get("/v1/pocket/mentor", headers=headers)
    assert response.status_code == 200, response.text
    board = response.json()
    assert board["reminders"]
    # 演示播种 → origin 头标 mock
    assert response.headers["x-matrix-data-origin"] == "mock"


def test_mentor_ack(client: TestClient, auth) -> None:
    headers = auth()
    board = client.get("/v1/pocket/mentor", headers=headers).json()
    rid = board["reminders"][0]["id"]
    response = client.post(
        "/v1/pocket/mentor/ack", json={"reminderId": rid}, headers=headers
    )
    assert response.status_code == 200, response.text
    after = client.get("/v1/pocket/mentor", headers=headers).json()
    assert [r for r in after["reminders"] if r["id"] == rid][0]["acknowledged"] is True


def test_mentor_stage_advances_one_step(client: TestClient, auth) -> None:
    """email_read → interview_scheduled 合法；再跳 →joined 非法。"""
    headers = auth()
    board = client.get("/v1/pocket/mentor", headers=headers).json()
    rid = board["reminders"][0]["id"]
    ok = client.post(
        f"/v1/pocket/mentor/stage?reminderId={rid}&stage=interview_scheduled",
        headers=headers,
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["stage"] == "interview_scheduled"

    skip = client.post(
        f"/v1/pocket/mentor/stage?reminderId={rid}&stage=joined",
        headers=headers,
    )
    assert skip.status_code == 409, skip.text
    assert skip.json()["code"] == "pocket.bad_transition"


def test_mentor_stage_bad_stage_name(client: TestClient, auth) -> None:
    headers = auth()
    board = client.get("/v1/pocket/mentor", headers=headers).json()
    rid = board["reminders"][0]["id"]
    response = client.post(
        f"/v1/pocket/mentor/stage?reminderId={rid}&stage=not_a_stage", headers=headers
    )
    assert response.status_code == 422, response.text


# ================================================================== camelCase 契约


def test_responses_are_camel_case(client: TestClient, auth) -> None:
    """外层字段必须 camelCase——前端 types.ts 就长这样，snake 会直接渲染空白。"""
    headers = auth()
    item = client.post(
        "/v1/pocket/queue/push", json=_push_body(), headers=headers
    ).json()["item"]
    for key in (
        "targetStation",
        "desktopAction",
        "payloadType",
        "evidenceAnchors",
        "originRef",
        "createdAt",
    ):
        assert key in item, f"缺少 camelCase 键 {key}"
    # 嵌套锚点是 snake（虫洞契约原样）
    assert "source_doi_or_url" in item["evidenceAnchors"][0]
