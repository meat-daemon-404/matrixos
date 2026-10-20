/**
 * `MatrixAppManifest` 校验器测试。
 *
 * 关注点：`app_id` 文法、`accent_color` 严格 6 位、`manifest_version` 是 const 而非普通
 * string、`accepts`/`emits` 允许空数组（语义为「不接收 / 纯接收端」），
 * 以及 W3 规则的可达性判定 `canRouteWormhole()`。
 */
import { describe, expect, it } from 'vitest';

import { canRouteWormhole, matrixAppManifestSchema, wormholeLinkMatrix } from '../src/index.js';
import { validManifest } from './fixtures.js';

describe('MatrixAppManifest · 合法路径', () => {
  it('接受一份完整 manifest', () => {
    expect(matrixAppManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it('最小 manifest：只有 7 个必填字段', () => {
    const minimal = {
      manifest_version: '1.0',
      app_id: 'bioscan',
      name: '生物扫描',
      entry_url: 'https://bioscan.matrixos.edu',
      orbit_station: 'study',
      accepts: [],
      emits: [],
    };
    expect(matrixAppManifestSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts 为空数组 → 合法（语义：不接收虫洞投送）', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), accepts: [] }).success).toBe(true);
  });

  it('emits 为空数组 → 合法（语义：纯接收端）', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), emits: [] }).success).toBe(true);
  });

  it('7 站 orbit_station 全部合法', () => {
    const stations = ['study', 'spark', 'pat_hot', 'xingmen', 'workshop', 'cloud_balance', 'pre_job'];
    for (const orbit_station of stations) {
      expect(matrixAppManifestSchema.safeParse({ ...validManifest(), orbit_station }).success, orbit_station).toBe(true);
    }
  });

  it('6 个 permission 全部合法', () => {
    for (const permission of [
      'matrix_id:read',
      'profile:read',
      'assets:read',
      'assets:write',
      'wormhole:send',
      'wormhole:receive',
    ]) {
      expect(
        matrixAppManifestSchema.safeParse({ ...validManifest(), permissions: [permission] }).success,
        permission,
      ).toBe(true);
    }
  });

  it('app_id 接受合法形态：单段与我方官方站样式（03-grant-audit）', () => {
    for (const app_id of ['abc', 'curvelab', 'lab-kanban', '03-grant-audit', 'a1x']) {
      expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id }).success, app_id).toBe(true);
    }
  });

  it('refresh_seconds 边界：60 与 86400 都合法', () => {
    for (const refresh_seconds of [60, 86400]) {
      const manifest = { ...validManifest(), live_mini_view: { endpoint: 'https://x.edu/a', refresh_seconds } };
      expect(matrixAppManifestSchema.safeParse(manifest).success, String(refresh_seconds)).toBe(true);
    }
  });

  it('省掉所有可选字段（icon / accent_color / live_mini_view / permissions / author）→ 合法', () => {
    const manifest = validManifest();
    for (const key of ['icon', 'accent_color', 'live_mini_view', 'permissions', 'author']) {
      delete (manifest as Record<string, unknown>)[key];
    }
    expect(matrixAppManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe('MatrixAppManifest · 结构性负例', () => {
  it('缺必填字段 → 逐个删除都失败', () => {
    const required = ['manifest_version', 'app_id', 'name', 'entry_url', 'orbit_station', 'accepts', 'emits'];
    for (const key of required) {
      const manifest = validManifest();
      delete (manifest as Record<string, unknown>)[key];
      expect(matrixAppManifestSchema.safeParse(manifest).success, key).toBe(false);
    }
  });

  it('顶层多一个未声明字段 → 失败（additionalProperties: false）', () => {
    const manifest = { ...validManifest(), secret_sauce: true };
    const result = matrixAppManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unrecognized');
  });

  it('manifest_version 为 "2.0" → 失败（const "1.0"）', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), manifest_version: '2.0' }).success).toBe(false);
  });

  it('manifest_version 为数字 1.0 → 失败（不是字符串）', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), manifest_version: 1.0 }).success).toBe(false);
  });

  it('app_id 大写 → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id: 'BioScan' }).success).toBe(false);
  });

  it('app_id 以下划线开头 → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id: '_bioscan' }).success).toBe(false);
  });

  it('app_id 以下划线连接 → 失败（只允许短横线）', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id: 'bio_scan' }).success).toBe(false);
  });

  it('app_id 以短横线结尾 → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id: 'bioscan-' }).success).toBe(false);
  });

  it('app_id 太短（2 字符 "ab"）→ 失败（正则最少 3 字符，见下方边界说明）', () => {
    // 契约正则 `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` 的最小长度是 **3**：
    // 首字符 1 + 中间 {1,30} + 尾字符 1。这是一个真实的实现陷阱——
    // 容易误以为「最短 2 字符」。已记入 README「已知坑」。
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id: 'ab' }).success).toBe(false);
  });

  it('app_id 3 字符 "abc" → 合法（正则下界）', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id: 'abc' }).success).toBe(true);
  });

  it('app_id 超长（33 字符）→ 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id: 'a'.repeat(33) }).success).toBe(false);
  });

  it('app_id 顶部正好 32 字符 → 合法（边界）', () => {
    const app_id = 'a' + 'b'.repeat(30) + 'c';
    expect(app_id.length).toBe(32);
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), app_id }).success).toBe(true);
  });

  it('name 超过 40 字符 → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), name: '字'.repeat(41) }).success).toBe(false);
  });

  it('name 正好 40 字符 → 合法（边界）', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), name: '字'.repeat(40) }).success).toBe(true);
  });

  it('entry_url 不是 URI → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), entry_url: 'bioscan.matrixos.edu' }).success).toBe(
      false,
    );
  });

  it('orbit_station 为契约外的站 → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), orbit_station: 'orbit_9' }).success).toBe(false);
  });

  it('accent_color 缺 # → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), accent_color: '1A2B3C' }).success).toBe(false);
  });

  it('accent_color 3 位简写 → 失败（契约要求 6 位）', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), accent_color: '#abc' }).success).toBe(false);
  });

  it('accent_color 8 位带 alpha → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), accent_color: '#1A2B3CFF' }).success).toBe(false);
  });

  it('accent_color 小写 6 位 → 合法', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), accent_color: '#1a2b3c' }).success).toBe(true);
  });

  it('accepts 里出现契约外 payload_type → 失败', () => {
    expect(
      matrixAppManifestSchema.safeParse({ ...validManifest(), accepts: ['asset_pointer'] }).success,
    ).toBe(false);
  });

  it('accepts 不是数组 → 失败', () => {
    expect(matrixAppManifestSchema.safeParse({ ...validManifest(), accepts: 'paper_doi_bundle' }).success).toBe(false);
  });

  it('permissions 里出现未定义 scope → 失败', () => {
    expect(
      matrixAppManifestSchema.safeParse({ ...validManifest(), permissions: ['admin:all'] }).success,
    ).toBe(false);
  });

  it('live_mini_view 缺 endpoint → 失败（内部 required: [endpoint]）', () => {
    const manifest = { ...validManifest(), live_mini_view: { refresh_seconds: 120 } };
    expect(matrixAppManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('refresh_seconds 为 59 → 失败（最小 60）', () => {
    const manifest = { ...validManifest(), live_mini_view: { endpoint: 'https://x.edu/a', refresh_seconds: 59 } };
    expect(matrixAppManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('refresh_seconds 为 86401 → 失败（最大 86400）', () => {
    const manifest = {
      ...validManifest(),
      live_mini_view: { endpoint: 'https://x.edu/a', refresh_seconds: 86401 },
    };
    expect(matrixAppManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('contact_email 非法 → 失败', () => {
    const manifest = { ...validManifest(), author: { contact_email: 'not-an-email' } };
    expect(matrixAppManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('author 上额外的键 → 合法（契约未封闭 author）', () => {
    const manifest = { ...validManifest(), author: { lab_name: 'X', homepage: 'https://x.edu' } };
    expect(matrixAppManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('live_mini_view 上额外的键 → 合法（契约未封闭该对象）', () => {
    const manifest = {
      ...validManifest(),
      live_mini_view: { endpoint: 'https://x.edu/a', unit: 'samples' },
    };
    expect(matrixAppManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe('canRouteWormhole · W3 只投给声明过的目标', () => {
  it('目标站 accepts 含该类型 → 放行', () => {
    expect(canRouteWormhole({ accepts: ['paper_doi_bundle'] }, 'paper_doi_bundle')).toBe(true);
  });

  it('目标站 accepts 为空 → 拒绝', () => {
    expect(canRouteWormhole({ accepts: [] }, 'paper_doi_bundle')).toBe(false);
  });

  it('目标站 accepts 不含该类型 → 拒绝', () => {
    expect(canRouteWormhole({ accepts: ['mentor_match_card'] }, 'paper_doi_bundle')).toBe(false);
  });

  it('给了 source 但 source 未 emits 该类型 → 拒绝', () => {
    expect(
      canRouteWormhole({ accepts: ['paper_doi_bundle'] }, 'paper_doi_bundle', { emits: [] }),
    ).toBe(false);
  });

  it('双向都声明 → 放行', () => {
    expect(
      canRouteWormhole({ accepts: ['paper_doi_bundle'] }, 'paper_doi_bundle', {
        emits: ['paper_doi_bundle'],
      }),
    ).toBe(true);
  });
});

describe('wormholeLinkMatrix · 星轨连线', () => {
  it('A emits + B accepts → 产生 A→B 连线', () => {
    const a = { ...validManifest(), app_id: 'aaa', emits: ['paper_doi_bundle'] as const };
    const b = { ...validManifest(), app_id: 'bbb', accepts: ['paper_doi_bundle'] as const };
    const links = wormholeLinkMatrix([a, b] as never);
    expect(links).toContainEqual({ from: 'aaa', to: 'bbb', payloadTypes: ['paper_doi_bundle'] });
  });

  it('没有共同类型 → 无连线（两侧 emits 都为空）', () => {
    const a = { ...validManifest(), app_id: 'aaa', emits: [] as const };
    const b = { ...validManifest(), app_id: 'bbb', accepts: [] as const };
    // 注意：必须把 b 的 emits 也清空。`validManifest()` 默认 emits 含
    // comparison_matrix_row，而 a 的 accepts 默认也含它——只清一侧仍会连出 b→a。
    const bNoEmit = { ...b, emits: [] as const };
    expect(wormholeLinkMatrix([a, bNoEmit] as never)).toEqual([]);
  });

  it('不给自己连自己', () => {
    const a = { ...validManifest(), app_id: 'aaa', accepts: ['paper_doi_bundle'] as const, emits: ['paper_doi_bundle'] as const };
    expect(wormholeLinkMatrix([a] as never)).toEqual([]);
  });

  it('双向可达时产生两条方向相反的连线', () => {
    const a = {
      ...validManifest(),
      app_id: 'aaa',
      accepts: ['paper_doi_bundle'] as const,
      emits: ['paper_doi_bundle'] as const,
    };
    const b = {
      ...validManifest(),
      app_id: 'bbb',
      accepts: ['paper_doi_bundle'] as const,
      emits: ['paper_doi_bundle'] as const,
    };
    const links = wormholeLinkMatrix([a, b] as never);
    expect(links.map((l) => `${l.from}->${l.to}`).sort()).toEqual(['aaa->bbb', 'bbb->aaa']);
  });
});
