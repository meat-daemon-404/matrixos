/**
 * orbital-hub 运行时配置
 *
 * 核心：**开发期不该依赖真实域名**。微站还没部署，iframe 用本地 dev server 或占位页。
 * 所以这里把「微站地址」收敛成一个模板函数，由环境变量决定指向哪里。
 */

/** 真实域名模板。生产：https://{appId}.matrixos.edu */
const DEFAULT_ORIGIN_TEMPLATE = 'https://{appId}.matrixos.edu';

/** 开发期本地 dev server 模板。端口约定 = 3010 + (id - 1)，见 docs/02-engineering/01-dev-setup.md */
const LOCAL_ORIGIN_TEMPLATE = 'http://localhost:{port}';

/**
 * 读取 NEXT_PUBLIC_* 必须用字面量属性访问：
 * Next 在构建期做静态替换，`process.env[key]` 这种动态写法拿不到值。
 */
function readPublicEnv(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export interface HubRuntimeConfig {
  /** 微站地址模板，支持 {appId} 与 {port} 两个占位符 */
  readonly originTemplate: string;
  /** 是否指向本地 dev server */
  readonly localMode: boolean;
  /** 未就位的微站用占位页代替（开发期默认 true） */
  readonly usePlaceholder: boolean;
  /** 性能探针阈值（R-T03 / S2-01e） */
  readonly probe: {
    readonly fpsFloor: number;
    readonly memoryCeilingMB: number;
    readonly longTaskCeilingMs: number;
    /** 连续多少个采样窗口低于阈值才降级（防抖，避免一次 GC 就降级） */
    readonly breachWindows: number;
  };
  /** 是否默认开启 1 全量 + 2 快照（性能探针触发前的手动开关，便于演示降级） */
  readonly forceSnapshotMode: boolean;
}

/**
 * 环境变量一览（全部 NEXT_PUBLIC_ 前缀，才能在浏览器端读到）：
 *
 *   NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE   微站地址模板，默认 https://{appId}.matrixos.edu
 *   NEXT_PUBLIC_MICROSITE_LOCAL_MODE        'true' 时改用 http://localhost:{port}
 *   NEXT_PUBLIC_MICROSITE_PORT_BASE         本地端口基数，默认 3010
 *   NEXT_PUBLIC_MICROSITE_PLACEHOLDER       'false' 时不再用占位页（改成真嵌 iframe）
 *   NEXT_PUBLIC_HUB_FPS_FLOOR               帧率下限，默认 45
 *   NEXT_PUBLIC_HUB_MEM_CEILING_MB          内存上限，默认 800
 *   NEXT_PUBLIC_HUB_LONG_TASK_MS            长任务上限，默认 100
 *   NEXT_PUBLIC_HUB_FORCE_SNAPSHOT          'true' 强制「1 全量 + 2 快照」
 */
export function readHubConfig(): HubRuntimeConfig {
  const localMode = readPublicEnv(process.env.NEXT_PUBLIC_MICROSITE_LOCAL_MODE, '') === 'true';
  const template = readPublicEnv(
    process.env.NEXT_PUBLIC_MICROSITE_ORIGIN_TEMPLATE,
    localMode ? LOCAL_ORIGIN_TEMPLATE : DEFAULT_ORIGIN_TEMPLATE,
  );

  const num = (raw: string | undefined, fallback: number): number => {
    const value = Number.parseFloat((raw ?? '').trim());
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  /**
   * 开发模式的阈值放宽。
   *
   * 为什么需要：dev server 下每个微站首次编译会产生 600ms+ 的长任务，
   * HMR 也会周期性触发重编译。这些是**开发工具链的开销**，不是产品性能问题。
   * 实测（2026-10-20）：挂 2 个 dev 微站时长任务 631ms，直接触发降级，
   * 而生产构建的同一页面长任务 < 50ms。
   *
   * 所以 dev 下把长任务上限提到 1000ms、帧率下限降到 30，
   * 让降级机制**只在真实性能问题时触发**，不被工具链噪音误触。
   * 生产模式仍用严格阈值（45fps / 800MB / 100ms）。
   */
  const isDev = process.env.NODE_ENV !== 'production';
  const fpsFloorDefault = isDev ? 30 : 45;
  const longTaskDefault = isDev ? 1000 : 100;

  return {
    originTemplate: template,
    localMode,
    usePlaceholder: readPublicEnv(process.env.NEXT_PUBLIC_MICROSITE_PLACEHOLDER, 'true') !== 'false',
    probe: {
      fpsFloor: num(process.env.NEXT_PUBLIC_HUB_FPS_FLOOR, fpsFloorDefault),
      memoryCeilingMB: num(process.env.NEXT_PUBLIC_HUB_MEM_CEILING_MB, 800),
      longTaskCeilingMs: num(process.env.NEXT_PUBLIC_HUB_LONG_TASK_MS, longTaskDefault),
      breachWindows: 2,
    },
    forceSnapshotMode: readPublicEnv(process.env.NEXT_PUBLIC_HUB_FORCE_SNAPSHOT, '') === 'true',
  };
}

/**
 * 把模板渲染成具体微站地址。
 * 未知占位符原样保留（便于暴露配置错误，而不是静默拼出半个 URL）。
 */
export function resolveMicrositeOrigin(
  template: string,
  station: { readonly appId: string; readonly devPort: number },
): string {
  return template
    .replace(/\{appId\}/g, station.appId)
    .replace(/\{port\}/g, String(station.devPort))
    .replace(/\{id\}/g, station.appId);
}
