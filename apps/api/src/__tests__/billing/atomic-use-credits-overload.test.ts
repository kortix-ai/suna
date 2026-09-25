// The debit function must have EXACTLY ONE signature, forever.
//
// The invariant broke twice:
//
//   1. The baseline shipped two overloads of public.atomic_use_credits whose
//      CALLABLE ARITIES overlapped at 4 (a 4-param/0-default one and a
//      5-param/3-default one). A positional four-argument call is then
//      ambiguous — SQLSTATE 42725 — in the money path. Production only escaped
//      it because the busiest caller used named PostgREST parameters, which
//      resolve by argument-name set instead.
//   2. The extra overload was also the WEAKER function: SECURITY INVOKER, no
//      metadata->>'ledger_type', and no balance guard. Anything that bound it
//      silently skipped the overdraft check added by
//      20260712160001000_atomic_use_credits_balance_guard.sql.
//
// 20260730012238065_credit_use_credits_single_overload.sql collapsed them, and
// 20260805175409752_credit_use_credits_idempotency.sql deliberately REPLACED the
// signature rather than overloading it. 20260925013304428_wallet_private_schema
// moved the body to kortix_wallet.debit_credits and left public.atomic_use_credits
// as a wrapper for one release. This test replays every CREATE/DROP of both
// names across the migration files in apply order and asserts that each
// surviving set has one member, and that the body carries the guard.
//
// Signature identity here is the ordered list of INPUT ARGUMENT TYPES, which is
// exactly how PostgreSQL identifies a function. Parameter names and DEFAULTs are
// not part of it — that is why the 5-arg (…, p_thread_id, p_message_id) overload
// and the 5-arg (…, p_ledger_type, p_idempotency_key) one are the same
// identity, and why the DROP in 20260805175409752 was required rather than
// optional.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../../../packages/db/migrations');
/** The compatibility name, kept until no deployed API image calls it. */
const WRAPPER = 'public.atomic_use_credits';
/** Where the arithmetic lives. */
const BODY = 'kortix_wallet.debit_credits';

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

function signaturesIn(sql: string, keyword: 'create' | 'drop', name: string): string[] {
  const escaped = name.replace('.', '\\.');
  const pattern =
    keyword === 'create'
      ? new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${escaped}\\s*\\(`, 'gi')
      : new RegExp(`DROP\\s+FUNCTION(?:\\s+IF\\s+EXISTS)?\\s+${escaped}\\s*\\(`, 'gi');

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

function replay(name: string): { live: Set<string>; touched: string[]; lastCreatedBy: string } {
  const live = new Set<string>();
  const touched: string[] = [];
  let lastCreatedBy = '';

  for (const file of migrationFiles()) {
    const sql = stripLineComments(readSql(file));
    const drops = signaturesIn(sql, 'drop', name);
    const creates = signaturesIn(sql, 'create', name);
    if (drops.length === 0 && creates.length === 0) continue;
    touched.push(file);
    for (const signature of drops) live.delete(signature);
    for (const signature of creates) live.add(signature);
    if (creates.length > 0) lastCreatedBy = file;
  }

  return { live, touched, lastCreatedBy };
}

/** The last shipped definition of `name`: from its CREATE to the end of its body. */
function currentDefinition(name: string): string {
  const sql = readSql(replay(name).lastCreatedBy);
  const start = sql.search(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`));
  const end = sql.indexOf('$function$;', start);
  if (start < 0 || end < 0) throw new Error(`no definition of ${name} found`);
  return sql.slice(start, end);
}

describe('debit function migration source', () => {
  test('the migrations actually define both names (the scan is not silently empty)', () => {
    const { touched } = replay(WRAPPER);
    expect(touched.length).toBeGreaterThanOrEqual(5);
    expect(touched).toContain('20260712160001000_atomic_use_credits_balance_guard.sql');
    expect(touched).toContain('20260730012238065_credit_use_credits_single_overload.sql');
    expect(touched).toContain('20260805175409752_credit_use_credits_idempotency.sql');
    expect(replay(BODY).touched).toContain('20260925013304428_wallet_private_schema.sql');
  });

  test('exactly ONE signature of each survives the full migration replay', () => {
    expect([...replay(WRAPPER).live].sort()).toEqual(['uuid,numeric,text,text,text']);
    expect([...replay(BODY).live].sort()).toEqual(['uuid,numeric,boolean,text,text,text']);
  });

  test('the baseline really did ship the two overlapping overloads this guards against', () => {
    const baseline = stripLineComments(readSql('20260621094136410_baseline.sql'));
    expect(signaturesIn(baseline, 'create', WRAPPER).sort()).toEqual([
      'uuid,numeric,text,text',
      'uuid,numeric,text,text,text',
    ]);
  });

  test('a new migration that adds a second overload would fail this test', () => {
    const hypothetical = new Set(replay(WRAPPER).live);
    for (const signature of signaturesIn(
      'CREATE OR REPLACE FUNCTION public.atomic_use_credits(p_account_id uuid, p_amount numeric)',
      'create',
      WRAPPER,
    )) {
      hypothetical.add(signature);
    }
    expect(hypothetical.size).toBe(2);
  });

  // Resolved from the replay, never hardcoded: a future migration that replaces
  // the function becomes the subject of these assertions automatically, so
  // dropping the guard on the way past fails here instead of shipping.
  test('the current wrapper delegates to the body with the floor enforced', () => {
    const wrapper = currentDefinition(WRAPPER);
    expect(wrapper).toContain(`SELECT ${BODY}(`);
    expect(wrapper).toContain('p_enforce_floor => true');
    expect(wrapper).toContain('SECURITY DEFINER');
    expect(wrapper).toContain("SET search_path TO ''");
  });

  test('the current body keeps the overdraft guard', () => {
    const body = currentDefinition(BODY);
    expect(body).toContain('IF v_floor AND v_total < p_amount THEN');
    expect(body).toContain("'Insufficient credits'");
    // A NULL floor argument enforces the floor.
    expect(body).toContain('v_floor boolean := p_enforce_floor IS NOT FALSE');
  });

  test('the current body takes the row lock BEFORE the overdraft guard runs', () => {
    const body = currentDefinition(BODY);
    const lockAt = body.indexOf('FOR UPDATE');
    const guardAt = body.indexOf('IF v_floor AND v_total < p_amount THEN');
    expect(lockAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(lockAt);
  });

  test('the current body pins its search_path', () => {
    expect(currentDefinition(BODY)).toContain("SET search_path TO ''");
  });

  test('the current body stamps the granular kind into metadata', () => {
    expect(currentDefinition(BODY)).toContain("'ledger_type', p_ledger_type");
  });
});
