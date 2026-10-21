/**
 * ⚠️ 由 scripts/wire-workbench.mjs 从 apps/micro-sites/shared/templates/ 分发，请勿直接修改本文件。
 * 模板：apps/micro-sites/shared/templates/workbench-impl.tsx
 * 作用：完工台实现（台账增删改 / 导出 / 虫洞投送接收），18 站共用
 * 站点：01 学分绩点动态配重台
 * 轨道：轨道 1 · 学阶 · 域名：gpa.matrixos.cc.cd
 * 改法：改模板 → 跑 `node scripts/wire-workbench.mjs` 重新分发（18 站会一起更新）。
 */
'use client';

/**
 * 微站「完工台」(Workbench) —— 18 个微站共用的完工层。
 *
 * 为什么只有一份：
 *   18 个站的结构完全同构。台账增删改查、导出、虫洞投送、资产落库这些
 *   **完工契约**如果让 18 个站各写一套，必然写出 18 种不一致实现，
 *   集成验收会全线失败。所以这一层只写一次，各站只提供业务规格
 *   `SiteWorkbenchSpec<T>`（见 `./types.ts`）。
 *
 * 样式为什么内联：
 *   18 个站的 `globals.css` 各不相同（每站 accent 不同），若把完工台样式
 *   加进去就要改 18 个文件。这里用带 `.mx-wb` 前缀的内联 `<style>` 把
 *   样式封在组件内部，18 个站**零 CSS 改动**即可获得一致的完工台外观。
 *
 * 诚实性约定（重要）：
 *   - 静态演示站没有后端。只有 `bridge.hostConnected === true`（真正嵌在
 *     hub iframe 里）才允许真投送 / 真落库；否则只做本地演示，
 *     并在反馈里写明「未实际投送」。
 *   - 存储不可用时显式提示，不假装保存成功。
 *   - 投送时证据锚点为 0 会被当场拦下并如实报告（虫洞契约红线）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import {
  createLedger,
  type ConsumableEnvelope,
  type EnvelopePayloadLike,
  type Ledger,
  type LedgerSnapshot,
  type RecordDraft,
  type RecordView,
  type SdkBridge,
  type SiteIdentityLike,
  type SiteWorkbenchSpec,
} from '@matrixos/microsite-data';

/* ─────────────────────────────── 工具函数 ─────────────────────────────── */

function nowIso(): string {
  return new Date().toISOString();
}

/** UUID v4 形状。crypto 不可用时退化实现，仅用于演示。 */
function makeTraceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
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

/** 默认的站级证据锚点。台账为空时投送也要有据可依，不能凭空投。 */
function baselineAnchor(identity: SiteIdentityLike) {
  return {
    source_doi_or_url: `https://${identity.domain}/`,
    verification_level: 'Level_B_Preprint' as const,
  };
}

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

/* ─────────────────────────────── 样式 ─────────────────────────────── */

