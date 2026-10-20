"""SQLite 持久化：早报归档、推送去重、已读回执、导师画像缓存。

为什么用 SQLite 而不是 PostgreSQL：架构 §3.3 规定本服务**不做面向用户的鉴权、
不持有业务台账**，它的全部持久化需求就是「三天内别把同一篇再推一遍」和
「记得用户点过已读」。这属于服务本地状态，不是 DigitalTwinAssetGraph 的一部分。
用文件型 SQLite 让服务可以单机跑、可离线、08:00 不依赖数据库连通性。

三张表：

- `brief`      早报归档（digest_id 主键，payload 存 JSON 文本）
- `push_log`   推送台账（paper_key + brief_date 唯一），去重的依据
- `read_log`   已读回执（paper_key 主键），投影到卡片 `read` 字段

`paper_key` 的构造见 `pipeline.brief._receipt_key`：DOI > arXiv id > 标题哈希。
刻意不用 OpenAlex work id —— 它会随去重合并变化，不是稳定标识。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS brief (
    digest_id   TEXT PRIMARY KEY,
    brief_date  TEXT NOT NULL,
    station     TEXT NOT NULL DEFAULT 'pat_hot',
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brief_date ON brief (brief_date);

CREATE TABLE IF NOT EXISTS push_log (
    paper_key   TEXT NOT NULL,
    brief_date  TEXT NOT NULL,
    digest_id   TEXT NOT NULL,
    pushed_at   TEXT NOT NULL,
    PRIMARY KEY (paper_key, brief_date)
);
CREATE INDEX IF NOT EXISTS idx_push_paper ON push_log (paper_key);
CREATE INDEX IF NOT EXISTS idx_push_at ON push_log (pushed_at);

CREATE TABLE IF NOT EXISTS read_log (
    paper_key   TEXT PRIMARY KEY,
    read_at     TEXT NOT NULL,
    digest_id   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_read_at ON read_log (read_at);

CREATE TABLE IF NOT EXISTS mentor_profile (
    author_id   TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    fetched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mentor_at ON mentor_profile (fetched_at);
"""


