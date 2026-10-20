"""口袋端 `/v1/pocket/*` 的 Pydantic 契约。

**唯一事实源是 `apps/wechat-pocket/miniprogram/api/types.ts`。** 本文件逐字段对齐它，
不新增、不改名、不调整可空性——前端页面代码是按那份类型写的，任何偏差都会变成
「联调时才炸」的返工。

## 命名映射规则（本模块最容易搞错的地方）

TS 侧字段是 **camelCase**（`targetStation` / `evidenceAnchors` / `desktopAction`），
Python 侧习惯 snake_case。这里用 `alias_generator` 输出 camelCase，同时
`populate_by_name=True` 让两种写法都能收——于是：

- 响应体：原样 camelCase，前端一行不用改；
- 请求体：camelCase 与 snake_case 都接受（便于 curl 调试与 TS 直连）。

**但嵌套的 `EvidenceAnchor` 例外**：它在 TS 里本来就是 snake_case
（`source_doi_or_url` / `verification_level`），因为它逐字对齐
`specs/contracts/wormhole-envelope.schema.json`——那是**已冻结的虫洞契约**。
所以这里直接复用 `app.schemas.wormhole.EvidenceAnchor`，不套 camelCase 生成器。
外层 camelCase、内层 snake_case 是刻意的，不是疏漏。

## 与数据库模型的边界

本文件是**对外视图**（含 `done`/`dismissed` 这类派生布尔量），
`app/models/pocket.py` 是存储形态。两者的转换只在 `app/services/pocket.py` 里做，
路由层不碰 ORM 对象。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.wormhole import EvidenceAnchor, PayloadType, VerificationLevel

# 与 types.ts 的 GoalKind / QueueStatus / QueueOrigin / MentorStage 逐字对齐
GoalKind = Literal["study", "research", "desktop"]
QueueStatus = Literal["pending", "claimed", "done"]
QueueOrigin = Literal["morning_card", "checkin_goal", "manual"]
MentorStage = Literal[
    "email_sent",
    "email_read",
    "interview_scheduled",
    "interview_passed",
    "joined",
]


def to_camel(name: str) -> str:
    """`target_station` → `targetStation`。

    自己写而不用 `pydantic.alias_generators.to_camel`：本仓库锁的是 pydantic>=2.9，
    该工具函数在 2.x 里搬过家（`pydantic.generatives` → `pydantic.alias_generators`），
    一个 6 行的纯函数不值得把契约形状交给上游的模块路径稳定性。
    """
    head, *rest = name.split("_")
    return head + "".join(word[:1].upper() + word[1:] for word in rest)


class CamelModel(BaseModel):
    """对外视图基类：输出 camelCase，输入两种写法都收。"""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        # 视图里多余的键要报错：静默丢弃会让「前端传了但服务端没接到」变成排查黑洞
        extra="forbid",
    )


class LooseCamelModel(CamelModel):
    """请求体基类：允许未知键被忽略。

    只有 `queue/push` 这类「移动端可能先于服务端演进」的入口用它——口袋端发版
    受微信审核制约（见 roadmap S2 风险表），多带一个键不该让整个推送 422。
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


# ================================================================== 早报
#
# GET /v1/pocket/morning → MorningBriefing；POST /v1/pocket/morning/dismiss


class MorningCard(CamelModel):
    id: str
    index: int = Field(ge=1, le=3)
    station: str
    source: str
    title: str
    summary: str
    heat: int = Field(ge=0, le=100)
    metrics: list[dict[str, str]] = Field(default_factory=list)
    fit_note: str = ""
    payload_type: PayloadType
    target_station: str
    desktop_action: str
    evidence_anchors: list[EvidenceAnchor] = Field(min_length=1)
    published_at: str
    dismissed: bool | None = None
    pushed: bool | None = None


class MorningBriefing(CamelModel):
    briefing_date: str
    generated_at: str
    keywords: list[str] = Field(default_factory=list)
    cards: list[MorningCard] = Field(default_factory=list)
    desktop_queue_count: int = Field(ge=0)


class MorningDismissRequest(CamelModel):
    card_id: str = Field(min_length=1)


# ================================================================== 打卡


class MicroGoal(CamelModel):
    id: str
    title: str
    note: str | None = None
    kind: GoalKind
    target: str | None = None
    done: bool
    done_at: str | None = None


class CheckinDay(CamelModel):
    date: str
    goals: list[MicroGoal] = Field(default_factory=list)
    streak: int = Field(ge=0)
    week: list[bool] = Field(default_factory=list)
    term_days: int = Field(ge=0)
    term_target: int = Field(ge=1)


