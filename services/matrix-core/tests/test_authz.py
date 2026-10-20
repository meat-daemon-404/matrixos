"""P0 越权：跨用户读写 asset 必须被拒，跨站读写必须被拒。

三层防线（任一层失效这里都应该红）：
1. 验签 + jti 黑名单 + epoch（``IdentityDep``）；
2. scope 判定（``assert_can_read`` / ``assert_can_write``）；
3. 数据行过滤（``matrix_uid == 当前用户``）。

**跨用户返回 404 而不是 403 是刻意的**：资产 id 是 UUID，返回 403 等于承认
"这个 id 存在"。真正的 403 留给"你自己有身份，但在这个站没有权限"。
"""

from __future__ import annotations

import uuid

import pytest

from .conftest import ALICE, BOB, CAROL, CHART, CURVELAB, scopes


# ================================================================== 跨用户


def test_owner_can_read_own_asset(client, auth, make_asset) -> None:
    asset = make_asset(auth(matrix_uid=ALICE))
    response = client.get(f"/v1/assets/{asset['asset_id']}", headers=auth(matrix_uid=ALICE))
    assert response.status_code == 200
    assert response.json()["matrix_uid"] == ALICE


def test_other_user_cannot_read_asset(client, auth, make_asset) -> None:
    """**核心红线**：Bob 拿着完全合法的令牌，也读不到 Alice 的资产。"""
    asset = make_asset(auth(matrix_uid=ALICE))

    response = client.get(f"/v1/assets/{asset['asset_id']}", headers=auth(matrix_uid=BOB))

    assert response.status_code == 404
    assert response.json()["code"] == "asset.not_found"
    # 不泄漏存在性：错误体里不能出现资产标题等任何内容
    assert asset["title"] not in response.text


def test_other_user_cannot_patch_asset(client, auth, make_asset) -> None:
    asset = make_asset(auth(matrix_uid=ALICE), title="Alice 的原始标题")

    response = client.patch(
        f"/v1/assets/{asset['asset_id']}",
        json={"title": "被 Bob 篡改"},
        headers=auth(matrix_uid=BOB),
    )

    assert response.status_code == 404
    # 确认真的没写进去
    check = client.get(f"/v1/assets/{asset['asset_id']}", headers=auth(matrix_uid=ALICE))
    assert check.json()["title"] == "Alice 的原始标题"
    assert check.json()["version"] == 1


def test_other_user_cannot_delete_asset(client, auth, make_asset) -> None:
    asset = make_asset(auth(matrix_uid=ALICE))

    response = client.delete(
        f"/v1/assets/{asset['asset_id']}", headers=auth(matrix_uid=BOB)
    )

    assert response.status_code == 404
    # Alice 的资产还在
    assert client.get(
        f"/v1/assets/{asset['asset_id']}", headers=auth(matrix_uid=ALICE)
    ).status_code == 200


def test_list_only_returns_own_assets(client, auth, make_asset) -> None:
    make_asset(auth(matrix_uid=ALICE), title="Alice A")
    make_asset(auth(matrix_uid=ALICE), title="Alice B")
    make_asset(auth(matrix_uid=BOB), title="Bob A")

    alice_list = client.get("/v1/assets", headers=auth(matrix_uid=ALICE)).json()
    bob_list = client.get("/v1/assets", headers=auth(matrix_uid=BOB)).json()

    assert alice_list["total"] == 2
    assert {item["title"] for item in alice_list["items"]} == {"Alice A", "Alice B"}
    assert bob_list["total"] == 1
    assert {item["matrix_uid"] for item in alice_list["items"]} == {ALICE}


