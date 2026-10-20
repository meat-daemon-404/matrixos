/**
 * MatrixOS SDK · 零依赖的契约校验器
 *
 * 只实现冻结契约实际用到的 JSON Schema 关键字子集（draft-07）：
 *   type / required / additionalProperties / properties / items /
 *   enum / const / pattern / minLength / maxLength / minimum / maximum /
 *   minItems / maxItems / format(URI|email|uuid|date-time)
 *
 * ## 为什么不用 ajv
 *
 * `@matrixos/sdk` 被 18 个微站 + 第三方站 import。为了一个校验器引入 ajv
 * （≈120KB）会让每个微站的首屏包体白白变大，且 ajv 与 Next.js 的 ESM/CJS
 * 边界历史上出过问题。这里的关键字子集是固定且封闭的（契约已冻结），
 * 手写约 300 行的校验器反而更可控、更容易测、不会因为上游大版本升级而炸。
 *
 * ## 与 schema 的关系
 *
 * **规则全部来自 schema 数据本身**，本文件不含任何 manifest/envelope 的硬编码字段名。
 * schema 改了（虽然契约已冻结），校验行为自动跟着改。
 */

import type { JsonSchemaNode, JsonSchemaDocument } from './schemas.ts';

/** 引用定义（在 `$defs`/`definitions` 中解析 `$ref`）。 */
interface ValidationContext {
  readonly root: JsonSchemaDocument;
  readonly path: string;
  readonly errors: ValidationIssue[];
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly keyword: string;
  readonly severity: 'error' | 'warning';
}

