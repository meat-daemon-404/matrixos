/**
 * 微站仪器类名基础样式 —— 单一事实源
 * ============================================================================
 * 为什么单独一个文件：
 *   `src/components/site-instrument.tsx` 里 18 个仪器用了 139 个 class，
 *   但 18 站的 `globals.css` 历史上一行都没写过它们（只写外壳）。
 *   结果是仪器一直是「无样式纯文本」：<pre> 不换行把移动端顶到 530px 宽、
 *   条形图没有轨道、卡片没有边界。这份样式由 scripts/gen-site.mjs 的
 *   renderGlobalsCss 注入，18 站共用，站点之间只有 --site-accent 不同。
 *
 * 硬约束（改之前先读）：
 *   1. 只能用 `:root` 里已有的 token，不许写死颜色（唯一例外：透明度修饰的 rgba，
 *      因为要叠在 --site-accent 上做高光/底纹）。
 *   2. 任何可能变长的文本容器都要能断行（overflow-wrap: anywhere），
 *      否则 390px 视口会横向溢出 —— 这是验收器的硬断言。
 *   3. 不许出现固定像素宽度（min-width 只在 flex 子项上用 0）。
 *   4. 动态类名只有这几个：`.active`、`.accent`、`.theirs`、`.seminal`、
 *      `.outline-l1`/`.outline-l2`、`.cite-edge.extends|cites|refutes`、
 *      `.sniper-pane.pdf|scope`、`.email-pane.blue|red`、
 *      `.check-item[data-tone=ok|warn|bad]`、`.outline-l*[data-cluster=c1|c2|c3]`。
 *      新增动态类名必须同步改这里，否则那个状态永远不生效。
 * ============================================================================
 */

