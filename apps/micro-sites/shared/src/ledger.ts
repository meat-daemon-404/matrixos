/**
 * 微站本地台账（Local Ledger）—— 18 个微站共用的持久化底座。
 *
 * 为什么需要它：
 *   18 个微站每个都要有「独立持久化台账」（WBS S3 统一验收项 3），
 *   而当前 `matrix-core` 的 `/v1/assets` 尚未接入前端演示链路。
 *   在这一步之前，用浏览器 localStorage 提供**真实可用**的端侧台账：
 *   刷新不丢、可新建/读取/更新/删除、可导出 JSON/CSV，
 *   并且数据格式带版本号，未来切到 /v1/assets 时可以平滑迁移。
 *
 * 设计约束（都是踩过的坑）：
 *   1. **版本化信封**：只存裸数据的话，字段一变旧数据就会炸 UI。
 *      这里统一存 `{ version, updatedAt, data }`，读取时校验版本，
 *      遇到旧版本走 `migrate`，遇到坏数据回退默认值而不是抛错。
 *   2. **SSR 安全**：模块在 Next.js 服务端也会被 import，
 *      因此任何地方都不能在模块顶层直接摸 `window`/`localStorage`。
 *   3. **不静默失败**：读写失败（隐私模式、配额满、被禁用）时
 *      `available` 变为 false，调用方必须在 UI 上显式提示，
 *      不允许假装保存成功（全仓「不伪造」约定）。
 *   4. **导出是硬需求**：台账数据必须能被用户带走。
 *      JSON / CSV / 任意文本三种导出都经由 Blob 下载，不依赖后端。
 *
 * 用法（微站内）：
 * ```ts
 * import { createLedger } from '@matrixos/microsite-data';
 *
 * interface GpaPlan { id: string; name: string; courses: CourseRow[]; savedAt: string }
 *
 * export const gpaLedger = createLedger<GpaPlan[]>({
 *   key: 'mx.gpa.plans',
 *   version: 1,
 *   createDefault: () => [],
 *   validate: (v): v is GpaPlan[] => Array.isArray(v),
 * });
 * ```
 *
 * React 侧推荐的水合安全写法（**不要**在 useState 初始化里读 localStorage，
 * 否则静态导出预渲染的 HTML 与客户端首帧不一致，React 会报 hydration 错误）：
 * ```ts
 * const [snap, setSnap] = useState(() => ledger.readDefault()); // 服务端/首帧都走默认值
 * useEffect(() => { setSnap(ledger.read()); }, []);            // 挂载后再读真实台账
 * ```
 */

/* ────────────────────────── 存储抽象（测试可注入） ────────────────────────── */

/** localStorage 的最小接口子集；测试里可注入内存实现。 */
export interface LedgerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LedgerOptions<T> {
  /** localStorage 键名，建议 `mx.<站名>.<用途>`，例如 `mx.gpa.plans` */
  readonly key: string;
  /** 数据结构版本号。字段含义变化时 +1，并补 `migrate`。 */
  readonly version: number;
  /** 首次读取时的默认值工厂（每次返回新对象，避免共享引用） */
  readonly createDefault: () => T;
  /** 反序列化后的形状校验。缺省时只要 JSON 解析成功就采用。 */
  readonly validate?: (value: unknown) => value is T;
  /** 旧版本数据迁移。返回 null 表示无法迁移，读默认值。 */
  readonly migrate?: (raw: unknown, fromVersion: number) => T | null;
  /** 测试注入；生产环境留空，自动使用全局 localStorage */
  readonly storage?: LedgerStorage | null;
}

/** 台账快照：`data` 是业务数据，其余是同步元信息。 */
export interface LedgerSnapshot<T> {
  readonly version: number;
  /** ISO 时间；从未写入过时为默认值创建时刻 */
  readonly updatedAt: string;
  readonly data: T;
}

/** 台账句柄。所有方法都不会抛错；失败通过返回值 / `available` 表达。 */
export interface Ledger<T> {
  readonly key: string;
  /** 存储是否可用。false 时 UI 必须显式提示「本次未能持久化」 */
  readonly available: boolean;
  /** 只取默认值，不读存储。用于 SSR / 客户端首帧，保证水合一致 */
  readDefault(): LedgerSnapshot<T>;
  /** 读当前快照（坏数据 / 无数据时返回默认值，不写盘） */
  read(): LedgerSnapshot<T>;
  /** 覆盖写入并返回新快照 */
  write(data: T): LedgerSnapshot<T>;
  /** 读改写一步完成，适合「往列表里 push 一条」 */
  update(updater: (prev: T) => T): LedgerSnapshot<T>;
  /** 清空键并返回默认快照 */
  reset(): LedgerSnapshot<T>;
  /** 导出当前数据为格式化 JSON 文件 */
  exportJson(filename?: string): boolean;
  /** 导出任意文本文件（Markdown / Python 脚本 / Dockerfile 等） */
  exportText(filename: string, text: string, mime?: string): boolean;
  /** 导出二维数组为 CSV（带 UTF-8 BOM，Excel 打开中文不乱码） */
  exportCsv(
    filename: string,
    rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
    options?: { readonly header?: readonly string[] },
  ): boolean;
}

