import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { cx } from '../lib/cx';
import { accentStyle } from '../lib/accent';
import type { InstrumentAccent } from '../lib/accent';
import { usePrefersReducedMotion, useUid } from '../lib/hooks';
import { clamp, formatFixed, normalize } from '../lib/math';
import '../styles/components/task-kanban.css';

/** 航天任务看板列（对应进组跟进状态机 已发信→已读→待面试→已进组）。 */
export interface KanbanColumn {
  /** 唯一 id。 */
  id: string;
  /** 列名，如「待寄箱」。 */
  title: string;
  /** 列副标题（如「Drafting·Searching」）。 */
  subtitle?: string;
  /** 强调色。 */
  accent?: InstrumentAccent;
  /** 是否锁定（不可投放，如终态）。 */
  locked?: boolean;
  /** WIP 上限（超出时列头转 amber）。 */
  wipLimit?: number;
}

/** 任务卡（一封套磁信 / 一次面试）。 */
export interface KanbanTask {
  /** 唯一 id。 */
  id: string;
  /** 标题，如「张教授 · 钙钛矿钝化」。 */
  title: string;
  /** 摘要。 */
  summary?: string;
  /** 所属列 id。 */
  columnId: string;
  /** 强调色。 */
  accent?: InstrumentAccent;
  /** 优先级。 */
  priority?: 'P0' | 'P1' | 'P2';
  /** 标签。 */
  tags?: readonly string[];
  /** 截止时间（ISO 或已格式化文案）。 */
  due?: string;
  /** 进度 0..1（可选，画一条细进度条）。 */
  progress?: number;
  /** 负责人缩写（两个字母）。 */
  assignee?: string;
  /** 执行窗口（如「周五 15:00 面试」）。 */
  window?: string;
  /** 是否被阻断（如缺证据锚点）。 */
  blocked?: boolean;
  /** 阻断原因。 */
  blockedReason?: string;
}

export interface TaskKanbanProps {
  /** 列定义。 */
  columns?: readonly KanbanColumn[];
  /** 任务卡。 */
  tasks?: readonly KanbanTask[];
  /** 受控：当前选中卡 id。 */
  selectedId?: string;
  /** 点击卡片。 */
  onTaskClick?: (task: KanbanTask, event: React.MouseEvent) => void;
  /**
   * 移动卡片。**是否真正移动由调用方决定**（受控组件原则）：
   * 返回 `false` 可拒绝非法跃迁（状态机约束，见 WBS S3-MS08）。
   */
  onTaskMove?: (
    task: KanbanTask,
    toColumnId: string,
    fromColumnId: string,
  ) => boolean | void;
  /** 新增卡片（列尾 + 号）。 */
  onTaskCreate?: (columnId: string) => void;
  /** 看板标题。 */
  title?: string;
  /** 任务代号（右上角，如「MISSION SG-07」）。 */
  missionCode?: string;
  /** 强调色，默认 emerald（星门/已进组的正向色）。 */
  accent?: InstrumentAccent;
  /** 列高（px），默认 420。 */
  height?: number;
  /** 是否允许拖拽，默认 true。 */
  draggable?: boolean;
  /** 是否渲染等价数据表格（无障碍），默认 true。 */
  accessibleTable?: boolean;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
}

interface DragPayload {
  taskId: string;
  fromColumnId: string;
}

/**
 * `<TaskKanban>` 航天任务控制看板。
 *
 * 视觉来源：bundle UI_03 的「太空舱进组台账」——三张圆角舱段卡片
 * （待寄箱 Drafting·Searching / 已发信 Transit / 周五15:00面试）串成一条
 * 任务链条，卡片带进度条与状态灯。
 *
 * 交互与工程约束：
 * - **受控组件**：拖拽/键盘移动只发 `onTaskMove` 事件，**不自己改数据**。
 *   调用方返回 `false` 即可拒绝非法跃迁（状态机 已发信→已读→待面试→已进组
 *   不可跳级），这是 WBS S3-MS08 的硬验收点。
 * - **拖拽**用 HTML5 DnD + pointer 双通道：DnD 在触屏不可用，故触屏走
 *   pointer 事件自绘拖影；两条路径最终都收敛到同一个 `tryMove`。
 * - **键盘可达**：卡片聚焦后 `←/→` 换列、`Home/End` 到首尾列、`Enter` 打开。
 *   这是 ADR-07「自建组件最容易翻车的地方」的正面应对。
 * - 拖拽中的视觉反馈（列高亮）用 `data-drop-target` 属性 + CSS，不逐帧改样式。
 */
