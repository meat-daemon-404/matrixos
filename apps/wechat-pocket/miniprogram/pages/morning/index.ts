/**
 * 晨间三卡早报页（主包首屏）。
 *
 * 视图层骨架：消费 `morningApi`，冷启动先 `peekCache()` 同步渲染缓存，再
 * `load()` 后台刷新；`origin` 决定「演示数据 / 缓存」角标；`onReady` 上报首屏。
 */
import { morningApi } from '../../api/index';
import { reportFirstPaint, log } from '../../core/logger';
import { originBadge } from '../../utils/origin';
import type { DataOrigin, MorningCard } from '../../api/types';

type TapEvent = { currentTarget: { dataset: Record<string, string> } };

type MorningMethods = {
  refresh(): Promise<void>;
  dismissCard(e: TapEvent): Promise<void>;
  pushToDesktop(e: TapEvent): Promise<void>;
};

type MorningData = {
  briefingDate: string;
  keywords: string[];
  cards: MorningCard[];
  desktopQueueCount: number;
  origin: DataOrigin | null;
  ageMin: number;
  originLabel: string;
  originClass: string;
  loading: boolean;
  error: string;
};

function applyOrigin(d: Partial<MorningData>, origin: DataOrigin | null, ageMin: number): void {
  const b = originBadge(origin, ageMin);
  d.origin = origin;
  d.ageMin = ageMin;
  d.originLabel = b.label;
  d.originClass = b.cls;
}

Page<MorningData, MorningMethods>({
  data: {
    briefingDate: '',
    keywords: [],
    cards: [],
    desktopQueueCount: 0,
    origin: null,
    ageMin: 0,
    originLabel: '',
    originClass: '',
    loading: true,
    error: '',
  },

  onLoad() {
    const cached = morningApi.peekCache();
    if (cached) {
      const d: Partial<MorningData> = {
        briefingDate: cached.value.briefingDate,
        keywords: cached.value.keywords,
        cards: cached.value.cards,
        desktopQueueCount: cached.value.desktopQueueCount,
      };
      applyOrigin(d, 'cache', Math.round(cached.ageMs / 60000));
      d.loading = false;
      this.setData(d);
    }
    this.refresh();
  },

  onReady() {
    reportFirstPaint('pages/morning/index');
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const loaded = await morningApi.load();
      const b = loaded.data;
      const d: Partial<MorningData> = {
        briefingDate: b.briefingDate,
        keywords: b.keywords,
        cards: b.cards,
        desktopQueueCount: b.desktopQueueCount,
      };
      applyOrigin(d, loaded.origin, Math.round(loaded.ageMs / 60000));
      d.loading = false;
      this.setData(d);
    } catch (e) {
      log.warn('morning', 'load failed', e);
      this.setData({ error: '早报加载失败，请稍后重试', loading: false });
    }
  },

  async dismissCard(e: TapEvent) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    try {
      await morningApi.dismiss(id);
      wx.showToast({ title: '已忽略', icon: 'none' });
      this.refresh();
    } catch (err) {
      log.warn('morning', 'dismiss failed', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  async pushToDesktop(e: TapEvent) {
    const id = e.currentTarget.dataset.id;
    const card = this.data.cards.find((c) => c.id === id);
    if (!card) return;
    try {
      const res = await morningApi.pushToDesktop({
        id: card.id,
        title: card.title,
        fitNote: card.fitNote,
        targetStation: card.targetStation,
        desktopAction: card.desktopAction,
        payloadType: card.payloadType,
        evidenceAnchors: card.evidenceAnchors,
      });
      wx.showToast({
        title: res.desktopNotified ? '已推送到电脑端' : '已写入本地队列',
        icon: 'none',
      });
    } catch (err) {
      log.warn('morning', 'pushToDesktop failed', err);
      wx.showToast({ title: '推送失败', icon: 'none' });
    }
  },
});