class Store:
    """线程/协程安全的 SQLite 封装。

    每个线程一条连接（`threading.local`），因为 sqlite3 的连接默认不能跨线程；
    FastAPI 的同步路由跑在线程池里，异步路由跑在事件循环线程，两类都会用到。
    """

    def __init__(self, path: str | Path = ":memory:") -> None:
        self._path = str(path)
        self._local = threading.local()
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    # ------------------------------------------------------------ 连接管理

    def _conn(self) -> sqlite3.Connection:
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._path, check_same_thread=False, timeout=10.0)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        conn = self._conn()
        conn.executescript(SCHEMA)
        conn.commit()

    def close(self) -> None:
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # ------------------------------------------------------------ 早报归档

    def save_brief(self, payload: dict[str, Any]) -> None:
        """按 digest_id 幂等写入。重复写入直接覆盖（同日重跑应得到同一 digest_id）。"""
        digest_id = str(payload.get("digest_id") or "")
        brief_date = str(payload.get("brief_date") or "")
        if not digest_id or not brief_date:
            raise ValueError("payload 缺 digest_id 或 brief_date，拒绝归档")
        conn = self._conn()
        conn.execute(
            "INSERT OR REPLACE INTO brief (digest_id, brief_date, station, payload, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                digest_id,
                brief_date,
                str(payload.get("station") or "pat_hot"),
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                str(payload.get("generated_at") or ""),
            ),
        )
        conn.commit()

    def get_brief(self, digest_id: str) -> dict[str, Any] | None:
        row = self._conn().execute(
            "SELECT payload FROM brief WHERE digest_id = ?", (digest_id,)
        ).fetchone()
        return json.loads(row["payload"]) if row else None

    def get_brief_by_date(self, brief_date: str) -> dict[str, Any] | None:
        """取某天的**最新**早报。同一天多次生成时以最后一次为准。"""
        row = self._conn().execute(
            "SELECT payload FROM brief WHERE brief_date = ? ORDER BY created_at DESC LIMIT 1",
            (brief_date,),
        ).fetchone()
        return json.loads(row["payload"]) if row else None

    def list_briefs(self, limit: int = 30) -> list[dict[str, Any]]:
        """早报历史（列表页用）。只返回摘要字段，不回传整份 payload。"""
        rows = self._conn().execute(
            "SELECT digest_id, brief_date, created_at, payload FROM brief"
            " ORDER BY brief_date DESC, created_at DESC LIMIT ?",
            (max(1, limit),),
        ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            payload = json.loads(row["payload"])
            cards = payload.get("cards") or []
            result.append(
                {
                    "digest_id": row["digest_id"],
                    "brief_date": row["brief_date"],
                    "generated_at": row["created_at"],
                    "headline": (cards[0].get("title") if cards else ""),
                    "selected": (payload.get("stats") or {}).get("selected", 0),
                }
            )
        return result

    def count_briefs(self) -> int:
        row = self._conn().execute("SELECT COUNT(*) AS n FROM brief").fetchone()
        return int(row["n"] if row else 0)

    # ------------------------------------------------------------ 推送去重

    def recently_pushed(
        self, *, now: datetime, within_days: int = 3
    ) -> set[str]:
        """返回最近 N 天内推送过的 paper_key 集合。

        `within_days=0` 表示「只要今天推过就算」——由调用方决定粒度。
        时间比较用 ISO 字符串，因为 SQLite 没有原生 datetime。
        """
        if within_days <= 0:
            return set()
        cutoff = (now - timedelta(days=within_days)).isoformat(timespec="seconds")
        rows = self._conn().execute(
            "SELECT DISTINCT paper_key FROM push_log WHERE pushed_at >= ?", (cutoff,)
        ).fetchall()
        return {row["paper_key"] for row in rows}

    def pushed_dates(self, paper_key: str) -> list[str]:
        rows = self._conn().execute(
            "SELECT brief_date FROM push_log WHERE paper_key = ? ORDER BY brief_date DESC",
            (paper_key,),
        ).fetchall()
        return [row["brief_date"] for row in rows]

    def mark_pushed(
        self, paper_keys: list[str], *, digest_id: str, brief_date: str, now: datetime
    ) -> int:
        """登记推送。返回值是实际新增的行数（重复推送同一天同一篇不增行）。"""
        if not paper_keys:
            return 0
        conn = self._conn()
        stamp = now.isoformat(timespec="seconds")
        inserted = 0
        for key in dict.fromkeys(paper_keys):
            cursor = conn.execute(
                "INSERT OR IGNORE INTO push_log (paper_key, brief_date, digest_id, pushed_at)"
                " VALUES (?, ?, ?, ?)",
                (key, brief_date, digest_id, stamp),
            )
            inserted += cursor.rowcount or 0
        conn.commit()
        return inserted

    # ------------------------------------------------------------ 已读回执

    def mark_read(self, paper_key: str, *, now: datetime, digest_id: str = "") -> None:
        conn = self._conn()
        conn.execute(
            "INSERT OR REPLACE INTO read_log (paper_key, read_at, digest_id) VALUES (?, ?, ?)",
            (paper_key, now.isoformat(timespec="seconds"), digest_id),
        )
        conn.commit()

    def mark_unread(self, paper_key: str) -> None:
        conn = self._conn()
        conn.execute("DELETE FROM read_log WHERE paper_key = ?", (paper_key,))
        conn.commit()

    def is_read(self, paper_key: str) -> bool:
        row = self._conn().execute(
            "SELECT 1 FROM read_log WHERE paper_key = ?", (paper_key,)
        ).fetchone()
        return row is not None

    def read_keys(self) -> set[str]:
        rows = self._conn().execute("SELECT paper_key FROM read_log").fetchall()
        return {row["paper_key"] for row in rows}

    # ------------------------------------------------------------ 导师缓存

    def save_mentor_profile(self, payload: dict[str, Any], *, now: datetime) -> None:
        author_id = str(payload.get("author_id") or "")
        if not author_id:
            raise ValueError("导师画像缺 author_id，拒绝缓存")
        conn = self._conn()
        conn.execute(
            "INSERT OR REPLACE INTO mentor_profile (author_id, payload, fetched_at)"
            " VALUES (?, ?, ?)",
            (
                author_id,
                json.dumps(payload, ensure_ascii=False, sort_keys=True),
                now.isoformat(timespec="seconds"),
            ),
        )
        conn.commit()

    def get_mentor_profile(
        self, author_id: str, *, max_age_hours: int = 168
    ) -> dict[str, Any] | None:
        """取缓存画像。超过 max_age_hours 视为过期返回 None（由调用方重算）。"""
        row = self._conn().execute(
            "SELECT payload, fetched_at FROM mentor_profile WHERE author_id = ?",
            (author_id,),
        ).fetchone()
        if row is None:
            return None
        try:
            fetched = datetime.fromisoformat(row["fetched_at"])
        except (TypeError, ValueError):
            return None
        if datetime.now(fetched.tzinfo) - fetched > timedelta(hours=max_age_hours):
            return None
        return json.loads(row["payload"])

    def clear(self) -> None:
        """清空全部业务表。测试用，生产不调用。"""
        conn = self._conn()
        for table in ("brief", "push_log", "read_log", "mentor_profile"):
            conn.execute(f"DELETE FROM {table}")  # noqa: S608 - 表名来自固定白名单
        conn.commit()
