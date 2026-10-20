/**
 * 待办详情（分包）—— 单条队列条目的完整证据视图。
 *
 * 为什么没有 GET /v1/pocket/queue/{id}：契约（api/index.ts 端点表）里
 * 只有列表端点。详情页从 `queueApi.load()` 的快照里按 id 取那一条——
 * 快照本身 < 100 条且带缓存，多一次全量读比新增一条端点更划算，
 * 也更接近「桌面/手机看的是同一份队列」的事实。拿不到就如实显示已移除。
 */
import { queueApi } from '../../api/index';
import type { QueueItem, VerificationLevel } from '../../api/types';
import { toApiError } from '../../core/errors';

type AnchorView = {
  key: string;
  ref: string;
  level: VerificationLevel;
  levelText: string;
  pageText: string;
  bboxText: string;
};

type DetailData = {
  state: 'ready' | 'loading' | 'empty' | 'error';
  errorText: string;
  origin: 'live' | 'mock' | 'cache' | 'local';
  title: string;
  note: string;
  stationLabel: string;
  targetStation: string;
  desktopAction: string;
  payloadType: string;
  statusText: string;
  status: 'pending' | 'claimed' | 'done';
  createdAtText: string;
  claimedText: string;
  originText: string;
  receiptId: string;
  anchors: AnchorView[];
};

type DetailMethods = {
  id: string;
  load(): Promise<void>;
  fill(item: QueueItem, origin: DetailData['origin']): void;
  toAnchors(item: QueueItem): AnchorView[];
  fmtTime(iso: string): string;
  onCopy(e: WechatMiniprogram.TapEventParam): void;
  onRetry(): void;
};

const STATUS_TEXT: Record<string, string> = {
  pending: '待处理',
  claimed: '桌面已认领',
  done: '已完成',
};

const ORIGIN_TEXT: Record<string, string> = {
  morning_card: '来自晨间早报',
  checkin_goal: '来自打卡目标',
  manual: '手动添加',
};

const LEVEL_TEXT: Record<VerificationLevel, string> = {
  Level_A_Verified: '已验真',
  Level_B_Preprint: '预印本',
  Retracted_Warning: '撤稿警示',
};

Page<DetailData, DetailMethods>({
  data: {
    state: 'loading',
    errorText: '',
    origin: 'live',
    title: '',
    note: '',
    stationLabel: '',
    targetStation: '',
    desktopAction: '',
    payloadType: '',
    statusText: '',
    status: 'pending',
    createdAtText: '',
    claimedText: '',
    originText: '',
    receiptId: '',
    anchors: [],
  },

  id: '',

  onLoad(query: Record<string, string>) {
    this.id = query.id || '';
    void this.load();
  },

  onPullDownRefresh() {
    void this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (!this.id) {
      this.setData({ state: 'error', errorText: '缺少待办 id' });
      return;
    }
    try {
      const loaded = await queueApi.load();
      const item = loaded.data.items.find((i) => i.id === this.id);
      if (!item) {
        this.setData({ state: 'empty', errorText: '这条待办可能已被移除' });
        return;
      }
      this.fill(item, loaded.origin);
    } catch (e) {
      this.setData({ state: 'error', errorText: toApiError(e).userMessage || '加载失败' });
    }
  },

  fill(item, origin) {
    this.setData({
      state: 'ready',
      origin,
      title: item.title,
      note: item.note,
      stationLabel: item.targetStation.split('.')[0],
      targetStation: item.targetStation,
      desktopAction: item.desktopAction,
      payloadType: item.payloadType,
      status: item.status,
      statusText: STATUS_TEXT[item.status] || item.status,
      createdAtText: this.fmtTime(item.createdAt),
      claimedText: item.claimedAt ? this.fmtTime(item.claimedAt) : '',
      originText: ORIGIN_TEXT[item.origin] || item.origin,
      receiptId: item.receiptId || '',
      anchors: this.toAnchors(item),
      errorText: '',
    });
  },

  toAnchors(item) {
    return item.evidenceAnchors.map((a, i) => {
      const bboxText = a.bbox
        ? `[${a.bbox.map((n) => Math.round(n * 10) / 10).join(', ')}]`
        : '';
      return {
        key: `${a.source_doi_or_url}-${i}`,
        ref: a.source_doi_or_url,
        level: a.verification_level,
        levelText: LEVEL_TEXT[a.verification_level] || a.verification_level,
        pageText: a.pdf_page ? `第 ${a.pdf_page} 页` : '',
        bboxText,
      };
    });
  },

  fmtTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const d = new Date(t);
    const p = (n: number) => (n < 10 ? `0${n}` : String(n));
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  onCopy(e) {
    const ref = String(e.currentTarget.dataset.ref ?? '');
    if (!ref) return;
    wx.setClipboardData({
      data: ref,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  onRetry() {
    void this.load();
  },
});
