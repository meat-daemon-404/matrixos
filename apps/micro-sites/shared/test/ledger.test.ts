/**
 * `src/ledger.ts` 单元测试。
 *
 * 测试重点不在 happy path，而在「坏数据不能炸 UI」：
 * 坏 JSON、版本不匹配、形状不符、存储不可用、配额写失败 ——
 * 这些是 18 个微站里最容易被 localStorage 拖垮的地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLedger,
  createLocalWormholeEnvelope,
  toCsv,
  type LedgerStorage,
} from '../src/ledger.ts';

/* ───────────────────────── 内存存储实现 ───────────────────────── */

function memoryStorage(initial: Record<string, string> = {}): LedgerStorage & {
  readonly dump: Record<string, string>;
  failWrites: boolean;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get dump() {
      return Object.fromEntries(map);
    },
    failWrites: false,
    getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key, value) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

interface Item {
  readonly id: string;
  readonly label: string;
}

const baseOptions = {
  key: 'mx.test.items',
  version: 2,
  createDefault: (): Item[] => [],
  validate: (value: unknown): value is Item[] =>
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'object' && entry !== null && typeof (entry as Item).id === 'string'),
};

/* ─────────────────────────── 基础读写 ─────────────────────────── */

test('空存储：read 返回默认值，且不写盘', () => {
  const storage = memoryStorage();
  const ledger = createLedger({ ...baseOptions, storage });
  const snapshot = ledger.read();
  assert.deepEqual(snapshot.data, []);
  assert.equal(snapshot.version, 2);
  assert.equal(ledger.available, true);
  // 读空不应产生写入
  assert.deepEqual(Object.keys(storage.dump), []);
});

test('write → read 往返：数据与 updatedAt 保留', () => {
  const storage = memoryStorage();
  const ledger = createLedger({ ...baseOptions, storage });
  const written = ledger.write([{ id: 'a', label: '方案 A' }]);
  assert.deepEqual(written.data, [{ id: 'a', label: '方案 A' }]);
  const read = ledger.read();
  assert.deepEqual(read.data, [{ id: 'a', label: '方案 A' }]);
  assert.equal(read.updatedAt, written.updatedAt);
  // 存的是版本化信封，不是裸数组
  const raw = JSON.parse(storage.dump['mx.test.items'] as string) as Record<string, unknown>;
  assert.equal(raw.version, 2);
  assert.ok(typeof raw.updatedAt === 'string');
});

test('update：读改写一步完成', () => {
  const storage = memoryStorage();
  const ledger = createLedger({ ...baseOptions, storage });
  ledger.write([{ id: 'a', label: 'A' }]);
  const next = ledger.update((prev) => [...prev, { id: 'b', label: 'B' }]);
  assert.deepEqual(
    next.data.map((item) => item.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    ledger.read().data.map((item) => item.id),
    ['a', 'b'],
  );
});

test('reset：清空键并回到默认值', () => {
  const storage = memoryStorage();
  const ledger = createLedger({ ...baseOptions, storage });
  ledger.write([{ id: 'a', label: 'A' }]);
  const reset = ledger.reset();
  assert.deepEqual(reset.data, []);
  assert.deepEqual(Object.keys(storage.dump), []);
  assert.deepEqual(ledger.read().data, []);
});

test('createDefault 每次返回新对象（不共享引用）', () => {
  const storage = memoryStorage();
  const ledger = createLedger({ ...baseOptions, storage, createDefault: () => [{ id: 'seed', label: '默认' }] });
  const first = ledger.read();
  const second = ledger.read();
  assert.notEqual(first.data, second.data);
  assert.notEqual(first.data[0], second.data[0]);
});

/* ─────────────────────────── 坏数据容错 ─────────────────────────── */

test('坏 JSON：回默认值，不抛错，不覆盖原始数据', () => {
  const storage = memoryStorage({ 'mx.test.items': '{ not json' });
  const ledger = createLedger({ ...baseOptions, storage });
  assert.deepEqual(ledger.read().data, []);
  assert.equal(storage.dump['mx.test.items'], '{ not json');
});

test('非信封形状（裸数组）：回默认值', () => {
  const storage = memoryStorage({ 'mx.test.items': '[{"id":"a","label":"A"}]' });
  const ledger = createLedger({ ...baseOptions, storage });
  assert.deepEqual(ledger.read().data, []);
});

test('validate 失败：回默认值', () => {
  const envelope = JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), data: [{ nope: 1 }] });
  const storage = memoryStorage({ 'mx.test.items': envelope });
  const ledger = createLedger({ ...baseOptions, storage });
  assert.deepEqual(ledger.read().data, []);
});

