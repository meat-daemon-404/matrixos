/**
 * 数据新鲜度角标。
 *
 * ADR-09 硬性要求：mock / 缓存 / 本地回填都属于「非实时数据」，必须在 UI 上
 * 显式标注，禁止静默降级。页面拿到 `origin` 后统一走这里生成展示文案与样式类，
 * 避免每个页面各写一套判断。
 */
import type { DataOrigin } from '../api/types';

export interface OriginBadge {
  label: string;
  cls: string;
}

export function originBadge(origin: DataOrigin | null, ageMin: number): OriginBadge {
  switch (origin) {
    case 'mock':
      return { label: '演示数据', cls: 'badge-demo' };
    case 'cache':
      return { label: `缓存约 ${ageMin} 分钟前`, cls: 'badge-cache' };
    case 'local':
      return { label: '本地数据', cls: 'badge-local' };
    case 'live':
      return { label: '已同步', cls: 'badge-live' };
    default:
      return { label: '', cls: '' };
  }
}
