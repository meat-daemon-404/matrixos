/**
 * MatrixOS SDK · 资产图谱客户端（`/v1/assets`）
 *
 * 架构 §6.3 的唯一写入路径：
 *
 * ```
 * 微站 → MatrixSDK.emitAsset() → 本地契约校验 → POST /v1/assets → matrix-core
 * ```
 *
 * 「微站不得直连数据库」这条铁律在 SDK 侧的执行方式就是：**这里没有数据库连接，
 * 只有 HTTP**。任何微站想绕过 SDK 都得自己实现一遍鉴权 + CSRF + 重试，
 * 那比直接用 SDK 麻烦得多——这是让正确做法成为最省事做法的设计。
 *
 * ## 写入前的两道本地校验
 *
 * 1. **证据非空**（合规红线，架构 §5.3 W1 在资产侧的同构要求）；
 * 2. **`verification_level` 与证据等级的一致性**——声明 `Level_A_Verified`
 *    却没有任何带 PDF 页码的证据锚点，是自相矛盾的（Level A 的定义就含 PDF 坐标）。
 *
 * 本地校验的意义不是安全（服务端还要再验一遍），而是**反馈速度**：
 * 用户点「沉淀到资产图谱」后 50ms 就得到错误，而不是等一个来回。
 */

import { MatrixError } from '../errors.ts';
import type { MatrixHttpClient } from '../http/client.ts';
import type {
  AssetClient,
  AssetListQuery,
  AssetNode,
  AssetSearchHit,
  AssetSearchQuery,
  EmitAssetInput,
  Paginated,
} from '../types.ts';

export interface AssetClientInit {
  readonly http: MatrixHttpClient;
  readonly selfApp: string;
  readonly getMatrixUid: () => string | null;
  readonly debug?: boolean;
}

interface RawListResponse {
  readonly items?: unknown;
  readonly next_cursor?: unknown;
  readonly total?: unknown;
}

interface RawSearchResponse {
  readonly hits?: unknown;
}

export class AssetClientImpl implements AssetClient {
  readonly #http: MatrixHttpClient;
  readonly #selfApp: string;
  readonly #getMatrixUid: () => string | null;
  readonly #debug: boolean;

  constructor(init: AssetClientInit) {
    this.#http = init.http;
    this.#selfApp = init.selfApp;
    this.#getMatrixUid = init.getMatrixUid;
    this.#debug = init.debug ?? false;
  }

