/**
 * 学业微目标每日打卡 —— 口袋端把「桌面干的活」拉回手机碎片时间的落点。
 *
 * kind==='desktop' 的目标（如「晚 20:00 电脑端跑拟合」）在手机上**只能标记、
 * 不能执行**——UI 要如实说明这一点，而不是假装手机能做。
 * 打卡走 REST `POST/DELETE /v1/pocket/checkin`（对称可逆）；乐观更新后
 * 静默重拉一次校准 streak/week/termDays，服务端是唯一事实源。
 */
import { checkinApi } from '../../api/index';
import type { CheckinDay, GoalKind, MicroGoal } from '../../api/types';
import { toApiError } from '../../core/errors';
import { sync } from '../../core/sync';

type GoalView = {
  id: string;
  title: string;
  note: string;
  kind: GoalKind;
  kindText: string;
  needsDesktop: boolean;
  target: string;
  done: boolean;
};

type WeekCell = { on: boolean; label: string };

type CheckinData = {
  state: 'ready' | 'loading' | 'empty' | 'error';
  errorText: string;
  origin: 'live' | 'mock' | 'cache' | 'local';
  ageMs: number;
  date: string;
  streak: number;
  termDays: number;
  termTarget: number;
  termPct: number;
  week: WeekCell[];
  goals: GoalView[];
  busyId: string;
};

type CheckinMethods = {
  offSync: null | (() => void);
  releaseSync: null | (() => void);
  load(silent: boolean): Promise<void>;
  applyDay(day: CheckinDay, origin: CheckinData['origin'], ageMs: number): void;
  toGoalView(goal: MicroGoal): GoalView;
  detachSync(): void;
  onToggle(e: WechatMiniprogram.TapEventParam): void;
  onRetry(): void;
};

const KIND_TEXT: Record<GoalKind, string> = {
  study: '学习',
  research: '科研',
  desktop: '需开电脑',
};

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function todayKey(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function weekdayLabelsFor(today: string): string[] {
  // week 数组是「旧→新」的近 7 天，最后一格=今天；按今天的星期倒推标签。
  const base = new Date(`${today}T00:00:00`);
  const out: string[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() - i);
    const idx = (d.getDay() + 6) % 7; // 周一=0
    out.push(WEEK_LABELS[idx] || '');
  }
  return out;
}

Page<CheckinData, CheckinMethods>({
  data: {
    state: 'loading',
    errorText: '',
    origin: 'live',
    ageMs: 0,
    date: '',
    streak: 0,
    termDays: 0,
    termTarget: 60,
    termPct: 0,
    week: [],
    goals: [],
    busyId: '',
  },

  offSync: null,
  releaseSync: null,

  onLoad() {
    void this.load(false);
  },

  onShow() {
    this.releaseSync = sync.acquire();
    this.offSync = sync.on((event) => {
      // 桌面端改了同一份台账时（resync 由 WS 鉴权/断线重连触发）静默校准。
      if (event.type === 'resync') void this.load(true);
    });
  },

  onHide() {
    this.detachSync();
  },

  onUnload() {
    this.detachSync();
  },

  onPullDownRefresh() {
    void this.load(true).then(() => wx.stopPullDownRefresh());
  },

  detachSync() {
    if (this.offSync) this.offSync();
    if (this.releaseSync) this.releaseSync();
    this.offSync = null;
    this.releaseSync = null;
  },

  async load(silent) {
    if (!silent && this.data.goals.length === 0) this.setData({ state: 'loading' });
    try {
      const loaded = await checkinApi.load();
      this.applyDay(loaded.data, loaded.origin, loaded.ageMs);
    } catch (e) {
      if (this.data.goals.length > 0) return; // 屏上有数据就只丢后台刷新，不清空
      this.setData({ state: 'error', errorText: toApiError(e).userMessage || '加载失败' });
    }
  },

  applyDay(day, origin, ageMs) {
    const labels = weekdayLabelsFor(day.date);
    this.setData({
      state: day.goals.length > 0 ? 'ready' : 'empty',
      origin,
      ageMs,
      date: day.date,
      streak: day.streak,
      termDays: day.termDays,
      termTarget: day.termTarget,
      termPct: day.termTarget > 0 ? Math.min(100, Math.round((day.termDays / day.termTarget) * 100)) : 0,
      week: day.week.map((on, i) => ({ on, label: labels[i] || '' })),
      goals: day.goals.map((g) => this.toGoalView(g)),
      errorText: '',
    });
  },

  toGoalView(goal) {
    return {
      id: goal.id,
      title: goal.title,
      note: goal.note || '',
      kind: goal.kind,
      kindText: KIND_TEXT[goal.kind] || goal.kind,
      needsDesktop: goal.kind === 'desktop',
      target: goal.target || '',
      done: goal.done,
    };
  },

  onToggle(e) {
    const id = String(e.currentTarget.dataset.id ?? '');
    const goal = this.data.goals.find((g) => g.id === id);
    if (!goal || this.data.busyId) return;
    const nextDone = !goal.done;
    // 乐观翻转，失败回滚，成功后静默重拉校准 streak/week。
    const goals = this.data.goals.map((g) => (g.id === id ? { ...g, done: nextDone } : g));
    this.setData({ goals, busyId: id });
    void (async () => {
      try {
        await checkinApi.toggle(id, this.data.date || todayKey(), nextDone);
        if (nextDone) wx.showToast({ title: '打卡成功', icon: 'success' });
        await this.load(true);
      } catch (err) {
        const rolled = this.data.goals.map((g) => (g.id === id ? { ...g, done: goal.done } : g));
        this.setData({ goals: rolled });
        wx.showToast({ title: toApiError(err).userMessage || '操作失败', icon: 'none' });
      } finally {
        this.setData({ busyId: '' });
      }
    })();
  },

  onRetry() {
    void this.load(true);
  },
});
