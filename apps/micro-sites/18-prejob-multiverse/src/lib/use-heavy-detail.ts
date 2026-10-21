'use client';

/**
 * 专业重 detail 的按需加载 hook。
 *
 * 为什么需要它：重 detail（intro / direction / courses / related / juniorAdvice）
 * 共 539 KB gzip，占整个数据集 72%。列表页只在**展开某一行**或**选中某个专业**时
 * 才用得到，所以不能像之前那样静态 import 进主 chunk —— 那让路由涨到 833 kB。
 *
 * 关键区别（上轮我搞错过一次，别再犯）：
 *   - `import(变量路径)` → webpack 生成 context module，把整个目录都编译进去，
 *     无法静态分析，是要避免的写法；
 *   - `import('字面量路径')` → webpack 切成**一个**独立异步 chunk，主 bundle
 *     不含它，首次调用才下载。本文件用的是后者。
 *
 * 模块级 `loadedMap` 兼作单例与「是否已加载」的判据：
 *   - 单例：无论多少行被展开，JSON 只下载解析一次；
 *   - 判据：`loading` 由「要了数据但 map 还没到」推导，而不是等 useEffect
 *     把 loading 置 true —— 后者会让首帧（effect 尚未执行）闪一下
 *     「该专业无详情」，用户看到的就是错误信息。
 */
import { useEffect, useState } from 'react';

import type { XzSpecHeavyDetail } from './xz-data';

type HeavyMap = Readonly<Record<string, XzSpecHeavyDetail>>;

let inflight: Promise<HeavyMap> | null = null;
/** 已解析完的映射表；同时充当「chunk 是否已到位」的同步判据。 */
let loadedMap: HeavyMap | null = null;

function loadMap(): Promise<HeavyMap> {
  if (!inflight) {
    inflight = import('./xz-data/xz-spec-details.json')
      .then((m) => {
        loadedMap = (m.default ?? m) as unknown as HeavyMap;
        return loadedMap;
      })
      .catch((err: unknown) => {
        // 失败要能重试：否则一次网络抖动就把面板永久锁死在空态。
        inflight = null;
        throw err;
      });
  }
  return inflight;
}

export interface HeavyDetailState {
  readonly detail: XzSpecHeavyDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * @param specId 要取详情的专业；传 null 表示当前不需要（收起的行），不触发下载。
 */
export function useSpecHeavyDetail(specId: string | null): HeavyDetailState {
  const [map, setMap] = useState<HeavyMap | null>(() => loadedMap);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /*
     * specId 为空就**不要碰 loadMap()**。
     *
     * 这里踩过一次坑：原先只判 `if (map) return`，结果 SpecRow 每行、
     * AnchorPanel 常驻挂载，effect 一跑就无条件 import 了那个 chunk ——
     * 首屏照样下载 2266KB，「懒加载」形同虚设（Next 报的 282 kB 只是
     * 说它不在主 chunk 里，不代表没人提前拉它）。必须用 specId 把下载本身挡住。
     */
    if (!specId || map) return;
    if (loadedMap) {
      setMap(loadedMap);
      return;
    }
    let cancelled = false;
    loadMap()
      .then((m) => {
        if (!cancelled) setMap(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [specId, map]);

  return {
    detail: map && specId ? (map[specId] ?? null) : null,
    // 只在「确实要了数据」且 chunk 未到位时算加载中；已加载后 null 就是真的没有。
    loading: specId != null && map == null && error == null,
    error,
  };
}