test('版本不匹配且无 migrate：回默认值，不写盘', () => {
  const envelope = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), data: [{ id: 'a', label: 'A' }] });
  const storage = memoryStorage({ 'mx.test.items': envelope });
  const ledger = createLedger({ ...baseOptions, storage });
  assert.deepEqual(ledger.read().data, []);
  assert.equal(JSON.parse(storage.dump['mx.test.items'] as string).version, 1);
});

test('版本不匹配但有 migrate：迁移并落盘为新版本', () => {
  const envelope = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), data: ['a', 'b'] });
  const storage = memoryStorage({ 'mx.test.items': envelope });
  const ledger = createLedger({
    ...baseOptions,
    storage,
    migrate: (raw, fromVersion) => {
      if (fromVersion !== 1 || !Array.isArray(raw)) return null;
      return raw.map((id, index) => ({ id: String(id), label: `迁移-${index}` }));
    },
  });
  const read = ledger.read();
  assert.deepEqual(
    read.data.map((item) => item.id),
    ['a', 'b'],
  );
  // 迁移结果应已写回，避免下次重复迁移
  const persisted = JSON.parse(storage.dump['mx.test.items'] as string) as Record<string, unknown>;
  assert.equal(persisted.version, 2);
});

test('migrate 抛错：不影响 read，回默认值', () => {
  const envelope = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), data: [] });
  const storage = memoryStorage({ 'mx.test.items': envelope });
  const ledger = createLedger({
    ...baseOptions,
    storage,
    migrate: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(ledger.read().data, []);
});

/* ────────────────────── 存储不可用 / 写失败 ────────────────────── */

test('storage = null：available=false，读写不抛错', () => {
  const ledger = createLedger({ ...baseOptions, storage: null });
  assert.equal(ledger.available, false);
  const written = ledger.write([{ id: 'a', label: 'A' }]);
  assert.deepEqual(written.data, [{ id: 'a', label: 'A' }]);
  // 没有持久化，读回来是默认值
  assert.deepEqual(ledger.read().data, []);
});

test('配额写失败：write 不抛错，available 仍为 true（由调用方看返回）', () => {
  const storage = memoryStorage();
  storage.failWrites = true;
  const ledger = createLedger({ ...baseOptions, storage });
  const written = ledger.write([{ id: 'a', label: 'A' }]);
  assert.deepEqual(written.data, [{ id: 'a', label: 'A' }]);
  assert.deepEqual(ledger.read().data, []);
});

test('getItem 抛错：read 回默认值，不抛错', () => {
  const storage: LedgerStorage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {},
    removeItem() {},
  };
  const ledger = createLedger({ ...baseOptions, storage });
  assert.deepEqual(ledger.read().data, []);
});

/* ─────────────────────────── 导出 ─────────────────────────── */

test('非浏览器环境：exportJson / exportCsv 返回 false 而不是抛错', () => {
  const storage = memoryStorage();
  const ledger = createLedger({ ...baseOptions, storage });
  ledger.write([{ id: 'a', label: 'A' }]);
  assert.equal(ledger.exportJson(), false);
  assert.equal(ledger.exportCsv('x.csv', [['a', 'b']]), false);
  assert.equal(ledger.exportText('x.txt', 'hello'), false);
});

test('toCsv：逗号/引号/换行转义，表头可选', () => {
  const csv = toCsv(
    [
      ['a,b', 'say "hi"', 'line1\nline2'],
      [1, true, null],
    ],
    ['x', 'y', 'z'],
  );
  assert.equal(csv, 'x,y,z\r\n"a,b","say ""hi""","line1\nline2"\r\n1,true,');
});

/* ─────────────────────────── 虫洞信封 ─────────────────────────── */

test('createLocalWormholeEnvelope：证据锚点为空时抛错（契约红线）', () => {
  assert.throws(() =>
    createLocalWormholeEnvelope({
      sourceApp: 'gpa.matrixos.edu',
      targetApp: 'mentor.matrixos.edu',
      payloadType: 'mentor_match_card',
      data: {},
      evidenceAnchors: [],
    }),
  );
});

test('createLocalWormholeEnvelope：形状符合契约，trace_id 是 UUID，evidence 原样保留', () => {
  const envelope = createLocalWormholeEnvelope({
    sourceApp: 'curvelab.matrixos.edu',
    targetApp: 'mentor.matrixos.edu',
    payloadType: 'curve_fit_parameters',
    data: { model: 'bi-exponential', r2: 0.9884 },
    evidenceAnchors: [
      {
        source_doi_or_url: '10.1038/s41566-025-01234-5',
        verification_level: 'Level_A_Verified',
        pdf_page: 4,
        bbox: [72.5, 144, 300.25, 210.75],
      },
    ],
  });
  assert.match(envelope.trace_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(envelope.payload_type, 'curve_fit_parameters');
  assert.equal(envelope.payload.evidence_anchors.length, 1);
  assert.equal(envelope.matrix_uid, 'local-demo-user');
  assert.ok(Date.parse(envelope.created_at) > 0);
});
