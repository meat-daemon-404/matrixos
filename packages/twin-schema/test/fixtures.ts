/**
 * 测试用的合法样本工厂。
 *
 * 统一放在一处，避免每个测试文件各写一份「看起来差不多」的样本——
 * 那样一旦契约加字段，就要改 5 个文件，改漏一个就会静默失去覆盖。
 *
 * 所有工厂返回**全新对象**（每次调用重新构造），测试之间不会互相污染。
 */

/** 合法 uuid v4 形态。 */
export const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
export const UUID_B = '11111111-2222-4333-8444-555555555555';

/**
 * 三档证据可信度。
 * 这里显式声明联合类型，而不是在工厂里用 `as const`：
 * 用 as const 会把返回类型收窄成单一字面量，导致测试里
 * `anchor.verification_level = level`（level 为联合类型）编译失败。
 */
export type VerificationLevel = 'Level_A_Verified' | 'Level_B_Preprint' | 'Retracted_Warning';

/** 一条 Level_A 证据锚点。 */
export function levelAAnchor(source = '10.1021/jacs.4c0112') {
  return {
    source_doi_or_url: source,
    pdf_page: 7,
    bbox: [72.5, 144.0, 300.25, 210.75] as [number, number, number, number],
    verification_level: 'Level_A_Verified' as VerificationLevel,
  };
}

/** 一份合法的虫洞信封。 */
export function validEnvelope() {
  return {
    $schema: 'https://matrixos.edu/contracts/wormhole-envelope.schema.json',
    trace_id: UUID_A,
    matrix_uid: 'mx_01H8Z9K2QW',
    source_app: 'curvelab.matrixos.edu',
    target_app: 'mentor.matrixos.edu',
    payload_type: 'curve_fit_parameters' as const,
    payload: {
      data: {
        tau: 3.42,
        r_squared: 0.987,
        model: 'biexponential',
      },
      evidence_anchors: [levelAAnchor()],
    },
    created_at: '2026-10-20T11:54:10+08:00',
  };
}

/** 一份合法的调度契约。 */
export function validDispatch() {
  return {
    trace_id: UUID_B,
    user_id: 'mx_01H8Z9K2QW',
    station_id: 'xingmen' as const,
    intent: {
      action: 'find_mentor',
      discipline: '物理',
      parameters: { keywords: ['钙钛矿', '钝化'], max_results: 5 },
    },
    workflow: [
      {
        step_id: 1,
        service_name: 'copilot-router',
        model_tier: 'flash' as const,
        status: 'success' as const,
        input_payload: { query: '钙钛矿钝化导师' },
      },
      {
        step_id: 2,
        service_name: 'openalex-pat-worker',
        model_tier: 'pro' as const,
        depends_on: [1],
        status: 'pending' as const,
      },
    ],
  };
}

/** 一份合法的微站 manifest。 */
export function validManifest() {
  return {
    manifest_version: '1.0' as const,
    app_id: 'bioscan',
    name: '生物扫描实验室',
    entry_url: 'https://bioscan.matrixos.edu',
    orbit_station: 'cloud_balance' as const,
    icon: 'https://bioscan.matrixos.edu/icon.svg',
    accent_color: '#1A2B3C',
    accepts: ['paper_doi_bundle' as const, 'comparison_matrix_row' as const],
    emits: ['comparison_matrix_row' as const],
    live_mini_view: {
      endpoint: 'https://bioscan.matrixos.edu/api/live',
      refresh_seconds: 300,
      display_field: 'active_samples',
    },
    permissions: ['matrix_id:read' as const, 'assets:read' as const],
    author: {
      lab_name: 'Zhang Lab',
      university: '某某大学',
      contact_email: 'zhang@example.edu',
    },
  };
}

/** 一份合法的资产节点。 */
export function validAssetNode() {
  return {
    asset_id: UUID_A,
    matrix_uid: 'mx_01H8Z9K2QW',
    station_id: 'curvelab',
    asset_type: 'fit_result' as const,
    title: 'TRPL 双指数拟合',
    payload: { tau_fast: 0.42, tau_slow: 3.1, r_squared: 0.987 },
    evidence_anchors: [levelAAnchor()],
    verification_level: 'Level_A_Verified' as const,
    trace_id: UUID_B,
    version: 1,
    created_at: '2026-10-20T11:54:10Z',
    updated_at: '2026-10-20T11:54:10Z',
  };
}

/** 一份合法的 1024 维 embedding。 */
export function embedding1024(fill = 0.0125): number[] {
  return Array.from({ length: 1024 }, (_, i) => fill + i * 1e-6);
}
