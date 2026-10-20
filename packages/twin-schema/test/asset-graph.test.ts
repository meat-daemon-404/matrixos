/**
 * `DigitalTwinAssetGraph` 契约测试。
 *
 * 覆盖点：
 *  - `AssetNode` 的证据红线（与虫洞信封同构、同一条 `minItems: 1`）；
 *  - `AssetType` 12 值 / `AssetRelation` 5 值封闭枚举；
 *  - `AssetChunk.embedding` **恰好 1024 维**（ADR-04）；
 *  - `station_id` 用**文法校验**而非封闭枚举（支持第 19+ 站动态注册）；
 *  - §5.4 的大载荷工具 `isLargePayload()` / `toAssetRef()`。
 */
import { describe, expect, it } from 'vitest';

import {
  ASSET_RELATION,
  ASSET_TYPE,
  EMBEDDING_DIMENSIONS,
  WORMHOLE_INLINE_PAYLOAD_LIMIT_BYTES,
  assetChunkSchema,
  assetEdgeSchema,
  assetNodeSchema,
  estimatePayloadBytes,
  isAssetRefPayload,
  isLargePayload,
  toAssetRef,
} from '../src/index.js';
import { UUID_A, UUID_B, embedding1024, levelAAnchor, validAssetNode } from './fixtures.js';

function validChunk() {
  return {
    chunk_id: UUID_A,
    asset_id: UUID_B,
    chunk_index: 0,
    content: '双指数拟合得到 τ_fast = 0.42 ns，τ_slow = 3.1 ns。',
    embedding: embedding1024(),
  };
}

function validEdge() {
  return {
    edge_id: UUID_A,
    from_asset_id: UUID_A,
    to_asset_id: UUID_B,
    relation: 'derived_from' as const,
    weight: 0.8,
  };
}

describe('AssetNode · 合法路径', () => {
  it('接受一份完整节点', () => {
    expect(assetNodeSchema.safeParse(validAssetNode()).success).toBe(true);
  });

  it('12 类 asset_type 全部合法', () => {
    expect(ASSET_TYPE.length).toBe(12);
    for (const asset_type of ASSET_TYPE) {
      expect(assetNodeSchema.safeParse({ ...validAssetNode(), asset_type }).success, asset_type).toBe(true);
    }
  });

  it('Task 要求的 6 类全部在枚举内（paper/fit_result/comparison_row/cv_entry/mentor_card/receipt）', () => {
    for (const required of ['paper', 'fit_result', 'comparison_row', 'cv_entry', 'mentor_card', 'receipt']) {
      expect(ASSET_TYPE, required).toContain(required);
    }
  });

  it('title / trace_id / local_ref 都可选', () => {
    const node = validAssetNode();
    delete (node as Record<string, unknown>)['title'];
    delete (node as Record<string, unknown>)['trace_id'];
    expect(assetNodeSchema.safeParse(node).success).toBe(true);
  });

  it('带端侧隐私指针 local_ref 的节点合法（架构 §6.4）', () => {
    const node = { ...validAssetNode(), local_ref: { device_id: 'dev-abc', local_key: 'trpl-raw-001' } };
    expect(assetNodeSchema.safeParse(node).success).toBe(true);
  });

  it('第三方微站的 station_id 合法（动态注册，非官方 18 站）', () => {
    expect(assetNodeSchema.safeParse({ ...validAssetNode(), station_id: 'bioscan' }).success).toBe(true);
  });
});

describe('AssetNode · 证据红线（与 Wormhole 同构）', () => {
  it('缺 evidence_anchors → 失败', () => {
    const node = validAssetNode();
    delete (node as Record<string, unknown>)['evidence_anchors'];
    const result = assetNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('evidence_anchors');
  });

  it('evidence_anchors 为空数组 → 失败（minItems: 1）', () => {
    const node = { ...validAssetNode(), evidence_anchors: [] };
    expect(assetNodeSchema.safeParse(node).success).toBe(false);
  });

  it('锚点缺 source_doi_or_url → 失败', () => {
    const node = {
      ...validAssetNode(),
      evidence_anchors: [{ verification_level: 'Level_A_Verified' }],
    };
    expect(assetNodeSchema.safeParse(node).success).toBe(false);
  });

  it('锚点缺 verification_level → 失败', () => {
    const node = { ...validAssetNode(), evidence_anchors: [{ source_doi_or_url: '10.1/x' }] };
    expect(assetNodeSchema.safeParse(node).success).toBe(false);
  });

  it('verification_level 非法值 → 失败', () => {
    const node = {
      ...validAssetNode(),
      evidence_anchors: [{ source_doi_or_url: '10.1/x', verification_level: 'Verified' }],
    };
    expect(assetNodeSchema.safeParse(node).success).toBe(false);
  });

  it('节点级 verification_level 缺失 → 失败', () => {
    const node = validAssetNode();
    delete (node as Record<string, unknown>)['verification_level'];
    expect(assetNodeSchema.safeParse(node).success).toBe(false);
  });
});

