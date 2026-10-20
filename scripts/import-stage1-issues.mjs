#!/usr/bin/env node
/**
 * 一次性把 WBS 的 Stage 1 任务导入为 GitHub Issues。
 *
 * 用法：
 *   node scripts/import-stage1-issues.mjs --dry-run   # 只看会创建什么
 *   node scripts/import-stage1-issues.mjs             # 真正创建
 *
 * 依赖 gh CLI 已登录且对仓库有 issue 写权限。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'meat-daemon-404/matrixos';
const DRY = process.argv.includes('--dry-run');

// 从 WBS 解析 Stage 1 表格行
const wbs = readFileSync(join(ROOT, 'docs/01-plan/03-work-breakdown.md'), 'utf8');
const lines = wbs.split(/\r?\n/);

const ORBIT_LABEL = {
  '01': 'orbit-1', '02': 'orbit-2', '03': 'orbit-2',
  '04': 'orbit-3', '05': 'orbit-3',
  '06': 'orbit-4', '07': 'orbit-4', '08': 'orbit-4',
  '09': 'orbit-5', '10': 'orbit-5', '11': 'orbit-5', '12': 'orbit-5',
  '13': 'orbit-5', '14': 'orbit-5', '15': 'orbit-5',
  '16': 'orbit-6', '17': 'orbit-7', '18': 'orbit-7',
};

function parseRow(line) {
  // | `S1-01` | 标题 | P0 | 3 | TL | 验收 |
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length < 7) return null;
  const id = cells[1].replace(/`/g, '');
  if (!/^S1-\d+/.test(id)) return null;
  return {
    id,
    title: cells[2],
    priority: cells[3],
    effort: cells[4],
    role: cells[5],
    acceptance: cells.slice(6, -1).join(' | ').trim(),
  };
}

const tasks = lines.map(parseRow).filter(Boolean);

// 从标题推断 area 标签
function areaLabel(title) {
  const t = title.toLowerCase();
  if (/monorepo|turbo|脚手架|scaffold/.test(t)) return 'area:orbital-hub';
  if (/twin-schema|schema|契约|contract/.test(t)) return 'area:twin-schema';
  if (/matrixid|鉴权|auth|jwt|oauth/.test(t)) return 'area:twin-schema';
  if (/matrix-sdk|sdk/.test(t)) return 'area:matrix-sdk';
  if (/copilot|模型|llm|路由/.test(t)) return 'area:copilot-router';
  if (/微站|micro-?site/.test(t)) return 'area:microsite';
  if (/ci|actions|telemetry|日志|log|观测/.test(t)) return 'area:orbital-hub';
  if (/toolbox|工具/.test(t)) return 'area:copilot-router';
  return 'area:microsite';
}

function labelsFor(t) {
  const ls = ['stage-1', t.priority, areaLabel(t.title)];
  if (/e$/.test(t.id)) ls.push('type:docs');
  else if (/x$/.test(t.id)) ls.push('type:infra');
  else ls.push('type:feature');
  return [...new Set(ls)];
}

function bodyFor(t) {
  return [
    `> 本 Issue 由 \`scripts/import-stage1-issues.mjs\` 从 WBS 自动导入。`,
    `> 上游：[\`docs/01-plan/03-work-breakdown.md\`](../blob/main/docs/01-plan/03-work-breakdown.md)`,
    `> 架构依据：[\`docs/01-plan/01-architecture.md\`](../blob/main/docs/01-plan/01-architecture.md)`,
    ``,
    `## 任务`,
    ``,
    t.title,
    ``,
    `## 验收标准`,
    ``,
    t.acceptance,
    ``,
    `## 元信息`,
    ``,
    `| 项 | 值 |`,
    `| :--- | :--- |`,
    `| WBS ID | \`${t.id}\` |`,
    `| 优先级 | ${t.priority} |`,
    `| 估时 | ${t.effort} 人日 |`,
    `| 建议角色 | ${t.role} |`,
    `| 阶段 | Stage 1 · 解耦与接口协议标准化 |`,
    ``,
    `## 完成定义 (DoD)`,
    ``,
    `- [ ] 验收标准逐项有证据（测试输出 / 截图 / 日志）`,
    `- [ ] 代码已合入 \`main\``,
    `- [ ] 若涉及契约变更，已在 PR 中说明影响面`,
    ``,
    `---`,
    ``,
    `⚠️ 开工前请先读 [\`docs/01-plan/00-adr-000-spec-authority.md\`](../blob/main/docs/01-plan/00-adr-000-spec-authority.md)：`,
    `Bundle 内两份规范冲突，以 v3 HTML 图谱为准。`,
  ].join('\n');
}

console.log(`解析到 Stage 1 任务 ${tasks.length} 个\n`);
if (tasks.length === 0) {
  console.error('未解析到任务，请检查 WBS 表格格式');
  process.exit(1);
}

let created = 0;
let failed = 0;

for (const t of tasks) {
  const labels = labelsFor(t);
  // 标题清洗：去 markdown 粗体/行内代码，压空白，截断
  const cleanTitle = t.title
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  const title = `[${t.id}] ${cleanTitle}`;
  if (DRY) {
    console.log(`--- ${t.id} | ${t.priority} | ${t.effort}pd | ${t.role}`);
    console.log(`    title : ${title}`);
    console.log(`    labels: ${labels.join(', ')}`);
    continue;
  }
  try {
    const out = execFileSync(
      'gh',
      [
        'issue', 'create',
        '--repo', REPO,
        '--title', title,
        '--body', bodyFor(t),
        '--label', labels.join(','),
        '--milestone', 'Stage 1 · 解耦与接口协议标准化',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    created++;
    console.log(`✓ ${t.id}  ${out}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${t.id}  ${e.message.split('\n')[0]}`);
  }
}

if (DRY) {
  console.log('\n(dry-run 结束，未创建任何 Issue)');
} else {
  console.log(`\n创建成功 ${created} 个，失败 ${failed} 个`);
  if (failed) process.exit(1);
}
