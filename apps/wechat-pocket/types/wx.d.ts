/**
 * MatrixOS 口袋端 —— 全局类型声明。
 *
 * 小程序没有 `@types/wechat-miniprogram` 依赖（铁律：不执行安装），
 * 因此这里按官方文档手写最小可用的 `wx` 声明面。
 * 只声明本项目真正用到的 API，避免造一份假的完整 SDK。
 */

declare namespace WechatMiniprogram {
  interface CallbackOptions<T> {
    success?: (res: T) => void;
    fail?: (err: ErrnoError) => void;
    complete?: (res: unknown) => void;
  }

  /** 微信回调风格错误的统一形状（非官方完整定义，仅本端所需字段）。 */
  interface ErrnoError {
    errMsg?: string;
    errno?: number;
    errCode?: number;
    [key: string]: unknown;
  }

  interface RequestSuccess {
    data: unknown;
    statusCode: number;
    header: Record<string, string>;
    cookies: string[];
    profile?: { [key: string]: unknown };
  }

  interface SocketTask {
    send(opts: CallbackOptions<unknown> & { data: string | ArrayBuffer }): void;
    close(opts?: CallbackOptions<unknown> & { code?: number; reason?: string }): void;
    onOpen(cb: () => void): void;
    onClose(cb: (res: { code: number; reason: string }) => void): void;
    onError(cb: (err: ErrnoError) => void): void;
    onMessage(cb: (res: { data: string | ArrayBuffer }) => void): void;
  }

  interface AsyncStorageSuccess<T> {
    data: T;
    errMsg: string;
  }
}

declare const wx: {
  // ---------- 生命周期 / 环境 ----------
  getSystemInfoSync(): {
    windowWidth: number;
    windowHeight: number;
    pixelRatio: number;
    platform: string;
    system: string;
    SDKVersion: string;
    safeArea?: { top: number; bottom: number; left: number; right: number; height: number; width: number };
    statusBarHeight?: number;
  };
  getWindowInfo(): {
    windowWidth: number;
    windowHeight: number;
    pixelRatio: number;
    statusBarHeight: number;
    safeArea?: { top: number; bottom: number; left: number; right: number; height: number; width: number };
  };
  getDeviceInfo(): { platform: string; system: string; brand: string; model: string };
  getAppBaseInfo(): { SDKVersion: string; version: string; language: string };
  getLaunchOptionsSync(): { scene?: number; query?: Record<string, string>; path?: string };
  onAppShow(cb: (res: { scene?: number; query?: Record<string, string> }) => void): void;
  onAppHide(cb: () => void): void;
  onError(cb: (err: string) => void): void;
  onUnhandledRejection(cb: (res: { reason: unknown; promise: unknown }) => void): void;
  nextTick(cb: () => void): void;

  // ---------- 存储 ----------
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  getStorageInfoSync?(): { keys: string[]; currentSize: number; limitSize: number };

  // ---------- 网络 ----------
  request(opts: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    data?: unknown;
    header?: Record<string, string>;
    timeout?: number;
    dataType?: string;
    responseType?: 'text' | 'arraybuffer';
  } & WechatMiniprogram.CallbackOptions<WechatMiniprogram.RequestSuccess>): unknown;
  connectSocket(opts: {
    url: string;
    header?: Record<string, string>;
    protocols?: string[];
    tcpNoDelay?: boolean;
    timeout?: number;
  } & WechatMiniprogram.CallbackOptions<unknown>): WechatMiniprogram.SocketTask;
  onNetworkStatusChange(cb: (res: { isConnected: boolean; networkType: string }) => void): void;
  getNetworkType(opts: WechatMiniprogram.CallbackOptions<{ networkType: string }>): void;

  // ---------- 交互 ----------
  showToast(opts: { title: string; icon?: 'success' | 'error' | 'loading' | 'none'; duration?: number; mask?: boolean }): void;
  hideToast(opts?: Record<string, unknown>): void;
  showLoading(opts: { title: string; mask?: boolean }): void;
  hideLoading(opts?: Record<string, unknown>): void;
  showModal(opts: {
    title?: string;
    content?: string;
    showCancel?: boolean;
    cancelText?: string;
    confirmText?: string;
    confirmColor?: string;
  } & WechatMiniprogram.CallbackOptions<{ confirm: boolean; cancel: boolean }>): void;
  vibrateShort?(opts?: { type?: 'heavy' | 'medium' | 'light' } & WechatMiniprogram.CallbackOptions<unknown>): void;
  setClipboardData(opts: { data: string } & WechatMiniprogram.CallbackOptions<unknown>): void;
  getClipboardData?(opts: WechatMiniprogram.CallbackOptions<{ data: string }>): void;

  // ---------- 页面栈 / 路由 ----------
  navigateTo(opts: { url: string } & WechatMiniprogram.CallbackOptions<unknown>): void;
  redirectTo(opts: { url: string } & WechatMiniprogram.CallbackOptions<unknown>): void;
  switchTab(opts: { url: string } & WechatMiniprogram.CallbackOptions<unknown>): void;
  reLaunch(opts: { url: string } & WechatMiniprogram.CallbackOptions<unknown>): void;
  navigateBack(opts?: { delta?: number }): void;
  getCurrentPages(): Array<{ route: string; setData: (d: Record<string, unknown>) => void }>;

  // ---------- 登录 / 用户 ----------
  login(opts: { timeout?: number } & WechatMiniprogram.CallbackOptions<{ code: string; errMsg: string }>): void;
  getUserProfile?(opts: {
    desc: string;
    lang?: string;
  } & WechatMiniprogram.CallbackOptions<{ userInfo: Record<string, unknown>; rawData: string; signature: string }>): void;
  checkSession(opts?: WechatMiniprogram.CallbackOptions<unknown>): void;

  // ---------- UI 线程 / 渲染 ----------
  createSelectorQuery(): {
    select(selector: string): {
      fields(opts: { node?: boolean; size?: boolean; rect?: boolean; context?: boolean }, cb?: (res: unknown) => void): {
        exec(cb: (res: Array<Record<string, unknown> | null>) => void): void;
      };
      boundingClientRect(cb: (rect: { width: number; height: number; top: number; left: number } | null) => void): {
        exec(cb: (res: unknown) => void): void;
      };
    };
    selectAll(selector: string): {
      boundingClientRect(cb: (rects: Array<{ width: number; height: number; top: number; left: number }>) => void): {
        exec(cb: (res: unknown) => void): void;
      };
    };
    in(component: unknown): ReturnType<typeof wx.createSelectorQuery> extends never ? never : unknown;
    exec(cb?: (res: unknown) => void): void;
  };
  createCanvasContext(canvasId: string, componentInstance?: unknown): unknown;
  createOffscreenCanvas?(opts?: { type?: '2d' | 'webgl'; width?: number; height?: number }): unknown;

  // ---------- 订阅消息 ----------
  requestSubscribeMessage(opts: {
    tmplIds: string[];
  } & WechatMiniprogram.CallbackOptions<Record<string, string>>): void;

  // ---------- 分享 ----------
  showShareMenu?(opts?: { withShareTicket?: boolean; menus?: string[] }): void;
  shareAppMessage?(opts?: Record<string, unknown>): void;

  // ---------- 小程序更新 ----------
  getUpdateManager?(): {
    onCheckForUpdate(cb: (res: { hasUpdate: boolean }) => void): void;
    onUpdateReady(cb: () => void): void;
    onUpdateFailed(cb: () => void): void;
    applyUpdate(): void;
  };

  // ---------- 性能 ----------
  getPerformance?(): { now(): number };
  reportPerformance?(id: number, value: number, dimensions?: string[]): void;
  reportEvent?(id: number, data: Record<string, unknown>): void;
};

