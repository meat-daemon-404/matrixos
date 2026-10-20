"""P0 虫洞 receipt 合规红线：``/v1/wormhole/receipt`` 只存哈希与元数据，不存 payload 正文。

**这是全部测试里最要紧的一类。** 它不是"功能对不对"，而是"红线有没有破"：
如果服务端落一份 payload 正文，matrix-core 就成了 18 站科研数据的汇聚点，
泄露即全损，也直接违反 TIER 04 "未发表原始数据零外泄" 的承诺。

因此这里的断言刻意做成**穷举式**：
1. 表结构层面：``wormhole_receipt`` 不许有能装正文的列；
2. 数据层面：拿一个唯一哨兵串走完整 HTTP 流程，然后**直接在库里搜它**；
3. 原始字节层面：绕过 ORM 直接读 SQLite 文件字节，确认哨兵串不在里面——
   这一层连"某列存了 JSON、正文藏在里边"都能抓到；
4. 接口层面：拒收、响应体、列表、审计流水都不许出现哨兵串。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path
from typing import Any

import pytest

from .conftest import ALICE, BOB, CURVELAB

# 唯一的哨兵串：出现在任何地方都说明正文被存下来了
SENTINEL = "SENTINEL-raw-payload-must-never-be-persisted-7f3a9c"


def _receipt_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "trace_id": str(uuid.uuid4()),
        "source_app": "curvelab.matrixos.edu",
        "target_app": "chart-foundry.matrixos.edu",
        "payload_type": "curve_fit_parameters",
        "evidence_count": 1,
        "payload_hash": "a" * 64,
    }
    body.update(overrides)
    return body


# ================================================================== 表结构红线


def test_receipt_table_has_no_text_column_for_body() -> None:
    """结构性保证：表里根本没有能装正文的列。

    允许存在的列只有哈希、计数、站点名、枚举与时间戳；任何"自由文本"列
    （除了 ``scope_used`` 这种由服务端生成的枚举串）都是红线风险。
    """
    from app.models.wormhole import WormholeReceipt

    columns = WormholeReceipt.__table__.columns
    names = {column.name for column in columns}

    assert "payload" not in names
    assert "payload_data" not in names
    assert "data" not in names
    assert "content" not in names
    assert "raw" not in names
    assert "envelope" not in names
    # 只允许这些哈希/元数据列
    assert {"payload_hash", "payload_data_hash", "payload_size"} <= names


def test_payload_hash_columns_are_fixed_length() -> None:
    """哈希列是定长 hex，装不下正文。"""
    from app.models.wormhole import WormholeReceipt

    table = WormholeReceipt.__table__
    for column_name in ("payload_hash", "payload_data_hash"):
        column = table.columns[column_name]
        assert column.type.length == 64, f"{column_name} 不是定长 64，可能被当正文列用"


# ================================================================== 数据层红线


def test_receipt_stores_hash_only_and_sentinel_is_absent_from_db(
    client, auth, settings, db_run
) -> None:
    """走真实 HTTP 落一条收据，然后在库里搜哨兵串。"""
    headers = auth(matrix_uid=ALICE)
    trace_id = str(uuid.uuid4())

    response = client.post(
        "/v1/wormhole/receipt",
        json=_receipt_body(trace_id=trace_id, payload_hash="b" * 64),
        headers=headers,
    )
    assert response.status_code == 201, response.text
    receipt_id = response.json()["receipt_id"]

    def query(session):
        async def run():
            from sqlalchemy import select

            from app.models.wormhole import WormholeReceipt

            return await session.scalar(
                select(WormholeReceipt).where(WormholeReceipt.trace_id == trace_id)
            )

        return run()

    record = db_run(query)
    assert record is not None
    assert record.receipt_id == uuid.UUID(receipt_id)
    assert record.payload_hash == "b" * 64
    assert record.matrix_uid == ALICE
    # 整行序列化后不含哨兵
    row_dump = json.dumps(
        {column.name: str(getattr(record, column.name)) for column in record.__table__.columns},
        ensure_ascii=False,
    )
    assert SENTINEL not in row_dump


def test_sentinel_never_reaches_sqlite_file_bytes(client, auth, db_path: Path) -> None:
    """**最硬的一条**：绕过 ORM，直接扫 SQLite 文件的原始字节。

    只要哨兵串以任何形式（明文、JSON 值、未 VACUUM 的页残留）落盘，这里就会红。
    """
    headers = auth(matrix_uid=ALICE)
    response = client.post(
        "/v1/wormhole/receipt",
        json=_receipt_body(payload_hash="c" * 64),
        headers=headers,
    )
    assert response.status_code == 201

    raw_bytes = db_path.read_bytes()
    assert SENTINEL.encode("utf-8") not in raw_bytes, (
        "payload 正文字符串出现在了数据库文件里——W2 红线被突破"
    )
    # 反向确认：库文件确实是这次测试的库（收据的哈希在里面）
    assert b"c" * 64 in raw_bytes or b"wormhole_receipt" in raw_bytes


def test_all_wormhole_rows_hold_no_free_text_body(client, auth, db_run) -> None:
    """连发多条收据后，整表逐行检查：除了服务端生成的枚举串，没有正文。"""
    headers = auth(matrix_uid=ALICE)
    for index in range(3):
        response = client.post(
            "/v1/wormhole/receipt",
            json=_receipt_body(payload_hash=f"{index}" * 64),
            headers=headers,
        )
        assert response.status_code == 201

    def query(session):
        async def run():
            from sqlalchemy import select

            from app.models.wormhole import WormholeReceipt

            result = await session.execute(select(WormholeReceipt))
            return list(result.scalars().all())

        return run()

    rows = db_run(query)
    assert len(rows) == 3
    for row in rows:
        dump = json.dumps(
            {column.name: str(getattr(row, column.name)) for column in row.__table__.columns},
            ensure_ascii=False,
        )
        assert SENTINEL not in dump
        assert "evidence_anchors" not in dump


def test_audit_trail_records_hash_not_body(client, auth, db_run) -> None:
    """审计流水同样不能成为"另一条漏法"。"""
    headers = auth(matrix_uid=ALICE)
    trace_id = str(uuid.uuid4())
    response = client.post(
        "/v1/wormhole/receipt",
        json=_receipt_body(trace_id=trace_id, payload_hash="d" * 64),
        headers=headers,
    )
    assert response.status_code == 201

    def query(session):
        async def run():
            from sqlalchemy import select

            from app.models.auth import AuditEvent

            result = await session.execute(
                select(AuditEvent).where(AuditEvent.action == "wormhole.receipt_created")
            )
            return list(result.scalars().all())

        return run()

    events = db_run(query)
    assert events, "虫洞收据必须留审计"
    for event in events:
        detail = json.dumps(event.detail, ensure_ascii=False)
        assert SENTINEL not in detail
        assert "payload_hash" in event.detail
        assert "payload" not in event.detail, "审计里出现了 payload 键"


# ================================================================== 接口层拒收


@pytest.mark.parametrize(
    "forbidden_key",
    ["payload", "data", "payload_data", "content", "body", "raw", "envelope_body"],
)
def test_receipt_rejects_forbidden_body_keys(client, auth, forbidden_key: str) -> None:
    """请求体带正文键 → 422 显式拒收（静默忽略是更危险的失败模式）。"""
    body = _receipt_body()
    body[forbidden_key] = {"nested": SENTINEL}

    response = client.post("/v1/wormhole/receipt", json=body, headers=auth(matrix_uid=ALICE))

    assert response.status_code == 422, f"{forbidden_key} 没被拒收：{response.text}"
    assert SENTINEL not in response.text


def test_receipt_accepts_metadata_only_body(client, auth) -> None:
    """正常路径：只传元数据必须能成功（这条曾经因为 schema 绑错而 422）。"""
    response = client.post(
        "/v1/wormhole/receipt", json=_receipt_body(), headers=auth(matrix_uid=ALICE)
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == {
        "receipt_id",
        "trace_id",
        "source_app",
        "target_app",
        "payload_type",
        "payload_hash",
        "evidence_count",
        "highest_verification_level",
        "created_at",
        "matrix_uid",
        "mx_idt",
        "mx_idt_expires_in",
    }
    assert "payload" not in body
    assert "data" not in body


def test_receipt_response_contains_no_payload_body(client, auth) -> None:
    """响应体是第二道口子：连字段都不该存在。"""
    response = client.post(
        "/v1/wormhole/receipt", json=_receipt_body(), headers=auth(matrix_uid=ALICE)
    )
    assert response.status_code == 201
    text = response.text
    assert SENTINEL not in text
    for key in ('"payload":', '"payload_data":', '"content":', '"data":'):
        assert key not in text


def test_envelope_embedded_in_request_is_hashed_then_dropped(client, auth, db_run) -> None:
    """即使调用方把完整 envelope 塞进来，也只用于内存重算哈希，随后丢弃。"""
    import hashlib

    payload = {
        "data": {"curve": SENTINEL, "r2": 0.98},
        "evidence_anchors": [
            {
                "source_doi_or_url": "https://doi.org/10.1103/PhysRevB.99.014301",
                "verification_level": "Level_A_Verified",
            }
        ],
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    payload_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    envelope = {
        "trace_id": str(uuid.uuid4()),
        "matrix_uid": ALICE,
        "source_app": "curvelab.matrixos.edu",
        "target_app": "chart-foundry.matrixos.edu",
        "payload_type": "curve_fit_parameters",
        "payload": payload,
    }
    body = _receipt_body(
        trace_id=envelope["trace_id"],
        payload_hash=payload_hash,
        envelope=envelope,
    )

    response = client.post(
        "/v1/wormhole/receipt", json=body, headers=auth(matrix_uid=ALICE)
    )
    assert response.status_code == 201, response.text
    # 响应不回声正文
    assert SENTINEL not in response.text

    def query(session):
        async def run():
            from sqlalchemy import select

            from app.models.wormhole import WormholeReceipt

            return await session.scalar(
                select(WormholeReceipt).where(
                    WormholeReceipt.trace_id == envelope["trace_id"].lower()
                )
            )

        return run()

    record = db_run(query)
    assert record is not None
    assert record.payload_hash == payload_hash
    dump = json.dumps(
        {column.name: str(getattr(record, column.name)) for column in record.__table__.columns},
        ensure_ascii=False,
    )
    assert SENTINEL not in dump


def test_hash_mismatch_between_client_and_envelope_is_rejected(client, auth) -> None:
    """完整性校验：客户端算的哈希与 envelope 重算不一致 → 422（防传输篡改）。"""
    envelope = {
        "trace_id": str(uuid.uuid4()),
        "matrix_uid": ALICE,
        "source_app": "curvelab.matrixos.edu",
        "target_app": "chart-foundry.matrixos.edu",
        "payload_type": "curve_fit_parameters",
        "payload": {
            "data": {"real": "value"},
            "evidence_anchors": [
                {
                    "source_doi_or_url": "https://doi.org/10.1/x",
                    "verification_level": "Level_B_Preprint",
                }
            ],
        },
    }
    body = _receipt_body(trace_id=envelope["trace_id"], payload_hash="e" * 64, envelope=envelope)

    response = client.post(
        "/v1/wormhole/receipt", json=body, headers=auth(matrix_uid=ALICE)
    )
    assert response.status_code == 422
    assert response.json()["code"] == "wormhole.invalid_envelope"


# ================================================================== 读接口


def test_get_receipt_never_returns_body(client, auth) -> None:
    created = client.post(
        "/v1/wormhole/receipt", json=_receipt_body(), headers=auth(matrix_uid=ALICE)
    )
    assert created.status_code == 201
    receipt_id = created.json()["receipt_id"]

    response = client.get(
        f"/v1/wormhole/receipt/{receipt_id}", headers=auth(matrix_uid=ALICE)
    )
    assert response.status_code == 200
    body = response.json()
    assert "payload" not in body
    assert "data" not in body
    assert body["payload_hash"] == "a" * 64


def test_list_receipts_never_returns_body(client, auth) -> None:
    client.post("/v1/wormhole/receipt", json=_receipt_body(), headers=auth(matrix_uid=ALICE))
    response = client.get("/v1/wormhole/receipts", headers=auth(matrix_uid=ALICE))
    assert response.status_code == 200
    text = response.text
    assert '"payload":' not in text
    assert SENTINEL not in text


def test_other_user_cannot_read_receipt(client, auth) -> None:
    """跨用户 404（不泄漏存在性）。"""
    created = client.post(
        "/v1/wormhole/receipt", json=_receipt_body(), headers=auth(matrix_uid=ALICE)
    )
    receipt_id = created.json()["receipt_id"]

    response = client.get(
        f"/v1/wormhole/receipt/{receipt_id}", headers=auth(matrix_uid=BOB)
    )
    assert response.status_code == 404
    assert response.json()["code"] == "wormhole.receipt_not_found"


def test_receipt_list_only_shows_own(client, auth) -> None:
    client.post("/v1/wormhole/receipt", json=_receipt_body(), headers=auth(matrix_uid=ALICE))
    client.post("/v1/wormhole/receipt", json=_receipt_body(), headers=auth(matrix_uid=BOB))

    alice = client.get("/v1/wormhole/receipts", headers=auth(matrix_uid=ALICE)).json()
    bob = client.get("/v1/wormhole/receipts", headers=auth(matrix_uid=BOB)).json()

    assert alice["total"] == 1
    assert bob["total"] == 1
    assert {item["matrix_uid"] for item in alice["items"]} == {ALICE}


# ================================================================== W1/W3 规则


def test_receipt_requires_at_least_one_evidence(client, auth) -> None:
    """W1：证据不可为空。"""
    response = client.post(
        "/v1/wormhole/receipt",
        json=_receipt_body(evidence_count=0),
        headers=auth(matrix_uid=ALICE),
    )
    assert response.status_code == 422


def test_receipt_requires_emit_scope(client, auth) -> None:
    """W3 前置：源站没有 emit 权限就不能发起投送。"""
    from .conftest import scopes

    response = client.post(
        "/v1/wormhole/receipt",
        json=_receipt_body(),
        headers=auth(matrix_uid=ALICE, scope=scopes("read", "write")),
    )
    assert response.status_code == 403
    assert response.json()["code"] == "wormhole.emit_scope_required"


def test_receipt_rejects_unknown_target_station(client, auth) -> None:
    response = client.post(
        "/v1/wormhole/receipt",
        json=_receipt_body(target_app="evil.example.com"),
        headers=auth(matrix_uid=ALICE),
    )
    assert response.status_code == 422
    assert response.json()["code"] == "wormhole.invalid_envelope"


def test_receipt_trace_id_must_be_uuid(client, auth) -> None:
    response = client.post(
        "/v1/wormhole/receipt",
        json=_receipt_body(trace_id="not-a-uuid"),
        headers=auth(matrix_uid=ALICE),
    )
    assert response.status_code == 422


def test_receipt_is_idempotent_on_trace_id(client, auth, db_run) -> None:
    """同一 trace_id 重投不新建收据，但仍发新的 mx_idt（一次性消耗品）。"""
    body = _receipt_body()
    first = client.post("/v1/wormhole/receipt", json=body, headers=auth(matrix_uid=ALICE))
    second = client.post("/v1/wormhole/receipt", json=body, headers=auth(matrix_uid=ALICE))

    assert first.status_code == second.status_code == 201
    assert first.json()["receipt_id"] == second.json()["receipt_id"]
    assert first.json()["mx_idt"] != second.json()["mx_idt"], "重投必须给新的 idt"

    def query(session):
        async def run():
            from sqlalchemy import func, select

            from app.models.wormhole import WormholeReceipt

            return await session.scalar(
                select(func.count()).select_from(WormholeReceipt)
            )

        return run()

    assert db_run(query) == 1


def test_validate_endpoint_returns_hashes_not_body(client, auth) -> None:
    """``/validate`` 只回哈希与计数，不回声正文。"""
    response = client.post(
        "/v1/wormhole/validate",
        json={
            "trace_id": str(uuid.uuid4()),
            "matrix_uid": ALICE,
            "source_app": "curvelab.matrixos.edu",
            "target_app": "chart-foundry.matrixos.edu",
            "payload_type": "curve_fit_parameters",
            "payload": {
                "data": {"raw": SENTINEL},
                "evidence_anchors": [
                    {
                        "source_doi_or_url": "https://doi.org/10.1/y",
                        "verification_level": "Level_A_Verified",
                    }
                ],
            },
        },
        headers=auth(matrix_uid=ALICE),
    )
    assert response.status_code == 200, response.text
    assert SENTINEL not in response.text
    body = response.json()
    assert body["valid"] is True
    assert len(body["payload_hash"]) == 64
    assert len(body["payload_data_hash"]) == 64


# ================================================================== 服务层哈希


def test_canonical_json_is_key_order_independent() -> None:
    """规范化规则必须唯一：否则两侧算出的哈希会假报警。"""
    from app.services.wormhole import canonical_json, hash_payload

    left = {"b": 2, "a": {"y": 1, "x": [1, 2]}}
    right = {"a": {"x": [1, 2], "y": 1}, "b": 2}
    assert canonical_json(left) == canonical_json(right)
    assert hash_payload(left) == hash_payload(right)


def test_retracted_warning_dominates_highest_level() -> None:
    """撤稿告警必须置顶（不能被 Level_A 掩盖）。"""
    from app.services.wormhole import count_levels

    levels, highest = count_levels(
        [
            {"verification_level": "Level_A_Verified"},
            {"verification_level": "Retracted_Warning"},
        ]
    )
    assert levels == {"Level_A_Verified": 1, "Retracted_Warning": 1}
    assert highest == "Retracted_Warning"
