// public.atomic_use_credits must have EXACTLY ONE signature, forever.
//
// The invariant broke twice:
//
//   1. The baseline shipped two overloads whose CALLABLE ARITIES overlapped at 4
//      (a 4-param/0-default one and a 5-param/3-default one). A positional
//      four-argument call is then ambiguous — SQLSTATE 42725 — in the money
//      path. Production only escaped it because the busiest caller used named
//      PostgREST parameters, which resolve by argument-name set instead.
//   2. The extra overload was also the WEAKER function: SECURITY INVOKER, no
//      metadata->>'ledger_type', and no balance guard. Anything that bound it
//      silently skipped the overdraft check added by
//      20260712160001000_atomic_use_credits_balance_guard.sql.
//
// 20260730012238065_credit_use_credits_single_overload.sql collapsed them, and
// 20260805175409752_credit_use_credits_idempotency.sql deliberately REPLACED the
// signature rather than overloading it. Nothing enforced either decision. This
// test does: it replays every CREATE/DROP of the function across the migration
// files in apply order and asserts the surviving set has one member.
//
// Signature identity here is the ordered list of INPUT ARGUMENT TYPES, which is
// exactly how PostgreSQL identifies a function. Parameter names and DEFAULTs are
// not part of it — that is why the 5-arg (…, p_thread_id, p_message_id) overload
// and today's 5-arg (…, p_ledger_type, p_idempotency_key) one are the same
// identity, and why the DROP in 20260805175409752 was required rather than
// optional.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../../../packages/db/migrations');
const FUNCTION = 'atomic_use_credits';

function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Text between the parenthesis that follows `from`, honouring nesting. */
function argumentList(sql: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openParen + 1, i);
    }
  }
  throw new Error('unbalanced parenthesis in migration SQL');
}

function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of args) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * `p_amount numeric` -> numeric, `p_description text DEFAULT 'x'::text` -> text,
 * and for a DROP's bare list, `numeric` -> numeric.
 */
function argumentType(declaration: string): string {
  const tokens = declaration.split(/\s+/);
  const type = tokens.length === 1 ? tokens[0]! : tokens[1]!;
  return type.toLowerCase().replace(/,$/, '');
}

function signaturesIn(sql: string, keyword: 'create' | 'drop'): string[] {
  const pattern =
    keyword === 'create'
      ? new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${FUNCTION}\\s*\\(`, 'gi')
      : new RegExp(`DROP\\s+FUNCTION(?:\\s+IF\\s+EXISTS)?\\s+public\\.${FUNCTION}\\s*\\(`, 'gi');

  const found: string[] = [];
  for (const match of sql.matchAll(pattern)) {
    const openParen = match.index! + match[0].length - 1;
    found.push(splitTopLevel(argumentList(sql, openParen)).map(argumentType).join(','));
  }
  return found;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function readSql(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');
}

function replay(): { live: Set<string>; touched: string[]; lastCreatedBy: string } {
  const live = new Set<string>();
  const touched: string[] = [];
  let lastCreatedBy = '';

  for (const name of migrationFiles()) {
    const sql = stripLineComments(readSql(name));
    const drops = signaturesIn(sql, 'drop');
    const creates = signaturesIn(sql, 'create');
    if (drops.length === 0 && creates.length === 0) continue;
    touched.push(name);
    for (const signature of drops) live.delete(signature);
    for (const signature of creates) live.add(signature);
    if (creates.length > 0) lastCreatedBy = name;
  }

  return { live, touched, lastCreatedBy };
}

describe('atomic_use_credits migration source', () => {
  test('the migrations actually define the function (the scan is not silently empty)', () => {
    const { touched } = replay();
    expect(touched.length).toBeGreaterThanOrEqual(4);
    expect(touched).toContain('20260712160001000_atomic_use_credits_balance_guard.sql');
    expect(touched).toContain('20260730012238065_credit_use_credits_single_overload.sql');
    expect(touched).toContain('20260805175409752_credit_use_credits_idempotency.sql');
  });

  test('exactly ONE signature survives the full migration replay', () => {
    const { live } = replay();
    expect([...live].sort()).toEqual(['uuid,numeric,text,text,text']);
  });

  test('the baseline really did ship the two overlapping overloads this guards against', () => {
    const baseline = stripLineComments(readSql('20260621094136410_baseline.sql'));
    expect(signaturesIn(baseline, 'create').sort()).toEqual([
      'uuid,numeric,text,text',
      'uuid,numeric,text,text,text',
    ]);
  });

  test('a new migration that adds a second overload would fail this test', () => {
    const { live } = replay();
    const hypothetical = new Set(live);
    for (const signature of signaturesIn(
      'CREATE OR REPLACE FUNCTION public.atomic_use_credits(p_account_id uuid, p_amount numeric)',
      'create',
    )) {
      hypothetical.add(signature);
    }
    expect(hypothetical.size).toBe(2);
  });

  // Resolved from the replay, never hardcoded: a future migration that replaces
  // the function becomes the subject of these assertions automatically, so
  // dropping the guard on the way past fails here instead of shipping.
  test('whichever migration defines the function LAST keeps the overdraft guard', () => {
    const { lastCreatedBy } = replay();
    const current = readSql(lastCreatedBy);
    expect(current).toContain('IF v_total < p_amount THEN');
    expect(current).toContain("'Insufficient credits'");
  });

  test('the last definition takes the row lock BEFORE the overdraft guard runs', () => {
    const { lastCreatedBy } = replay();
    const sql = readSql(lastCreatedBy);
    const bodyStart = sql.indexOf('CREATE OR REPLACE FUNCTION');
    const lockAt = sql.indexOf('FOR UPDATE', bodyStart);
    const guardAt = sql.indexOf('IF v_total < p_amount THEN', bodyStart);
    expect(lockAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(lockAt);
  });

  test('the last definition is SECURITY DEFINER with a pinned search_path', () => {
    const { lastCreatedBy } = replay();
    const sql = readSql(lastCreatedBy);
    const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO ''");
    expect(body).not.toContain('SECURITY INVOKER');
  });

  test('the last definition stamps the granular kind into metadata', () => {
    const { lastCreatedBy } = replay();
    expect(readSql(lastCreatedBy)).toContain("'ledger_type', p_ledger_type");
  });
});
