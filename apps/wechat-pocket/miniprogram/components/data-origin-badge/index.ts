/**
 * 数据来源角标 —— ADR-09 的 UI 落点。
 *
 * 「降级不可静默」：live 之外的每一档（mock 演示 / cache 陈旧 / local 仅本机）
 * 都必须让用户看见并知道为什么。需求 §5.2 批评过原型「Toast 假装成功」，
 * 这个组件就是把「数据从哪来」变成常驻可见，而不是一次性提示。
 *
 * 类型注：observers 回调按 `(...args: unknown[]) => void` 声明，参数写成
 * `unknown` 再收窄，是为了满足 strictFunctionTypes 的逆变；显式 `this: any`
 * 是为了满足 noImplicitThis——二者都是这个包 tsconfig 开了 strict 的硬要求。
 */

type Tone = 'ok' | 'warn' | 'muted';

const ORIGIN_META: Record<string, { label: string; tone: Tone }> = {
  live: { label: '实时', tone: 'ok' },
  mock: { label: '演示数据', tone: 'warn' },
  cache: { label: '缓存', tone: 'muted' },
  local: { label: '仅本机', tone: 'muted' },
};

function ageTextOf(ageMs: number): string {
  if (!(ageMs > 0)) return '';
  const min = Math.round(ageMs / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  return `${Math.round(min / 60)} 小时前`;
}

Component({
  properties: {
    /** 来自 Loaded<T>.origin：live | mock | cache | local */
    origin: { type: String, value: 'live' },
    /** 缓存年龄（ms），origin==='cache' 时渲染「N 分钟前」 */
    ageMs: { type: Number, value: 0 },
  },

  data: {
    label: '实时',
    tone: 'ok' as Tone,
    ageText: '',
  },

  observers: {
    'origin, ageMs': function (this: any, origin: unknown, ageMs: unknown) {
      const key = typeof origin === 'string' ? origin : 'live';
      const meta = ORIGIN_META[key] || ORIGIN_META.live;
      const ms = typeof ageMs === 'number' ? ageMs : 0;
      this.setData({ label: meta.label, tone: meta.tone, ageText: key === 'cache' ? ageTextOf(ms) : '' });
    },
  },
});