def test_search_never_returns_other_users_chunks(client, auth, make_asset) -> None:
    """检索是越权的经典漏点：必须"权限在候选集之前"。"""
    make_asset(
        auth(matrix_uid=ALICE),
        title="Alice 的双指数拟合结果",
        payload={"secret_marker": "alice-only-token-xyz"},
    )

    response = client.post(
        "/v1/assets/search",
        json={"query": "alice-only-token-xyz", "top_k": 10},
        headers=auth(matrix_uid=BOB),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["hits"] == []
    assert body["total_candidates"] == 0


def test_cross_user_edge_is_impossible(client, auth, make_asset) -> None:
    """Bob 不能把边指向 Alice 的资产（否则溯源就成了越权读通道）。"""
    alice_asset = make_asset(auth(matrix_uid=ALICE))
    bob_asset = make_asset(auth(matrix_uid=BOB), title="Bob 的图")

    response = client.post(
        f"/v1/assets/{bob_asset['asset_id']}/edges",
        json={"to_asset_id": alice_asset["asset_id"], "relation": "cites"},
        headers=auth(matrix_uid=BOB),
    )
    assert response.status_code == 404
    assert response.json()["code"] == "asset.not_found"


def test_infer_only_touches_own_assets(client, auth, make_asset) -> None:
    """边推断必须限定本人：Alice 与 Bob 有相同 DOI，也不该互连。"""
    shared_doi = {
        "source_doi_or_url": "https://doi.org/10.1234/shared",
        "verification_level": "Level_A_Verified",
    }
    make_asset(auth(matrix_uid=ALICE), evidence_anchors=[shared_doi])
    bob = make_asset(auth(matrix_uid=BOB), evidence_anchors=[shared_doi], title="Bob 同 DOI")

    response = client.post(
        "/v1/assets/graph/infer", json={"dry_run": False}, headers=auth(matrix_uid=BOB)
    )
    assert response.status_code == 200
    assert response.json()["scanned_assets"] == 1
    assert response.json()["created_edges"] == 0

    detail = client.get(f"/v1/assets/{bob['asset_id']}", headers=auth(matrix_uid=BOB)).json()
    assert detail["edges_out"] == []
    assert detail["edges_in"] == []


# ================================================================== 跨站（scope）


def test_write_without_write_scope_is_forbidden(client, auth) -> None:
    """有 read 但没有 write：写必须 403（"登录即可写"是明确禁止的）。"""
    response = client.post(
        "/v1/assets",
        json={"station_id": CURVELAB, "asset_type": "paper", "title": "x"},
        headers=auth(matrix_uid=ALICE, scope=scopes("read")),
    )
    assert response.status_code == 403
    assert response.json()["code"] == "asset.forbidden"


def test_read_other_station_without_scope_is_forbidden(client, auth, make_asset) -> None:
    """资产属于 curvelab，但令牌只有 chart-foundry 的权限 → 403。"""
    asset = make_asset(auth(matrix_uid=ALICE))

    response = client.get(
        f"/v1/assets/{asset['asset_id']}",
        headers=auth(matrix_uid=ALICE, scope=scopes("read", station=CHART)),
    )
    assert response.status_code == 403
    assert response.json()["code"] == "asset.forbidden"


def test_emit_scope_does_not_imply_write(client, auth) -> None:
    """``emit`` 是虫洞投送权限，不等于本地写权限——别把动词混为一谈。"""
    response = client.post(
        "/v1/assets",
        json={"station_id": CURVELAB, "asset_type": "paper", "title": "x"},
        headers=auth(matrix_uid=ALICE, scope=scopes("read", "emit")),
    )
    assert response.status_code == 403


def test_identity_without_scope_can_login_but_not_read(client, auth) -> None:
    """CAROL 存在但没有任何 scope：登录可行，读资产 403。"""
    response = client.get("/v1/assets", headers=auth(matrix_uid=CAROL, scope=[]))
    assert response.status_code == 403
    assert response.json()["code"] == "asset.forbidden"


def test_list_with_foreign_station_filter_is_forbidden(client, auth) -> None:
    response = client.get(
        "/v1/assets", params={"station_ids": [CHART]}, headers=auth(matrix_uid=ALICE)
    )
    assert response.status_code == 403


def test_search_with_foreign_station_filter_is_forbidden(client, auth) -> None:
    response = client.post(
        "/v1/assets/search",
        json={"query": "anything", "station_ids": [CHART]},
        headers=auth(matrix_uid=ALICE),
    )
    assert response.status_code == 403


def test_admin_scope_grants_all_stations(client, auth, make_asset) -> None:
    """``admin:*`` 是全量（仅运维账号）：跨站读取应放行。"""
    asset = make_asset(auth(matrix_uid=ALICE))

    response = client.get(
        f"/v1/assets/{asset['asset_id']}",
        headers=auth(matrix_uid=ALICE, scope=["admin:*"]),
    )
    assert response.status_code == 200


# ================================================================== 未认证


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/v1/assets"),
        ("get", f"/v1/assets/{uuid.uuid4()}"),
        ("post", "/v1/assets"),
        ("post", "/v1/assets/search"),
        ("post", "/v1/assets/graph/infer"),
        ("get", "/v1/wormhole/receipts"),
        ("get", "/v1/auth/userinfo"),
        ("post", "/v1/auth/logout"),
    ],
)
def test_protected_endpoints_require_token(client, method, path) -> None:
    response = getattr(client, method)(path)
    assert response.status_code == 401
    assert response.json()["code"] == "auth.login_required"