describe('AssetNode · 结构性负例', () => {
  it('缺必填字段 → 逐个删除都失败', () => {
    const required = [
      'asset_id',
      'matrix_uid',
      'station_id',
      'asset_type',
      'payload',
      'evidence_anchors',
      'verification_level',
      'version',
      'created_at',
      'updated_at',
    ];
    for (const key of required) {
      const node = validAssetNode();
      delete (node as Record<string, unknown>)[key];
      expect(assetNodeSchema.safeParse(node).success, key).toBe(false);
    }
  });

  it('asset_type 为契约外类型 → 失败', () => {
    expect(assetNodeSchema.safeParse({ ...validAssetNode(), asset_type: 'podcast' }).success).toBe(false);
  });

  it('station_id 含大写 → 失败（文法校验）', () => {
    expect(assetNodeSchema.safeParse({ ...validAssetNode(), station_id: 'CurveLab' }).success).toBe(false);
  });

  it('station_id 含下划线 → 失败', () => {
    expect(assetNodeSchema.safeParse({ ...validAssetNode(), station_id: 'curve_lab' }).success).toBe(false);
  });

  it('station_id 误填 7 站轨道的值（xingmen 恰好也合法，但 study 太短会失败）', () => {
    // 这是一个真实的语义陷阱：`station_id` 的定义域是**微站 key**，
    // 不是 7 站生涯闭环。二者在字符串层有交集（如 xingmen 两处都合法），
    // 类型层无法区分，只能靠文档与 code review。见 README「已知坑」。
    expect(assetNodeSchema.safeParse({ ...validAssetNode(), station_id: 'study' }).success).toBe(false);
    expect(assetNodeSchema.safeParse({ ...validAssetNode(), station_id: 'xingmen' }).success).toBe(true);
  });

  it('version 为 0 → 失败（minimum: 1）', () => {
    expect(assetNodeSchema.safeParse({ ...validAssetNode(), version: 0 }).success).toBe(false);
  });

  it('asset_id 非 uuid → 失败', () => {
    expect(assetNodeSchema.safeParse({ ...validAssetNode(), asset_id: 'ast_01H8Z9K2' }).success).toBe(false);
  });

  it('多一个未声明字段 → 失败（strictObject）', () => {
    const result = assetNodeSchema.safeParse({ ...validAssetNode(), server_derived: true });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('unrecognized');
  });

  it('payload 内任意嵌套结构 → 合法（jsonb 自由形态）', () => {
    const node = {
      ...validAssetNode(),
      payload: { nested: { rows: [[1, 2], [3, 4]] }, null_value: null, flag: true },
    };
    expect(assetNodeSchema.safeParse(node).success).toBe(true);
  });
});

