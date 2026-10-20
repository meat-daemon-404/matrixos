/**
 * 队列详情页（分包 detail）。
 *
 * 视图层骨架：接收 `?id=`，从队列快照里取出对应条目展示。
 * 目前仅为只读展示；落库 / 虫洞收据等写路径由 matrix-core 实现后接入。
 */
import { queueApi } from '../../api/index';
import { reportFirstPaint, log } from '../../core/logger';
import type { QueueItem } from '../../api/types';

type DetailMethods = {
  refresh(): Promise<void>;
};

type DetailData = {
  id: string;
  item: QueueItem | null;
  loading: boolean;
  error: string;
};

Page<DetailData, DetailMethods>({
  data: {
    id: '',
    item: null,
    loading: true,
    error: '',
  },

  onLoad(query: Record<string, string>) {
    const id = query.id ?? '';
    this.setData({ id });
    this.refresh();
  },

  onReady() {
    reportFirstPaint('pkg-queue/detail/index');
  },

  async refresh() {
    this.setData({ loading: true, error: '' });
    try {
      const loaded = await queueApi.load();
      const item = loaded.data.items.find((it) => it.id === this.data.id) ?? null;
      this.setData({ item, loading: false });
    } catch (e) {
      log.warn('queue-detail', 'load failed', e);
      this.setData({ error: '详情加载失败', loading: false });
    }
  },
});
