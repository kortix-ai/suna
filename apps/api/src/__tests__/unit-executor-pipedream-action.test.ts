/**
 * The Pipedream Connect `actions/run` wire format — specifically the
 * `configured_props` binding. Mocks global fetch (OAuth mint + actions/run) so
 * we assert exactly what we send. The account selector (keyed by the app slug,
 * e.g. `gmail`) MUST resolve to `{ authProvisionId }` and MUST NOT be
 * overwritable by a stray same-named arg — otherwise Pipedream can't resolve
 * the connected account and returns empty data (the "can't find any" bug).
 * Docs: https://pipedream.com/docs/connect/api-reference/run-action
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runPipedreamAction } from '../executor/pipedream';

const PD_PROJECT = process.env.PIPEDREAM_PROJECT_ID!;

interface Captured { url: string; method: string; body?: string }

const realFetch = globalThis.fetch;
let calls: Captured[];
let runResponse: { status: number; body: string };

beforeEach(() => {
  calls = [];
  runResponse = { status: 200, body: JSON.stringify({ ret: { messages: [{ id: 'm1' }] } }) };
  globalThis.fetch = (async (url: string, init: any) => {
    const u = String(url);
    if (u.includes('/v1/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'pd_tok', expires_in: 3600 }), { status: 200 });
    }
    calls.push({ url: u, method: init.method, body: init.body });
    return new Response(runResponse.body, { status: runResponse.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('actions/run configured_props', () => {
  test('binds the account by authProvisionId under the app slug and returns ret', async () => {
    const res = await runPipedreamAction(
      'proj-x', 'gmail', 'gmail', 'gmail-find-email',
      { q: 'is:unread', withTextPayload: true },
      'apn_acct123', 'user-7',
    );
    expect(res).toEqual({ status: 200, ok: true, data: { messages: [{ id: 'm1' }] } });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(`https://api.pipedream.com/v1/connect/${PD_PROJECT}/actions/run`);
    const body = JSON.parse(c.body!);
    expect(body.id).toBe('gmail-find-email');
    expect(body.external_user_id).toBe('proj-x:gmail:user-7');
    expect(body.configured_props.gmail).toEqual({ authProvisionId: 'apn_acct123' });
    expect(body.configured_props.q).toBe('is:unread');
    expect(body.configured_props.withTextPayload).toBe(true);
  });

  test('a stray arg named like the app slug CANNOT clobber the credential binding', async () => {
    // This is exactly what the agent did when the selector leaked into the schema:
    // it passed `gmail: "me"`. The binding must still win.
    await runPipedreamAction(
      'proj-x', 'gmail', 'gmail', 'gmail-find-email',
      { gmail: 'me', q: 'x' },
      'apn_acct123', null,
    );
    const body = JSON.parse(calls[0]!.body!);
    expect(body.configured_props.gmail).toEqual({ authProvisionId: 'apn_acct123' }); // NOT "me"
    expect(body.external_user_id).toBe('proj-x:gmail'); // shared (no user)
  });

  test('a Pipedream action error (HTTP 200 with an `error`/`os` body) surfaces as ok:false — NOT empty data', async () => {
    // Pipedream returns 200 even when the action threw; the failure is in `error`
    // + an `os` log entry. The old code returned `exports` ({}) as fake success.
    runResponse = { status: 200, body: JSON.stringify({
      os: [{ ts: 1, k: 'error', err: { name: 'TypeError', message: "Cannot read properties of undefined (reading 'oauth_access_token')" } }],
      exports: {},
      error: { name: 'TypeError', message: "Cannot read properties of undefined (reading 'oauth_access_token')" },
    }) };
    const res = await runPipedreamAction('p', 'google_calendar', 'google_calendar', 'google_calendar-list-calendars', {}, 'apn_1');
    expect(res.ok).toBe(false);
    expect(String(res.data)).toContain('oauth_access_token'); // real cause, not {}
  });

  test('upstream failure surfaces as ok:false', async () => {
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'pd_tok', expires_in: 3600 }), { status: 200 });
      }
      return new Response('boom', { status: 500 });
    }) as typeof fetch;
    const res = await runPipedreamAction('p', 'gmail', 'gmail', 'gmail-find-email', {}, 'apn_1');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
  });
});