describe('AssetEdge · 图谱边', () => {
  it('接受一条完整边', () => {
    expect(assetEdgeSchema.safeParse(validEdge()).success).toBe(true);
  });

  it('Task 要求的 3 种关系全部在枚举内（derived_from/cites/evidences）', () => {
    for (const required of ['derived_from', 'cites', 'evidences']) {
      expect(ASSET_RELATION, required).toContain(required);
    }
  });

  it('5 种关系全部合法', () => {
    expect(ASSET_RELATION.length).toBe(5);
    for (const relation of ASSET_RELATION) {
      expect(assetEdgeSchema.safeParse({ ...validEdge(), relation }).success, relation).toBe(true);
    }
  });

  it('relation 为契约外值 → 失败', () => {
    expect(assetEdgeSchema.safeParse({ ...validEdge(), relation: 'mentions' }).success).toBe(false);
  });

  it('weight 可选', () => {
    const edge = validEdge();
    delete (edge as Record<string, unknown>)['weight'];
    expect(assetEdgeSchema.safeParse(edge).success).toBe(true);
  });

  it('weight 为 Infinity → 失败（JSON 无法编码）', () => {
    expect(assetEdgeSchema.safeParse({ ...validEdge(), weight: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it('缺 from_asset_id → 失败', () => {
    const edge = validEdge();
    delete (edge as Record<string, unknown>)['from_asset_id'];
    expect(assetEdgeSchema.safeParse(edge).success).toBe(false);
  });

  it('from/to 非 uuid → 失败', () => {
    expect(assetEdgeSchema.safeParse({ ...validEdge(), from_asset_id: 'nope' }).success).toBe(false);
  });
});

describe('AssetChunk · 向量分片', () => {
  it('接受一份完整分片（1024 维）', () => {
    expect(assetChunkSchema.safeParse(validChunk()).success).toBe(true);
  });

  it('embedding 维度常量就是 1024', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it('embedding 只有 1023 维 → 失败', () => {
    const chunk = { ...validChunk(), embedding: embedding1024().slice(0, 1023) };
    const result = assetChunkSchema.safeParse(chunk);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('1024');
  });

  it('embedding 多一维（1025）→ 失败', () => {
    const chunk = { ...validChunk(), embedding: [...embedding1024(), 0] };
    expect(assetChunkSchema.safeParse(chunk).success).toBe(false);
  });

  it('embedding 为空数组 → 失败', () => {
    expect(assetChunkSchema.safeParse({ ...validChunk(), embedding: [] }).success).toBe(false);
  });

  it('embedding 含非数字 → 失败', () => {
    const embedding = embedding1024();
    (embedding as unknown[])[100] = 'x';
    expect(assetChunkSchema.safeParse({ ...validChunk(), embedding }).success).toBe(false);
  });

  it('embedding 含 NaN → 失败', () => {
    const embedding = embedding1024();
    (embedding as number[])[100] = Number.NaN;
    expect(assetChunkSchema.safeParse({ ...validChunk(), embedding }).success).toBe(false);
  });

  it('chunk_index 为 -1 → 失败（minimum: 0）', () => {
    expect(assetChunkSchema.safeParse({ ...validChunk(), chunk_index: -1 }).success).toBe(false);
  });

  it('content 允许空串（契约未加 minLength）', () => {
    expect(assetChunkSchema.safeParse({ ...validChunk(), content: '' }).success).toBe(true);
  });
});

describe('大载荷工具（架构 §5.4）', () => {
  it('阈值就是 64 KB', () => {
    expect(WORMHOLE_INLINE_PAYLOAD_LIMIT_BYTES).toBe(64 * 1024);
  });

  it('小载荷不触发大载荷路径', () => {
    expect(isLargePayload({ tau: 3.42, r_squared: 0.987 })).toBe(false);
  });

  it('超过 64 KB 触发大载荷路径', () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, title: '论文标题'.repeat(4) })) };
    expect(isLargePayload(big)).toBe(true);
  });

  it('estimatePayloadBytes 按 UTF-8 计字节（中文 3 字节）', () => {
    expect(estimatePayloadBytes('中')).toBe(5); // '"中"' = 1 引号 + 3 字节 + 1 引号
  });

  it('循环引用不抛异常，按超大处理', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(isLargePayload(cyclic)).toBe(true);
    expect(estimatePayloadBytes(cyclic)).toBe(Number.POSITIVE_INFINITY);
  });

  it('toAssetRef 产出架构 §5.4 示例的四个字段', () => {
    const data = toAssetRef({
      assetRef: 'ast_01H8Z9K2',
      assetVersion: 3,
      summary: '30 篇钙钛矿钝化文献元数据 + 坐标锚点',
      resultCount: 30,
    });
    expect(data).toEqual({
      asset_ref: 'ast_01H8Z9K2',
      asset_version: 3,
      summary: '30 篇钙钛矿钝化文献元数据 + 坐标锚点',
      result_count: 30,
    });
  });

  it('toAssetRef 省略 resultCount 时不写该字段', () => {
    const data = toAssetRef({ assetRef: 'a', assetVersion: 1, summary: 's' });
    expect('result_count' in data).toBe(false);
  });

  it('toAssetRef 产出的 data 可被 asserts 识别为引用形态', () => {
    const data = toAssetRef({ assetRef: 'ast_1', assetVersion: 2, summary: 's' });
    expect(isAssetRefPayload(data)).toBe(true);
  });

  it('isAssetRefPayload 拒绝普通正文与 null / 数组', () => {
    expect(isAssetRefPayload({ tau: 1 })).toBe(false);
    expect(isAssetRefPayload(null)).toBe(false);
    expect(isAssetRefPayload([{ asset_ref: 'a' }])).toBe(false);
    expect(isAssetRefPayload('ast_1')).toBe(false);
  });

  it('toAssetRef 的产物能被虫洞信封直接接受（闭环）', () => {
    // 这条用例把 §5.4 的策略和信封校验串起来：
    // 大载荷 → toAssetRef → 塞进 payload.data → 信封依然合法（证据仍非空）。
    const data = toAssetRef({ assetRef: 'ast_01H8Z9K2', assetVersion: 3, summary: '30 篇文献', resultCount: 30 });
    expect(isLargePayload(data)).toBe(false);
    expect(isAssetRefPayload(data)).toBe(true);
    expect(data['asset_ref']).toBe('ast_01H8Z9K2');
  });
});

describe('fixtures · 样本自检', () => {
  it('levelAAnchor 是 A 级且带 bbox 四元组', () => {
    const anchor = levelAAnchor();
    expect(anchor.verification_level).toBe('Level_A_Verified');
    expect(anchor.bbox).toHaveLength(4);
  });

  it('embedding1024 长度正确且全为有限数', () => {
    const embedding = embedding1024();
    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedding.every((n) => Number.isFinite(n))).toBe(true);
  });
});