const URI_RE = /^(?:[a-z][a-z0-9+.-]*):(?:\/\/)?[^\s]*$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function jsonPointerAppend(base: string, segment: string | number): string {
  const escaped = String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${base}/${escaped}`;
}

function resolveRef(root: JsonSchemaDocument, ref: string, ctx: ValidationContext): JsonSchemaNode | null {
  if (!ref.startsWith('#')) {
    ctx.errors.push({
      path: ctx.path,
      keyword: 'unsupportedRef',
      message: `不支持外部 $ref「${ref}」，冻结契约只应使用文档内引用`,
      severity: 'error',
    });
    return null;
  }
  const segments = ref
    .slice(1)
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node: unknown = root;
  for (const seg of segments) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[seg];
    if (node === undefined) return null;
  }
  return typeof node === 'object' || typeof node === 'boolean' ? (node as JsonSchemaNode) : null;
}

function validateNode(value: unknown, schema: JsonSchemaNode, ctx: ValidationContext): void {
  if (schema === true) return;
  if (schema === false) {
    ctx.errors.push({
      path: ctx.path,
      keyword: 'false',
      message: '该位置不允许出现任何值（schema 为 false）',
      severity: 'error',
    });
    return;
  }
  const s = schema as { readonly [keyword: string]: unknown };

  // ── $ref ──────────────────────────────────────────────────────────────────
  if (typeof s.$ref === 'string') {
    const target = resolveRef(ctx.root, s.$ref, ctx);
    if (target !== null) validateNode(value, target, ctx);
    return;
  }

  // ── const ─────────────────────────────────────────────────────────────────
  if ('const' in s && !deepEqual(value, s.const)) {
    ctx.errors.push({
      path: ctx.path,
      keyword: 'const',
      message: `必须等于 ${JSON.stringify(s.const)}，实际为 ${JSON.stringify(value)}`,
      severity: 'error',
    });
    return;
  }

  // ── enum ──────────────────────────────────────────────────────────────────
  if (Array.isArray(s.enum) && !s.enum.some((candidate) => deepEqual(value, candidate))) {
    ctx.errors.push({
      path: ctx.path,
      keyword: 'enum',
      message: `取值必须是 ${(s.enum as readonly unknown[]).map((v) => JSON.stringify(v)).join(' | ')} 之一，实际为 ${JSON.stringify(value)}`,
      severity: 'error',
    });
  }

  // ── type ──────────────────────────────────────────────────────────────────
  if (typeof s.type === 'string' && !matchesType(value, s.type)) {
    ctx.errors.push({
      path: ctx.path,
      keyword: 'type',
      message: `类型应为 ${s.type}，实际为 ${typeOf(value)}`,
      severity: 'error',
    });
    return; // 类型不符时后续字符串/数值约束没有意义
  }
  if (Array.isArray(s.type) && !s.type.some((t) => typeof t === 'string' && matchesType(value, t))) {
    ctx.errors.push({
      path: ctx.path,
      keyword: 'type',
      message: `类型应为 ${(s.type as readonly string[]).join(' | ')} 之一，实际为 ${typeOf(value)}`,
      severity: 'error',
    });
    return;
  }

  // ── 字符串约束 ────────────────────────────────────────────────────────────
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      ctx.errors.push({
        path: ctx.path,
        keyword: 'minLength',
        message: `长度不得少于 ${s.minLength}，实际 ${value.length}`,
        severity: 'error',
      });
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      ctx.errors.push({
        path: ctx.path,
        keyword: 'maxLength',
        message: `长度不得超过 ${s.maxLength}，实际 ${value.length}`,
        severity: 'error',
      });
    }
    if (typeof s.pattern === 'string') {
      let re: RegExp | null = null;
      try {
        re = new RegExp(s.pattern, 'u');
      } catch {
        re = null;
      }
      if (re !== null && !re.test(value)) {
        ctx.errors.push({
          path: ctx.path,
          keyword: 'pattern',
          message: `不符合格式要求 ${s.pattern}，实际为「${value}」`,
          severity: 'error',
        });
      }
    }
    if (typeof s.format === 'string') {
      const formatOk = checkFormat(value, s.format);
      if (formatOk === false) {
        ctx.errors.push({
          path: ctx.path,
          keyword: 'format',
          message: `不是合法的 ${s.format}：${value}`,
          severity: 'error',
        });
      }
    }
  }

  // ── 数值约束 ──────────────────────────────────────────────────────────────
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      ctx.errors.push({
        path: ctx.path,
        keyword: 'minimum',
        message: `不得小于 ${s.minimum}，实际 ${value}`,
        severity: 'error',
      });
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      ctx.errors.push({
        path: ctx.path,
        keyword: 'maximum',
        message: `不得大于 ${s.maximum}，实际 ${value}`,
        severity: 'error',
      });
    }
  }

  // ── 数组约束 ──────────────────────────────────────────────────────────────
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      ctx.errors.push({
        path: ctx.path,
        keyword: 'minItems',
        message: `至少需要 ${s.minItems} 项，实际 ${value.length} 项`,
        severity: 'error',
      });
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      ctx.errors.push({
        path: ctx.path,
        keyword: 'maxItems',
        message: `最多允许 ${s.maxItems} 项，实际 ${value.length} 项`,
        severity: 'error',
      });
    }
    if (s.items !== undefined && s.items !== null) {
      const items = s.items as JsonSchemaNode;
      value.forEach((item, index) => {
        validateNode(item, items, { ...ctx, path: jsonPointerAppend(ctx.path, index) });
      });
    }
  }

  // ── 对象约束 ──────────────────────────────────────────────────────────────
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (s.properties ?? {}) as Readonly<Record<string, JsonSchemaNode>>;

    if (Array.isArray(s.required)) {
      for (const key of s.required as readonly string[]) {
        if (!(key in record) || record[key] === undefined) {
          ctx.errors.push({
            path: ctx.path,
            keyword: 'required',
            message: `缺少必填字段 \`${key}\``,
            severity: 'error',
          });
        }
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record && record[key] !== undefined) {
        validateNode(record[key], childSchema, { ...ctx, path: jsonPointerAppend(ctx.path, key) });
      }
    }

    // additionalProperties: false —— 冻结契约的封闭性由它保证（ADR-10 的「只增不改」）。
    if (s.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties) && record[key] !== undefined) {
          ctx.errors.push({
            path: jsonPointerAppend(ctx.path, key),
            keyword: 'additionalProperties',
            message: `不允许的额外字段 \`${key}\`（契约已冻结，扩展须走 ADR-10 版本化流程）`,
            severity: 'error',
          });
        }
      }
    } else if (s.additionalProperties !== undefined && typeof s.additionalProperties === 'object') {
      for (const key of Object.keys(record)) {
        if (!(key in properties) && record[key] !== undefined) {
          validateNode(record[key], s.additionalProperties as JsonSchemaNode, {
            ...ctx,
            path: jsonPointerAppend(ctx.path, key),
          });
        }
      }
    }
  }
}

function checkFormat(value: string, format: string): boolean | null {
  switch (format) {
    case 'uri':
    case 'uri-reference':
      return URI_RE.test(value);
    case 'email':
      return EMAIL_RE.test(value);
    case 'uuid':
      return UUID_RE.test(value);
    case 'date-time':
      return DATE_TIME_RE.test(value);
    default:
      // 未知 format 不判定为失败（draft-07 允许实现忽略不认识的 format）。
      return null;
  }
}

/** 键顺序无关的深度相等。用于 const/enum 判定与契约一致性测试复用。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec).sort();
  const bKeys = Object.keys(bRec).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((key, index) => key === bKeys[index])) return false;
  return aKeys.every((key) => deepEqual(aRec[key], bRec[key]));
}

/** 用一份 schema 校验任意值，返回全部问题（不短路，便于一次性展示给开发者）。 */
export function validateAgainstSchema(value: unknown, schema: JsonSchemaDocument): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  validateNode(value, schema as JsonSchemaNode, { root: schema, path: '', errors });
  return errors;
}

/** 把 JSON Pointer 路径渲染成人看得懂的字段名。 */
export function toFieldPath(pointer: string): string {
  if (pointer === '') return '(根)';
  return pointer
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

/** 生成「人可读」的报错摘要，直接用于 UI 与日志。 */
export function formatIssues(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => `${toFieldPath(issue.path)}: ${issue.message}`);
}
