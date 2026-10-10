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

function shape(s: z.ZodTypeAny, pad: string, root = false): string {
  const name = named.get(s);
  if (name && !root) return name;
  const d = s._def;
  const inner = pad + '  ';
  switch (d.typeName) {
    case z.ZodFirstPartyTypeKind.ZodOptional: return `${shape(d.innerType, pad)} | absent`;
    case z.ZodFirstPartyTypeKind.ZodNullable: return `${shape(d.innerType, pad)} | null`;
    case z.ZodFirstPartyTypeKind.ZodEffects: return `${shape(d.schema, pad)} + refine`;
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const fields = Object.entries((s as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>).map(([k, v]) => `${inner}${k}: ${shape(v, inner)}`);
      return fields.length ? `{\n${fields.join('\n')}\n${pad}}` : '{}';
    }
    case z.ZodFirstPartyTypeKind.ZodEnum: return `enum(${d.values.join(' | ')})`;
    case z.ZodFirstPartyTypeKind.ZodLiteral: return `literal(${JSON.stringify(d.value)})`;
    case z.ZodFirstPartyTypeKind.ZodUnion:
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return `union(\n${[...(d.options as Iterable<z.ZodTypeAny>)].map((o) => `${inner}| ${shape(o, inner)}`).join('\n')}\n${pad})`;
    case z.ZodFirstPartyTypeKind.ZodArray: return `array(${shape(d.type, pad)})`;
    case z.ZodFirstPartyTypeKind.ZodRecord: return `record(${shape(d.valueType, pad)})`;
    case z.ZodFirstPartyTypeKind.ZodString: return d.checks.some((c: { kind: string }) => c.kind === 'min') ? 'string(non-empty)' : 'string';
    case z.ZodFirstPartyTypeKind.ZodNumber: return `number${d.checks.map((c: { kind: string }) => `(${c.kind})`).join('')}`;
    default: return d.typeName.replace('Zod', '').toLowerCase();
  }
}

const render = () =>
  [...named]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([schema, name]) => `${name} = ${shape(schema as z.ZodTypeAny, '', true)}`)
    .join('\n\n') + '\n';

test('the shape of every exported session-log schema matches the committed snapshot', () => {
  const actual = render();
  if (process.env.SESSION_LOG_SHAPE_UPDATE === '1') writeFileSync(SNAPSHOT, actual);
  expect(actual).toBe(readFileSync(SNAPSHOT, 'utf8'));
});
