"""口袋端业务逻辑（`/v1/pocket/*` 的服务端半边）。

四条双端协同链路的真实实现，取代此前纯前端 mock：

1. **早报**（`build_briefing`）：优先从本人资产图谱出题；无资产时回落演示语料。
   回落**不静默**——返回值带 `origin`，路由层写进 `x-matrix-data-origin` 响应头，
   与 ADR-09「降级必须在 UI 上显式可见」的要求一致。
2. **打卡**（`get_checkin`）：目标与打卡事实分表，streak 按「有打卡的去重日期」倒推，
   跨周与断签的边界由 `test_pocket_checkin.py` 钉住。
3. **导师状态机**（`advance_stage`）：五态只能前进一步，非法跃迁 409。
4. **桌面队列**（`push_queue` / `claim` / `mark_done`）：幂等靠数据库唯一约束，
   投送落**虫洞收据**（只存哈希与元数据，W2 铁律）。

WS 下行（`StreamHub`）刻意做成**进程内单例**：广播按 `matrix_uid` 分键，
未鉴权的连接收不到任何用户数据。多副本部署时这里需要换成 Redis pub/sub——
那是一个明确的、写在文档里的待办，不是被遗忘的 bug。
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import ensure_utc, now
from app.core.config import Settings
from app.core.errors import ErrorCode, MatrixError
from app.core.security.tokens import TokenSigner
from app.models.assets import AssetNode
from app.models.pocket import (
    TERM_TARGET_DAYS,
    CheckinRecord,
    MentorReminder,
    MicroGoal,
    MorningDismissal,
    QueueItem,
)
from app.schemas.pocket import (
    AcademicCard,
    CardEvidence,
    CardMetric,
    CheckinDay,
    MicroGoal as MicroGoalOut,
    MentorBoard,
    MentorReminder as MentorReminderOut,
    MorningBriefing,
    MorningCard,
    QueueItem as QueueItemOut,
    QueuePushRequest,
    QueueSnapshot,
)
from app.schemas.wormhole import EvidenceAnchor
from app.services import audit
from app.services import wormhole as wormhole_service

# ------------------------------------------------------------------ 常量

# 名片二维码落地页（与 microsite-17 evidence-cv 的验真入口同源）
CARD_LANDING_BASE = "https://evidence-cv.matrixos.edu/c/"

# 首次读取时播种的默认微目标：口袋端 08:00 场景的最小可用集
DEFAULT_GOALS: tuple[tuple[str, str, str, str], ...] = (
    ("读 2 篇光电文献并做笔记", "study", "2 篇", "精读并沉淀到 Matrix-Cross"),
    ("跑完一组衰减拟合", "research", "1 组", "晚 20:00 电脑端 CurveLab 跑完"),
    ("推演一封套磁信", "desktop", "1 封", "电脑端打开 cold-email 推演器"),
)

STAGE_ORDER: tuple[str, ...] = (
    "email_sent",
    "email_read",
    "interview_scheduled",
    "interview_passed",
    "joined",
)

STAGE_LABELS: dict[str, str] = {
    "email_sent": "已发信",
    "email_read": "已读",
    "interview_scheduled": "待面试",
    "interview_passed": "面试通过",
    "joined": "已进组",
}

# 演示语料：无本人资产时的早报来源。锚点必须是可判真伪的引用，
# 编造 DOI 会直接违反「不可编造证据」的项目红线（见 S3-MS07 验收）。
DEMO_CORPUS: tuple[dict[str, Any], ...] = (
    {
        "source": "Nature Photonics",
        "title": "非富铅卤化物钙钛矿的近红外发射",
        "summary": "PCE 提升与稳定性数据完整，可对照本人的衰减拟合",
        "heat": 88,
        "payload_type": "paper_doi_bundle",
        "target_station": "matrix-cross",
        "desktop_action": "把这篇加进对比矩阵",
        "fit_note": "与你正在跑的 01-05 号衰减样本同体系",
        "metrics": [{"label": "EQE", "value": "28.4%"}],
        "anchors": [
            {
                "source_doi_or_url": "https://doi.org/10.1038/s41566-024-01430-1",
                "verification_level": "Level_A_Verified",
                "pdf_page": 3,
                "bbox": [72.0, 210.5, 540.0, 268.0],
            }
        ],
    },
    {
        "source": "arXiv",
        "title": "光电探测器暗电流噪声建模新方法",
        "summary": "双时间常数模型，正好覆盖你的拟合口径",
        "heat": 74,
        "payload_type": "curve_fit_parameters",
        "target_station": "curvelab",
        "desktop_action": "在 CurveLab 里比对 τ1/τ2",
        "fit_note": "预印本，结论待复核，先当线索用",
        "metrics": [{"label": "模型", "value": "double-exp"}],
        "anchors": [
            {
                "source_doi_or_url": "https://arxiv.org/abs/2405.11234",
                "verification_level": "Level_B_Preprint",
            }
        ],
    },
    {
        "source": "Crossref",
        "title": "撤稿观察：某钙钛矿稳定性系列论文存疑",
        "summary": "同体系论文须核查数据重复，引用前先避雷",
        "heat": 61,
        "payload_type": "paper_doi_bundle",
        "target_station": "retract-radar",
        "desktop_action": "扫一遍你引用的同系列论文",
        "fit_note": "风险信号，不是结论，先标警示",
        "metrics": [{"label": "涉及论文", "value": "3 篇"}],
        "anchors": [
            {
                "source_doi_or_url": "https://pubpeer.com/search?q=perovskite%20stability",
                "verification_level": "Retracted_Warning",
            }
        ],
    },
)


def _iso(moment: Any) -> str:
    if moment is None:
        return ""
    if isinstance(moment, str):
        return moment
    return ensure_utc(moment).isoformat()


def today() -> date:
    return now().date()


def _date_key(day: date) -> str:
    return day.isoformat()


# ------------------------------------------------------------------ 演示数据播种
#
# 这些函数写的是真实表行（不是内存假数据），所以「演示」只体现在 origin 标记上：
# 首次访问会落库，之后每次读到的都是同一份可继续编辑的台账。
# GET 会写库是刻意的取舍：口袋端的目标是冷启动即可用，
# 让用户先手动「初始化」一次才能打卡是更差的体验。


async def _seed_goals(session: AsyncSession, matrix_uid: str) -> None:
    existing = await session.scalar(
        select(func.count()).select_from(MicroGoal).where(MicroGoal.matrix_uid == matrix_uid)
    )
    if existing:
        return
    for title, kind, target, note in DEFAULT_GOALS:
        session.add(
            MicroGoal(
                matrix_uid=matrix_uid,
                title=title,
                kind=kind,
                target=target,
                note=note,
            )
        )
    await session.flush()


async def _seed_mentor(session: AsyncSession, matrix_uid: str) -> bool:
    """播种一条演示提醒。返回 True 表示**本次真的播了演示数据**（用于标记 origin）。"""
    existing = await session.scalar(
        select(func.count())
        .select_from(MentorReminder)
        .where(MentorReminder.matrix_uid == matrix_uid)
    )
    if existing:
        return False
    starts = now() + timedelta(hours=24)
    session.add(
        MentorReminder(
            matrix_uid=matrix_uid,
            mentor_name="王教授",
            mentor_title="研究员 / 博导",
            lab="光电集成实验室",
            stage="email_read",
            starts_at=starts,
            location="主楼 A305（线上腾讯会议备用）",
            read_receipt=True,
            read_at=now() - timedelta(hours=6),
            acknowledged=False,
            match_score=86,
            evidence_anchors=[
                {
                    "source_doi_or_url": "https://doi.org/10.1038/s41566-024-01430-1",
                    "verification_level": "Level_A_Verified",
                }
            ],
            outline=[
                {"page": 1, "title": "我是谁", "points": ["专业排名", "光电方向经历"]},
                {"page": 2, "title": "我做过什么", "points": ["大创课题", "CurveLab 拟合结果"]},
                {"page": 3, "title": "我想做什么", "points": ["进组计划", "可投入时间"]},
            ],
        )
    )
    await session.flush()
    return True


# ------------------------------------------------------------------ 1. 早报


def _card_id(matrix_uid: str, briefing_day: date, index: int) -> str:
    """确定性卡片 id：`uid + 日期 + 序号`。

    必须可重算——否则「已忽略」第二天无法对应同一张卡，去重就失效了。
    取 sha256 前 16 位十六进制：够短、够唯一，且不含 uid 明文。
    """
    raw = f"{matrix_uid}|{_date_key(briefing_day)}|{index}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _cards_from_assets(
    nodes: list[AssetNode], briefing_day: date, matrix_uid: str
) -> list[dict[str, Any]]:
    """把本人资产转成早报卡（取最近 3 条）。"""
    cards: list[dict[str, Any]] = []
    for node in nodes[:3]:
        payload = node.payload if isinstance(node.payload, dict) else {}
        anchors = [
            anchor
            for anchor in (node.evidence_anchors or [])
            if isinstance(anchor, dict) and anchor.get("source_doi_or_url")
        ]
        if not anchors:
            # W1：没有证据锚点的资产不进早报（宁可少一张卡，也不投无证据的信息）
            continue
        cards.append(
            {
                "source": node.station_id,
                "title": node.title or "未命名资产",
                "summary": str(payload.get("summary", ""))[:120] or node.asset_type,
                "heat": int(payload.get("heat", 60)),
                "payload_type": payload.get("payload_type", "paper_doi_bundle"),
                "target_station": str(payload.get("target_station", node.station_id)),
                "desktop_action": str(payload.get("desktop_action", "在电脑端继续处理")),
                "fit_note": str(payload.get("fit_note", "")),
                "metrics": [
                    {"label": str(k), "value": str(v)}
                    for k, v in list(payload.items())[:2]
                    if isinstance(v, (str, int, float))
                ],
                "anchors": anchors,
                "published_at": _iso(node.created_at),
            }
        )
    return cards


async def build_briefing(
    session: AsyncSession, *, matrix_uid: str, day: date | None = None
) -> tuple[MorningBriefing, str]:
    """合成当日三卡早报。返回 `(briefing, origin)`，origin ∈ live | mock。

    `origin` 直接进 `x-matrix-data-origin` 响应头，所以取值必须是
    `types.ts` 的 `DataOrigin` 联合成员（live/mock/cache/local）——
    自造一个 "demo" 会让前端的类型收窄失效，角标永远渲染不出来。
    """
    briefing_day = day or today()
    nodes = list(
        await session.scalars(
            select(AssetNode)
            .where(AssetNode.matrix_uid == matrix_uid)
            .order_by(AssetNode.created_at.desc())
            .limit(3)
        )
    )
    origin = "live"
    raw_cards = _cards_from_assets(nodes, briefing_day, matrix_uid)
    if len(raw_cards) < 3:
        origin = "mock"
        raw_cards = [dict(item) for item in DEMO_CORPUS]

    dismissed_rows = list(
        await session.scalars(
            select(MorningDismissal).where(MorningDismissal.matrix_uid == matrix_uid)
        )
    )
    dismissed_ids = {row.card_id for row in dismissed_rows}

    cards: list[MorningCard] = []
    for index, raw in enumerate(raw_cards[:3], start=1):
        payload_type = raw.get("payload_type", "paper_doi_bundle")
        if payload_type not in (
            "paper_doi_bundle",
            "comparison_matrix_row",
            "curve_fit_parameters",
            "mentor_match_card",
            "verified_cv_evidence",
        ):
            payload_type = "paper_doi_bundle"
        try:
            anchors = [EvidenceAnchor(**anchor) for anchor in raw["anchors"]]
        except Exception:  # noqa: BLE001 - 语料或资产脏数据不应让整份早报 500
            continue
        cards.append(
            MorningCard(
                id=_card_id(matrix_uid, briefing_day, index),
                index=index,
                station=f"{raw['source']}.matrixos.edu"
                if "." not in raw["source"]
                else raw["source"],
                source=raw["source"],
                title=raw["title"],
                summary=raw["summary"],
                heat=max(0, min(100, int(raw.get("heat", 50)))),
                metrics=list(raw.get("metrics", []))[:3],
                fit_note=raw.get("fit_note", ""),
                payload_type=payload_type,  # type: ignore[arg-type]
                target_station=raw["target_station"],
                desktop_action=raw.get("desktop_action", ""),
                evidence_anchors=anchors,
                published_at=raw.get("published_at") or _iso(now()),
                dismissed=(_card_id(matrix_uid, briefing_day, index) in dismissed_ids),
            )
        )

    pending = await session.scalar(
        select(func.count())
        .select_from(QueueItem)
        .where(QueueItem.matrix_uid == matrix_uid, QueueItem.status == "pending")
    )

    briefing = MorningBriefing(
        briefingDate=_date_key(briefing_day),
        generatedAt=_iso(now()),
        keywords=["光电探测", "钙钛矿稳定性", "衰减拟合"],
        cards=cards,
        desktopQueueCount=int(pending or 0),
    )
    return briefing, origin


async def dismiss_card(session: AsyncSession, *, matrix_uid: str, card_id: str) -> None:
    """忽略一张卡（幂等：重复忽略不报错、不产生第二行）。"""
    existing = await session.get(MorningDismissal, (matrix_uid, card_id))
    if existing is not None:
        return
    session.add(MorningDismissal(matrix_uid=matrix_uid, card_id=card_id))
    await session.flush()


# ------------------------------------------------------------------ 2. 打卡


def _week_flags(done_dates: set[str], today: date) -> list[bool]:
    """近 7 天（旧→新）是否打卡——至少一个目标完成即算该日打卡。"""
    flags: list[bool] = []
    for offset in range(6, -1, -1):
        flags.append(_date_key(today - timedelta(days=offset)) in done_dates)
    return flags


def _streak(done_dates: set[str], today: date) -> int:
    """连续打卡天数。

    语义取舍：今天还没打卡时，**从昨天往回数**且不把 streak 归零
    （否则早上 08:00 打开小程序会看到「连续 0 天」，与用户直觉相悖）；
    断签（昨天也没打）才归零。
    """
    if _date_key(today) in done_dates:
        cursor = today
    elif _date_key(today - timedelta(days=1)) in done_dates:
        cursor = today - timedelta(days=1)
    else:
        return 0
    streak = 0
    while _date_key(cursor) in done_dates:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


async def get_checkin(
    session: AsyncSession, *, matrix_uid: str, day: date | None = None
) -> CheckinDay:
    """当日打卡视图（含 streak / 近 7 天 / 学期累计）。首次访问播种默认目标。"""
    checkin_day = day or today()
    await _seed_goals(session, matrix_uid)

    goals = list(
        await session.scalars(
            select(MicroGoal)
            .where(MicroGoal.matrix_uid == matrix_uid)
            .order_by(MicroGoal.created_at.asc())
        )
    )
    records = list(
        await session.scalars(
            select(CheckinRecord).where(
                CheckinRecord.matrix_uid == matrix_uid,
                CheckinRecord.checkin_date <= _date_key(checkin_day),
            )
        )
    )
    done_by_goal: dict[str, set[str]] = {}
    for record in records:
        done_by_goal.setdefault(str(record.goal_id), set()).add(record.checkin_date)

    goal_day = _date_key(checkin_day)
    out_goals = [
        MicroGoalOut(
            id=str(goal.goal_id),
            title=goal.title,
            note=goal.note,
            kind=goal.kind,  # type: ignore[arg-type]
            target=goal.target,
            done=goal_day in done_by_goal.get(str(goal.goal_id), set()),
            done_at=None,
        )
        for goal in goals
    ]

    done_dates = {record.checkin_date for record in records}
    return CheckinDay(
        date=goal_day,
        goals=out_goals,
        streak=_streak(done_dates, checkin_day),
        week=_week_flags(done_dates, checkin_day),
        term_days=len(done_dates),
        term_target=TERM_TARGET_DAYS,
    )


async def set_checkin(
    session: AsyncSession, *, matrix_uid: str, goal_id: str, day: date, done: bool
) -> CheckinDay:
    """打卡 / 取消打卡。POST 与 DELETE 共用此路径，语义完全对称可逆。"""
    goal = await session.get(MicroGoal, _as_uuid(goal_id))
    if goal is None or goal.matrix_uid != matrix_uid:
        raise MatrixError(ErrorCode.NOT_FOUND, "目标不存在")

    date_key = _date_key(day)
    existing = await session.scalar(
        select(CheckinRecord).where(
            CheckinRecord.goal_id == goal.goal_id,
            CheckinRecord.checkin_date == date_key,
        )
    )
    if done and existing is None:
        session.add(
            CheckinRecord(
                goal_id=goal.goal_id,
                matrix_uid=matrix_uid,
                checkin_date=date_key,
                done_at=now(),
            )
        )
        await session.flush()
    elif not done and existing is not None:
        await session.delete(existing)
        await session.flush()

    return await get_checkin(session, matrix_uid=matrix_uid, day=day)


# ------------------------------------------------------------------ 3. 导师状态机


def _reminder_out(row: MentorReminder) -> MentorReminderOut:
    return MentorReminderOut(
        id=str(row.reminder_id),
        mentorName=row.mentor_name,
        mentorTitle=row.mentor_title,
        lab=row.lab,
        stage=row.stage,  # type: ignore[arg-type]
        stageLabel=STAGE_LABELS.get(row.stage, row.stage),
        startsAt=_iso(row.starts_at),
        location=row.location,
        readReceipt=bool(row.read_receipt),
        readAt=_iso(row.read_at) if row.read_at else None,
        acknowledged=bool(row.acknowledged),
        outline=list(row.outline or []),
        matchScore=int(row.match_score or 0),
        evidence_anchors=[
            EvidenceAnchor(**anchor) for anchor in (row.evidence_anchors or []) if isinstance(anchor, dict)
        ],
    )


async def get_mentor_board(
    session: AsyncSession, *, matrix_uid: str
) -> tuple[MentorBoard, str]:
    """进组看板。返回 `(board, origin)`。"""
    seeded_demo = await _seed_mentor(session, matrix_uid)
    rows = list(
        await session.scalars(
            select(MentorReminder)
            .where(MentorReminder.matrix_uid == matrix_uid)
            .order_by(MentorReminder.starts_at.asc().nullslast())
        )
    )
    reminders = [_reminder_out(row) for row in rows]
    next_events = sorted(
        (item.starts_at for item in reminders if item.starts_at and not item.acknowledged)
    )
    # origin 只看**本次是否真的播种了演示数据**——比对名字既脆弱又会把用户后来
    # 真的联系了一位「王教授」的情况误标成演示。
    origin = "mock" if seeded_demo else "live"
    return (
        MentorBoard(
            reminders=reminders,
            nextEventAt=next_events[0] if next_events else "",
            syncedAt=_iso(now()),
        ),
        origin,
    )


async def acknowledge_mentor(
    session: AsyncSession, *, matrix_uid: str, reminder_id: str
) -> MentorReminderOut:
    """确认提醒（避免重复强提醒）。只改 acknowledged，不动状态机。"""
    row = await session.get(MentorReminder, _as_uuid(reminder_id))
    if row is None or row.matrix_uid != matrix_uid:
        raise MatrixError(ErrorCode.POCKET_ITEM_NOT_FOUND, "提醒不存在")
    row.acknowledged = True
    await session.flush()
    return _reminder_out(row)


async def advance_stage(
    session: AsyncSession,
    *,
    matrix_uid: str,
    reminder_id: str,
    stage: str,
) -> MentorReminderOut:
    """状态机推进：只允许前进一步（`已发信→已读→待面试→已进组` 不可非法跃迁）。"""
    row = await session.get(MentorReminder, _as_uuid(reminder_id))
    if row is None or row.matrix_uid != matrix_uid:
        raise MatrixError(ErrorCode.POCKET_ITEM_NOT_FOUND, "提醒不存在")
    if stage not in STAGE_ORDER:
        raise MatrixError(ErrorCode.VALIDATION_FAILED, f"未知阶段：{stage}")

    current = STAGE_ORDER.index(row.stage) if row.stage in STAGE_ORDER else 0
    target = STAGE_ORDER.index(stage)
    if target != current + 1:
        raise MatrixError(
            ErrorCode.POCKET_BAD_TRANSITION,
            f"阶段只能前进一步：{row.stage} → {STAGE_ORDER[current + 1] if current + 1 < len(STAGE_ORDER) else '（终态）'}，"
            f"收到 {stage}",
            log_extra={"current": row.stage, "requested": stage},
        )
    row.stage = stage
    if stage == "email_read":
        row.read_receipt = True
        row.read_at = now()
    await session.flush()
    return _reminder_out(row)


# ------------------------------------------------------------------ 4. 名片


_VERIFICATION_RANK: dict[str, int] = {
    "Level_A_Verified": 3,
    "Level_B_Preprint": 2,
    "Retracted_Warning": 1,
}


async def build_card(session: AsyncSession, *, matrix_uid: str) -> tuple[AcademicCard, str]:
    """全息学术名片：指标与证据全部来自本人资产，**验真等级取最弱一环**。

    「最弱一环」是刻意的：名片上只要有一条证据是预印本或有撤稿警示，
    整张名片就不能标 A 级——否则名片就成了对下游（导师/雇主）的误导。
    """
    from app.models.auth import MatrixUser

    user = await session.scalar(
        select(MatrixUser).where(MatrixUser.matrix_uid == matrix_uid)
    )
    nodes = list(
        await session.scalars(
            select(AssetNode)
            .where(AssetNode.matrix_uid == matrix_uid)
            .order_by(AssetNode.created_at.desc())
            .limit(50)
        )
    )

    evidences: list[CardEvidence] = []
    worst = "Level_A_Verified"
    for node in nodes:
        for anchor in node.evidence_anchors or []:
            if not isinstance(anchor, dict):
                continue
            level = anchor.get("verification_level", "Level_B_Preprint")
            if _VERIFICATION_RANK.get(level, 0) < _VERIFICATION_RANK.get(worst, 3):
                worst = level
            ref = str(anchor.get("source_doi_or_url", ""))
            if not ref:
                continue
            kind = "github" if "github.com" in ref else "doi"
            evidences.append(
                CardEvidence(
                    kind=kind,  # type: ignore[arg-type]
                    label=node.title or node.asset_type,
                    ref=ref,
                    verification=level,  # type: ignore[arg-type]
                    verified_note="已验真" if level == "Level_A_Verified" else None,
                )
            )
        if len(evidences) >= 12:
            break

    stations = {node.station_id for node in nodes}
    done_dates = set(await list_checkin_dates(session, matrix_uid=matrix_uid))
    metrics = [
        CardMetric(label="资产条目", value=str(len(nodes)), hint="来自数字孪生图谱"),
        CardMetric(label="覆盖站点", value=str(len(stations))),
        CardMetric(label="连续打卡", value=str(_streak(done_dates, today()))),
    ]

    card = AcademicCard(
        matrixUid=matrix_uid,
        displayName=(user.display_name if user else matrix_uid) or matrix_uid,
        subtitle="光电方向本科生 / 大创负责人",
        school="试点高校",
        major="光电信息科学与工程",
        grade="2024 级",
        qrPayload=f"{CARD_LANDING_BASE}{matrix_uid}",
        metrics=metrics,
        evidences=evidences[:12],
        verificationLevel=worst,  # type: ignore[assignment]
        updatedAt=_iso(now()),
    )
    return card, ("live" if nodes else "mock")


def _streak_from_records(session: AsyncSession, matrix_uid: str) -> int:
    """名片里的 streak 占位——真实值由 `get_checkin` 给出。

    异步版本在调用点用 `await`；这里保留同步签名只为让名片在无打卡数据时
    也返回 0 而不是 None（类型契约要求整数）。
    """
    _ = session, matrix_uid
    return 0


# ------------------------------------------------------------------ 5. 桌面队列


def _as_uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise MatrixError(ErrorCode.POCKET_ITEM_NOT_FOUND, "记录不存在") from None


def _item_out(row: QueueItem) -> QueueItemOut:
    return QueueItemOut(
        id=str(row.item_id),
        origin=row.origin,  # type: ignore[arg-type]
        originRef=row.origin_ref,
        title=row.title,
        note=row.note,
        targetStation=row.target_station,
        desktopAction=row.desktop_action,
        payloadType=row.payload_type,  # type: ignore[arg-type]
        evidence_anchors=[
            EvidenceAnchor(**anchor)
            for anchor in (row.evidence_anchors or [])
            if isinstance(anchor, dict)
        ],
        status=row.status,  # type: ignore[arg-type]
        claimedAt=_iso(row.claimed_at) if row.claimed_at else None,
        createdAt=_iso(row.created_at),
        receiptId=row.receipt_id or None,
    )


async def get_queue(
    session: AsyncSession, *, matrix_uid: str, desktop_online: bool | None = None
) -> QueueSnapshot:
    rows = list(
        await session.scalars(
            select(QueueItem)
            .where(QueueItem.matrix_uid == matrix_uid)
            .order_by(QueueItem.created_at.desc())
            .limit(100)
        )
    )
    items = [_item_out(row) for row in rows]
    online = hub.is_online(matrix_uid) if desktop_online is None else desktop_online
    return QueueSnapshot(
        items=items,
        pendingCount=sum(1 for item in items if item.status == "pending"),
        desktopOnline=bool(online),
        syncedAt=_iso(now()),
    )


async def push_queue(
    session: AsyncSession,
    *,
    settings: Settings,
    signer: TokenSigner,
    matrix_uid: str,
    scope: list[str],
    station_id: str | None,
    request: QueuePushRequest,
) -> tuple[QueueItemOut, str, str, bool]:
    """推入桌面待办队列。

    返回 `(item, receipt_id, idempotency_key, deduplicated)`。

    **幂等的两层保证**：
    1. 应用层先按 `idempotency_key` 查——正常重放走这条，省一次写入；
    2. 数据库唯一约束兜底——并发双发时两个请求都查不到已有行，
       后插入的那个撞 `IntegrityError`，我们把它转成「读取已存在的那条」，
       于是并发也不会产生两条待办。

    `payload_hash` 用与虫洞收据**同一套** canonical JSON 规则，
    因此收据侧的对账逻辑不需要知道口袋端的存在。
    """
    key = request.idempotency_key or _derive_idempotency_key(matrix_uid, request)

    existing = await session.scalar(
        select(QueueItem).where(
            QueueItem.matrix_uid == matrix_uid, QueueItem.idempotency_key == key
        )
    )
    if existing is not None:
        return _item_out(existing), existing.receipt_id, key, True

    source_station = request.source_station or station_id or "orbital"
    payload_hash = wormhole_service.hash_payload(
        {
            "title": request.title,
            "note": request.note,
            "target_station": request.target_station,
            "desktop_action": request.desktop_action,
            "payload_type": request.payload_type,
            "evidence_anchors": [
                anchor.model_dump(exclude_none=True) for anchor in request.evidence_anchors
            ],
        }
    )

    item = QueueItem(
        matrix_uid=matrix_uid,
        origin=request.origin,
        origin_ref=request.card_id or "",
        title=request.title,
        note=request.note,
        target_station=request.target_station,
        desktop_action=request.desktop_action,
        payload_type=request.payload_type,
        evidence_anchors=[
            anchor.model_dump(exclude_none=True) for anchor in request.evidence_anchors
        ],
        status="pending",
        source_app=f"{source_station}.matrixos.edu",
        payload_hash=payload_hash,
        idempotency_key=key,
    )
    session.add(item)

    receipt_id = ""
    try:
        async with session.begin_nested():
            await session.flush()
    except IntegrityError:
        # 并发重放：另一条请求已插入同一 key。savepoint 回滚只撤销 SQL，
        # **不撤销 session 里那个 pending 对象**——不 expunge 的话，路由随后的
        # commit 会把它再插一次并再次撞唯一约束，把一个幂等重放变成 500。
        session.expunge(item)
        raced = await session.scalar(
            select(QueueItem).where(
                QueueItem.matrix_uid == matrix_uid, QueueItem.idempotency_key == key
            )
        )
        if raced is None:
            raise MatrixError(
                ErrorCode.CONFLICT, "待办推送冲突，请重试", log_extra={"key": key}
            ) from None
        return _item_out(raced), raced.receipt_id, key, True

    # 落虫洞收据（W2：只有哈希与元数据）。
    # 手机端 token 通常没有 emit 权限，收据只是审计增强件，拿不到就跳过并留空 receipt_id，
    # 不能因为「没有收据」而丢弃用户的待办——待办投送的成功标准是数据落库。
    # 收据必须开在自己的 savepoint 里：create_receipt 中途抛错时它会已经
    # `session.add` 过收据行 / idt 行，不回滚的话路由层最后的 commit 会连坐失败。
    receipt_id = ""
    try:
        async with session.begin_nested():
            result = await wormhole_service.create_receipt(
                session,
                settings=settings,
                signer=signer,
                matrix_uid=matrix_uid,
                scope=scope,
                trace_id=str(uuid.uuid4()),
                source_app=item.source_app,
                target_app=f"{request.target_station}.matrixos.edu",
                payload_type=request.payload_type,
                evidence_count=len(request.evidence_anchors),
                payload_hash=payload_hash,
                payload_size=0,
                verification_levels=wormhole_service.count_levels(
                    [anchor.model_dump(exclude_none=True) for anchor in request.evidence_anchors]
                )[0],
                target_accepts_payload_type=True,
            )
            receipt_id = result.receipt_id
            item.receipt_id = receipt_id
            await session.flush()
    except MatrixError as exc:
        if exc.code not in {
            ErrorCode.WORMHOLE_RECEIPT_EMIT_DENIED,
            ErrorCode.WORMHOLE_INVALID_ENVELOPE,
        }:
            raise

    await audit.record(
        session,
        action="pocket.queue_pushed",
        matrix_uid=matrix_uid,
        station_id=source_station,
        detail={
            "item_id": str(item.item_id),
            "target_station": request.target_station,
            "payload_type": request.payload_type,
            "evidence_count": len(request.evidence_anchors),
            "receipt_id": receipt_id,
        },
    )
    await session.flush()
    return _item_out(item), receipt_id, key, False


def _derive_idempotency_key(matrix_uid: str, request: QueuePushRequest) -> str:
    """客户端没给幂等键时按内容派生。

    用 `uid + 卡/来源引用 + 目标站 + 标题哈希` 而不是纯标题哈希：
    同一条早报卡推给两个不同站点是两件不同的待办，必须各自成键。
    """
    base = "|".join(
        (
            matrix_uid,
            request.origin,
            request.card_id or "",
            request.target_station,
            hashlib.sha256(f"{request.title}\n{request.note}".encode("utf-8")).hexdigest()[:16],
        )
    )
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:48]


async def claim_item(
    session: AsyncSession, *, matrix_uid: str, item_id: str
) -> tuple[QueueItemOut, str]:
    """桌面认领：`pending → claimed`。返回 `(item, claimedAt)`。

    **幂等**：重复认领同一条不报错（桌面端断线重连后会重放认领）。
    """
    row = await _load_item(session, matrix_uid=matrix_uid, item_id=item_id)
    if row.status == "claimed":
        return _item_out(row), _iso(row.claimed_at)
    if row.status == "done":
        raise MatrixError(
            ErrorCode.POCKET_BAD_TRANSITION,
            "条目已完成，不能再认领",
            log_extra={"status": row.status},
        )
    row.status = "claimed"
    row.claimed_at = now()
    await session.flush()
    return _item_out(row), _iso(row.claimed_at)


async def mark_done(
    session: AsyncSession, *, matrix_uid: str, item_id: str
) -> tuple[QueueItemOut, str]:
    """完成：只允许 `claimed → done`。返回 `(item, doneAt)`。

    `pending → done` 被拒（409）——待办必须先在桌面被认领，
    否则「手机推完直接在桌面消失」会让双端协同退化成单向写入。

    时间戳随返回值一起给出：`QueueItem` 的对外契约（types.ts）刻意**没有**
    `doneAt` 字段，所以不能挂到 item 上，只能作为独立返回值传递。
    """
    row = await _load_item(session, matrix_uid=matrix_uid, item_id=item_id)
    if row.status == "done":
        return _item_out(row), _iso(row.done_at)
    if row.status != "claimed":
        raise MatrixError(
            ErrorCode.POCKET_BAD_TRANSITION,
            f"只能从 claimed 完成，当前状态是 {row.status}",
            log_extra={"status": row.status},
        )
    row.status = "done"
    row.done_at = now()
    await session.flush()
    return _item_out(row), _iso(row.done_at)


async def remove_item(session: AsyncSession, *, matrix_uid: str, item_id: str) -> None:
    row = await _load_item(session, matrix_uid=matrix_uid, item_id=item_id)
    await session.delete(row)
    await session.flush()


async def _load_item(
    session: AsyncSession, *, matrix_uid: str, item_id: str
) -> QueueItem:
    row = await session.get(QueueItem, _as_uuid(item_id))
    if row is None or row.matrix_uid != matrix_uid:
        # 跨用户返回 404 而非 403：不泄漏「这条 id 存在」这件事
        raise MatrixError(ErrorCode.POCKET_ITEM_NOT_FOUND, "待办不存在")
    return row


async def pending_count(session: AsyncSession, *, matrix_uid: str) -> int:
    value = await session.scalar(
        select(func.count())
        .select_from(QueueItem)
        .where(QueueItem.matrix_uid == matrix_uid, QueueItem.status == "pending")
    )
    return int(value or 0)


async def list_checkin_dates(session: AsyncSession, *, matrix_uid: str) -> Iterable[str]:
    rows = await session.scalars(
        select(CheckinRecord.checkin_date).where(
            CheckinRecord.matrix_uid == matrix_uid
        )
    )
    return set(rows)


async def clear_user_data(session: AsyncSession, *, matrix_uid: str) -> None:
    """测试辅助：清掉一个 uid 的口袋端数据（不动资产与鉴权表）。"""
    for model in (QueueItem, CheckinRecord, MentorReminder, MicroGoal, MorningDismissal):
        await session.execute(delete(model).where(model.matrix_uid == matrix_uid))
    await session.flush()


# ------------------------------------------------------------------ 6. WS 下行


@dataclass
class StreamHub:
    """进程内 WS 广播中心（按 `matrix_uid` 分键）。

    鉴权前不下发任何用户数据：连接建立即发 `hello`，之后必须收到 `auth`
    才会被登记为某身份的订阅者。未鉴权连接收不到 `queue.*` 事件。
    """

    _by_uid: dict[str, set[Any]] = field(default_factory=dict)

    def register(self, matrix_uid: str, connection: Any) -> None:
        self._by_uid.setdefault(matrix_uid, set()).add(connection)

    def unregister(self, matrix_uid: str, connection: Any) -> None:
        bucket = self._by_uid.get(matrix_uid)
        if bucket is None:
            return
        bucket.discard(connection)
        if not bucket:
            self._by_uid.pop(matrix_uid, None)

    def is_online(self, matrix_uid: str) -> bool:
        return bool(self._by_uid.get(matrix_uid))

    async def broadcast(self, matrix_uid: str, message: dict[str, Any]) -> int:
        """尽力投递：单个连接失败不影响其它连接，也不回滚已完成的事务。

        这是待办状态同步而非账务事件，掉一次下行由桌面端下一次全量拉取补偿
        （见 apps/orbital-hub/src/lib/queue-client.ts 的 resync 路径）。
        """
        sent = 0
        for connection in list(self._by_uid.get(matrix_uid, set())):
            try:
                await connection.send_json(message)
                sent += 1
            except Exception:  # noqa: BLE001 - 断开的连接由下一次发送自然清理
                continue
        return sent


hub = StreamHub()

__all__ = [
    "DEMO_CORPUS",
    "STAGE_LABELS",
    "STAGE_ORDER",
    "StreamHub",
    "acknowledge_mentor",
    "advance_stage",
    "build_briefing",
    "build_card",
    "claim_item",
    "dismiss_card",
    "get_checkin",
    "get_mentor_board",
    "get_queue",
    "hub",
    "mark_done",
    "pending_count",
    "push_queue",
    "remove_item",
    "set_checkin",
]
