/**
 * `WormholeEnvelope` 校验器测试。
 *
 * 重点覆盖架构 §5.3 的 W1 红线：证据不可为空。下面 4 个用例是**永久性**的，
 * 任何一次「为了让某个站跑通而放宽校验」都会在这里立刻红掉。
 */
import { describe, expect, it } from 'vitest';

import {
  parseWormholeEnvelope,
  payloadTypes,
  verificationLevels,
  worstVerificationLevel,
  wormholeEnvelopeSchema,
} from '../src/index.js';
import { levelAAnchor, validEnvelope } from './fixtures.js';

describe('WormholeEnvelope · 合法路径', () => {
  it('接受一份完整信封', () => {
    const result = wormholeEnvelopeSchema.safeParse(validEnvelope());
    expect(result.success).toBe(true);
  });

  it('最小信封：省掉 $schema 与 created_at 仍合法（二者非必填）', () => {
    const envelope = validEnvelope();
    delete (envelope as Record<string, unknown>)['$schema'];
    delete (envelope as Record<string, unknown>)['created_at'];
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('5 类 payload_type 全部可投送', () => {
    for (const payloadType of payloadTypes) {
      const envelope = { ...validEnvelope(), payload_type: payloadType };
      expect(wormholeEnvelopeSchema.safeParse(envelope).success, payloadType).toBe(true);
    }
  });

  it('3 档 verification_level 全部合法', () => {
    for (const level of verificationLevels) {
      const envelope = validEnvelope();
      envelope.payload.evidence_anchors[0]!.verification_level = level;
      expect(wormholeEnvelopeSchema.safeParse(envelope).success, level).toBe(true);
    }
  });

  it('date-time 接受 +08:00 偏移（服务器在 Asia/Shanghai）', () => {
    const envelope = { ...validEnvelope(), created_at: '2026-10-20T11:54:10+08:00' };
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('created_at 接受 Z 结尾的 UTC 时刻', () => {
    const envelope = { ...validEnvelope(), created_at: '2026-10-20T03:54:10Z' };
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('大载荷策略：data 只放 asset_ref 引用，且证据仍非空 → 合法', () => {
    const envelope = {
      ...validEnvelope(),
      payload_type: 'paper_doi_bundle',
      payload: {
        data: {
          asset_ref: 'ast_01H8Z9K2',
          asset_version: 3,
          summary: '30 篇钙钛矿钝化文献元数据 + 坐标锚点',
          result_count: 30,
        },
        evidence_anchors: [levelAAnchor('10.1021/jacs.4c0112')],
      },
    };
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('一条锚点只带必填两项（省掉 bbox / pdf_page）→ 合法', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors = [
      { source_doi_or_url: '10.1/x', verification_level: 'Level_B_Preprint' },
    ] as never;
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('parseWormholeEnvelope 合法时返回判别式 ok:true', () => {
    const result = parseWormholeEnvelope(validEnvelope());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.trace_id).toBe(validEnvelope().trace_id);
  });
});

describe('WormholeEnvelope · 证据红线（W1）', () => {
  it('缺 evidence_anchors 整个字段 → 校验失败', () => {
    const envelope = validEnvelope();
    delete (envelope.payload as Record<string, unknown>)['evidence_anchors'];
    const result = wormholeEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('evidence_anchors');
  });

  it('evidence_anchors 为空数组 → 校验失败（minItems: 1）', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors = [];
    const result = wormholeEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('>=1');
  });

  it('锚点缺 source_doi_or_url → 校验失败', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors = [
      { pdf_page: 3, verification_level: 'Level_A_Verified' },
    ] as never;
    const result = wormholeEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('source_doi_or_url');
  });

  it('锚点 source_doi_or_url 为空串 → 校验失败（不能拿空串骗过 required）', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors[0]!.source_doi_or_url = '';
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('锚点缺 verification_level → 校验失败', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors = [{ source_doi_or_url: '10.1/x' }] as never;
    const result = wormholeEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('verification_level');
  });

  it('verification_level 为非法值 → 校验失败', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors[0]!.verification_level =
      'Level_S_Godlike' as never;
    const result = wormholeEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('verification_level');
  });

  it('多锚点里夹一条非法等级 → 整体失败（不做局部放行）', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors = [
      levelAAnchor('10.1/ok'),
      { source_doi_or_url: '10.1/bad', verification_level: 'verified' },
    ] as never;
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('bbox 只给 3 个数 → 校验失败（契约 minItems: 4）', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors[0]!.bbox = [1, 2, 3] as never;
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('bbox 给 5 个数 → 校验失败（契约 maxItems: 4）', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors[0]!.bbox = [1, 2, 3, 4, 5] as never;
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('pdf_page 为 0 → 校验失败（契约 minimum: 1）', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors[0]!.pdf_page = 0;
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });
});

describe('WormholeEnvelope · 扩展性与枚举', () => {
  it('顶层多一个未声明字段 → 校验失败（additionalProperties: false）', () => {
    const envelope = { ...validEnvelope(), sneaky_field: 'x' };
    const result = wormholeEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unrecognized');
  });

  it('payload 内多一个未声明字段 → 校验失败', () => {
    const envelope = validEnvelope();
    (envelope.payload as Record<string, unknown>)['extra'] = 1;
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('锚点内多一个未声明字段 → 校验失败', () => {
    const envelope = validEnvelope();
    (envelope.payload.evidence_anchors[0] as Record<string, unknown>)['confidence'] = 0.9;
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('payload_type 为契约外的类型 → 校验失败（封闭枚举）', () => {
    const envelope = { ...validEnvelope(), payload_type: 'asset_pointer' };
    const result = wormholeEnvelopeSchema.safeParse(envelope);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('payload_type');
  });

  it('trace_id 不是 uuid → 校验失败', () => {
    const envelope = { ...validEnvelope(), trace_id: 'trace-001' };
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('缺必填矩阵：逐个删除 6 个必填字段都必须失败', () => {
    const required = ['trace_id', 'matrix_uid', 'source_app', 'target_app', 'payload_type', 'payload'];
    for (const key of required) {
      const envelope = validEnvelope();
      delete (envelope as Record<string, unknown>)[key];
      expect(wormholeEnvelopeSchema.safeParse(envelope).success, key).toBe(false);
    }
  });

  it('created_at 是纯日期（无时间）→ 校验失败', () => {
    const envelope = { ...validEnvelope(), created_at: '2026-10-20' };
    expect(wormholeEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });
});

describe('WormholeEnvelope · parseWormholeEnvelope 失败路径', () => {
  it('失败时返回 ok:false 且 issues 里带路径', () => {
    const envelope = validEnvelope();
    envelope.payload.evidence_anchors = [];
    const result = parseWormholeEnvelope(envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join(' ')).toContain('payload.evidence_anchors');
    }
  });

  it('输入完全不是对象时也不抛异常，返回结构化解', () => {
    const result = parseWormholeEnvelope('not-an-envelope');
    expect(result.ok).toBe(false);
  });
});

describe('worstVerificationLevel · 取最弱证据', () => {
  it('多锚点取最弱：A + Retracted → Retracted_Warning', () => {
    expect(
      worstVerificationLevel([
        { source_doi_or_url: '10.1/a', verification_level: 'Level_A_Verified' },
        { source_doi_or_url: '10.1/b', verification_level: 'Retracted_Warning' },
      ]),
    ).toBe('Retracted_Warning');
  });

  it('A + B → Level_B_Preprint', () => {
    expect(
      worstVerificationLevel([
        { source_doi_or_url: '10.1/a', verification_level: 'Level_A_Verified' },
        { source_doi_or_url: '10.1/b', verification_level: 'Level_B_Preprint' },
      ]),
    ).toBe('Level_B_Preprint');
  });

  it('单条 A → Level_A_Verified', () => {
    expect(worstVerificationLevel([levelAAnchor()])).toBe('Level_A_Verified');
  });

  it('空数组 → undefined（不擅自兜底成 A 级）', () => {
    expect(worstVerificationLevel([])).toBeUndefined();
  });
});
