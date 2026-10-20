/**
 * 全息数字孪生学术名片页（主包，扫码落地）。
 *
 * 视图层骨架：消费 `cardApi` 拉名片；用仓库自带的零依赖 `qr.ts` 编码器把
 * `qrPayload` 画成可扫二维码（离线可扫，契合名片场景）；`origin` 驱动角标。
 */
import { cardApi } from '../../api/index';
import { reportFirstPaint, log } from '../../core/logger';
import { originBadge } from '../../utils/origin';
import { encodeQr, drawQrToCanvas } from '../../utils/qr';
import type {
  CardEvidence,
  CardMetric,
  DataOrigin,
  VerificationLevel,
} from '../../api/types';

type CardMethods = {
  refresh(): Promise<void>;
  drawQr(): void;
};

/** 老式 canvas-id 上下文的最小形状（wx.d.ts 把 createCanvasContext 收窄成 unknown）。 */
type LegacyCanvasCtx = {
  fillStyle: string;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  draw: () => void;
};

const QR_SIZE = 200;

type CardData = {
  matrixUid: string;
  displayName: string;
  subtitle: string;
  school: string;
  major: string;
  grade: string;
  qrPayload: string;
  metrics: CardMetric[];
  evidences: CardEvidence[];
  verificationLevel: VerificationLevel;
  updatedAt: string;
  origin: DataOrigin | null;
  ageMin: number;
  originLabel: string;
  originClass: string;
  loading: boolean;
  error: string;
  qrError: string;
};

function applyOrigin(d: Partial<CardData>, origin: DataOrigin | null, ageMin: number): void {
  const b = originBadge(origin, ageMin);
  d.origin = origin;
  d.ageMin = ageMin;
  d.originLabel = b.label;
  d.originClass = b.cls;
}

Page<CardData, CardMethods>({
  data: {
    matrixUid: '',
    displayName: '',
    subtitle: '',
    school: '',
    major: '',
    grade: '',
    qrPayload: '',
    metrics: [],
    evidences: [],
    verificationLevel: 'Level_B_Preprint',
    updatedAt: '',
    origin: null,
    ageMin: 0,
    originLabel: '',
    originClass: '',
    loading: true,
    error: '',
    qrError: '',
  },

  onLoad() {
    const cached = cardApi.peekCache();
    if (cached) {
      const d: Partial<CardData> = { ...flatten(cached.value) };
      applyOrigin(d, 'cache', Math.round(cached.ageMs / 60000));
      d.loading = false;
      this.setData(d);
      this.drawQr();
    }
    this.refresh();
  },

  onReady() {
    reportFirstPaint('pages/card/index');
  },

  async refresh() {
    this.setData({ loading: true, error: '', qrError: '' });
    try {
      const loaded = await cardApi.load();
      const v = loaded.data;
      const d: Partial<CardData> = { ...flatten(v) };
      applyOrigin(d, loaded.origin, Math.round(loaded.ageMs / 60000));
      d.loading = false;
      this.setData(d);
      this.drawQr();
    } catch (e) {
      log.warn('card', 'load failed', e);
      this.setData({ error: '名片加载失败', loading: false });
    }
  },

  drawQr() {
    const payload = this.data.qrPayload;
    if (!payload) return;
    try {
      const matrix = encodeQr(payload, 'M');
      const ctx = wx.createCanvasContext('qrCanvas') as unknown as LegacyCanvasCtx;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, QR_SIZE, QR_SIZE);
      drawQrToCanvas(ctx, matrix, {
        size: QR_SIZE,
        dark: '#0b1124',
        light: '#ffffff',
        quietZone: 4,
      });
      ctx.draw();
    } catch (e) {
      log.warn('card', 'qr draw failed', e);
      this.setData({ qrError: '二维码生成失败（内容过长或编码器不支持）' });
    }
  },
});

function flatten(card: {
  matrixUid: string;
  displayName: string;
  subtitle: string;
  school: string;
  major: string;
  grade: string;
  qrPayload: string;
  metrics: CardMetric[];
  evidences: CardEvidence[];
  verificationLevel: VerificationLevel;
  updatedAt: string;
}): CardData {
  return {
    matrixUid: card.matrixUid,
    displayName: card.displayName,
    subtitle: card.subtitle,
    school: card.school,
    major: card.major,
    grade: card.grade,
    qrPayload: card.qrPayload,
    metrics: card.metrics,
    evidences: card.evidences,
    verificationLevel: card.verificationLevel,
    updatedAt: card.updatedAt,
    origin: null,
    ageMin: 0,
    originLabel: '',
    originClass: '',
    loading: true,
    error: '',
    qrError: '',
  };
}
