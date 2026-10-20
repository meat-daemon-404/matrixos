/**
 * 应用入口。
 *
 * 视图层硬阻塞修复的一部分：此前 `app.ts` 不存在，开发者工具打开即报
 * 「找不到 app.js」。这里只做最小初始化 —— 真正的能力（鉴权、请求、
 * 跨端同步、冷启动打点）都在 `core/` 里，入口只负责把应用级生命周期
 * 钩子接上。
 */
import { bindAppLifecycle } from './core/sync';
import { log } from './core/logger';

App({
  globalData: {
    appName: 'MatrixOS 口袋',
  },
  onLaunch() {
    log.info('app', 'MatrixOS 口袋启动（视图层骨架 v0.1）');
    // 接上「切后台 >30s 断开省电 / 回前台重连」的应用级钩子
    bindAppLifecycle();
  },
});