/** 页面实例的形状（`Page()` / `Component()` 里的 `this`）。 */
interface IPageInstance<D = Record<string, unknown>> {
  data: D;
  setData(data: Partial<D> | Record<string, unknown>, cb?: () => void): void;
  route: string;
  options?: Record<string, string>;
  selectComponent(selector: string): unknown;
  triggerEvent?(name: string, detail?: unknown, opts?: Record<string, unknown>): void;
}

declare function Page<D extends Record<string, unknown>, T extends Record<string, unknown>>(
  options: {
    data?: D;
    onLoad?(this: IPageInstance<D> & T, query: Record<string, string>): void;
    onShow?(this: IPageInstance<D> & T): void;
    onReady?(this: IPageInstance<D> & T): void;
    onHide?(this: IPageInstance<D> & T): void;
    onUnload?(this: IPageInstance<D> & T): void;
    onPullDownRefresh?(this: IPageInstance<D> & T): void;
    onReachBottom?(this: IPageInstance<D> & T): void;
    onShareAppMessage?(this: IPageInstance<D> & T, opts: Record<string, unknown>): Record<string, unknown>;
    onShareTimeline?(this: IPageInstance<D> & T): Record<string, unknown>;
    [key: string]: unknown;
  } & ThisType<IPageInstance<D> & T>,
): void;

declare function Component<
  D extends Record<string, unknown>,
  P extends Record<string, unknown>,
  T extends Record<string, unknown>,
>(options: {
  properties?: Record<string, unknown>;
  data?: D;
  observers?: Record<string, (...args: unknown[]) => void>;
  lifetimes?: Record<string, () => void>;
  methods?: T;
  [key: string]: unknown;
}): void;

declare function App<T extends Record<string, unknown>>(options: {
  onLaunch?(this: T, opts: Record<string, unknown>): void;
  onShow?(this: T, opts: Record<string, unknown>): void;
  onHide?(this: T): void;
  onError?(this: T, msg: string): void;
  globalData?: Record<string, unknown>;
  [key: string]: unknown;
}): void;

declare function getApp<T = Record<string, unknown>>(): T;
declare function getCurrentPages(): Array<{ route: string }>;

/** 构建期注入的编译常量（见 miniprogram/typings/env.d.ts 说明）。 */
declare const __POCKET_BUILD__: {
  env: 'local' | 'staging' | 'prod';
  mock: boolean;
  version: string;
  builtAt: string;
} | undefined;
