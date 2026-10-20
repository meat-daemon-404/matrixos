/**
 * 口袋端 API 封装 —— 页面只调这一层，不直接碰 `core/request`。
 *
 * 端点约定（`/v1/*`，见 docs/01-plan/01-architecture.md §3.3）：
 *
 * | 方法 | 路径 | 承载服务 | 状态 |
 * | :--- | :--- | :--- | :--- |
 * | GET  | `/v1/pocket/morning`               | matrix-core | 🔶 mock |
 * | POST | `/v1/pocket/morning/dismiss`       | matrix-core | 🔶 mock |
 * | GET  | `/v1/pocket/checkin`               | matrix-core | 🔶 mock |
 * | POST | `/v1/pocket/checkin`               | matrix-core | 🔶 mock |
 * | GET  | `/v1/pocket/mentor`                | matrix-core（聚合 openalex-worker + lab-kanban） | 🔶 mock |
 * | POST | `/v1/pocket/mentor/ack`            | matrix-core | 🔶 mock |
 * | GET  | `/v1/pocket/card`                  | matrix-core（聚合 DigitalTwinAssetGraph） | 🔶 mock |
 * | GET  | `/v1/pocket/queue`                 | matrix-core | 🔶 mock |
 * | POST | `/v1/pocket/queue/push`            | matrix-core（落虫洞收据） | 🔶 mock |
 * | DEL  | `/v1/pocket/queue?id=`             | matrix-core | 🔶 mock |
 * | POST | `/v1/auth/wechat/exchange`         | matrix-core | 🔶 mock |
 * | POST | `/v1/auth/refresh`                 | matrix-core | 🔶 mock |
 * | WSS  | `/v1/pocket/stream`                | matrix-core | 🔶 mock（见 mock-server） |
 *
 * 所有读接口都带 `cacheKey`，让冷启动能先渲染缓存再刷新（见 core/request.ts）。
 */

import { http, readCache, type ApiResponse } from '../core/request';
import { STORAGE_KEYS } from '../core/storage';
import type {
  AcademicCard,
  CheckinDay,
  DataOrigin,
  MentorBoard,
  MorningBriefing,
  PushResult,
  QueueItem,
  QueueSnapshot,
} from './types';

const TTL = {
  /** 早报：当天有效，跨天即失效（08:00 发新的一批）。 */
  morning: 6 * 60 * 60 * 1000,
  checkin: 30 * 60 * 1000,
  mentor: 5 * 60 * 1000,
  card: 24 * 60 * 60 * 1000,
  queue: 2 * 60 * 1000,
};

export interface Loaded<T> {
  data: T;
  origin: DataOrigin;
  /** 缓存年龄；origin==='cache' 时用于展示「N 分钟前」。 */
  ageMs: number;
}

function toLoaded<T>(res: ApiResponse<T>): Loaded<T> {
  return {
    data: res.data,
    origin: res.mock ? 'mock' : res.cacheAgeMs > 0 ? 'cache' : 'live',
    ageMs: res.cacheAgeMs,
  };
}

/* ------------------------------------------------------------------ */
/* 早报                                                                */
/* ------------------------------------------------------------------ */

export const morningApi = {
  cacheKey: STORAGE_KEYS.morning,

  /** 同步读取上一次的早报缓存（冷启动首屏用，不发请求）。 */
  peekCache(): { value: MorningBriefing; ageMs: number } | undefined {
    return readCache<MorningBriefing>(STORAGE_KEYS.morning);
  },

  async load(): Promise<Loaded<MorningBriefing>> {
    const res = await http.get<MorningBriefing>('/v1/pocket/morning', {
      cacheKey: STORAGE_KEYS.morning,
      cacheTtlMs: TTL.morning,
    });
    return toLoaded(res);
  },

  async dismiss(cardId: string): Promise<void> {
    await http.post('/v1/pocket/morning/dismiss', { cardId }, { noMock: false });
  },

  /** ⚡ 推入电脑端对比矩阵待办队列 —— 双端协同的核心写路径。 */
  async pushToDesktop(card: {
    id: string;
    title: string;
    fitNote: string;
    targetStation: string;
    desktopAction: string;
    payloadType: QueueItem['payloadType'];
    evidenceAnchors: QueueItem['evidenceAnchors'];
  }): Promise<PushResult> {
    const res = await http.post<PushResult, unknown>(
      '/v1/pocket/queue/push',
      {
        cardId: card.id,
        title: card.title,
        note: card.fitNote,
        targetStation: card.targetStation,
        desktopAction: card.desktopAction,
        payloadType: card.payloadType,
        evidenceAnchors: card.evidenceAnchors,
      },
      // 写操作要求拿到确定的落库结果：不允许静默 mock 成功而不提示
      { noMock: false },
    );
    return res.data;
  },
};