  /**
   * 沉淀一条资产到数字孪生图谱。
   *
   * `idempotencyKey` 强烈建议传：网络抖动时 SDK 会自动重试 POST，
   * 没有幂等键的重试会产生重复资产节点（这是财务/成绩类数据的大忌）。
   */
  async emit(asset: EmitAssetInput): Promise<AssetNode> {
    this.#assertEvidence(asset);

    const body: Record<string, unknown> = {
      station_id: this.#selfApp,
      asset_type: asset.assetType,
      payload: asset.payload,
      evidence_anchors: asset.evidenceAnchors,
      verification_level: asset.verificationLevel ?? inferVerificationLevel(asset.evidenceAnchors),
    };
    if (asset.title !== undefined) body.title = asset.title;
    if (asset.traceId !== undefined) body.trace_id = asset.traceId;
    if (asset.localRef !== undefined) body.local_ref = asset.localRef;
    const matrixUid = this.#getMatrixUid();
    if (matrixUid !== null) body.matrix_uid = matrixUid;

    const response = await this.#http.request<AssetNode>({
      method: 'POST',
      path: '/v1/assets',
      body,
      ...(asset.idempotencyKey !== undefined ? { idempotencyKey: asset.idempotencyKey } : {}),
      ...(asset.traceId !== undefined ? { traceId: asset.traceId } : {}),
    });

    return normalizeAssetNode(response);
  }

  async get(assetId: string, options: { readonly version?: number } = {}): Promise<AssetNode> {
    if (assetId.trim().length === 0) {
      throw new MatrixError({ code: 'VALIDATION', message: 'assetId 不能为空', retryable: false });
    }
    const response = await this.#http.request<AssetNode>({
      method: 'GET',
      path: `/v1/assets/${encodeURIComponent(assetId)}`,
      ...(options.version !== undefined ? { query: { version: options.version } } : {}),
      skipCsrf: true,
    });
    return normalizeAssetNode(response);
  }

  async list(query: AssetListQuery = {}): Promise<Paginated<AssetNode>> {
    const response = await this.#http.request<RawListResponse>({
      method: 'GET',
      path: '/v1/assets',
      query: {
        station_id: query.stationId,
        asset_type: query.assetType,
        verification_level: query.verificationLevel,
        trace_id: query.traceId,
        limit: query.limit,
        cursor: query.cursor,
        order: query.order,
      },
      skipCsrf: true,
    });

    const items = Array.isArray(response?.items) ? response.items.map(normalizeAssetNode) : [];
    return {
      items,
      nextCursor: typeof response?.next_cursor === 'string' ? response.next_cursor : null,
      ...(typeof response?.total === 'number' ? { total: response.total } : {}),
    };
  }

  /** 向量 + 全文混合检索（pgvector，ADR-04）。 */
  async search(query: AssetSearchQuery): Promise<readonly AssetSearchHit[]> {
    if (query.query.trim().length === 0) {
      throw new MatrixError({ code: 'VALIDATION', message: '检索关键词不能为空', retryable: false });
    }
    const response = await this.#http.request<RawSearchResponse>({
      method: 'POST',
      path: '/v1/assets/search',
      body: {
        query: query.query,
        top_k: query.topK ?? 10,
        ...(query.stationId !== undefined ? { station_id: query.stationId } : {}),
        ...(query.assetType !== undefined ? { asset_type: query.assetType } : {}),
        ...(query.minScore !== undefined ? { min_score: query.minScore } : {}),
      },
      idempotencyKey: undefined,
    });

    const raw = Array.isArray(response?.hits) ? response.hits : [];
    return raw
      .map((hit): AssetSearchHit | null => {
        if (hit === null || typeof hit !== 'object') return null;
        const record = hit as Record<string, unknown>;
        const assetRaw = record.asset ?? record.asset_node ?? null;
        if (assetRaw === null) return null;
        return {
          asset: normalizeAssetNode(assetRaw),
          score: typeof record.score === 'number' ? record.score : 0,
          ...(typeof record.snippet === 'string' ? { snippet: record.snippet } : {}),
        };
      })
      .filter((hit): hit is AssetSearchHit => hit !== null);
  }

  /**
   * 更新资产。走 PATCH，服务端做版本递增。
   *
   * 注意 `evidence_anchors` 的**不可弱化**：更新时若把证据清空，
   * 本地就会先拒（与 `emit` 同一套校验）。
   */
  async update(assetId: string, patch: Partial<EmitAssetInput>): Promise<AssetNode> {
    if (patch.evidenceAnchors !== undefined && patch.evidenceAnchors.length === 0) {
      throw MatrixError.validation('更新被拒绝：证据锚点不能清空（合规红线）', [
        'evidence_anchors: 至少需要 1 条',
      ]);
    }

    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.payload !== undefined) body.payload = patch.payload;
    if (patch.evidenceAnchors !== undefined) body.evidence_anchors = patch.evidenceAnchors;
    if (patch.verificationLevel !== undefined) body.verification_level = patch.verificationLevel;
    if (patch.localRef !== undefined) body.local_ref = patch.localRef;

    const response = await this.#http.request<AssetNode>({
      method: 'PATCH',
      path: `/v1/assets/${encodeURIComponent(assetId)}`,
      body,
    });
    return normalizeAssetNode(response);
  }

  async remove(assetId: string): Promise<void> {
    await this.#http.request<void>({
      method: 'DELETE',
      path: `/v1/assets/${encodeURIComponent(assetId)}`,
    });
  }

  /** 图遍历：`asset_edge` 的多跳溯源。这是「DigitalTwin **Graph**」而非宽表的意义所在。 */
  async traverse(assetId: string, options: { readonly depth?: number; readonly relation?: string } = {}): Promise<readonly AssetNode[]> {
    const response = await this.#http.request<{ nodes?: unknown }>({
      method: 'GET',
      path: `/v1/assets/${encodeURIComponent(assetId)}/traverse`,
      query: {
        depth: options.depth ?? 2,
        relation: options.relation,
      },
      skipCsrf: true,
    });
    const nodes = Array.isArray(response?.nodes) ? response.nodes : [];
    return nodes.map(normalizeAssetNode);
  }

  /**
   * 写入前的本地合规校验。
   *
   * 这两条是**红线**，不是最佳实践：
   *   - 架构 W1：`evidence_anchors` 为空 = 学术幻觉的直接入口；
   *   - `Level_A_Verified` 的定义就包含 PDF 坐标，声明 A 级却无坐标是自相矛盾。
   */
  #assertEvidence(asset: EmitAssetInput): void {
    if (!Array.isArray(asset.evidenceAnchors) || asset.evidenceAnchors.length === 0) {
      throw MatrixError.validation('资产写入被拒绝：证据锚点为空', [
        'evidence_anchors: 至少需要 1 条（合规红线：所有引用必须带证据锚点，杜绝大模型学术幻觉）',
      ]);
    }

    const missing = asset.evidenceAnchors
      .map((anchor, index) => {
        const problems: string[] = [];
        if (typeof anchor.source_doi_or_url !== 'string' || anchor.source_doi_or_url.trim().length === 0) {
          problems.push('source_doi_or_url 为空');
        }
        if (anchor.verification_level === undefined) problems.push('verification_level 缺失');
        if (anchor.bbox !== undefined && (!Array.isArray(anchor.bbox) || anchor.bbox.length !== 4)) {
          problems.push('bbox 必须是 [x0, y0, x1, y1] 四个数');
        }
        return problems.length === 0 ? null : `evidence_anchors[${index}]: ${problems.join('、')}`;
      })
      .filter((item): item is string => item !== null);

    if (missing.length > 0) {
      throw MatrixError.validation('资产写入被拒绝：证据锚点字段不完整', missing);
    }

    // 声明 A 级但没有任何一条带坐标/页码 → 自相矛盾。
    const declaredLevel = asset.verificationLevel ?? inferVerificationLevel(asset.evidenceAnchors);
    if (declaredLevel === 'Level_A_Verified') {
      const hasLocatable = asset.evidenceAnchors.some(
        (anchor) => anchor.pdf_page !== undefined || anchor.bbox !== undefined,
      );
      if (!hasLocatable) {
        if (this.#debug) {
          console.debug('[matrixos/sdk] 声明 Level_A_Verified 但无任何可定位坐标，降级为 Level_B_Preprint');
        }
        throw MatrixError.validation(
          '资产写入被拒绝：声明 Level_A_Verified 但没有任何证据锚点带 pdf_page 或 bbox',
          [
            'verification_level: Level_A_Verified 要求有 DOI + PDF 坐标 + 人工/AI 双验；无坐标的证据最高只能是 Level_B_Preprint',
          ],
        );
      }
    }
  }
}

