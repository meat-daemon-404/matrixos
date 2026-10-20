/**
 * 桌面待办队列页（分包 queue）。
 *
 * 视图层骨架：消费 `queueApi`，peekCache + load；点条目前往详情；
 * 删除走 `remove()`。`origin` 驱动新鲜度角标。
 */
import { queueApi } from '../../api/index';
import { reportFirstPaint, log } from '../../core/logger';
import { originBadge } from '../../utils/origin';
import type { DataOrigin, QueueItem } from '../../api/types';

type TapEvent = { currentTarget: { dataset: Record<string, string> } };

type QueueMethods = {
  refresh(): Promise<void>;
  openDetail(e: TapEvent): void;
  remove(e: TapEvent): Promise<void>;
};

type QueueData = {
  items: QueueItem[];
  pendingCount: number;
  desktopOnline: boolean;
  syncedAt: string;
  origin: DataOrigin | null;
  ageMin: number;
  originLabel: string;
  originClass: string;
  loading: boolean;
  error: string;
};

function applyOrigin(d: Partial<QueueData>, origin: DataOrigin | null, ageMin: number): void {
  const b = originBadge(origin, ageMin);
  d.origin = origin;
  d.ageMin = ageMin;
  d.originLabel = b.label;
  d.originClass = b.cls;
}

Page<QueueData, QueueMethods>({
  data: {
    items: [],
    pendingCount: 0,
    desktopOnline: false,
    syncedAt: '',
    origin: null,
    ageMin: 0,
    originLabel: '',
    originClass: '',
    loading: true,
    error: '',
  },

  onLoad() {
    const cached = queueApi.peekCache();
    if (cached) {
      const d: Partial<QueueData> = {
        items: cached.value.items,
        pendingCount: cached.value.pendingCount,
        desktopOnline: cached.value.desktopOnline,
        syncedAt: cached.value.syncedAt,
      };
      applyOrigin(d, 'cache', Math.round(cached.ageMs / 60000));
      d.loading = false;
      this.setData(d);
    }
    this.refresh();
  },

  onReady() {
    reportFirstPaint('pkg-queue/queue/index');
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const loaded = await queueApi.load();
      const v = loaded.data;
      const d: Partial<QueueData> = {
        items: v.items,
        pendingCount: v.pendingCount,
        desktopOnline: v.desktopOnline,
        syncedAt: v.syncedAt,
      };
      applyOrigin(d, loaded.origin, Math.round(loaded.ageMs / 60000));
      d.loading = false;
      this.setData(d);
    } catch (e) {
      log.warn('queue', 'load failed', e);
      this.setData({ error: '队列加载失败', loading: false });
    }
  },

  openDetail(e: TapEvent) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pkg-queue/detail/index?id=' + id });
  },

  async remove(e: TapEvent) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    try {
      await queueApi.remove(id);
      wx.showToast({ title: '已移除', icon: 'none' });
      this.refresh();
    } catch (err) {
      log.warn('queue', 'remove failed', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },
});
