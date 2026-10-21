/**
 * `createRowSpec` 的 `patch` 语义测试。
 *
 * 重点不在 happy path，而在三条容易被写错的边界：
 *   1. 空字符串不能把标题清空（列表里会只剩空白行）
 *   2. 未提供的字段必须保持原值（不能让 meta/detail 被 undefined 冲掉）
 *   3. `patch` 与 `edit` 的职责不同 —— patch **不该**追加「已编辑 N 次」后缀
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRowSpec } from '../src/ui/spec-factory.ts';

const spec = createRowSpec({
  exportName: 'test-rows',
  seed: [
    { title: '甲', meta: 'm-甲', detail: 'd-甲' },
    { title: '乙', meta: 'm-乙', detail: 'd-乙' },
  ],
  emit: { targetApp: 'evidence-cv', payloadType: 'verified_cv_evidence' },
  accept: { payloadType: 'verified_cv_evidence', description: '测试用' },
});

const ISO = '2026-10-21T00:00:00.000Z';

function seedData() {
  return spec.createDefault();
}

test('patch：三个字段都能改，且 id 不变', () => {
  const data = seedData();
  const id = data.rows[0].id;
  const next = spec.patch(data, id, { title: '新标题', meta: '新摘要', detail: '新详情' }, ISO);
  assert.equal(next.rows[0].title, '新标题');
  assert.equal(next.rows[0].meta, '新摘要');
  assert.equal(next.rows[0].detail, '新详情');
  assert.equal(next.rows[0].id, id);
  assert.equal(next.rows[0].updatedAt, ISO);
  // 第二条不受影响
  assert.equal(next.rows[1].title, '乙');
});

test('patch：未提供的字段保持原值（不被 undefined 冲掉）', () => {
  const data = seedData();
  const id = data.rows[0].id;
  const next = spec.patch(data, id, { title: '只改标题' }, ISO);
  assert.equal(next.rows[0].title, '只改标题');
  assert.equal(next.rows[0].meta, 'm-甲');
  assert.equal(next.rows[0].detail, 'd-甲');
});

test('patch：空串 / 纯空白不覆盖原值（不允许把标题清空）', () => {
  const data = seedData();
  const id = data.rows[0].id;
  const next = spec.patch(data, id, { title: '   ', meta: '', detail: '\n\t ' }, ISO);
  assert.equal(next.rows[0].title, '甲');
  assert.equal(next.rows[0].meta, 'm-甲');
  assert.equal(next.rows[0].detail, 'd-甲');
});

test('patch：两端空白被裁掉', () => {
  const data = seedData();
  const id = data.rows[0].id;
  const next = spec.patch(data, id, { title: '  有空格  ' }, ISO);
  assert.equal(next.rows[0].title, '有空格');
});

test('patch：不追加「已编辑 N 次」后缀（那是 edit 的职责）', () => {
  const data = seedData();
  const id = data.rows[0].id;
  const afterPatch = spec.patch(data, id, { title: '用户自己写的标题' }, ISO);
  assert.equal(afterPatch.rows[0].title, '用户自己写的标题');
  assert.ok(!afterPatch.rows[0].title.includes('已编辑'));
});

test('patch：不存在的 id 不改变任何记录', () => {
  const data = seedData();
  const next = spec.patch(data, 'no-such-id', { title: 'X' }, ISO);
  assert.deepEqual(
    next.rows.map((r) => r.title),
    data.rows.map((r) => r.title),
  );
});

test('patch 之后再 edit：edit 仍能正常追加编辑次数', () => {
  const data = seedData();
  const id = data.rows[0].id;
  const patched = spec.patch(data, id, { title: '用户标题' }, ISO);
  const edited = spec.edit(patched, id, ISO);
  assert.match(edited.rows[0].title, /用户标题 · 已编辑 1 次/);
});

test('patch 结果能通过 validate（不会被台账当成坏数据回落）', () => {
  const data = seedData();
  const next = spec.patch(data, data.rows[0].id, { title: 't', meta: 'm', detail: 'd' }, ISO);
  if (spec.validate) {
    assert.equal(spec.validate(next), true);
  }
});