/* ------------------------------------------------------------------ */
/* 打卡                                                                */
/* ------------------------------------------------------------------ */

export const checkinApi = {
  peekCache(): { value: CheckinDay; ageMs: number } | undefined {
    return readCache<CheckinDay>(STORAGE_KEYS.checkin);
  },

  async load(): Promise<Loaded<CheckinDay>> {
    const res = await http.get<CheckinDay>('/v1/pocket/checkin', {
      cacheKey: STORAGE_KEYS.checkin,
      cacheTtlMs: TTL.checkin,
    });
    return toLoaded(res);
  },

  async toggle(goalId: string, date: string, done: boolean): Promise<void> {
    if (done) {
      await http.post('/v1/pocket/checkin', { goalId, date, done: true });
    } else {
      // 取消打卡用 DELETE + query，避免服务端把"取消"误当成幂等重放
      await http.del(`/v1/pocket/checkin`, { query: { goalId, date } });
    }
  },
};

/* ------------------------------------------------------------------ */
/* 进组提醒                                                            */
/* ------------------------------------------------------------------ */

export const mentorApi = {
  peekCache(): { value: MentorBoard; ageMs: number } | undefined {
    return readCache<MentorBoard>(STORAGE_KEYS.mentor);
  },

  async load(): Promise<Loaded<MentorBoard>> {
    const res = await http.get<MentorBoard>('/v1/pocket/mentor', {
      cacheKey: STORAGE_KEYS.mentor,
      cacheTtlMs: TTL.mentor,
    });
    return toLoaded(res);
  },

  async acknowledge(reminderId: string): Promise<void> {
    await http.post('/v1/pocket/mentor/ack', { reminderId });
  },
};

/* ------------------------------------------------------------------ */
/* 学术名片                                                            */
/* ------------------------------------------------------------------ */

export const cardApi = {
  peekCache(): { value: AcademicCard; ageMs: number } | undefined {
    return readCache<AcademicCard>(STORAGE_KEYS.card);
  },

  async load(): Promise<Loaded<AcademicCard>> {
    const res = await http.get<AcademicCard>('/v1/pocket/card', {
      cacheKey: STORAGE_KEYS.card,
      cacheTtlMs: TTL.card,
    });
    return toLoaded(res);
  },

  /**
   * 生成名片二维码内容。
   * 服务端若提供短链（`/v1/pocket/card/qr`）则优先用短链，否则用 `qrPayload`。
   * 这里不额外发请求 —— 名片数据里已经带了 `qrPayload`，少一次往返就少一次冷启动开销。
   */
  qrPayloadOf(card: AcademicCard): string {
    return card.qrPayload;
  },
};

/* ------------------------------------------------------------------ */
/* 桌面队列                                                            */
/* ------------------------------------------------------------------ */

export const queueApi = {
  peekCache(): { value: QueueSnapshot; ageMs: number } | undefined {
    return readCache<QueueSnapshot>(STORAGE_KEYS.queue);
  },

  async load(): Promise<Loaded<QueueSnapshot>> {
    const res = await http.get<QueueSnapshot>('/v1/pocket/queue', {
      cacheKey: STORAGE_KEYS.queue,
      cacheTtlMs: TTL.queue,
    });
    return toLoaded(res);
  },

  async remove(id: string): Promise<void> {
    await http.del('/v1/pocket/queue', { query: { id } });
  },
};
