/**
 * 晨间早报（08:00 三卡）—— 口袋端的每日触点。
 *
 * 数据路径（api/index.ts 已封装）：
 *   onLoad 先 peekCache() 同步渲染上次缓存（冷启动 < 800ms 预算），再后台 load() 换新；
 *   两者都失败时 panel-state 显示错误态 + 重试。
 * 写路径：忽略（dismiss）与推入桌面（pushToDesktop）都走 REST，
 *   不依赖 WS——WSS 全断时「推入」也必须成功（S2-19 的可用性设计）。
 * 下行增量：订阅 sync 的 queue.count，桌面消费后角标实时回落。
 *
 * strict 约定：Page 的 D 必须是 type 别名（具名 interface 无隐式索引签名 → TS2344）；
 *   方法体内 `this` 只允许访问 MorningMethods 声明的成员，故把实例内部的
 *   释放句柄也显式声明进 MorningMethods，而不是靠 `this: any` 逃逸。
 */
import { morningApi, type Loaded } from '../../api/index';
import type { MorningBriefing, MorningCard, PayloadType } from '../../api/types';
import { toApiError } from '../../core/errors';
import { log, reportFirstPaint } from '../../core/logger';
import { sync } from '../../core/sync';

type CardView = {
  id: string;
  index: number;
  source: string;
  title: string;
  summary: string;
  heat: number;
  heatText: string;
  metrics: Array<{ label: string; value: string }>;
  fitNote: string;
  payloadType: PayloadType;
  targetStation: string;
  desktopAction: string;
  evidenceAnchors: MorningCard['evidenceAnchors'];
  publishedAtText: string;
  dismissed: boolean;
  pushed: boolean;
};

type MorningData = {
  state: 'ready' | 'loading' | 'empty' | 'error';
  errorText: string;
  origin: 'live' | 'mock' | 'cache' | 'local';
  ageMs: number;
  briefingDate: string;
  queueCount: number;
  cards: CardView[];
  pushingId: string;
};

type MorningMethods = {
  /** sync 订阅与引用计数的释放句柄（实例字段，非 data）。 */
  offSync: null | (() => void);
  releaseSync: null | (() => void);
  refresh(fromUser: boolean): Promise<void>;
  applyBriefing(loaded: Loaded<MorningBriefing>): void;
  toViews(cards: MorningCard[]): CardView[];
  fmtPublishedAt(iso: string): string;
  detachSync(): void;
  onRetry(): void;
  onDismissTap(e: WechatMiniprogram.TapEventParam): void;
  onPushTap(e: WechatMiniprogram.TapEventParam): void;
};

function toErrorText(e: unknown): string {
  const err = toApiError(e);
  return err.userMessage || err.message || '加载失败';
}