export const INSTRUMENT_CSS = String.raw`
/* ══════════════════════════════════════════════════════════════════════════
 * 仪器类名基础样式（site-instrument.tsx 的 18 个仪器共用）
 * 这一段由 scripts/lib/microsite-instrument-css.mjs 提供，18 站完全一致。
 * ══════════════════════════════════════════════════════════════════════════ */

.instrument {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.instrument-head { display: flex; flex-direction: column; gap: 4px; }
.instrument-head h2 {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-instrument-bright);
  letter-spacing: 0.01em;
}
.instrument-head p {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

.instrument-hint {
  margin: 0;
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}

.instrument-placeholder {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  justify-content: center;
  padding: 28px 16px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  text-align: center;
}

/* ── 01 · GPA 配重台 ─────────────────────────────────────────────────────── */
.gpa-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.gpa-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  min-width: 0;
}
.gpa-label {
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
  letter-spacing: 0.04em;
}
.gpa-value {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--color-text-strong);
  line-height: 1.2;
}
.gpa-value.accent { color: var(--site-accent-text); }

.gpa-course-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gpa-course {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: rgba(15, 23, 42, 0.5);
  border: 1px solid var(--color-border);
  min-width: 0;
}
.gpa-course-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 160px;
  min-width: 0;
  flex-wrap: wrap;
}
.gpa-course-name {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}
.gpa-course-credits {
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
}
.gpa-knobs,
.curvelab-knobs {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: flex-end;
}

.badge-core {
  font-size: var(--text-2xs);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  color: var(--color-instrument-bright);
  background: rgba(6, 182, 212, 0.12);
  border: 1px solid rgba(6, 182, 212, 0.32);
  white-space: nowrap;
}

/* ── 04 · PAT-HOT 脉冲雷达 ───────────────────────────────────────────────── */
.pat-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pat-item {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  cursor: pointer;
  transition: border-color var(--dur-fast) ease, background var(--dur-fast) ease;
  min-width: 0;
}
.pat-item:hover { border-color: var(--color-border-strong); }
.pat-item.active {
  border-color: var(--site-accent);
  background: color-mix(in srgb, var(--site-accent) 10%, var(--color-bg-raised));
}
.pat-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.pat-heat { font-size: var(--text-2xs); color: var(--color-warning); }
.pat-source { font-size: var(--text-2xs); color: var(--color-text-faint); }
.pat-title {
  margin: 4px 0 6px;
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.pat-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  font-size: var(--text-2xs);
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: rgba(148, 163, 184, 0.1);
  border: 1px solid var(--color-border);
}
.pat-detail {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--color-instrument);
  background: rgba(6, 182, 212, 0.06);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pat-detail p {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

/* ── 06 / 07 / 13 · 标签页 ───────────────────────────────────────────────── */
.mentor-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mentor-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border-strong);
  background: rgba(15, 23, 42, 0.6);
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: var(--text-2xs);
  cursor: pointer;
  transition: color var(--dur-fast) ease, border-color var(--dur-fast) ease;
  min-width: 0;
}
.mentor-tab:hover { color: var(--color-text-secondary); }
.mentor-tab.active {
  color: var(--color-bg);
  background: var(--site-accent);
  border-color: var(--site-accent);
  font-weight: 600;
}
.mentor-name { overflow-wrap: anywhere; }
.mentor-score { font-size: var(--text-2xs); opacity: 0.85; }

.mentor-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mentor-affil {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
.mentor-dims {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mentor-dim {
  display: grid;
  grid-template-columns: minmax(64px, 5.5em) minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}
.mentor-dim-label {
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}
.mentor-dim-bar {
  position: relative;
  height: 6px;
  border-radius: var(--radius-pill);
  background: rgba(148, 163, 184, 0.16);
  overflow: hidden;
}
.mentor-dim-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--color-instrument), var(--color-instrument-bright));
}
.mentor-dim-val {
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
  text-align: right;
  white-space: nowrap;
}

/* ── 09 · 跨论文对比矩阵 ─────────────────────────────────────────────────── */
.cross-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-xs);
}
.cross-table th,
.cross-table td {
  padding: 7px 8px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--color-border);
  overflow-wrap: anywhere;
}
.cross-table th {
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-text-faint);
  text-transform: uppercase;
  border-bottom-color: var(--color-border-strong);
}
.cross-table tbody tr { cursor: pointer; }
.cross-table tbody tr:hover { background: rgba(148, 163, 184, 0.06); }
.cross-table tbody tr.active { background: rgba(6, 182, 212, 0.08); }
.cross-table td.accent {
  color: var(--site-accent-text);
  font-weight: 600;
}

/* ── 12 · 复现核验清单 ───────────────────────────────────────────────────── */
.checklist {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.check-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  border-left-width: 2px;
  min-width: 0;
}
.check-item[data-tone='ok'] { border-left-color: var(--color-positive); }
.check-item[data-tone='warn'] { border-left-color: var(--color-warning); }
.check-item[data-tone='bad'] { border-left-color: var(--color-danger); }
.check-icon {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-pill);
  font-size: var(--text-2xs);
  font-weight: 700;
}
.check-item[data-tone='ok'] .check-icon { color: var(--color-positive-bright); background: rgba(16, 185, 129, 0.14); }
.check-item[data-tone='warn'] .check-icon { color: var(--color-warning); background: rgba(245, 158, 11, 0.14); }
.check-item[data-tone='bad'] .check-icon { color: var(--color-danger); background: rgba(244, 63, 94, 0.14); }
.check-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.check-name {
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.check-detail {
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}
.check-status {
  flex: 0 0 auto;
  font-size: var(--text-2xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}

/* ── 17 · 证据简历 ───────────────────────────────────────────────────────── */
.cv-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cv-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  min-width: 0;
}
.cv-entry-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.cv-title {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.cv-role {
  font-size: var(--text-2xs);
  color: var(--color-instrument-bright);
}
.cv-period { font-size: var(--text-2xs); color: var(--color-text-faint); }
.cv-anchors { display: flex; flex-wrap: wrap; gap: 6px; }

/* ── 02 · 组队雷达 ───────────────────────────────────────────────────────── */
.spark-self {
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
}
.skill-bars {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.skill-row {
  display: grid;
  grid-template-columns: minmax(52px, 4.5em) minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.skill-label {
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}
.skill-track {
  position: relative;
  height: 6px;
  border-radius: var(--radius-pill);
  background: rgba(148, 163, 184, 0.16);
  overflow: hidden;
}
.skill-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--site-accent), var(--color-instrument-bright));
}
.skill-fill.theirs {
  background: linear-gradient(90deg, var(--color-ecosystem), var(--color-action));
}
.skill-val {
  font-size: var(--text-2xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.gain {
  font-style: normal;
  font-size: var(--text-2xs);
  color: var(--color-positive-bright);
  white-space: nowrap;
}
.spark-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--site-accent);
  background: rgba(139, 92, 246, 0.06);
  min-width: 0;
}

/* ── 05 · 引文声呐 ───────────────────────────────────────────────────────── */
.citation-sources { display: flex; flex-wrap: wrap; gap: 6px; }
.source-chip {
  font-size: var(--text-2xs);
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: rgba(148, 163, 184, 0.1);
  border: 1px solid var(--color-border);
  white-space: nowrap;
}
.citation-graph {
  display: block;
  width: 100%;
  max-width: 420px;
  height: auto;
  margin: 0 auto;
}
.cite-edge {
  stroke: var(--color-border-strong);
  stroke-width: 0.6;
}
.cite-edge.extends { stroke: var(--color-instrument); }
.cite-edge.cites { stroke: var(--color-text-faint); }
.cite-edge.refutes { stroke: var(--color-danger); stroke-dasharray: 2 1.4; }
.cite-node {
  fill: var(--color-bg-raised);
  stroke: var(--color-border-strong);
  stroke-width: 0.6;
  cursor: pointer;
}
.cite-node.seminal {
  stroke: var(--color-instrument-bright);
  stroke-width: 1;
}
.cite-node.active {
  fill: var(--site-accent);
  stroke: var(--color-text-strong);
}
.cite-label {
  fill: var(--color-text-muted);
  font-size: 3px;
  font-family: var(--font-mono);
  text-anchor: middle;
  pointer-events: none;
}

/* ── 07 · 套磁信红蓝对抗 ─────────────────────────────────────────────────── */
.email-dual {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 10px;
}
.email-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  min-width: 0;
}
.email-pane.blue { border-left: 2px solid var(--color-instrument); }
.email-pane.red { border-left: 2px solid var(--color-danger); }
.email-subject {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.email-body {
  margin: 0;
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  line-height: 1.7;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-width: 100%;
  max-height: 320px;
  overflow-y: auto;
}
.email-issues {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--color-warning);
}
.email-issues li { overflow-wrap: anywhere; }
.email-pass {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-positive-bright);
}
.email-tips {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
}
.email-tips li { overflow-wrap: anywhere; }

/* ── 10 · PDF 狙击镜 ─────────────────────────────────────────────────────── */
.sniper-dual {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 10px;
}
.sniper-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  min-width: 0;
}
.sniper-pane.pdf { border-left: 2px solid var(--color-instrument); }
.sniper-pane.scope { border-left: 2px solid var(--site-accent); }
.pdf-snippet {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  background: rgba(148, 163, 184, 0.06);
  border: 1px solid transparent;
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}
.pdf-snippet.active {
  border-color: var(--site-accent);
  background: color-mix(in srgb, var(--site-accent) 10%, transparent);
}
.pdf-page { font-size: var(--text-2xs); color: var(--color-text-faint); }
.formula-block {
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  font-size: var(--text-xs);
  color: var(--color-instrument-bright);
  overflow-wrap: anywhere;
}
.formula-meta {
  margin: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 10px;
  font-size: var(--text-2xs);
}
.formula-meta dt { color: var(--color-text-faint); }
.formula-meta dd { margin: 0; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.formula-code {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  line-height: 1.6;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-width: 100%;
  overflow-x: auto;
}

/* ── 13 · 出版图表熔炉 ───────────────────────────────────────────────────── */
.chart-spec { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.spec-grid {
  margin: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 10px;
  font-size: var(--text-2xs);
}
.spec-grid dt { color: var(--color-text-faint); }
.spec-grid dd { margin: 0; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.palette-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: var(--text-2xs);
  color: var(--color-text-faint);
}
.palette-swatches { display: flex; gap: 4px; }
.swatch {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--color-border-strong);
}
.chart-preview {
  display: block;
  width: 100%;
  max-width: 480px;
  height: auto;
  margin: 0 auto;
  background: var(--color-bg-sunken);
  border-radius: var(--radius-xs);
  border: 1px solid var(--color-border);
}

/* ── 14 · 综述推演 ───────────────────────────────────────────────────────── */
.cluster-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 8px;
}
.cluster-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  cursor: pointer;
  min-width: 0;
  transition: border-color var(--dur-fast) ease;
}
.cluster-card:hover { border-color: var(--color-border-strong); }
.cluster-card.active { border-color: var(--site-accent); }
.cluster-name {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.cluster-meta { font-size: var(--text-2xs); color: var(--color-text-faint); }
.cluster-detail { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.cluster-claim {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--color-instrument);
  background: rgba(6, 182, 212, 0.06);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}
.outline-tree {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.outline-l1,
.outline-l2 {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  padding: 3px 8px;
  border-radius: var(--radius-xs);
  overflow-wrap: anywhere;
}
.outline-l1 { font-weight: 600; color: var(--color-text); }
.outline-l2 { margin-left: 18px; font-size: var(--text-2xs); color: var(--color-text-muted); }
.outline-l2[data-cluster='c1'] { border-left: 2px solid var(--color-instrument); }
.outline-l2[data-cluster='c2'] { border-left: 2px solid var(--color-ecosystem); }
.outline-l2[data-cluster='c3'] { border-left: 2px solid var(--color-positive); }

/* ── 18 · 生涯决策树 ─────────────────────────────────────────────────────── */
.path-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr));
  gap: 8px;
}
.path-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  cursor: pointer;
  min-width: 0;
  transition: border-color var(--dur-fast) ease;
}
.path-card:hover { border-color: var(--color-border-strong); }
.path-card.active { border-color: var(--site-accent); }
.path-name {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.path-gain { font-size: var(--text-2xs); color: var(--color-positive-bright); }
.path-risk { font-size: var(--text-2xs); color: var(--color-text-faint); }
.path-bar {
  position: relative;
  height: 5px;
  border-radius: var(--radius-pill);
  background: rgba(148, 163, 184, 0.16);
  overflow: hidden;
}
.path-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--site-accent), var(--color-instrument-bright));
}
.path-detail { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.path-desc {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}
.prob-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.prob-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  min-width: 0;
}
.prob-label { font-size: var(--text-2xs); color: var(--color-text-faint); }
.prob-val {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-strong);
}
.trajectory {
  display: block;
  width: 100%;
  max-width: 420px;
  height: auto;
  margin: 0 auto;
  background: var(--color-bg-sunken);
  border-radius: var(--radius-xs);
  border: 1px solid var(--color-border);
}
.traj-line {
  fill: none;
  stroke: var(--site-accent);
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.traj-dot { fill: var(--color-instrument-bright); }

/* ── 窄屏：390px 视口不许横向溢出（验收器硬断言） ───────────────────────── */
@media (max-width: 480px) {
  .gpa-summary,
  .prob-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gpa-knobs,
  .curvelab-knobs { justify-content: flex-start; }
  .mentor-dim,
  .skill-row { grid-template-columns: minmax(48px, 4em) minmax(0, 1fr) auto; }
  .outline-l2 { margin-left: 10px; }

  /*
   * 对比矩阵的窄屏兜底。
   *
   * 为什么必须兜：MatrixCross 在 <td> 里放 EvidenceLink，而 instrument-ui 的
   * .iu-evidence__badge 带着 white-space: nowrap，让徽章 min-content 宽达 ~306px
   * （"Level B Preprint · p.3 · 10.1021/…"）。table 布局算法按 min-content 定列宽，
   * 于是整表 min-content 撑到 ~387px，390px 视口减去页面 padding 只剩 ~316px
   * → documentElement.scrollWidth 424，验收器的「移动端无横向溢出」直接红。
   * 光给 td 加 overflow-wrap 没用：nowrap 的子元素不吃这一套。
   *
   * 两件事一起做才既不溢出又不裁内容：
   *   ① 表格自己变成横向滚动容器（display:block + overflow-x:auto）→ 文档流不被撑宽；
   *   ② 把徽章从 nowrap 放开成可换行 → 表格内部的 min-content 降下来，
   *      滚动容器里不再有被裁掉的列（否则只是把溢出藏起来，内容看不全）。
   */
  .cross-table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .iu-evidence { flex-wrap: wrap; max-width: 100%; }
  .iu-evidence__badge { white-space: normal; max-width: 100%; }
  .iu-evidence__text { flex-wrap: wrap; }
  .iu-evidence__doi { max-width: 100%; }
}

/* ── 触屏按压反馈与命中区（V 系列收尾） ──────────────────────────────────
 * 盘点结论：全管线 :active 为 0 处——触屏点按无任何视觉响应，且 hover 态
 * 在 (hover: none) 设备上不可达。此处给六族可点元素补按压态（桌面鼠标
 * 按下同样受益）；按压态刻意用中性色（border-strong + 微亮底），与选中态
 * （--site-accent）严格区分，避免「按了一下=被选中」的误读。 */
.pat-item:active,
.cluster-card:active,
.path-card:active {
  border-color: var(--color-border-strong);
  background: rgba(148, 163, 184, 0.08);
}
.mentor-tab:active {
  color: var(--color-text-secondary);
  border-color: var(--color-text-faint);
}
.cross-table tbody tr:active { background: rgba(148, 163, 184, 0.12); }

/* ≤480px：mentor-tab 原 padding 5px 10px + 10px 字号 ≈ 24px 高，低于
 * WCAG 2.5.8 (AA) 24×24 的舒适线、远低于 44px 推荐命中区——放大到 ≈ 36px。
 * 桌面尺寸不变（media 块限定）。 */
@media (max-width: 480px) {
  .mentor-tab { padding: 9px 14px; }
}
`;