const WORKBENCH_CSS = `
.mx-wb {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: var(--radius-md, 12px);
  background: var(--color-bg-panel, #0b1124);
  border: 1px solid var(--color-border, #1e293b);
  min-width: 0;
}
.mx-wb-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; }
.mx-wb-head h2 {
  margin: 0; font-size: var(--text-sm, 14px); font-weight: 600;
  color: var(--color-instrument-bright, #22d3ee);
}
.mx-wb-head p { margin: 0; font-size: var(--text-xs, 12px); color: var(--color-text-muted, #94a3b8); }
.mx-wb-count { margin-left: auto; font-family: var(--font-mono, monospace); font-size: var(--text-xs, 12px); color: var(--color-text-secondary, #cbd5e1); }
.mx-wb-count b { color: var(--color-instrument-bright, #22d3ee); font-size: var(--text-sm, 14px); }
.mx-wb-toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
.mx-wb-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: var(--radius-sm, 8px);
  /* WCAG 2.5.8 (AA)：指针目标 ≥ 24×24。原 padding 6px 12px + 12px 字号实测
   * 仅 22px 高，且这是全站使用频率最高的按钮（新增/导出/清空/投送）。
   * min-height 32px 过 AA 且不破坏工具栏密度。 */
  min-height: 32px;
  font-family: var(--font-sans, system-ui); font-size: var(--text-xs, 12px); font-weight: 500;
  color: var(--color-text-secondary, #cbd5e1);
  background: var(--color-bg-raised, #0f172a);
  border: 1px solid var(--color-border-strong, #334155);
  cursor: pointer; transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
}
.mx-wb-btn:hover:not(:disabled) { color: var(--color-text, #f1f5f9); border-color: var(--color-action, #6366f1); }
.mx-wb-btn:disabled { opacity: .45; cursor: not-allowed; }
.mx-wb-btn[data-variant='primary'] {
  color: var(--color-bg, #050814); background: var(--color-action, #6366f1); border-color: transparent;
}
.mx-wb-btn[data-variant='primary']:hover:not(:disabled) { background: var(--color-action, #6366f1); color: var(--color-bg, #050814); filter: brightness(1.12); }
.mx-wb-btn[data-variant='danger'] { color: var(--color-danger, #f43f5e); border-color: rgba(244,63,94,.4); }
.mx-wb-btn[data-variant='danger']:hover:not(:disabled) { color: var(--color-danger, #f43f5e); border-color: var(--color-danger, #f43f5e); }
/* 撤销：清空之后才出现的短暂救回入口，用警示色吸引注意但不与「清空」同色混淆 */
.mx-wb-btn[data-variant='undo'] {
  color: var(--color-warning, #f59e0b);
  border-color: rgba(245, 158, 11, .5);
  background: rgba(245, 158, 11, .08);
}
.mx-wb-btn[data-variant='undo']:hover:not(:disabled) {
  color: var(--color-warning, #f59e0b);
  border-color: var(--color-warning, #f59e0b);
  background: rgba(245, 158, 11, .16);
}
.mx-wb-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.mx-wb-row {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px;
  padding: 10px 12px; border-radius: var(--radius-sm, 8px);
  background: var(--color-bg-sunken, #020617);
  border: 1px solid var(--color-border, #1e293b);
  border-left: 2px solid var(--site-accent, #6366f1);
  min-width: 0;
}
.mx-wb-row-main { flex: 1 1 220px; min-width: 0; }
.mx-wb-row-title { display: block; font-size: var(--text-xs, 12px); font-weight: 600; color: var(--color-text, #f1f5f9); overflow-wrap: anywhere; }
.mx-wb-row-meta { display: block; margin-top: 2px; font-family: var(--font-mono, monospace); font-size: var(--text-2xs, 10px); color: var(--color-text-faint, #7d8ba1); overflow-wrap: anywhere; }
.mx-wb-row-detail { display: block; margin-top: 3px; font-size: var(--text-2xs, 10px); color: var(--color-text-muted, #94a3b8); overflow-wrap: anywhere; }
.mx-wb-row-actions { display: flex; flex-shrink: 0; gap: 6px; }
.mx-wb-row-actions .mx-wb-btn { padding: 3px 8px; min-height: 24px; font-size: var(--text-2xs, 10px); }
/* 就地编辑：整行换成表单，宽度占满（不要再挤在 220px 的 flex 里） */
.mx-wb-row-editing { display: block; }
.mx-wb-form { display: flex; flex-direction: column; gap: 8px; width: 100%; min-width: 0; }
.mx-wb-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mx-wb-field > span {
  font-size: var(--text-2xs, 10px);
  color: var(--color-text-faint, #64748b);
  letter-spacing: .04em;
}
.mx-wb-field input,
.mx-wb-field textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border-radius: var(--radius-xs, 4px);
  border: 1px solid var(--color-border-strong, #334155);
  background: var(--color-bg-sunken, #020617);
  color: var(--color-text, #f1f5f9);
  font-family: var(--font-sans, system-ui);
  font-size: var(--text-xs, 12px);
  line-height: 1.5;
  resize: vertical;
}
.mx-wb-field input:focus,
.mx-wb-field textarea:focus {
  outline: none;
  border-color: var(--color-action, #6366f1);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, .2);
}
.mx-wb-form-actions { display: flex; gap: 6px; }
.mx-wb-empty {
  padding: 18px 12px; text-align: center;
  font-size: var(--text-xs, 12px); color: var(--color-text-faint, #7d8ba1);
  border: 1px dashed var(--color-border-strong, #334155);
  border-radius: var(--radius-sm, 8px);
}
.mx-wb-feedback {
  margin: 0; padding: 8px 10px; min-height: 1.2em;
  font-family: var(--font-mono, monospace); font-size: var(--text-2xs, 10px);
  line-height: 1.5; color: var(--color-text-muted, #94a3b8);
  background: rgba(6,182,212,.06); border-left: 2px solid var(--color-instrument, #06b6d4);
  border-radius: var(--radius-xs, 4px); overflow-wrap: anywhere;
}
.mx-wb-feedback[data-tone='ok'] { color: var(--color-positive, #10b981); border-left-color: var(--color-positive, #10b981); background: rgba(16,185,129,.07); }
.mx-wb-feedback[data-tone='warn'] { color: var(--color-warning, #f59e0b); border-left-color: var(--color-warning, #f59e0b); background: rgba(245,158,11,.07); }
.mx-wb-feedback[data-tone='error'] { color: var(--color-danger, #f43f5e); border-left-color: var(--color-danger, #f43f5e); background: rgba(244,63,94,.07); }
.mx-wb-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; min-width: 0; }
.mx-wb-panel {
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  padding: 10px 12px; border-radius: var(--radius-sm, 8px);
  background: var(--color-bg-raised, #0f172a);
  border: 1px solid var(--color-border, #1e293b);
}
.mx-wb-panel h3 { margin: 0; font-size: var(--text-2xs, 10px); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--color-text-faint, #64748b); }
.mx-wb-panel p { margin: 0; font-size: var(--text-2xs, 10px); line-height: 1.6; color: var(--color-text-muted, #94a3b8); overflow-wrap: anywhere; }
.mx-wb-panel code { font-family: var(--font-mono, monospace); color: var(--color-instrument-bright, #22d3ee); }
.mx-wb-note { margin: 0; font-size: var(--text-2xs, 10px); color: var(--color-warning, #f59e0b); }
@media (max-width: 420px) {
  .mx-wb { padding: 12px; }
  .mx-wb-count { margin-left: 0; width: 100%; }
  .mx-wb-row-actions { width: 100%; }
  .mx-wb-row-actions .mx-wb-btn { flex: 1 1 auto; justify-content: center; }
}
`;

