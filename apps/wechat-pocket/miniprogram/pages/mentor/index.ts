/**
 * 星门导师进组提醒 —— S2-20「面试前 24h/1h 强提醒 + 3 页提纲」的口袋端半边。
 *
 * 与 lab-kanban 的状态机同源（已发信→已读→待面试→已进组），
 * 但**状态推进只能由桌面/lab-kanban 触发**——手机这里只做「确认提醒」与阅读，
 * 不能在这里跳阶段（服务端会 409；UI 干脆不提供入口，避免误导）。
 *
 * 倒计时：nextEventAt 每秒重算一次。定时器随 onShow/onHide 起停——
 * 小程序切后台会被冻结，回来时如果不清理会叠出多个 interval。
 */
import { mentorApi } from '../../api/index';
import type { MentorBoard, MentorReminder, VerificationLevel } from '../../api/types';
import { toApiError } from '../../core/errors';
import { reportFirstPaint } from '../../core/logger';
import { sync } from '../../core/sync';

type AnchorView = { ref: string; level: VerificationLevel; levelText: string; pageText: string };

type OutlinePage = { page: number; title: string; pointsText: string };

type ReminderView = {
  id: string;
  mentorName: string;
  mentorTitle: string;
  lab: string;
  stage: string;
  stageText: string;
  stageIdx: number;
  stageTotal: number;
  location: string;
  readReceipt: boolean;
  acknowledged: boolean;
  matchScore: number;
  countdown: string;
  hasEvent: boolean;
  urgent: boolean;
  /** 原始 ISO 时刻，供每秒 tick 重算倒计时（不进 data 也没关系，这里必须声明）。 */
  rawStartsAt: string;
  anchors: AnchorView[];
  outline: OutlinePage[];
  outlineOpen: boolean;
};

type MentorData = {
  state: 'ready' | 'loading' | 'empty' | 'error';
  errorText: string;
  origin: 'live' | 'mock' | 'cache' | 'local';
  ageMs: number;
  nextEventText: string;
  syncedAtText: string;
  reminders: ReminderView[];
  busyId: string;
};

type MentorMethods = {
  offSync: null | (() => void);
  releaseSync: null | (() => void);
  tickTimer: null | ReturnType<typeof setInterval>;
  load(silent: boolean): Promise<void>;
  applyBoard(board: MentorBoard, origin: MentorData['origin'], ageMs: number): void;
  toView(r: MentorReminder, expanded: boolean): ReminderView;
  fmtCountdown(iso: string): { text: string; urgent: boolean };
  startTicker(): void;
  stopTicker(): void;
  detachSync(): void;
  onAck(e: WechatMiniprogram.TapEventParam): void;
  onToggleOutline(e: WechatMiniprogram.TapEventParam): void;
  onRetry(): void;
};

const STAGES = ['email_sent', 'email_read', 'interview_scheduled', 'interview_passed', 'joined'];

const LEVEL_TEXT: Record<VerificationLevel, string> = {
  Level_A_Verified: '已验真',
  Level_B_Preprint: '预印本',
  Retracted_Warning: '撤稿警示',
};

function daysAgoText(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  return `${Math.round(min / 60)} 小时前`;
}

