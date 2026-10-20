/**
 * 桌面待办队列（分包）——「手机推、桌面收」链路的手机端只读视图。
 *
 * 分工刻意不对称：手机端只能**查看与移除**，认领（claim）/完成（done）是
 * 桌面端的动作（见 apps/orbital-hub 的 QueueReceiver）。这里若也提供认领，
 * 就会有两个「谁认领了」的事实源，双端状态机打架。
 *
 * 下拉刷新调 queueApi.load()；订阅 sync 的 queue.count/claimed/done 事件，
 * 让桌面的操作实时反映到手机上。移除走 DELETE /v1/pocket/queue?id=。
 */
import { queueApi } from '../../api/index';
import type { QueueItem, QueueSnapshot } from '../../api/types';
import { toApiError } from '../../core/errors';
import { log } from '../../core/logger';
import { sync } from '../../core/sync';

type ItemView = {
  id: string;
  title: string;
  note: string;
  targetStation: string;
  stationLabel: string;
  desktopAction: string;
  payloadType: string;
  status: 'pending' | 'claimed' | 'done';
  statusText: string;
  originText: string;
  timeText: string;
  claimedText: string;
  anchorCount: number;
  receiptId: string;
};

type QueueData = {
  state: 'ready' | 'loading' | 'empty' | 'error';
  errorText: string;
  origin: 'live' | 'mock' | 'cache' | 'local';
  ageMs: number;
  desktopOnline: boolean;
  pendingCount: number;
  items: ItemView[];
  busyId: string;
};

type QueueMethods = {
  offSync: null | (() => void);
  releaseSync: null | (() => void);
  load(silent: boolean): Promise<void>;
  apply(snapshot: QueueSnapshot, origin: QueueData['origin'], ageMs: number): void;
  toView(item: QueueItem): ItemView;
  fmtTime(iso: string): string;
  detachSync(): void;
  onRemove(e: WechatMiniprogram.TapEventParam): void;
  onOpen(e: WechatMiniprogram.TapEventParam): void;
  onReconnect(): void;
  onRetry(): void;
};

const STATUS_TEXT: Record<string, string> = {
  pending: '待处理',
  claimed: '桌面已认领',
  done: '已完成',
};

const ORIGIN_TEXT: Record<string, string> = {
  morning_card: '来自早报',
  checkin_goal: '来自打卡',
  manual: '手动添加',
};

function stationLabel(domain: string): string {
  // matrix-cross.matrixos.edu → matrix-cross；已是短名则原样
  if (!domain) return '';
  return domain.split('.')[0];
}

Page<QueueData, QueueMethods>({
  data: {
    state: 'loading',
    errorText: '',
    origin: 'live',
    ageMs: 0,
    desktopOnline: false,
    pendingCount: 0,
    items: [],
    busyId: '',
  },

  offSync: null,
  releaseSync: null,

  onLoad() {
    const cached = queueApi.peekCache();
    if (cached) this.apply(cached.value, 'cache', cached.ageMs);
    void this.load(false);
  },

  onShow() {
    this.releaseSync = sync.acquire();
    this.offSync = sync.on((event) => {
      // 队列任何变化都重拉一次全量（幂等、便宜），保证与桌面最终一致。
      if (event.type === 'queue.count' || event.type === 'queue.claimed' || event.type === 'queue.done' || event.type === 'resync') {
        void this.load(true);
      }
    });
  },

  onHide() {
    this.detachSync();
  },

  onUnload() {
    this.detachSync();
  },

  detachSync() {
    if (this.offSync) this.offSync();
    if (this.releaseSync) this.releaseSync();
    this.offSync = null;
    this.releaseSync = null;
  },

  onPullDownRefresh() {
    void this.load(true).then(() => wx.stopPullDownRefresh());
  },

  async load(silent) {
    if (!silent && this.data.items.length === 0) this.setData({ state: 'loading' });
    try {
      const loaded = await queueApi.load();
      this.apply(loaded.data, loaded.origin, loaded.ageMs);
    } catch (e) {
      if (this.data.items.length > 0) return;
      this.setData({ state: 'error', errorText: toApiError(e).userMessage || '加载失败' });
    }
  },

  apply(snapshot, origin, ageMs) {
    const items = snapshot.items.map((i) => this.toView(i));
    this.setData({
      state: items.length > 0 ? 'ready' : 'empty',
      origin,
      ageMs,
      desktopOnline: snapshot.desktopOnline,
      pendingCount: snapshot.pendingCount,
      items,
      errorText: '',
    });
  },

  toView(item) {
    return {
      id: item.id,
      title: item.title,
      note: item.note,
      targetStation: item.targetStation,
      stationLabel: stationLabel(item.targetStation),
      desktopAction: item.desktopAction,
      payloadType: item.payloadType,
      status: item.status,
      statusText: STATUS_TEXT[item.status] || item.status,
      originText: ORIGIN_TEXT[item.origin] || item.origin,
      timeText: this.fmtTime(item.createdAt),
      claimedText: item.claimedAt ? this.fmtTime(item.claimedAt) : '',
      anchorCount: item.evidenceAnchors.length,
      receiptId: item.receiptId || '',
    };
  },

  fmtTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    if (min < 1440) return `${Math.round(min / 60)} 小时前`;
    return `${Math.round(min / 1440)} 天前`;
  },

  onOpen(e) {
    const id = String(e.currentTarget.dataset.id ?? '');
    if (!id) return;
    wx.navigateTo({ url: `/pkg-queue/detail/index?id=${encodeURIComponent(id)}` });
  },

  onRemove(e) {
    const id = String(e.currentTarget.dataset.id ?? '');
    const item = this.data.items.find((i) => i.id === id);
    if (!id || this.data.busyId) return;
    // catchtap 阻止冒泡到行的 onOpen。移除是破坏性动作，二次确认。
    wx.showModal({
      title: '移除这条待办？',
      content: item ? item.title : '',
      confirmText: '移除',
      confirmColor: '#fb7185',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ busyId: id });
        queueApi
          .remove(id)
          .then(() => {
            const items = this.data.items.filter((i) => i.id !== id);
            this.setData({
              items,
              state: items.length > 0 ? 'ready' : 'empty',
              pendingCount: items.filter((i) => i.status === 'pending').length,
            });
            wx.showToast({ title: '已移除', icon: 'none' });
          })
          .catch((err) => wx.showToast({ title: toApiError(err).userMessage || '移除失败', icon: 'none' }))
          .finally(() => this.setData({ busyId: '' }));
      },
      fail: (err) => log.warn('queue', `showModal 失败：${String(err.errMsg || 'unknown')}`),
    });
  },

  onReconnect() {
    sync.reconnectNow();
    wx.showToast({ title: '正在重连…', icon: 'none' });
  },

  onRetry() {
    void this.load(true);
  },
});
