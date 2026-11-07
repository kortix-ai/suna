import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import * as sessionLog from '../session-log';

/**
 * Pins the shape of every exported zod schema of the session log: keys, which are optional or
 * nullable, enum members, union variants. A shape change fails this test until the snapshot is
 * updated on purpose: `SESSION_LOG_SHAPE_UPDATE=1 bun test src/__tests__/session-log-shape.test.ts`
 * (from packages/api-contract), then review and commit the snapshot diff. After a minor is
 * released, a change that is not an optional field is a breaking change.
 */
const SNAPSHOT = join(import.meta.dir, 'session-log-shape.snapshot.txt');

const named = new Map<unknown, string>(Object.entries(sessionLog).filter(([, v]) => v instanceof z.ZodType).map(([k, v]) => [v, k]));

type Def = Record<string, any> & { type: string; checks?: Array<{ _zod: { def: Record<string, any> } }> };

/** One check in the notation the snapshot was written in: (min1), (int), (regex). */
function checkText(c: Record<string, any>): string {
  switch (c.check) {
    case 'min_length': return `(min${c.minimum})`;
    case 'max_length': return `(max${c.maximum})`;
    case 'length_equals': return `(length${c.length})`;
    case 'greater_than': return `(min${c.value})`;
    case 'less_than': return `(max${c.value})`;
    case 'number_format': return c.format === 'safeint' || c.format === 'int32' ? '(int)' : `(${c.format})`;
    case 'string_format': return `(${c.format})`;
    default: return `(${c.check})`;
  }
}

function shape(s: z.ZodType, pad: string, root = false): string {
  const name = named.get(s);
  if (name && !root) return name;
  const d = s._zod.def as Def;
  const checks = (d.checks ?? []).map((c) => c._zod.def);
  const refined = checks.some((c) => c.check === 'custom');
  const base = baseShape(s, d, checks.filter((c) => c.check !== 'custom'), pad);
  return refined ? `${base} + refine` : base;
}

function baseShape(s: z.ZodType, d: Def, checks: Array<Record<string, any>>, pad: string): string {
  const inner = pad + '  ';
  switch (d.type) {
    case 'optional': return `${shape(d.innerType, pad)} | absent`;
    case 'nullable': return `${shape(d.innerType, pad)} | null`;
    case 'pipe': return `${shape(d.in, pad)} + refine`;
    case 'object': {
      const fields = Object.entries((s as z.ZodObject).shape as Record<string, z.ZodType>).map(([k, v]) => `${inner}${k}: ${shape(v, inner)}`);
      const catchall = d.catchall?._zod.def.type;
      const keys = catchall === 'never' ? 'strict ' : catchall === 'unknown' ? 'passthrough ' : '';
      return `${keys}{${fields.length ? `\n${fields.join('\n')}\n${pad}` : ''}}`;
    }
    case 'enum': return `enum(${Object.values(d.entries as Record<string, string>).join(' | ')})`;
    case 'literal': return `literal(${JSON.stringify((d.values as unknown[])[0])})`;
    case 'union':
      return `union(\n${(d.options as z.ZodType[]).map((o) => `${inner}| ${shape(o, inner)}`).join('\n')}\n${pad})`;
    case 'array': return `array(${shape(d.element, pad)})`;
    case 'record': return `record(${shape(d.valueType, pad)})`;
    case 'string':
    case 'number': return `${d.type}${checks.map(checkText).join('')}`;
    default: return d.type;
  }
}

const render = () =>
  [...named]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([schema, name]) => `${name} = ${shape(schema as z.ZodType, '', true)}`)
    .join('\n\n') + '\n';

test('the shape of every exported session-log schema matches the committed snapshot', () => {
  const actual = render();
  if (process.env.SESSION_LOG_SHAPE_UPDATE === '1') writeFileSync(SNAPSHOT, actual);
  expect(actual).toBe(readFileSync(SNAPSHOT, 'utf8'));
});