def test_malformed_authorization_header_is_rejected(client) -> None:
    for header in ("Token abc", "Bearer", "Bearer ", "NotBearer xyz"):
        response = client.get("/v1/assets", headers={"Authorization": header})
        assert response.status_code == 401, header


def test_garbage_bearer_token_is_rejected(client) -> None:
    response = client.get(
        "/v1/assets", headers={"Authorization": "Bearer not.a.jwt"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "auth.token_invalid"


def test_refresh_token_rejected_on_asset_endpoint(client, signer) -> None:
    """攻击：把 mx_rt 当 mx_at 用。"""
    refresh = signer.sign_refresh_token(
        matrix_uid=ALICE,
        jti=str(uuid.uuid4()),
        family_id=str(uuid.uuid4()),
        client_id=f"site:{CURVELAB}",
        scope=scopes("read", "write"),
    )
    response = client.get("/v1/assets", headers={"Authorization": f"Bearer {refresh}"})
    assert response.status_code == 401
    assert response.json()["code"] == "auth.token_type_mismatch"


# ================================================================== 输入校验


def test_asset_type_outside_enum_is_rejected(client, auth) -> None:
    response = client.post(
        "/v1/assets",
        json={"station_id": CURVELAB, "asset_type": "not_a_real_type", "title": "x"},
        headers=auth(matrix_uid=ALICE),
    )
    assert response.status_code == 422


def test_event_extra_field_is_rejected(client, auth) -> None:
    """``extra="forbid"``：不许偷偷塞契约外字段。"""
    response = client.post(
        "/v1/assets",
        json={
            "station_id": CURVELAB,
            "asset_type": "paper",
            "title": "x",
            "sneaky_field": True,
        },
        headers=auth(matrix_uid=ALICE),
    )
    assert response.status_code == 422


def test_unknown_asset_id_returns_404(client, auth) -> None:
    response = client.get(f"/v1/assets/{uuid.uuid4()}", headers=auth(matrix_uid=ALICE))
    assert response.status_code == 404


def test_non_uuid_asset_id_returns_404(client, auth) -> None:
    response = client.get("/v1/assets/not-a-uuid", headers=auth(matrix_uid=ALICE))
    assert response.status_code == 404


def test_optimistic_lock_conflict(client, auth, make_asset) -> None:
    asset = make_asset(auth(matrix_uid=ALICE))
    headers = auth(matrix_uid=ALICE)

    ok = client.patch(
        f"/v1/assets/{asset['asset_id']}",
        json={"title": "v2", "expected_version": 1},
        headers=headers,
    )
    assert ok.status_code == 200
    assert ok.json()["version"] == 2

    stale = client.patch(
        f"/v1/assets/{asset['asset_id']}",
        json={"title": "v3", "expected_version": 1},
        headers=headers,
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "asset.version_conflict"


# ================================================================== 错误体契约


def test_error_body_has_exactly_three_keys(client) -> None:
    """S1-06 验收：错误体恒为 ``{code, message, trace_id}``，不多不少。"""
    response = client.get("/v1/assets")
    assert response.status_code == 401
    assert set(response.json()) == {"code", "message", "trace_id"}


def test_trace_id_header_matches_body(client) -> None:
    response = client.get("/v1/assets")
    assert response.headers["X-Trace-Id"] == response.json()["trace_id"]


def test_inbound_trace_id_is_echoed(client) -> None:
    trace = str(uuid.uuid4())
    response = client.get("/v1/health", headers={"X-Trace-Id": trace})
    assert response.headers["X-Trace-Id"] == trace


def test_validation_errors_also_use_unified_body(client) -> None:
    response = client.post(
        "/v1/auth/introspect", json={"unexpected": "shape"}, headers={}
    )
    assert response.status_code == 422
    assert set(response.json()) == {"code", "message", "trace_id"}