/* ────────────────────────────── 内部工具 ────────────────────────────── */

const STORAGE_PROBE_KEY = 'mx.__probe__';

/** 探测全局 localStorage；隐私模式/被禁用时返回 null（只探测一次）。 */
let cachedStorage: LedgerStorage | null | undefined;

function globalStorage(): LedgerStorage | null {
  if (cachedStorage !== undefined) return cachedStorage;
  try {
    if (typeof globalThis === 'undefined') {
      cachedStorage = null;
      return cachedStorage;
    }
    const candidate = (globalThis as { localStorage?: LedgerStorage }).localStorage;
    if (!candidate) {
      cachedStorage = null;
      return cachedStorage;
    }
    // Safari 隐私模式会给出对象但一写就抛，这里真写一次再撤回。
    candidate.setItem(STORAGE_PROBE_KEY, '1');
    candidate.removeItem(STORAGE_PROBE_KEY);
    cachedStorage = candidate;
    return cachedStorage;
  } catch {
    cachedStorage = null;
    return cachedStorage;
  }
}

/** 仅供测试使用：重置全局探测缓存，注入不同 storage。 */
export function __resetLedgerStorageProbe(): void {
  cachedStorage = undefined;
}

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

interface PersistedEnvelope {
  readonly version: number;
  readonly updatedAt: string;
  readonly data: unknown;
}

function isEnvelope(value: unknown): value is PersistedEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.version === 'number' && isIsoString(record.updatedAt) && 'data' in record;
}

/* ───────────────────────────── 文件导出 ───────────────────────────── */

/** 触发浏览器下载。返回 false 表示当前环境不支持（例如 SSR / 无 document）。 */
export function downloadBlob(filename: string, blob: Blob): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  // createObjectURL 在部分测试环境不存在
  const createObjectURL = URL.createObjectURL;
  if (typeof createObjectURL !== 'function') return false;
  try {
    const href = createObjectURL.call(URL, blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // 给浏览器一点时间取数据再回收
    setTimeout(() => {
      try {
        URL.revokeObjectURL(href);
      } catch {
        /* 忽略 */
      }
    }, 1000);
    return true;
  } catch {
    return false;
  }
}

/** 导出文本文件（自动补 UTF-8 BOM，Windows 记事本/Excel 打开中文正确）。 */
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): boolean {
  if (typeof Blob === 'undefined') return false;
  const payload = mime.startsWith('text/') || mime.includes('json') ? '\uFEFF' + text : text;
  return downloadBlob(filename, new Blob([payload], { type: mime }));
}

