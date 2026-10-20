/**
 * 面板三态组件：loading / empty / error 统一渲染。
 *
 * 每个口袋端页面都要处理这三种非成功态；不抽出来就会各写一套、
 * 错误态的文案与「重试」入口会不一致（错误归一在 core/errors 已做，
 * UI 层也要归一）。errorText 直接吃 ApiError.userMessage，页面不自己拼。
 */
Component({
  properties: {
    /** 'loading' | 'empty' | 'error' | 'ready'（ready 时不渲染任何占位） */
    state: { type: String, value: 'ready' },
    emptyText: { type: String, value: '这里还是空的' },
    errorText: { type: String, value: '加载失败' },
    loadingText: { type: String, value: '加载中…' },
    /** 是否显示重试按钮（error 态且可重试时才为真） */
    canRetry: { type: Boolean, value: true },
  },

  methods: {
    onRetry(this: any) {
      this.triggerEvent('retry');
    },
  },
});