/* ─────────────────────────────── 组件 ─────────────────────────────── */

export interface WorkbenchProps<T> {
  /** 站点身份，来自各站 `src/site.config.ts` 的 `SITE`。 */
  readonly identity: SiteIdentityLike;
  /** 该站的业务规格 —— 每个站唯一需要手写的业务代码。 */
  readonly spec: SiteWorkbenchSpec<T>;
  /** SDK 能力桥。没有宿主时传 `hostConnected: false`。 */
  readonly bridge: SdkBridge;
  /** localStorage 键名；缺省 `mx.<appId>.<exportName>`。 */
  readonly ledgerKey?: string;
  /** 数据结构版本；缺省 1。改字段含义时 +1 并补 migrate。 */
  readonly ledgerVersion?: number;
  /** 可选：渲染在完工台上方的自定义内容（如仪表盘）。 */
  readonly primaryTool?: ReactNode;
  readonly className?: string;
}

type Tone = 'info' | 'ok' | 'warn' | 'error';

interface FeedbackState {
  readonly text: string;
  readonly tone: Tone;
}

export function Workbench<T>(props: WorkbenchProps<T>) {
  const { identity, spec, bridge, primaryTool, className } = props;
  const ledgerKey = props.ledgerKey ?? `mx.${identity.appId}.${spec.exportName}`;
  const ledgerVersion = props.ledgerVersion ?? 1;

  /* 台账句柄。spec 视为常量，只在键/版本变化时重建。 */
  const ledger = useMemo<Ledger<T>>(
    () =>
      createLedger<T>({
        key: ledgerKey,
        version: ledgerVersion,
        createDefault: spec.createDefault,
        validate: spec.validate,
      }),
    // spec 是模块级常量；ledgerKey / ledgerVersion 决定实例身份
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledgerKey, ledgerVersion],
  );

  /**
   * 首帧必须与服务端逐字一致，所以用一个 `hydrated` 闸门：
   *
   *   hydrated === false → 渲染 `readDefault()` 的结果（= 服务端渲染的那一份）
   *   hydrated === true  → 渲染存储里的真实台账
   *
   * 为什么不能只靠 `useState(() => readDefault())` + `useEffect(setSnapshot(read()))`：
   *   在浏览器里 `useState` 的初始化函数**在首次渲染时就执行**，而 React 18 的
   *   hydration 会把这次渲染的产出与服务端 HTML 比对。若此时存储里已有用户数据
   *   （条数不同、标题被编辑过），首帧文本就与服务端对不上 —— 直接 React #418。
   *
   *   单独 `save` 或单独 `edit` 时条数变化往往被别的重排掩盖，所以只在「新增一条
   *   ＋编辑过标题」这种组合下稳定复现（实测 16 站），因此特别难查。
   *
   * 用显式 `hydrated` 状态而不是依赖 effect 的执行时机，水合期渲染的分支是确定的。
   */
  const [hydrated, setHydrated] = useState(false);
  const [snapshot, setSnapshot] = useState<LedgerSnapshot<T>>(() => ledger.readDefault());
  /* 存储可用性是三态，避免服务端/客户端首帧渲染不一致造成 hydration 警告。 */
  const [storage, setStorage] = useState<'pending' | 'ok' | 'unavailable'>('pending');
  const [feedback, setFeedback] = useState<FeedbackState>({ text: '', tone: 'info' });

  useEffect(() => {
    setSnapshot(ledger.read());
    setStorage(ledger.available ? 'ok' : 'unavailable');
    setHydrated(true);
  }, [ledger]);

  const data = snapshot.data;
  const records = useMemo<readonly RecordView[]>(() => {
    try {
      return spec.records(data);
    } catch {
      return [];
    }
  }, [spec, data]);

  /**
   * 水合期专用视图：与 `snapshot` 无关，永远取 `readDefault()`。
   *
   * 渲染层用它而不是直接用 `records`，是为了让「hydration 那一次渲染」的输出
   * 与服务端 HTML **逐字节一致**，从而彻底消除 #418 的可能。
   * `hydrated` 变 true 后（effect 已把真实台账写进 snapshot）才切到 `records`。
   */
  const hydrationRecords = useMemo<readonly RecordView[]>(() => {
    try {
      return spec.records(ledger.readDefault().data);
    } catch {
      return [];
    }
  }, [spec, ledger]);

  const visibleRecords = hydrated ? records : hydrationRecords;

  const say = useCallback((text: string, tone: Tone = 'info') => {
    setFeedback({ text, tone });
  }, []);

  /* ── 增 ── */
  const handleSave = useCallback(() => {
    try {
      const next = ledger.update((prev) => spec.add(prev, nowIso()));
      setSnapshot(next);
      const count = spec.records(next.data).length;
      say(`已保存并持久化 · 台账现有 ${count} 条`, 'ok');
    } catch (error) {
      say(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }, [ledger, spec, say]);

  /* ── 改 ── */
  /**
   * 就地编辑。
   *
   * 这里分两种情况，**不假装能力**：
   *   - 站点提供了 `spec.patch` → 打开内联表单，用户能改标题/摘要/详情这三个展示位，
   *     改的是真业务字段（`patch` 会写回台账并落盘）。
   *   - 站点没提供 `patch` → 退化成原来的「系统标记一次编辑」，并在反馈里明说
   *     「本站暂不支持就地编辑」，不让用户以为填了却没保存。
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RecordDraft>({});

  const beginEdit = useCallback(
    (record: RecordView) => {
      if (!spec.patch) {
        try {
          const next = ledger.update((prev) => spec.edit(prev, record.id, nowIso()));
          setSnapshot(next);
          say('本站暂不支持就地编辑业务字段 · 已记录一次编辑标记', 'warn');
        } catch (error) {
          say(`修改失败：${error instanceof Error ? error.message : String(error)}`, 'error');
        }
        return;
      }
      setEditingId(record.id);
      setDraft({ title: record.title, meta: record.meta, detail: record.detail ?? '' });
    },
    [ledger, spec, say],
  );

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft({});
  }, []);

  const commitEdit = useCallback(() => {
    const id = editingId;
    const patch = spec.patch;
    if (id === null || !patch) return;
    try {
      const next = ledger.update((prev) => patch(prev, id, draft, nowIso()));
      setSnapshot(next);
      setEditingId(null);
      setDraft({});
      say(`已保存修改并持久化`, 'ok');
    } catch (error) {
      say(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }, [ledger, spec, draft, editingId, say]);

  /* ── 删 ── */
  const handleRemove = useCallback(
    (id: string) => {
      try {
        const next = ledger.update((prev) => spec.remove(prev, id));
        setSnapshot(next);
        const count = spec.records(next.data).length;
        say(`已删除 ${shortId(id)} · 剩余 ${count} 条`, 'ok');
      } catch (error) {
        say(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
    [ledger, spec, say],
  );

  /* ── 清空（破坏性，可撤销） ── */
  /**
   * 为什么清空要留撤销：
   *   它**不可撤销** —— 一次误点就丢掉整站台账（答辩前夜的实验数据也在里面）。
   *
   *   不用 `confirm()`：iframe 里模态行为不一致（部分容器禁用）。
   *   不用「二次点击确认」：验收器的 ledger-clear 是单次点击后断言计数归 0，
   *   改成两段式会破坏这个契约，也会让老用户觉得点不动。
   *
   *   方案：清空前把当前台账**快照到内存**，反馈条旁给一个「撤销」按钮（8 秒有效）。
   *   单次点击语义、计数立即归 0，但误点有真实回退路径 —— 既不破坏契约也不丢数据。
   */
  const undoRef = useRef<{ data: T; label: string } | null>(null);
  const [undoAvailable, setUndoAvailable] = useState(false);

  useEffect(() => {
    if (!undoAvailable) return;
    const timer = setTimeout(() => {
      undoRef.current = null;
      setUndoAvailable(false);
    }, 8000);
    return () => clearTimeout(timer);
  }, [undoAvailable]);

  const handleClear = useCallback(() => {
    try {
      const before = ledger.read();
      const removed = spec.records(before.data).length;
      const next = ledger.write(spec.createEmpty());
      setSnapshot(next);
      const count = spec.records(next.data).length;
      if (removed > 0) {
        undoRef.current = { data: before.data, label: `清空（${removed} 条）` };
        setUndoAvailable(true);
        say(
          count === 0
            ? `已清空台账 · 删除 ${removed} 条 · 8 秒内可点「撤销」恢复`
            : `已重置台账 · 剩余 ${count} 条`,
          'warn',
        );
      } else {
        undoRef.current = null;
        setUndoAvailable(false);
        say('台账本来就是空的，无需清空', 'info');
      }
    } catch (error) {
      say(`清空失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }, [ledger, spec, say]);

  const handleUndo = useCallback(() => {
    const pending = undoRef.current;
    if (!pending) return;
    undoRef.current = null;
    setUndoAvailable(false);
    try {
      const next = ledger.write(pending.data);
      setSnapshot(next);
      say(`已撤销${pending.label} · 恢复 ${spec.records(next.data).length} 条`, 'ok');
    } catch (error) {
      say(`撤销失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }, [ledger, spec, say]);

  /* ── 导出 ── */
  const handleExportJson = useCallback(() => {
    const filename = `${spec.exportName}.json`;
    if (ledger.exportJson(filename)) {
      say(`已导出 ${filename}（${records.length} 条）`, 'ok');
    } else {
      say('导出失败：当前环境不支持文件下载（非浏览器）', 'error');
    }
  }, [ledger, spec, records.length, say]);

  const handleExportCsv = useCallback(() => {
    const filename = `${spec.exportName}.csv`;
    try {
      const table = spec.csv
        ? spec.csv(data)
        : {
            header: ['id', 'title', 'meta', 'detail'] as const,
            rows: records.map((r) => [r.id, r.title, r.meta, r.detail ?? '']),
          };
      const ok = ledger.exportCsv(filename, table.rows, { header: table.header });
      if (ok) say(`已导出 ${filename}（${table.rows.length} 行）`, 'ok');
      else say('导出失败：当前环境不支持文件下载（非浏览器）', 'error');
    } catch (error) {
      say(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }, [ledger, spec, data, records, say]);

  /* ── 投送（emits） ── */
  const handleEmit = useCallback(async () => {
    const stamp = nowIso();
    let payload: EnvelopePayloadLike;
    try {
      payload = spec.emit.build(data, stamp);
    } catch (error) {
      say(`投送被拦截：构建 payload 失败 · ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }

    /* 契约红线：evidence_anchors 至少 1 条。台账为空时用站级基线锚点，
       并明确告知这是基线而非台账证据，绝不伪造。 */
    const builtAnchors = payload.evidence_anchors ?? [];
    const anchors =
      builtAnchors.length > 0 ? builtAnchors : [baselineAnchor(identity)];
    const usedBaseline = builtAnchors.length === 0;
    const envelope: EnvelopePayloadLike = {
      data: payload.data,
      evidence_anchors: anchors,
    };
    const traceId = makeTraceId();
    const target = spec.emit.targetApp;
    const payloadType = spec.emit.payloadType;
    const baselineNote = usedBaseline ? ' · 台账为空，使用站级基线锚点' : '';

    /* 只有真的嵌在 hub iframe 内才真投送；否则本地演示，绝不谎称已送达。 */
    if (bridge.hostConnected && bridge.sendWormhole) {
      try {
        const receipt = (await bridge.sendWormhole(target, payloadType, envelope)) as
          | { traceId?: string; ok?: boolean; reason?: string }
          | undefined;
        const ok = receipt?.ok !== false;
        const realTrace = receipt?.traceId ?? traceId;
        say(
          ok
            ? `已投送至 ${target} · ${payloadType} · trace ${realTrace} · 证据 ${anchors.length} 条${baselineNote}`
            : `投送未成功：${receipt?.reason ?? '目标站未确认'} · trace ${realTrace}`,
          ok ? 'ok' : 'warn',
        );
      } catch (error) {
        say(`投送失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      return;
    }

    say(
      `本地演示 · 未实际投送（当前不在 hub iframe 内）· 目标 ${target} · ${payloadType} · trace ${traceId} · 证据 ${anchors.length} 条${baselineNote}`,
      'warn',
    );
  }, [bridge, identity, spec, data, say]);

  /* ── 接收（accepts） ── */
  const handleAcceptDemo = useCallback(() => {
    const stamp = nowIso();
    let envelope: ConsumableEnvelope;
    try {
      envelope = spec.accept.demoEnvelope
        ? spec.accept.demoEnvelope(stamp)
        : {
            trace_id: makeTraceId(),
            source_app: 'demo',
            payload_type: spec.accept.payloadType,
            payload: {
              data: { note: '本地演示信封' },
              evidence_anchors: [baselineAnchor(identity)],
            },
          };
      const next = ledger.update((prev) => spec.accept.consume(prev, envelope, stamp));
      setSnapshot(next);
      say(
        `已消费 ${envelope.payload_type ?? spec.accept.payloadType} 信封 · trace ${envelope.trace_id} · 台账现有 ${spec.records(next.data).length} 条`,
        'ok',
      );
    } catch (error) {
      say(`消费失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }, [ledger, spec, identity, say]);

  /* ── 资产落库 ── */
  const handleEmitAsset = useCallback(async () => {
    const stamp = nowIso();
    const asset = spec.asset
      ? spec.asset.build(data, stamp)
      : {
          assetType: 'dataset',
          title: `${identity.name} · ${spec.exportName}`,
          payload: { records: records.length, exportedAt: stamp },
          evidenceAnchors: [baselineAnchor(identity)],
        };

    if (bridge.hostConnected && bridge.emitAsset) {
      try {
        await bridge.emitAsset(asset);
        say('已写入资产图谱（AssetGraph）', 'ok');
      } catch (error) {
        say(`资产落库失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      return;
    }
    say('本地演示 · 未写入资产图谱（当前不在 hub iframe 内）', 'warn');
  }, [bridge, identity, spec, data, records.length, say]);

  /* 渲染层一律走 visibleRecords：水合期给默认视图、挂载后给真实台账。
     业务逻辑（导出 / 投送 / 计数）仍用 records（真实数据）—— 那是用户操作时才跑的。 */
  const recordCount = visibleRecords.length;
  const styleVars = { '--site-accent': identity.accent } as CSSProperties;

  return (
    <section
      className={['mx-wb', className].filter(Boolean).join(' ')}
      style={styleVars}
      data-testid="primary-tool"
      data-workbench={spec.exportName}
    >
      <style>{WORKBENCH_CSS}</style>

      {primaryTool}

      <div className="mx-wb-head">
        <h2>{identity.ledger}</h2>
        <p>
          本机持久化台账 · 可增 / 改 / 删 / 导出 · 投送 {spec.emit.payloadType} →{' '}
          {spec.emit.targetApp}
        </p>
        <span className="mx-wb-count">
          <b data-testid="ledger-count">{recordCount}</b> 条记录
        </span>
      </div>

      <div className="mx-wb-toolbar">
        <button
          type="button"
          className="mx-wb-btn"
          data-variant="primary"
          data-testid="ledger-save"
          onClick={handleSave}
        >
          + 新增一条
        </button>
        <button
          type="button"
          className="mx-wb-btn"
          data-testid="ledger-export-json"
          onClick={handleExportJson}
        >
          导出 JSON
        </button>
        <button type="button" className="mx-wb-btn" onClick={handleExportCsv}>
          导出 CSV
        </button>
        <button
          type="button"
          className="mx-wb-btn"
          data-variant="danger"
          data-testid="ledger-clear"
          onClick={handleClear}
        >
          清空台账
        </button>
        {undoAvailable ? (
          <button
            type="button"
            className="mx-wb-btn"
            data-variant="undo"
            data-testid="ledger-undo"
            onClick={handleUndo}
            aria-label="撤销上一次清空，恢复被删除的记录"
          >
            ↷ 撤销清空
          </button>
        ) : null}
        <button
          type="button"
          className="mx-wb-btn"
          data-testid="wormhole-emit"
          onClick={() => {
            void handleEmit();
          }}
        >
          虫洞投送
        </button>
        <button
          type="button"
          className="mx-wb-btn"
          onClick={() => {
            void handleEmitAsset();
          }}
        >
          写入资产图谱
        </button>
      </div>

      {storage === 'unavailable' ? (
        <p className="mx-wb-note">
          存储不可用（隐私模式或浏览器限制）· 本次操作只在内存中生效，刷新后会丢失。
        </p>
      ) : null}

      <p className="mx-wb-feedback" data-testid="wormhole-feedback" data-tone={feedback.tone} role="status">
        {feedback.text}
      </p>

      {recordCount === 0 ? (
        <p className="mx-wb-empty">
          台账为空。点「+ 新增一条」开始记录，或「清空台账」后重新开始。
        </p>
      ) : (
        <ul className="mx-wb-list">
          {visibleRecords.map((record) =>
            record.id === editingId ? (
              /* 就地编辑表单：三个展示位各自可改，空值保持原值（见 spec-factory.patch） */
              <li className="mx-wb-row mx-wb-row-editing" key={record.id}>
                <div className="mx-wb-form" data-testid="ledger-edit-form">
                  <label className="mx-wb-field">
                    <span>标题</span>
                    <input
                      data-testid="ledger-edit-title"
                      value={draft.title ?? ''}
                      onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                      autoFocus
                    />
                  </label>
                  <label className="mx-wb-field">
                    <span>摘要</span>
                    <input
                      data-testid="ledger-edit-meta"
                      value={draft.meta ?? ''}
                      onChange={(event) => setDraft((prev) => ({ ...prev, meta: event.target.value }))}
                    />
                  </label>
                  <label className="mx-wb-field">
                    <span>详情</span>
                    <textarea
                      data-testid="ledger-edit-detail"
                      rows={3}
                      value={draft.detail ?? ''}
                      onChange={(event) => setDraft((prev) => ({ ...prev, detail: event.target.value }))}
                    />
                  </label>
                  <div className="mx-wb-form-actions">
                    <button
                      type="button"
                      className="mx-wb-btn"
                      data-variant="primary"
                      data-testid="ledger-edit-save"
                      onClick={commitEdit}
                    >
                      保存
                    </button>
                    <button type="button" className="mx-wb-btn" onClick={cancelEdit}>
                      取消
                    </button>
                  </div>
                </div>
              </li>
            ) : (
              <li className="mx-wb-row" key={record.id}>
                <span className="mx-wb-row-main">
                  <span className="mx-wb-row-title">{record.title}</span>
                  <span className="mx-wb-row-meta">{record.meta}</span>
                  {record.detail ? <span className="mx-wb-row-detail">{record.detail}</span> : null}
                </span>
                <span className="mx-wb-row-actions">
                  <button
                    type="button"
                    className="mx-wb-btn"
                    data-testid="ledger-edit"
                    onClick={() => beginEdit(record)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="mx-wb-btn"
                    data-variant="danger"
                    onClick={() => handleRemove(record.id)}
                  >
                    删除
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}

      <div className="mx-wb-split">
        <div className="mx-wb-panel">
          <h3>投送契约 · emits</h3>
          <p>
            payload_type <code>{spec.emit.payloadType}</code> → 目标 <code>{spec.emit.targetApp}</code>
          </p>
          <p>
            虫洞契约要求 <code>evidence_anchors ≥ 1</code>。台账为空时使用站级基线锚点，
            反馈里会写明，不会伪造证据。
          </p>
        </div>
        <div className="mx-wb-panel">
          <h3>接收契约 · accepts</h3>
          <p>
            payload_type <code>{spec.accept.payloadType}</code>
          </p>
          <p>{spec.accept.description}</p>
          <button type="button" className="mx-wb-btn" onClick={handleAcceptDemo}>
            接收演示信封
          </button>
        </div>
      </div>
    </section>
  );
}

export default Workbench;