Page<MentorData, MentorMethods>({
  data: {
    state: 'loading',
    errorText: '',
    origin: 'live',
    ageMs: 0,
    nextEventText: '',
    syncedAtText: '',
    reminders: [],
    busyId: '',
  },

  offSync: null,
  releaseSync: null,
  tickTimer: null,

  onLoad() {
    const cached = mentorApi.peekCache();
    if (cached) this.applyBoard(cached.value, 'cache', cached.ageMs);
    void this.load(false);
  },

  onShow() {
    this.releaseSync = sync.acquire();
    this.offSync = sync.on((event) => {
      if (event.type === 'mentor.read' || event.type === 'resync') void this.load(true);
      if (event.type === 'mentor.stage') void this.load(true);
    });
    this.startTicker();
  },

  /** 首屏可交互时打点，度量冷启动是否在 COLD_START_BUDGET_MS 预算内。 */
  onReady() {
    reportFirstPaint('pages/mentor/index');
  },

  onHide() {
    this.detachSync();
    this.stopTicker();
  },

  onUnload() {
    this.detachSync();
    this.stopTicker();
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

  startTicker() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      const reminders = this.data.reminders.map((r) => {
        if (!r.hasEvent) return r;
        const c = this.fmtCountdown(r.rawStartsAt || '');
        return { ...r, countdown: c.text, urgent: c.urgent };
      });
      this.setData({ reminders });
    }, 1000);
  },

  stopTicker() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  },

  async load(silent) {
    if (!silent && this.data.reminders.length === 0) this.setData({ state: 'loading' });
    try {
      const loaded = await mentorApi.load();
      this.applyBoard(loaded.data, loaded.origin, loaded.ageMs);
    } catch (e) {
      if (this.data.reminders.length > 0) return;
      this.setData({ state: 'error', errorText: toApiError(e).userMessage || '加载失败' });
    }
  },

  applyBoard(board, origin, ageMs) {
    // 展开状态按 id 保留：重拉/每秒 tick 不应把用户展开的提纲合上。
    const openIds = new Set(
      this.data.reminders.filter((r) => r.outlineOpen).map((r) => r.id),
    );
    const reminders = board.reminders.map((r) => this.toView(r, openIds.has(r.id)));
    const next = this.fmtCountdown(board.nextEventAt);
    this.setData({
      state: reminders.length > 0 ? 'ready' : 'empty',
      origin,
      ageMs,
      reminders,
      nextEventText: board.nextEventAt ? `${next.text}` : '',
      syncedAtText: daysAgoText(board.syncedAt),
      errorText: '',
    });
  },

  toView(r, expanded) {
    const c = this.fmtCountdown(r.startsAt);
    return {
      id: r.id,
      mentorName: r.mentorName,
      mentorTitle: r.mentorTitle,
      lab: r.lab,
      stage: r.stage,
      stageText: r.stageLabel,
      stageIdx: Math.max(0, STAGES.indexOf(r.stage)),
      stageTotal: STAGES.length,
      location: r.location,
      readReceipt: r.readReceipt,
      acknowledged: r.acknowledged,
      matchScore: r.matchScore,
      countdown: c.text,
      hasEvent: Boolean(r.startsAt),
      urgent: c.urgent,
      rawStartsAt: r.startsAt,
      anchors: r.evidenceAnchors.map((a) => ({
        ref: a.source_doi_or_url,
        level: a.verification_level,
        levelText: LEVEL_TEXT[a.verification_level] || a.verification_level,
        pageText: a.pdf_page ? `P${a.pdf_page}` : '',
      })),
      outline: (r.outline || []).map((p) => ({
        page: p.page,
        title: p.title,
        pointsText: (p.points || []).join(' · '),
      })),
      outlineOpen: expanded,
    };
  },

  fmtCountdown(iso) {
    if (!iso) return { text: '', urgent: false };
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return { text: '', urgent: false };
    const diff = t - Date.now();
    if (diff <= 0) return { text: '进行中 / 已开始', urgent: true };
    const min = Math.round(diff / 60000);
    if (min < 60) return { text: `${min} 分钟后`, urgent: min <= 60 };
    const hr = Math.round(min / 60);
    if (hr < 48) return { text: `${hr} 小时后`, urgent: hr <= 24 };
    return { text: `${Math.round(hr / 24)} 天后`, urgent: false };
  },

  onToggleOutline(e) {
    const id = String(e.currentTarget.dataset.id ?? '');
    const reminders = this.data.reminders.map((r) =>
      r.id === id ? { ...r, outlineOpen: !r.outlineOpen } : r,
    );
    this.setData({ reminders });
  },

  onAck(e) {
    const id = String(e.currentTarget.dataset.id ?? '');
    if (!id || this.data.busyId) return;
    this.setData({ busyId: id });
    void (async () => {
      try {
        await mentorApi.acknowledge(id);
        const reminders = this.data.reminders.map((r) =>
          r.id === id ? { ...r, acknowledged: true } : r,
        );
        this.setData({ reminders });
        wx.showToast({ title: '已确认，不再重复提醒', icon: 'none' });
      } catch (err) {
        wx.showToast({ title: toApiError(err).userMessage || '确认失败', icon: 'none' });
      } finally {
        this.setData({ busyId: '' });
      }
    })();
  },

  onRetry() {
    void this.load(true);
  },
});
