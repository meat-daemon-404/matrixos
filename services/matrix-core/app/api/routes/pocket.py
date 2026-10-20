"""``/v1/pocket/*`` 路由（WBS S2-17~S2-20 的服务端半边）。

端点清单（与 ``apps/wechat-pocket/miniprogram/api/index.ts`` 的表格一一对应）：

| 方法 | 路径 | 语义 |
| :--- | :--- | :--- |
| GET  | `/pocket/morning`        | 当日三卡早报 |
| POST | `/pocket/morning/dismiss`| 忽略一张卡（幂等） |
| GET  | `/pocket/checkin`        | 当日打卡视图（?date=YYYY-MM-DD 可查历史） |
| POST | `/pocket/checkin`        | 打卡 |
| DELETE | `/pocket/checkin`      | 取消打卡（?goalId=&date=，与 POST 对称可逆） |
| GET  | `/pocket/mentor`         | 进组看板 |
| POST | `/pocket/mentor/ack`     | 确认提醒 |
| POST | `/pocket/mentor/stage`   | 状态机前进一步（桌面/lab-kanban 用） |
| GET  | `/pocket/card`           | 全息学术名片（验真等级=最弱一环） |
| GET  | `/pocket/queue`          | 桌面队列快照 |
| POST | `/pocket/queue/push`     | 手机推入待办（幂等 + 落虫洞收据） |
| POST | `/pocket/queue/claim`    | 桌面认领（2s 规则的服务端落点） |
| POST | `/pocket/queue/done`     | 桌面完成（claimed→done，pending→done 拒绝） |
| DELETE | `/pocket/queue`        | 移除条目（?id=） |
| WS   | `/pocket/stream`         | 下行通道：hello → auth → ping/pong → queue.* 广播 |

查询参数用 **camelCase**（`goalId` / `cardId` / `reminderId`）：这是小程序请求层
（`http.del(path, {query:{goalId,date}})`）已经在发的键名，服务端迁就客户端，
而不是让 20 个页面跟着改。

鉴权：所有 HTTP 端点走 ``IdentityDep``（验签 + 黑名单 + epoch + 激活态四道），
与 assets/wormhole 同一口径。WS 无法复用 HTTP 依赖，在握手后第一条 ``auth``
消息里做同等的四道校验，未通过即关闭（4401）——**签名有效 ≠ 身份有效**
这条规矩不因传输协议打折。
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Query, Response, WebSocket, WebSocketDisconnect, status

from app.api.deps import SessionDep, SettingsDep, SignerDep
from app.api.security import IdentityDep
from app.core.clock import now
from app.core.errors import ErrorCode, MatrixError
from app.core.security.tokens import TokenError
from app.schemas.pocket import (
    AcademicCard,
    CheckinDay,
    CheckinRequest,
    MentorAckRequest,
    MentorBoard,
    MentorReminder,
    MorningBriefing,
    MorningDismissRequest,
    QueueItemRefRequest,
    QueuePushRequest,
    QueuePushResult,
    QueueSnapshot,
    QueueStateResult,
)
from app.services import auth as auth_service
from app.services import pocket as pocket_service
from app.services.pocket import STAGE_LABELS, hub

router = APIRouter(prefix="/pocket", tags=["pocket"])

HEARTBEAT_SEC = 30

# 数据来源标记头。客户端（core/request.ts 与 hub 的 queue-client）据此
# 在 UI 上显示「演示数据 / 缓存」角标——ADR-09 要求降级不可静默。
DATA_ORIGIN_HEADER = "x-matrix-data-origin"

_DateQuery = Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")]


def _parse_date(value: str | None) -> date:
    if not value:
        return pocket_service.today()
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise MatrixError(ErrorCode.VALIDATION_FAILED, "date 必须是 YYYY-MM-DD") from None


# ------------------------------------------------------------------ 早报


@router.get("/morning", summary="当日三卡早报", response_model=MorningBriefing)
async def get_morning(
    response: Response,
    session: SessionDep,
    identity: IdentityDep,
) -> MorningBriefing:
    briefing, origin = await pocket_service.build_briefing(
        session, matrix_uid=identity.matrix_uid
    )
    await session.commit()
    # 演示回落必须可被客户端识别（x-matrix-data-origin），UI 才能显示「演示数据」角标
    response.headers[DATA_ORIGIN_HEADER] = origin
    return briefing


@router.post("/morning/dismiss", summary="忽略早报卡片（幂等）")
async def dismiss_morning(
    session: SessionDep,
    identity: IdentityDep,
    payload: MorningDismissRequest,
) -> dict[str, bool]:
    await pocket_service.dismiss_card(
        session, matrix_uid=identity.matrix_uid, card_id=payload.card_id
    )
    await session.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 打卡


@router.get("/checkin", summary="当日打卡视图", response_model=CheckinDay)
async def get_checkin(
    session: SessionDep,
    identity: IdentityDep,
    day: _DateQuery = None,
) -> CheckinDay:
    view = await pocket_service.get_checkin(
        session, matrix_uid=identity.matrix_uid, day=_parse_date(day)
    )
    await session.commit()
    return view


@router.post("/checkin", summary="打卡", response_model=CheckinDay)
async def post_checkin(
    session: SessionDep,
    identity: IdentityDep,
    payload: CheckinRequest,
) -> CheckinDay:
    view = await pocket_service.set_checkin(
        session,
        matrix_uid=identity.matrix_uid,
        goal_id=payload.goal_id,
        day=_parse_date(payload.date),
        done=payload.done,
    )
    await session.commit()
    return view


@router.delete("/checkin", summary="取消打卡（与 POST 对称可逆）", response_model=CheckinDay)
async def delete_checkin(
    session: SessionDep,
    identity: IdentityDep,
    goal_id: Annotated[str, Query(alias="goalId")],
    day: Annotated[str, Query(alias="date", pattern=r"^\d{4}-\d{2}-\d{2}$")],
) -> CheckinDay:
    view = await pocket_service.set_checkin(
        session,
        matrix_uid=identity.matrix_uid,
        goal_id=goal_id,
        day=_parse_date(day),
        done=False,
    )
    await session.commit()
    return view


# ------------------------------------------------------------------ 进组提醒


@router.get("/mentor", summary="进组看板", response_model=MentorBoard)
async def get_mentor(
    response: Response,
    session: SessionDep,
    identity: IdentityDep,
) -> MentorBoard:
    board, origin = await pocket_service.get_mentor_board(
        session, matrix_uid=identity.matrix_uid
    )
    await session.commit()
    # 播种演示提醒同样必须显式可见——否则用户把演示导师当成真实进组进度
    response.headers[DATA_ORIGIN_HEADER] = origin
    return board


@router.post("/mentor/ack", summary="确认提醒（不再重复强提醒）")
async def ack_mentor(
    session: SessionDep,
    identity: IdentityDep,
    payload: MentorAckRequest,
) -> dict[str, bool]:
    await pocket_service.acknowledge_mentor(
        session, matrix_uid=identity.matrix_uid, reminder_id=payload.reminder_id
    )
    await session.commit()
    return {"ok": True}


@router.post(
    "/mentor/stage",
    summary="推进进组状态机（只允许前进一步）",
    response_model=MentorReminder,
)
async def advance_mentor_stage(
    session: SessionDep,
    identity: IdentityDep,
    reminder_id: Annotated[str, Query(alias="reminderId")],
    stage: Annotated[str, Query()],
) -> MentorReminder:
    out = await pocket_service.advance_stage(
        session, matrix_uid=identity.matrix_uid, reminder_id=reminder_id, stage=stage
    )
    await session.commit()
    await hub.broadcast(
        identity.matrix_uid,
        {
            "type": "mentor.stage",
            "reminderId": str(out.id),
            "stage": out.stage,
            "stageLabel": STAGE_LABELS.get(out.stage, out.stage),
        },
    )
    return out


# ------------------------------------------------------------------ 名片


@router.get("/card", summary="全息学术名片（验真等级=最弱一环）", response_model=AcademicCard)
async def get_card(
    response: Response,
    session: SessionDep,
    identity: IdentityDep,
) -> AcademicCard:
    card, origin = await pocket_service.build_card(
        session, matrix_uid=identity.matrix_uid
    )
    await session.commit()
    response.headers[DATA_ORIGIN_HEADER] = origin
    return card


# ------------------------------------------------------------------ 桌面队列


@router.get("/queue", summary="桌面队列快照", response_model=QueueSnapshot)
async def get_queue(
    session: SessionDep,
    identity: IdentityDep,
) -> QueueSnapshot:
    snapshot = await pocket_service.get_queue(
        session, matrix_uid=identity.matrix_uid
    )
    return snapshot


@router.post(
    "/queue/push",
    summary="推入桌面待办（幂等；落虫洞收据，不含正文）",
    response_model=QueuePushResult,
    status_code=status.HTTP_201_CREATED,
)
async def push_queue(
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    signer: SignerDep,
    identity: IdentityDep,
    payload: QueuePushRequest,
) -> QueuePushResult:
    item, receipt_id, key, deduplicated = await pocket_service.push_queue(
        session,
        settings=settings,
        signer=signer,
        matrix_uid=identity.matrix_uid,
        scope=identity.scope,
        station_id=identity.station_id,
        request=payload,
    )
    await session.commit()
    # 重复推送返回 200 而不是 201：状态码本身就是「有没有新建」的诚实信号，
    # 比在响应体里塞一个 dedup 布尔更不容易被调用方忽略。
    if deduplicated:
        response.status_code = status.HTTP_200_OK

    # 2s 规则的服务端半边：提交后立即向该身份的在线桌面广播计数变化。
    # 顺序是刻意的——**先 commit 再广播**，反过来的话桌面收到事件去拉取时
    # 读到的还是旧快照，「2s 内出现」会变成偶然的时序竞速。
    count = await pocket_service.pending_count(session, matrix_uid=identity.matrix_uid)
    notified = await hub.broadcast(
        identity.matrix_uid, {"type": "queue.count", "pendingCount": count}
    )
    return QueuePushResult(
        item=item,
        receiptId=receipt_id,
        desktopNotified=notified > 0,
        idempotencyKey=key,
    )


@router.post("/queue/claim", summary="桌面认领（pending→claimed，重复认领幂等）", response_model=QueueStateResult)
async def claim_queue(
    session: SessionDep,
    identity: IdentityDep,
    payload: QueueItemRefRequest,
) -> QueueStateResult:
    item, claimed_at = await pocket_service.claim_item(
        session, matrix_uid=identity.matrix_uid, item_id=payload.item_id
    )
    await session.commit()
    await hub.broadcast(
        identity.matrix_uid,
        {
            "type": "queue.claimed",
            "itemId": item.id,
            "claimedAt": claimed_at,
            "station": item.target_station,
        },
    )
    return QueueStateResult(item=item, claimedAt=claimed_at)


@router.post("/queue/done", summary="桌面完成（claimed→done；pending 直跳被拒）", response_model=QueueStateResult)
async def done_queue(
    session: SessionDep,
    identity: IdentityDep,
    payload: QueueItemRefRequest,
) -> QueueStateResult:
    item, done_at = await pocket_service.mark_done(
        session, matrix_uid=identity.matrix_uid, item_id=payload.item_id
    )
    await session.commit()
    count = await pocket_service.pending_count(session, matrix_uid=identity.matrix_uid)
    await hub.broadcast(
        identity.matrix_uid, {"type": "queue.done", "itemId": item.id, "doneAt": done_at}
    )
    await hub.broadcast(identity.matrix_uid, {"type": "queue.count", "pendingCount": count})
    return QueueStateResult(item=item, doneAt=done_at)


@router.delete("/queue", summary="移除待办", response_model=dict)
async def remove_queue(
    session: SessionDep,
    identity: IdentityDep,
    item_id: Annotated[str, Query(alias="id")],
) -> dict[str, bool]:
    await pocket_service.remove_item(
        session, matrix_uid=identity.matrix_uid, item_id=item_id
    )
    await session.commit()
    count = await pocket_service.pending_count(session, matrix_uid=identity.matrix_uid)
    await hub.broadcast(identity.matrix_uid, {"type": "queue.count", "pendingCount": count})
    return {"ok": True}


# ------------------------------------------------------------------ WS 下行


@router.websocket("/stream")
async def pocket_stream(websocket: WebSocket) -> None:
    """下行通道：`hello → auth → ping/pong → queue.* / mentor.* / briefing.ready`。

    协议与 ``types.ts`` 的 ``WsServerMessage`` / ``WsClientMessage`` 严格一致。
    未鉴权连接只收到 `hello`；`auth` 校验四道（验签/黑名单/epoch/激活态）后
    才登记进 :class:`StreamHub`。鉴权失败以 4401 关闭——不是 1008 之类的
    通用码，客户端据此区分「凭证问题需要重登」与「网络问题需要重连」。
    """
    await websocket.accept()
    matrix_uid: str | None = None
    try:
        await websocket.send_json(
            {
                "type": "hello",
                "serverTime": now().isoformat(),
                "heartbeatSec": HEARTBEAT_SEC,
            }
        )

        while True:
            message = await websocket.receive_json()
            kind = message.get("type")

            if kind == "auth":
                token = str(message.get("token") or "")
                uid = await _authenticate_socket(websocket, token)
                if uid is None:
                    await websocket.close(code=4401)
                    return
                if matrix_uid is not None:
                    hub.unregister(matrix_uid, websocket)
                matrix_uid = uid
                hub.register(uid, websocket)
                # 鉴权成功后立刻要求客户端全量对账：连接建立与第一次推送之间必然存在
                # 事件空窗（这条连接刚注册，之前的广播与它无关）。不下发 resync，
                # 桌面就会显示一个「连上了但队列是空的」的假状态。
                await websocket.send_json(
                    {"type": "resync", "reason": "authenticated"}
                )
                continue

            if kind == "ping":
                await websocket.send_json({"type": "pong", "t": message.get("t", 0)})
                continue

            if kind == "subscribe":
                # 订阅按身份分键已经足够细（一个用户一类通道）；
                # topics 收下但不建第二级索引——那是等有真实需求再做的扩展点。
                continue

    except WebSocketDisconnect:
        pass
    finally:
        if matrix_uid is not None:
            hub.unregister(matrix_uid, websocket)


async def _authenticate_socket(websocket: WebSocket, token: str) -> str | None:
    """WS 版的 IdentityDep：与 HTTP 完全相同的四道校验，任一不过返回 None。

    复用 `app.state` 里 lifespan 已建好的 KeyStore 与 Database——不在这里
    `KeyStore(...).load(create_if_missing=True)`：WS 鉴权绝不能有「缺密钥就
    顺手生成一把」的路径，那会掩盖装配错误并让多副本 kid 漂移。
    """
    if not token:
        return None
    from app.core.security.tokens import TokenSigner

    settings = websocket.app.state.settings
    try:
        signer = TokenSigner(settings=settings, key_store=websocket.app.state.key_store)
        claims = signer.verify(token, expected_typ="mx_at")
    except (TokenError, AttributeError, RuntimeError):
        return None

    database = websocket.app.state.database
    try:
        async with database.session() as session:
            try:
                user = await auth_service.assert_access_token_live(session, claims)
            except MatrixError:
                return None
    except Exception:  # noqa: BLE001 - 库不可用时宁可断流，不能放行未校验身份
        return None
    return user.matrix_uid
