import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { wireMessageIdMatches } from './wire-id-match';

const compile = (messageId: string) =>
  new PgDialect().sqlToQuery(wireMessageIdMatches(messageId)!);

describe('wireMessageIdMatches', () => {
  test('matches all FOUR columns a wire id can be recorded in', () => {
    const q = compile('msg_000000000001AAAAAAAAAAAAAA');
    expect(q.sql).toBe(
      '("kortix"."session_lifecycle_commands"."payload"->>\'wireMessageId\' = $1' +
        ' or "kortix"."session_lifecycle_commands"."payload"->>\'redeliveredMessageId\' = $2' +
        ' or "kortix"."session_lifecycle_commands"."result"->>\'forwarded_message_id\' = $3' +
        " or coalesce(\"kortix\".\"session_lifecycle_commands\".\"payload\"->'redeliveredMessageIds', '[]'::jsonb) @> $4::jsonb)",
    );
    // Bound, never interpolated — the id comes off the wire. The fourth is the
    // one-element JSON array the `@>` containment test needs.
    expect(q.params).toEqual([
      'msg_000000000001AAAAAAAAAAAAAA',
      'msg_000000000001AAAAAAAAAAAAAA',
      'msg_000000000001AAAAAAAAAAAAAA',
      '["msg_000000000001AAAAAAAAAAAAAA"]',
    ]);
  });

  test('the id is a bound parameter, so a quote in it cannot reach the statement', () => {
    const q = compile("msg_x' OR '1'='1");
    expect(q.sql).not.toContain("1'='1");
    expect(q.params[0]).toBe("msg_x' OR '1'='1");
  });
});

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * Until 2026-08-20 four readers answered "which row does this wire id name?"
 * and only ONE of them (`cancel-forwarded.ts`) read
 * `result.forwarded_message_id`. A row whose forwarded id differed from both
 * payload ids — which `markCommandForwarded` (`store.ts:518`) writes precisely
 * so it CAN differ — was invisible to the other three:
 *
 *   consumption.ts `confirm`                -> row never closed
 *   redelivery.ts `findPromptByWireId`      -> never re-queued
 *   forwarded-strand-reconcile.ts           -> stranded prompt never redelivered
 *     `requeueStranded`
 *
 * `consumption.ts` even asserted in a comment that its predicate and
 * `redelivery.ts`'s could "never disagree about which row a wire id names".
 * The comment was true of those two and false of the set.
 *
 * A behavioural test cannot catch this class on its own: every one of these
 * modules is unit-tested through a dependency stand-in that RE-EXPRESSES the
 * SQL predicate in TypeScript, so a divergence in the real statement is
 * invisible to it — that is exactly how the bug survived. The statement itself
 * is what has to be pinned, so this asserts on the SOURCE: every reader calls
 * the one helper, and none of them hand-writes the id predicate again.
 */
describe('every wire-id reader uses the one predicate', () => {
  const READERS = [
    'consumption.ts',
    'redelivery.ts',
    'cancel-forwarded.ts',
    'forwarded-strand-reconcile.ts',
  ];
  const source = (file: string) => readFileSync(join(import.meta.dir, file), 'utf8');

  for (const file of READERS) {
    test(`${file} calls wireMessageIdMatches and hand-writes no id predicate`, () => {
      const src = source(file);
      expect(src).toContain('wireMessageIdMatches(');
      // The exact fragments the divergent copies were written with.
      expect(src).not.toContain("->>'wireMessageId' = ");
      expect(src).not.toContain("->>'redeliveredMessageId' = ");
      expect(src).not.toContain("->>'forwarded_message_id' = ");
    });
  }

  test('the predicate is defined in exactly one place', () => {
    expect(source('wire-id-match.ts')).toContain("->>'forwarded_message_id' = ");
  });
});