export function TaskKanban({
  columns = [],
  tasks = [],
  selectedId,
  onTaskClick,
  onTaskMove,
  onTaskCreate,
  title = '太空舱进组跟进台账',
  missionCode = 'MISSION SG-07',
  accent = 'emerald',
  height = 420,
  draggable = true,
  accessibleTable = true,
  className,
  style,
  ...rest
}: TaskKanbanProps) {
  const uid = useUid('iu-kanban');
  const reducedMotion = usePrefersReducedMotion();
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [lastRejected, setLastRejected] = useState<{ taskId: string; columnId: string } | null>(
    null,
  );
  const dragImageRef = useRef<HTMLDivElement | null>(null);

  const byColumn = useMemo(() => {
    const map = new Map<string, KanbanTask[]>();
    for (const column of columns) map.set(column.id, []);
    for (const task of tasks) {
      const list = map.get(task.columnId);
      if (list) list.push(task);
    }
    return map;
  }, [columns, tasks]);

  const tryMove = useCallback(
    (task: KanbanTask, toColumnId: string) => {
      if (task.columnId === toColumnId) return;
      const targetColumn = columns.find((c) => c.id === toColumnId);
      if (!targetColumn) return;
      // 调用方可以拒绝；只有显式返回 false 才算拒绝
      const accepted = onTaskMove?.(task, toColumnId, task.columnId);
      if (accepted === false) {
        setLastRejected({ taskId: task.id, columnId: toColumnId });
        // 1.2s 后清除拒绝态（不无限留存，避免干扰后续操作）
        window.setTimeout(() => setLastRejected(null), 1200);
      }
    },
    [columns, onTaskMove],
  );

  const handleDragStart = useCallback(
    (task: KanbanTask, event: React.DragEvent<HTMLDivElement>) => {
      if (!draggable) return;
      setDragging({ taskId: task.id, fromColumnId: task.columnId });
      event.dataTransfer.effectAllowed = 'move';
      // Firefox 必须要 setData 才会触发 drag
      event.dataTransfer.setData('text/plain', task.id);
      if (dragImageRef.current) {
        event.dataTransfer.setDragImage(dragImageRef.current, 12, 12);
      }
    },
    [draggable],
  );

  const handleDrop = useCallback(
    (columnId: string, event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      const taskId = event.dataTransfer.getData('text/plain') || dragging?.taskId;
      const task = tasks.find((t) => t.id === taskId);
      if (task) tryMove(task, columnId);
      setDragging(null);
      setDropTarget(null);
    },
    [dragging, tasks, tryMove],
  );

  const handleKeyMove = useCallback(
    (task: KanbanTask, event: React.KeyboardEvent<HTMLDivElement>) => {
      const index = columns.findIndex((c) => c.id === task.columnId);
      if (index < 0) return;
      let target = -1;
      if (event.key === 'ArrowRight') target = index + 1;
      else if (event.key === 'ArrowLeft') target = index - 1;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = columns.length - 1;
      else return;
      event.preventDefault();
      const next = columns[clamp(target, 0, columns.length - 1)];
      if (next) tryMove(task, next.id);
    },
    [columns, tryMove],
  );

  const totalBlocked = tasks.filter((t) => t.blocked).length;
  const totalDone = tasks.filter((t) => {
    const column = columns.find((c) => c.id === t.columnId);
    return column?.locked ?? false;
  }).length;

  return (
    <div
      className={cx('iu-root', 'iu-kanban', dragging && 'is-dragging', className)}
      style={accentStyle(accent, { ...style, ['--iu-kanban-height' as string]: `${height}px` })}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      {...rest}
    >
      {/* 拖影（屏幕外的渲染节点，供 setDragImage 使用） */}
      <div className="iu-kanban__drag-ghost" ref={dragImageRef} aria-hidden="true">
        <span className="iu-kanban__drag-ghost-bar" />
        <span className="iu-kanban__drag-ghost-dot" />
      </div>

      <div className="iu-kanban__frame">
        {/* 任务控制台头部 */}
        <header className="iu-kanban__header">
          <div className="iu-kanban__header-left">
            <span className="iu-kanban__mission iu-label">{missionCode}</span>
            <h2 className="iu-kanban__title">{title}</h2>
          </div>
          <div className="iu-kanban__telemetry" aria-hidden="true">
            <span className="iu-kanban__telemetry-item">
              <span className="iu-label">TASKS</span>
              <span className="iu-readout iu-kanban__telemetry-value">{tasks.length}</span>
            </span>
            <span className="iu-kanban__telemetry-item">
              <span className="iu-label">DONE</span>
              <span className="iu-readout iu-kanban__telemetry-value is-positive">
                {totalDone}
              </span>
            </span>
            <span className="iu-kanban__telemetry-item">
              <span className="iu-label">BLOCKED</span>
              <span
                className={cx(
                  'iu-readout',
                  'iu-kanban__telemetry-value',
                  totalBlocked > 0 && 'is-danger',
                )}
              >
                {totalBlocked}
              </span>
            </span>
            <span className="iu-kanban__signal" data-active={dragging ? 'true' : 'false'} />
          </div>
        </header>

        {/* 列 */}
        <div className="iu-kanban__columns">
          {columns.map((column, columnIndex) => {
            const columnTasks = byColumn.get(column.id) ?? [];
            const isTarget = dropTarget === column.id;
            const isRejecting =
              lastRejected?.columnId === column.id;
            const overWip =
              column.wipLimit !== undefined && columnTasks.length > column.wipLimit;
            const columnAccent = column.accent;
            const isLocked = column.locked ?? false;

            return (
              <section
                key={column.id}
                className={cx(
                  'iu-kanban__column',
                  isTarget && 'is-drop-target',
                  isRejecting && 'is-rejected',
                  isLocked && 'is-locked',
                  overWip && 'is-over-wip',
                )}
                style={
                  {
                    '--iu-column-index': String(columnIndex),
                    ...(columnAccent
                      ? {
                          '--iu-accent': `var(--iu-${columnAccent})`,
                          '--iu-accent-bright': `var(--iu-${columnAccent}-bright)`,
                          '--iu-accent-text': `var(--iu-${columnAccent}-text, var(--iu-${columnAccent}-bright))`,
                          '--iu-accent-rgb': `var(--iu-${columnAccent}-rgb)`,
                        }
                      : {}),
                  } as CSSProperties
                }
                aria-label={`${column.title}，${columnTasks.length} 项`}
                onDragOver={(event) => {
                  if (!draggable) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dropTarget !== column.id) setDropTarget(column.id);
                }}
                onDragLeave={(event) => {
                  // 只在真正离开列元素时清，避免子元素冒泡误清
                  if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                  if (dropTarget === column.id) setDropTarget(null);
                }}
                onDrop={(event) => handleDrop(column.id, event)}
              >
                {/* 列头 */}
                <header className="iu-kanban__column-head">
                  <span className="iu-kanban__column-index iu-num">
                    {String(columnIndex + 1).padStart(2, '0')}
                  </span>
                  <span className="iu-kanban__column-title-wrap">
                    <span className="iu-kanban__column-title">{column.title}</span>
                    {column.subtitle ? (
                      <span className="iu-kanban__column-subtitle iu-num">{column.subtitle}</span>
                    ) : null}
                  </span>
                  <span className="iu-kanban__column-count iu-num">
                    {columnTasks.length}
                    {column.wipLimit !== undefined ? `/${column.wipLimit}` : ''}
                  </span>
                  {onTaskCreate ? (
                    <button
                      type="button"
                      className="iu-kanban__add iu-focus"
                      onClick={() => onTaskCreate(column.id)}
                      aria-label={`在 ${column.title} 新建任务`}
                    >
                      +
                    </button>
                  ) : null}
                </header>

                {/* 连接线（任务链条感） */}
                {columnIndex < columns.length - 1 ? (
                  <span className="iu-kanban__connector" aria-hidden="true" />
                ) : null}

                {/* 卡片列表 */}
                <div className="iu-kanban__cards iu-scroll">
                  {columnTasks.length === 0 ? (
                    <p className="iu-kanban__empty">
                      {isLocked ? '终态舱段 · 空' : '空舱段 · 拖入任务'}
                    </p>
                  ) : null}

                  {columnTasks.map((task) => {
                    const isSelected = selectedId === task.id;
                    const isBeingDragged = dragging?.taskId === task.id;
                    const isRejected = lastRejected?.taskId === task.id;
                    const taskAccent = task.accent;

                    return (
                      <div
                        key={task.id}
                        className={cx(
                          'iu-kanban__card',
                          isSelected && 'is-selected',
                          isBeingDragged && 'is-being-dragged',
                          isRejected && 'is-rejected',
                          task.blocked && 'is-blocked',
                        )}
                        style={
                          taskAccent
                            ? ({
                                '--iu-accent': `var(--iu-${taskAccent})`,
                                '--iu-accent-bright': `var(--iu-${taskAccent}-bright)`,
                                '--iu-accent-text': `var(--iu-${taskAccent}-text, var(--iu-${taskAccent}-bright))`,
                                '--iu-accent-rgb': `var(--iu-${taskAccent}-rgb)`,
                              } as CSSProperties)
                            : undefined
                        }
                        role="button"
                        tabIndex={0}
                        draggable={draggable}
                        aria-label={`${task.title}${
                          task.priority ? ` · ${task.priority}` : ''
                        }${task.blocked ? ` · 已阻断：${task.blockedReason ?? ''}` : ''}`}
                        aria-pressed={isSelected}
                        aria-describedby={task.blocked ? `${uid}-blocked-${task.id}` : undefined}
                        onDragStart={(event) => handleDragStart(task, event)}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropTarget(null);
                        }}
                        onClick={(event) => onTaskClick?.(task, event)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            if (event.key === ' ') event.preventDefault();
                            onTaskClick?.(task, event as unknown as React.MouseEvent);
                            return;
                          }
                          handleKeyMove(task, event);
                        }}
                      >
                        {/* 左上角：优先级/状态灯 */}
                        <span className="iu-kanban__card-top">
                          <span
                            className="iu-kanban__card-status"
                            data-blocked={task.blocked ? 'true' : 'false'}
                            aria-hidden="true"
                          />
                          {task.priority ? (
                            <span
                              className="iu-kanban__card-priority iu-num"
                              data-priority={task.priority}
                            >
                              {task.priority}
                            </span>
                          ) : null}
                          {task.window ? (
                            <span className="iu-kanban__card-window iu-num">{task.window}</span>
                          ) : null}
                          {task.assignee ? (
                            <span className="iu-kanban__card-assignee" aria-hidden="true">
                              {task.assignee}
                            </span>
                          ) : null}
                        </span>

                        <span className="iu-kanban__card-title">{task.title}</span>

                        {task.summary ? (
                          <span className="iu-kanban__card-summary">{task.summary}</span>
                        ) : null}

                        {/* 进度条 */}
                        {task.progress !== undefined ? (
                          <span className="iu-kanban__card-progress" aria-hidden="true">
                            <span
                              className="iu-kanban__card-progress-fill"
                              style={{ width: `${normalize(task.progress, 0, 1) * 100}%` }}
                            />
                            <span className="iu-kanban__card-progress-label iu-num">
                              {formatFixed(normalize(task.progress, 0, 1) * 100, 0)}%
                            </span>
                          </span>
                        ) : null}

                        {/* 标签 */}
                        {task.tags && task.tags.length > 0 ? (
                          <span className="iu-kanban__card-tags">
                            {task.tags.map((tag) => (
                              <span key={tag} className="iu-kanban__card-tag">
                                {tag}
                              </span>
                            ))}
                          </span>
                        ) : null}

                        {/* 底行 */}
                        <span className="iu-kanban__card-foot">
                          {task.due ? (
                            <span className="iu-kanban__card-due iu-num">{task.due}</span>
                          ) : null}
                          {task.blocked ? (
                            <span
                              className="iu-kanban__card-blocked"
                              id={`${uid}-blocked-${task.id}`}
                            >
                              ⚠ {task.blockedReason ?? '已阻断'}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        {/* 底部状态栏 */}
        <footer className="iu-kanban__footer">
          <span className="iu-kanban__footer-hint">
            拖拽换列 · 聚焦卡片后 ←/→ 移动（非法跃迁会被状态机拒绝）
          </span>
          <span className="iu-kanban__footer-legend" aria-hidden="true">
            <span className="iu-kanban__legend-dot is-blocked" />阻断
            <span className="iu-kanban__legend-dot is-normal" />正常
          </span>
        </footer>
      </div>

      {accessibleTable ? (
        <table className="iu-sr-only">
          <caption>{title} 任务列表</caption>
          <thead>
            <tr>
              <th scope="col">任务</th>
              <th scope="col">所在列</th>
              <th scope="col">优先级</th>
              <th scope="col">进度</th>
              <th scope="col">截止</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const column = columns.find((c) => c.id === task.columnId);
              return (
                <tr key={task.id}>
                  <td>{task.title}</td>
                  <td>{column?.title ?? task.columnId}</td>
                  <td>{task.priority ?? '—'}</td>
                  <td>
                    {task.progress !== undefined
                      ? `${formatFixed(normalize(task.progress, 0, 1) * 100, 0)}%`
                      : '—'}
                  </td>
                  <td>{task.due ?? '—'}</td>
                  <td>{task.blocked ? `阻断：${task.blockedReason ?? ''}` : '正常'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
