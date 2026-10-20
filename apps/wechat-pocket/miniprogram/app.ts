/**
 * 口袋端应用入口。
 *
 * 职责刻意很薄——只做「启动装配 + 全局兜底」，业务都在页面与 `core/` 里：
 *   1. 冷启动打点（`core/logger` 的 mark，对齐 < 800ms 预算）；
 *   2. 恢复身份：读 storage 的 token，有则后台 `ensureFreshToken` 预热，
 *      没有也不阻断（mock 环境下页面仍要能渲染占位数据）；
 *   3. 绑定跨端同步通道的 App 生命周期（切后台断开省电、回前台重连）；
 *   4. 全局错误 / 未处理 Promise 兜底，一律走 logger，不让异常静默。
 *
 * 启动状态放**模块作用域**而不是 globalData：`App<T>` 的 `this` 被 T=Record<string,unknown>
 * 约束，`this.globalData.env = x` 会因 globalData 是 unknown 而报错——为共享可变状态
 * 造一套断言不如直接用一个类型正确的模块单例（小程序逻辑层是单进程 JS，模块作用域
 * 就是天然的全局）。globalData 仍保留一个只读快照供页面取用。
 */
import { ensureDeviceId, ensureFreshToken, getTokens } from './core/auth';
import { getEnv, resolveEnv } from './core/config';
import { toApiError } from './core/errors';
import { log, mark } from './core/logger';
import { bindAppLifecycle, sync } from './core/sync';

export type PocketEnv = 'local' | 'staging' | 'prod';

/** 启动期装配出来的全局状态（模块单例，见文件头注释）。 */
export const bootState = {
  /** 本次冷启动的起点（epoch ms）。 */
  bootAt: Date.now(),
  /** 由启动参数解析出的环境。 */
  env: 'local' as PocketEnv,
  /** 订阅消息引导是否已经问过（只问一次）。 */
  guided: false,
};

App<Record<string, unknown>>({
  globalData: {
    bootAt: bootState.bootAt,
    env: bootState.env,
  },

  onLaunch(options: Record<string, unknown>) {
    mark('app:launch');

    // 环境由启动参数决定（开发者工具可用 ?env=local 指向 mock-server）。
    const query = (options.query as Record<string, string> | undefined) || {};
    bootState.env = resolveEnv(query);
    log.info(
      'app',
      `冷启动 env=${getEnv()} scene=${String(options.scene ?? '-')} path=${String(options.path ?? '-')}`,
    );

    // 恢复设备 id（推队列、WS auth 都要用），失败不致命。
    try {
      ensureDeviceId();
    } catch (e) {
      log.warn('app', `设备 id 初始化失败（不阻断启动）：${String((e as Error).message || e)}`);
    }

    // 只在已有本地 token 时后台预热刷新：没有就留给首个页面的登录流程，
    // 避免在冷启动关键路径上同步等待网络（< 800ms 预算）。
    if (getTokens()) {
      ensureFreshToken(false).catch((e) => {
        log.warn('app', `token 预热失败（页面将按需重试）：${toApiError(e).kind}`);
      });
    }

    // 跨端同步通道：绑定 App 级前后台钩子。实际连接由页面 acquire() 引用计数触发。
    bindAppLifecycle();
  },

  onShow(options: Record<string, unknown>) {
    log.info('app', `onShow scene=${String(options.scene ?? '-')}`);
    const state = sync.snapshot();
    if (state.status === 'offline' || state.transport === 'none') {
      // 交给页面的 acquire()/reconnectNow；这里只记录，不越权建连接。
      log.info('app', `回前台，同步当前状态=${state.status}，等待页面重连`);
    }
  },

  onError(msg: string) {
    // 全局 JS 异常。落日志但不吞——返回后框架仍会记录堆栈。
    log.error('app', '全局错误', msg);
  },

  onUnhandledRejection(res: { reason: unknown }) {
    const err = toApiError(res.reason);
    log.error('app', `未处理的 Promise 拒绝：${err.kind} ${err.message}`, res.reason);
  },
});
