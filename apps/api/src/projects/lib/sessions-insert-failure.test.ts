/**
 * A failed `project_sessions` insert must never leak its postgres.js error
 * message to the client.
 *
 * postgres.js puts the FULL SQL statement and EVERY bound parameter value into
 * `error.message` ("Failed query: insert into … params: …"). The session-create
 * `catch` returned that message as the 500 body, so the web SDK threw an
 * `ApiError` carrying attachment filenames, model config and opaque ids, and
 * reported it to Better Stack (pattern `9aecd4f8…`). The real cause was never
 * logged. `resolveSessionInsertFailure` fixes both halves: it logs the cause
 * server-side and returns a stable, non-leaking body.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { resolveSessionInsertFailure } from './sessions';

const SQL_LEAK =
  'insert into "kortix"."project_sessions" ("session_id", "metadata") values ($1, $2)';
const PARAM_LEAK =
  'params: 11111111-2222-3333-4444-555555555555,{"attachment_names":["private-customer-file.docx"]}';

let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('resolveSessionInsertFailure', () => {
  test('a raw postgres.js message is logged server-side but never returned to the client', () => {
    const raw = Object.assign(new Error(`Failed query: ${SQL_LEAK}\n${PARAM_LEAK}`), {
      code: '42P01',
    });

    const mapped = resolveSessionInsertFailure(raw);

    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: 'Failed to create session',
      code: 'SESSION_CREATE_FAILED',
      retry: true,
    });

    const serialized = JSON.stringify(mapped.body);
    expect(serialized).not.toContain('insert into');
    expect(serialized).not.toContain('params:');
    expect(serialized).not.toContain('private-customer-file.docx');
    expect(serialized).not.toContain(SQL_LEAK);

    // The cause stays observable, but the bound parameter values are dropped
    // from the server log too (postgres.js appends them after "\nparams:").
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0] as unknown[];
    expect(logged[0]).toBe('[projects] session insert failed');
    expect(logged[1]).toMatchObject({
      pgCode: '42P01',
      message: expect.stringContaining(SQL_LEAK),
    });
    expect(JSON.stringify(logged[1])).not.toContain('private-customer-file.docx');
  });

  test('a unique violation on the session PK maps to a typed 409', () => {
    const raw = Object.assign(
      new Error('Failed query: insert into "kortix"."project_sessions" …'),
      {
        code: '23505',
        constraint: 'project_sessions_pkey',
      },
    );

    const mapped = resolveSessionInsertFailure(raw);

    expect(mapped.status).toBe(409);
    expect(mapped.body).toEqual({
      error: 'A session with this id already exists',
      code: 'session_already_exists',
    });
    expect(JSON.stringify(mapped.body)).not.toContain('insert into');
  });

  test('a non-Error value still yields the stable body and is logged', () => {
    const mapped = resolveSessionInsertFailure('boom');

    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({
      error: 'Failed to create session',
      code: 'SESSION_CREATE_FAILED',
      retry: true,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