Page<MorningData, MorningMethods>({
  data: {
    state: 'loading',
    errorText: '',
    origin: 'live',
    ageMs: 0,
    briefingDate: '',
    queueCount: 0,
    cards: [],
    pushingId: '',
  },

  offSync: null,
  releaseSync: null,

  onLoad() {
    const cached = morningApi.peekCache();
    if (cached) {
      this.applyBriefing({ data: cached.value, origin: 'cache', ageMs: cached.ageMs });
    } else {
      this.setData({ state: 'loading' });
    }
    void this.refresh(false);
  },

  onShow() {
    this.releaseSync = sync.acquire();
    this.offSync = sync.on((event) => {
      if (event.type === 'queue.count') this.setData({ queueCount: event.pendingCount });
      else if (event.type === 'resync') void this.refresh(false);
    });
  },

  /** 首屏可交互时打点，度量冷启动是否在 COLD_START_BUDGET_MS 预算内。 */
  onReady() {
    reportFirstPaint('pages/morning/index');
  },

  onHide() {
    this.detachSync();
  },

  onUnload() {
    this.detachSync();
  },

  onPullDownRefresh() {
    void this.refresh(true).then(() => wx.stopPullDownRefresh());
  },

  detachSync() {
    if (this.offSync) this.offSync();
    if (this.releaseSync) this.releaseSync();
    this.offSync = null;
    this.releaseSync = null;
  },

  applyBriefing(loaded) {
    const views = this.toViews(loaded.data.cards);
    this.setData({
      state: views.length > 0 ? 'ready' : 'empty',
      origin: loaded.origin,
      ageMs: loaded.ageMs,
      briefingDate: loaded.data.briefingDate,
      queueCount: loaded.data.desktopQueueCount,
      cards: views,
      errorText: '',
    });
  },

  toViews(cards) {
    return cards.map((c) => ({
      id: c.id,
      index: c.index,
      source: c.source,
      title: c.title,
      summary: c.summary,
      heat: c.heat,
      heatText: `热度 ${Math.round(c.heat)}`,
      metrics: c.metrics,
      fitNote: c.fitNote,
      payloadType: c.payloadType,
      targetStation: c.targetStation,
      desktopAction: c.desktopAction,
      evidenceAnchors: c.evidenceAnchors,
      publishedAtText: this.fmtPublishedAt(c.publishedAt),
      dismissed: c.dismissed === true,
      pushed: c.pushed === true,
    }));
  },

  fmtPublishedAt(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const diffH = Math.max(0, Math.round((Date.now() - t) / 3600000));
    if (diffH < 1) return '刚刚';
    if (diffH < 24) return `${diffH} 小时前`;
    return `${Math.round(diffH / 24)} 天前`;
  },

  async refresh(fromUser) {
    if (fromUser) this.setData({ state: 'loading' });
    try {
      const loaded = await morningApi.load();
      this.applyBriefing(loaded);
    } catch (e) {
      const err = toApiError(e);
      // 网络/超时失败且屏上已有缓存：保留内容只降级角标，不清空（ADR-09 L2）。
      if (this.data.cards.length > 0 && (err.kind === 'network' || err.kind === 'timeout')) {
        this.setData({ origin: 'cache' });
        log.warn('morning', `刷新失败，保留缓存展示：${err.kind}`);
        return;
      }
      this.setData({ state: 'error', errorText: toErrorText(e) });
    }
  },

  onRetry() {
    void this.refresh(true);
  },

  onDismissTap(e) {
    const id = String(e.currentTarget.dataset.id ?? '');
    if (!id) return;
    void (async () => {
      try {
        await morningApi.dismiss(id);
        const cards = this.data.cards.map((c) => (c.id === id ? { ...c, dismissed: true } : c));
        this.setData({ cards });
        wx.showToast({ title: '已忽略', icon: 'none' });
      } catch (err) {
        wx.showToast({ title: toErrorText(err), icon: 'none' });
      }
    })();
  },

  onPushTap(e) {
    const id = String(e.currentTarget.dataset.id ?? '');
    const card = this.data.cards.find((c) => c.id === id);
    if (!card || this.data.pushingId) return;
    if (card.pushed) {
      wx.showToast({ title: '已在桌面队列', icon: 'none' });
      return;
    }
    this.setData({ pushingId: id });
    void (async () => {
      try {
        const result = await morningApi.pushToDesktop({
          id: card.id,
          title: card.title,
          fitNote: card.fitNote,
          targetStation: card.targetStation,
          desktopAction: card.desktopAction,
          payloadType: card.payloadType,
          evidenceAnchors: card.evidenceAnchors,
        });
        const cards = this.data.cards.map((c) => (c.id === id ? { ...c, pushed: true } : c));
        // 乐观 +1：桌面消费后的回落由 sync 的 queue.count 事件修正。
        this.setData({ cards, queueCount: this.data.queueCount + 1 });
        wx.showToast({
          title: result.desktopNotified ? '已推入，桌面将亮醒' : '已推入桌面队列',
          icon: 'success',
        });
      } catch (err) {
        wx.showToast({ title: toErrorText(err), icon: 'none' });
      } finally {
        this.setData({ pushingId: '' });
      }
    })();
  },

  onShareAppMessage() {
    return { title: 'MatrixOS 晨间早报 · 今日三卡', path: '/pages/morning/index' };
  },
});
