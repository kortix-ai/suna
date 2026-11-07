/**
 * The playground's per-model catch never echoes a database error's message
 * to the client (KRTX-4400). `recordGatewayUsage`/`persistGatewayTrace` can
 * reject with a `DrizzleQueryError`/`PostgresError` whose message is the
 * whole generated SQL statement plus its bound parameters. That catch sits
 * inside `Promise.all`, outside the route's own try/catch, so it never
 * reaches the global handler that already turns an uncaught database error
 * into a generic 500 (`shared/http-errors.ts`) — a crafted `model` value that
 * made the write fail would otherwise return the raw statement straight to
 * an authenticated caller: a SQL error oracle.
 */
import { describe, expect, test } from 'bun:test';
import { playgroundModelError } from './gateway-playground';

describe('playgroundModelError', () => {
  test('a database error never echoes its message', () => {
    class PostgresError extends Error {
      override name = 'PostgresError';
    }
    const err = new PostgresError(
      'insert into usage_events (account_id, project_id, model, ...) values ($1, $2, $3, ...) - duplicate key value violates unique constraint "usage_events_request_id_key"',
    );
    expect(playgroundModelError(err, 'claude-sonnet-4.6')).toBe('Request failed');
  });

  test('a DrizzleQueryError-shaped error (name only, no driver import) never echoes its message', () => {
    // Mirrors drizzle-orm's DrizzleQueryError shape without importing the
    // class: isDatabaseError also matches on `name === 'PostgresError'` in
    // the cause chain, which is what a raw postgres.js rejection carries.
    const cause = new Error('syntax error at or near "\'"');
    (cause as Error & { name: string }).name = 'PostgresError';
    const err = new Error('Failed query: insert into usage_events ...', { cause });
    expect(playgroundModelError(err, "bad'model")).toBe('Request failed');
  });

  test('a typed, non-database error still echoes its own message', () => {
    const err = new Error('No upstream configured for this model');
    expect(playgroundModelError(err, 'unknown-model')).toBe('No upstream configured for this model');
  });

  test('a non-Error throw falls back to the generic message', () => {
    expect(playgroundModelError('boom', 'claude-sonnet-4.6')).toBe('Request failed');
  });
});
