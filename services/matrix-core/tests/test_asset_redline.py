"""资产写入的合规红线回归测试。

背景（2026-10-20 实测发现）：
`AssetCreateRequest._level_consistency` 原本是个空壳 validator（只 `return value`），
导致 `POST /v1/assets` 传 `evidence_anchors: []` 仍能 201 成功。

这与设计文档的硬约束冲突：
- `specs/contracts/wormhole-envelope.schema.json` 规定 `evidence_anchors` 的
  `minItems: 1`
- ADR-000 把「每个流转数据必须能溯源到 DOI + 页码 + bbox」定为合规红线
- v3 的核心卖点是「从契约层杜绝大模型学术幻觉」

虫洞端点至少有 `evidence_count >= 1` 的字段级约束，资产端点却完全没有——
这是更危险的缺口，因为资产是**长期沉淀**的那一侧。

本文件锁死修复后的行为，防止有人「为了跑通 demo」把校验去掉。
"""

from __future__ import annotations

import pytest

from tests.conftest import ALICE, CURVELAB


# ─────────────────────────────────────────────────────────────
# 红线：证据锚点不可为空
# ─────────────────────────────────────────────────────────────


def test_empty_evidence_anchors_is_rejected(client, auth) -> None:
    """空 evidence_anchors 必须被拒（422），不得入库。"""
    response = client.post(
        "/v1/assets",
        json={
            "station_id": CURVELAB,
            "asset_type": "fit_result",
            "title": "没有证据的拟合结果",
            "payload": {"r2": 0.98},
            "evidence_anchors": [],
        },
        headers=auth(matrix_uid=ALICE),
    )

    assert response.status_code == 422, (
        "空 evidence_anchors 被接受了——合规红线失守。"
        "每个科研资产必须至少 1 条可溯源锚点。"
    )
    body = response.json()
    assert body["code"] == "validation.failed"
    # 错误消息要明确指出是 evidence_anchors 的问题，便于调用方定位
    assert "evidence_anchors" in str(body)


def test_missing_evidence_anchors_field_is_rejected(client, auth) -> None:
    """整个字段缺失也应被拒（默认空列表同样违反红线）。"""
    response = client.post(
        "/v1/assets",
        json={
            "station_id": CURVELAB,
            "asset_type": "fit_result",
            "title": "压根没传证据字段",
            "payload": {"r2": 0.98},
        },
        headers=auth(matrix_uid=ALICE),
    )

    assert response.status_code == 422


def test_single_anchor_is_accepted(client, auth) -> None:
    """恰好 1 条锚点是合法的（minItems: 1，不是 2）。"""
    response = client.post(
        "/v1/assets",
        json={
            "station_id": CURVELAB,
            "asset_type": "fit_result",
            "title": "只有一条证据",
            "payload": {"r2": 0.98},
            "evidence_anchors": [
                {
                    "source_doi_or_url": "10.1103/PhysRevB.99.014301",
                    "verification_level": "Level_A_Verified",
                }
            ],
        },
        headers=auth(matrix_uid=ALICE),
    )

    assert response.status_code == 201, response.text
    body = response.json()
    # 响应字段名是 evidence_anchors（列表），不是 evidence_count
    assert len(body["evidence_anchors"]) == 1
    assert body["evidence_anchors"][0]["source_doi_or_url"] == "10.1103/PhysRevB.99.014301"


def test_anchor_requires_source_doi(client, auth) -> None:
    """锚点必须有 source_doi_or_url（哪怕只有 1 条也不能是空串）。"""
    response = client.post(
        "/v1/assets",
        json={
            "station_id": CURVELAB,
            "asset_type": "fit_result",
            "title": "锚点缺 DOI",
            "evidence_anchors": [
                {"source_doi_or_url": "", "verification_level": "Level_A_Verified"}
            ],
        },
        headers=auth(matrix_uid=ALICE),
    )

    assert response.status_code == 422


def test_anchor_requires_verification_level(client, auth) -> None:
    """锚点必须有 verification_level（三档枚举之一）。"""
    response = client.post(
        "/v1/assets",
        json={
            "station_id": CURVELAB,
            "asset_type": "fit_result",
            "title": "锚点缺等级",
            "evidence_anchors": [{"source_doi_or_url": "10.1103/PhysRevB.99.014301"}],
        },
        headers=auth(matrix_uid=ALICE),
    )

    assert response.status_code == 422


def test_invalid_verification_level_rejected(client, auth) -> None:
    """verification_level 必须是三档枚举，不接受任意字符串。"""
    response = client.post(
        "/v1/assets",
        json={
            "station_id": CURVELAB,
            "asset_type": "fit_result",
            "title": "非法等级",
            "evidence_anchors": [
                {
                    "source_doi_or_url": "10.1103/PhysRevB.99.014301",
                    "verification_level": "Level_Z_随便写的",
                }
            ],
        },
        headers=auth(matrix_uid=ALICE),
    )

    assert response.status_code == 422


def test_bbox_must_be_four_numbers(client, auth) -> None:
    """bbox 若提供必须是 4 个数字（PDF 坐标框 x0,y0,x1,y1）。"""
    response = client.post(
        "/v1/assets",
        json={
            "station_id": CURVELAB,
            "asset_type": "fit_result",
            "title": "bbox 长度不对",
            "evidence_anchors": [
                {
                    "source_doi_or_url": "10.1103/PhysRevB.99.014301",
                    "verification_level": "Level_A_Verified",
                    "bbox": [1.0, 2.0],
                }
            ],
        },
        headers=auth(matrix_uid=ALICE),
    )

    assert response.status_code == 422