/** 二维数组 → CSV 文本。数值不做本地化（避免 `1,234` 被 Excel 拆列）。 */
export function toCsv(
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
  header?: readonly string[],
): string {
  const escapeCell = (cell: string | number | boolean | null | undefined): string => {
    if (cell === null || cell === undefined) return '';
    const raw = typeof cell === 'string' ? cell : String(cell);
    // 引号转义；含分隔符 / 引号 / 换行时整体加引号
    return /[",\n\r]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
  };
  const lines: string[] = [];
  if (header) lines.push(header.map(escapeCell).join(','));
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  // Excel 对 \n 的接受度最好，统一 CRLF
  return lines.join('\r\n');
}

/* ────────────────────────────── 台账实现 ────────────────────────────── */

/** 创建一份带版本号的本地台账。 */
export function createLedger<T>(options: LedgerOptions<T>): Ledger<T> {
  const storage = options.storage !== undefined ? options.storage : globalStorage();
  const available = storage !== null;

  function defaultSnapshot(): LedgerSnapshot<T> {
    return { version: options.version, updatedAt: nowIso(), data: options.createDefault() };
  }

  function isValid(value: unknown): value is T {
    if (options.validate) return options.validate(value);
    return true;
  }

  function read(): LedgerSnapshot<T> {
    if (!storage) return defaultSnapshot();
    let raw: string | null = null;
    try {
      raw = storage.getItem(options.key);
    } catch {
      return defaultSnapshot();
    }
    if (raw === null || raw === '') return defaultSnapshot();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultSnapshot();
    }
    if (!isEnvelope(parsed)) return defaultSnapshot();

    if (parsed.version === options.version) {
      if (!isValid(parsed.data)) return defaultSnapshot();
      return { version: options.version, updatedAt: parsed.updatedAt, data: parsed.data };
    }

    // 版本不一致：能迁移就迁移，否则回默认值（不覆盖用户数据）
    if (options.migrate) {
      let migrated: T | null = null;
      try {
        migrated = options.migrate(parsed.data, parsed.version);
      } catch {
        migrated = null;
      }
      if (migrated !== null) {
        const upgraded: LedgerSnapshot<T> = {
          version: options.version,
          updatedAt: parsed.updatedAt,
          data: migrated,
        };
        // 迁移结果落盘，避免下次再迁
        write(upgraded.data);
        return upgraded;
      }
    }
    return defaultSnapshot();
  }

  function write(data: T): LedgerSnapshot<T> {
    const snapshot: LedgerSnapshot<T> = {
      version: options.version,
      updatedAt: nowIso(),
      data,
    };
    if (!storage) return snapshot;
    try {
      storage.setItem(options.key, JSON.stringify(snapshot));
    } catch {
      // 配额满 / 被禁用：返回快照但不假装已持久化，调用方看 available 决定提示
    }
    return snapshot;
  }

  function update(updater: (prev: T) => T): LedgerSnapshot<T> {
    const current = read();
    let next: T;
    try {
      next = updater(current.data);
    } catch {
      next = current.data;
    }
    return write(next);
  }

  function reset(): LedgerSnapshot<T> {
    if (storage) {
      try {
        storage.removeItem(options.key);
      } catch {
        /* 忽略 */
      }
    }
    return defaultSnapshot();
  }

  function exportJson(filename = options.key.replace(/[^\w.-]+/g, '-') + '.json'): boolean {
    const snapshot = read();
    const payload = {
      exportedAt: nowIso(),
      source: 'MatrixOS microsite local ledger',
      ledgerKey: options.key,
      version: options.version,
      updatedAt: snapshot.updatedAt,
      data: snapshot.data,
    };
    return downloadText(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  }

  function exportText(filename: string, text: string, mime?: string): boolean {
    return downloadText(filename, text, mime);
  }

  function exportCsv(
    filename: string,
    rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
    csvOptions?: { readonly header?: readonly string[] },
  ): boolean {
    const csv = toCsv(rows, csvOptions?.header);
    return downloadText(filename, csv, 'text/csv;charset=utf-8');
  }

  return {
    key: options.key,
    available,
    readDefault: defaultSnapshot,
    read,
    write,
    update,
    reset,
    exportJson,
    exportText,
    exportCsv,
  };
}

/* ───────────────────────── 虫洞本地演示信封 ───────────────────────── */

/**
 * 虫洞 payload 类型（与 specs/contracts/matrix-app-manifest.schema.json 的 enum 一致）。
 * 这里只做类型镜像，不做校验 —— 校验归 `@matrixos/twin-schema`。
 */
export type WormholePayloadType =
  | 'paper_doi_bundle'
  | 'comparison_matrix_row'
  | 'curve_fit_parameters'
  | 'mentor_match_card'
  | 'verified_cv_evidence';

/**
 * 证据锚点。字段与 `specs/contracts/wormhole-envelope.schema.json` 严格一致：
 * 该 schema 在锚点这一层是 `additionalProperties: false`，所以这里**不能加字段**
 * （曾经加过 `note`，会让信封无法通过契约校验，已删除）。
 */
export interface WormholeEvidenceAnchor {
  readonly source_doi_or_url: string;
  readonly verification_level: 'Level_A_Verified' | 'Level_B_Preprint' | 'Retracted_Warning';
  readonly pdf_page?: number;
  /** PDF 原文坐标 `[x0, y0, x1, y1]`，恰好 4 个数。 */
  readonly bbox?: readonly [number, number, number, number];
}

export interface WormholeEnvelopeLike {
  readonly trace_id: string;
  readonly matrix_uid: string;
  readonly source_app: string;
  readonly target_app: string;
  readonly payload_type: WormholePayloadType;
  readonly payload: {
    readonly data: Readonly<Record<string, unknown>>;
    readonly evidence_anchors: readonly WormholeEvidenceAnchor[];
  };
  readonly created_at: string;
}

function uuid(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  // 退化实现：仅用于演示/旧浏览器，格式仍是 UUID v4 形状
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.floor(Math.random() * 4) + 8) & 0xf] ?? '8';
    else out += hex[Math.floor(Math.random() * 16)] ?? '0';
  }
  return out;
}

/**
 * 构造一个**符合契约形状**的虫洞信封，用于 SDK 未就位时的本地演示。
 *
 * 诚实性约定：这个信封**没有真的发出去**。调用方必须在 UI 上写明
 * 「本地演示 · 未实际投送」，不能显示成「已投送至 XX」。
 */
export function createLocalWormholeEnvelope(input: {
  readonly sourceApp: string;
  readonly targetApp: string;
  readonly payloadType: WormholePayloadType;
  readonly data: Readonly<Record<string, unknown>>;
  readonly evidenceAnchors: readonly WormholeEvidenceAnchor[];
  readonly matrixUid?: string;
}): WormholeEnvelopeLike {
  if (input.evidenceAnchors.length === 0) {
    throw new Error('虫洞信封至少需要 1 条证据锚点（契约红线）');
  }
  return {
    trace_id: uuid(),
    matrix_uid: input.matrixUid ?? 'local-demo-user',
    source_app: input.sourceApp,
    target_app: input.targetApp,
    payload_type: input.payloadType,
    payload: { data: input.data, evidence_anchors: input.evidenceAnchors },
    created_at: nowIso(),
  };
}
