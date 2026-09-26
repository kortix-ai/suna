/**
 * The public audit contract names every actor type the writer can emit.
 *
 * The request audit writes a request nobody identified as `anonymous`. The
 * response schema and the `?actor_type=` filters must accept that value, or
 * an operator can see those rows but never select them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AuditActorType } from './audit';
import { AUDIT_ACTOR_TYPES, AuditActorTypeSchema, AuditEventSchema } from './audit-schema';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('audit actor types', () => {
  test('the public list is exactly the set the writer emits', () => {
    const same: Same<(typeof AUDIT_ACTOR_TYPES)[number], AuditActorType> = true;
    expect(same).toBe(true);
    expect([...AUDIT_ACTOR_TYPES]).toEqual([
      'human',
      'agent',
      'service_account',
      'system',
      'anonymous',
    ]);
  });

  test('an anonymous row is a valid response event', () => {
    expect(AuditEventSchema.shape.actor_type.parse('anonymous')).toBe('anonymous');
    expect(AuditEventSchema.shape.actor_type.parse(null)).toBeNull();
  });

  test('the filter accepts anonymous and still refuses an unknown type', () => {
    expect(AuditActorTypeSchema.parse('anonymous')).toBe('anonymous');
    expect(AuditActorTypeSchema.safeParse('robot').success).toBe(false);
  });

  test.each([
    ['../accounts/audit.ts', 2],
    ['../projects/routes/project-audit.ts', 1],
  ])('%s filters with the shared schema, never a local copy', (path, uses) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source).not.toContain("z.enum(['human', 'agent', 'service_account', 'system'");
    expect(source.match(/actor_type: AuditActorTypeSchema\.optional\(\)/g)).toHaveLength(uses);
  });
});
