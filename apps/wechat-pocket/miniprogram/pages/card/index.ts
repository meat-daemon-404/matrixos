/**
 * 全息数字孪生学术名片 —— 口袋端的「可验真门面」。
 *
 * 三条项目红线在这一页都要守住：
 *   1. **验真等级 = 最弱一环**（服务端已算好，UI 只呈现，不粉饰）；
 *   2. 每条证据的 DOI 可长按复制，用于第三方在 Crossref 独立复核；
 *   3. 二维码内容就是服务端给的 `qrPayload`（含 matrix_uid 的落地页），
 *      前端**不改写、不拼参数**——伪造落地页等于伪造验真入口。
 *
 * 二维码渲染用 Canvas 2D：`node.width = cssPx × dpr`，绘制尺寸直接用设备像素，
 * 免去 ctx.scale()（本端 wx.d.ts 刻意不声明 scale，少一个假 SDK 面）。
 * 编码本身走 `utils/qr.ts`（零依赖、有自测），不引第三方。
 */
import { cardApi } from '../../api/index';
import type { AcademicCard, VerificationLevel } from '../../api/types';
import { toApiError } from '../../core/errors';
import { encodeQr, drawQrToCanvas } from '../../utils/qr';

const QR_CSS_PX = 220;

type MetricView = { label: string; value: string; hint: string };
type EvidenceView = {
  id: string;
  kind: string;
  kindText: string;
  label: string;
  ref: string;
  verification: VerificationLevel;
  verificationText: string;
  verifiedNote: string;
};

type CardData = {
  state: 'ready' | 'loading' | 'empty' | 'error';
  errorText: string;
  origin: 'live' | 'mock' | 'cache' | 'local';
  ageMs: number;
  displayName: string;
  subtitle: string;
  schoolLine: string;
  levelText: string;
  levelTone: 'ok' | 'mid' | 'warn';
  updatedAtText: string;
  metrics: MetricView[];
  evidences: EvidenceView[];
  qrReady: boolean;
  qrError: string;
};

type CardMethods = {
  raw: AcademicCard | null;
  load(): Promise<void>;
  apply(card: AcademicCard, origin: CardData['origin'], ageMs: number): void;
  paintQr(payload: string): void;
  onCopyRef(e: WechatMiniprogram.TapEventParam): void;
  onRetry(): void;
};

const KIND_TEXT: Record<string, string> = {
  doi: 'DOI',
  github: '代码',
  patent: '专利',
  competition: '竞赛',
};

const LEVEL_TEXT: Record<VerificationLevel, { text: string; tone: 'ok' | 'mid' | 'warn' }> = {
  Level_A_Verified: { text: '全部验真', tone: 'ok' },
  Level_B_Preprint: { text: '含预印本', tone: 'mid' },
  Retracted_Warning: { text: '含撤稿警示', tone: 'warn' },
};

function fmtUpdated(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

Page<CardData, CardMethods>({
  data: {
    state: 'loading',
    errorText: '',
    origin: 'live',
    ageMs: 0,
    displayName: '',
    subtitle: '',
    schoolLine: '',
    levelText: '',
    levelTone: 'mid',
    updatedAtText: '',
    metrics: [],
    evidences: [],
    qrReady: false,
    qrError: '',
  },

  raw: null,

  onLoad() {
    void this.load();
  },

  onPullDownRefresh() {
    void this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const cached = cardApi.peekCache();
      if (cached) this.apply(cached.value, 'cache', cached.ageMs);
      const loaded = await cardApi.load();
      this.apply(loaded.data, loaded.origin, loaded.ageMs);
    } catch (e) {
      if (this.raw) return;
      this.setData({ state: 'error', errorText: toApiError(e).userMessage || '加载失败' });
    }
  },

  apply(card, origin, ageMs) {
    this.raw = card;
    const level = LEVEL_TEXT[card.verificationLevel] || LEVEL_TEXT.Level_B_Preprint;
    this.setData({
      state: 'ready',
      origin,
      ageMs,
      displayName: card.displayName,
      subtitle: card.subtitle,
      schoolLine: [card.school, card.major, card.grade].filter(Boolean).join(' · '),
      levelText: level.text,
      levelTone: level.tone,
      updatedAtText: fmtUpdated(card.updatedAt),
      metrics: card.metrics.map((m) => ({ label: m.label, value: m.value, hint: m.hint || '' })),
      evidences: card.evidences.map((ev, i) => ({
        id: `${ev.ref}-${i}`,
        kind: ev.kind,
        kindText: KIND_TEXT[ev.kind] || ev.kind,
        label: ev.label,
        ref: ev.ref,
        verification: ev.verification,
        verificationText: (LEVEL_TEXT[ev.verification] || { text: ev.verification }).text,
        verifiedNote: ev.verifiedNote || '',
      })),
      errorText: '',
    });
    this.paintQr(cardApi.qrPayloadOf(card));
  },

  paintQr(payload) {
    this.setData({ qrReady: false, qrError: '' });
    if (!payload) {
      this.setData({ qrError: '名片缺少二维码内容' });
      return;
    }
    let matrix;
    try {
      matrix = encodeQr(payload, 'M');
    } catch (e) {
      // 内容超出编码器支持的版本：如实显示，不画半张假码
      this.setData({ qrError: `二维码生成失败：${String((e as Error).message || e)}` });
      return;
    }

    const query = wx.createSelectorQuery();
    query
      .select('#qr-canvas')
      .fields({ node: true, size: true }, (res) => {
        const node = res && res.node;
        if (!node) {
          this.setData({ qrError: '画布尚未就绪' });
          return;
        }
        let dpr = 2;
        try {
          dpr = wx.getSystemInfoSync().pixelRatio || 2;
        } catch (e) {
          dpr = 2;
        }
        const px = Math.round(QR_CSS_PX * dpr);
        node.width = px;
        node.height = px;
        const ctx = node.getContext('2d');
        // 绘制尺寸直接用设备像素（不依赖 ctx.scale）；白底是扫码对比度要求，
        // 深色主题下二维码必须是浅底深码，反过来大多数扫码器不识别。
        drawQrToCanvas(ctx, matrix, { size: px, dark: '#0b1124', light: '#ffffff' });
        this.setData({ qrReady: true });
      })
      .exec();
  },

  onCopyRef(e) {
    const ref = String(e.currentTarget.dataset.ref ?? '');
    if (!ref) return;
    wx.setClipboardData({
      data: ref,
      success: () => wx.showToast({ title: '已复制，可在 Crossref 复核', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    });
  },

  onRetry() {
    void this.load();
  },

  onShareAppMessage() {
    const name = this.raw ? this.raw.displayName : 'MatrixOS';
    return { title: `${name} 的学术名片 · 每条经历可验真`, path: '/pages/card/index' };
  },
});
