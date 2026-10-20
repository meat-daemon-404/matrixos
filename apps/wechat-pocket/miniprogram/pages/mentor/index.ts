/**
 * 星门 · 导师进组进度与面试提醒页（主包）。
 *
 * 视图层骨架：消费 `mentorApi`，peekCache + load；`acknowledge()` 确认提醒；
 * `sync.on()` 订阅 `mentor.read` 由逻辑层处理，这里只负责首屏渲染与强提醒确认。
 */
import { mentorApi } from '../../api/index';
import { reportFirstPaint, log } from '../../core/logger';
import { originBadge } from '../../utils/origin';
import type { DataOrigin, MentorReminder } from '../../api/types';

type TapEvent = { currentTarget: { dataset: Record<string, string> } };

type MentorMethods = {
  refresh(): Promise<void>;
  acknowledge(e: TapEvent): Promise<void>;
};

type MentorData = {
  reminders: MentorReminder[];
  nextEventAt: string;
  syncedAt: string;
  origin: DataOrigin | null;
  ageMin: number;
  originLabel: string;
  originClass: string;
  loading: boolean;
  error: string;
};

function applyOrigin(d: Partial<MentorData>, origin: DataOrigin | null, ageMin: number): void {
  const b = originBadge(origin, ageMin);
  d.origin = origin;
  d.ageMin = ageMin;
  d.originLabel = b.label;
  d.originClass = b.cls;
}

Page<MentorData, MentorMethods>({
  data: {
    reminders: [],
    nextEventAt: '',
    syncedAt: '',
    origin: null,
    ageMin: 0,
    originLabel: '',
    originClass: '',
    loading: true,
    error: '',
  },

  onLoad() {
    const cached = mentorApi.peekCache();
    if (cached) {
      const d: Partial<MentorData> = {
        reminders: cached.value.reminders,
        nextEventAt: cached.value.nextEventAt,
        syncedAt: cached.value.syncedAt,
      };
      applyOrigin(d, 'cache', Math.round(cached.ageMs / 60000));
      d.loading = false;
      this.setData(d);
    }
    this.refresh();
  },

  onReady() {
    reportFirstPaint('pages/mentor/index');
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const loaded = await mentorApi.load();
      const v = loaded.data;
      const d: Partial<MentorData> = {
        reminders: v.reminders,
        nextEventAt: v.nextEventAt,
        syncedAt: v.syncedAt,
      };
      applyOrigin(d, loaded.origin, Math.round(loaded.ageMs / 60000));
      d.loading = false;
      this.setData(d);
    } catch (e) {
      log.warn('mentor', 'load failed', e);
      this.setData({ error: '进组提醒加载失败', loading: false });
    }
  },

  async acknowledge(e: TapEvent) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    try {
      await mentorApi.acknowledge(id);
      wx.showToast({ title: '已确认', icon: 'none' });
      this.refresh();
    } catch (err) {
      log.warn('mentor', 'acknowledge failed', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },
});