/**
 * 从证据锚点推断整体验证等级。
 *
 * 规则取「最弱一环」：只要有一条是预印本，整条资产就不该标 A 级——
 * 因为资产的价值取决于它最不可靠的那条证据。
 * 撤稿警告优先级最高，压过一切。
 */
export function inferVerificationLevel(
  anchors: readonly { readonly verification_level?: string }[],
): AssetNode['verification_level'] {
  if (anchors.some((anchor) => anchor.verification_level === 'Retracted_Warning')) {
    return 'Retracted_Warning';
  }
  if (anchors.length === 0) return 'Level_B_Preprint';
  if (anchors.every((anchor) => anchor.verification_level === 'Level_A_Verified')) {
    return 'Level_A_Verified';
  }
  return 'Level_B_Preprint';
}

/** 服务端返回的节点做一次宽松归一化：缺字段补安全默认值，避免 UI 到处判空。 */
function normalizeAssetNode(raw: unknown): AssetNode {
  if (raw === null || typeof raw !== 'object') {
    throw new MatrixError({
      code: 'HTTP',
      message: '资产服务返回的节点不是对象',
      retryable: false,
    });
  }
  const record = raw as Record<string, unknown>;
  return {
    asset_id: typeof record.asset_id === 'string' ? record.asset_id : '',
    matrix_uid: typeof record.matrix_uid === 'string' ? record.matrix_uid : '',
    station_id: typeof record.station_id === 'string' ? record.station_id : '',
    asset_type: (typeof record.asset_type === 'string' ? record.asset_type : 'dataset') as AssetNode['asset_type'],
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    payload: typeof record.payload === 'object' && record.payload !== null ? (record.payload as Record<string, unknown>) : {},
    evidence_anchors: Array.isArray(record.evidence_anchors)
      ? (record.evidence_anchors as AssetNode['evidence_anchors'])
      : [],
    verification_level: (typeof record.verification_level === 'string'
      ? record.verification_level
      : 'Level_B_Preprint') as AssetNode['verification_level'],
    ...(typeof record.trace_id === 'string' ? { trace_id: record.trace_id } : {}),
    version: typeof record.version === 'number' ? record.version : 1,
    created_at: typeof record.created_at === 'string' ? record.created_at : new Date(0).toISOString(),
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : new Date(0).toISOString(),
    ...(record.local_ref !== null && typeof record.local_ref === 'object'
      ? { local_ref: record.local_ref as NonNullable<AssetNode['local_ref']> }
      : {}),
  };
}
