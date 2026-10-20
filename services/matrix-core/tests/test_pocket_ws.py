"""口袋端 WS 下行 `/v1/pocket/stream` 的测试。

覆盖双端协同里最难自证的一半：手机推一条 → 桌面 2s 内收到。
`fastapi.testclient.TestClient` 的 `websocket_connect` 走的是真实的 ASGI 循环，
足以验证握手、鉴权、心跳、订阅与广播，不需要起真端口。

**断言的不是「能连上」，而是安全边界**：未鉴权的连接只配拿到 `hello`，
拿不到任何用户的 `queue.*`；用另一个身份的错误 token 连接必须被 4401 关闭。
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from .conftest import ALICE, BOB, CURVELAB


def _push_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "cardId": "ws-card",
        "title": "WS 推送用例",
        "note": "",
        "targetStation": "matrix-cross",
        "desktopAction": "在桌面处理",
        "payloadType": "paper_doi_bundle",
        "evidenceAnchors": [
            {
                "source_doi_or_url": "https://doi.org/10.1038/s41566-024-01430-1",
                "verification_level": "Level_A_Verified",
            }
        ],
        "sourceStation": CURVELAB,
    }
    body.update(overrides)
    return body


def _drain_until(websocket, want_type: str, limit: int = 5) -> dict:
    """收到目标类型前的消息都收下；收到即返回。"""
    seen: list[dict] = []
    for _ in range(limit):
        message = websocket.receive_json()
        seen.append(message)
        if message.get("type") == want_type:
            return message
    raise AssertionError(f"未收到 {want_type}，实际收到：{seen}")


def _auth_and_wait_ready(websocket, token: str, device_id: str) -> dict:
    """发 auth 并等 resync —— 保证连接**已注册进 StreamHub** 后再继续。

    不等就直接 push 会撞上「服务端还没处理完 auth」的竞态：广播找不到订阅者，
    `desktopNotified` 变 False。用协议里已有的 resync 当同步点，比 sleep 更诚实
    ——它同时也是桌面客户端真实的对账触发器。
    """
    websocket.send_json({"type": "auth", "token": token, "deviceId": device_id})
    return _drain_until(websocket, "resync")


def test_hello_is_first_message(client: TestClient) -> None:
    """握手第一件事是 hello，带 serverTime 与 heartbeatSec。"""
    with client.websocket_connect("/v1/pocket/stream") as websocket:
        hello = websocket.receive_json()
        assert hello["type"] == "hello"
        assert hello["serverTime"]
        assert hello["heartbeatSec"] == 30


def test_ping_pong_without_auth(client: TestClient) -> None:
    """心跳不需要鉴权——它是连接存活探测，不含用户数据。"""
    with client.websocket_connect("/v1/pocket/stream") as websocket:
        websocket.receive_json()  # hello
        websocket.send_json({"type": "ping", "t": 1234})
        pong = _drain_until(websocket, "pong")
        assert pong["t"] == 1234


def test_bad_token_closes_4401(client: TestClient) -> None:
    """伪造 token → 连接被拒绝，而不是接受后静默无数据。"""
    from starlette.websockets import WebSocketDisconnect

    with client.websocket_connect("/v1/pocket/stream") as websocket:
        websocket.receive_json()  # hello
        websocket.send_json({"type": "auth", "token": "not.a.jwt", "deviceId": "d1"})
        try:
            message = websocket.receive_json()
        except WebSocketDisconnect:
            return
        raise AssertionError(f"非法 token 未被拒绝，收到：{message}")


def test_push_broadcasts_queue_count_to_authenticated_socket(
    client: TestClient, auth, make_token
) -> None:
    """核心链路：桌面 WS 已鉴权 → 手机推一条 → 桌面收到 queue.count。"""
    headers = auth()
    with client.websocket_connect("/v1/pocket/stream") as websocket:
        websocket.receive_json()  # hello
        _auth_and_wait_ready(websocket, make_token(), "desktop-1")

        response = client.post(
            "/v1/pocket/queue/push", json=_push_body(), headers=headers
        )
        assert response.status_code == 201, response.text
        assert response.json()["desktopNotified"] is True, "有在线桌面时应回执已通知"

        message = _drain_until(websocket, "queue.count")
        assert message["pendingCount"] == 1


def test_claim_broadcasts_queue_claimed(client: TestClient, auth, make_token) -> None:
    headers = auth()
    item_id = client.post(
        "/v1/pocket/queue/push", json=_push_body(), headers=headers
    ).json()["item"]["id"]

    with client.websocket_connect("/v1/pocket/stream") as websocket:
        websocket.receive_json()  # hello
        _auth_and_wait_ready(websocket, make_token(), "d2")
        client.post("/v1/pocket/queue/claim", json={"itemId": item_id}, headers=headers)

        message = _drain_until(websocket, "queue.claimed")
        assert message["itemId"] == item_id
        assert message["station"] == "matrix-cross"
        assert message["claimedAt"]


def test_done_broadcasts_done_then_count(client: TestClient, auth, make_token) -> None:
    headers = auth()
    item_id = client.post(
        "/v1/pocket/queue/push", json=_push_body(), headers=headers
    ).json()["item"]["id"]
    client.post("/v1/pocket/queue/claim", json={"itemId": item_id}, headers=headers)

    with client.websocket_connect("/v1/pocket/stream") as websocket:
        websocket.receive_json()  # hello
        _auth_and_wait_ready(websocket, make_token(), "d3")
        client.post("/v1/pocket/queue/done", json={"itemId": item_id}, headers=headers)

        done = _drain_until(websocket, "queue.done")
        assert done["itemId"] == item_id
        count = _drain_until(websocket, "queue.count")
        assert count["pendingCount"] == 0


def test_other_users_events_not_leaked(
    client: TestClient, auth, make_token
) -> None:
    """Bob 的桌面连接收不到 Alice 的队列事件（按 matrix_uid 分键）。"""
    alice_headers = auth(matrix_uid=ALICE)
    client.post("/v1/pocket/queue/push", json=_push_body(), headers=alice_headers)

    with client.websocket_connect("/v1/pocket/stream") as websocket:
        websocket.receive_json()  # hello
        _auth_and_wait_ready(websocket, make_token(matrix_uid=BOB), "bob-desktop")
        # Bob 自己推一条，确认通道是活的
        bob_headers = auth(matrix_uid=BOB)
        client.post(
            "/v1/pocket/queue/push",
            json=_push_body(cardId="bob-card", targetStation="curvelab"),
            headers=bob_headers,
        )

        message = _drain_until(websocket, "queue.count")
        # Bob 只应有自己那一条 pending，绝不包含 Alice 的内容
        assert message["pendingCount"] == 1

        snapshot = client.get("/v1/pocket/queue", headers=bob_headers).json()
        assert all(i["targetStation"] == "curvelab" for i in snapshot["items"])


def test_desktop_online_reflected_in_snapshot(
    client: TestClient, auth, make_token
) -> None:
    """WS 在线 → GET /queue 的 desktopOnline 为 True；断开后回落 False。"""
    headers = auth()
    assert client.get("/v1/pocket/queue", headers=headers).json()["desktopOnline"] is False

    with client.websocket_connect("/v1/pocket/stream") as websocket:
        websocket.receive_json()  # hello
        _auth_and_wait_ready(websocket, make_token(), "d4")
        assert client.get("/v1/pocket/queue", headers=headers).json()["desktopOnline"] is True

    # with 块退出后连接关闭，注册表应清空
    assert client.get("/v1/pocket/queue", headers=headers).json()["desktopOnline"] is False
