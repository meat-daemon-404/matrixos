/**
 * 「台账记录型」微站的业务规格工厂。
 *
 * 为什么要有它：
 *   18 个微站的完工层（增/删/改/清空/导出/投送/接收）在结构上是同一件事，
 *   差别只在**业务字段名与演示数据**。如果让 18 份 site-spec.ts 各写一遍
 *   增删改逻辑，必然出现 18 份不一致实现，集成验收会崩。
 *   所以这里把「记录型台账」的通用语义固化成一个工厂，
 *   每个站只需提供一个配置字面量（演示数据 + 投送字段映射）。
 *
 * 约束：本文件是纯 TS，不含 React，会被 tsc 编进 shared/dist。
 */

import type {
  CsvTable,
  ConsumableEnvelope,
  EnvelopePayloadLike,
  RecordDraft,
  RecordView,
  SiteWorkbenchSpec,
} from './types.js';
import type { WormholePayloadType } from '../ledger.js';

/** 一条台账记录。`title/meta/detail` 是 UI 展示位，其余字段由各站自定义。 */
export interface LedgerRow {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly detail: string;
  /** 最后修改时间（ISO）。编辑时刷新它，用来证明「改」真的落盘。 */
  readonly updatedAt: string;
  /** 编辑次数。Workbench 用它证明「改」确实改变了数据。 */
  readonly edits?: number;
  /** 该条记录对应的证据锚点（可选）。投送时会聚合成信封的 evidence_anchors。 */
  readonly anchor?: EnvelopePayloadLike['evidence_anchors'][number];
  readonly [extra: string]: unknown;
}

/** 台账数据 = 一组记录（外层对象，便于以后加 schemaVersion 之类的字段）。 */
export interface RowLedgerData {
  readonly rows: readonly LedgerRow[];
}

/** 演示数据/新增草稿：只需给出展示三段 + 自定义字段。 */
export interface RowSeed {
  readonly title: string;
  readonly meta: string;
  readonly detail: string;
  readonly anchor?: EnvelopePayloadLike['evidence_anchors'][number];
  readonly [extra: string]: unknown;
}

export interface RowSpecConfig {
  /** 导出文件名前缀，如 `gpa-plans`。 */
  readonly exportName: string;

  /** 首次打开时的演示数据（确定性，答辩可复现）。 */
  readonly seed: readonly RowSeed[];

  /** 主动投送的目标站与 payload 类型（必须与本站 matrix-app.manifest.json 的 emits 一致）。 */
  readonly emit: {
    readonly targetApp: string;
    readonly payloadType: WormholePayloadType;
  };

  /** 接收消费的 payload 类型（必须与 manifest 的 accepts 一致）。 */
  readonly accept: {
    readonly payloadType: WormholePayloadType;
    /** 面板上展示的一句话，说明消费后落到哪张表。 */
    readonly description: string;
  };

  /** 新增一条的默认内容。缺省按序号生成一条「待补全」记录。 */
  readonly draft?: (rows: readonly LedgerRow[], nowIso: string) => RowSeed;

  /** 投送信封里的 `payload.data`。缺省 `{ ledger, count, rows }`。 */
  readonly payloadOf?: (rows: readonly LedgerRow[], nowIso: string) => Record<string, unknown>;

  /** 把收到的信封并成一条记录。缺省从 `payload.data` 里尽力取 title/meta/detail。 */
  readonly rowOfEnvelope?: (envelope: ConsumableEnvelope, nowIso: string) => RowSeed;

  /** CSV 列定义。缺省 id/title/meta/detail/updatedAt。 */
  readonly csvOf?: (rows: readonly LedgerRow[]) => CsvTable;
}

/** 站内台账版本号：改动 seed 数据形状时 +1，旧数据会自动回落默认值。 */
export const LEDGER_VERSION = 1;

let seq = 0;