class CheckinRequest(CamelModel):
    goal_id: str = Field(min_length=1)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    done: bool


# ================================================================== 进组提醒


class MentorReminder(CamelModel):
    id: str
    mentor_name: str
    mentor_title: str
    lab: str
    stage: MentorStage
    stage_label: str
    starts_at: str
    location: str
    read_receipt: bool
    read_at: str | None = None
    acknowledged: bool
    outline: list[dict[str, object]] | None = None
    match_score: int = Field(ge=0, le=100)
    evidence_anchors: list[EvidenceAnchor] = Field(default_factory=list)


class MentorBoard(CamelModel):
    reminders: list[MentorReminder] = Field(default_factory=list)
    next_event_at: str = ""
    synced_at: str


class MentorAckRequest(CamelModel):
    reminder_id: str = Field(min_length=1)


# ================================================================== 学术名片


class CardMetric(CamelModel):
    label: str
    value: str
    hint: str | None = None


class CardEvidence(CamelModel):
    kind: Literal["doi", "github", "patent", "competition"]
    label: str
    ref: str
    verification: VerificationLevel
    verified_note: str | None = None


class AcademicCard(CamelModel):
    matrix_uid: str
    display_name: str
    subtitle: str = ""
    school: str = ""
    major: str = ""
    grade: str = ""
    qr_payload: str
    metrics: list[CardMetric] = Field(default_factory=list)
    evidences: list[CardEvidence] = Field(default_factory=list)
    verification_level: VerificationLevel
    updated_at: str


# ================================================================== 桌面队列


class QueueItem(CamelModel):
    id: str
    origin: QueueOrigin
    origin_ref: str
    title: str
    note: str
    target_station: str
    desktop_action: str
    payload_type: PayloadType
    evidence_anchors: list[EvidenceAnchor] = Field(min_length=1)
    status: QueueStatus
    claimed_at: str | None = None
    created_at: str
    receipt_id: str | None = None


class QueueSnapshot(CamelModel):
    items: list[QueueItem] = Field(default_factory=list)
    pending_count: int = Field(ge=0)
    desktop_online: bool
    synced_at: str


class QueuePushRequest(LooseCamelModel):
    """`POST /v1/pocket/queue/push` 的请求体。

    **刻意不含 payload 正文**（W2）：只收标题、说明、目标站与证据锚点这些元数据。
    正文由浏览器/小程序 P2P 直投，服务端只留哈希做对账。
    """

    card_id: str | None = None
    title: str = Field(min_length=1, max_length=500)
    note: str = Field(default="", max_length=2000)
    target_station: str = Field(min_length=1, max_length=64)
    desktop_action: str = Field(default="", max_length=500)
    payload_type: PayloadType
    evidence_anchors: list[EvidenceAnchor] = Field(min_length=1)
    source_station: str | None = None
    origin: QueueOrigin = "morning_card"
    # 客户端可自带幂等键；不带时服务端按内容派生（见 services/pocket.py）
    idempotency_key: str | None = Field(default=None, max_length=128)

    @field_validator("evidence_anchors")
    @classmethod
    def _anchors_have_source(cls, value: list[EvidenceAnchor]) -> list[EvidenceAnchor]:
        """W1 的入口版：非空已由 `min_length` 保证，这里补「DOI/URL 不能是空白」。"""
        for anchor in value:
            if not anchor.source_doi_or_url.strip():
                raise ValueError("evidence_anchors 的 source_doi_or_url 不能为空白")
        return value


class QueueItemRefRequest(CamelModel):
    """`claim` / `done` 的共用请求体。"""

    item_id: str = Field(min_length=1)


class QueuePushResult(CamelModel):
    item: QueueItem
    receipt_id: str
    desktop_notified: bool
    idempotency_key: str


class QueueStateResult(CamelModel):
    item: QueueItem
    claimed_at: str | None = None
    done_at: str | None = None


__all__ = [
    "AcademicCard",
    "CardEvidence",
    "CardMetric",
    "CheckinDay",
    "CheckinRequest",
    "GoalKind",
    "MentorAckRequest",
    "MentorBoard",
    "MentorReminder",
    "MentorStage",
    "MicroGoal",
    "MorningBriefing",
    "MorningCard",
    "MorningDismissRequest",
    "QueueItem",
    "QueueItemRefRequest",
    "QueueOrigin",
    "QueuePushRequest",
    "QueuePushResult",
    "QueueSnapshot",
    "QueueStateResult",
    "QueueStatus",
    "to_camel",
]
