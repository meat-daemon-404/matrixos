/**
 * 学业微目标每日打卡页（主包）。
 *
 * 视图层骨架：消费 `checkinApi`，peekCache 先渲染再 load 刷新；
 * 打卡/取消走 `toggle()`；`origin` 驱动新鲜度角标。
 */
import { checkinApi } from '../../api/index';
import { reportFirstPaint, log } from '../../core/logger';
import { originBadge } from '../../utils/origin';
import type { DataOrigin, MicroGoal } from '../../api/types';

type TapEvent = { currentTarget: { dataset: Record<string, string> } };

type CheckinMethods = {
  refresh(): Promise<void>;
  toggle(e: TapEvent): Promise<void>;
};

type CheckinData = {
  date: string;
  goals: MicroGoal[];
  streak: number;
  week: boolean[];
  termDays: number;
  termTarget: number;
  origin: DataOrigin | null;
  ageMin: number;
  originLabel: string;
  originClass: string;
  loading: boolean;
  error: string;
};

function applyOrigin(d: Partial<CheckinData>, origin: DataOrigin | null, ageMin: number): void {
  const b = originBadge(origin, ageMin);
  d.origin = origin;
  d.ageMin = ageMin;
  d.originLabel = b.label;
  d.originClass = b.cls;
}

Page<CheckinData, CheckinMethods>({
  data: {
    date: '',
    goals: [],
    streak: 0,
    week: [],
    termDays: 0,
    termTarget: 0,
    origin: null,
    ageMin: 0,
    originLabel: '',
    originClass: '',
    loading: true,
    error: '',
  },

  onLoad() {
    const cached = checkinApi.peekCache();
    if (cached) {
      const d: Partial<CheckinData> = {
        date: cached.value.date,
        goals: cached.value.goals,
        streak: cached.value.streak,
        week: cached.value.week,
        termDays: cached.value.termDays,
        termTarget: cached.value.termTarget,
      };
      applyOrigin(d, 'cache', Math.round(cached.ageMs / 60000));
      d.loading = false;
      this.setData(d);
    }
    this.refresh();
  },

  onReady() {
    reportFirstPaint('pages/checkin/index');
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const loaded = await checkinApi.load();
      const v = loaded.data;
      const d: Partial<CheckinData> = {
        date: v.date,
        goals: v.goals,
        streak: v.streak,
        week: v.week,
        termDays: v.termDays,
        termTarget: v.termTarget,
      };
      applyOrigin(d, loaded.origin, Math.round(loaded.ageMs / 60000));
      d.loading = false;
      this.setData(d);
    } catch (e) {
      log.warn('checkin', 'load failed', e);
      this.setData({ error: '打卡数据加载失败', loading: false });
    }
  },

  async toggle(e: TapEvent) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const goal = this.data.goals.find((g) => g.id === id);
    if (!goal) return;
    try {
      await checkinApi.toggle(id, this.data.date, !goal.done);
      wx.showToast({ title: goal.done ? '已取消打卡' : '已打卡', icon: 'none' });
      this.refresh();
    } catch (err) {
      log.warn('checkin', 'toggle failed', err);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },
});