/** 生成一个稳定形状的本地 id（不依赖 crypto，SSR 与浏览器都能跑）。 */
function makeId(nowIso: string): string {
  seq = (seq + 1) % 1000;
  const stamp = nowIso.replace(/[^0-9]/g, '').slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 6);
  return `r-${stamp}-${seq}-${rand}`;
}

function toRow(seed: RowSeed, nowIso: string): LedgerRow {
  return { ...seed, id: makeId(nowIso), updatedAt: nowIso, edits: 0 };
}

function text(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

/** 剥掉编辑标记，避免反复编辑把标题越拉越长。 */
function baseTitle(title: string): string {
  return title.replace(/\s*·\s*已编辑\s*\d*\s*次?$/, '');
}

function rowsOf(data: RowLedgerData | undefined | null): readonly LedgerRow[] {
  return Array.isArray(data?.rows) ? data.rows : [];
}

/** 缺省的「外部信封 → 一条记录」映射：尽力从 payload.data 里取三段文本。 */
export function defaultRowOfEnvelope(envelope: ConsumableEnvelope, nowIso: string): RowSeed {
  const payload = envelope?.payload;
  const data = (payload?.data ?? {}) as Record<string, unknown>;
  const anchors = Array.isArray(payload?.evidence_anchors) ? payload.evidence_anchors : [];
  const firstAnchor = anchors[0];
  const title = text(data.title ?? data.name ?? data.label, '外部投送记录');
  const meta = `来自 ${text(envelope?.source_app, 'unknown')} · ${text(envelope?.payload_type, 'unknown')} · 证据锚点 ${anchors.length} 条`;
  const detail = text(
    data.detail ?? data.summary ?? data.description,
    `接收于 ${nowIso.slice(0, 19).replace('T', ' ')}`,
  );
  return {
    title,
    meta,
    detail,
    ...(firstAnchor ? { anchor: firstAnchor } : {}),
    traceId: text(envelope?.trace_id, 'unknown'),
  };
}

/** 站内基线证据锚点：台账为空时用它兜底，保证信封永远满足「至少 1 条锚点」的契约红线。 */
export function baselineAnchor(domain: string): EnvelopePayloadLike['evidence_anchors'][number] {
  return {
    source_doi_or_url: `https://${domain}/`,
    verification_level: 'Level_B_Preprint',
  };
}

/**
 * 建一个「记录型台账」的业务规格。
 *
 * 返回的对象满足 `SiteWorkbenchSpec<RowLedgerData>`，可直接喂给 Workbench。
 */
export function createRowSpec(config: RowSpecConfig): SiteWorkbenchSpec<RowLedgerData> {
  const seedRows = config.seed;

  const draftOf = (rows: readonly LedgerRow[], nowIso: string): RowSeed => {
    if (config.draft) return config.draft(rows, nowIso);
    const n = rows.length + 1;
    return {
      title: `待补全记录 ${String(n).padStart(2, '0')}`,
      meta: `本地新增 · ${nowIso.slice(0, 10)}`,
      detail: '点「编辑」补充这条记录的业务字段；改动会立即写入本地台账。',
    };
  };

  const spec: SiteWorkbenchSpec<RowLedgerData> = {
    exportName: config.exportName,

    createDefault(): RowLedgerData {
      const epoch = new Date(0).toISOString();
      return {
        rows: seedRows.map((seed, i) => ({
          ...toRow(seed, epoch),
          id: `seed-${String(i + 1).padStart(2, '0')}`,
        })),
      };
    },

    createEmpty(): RowLedgerData {
      return { rows: [] };
    },

    validate(value: unknown): value is RowLedgerData {
      if (typeof value !== 'object' || value === null) return false;
      const rows = (value as { rows?: unknown }).rows;
      if (!Array.isArray(rows)) return false;
      return rows.every((row) => {
        if (typeof row !== 'object' || row === null) return false;
        const r = row as Record<string, unknown>;
        return (
          typeof r.id === 'string' &&
          typeof r.title === 'string' &&
          typeof r.meta === 'string' &&
          typeof r.detail === 'string'
        );
      });
    },

    records(data: RowLedgerData): readonly RecordView[] {
      return rowsOf(data).map((row) => ({
        id: String(row.id),
        title: String(row.title),
        meta: String(row.meta),
        detail: String(row.detail),
      }));
    },

    add(data: RowLedgerData, nowIso: string): RowLedgerData {
      const rows = rowsOf(data);
      return { rows: [...rows, toRow(draftOf(rows, nowIso), nowIso)] };
    },

    edit(data: RowLedgerData, id: string, nowIso: string): RowLedgerData {
      return {
        rows: rowsOf(data).map((row) => {
          if (String(row.id) !== id) return row;
          const edits = Number(row.edits ?? 0) + 1;
          return {
            ...row,
            edits,
            title: `${baseTitle(String(row.title))} · 已编辑 ${edits} 次`,
            updatedAt: nowIso,
          };
        }),
      };
    },

    /**
     * 用**用户输入**改写一条记录。
     *
     * 与 `edit` 的分工：`edit` 是「系统按规则改」（追加编辑次数标记，用于验收与演示），
     * `patch` 是「用户填自己的内容」。两者都刷新 updatedAt，但 patch **不**动标题后缀 ——
     * 用户输入的标题应当原样保存，不该被系统追加「已编辑 N 次」。
     *
     * 裁剪规则：只接受 title/meta/detail 三个字段，字符串两端空白去掉；
     * 结果为空串时**保持原值**（不允许把标题清成空，否则列表里就只剩一串空白行）。
     */
    patch(data: RowLedgerData, id: string, patch: RecordDraft, nowIso: string): RowLedgerData {
      const pick = (next: string | undefined, current: string): string => {
        if (typeof next !== 'string') return current;
        const trimmed = next.trim();
        return trimmed === '' ? current : trimmed;
      };
      return {
        rows: rowsOf(data).map((row) => {
          if (String(row.id) !== id) return row;
          return {
            ...row,
            title: pick(patch.title, String(row.title)),
            meta: pick(patch.meta, String(row.meta)),
            detail: pick(patch.detail, String(row.detail)),
            updatedAt: nowIso,
          };
        }),
      };
    },

    remove(data: RowLedgerData, id: string): RowLedgerData {
      return { rows: rowsOf(data).filter((row) => String(row.id) !== id) };
    },

    csv(data: RowLedgerData): CsvTable {
      const rows = rowsOf(data);
      if (config.csvOf) return config.csvOf(rows);
      return {
        header: ['id', '标题', '摘要', '详情', '最后修改'],
        rows: rows.map((row) => [
          String(row.id),
          String(row.title),
          String(row.meta),
          String(row.detail),
          String(row.updatedAt ?? ''),
        ]),
      };
    },

    emit: {
      targetApp: config.emit.targetApp,
      payloadType: config.emit.payloadType,
      build(data: RowLedgerData, nowIso: string): EnvelopePayloadLike {
        const rows = rowsOf(data);
        const payloadData = config.payloadOf
          ? config.payloadOf(rows, nowIso)
          : {
              ledger: config.exportName,
              count: rows.length,
              rows: rows.map((row) => ({
                id: String(row.id),
                title: String(row.title),
                meta: String(row.meta),
                detail: String(row.detail),
              })),
            };
        const anchors: EnvelopePayloadLike['evidence_anchors'][number][] = [];
        for (const row of rows) {
          if (row.anchor) anchors.push(row.anchor);
        }
        return { data: payloadData, evidence_anchors: anchors };
      },
    },

    accept: {
      payloadType: config.accept.payloadType,
      description: config.accept.description,
      consume(data: RowLedgerData, envelope: ConsumableEnvelope, nowIso: string): RowLedgerData {
        const rows = rowsOf(data);
        const seed = config.rowOfEnvelope
          ? config.rowOfEnvelope(envelope, nowIso)
          : defaultRowOfEnvelope(envelope, nowIso);
        return { rows: [toRow(seed, nowIso), ...rows] };
      },
    },
  };

  return spec;
}
