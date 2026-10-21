'use client';

/**
 * 站点工作台薄封装 —— 每个微站的 `src/components/site-workbench.tsx`。
 *
 * 只做一件事：把站点身份、业务规格、SDK 桥接三样东西喂给共享 Workbench 实现。
 * 台账增删改、导出、虫洞投送/接收的全部逻辑都在 `./workbench-impl` 里，
 * 18 站共用同一份字节相同的实现，保证验收契约（testid、计数、下载、投送反馈）
 * 完全一致；各站唯一的差异是 `../lib/site-spec` 里的业务演示数据。
 */

import { Workbench } from './workbench-impl';
import { SITE } from '../site.config';
import { sdkBridge } from '../lib/sdk-facade';
import { siteSpec } from '../lib/site-spec';
import type { SiteIdentityLike } from '@matrixos/microsite-data';

const identity: SiteIdentityLike = {
  id: SITE.id,
  name: SITE.name,
  domain: SITE.domain,
  appId: SITE.appId,
  orbitName: SITE.orbitName,
  accent: SITE.accent,
  uiStyle: SITE.uiStyle,
  ledger: SITE.ledger,
  source: SITE.source,
};

export function SiteWorkbench() {
  return <Workbench identity={identity} spec={siteSpec} bridge={sdkBridge()} />;
}

export default SiteWorkbench;
