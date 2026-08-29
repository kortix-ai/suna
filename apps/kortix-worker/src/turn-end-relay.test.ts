import { describe, expect, test } from 'bun:test';

import {
  buildTurnEndRelay,
  scheduleBootReconcile,
  turnEndPayload,
  turnEndUrl,
  type TurnEndStatus,
} from './turn-end-relay';

/**
 * Measured on `pi.kortix.com` 2026-08-29, four sessions sampled through the
 * live API:
 *
 *   AGENT OK       3 turn rows — 3 still `active`, oldest 15:44 (39 min old)
 *   PER AGENT OK   1 turn row  — 1 still `active`
 *   hey kortix     4 turn rows — 4 still `active`, oldest 15:16 (67 min old)
 *   cold start     1 turn row  — 1 still `active`
 *
 * Nine rows, nine `active`, zero `ended`. No turn on that environment had ever
 * been closed.
 *
 * Cause: the sandbox daemon relays turn end from OpenCode's NATIVE `/event`
 * stream (`startOpencodeEventLoop`, `opencode.getInternalUrl()/event`). The pi
 * worker does not serve that surface — it serves the Kortix Runtime API at
 * `/kortix/opencode/*` — so `onSessionIdle` never fires for a pi session and
 * `relayTurnEndToApi` is never reached. The worker is the only process that
 * knows its own turn ended, so the relay belongs here.
 *
 * Consequences of a row that never closes, beyond the visible one:
 *  - `serverOpenTurnToken` stays non-null, so the composer holds `/` commands
 *    and shows Stop over a finished turn;
 *  - the transcript paints "Gathering thoughts…" until the runtime's own idle
 *    frame vetoes the read;
 *  - `box-reaper` only clears an unobservable turn past `deadlineAt`, which is
 *    `KORTIX_SANDBOX_TURN_GRANT_MINUTES` — 240 by default — so sandboxes stay
 *    alive for hours after their work is done.
 */

const cfg = {
  apiUrl: 'https://api.example.test/v1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  kortixToken: 'tok-1',
};

describe('turnEndUrl', () => {
  test('targets the project turn-stream route the API actually serves', () => {
    expect(turnEndUrl('https://api.example.test/v1', 'proj-1')).toBe(
      'https://api.example.test/v1/projects/proj-1/turn-stream',
    );
  });

  test('tolerates a trailing slash on the API root', () => {
    expect(turnEndUrl('https://api.example.test/v1/', 'proj-1')).toBe(
      'https://api.example.test/v1/projects/proj-1/turn-stream',
    );
  });

  test('encodes the project id', () => {
    expect(turnEndUrl('https://x.test', 'a/b')).toBe('https://x.test/projects/a%2Fb/turn-stream');
  });
});

describe('turnEndPayload', () => {
  test('sends the kind and status the API branches on', () => {
    // `r4.ts` accepts `kind: 'end' | 'turn_end'` and reads `status` as
    // 'error' | anything-else-means-idle.
    expect(turnEndPayload({ sessionId: 'sess-1', status: 'idle' })).toEqual({
      session_id: 'sess-1',
      kind: 'turn_end',
      status: 'idle',
    });
  });

  test('carries an error status through', () => {
    expect(turnEndPayload({ sessionId: 'sess-1', status: 'error' })).toMatchObject({
      status: 'error',
    });
  });

  // 2026-08-30, pi.kortix.com, session 6afb4e2d: a FRESH sandbox running the
  // deployed relay answered its prompt, POSTed turn_end, got HTTP 200 — and the
  // row stayed `active`. The live `activeTurns` entry read
  //   { messageId: 'msg_01a04fa487a1...', opencodeSessionId: 'ses_pib78964...' }
  // while the payload named neither, so `completeSandboxTurn`'s candidate CTE
  // (`opencodeSessionId IS NULL OR = reported`) selected nothing. A relay that
  // does not say WHICH turn ended closes none of them and still reads as
  // success.
  test('THE FIX: names the turn, because the API selects the row by identity', () => {
    expect(
      turnEndPayload({
        sessionId: 'sess-1',
        status: 'idle',
        identity: { opencodeSessionId: 'ses_pi123', messageId: 'msg_abc' },
      }),
    ).toEqual({
      session_id: 'sess-1',
      kind: 'turn_end',
      status: 'idle',
      opencode_session_id: 'ses_pi123',
      turn_message_id: 'msg_abc',
    });
  });

  test('omits an unknown id rather than sending null, which the API reads as absent', () => {
    expect(
      turnEndPayload({ sessionId: 'sess-1', status: 'idle', identity: { opencodeSessionId: 'ses_pi123', messageId: null } }),
    ).toEqual({
      session_id: 'sess-1',
      kind: 'turn_end',
      status: 'idle',
      opencode_session_id: 'ses_pi123',
    });
  });
});

describe('buildTurnEndRelay', () => {
  test('THE FIX: an agent turn end posts turn_end to the control plane', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const relay = buildTurnEndRelay({
      ...cfg,
      fetch: (async (url: any, init: any) => {
        calls.push({
          url: String(url),
          body: JSON.parse(init.body),
          auth: init.headers?.Authorization ?? null,
        });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });

    await relay('idle');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.test/v1/projects/proj-1/turn-stream');
    expect(calls[0].auth).toBe('Bearer tok-1');
    expect(calls[0].body).toEqual({ session_id: 'sess-1', kind: 'turn_end', status: 'idle' });
  });

  test('puts the turn identity on the wire', async () => {
    let body: any = null;
    const relay = buildTurnEndRelay({
      ...cfg,
      fetch: (async (_url: any, init: any) => {
        body = JSON.parse(init.body);
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });

    await relay('idle', { opencodeSessionId: 'ses_pi999', messageId: 'msg_zzz' });

    expect(body).toMatchObject({ opencode_session_id: 'ses_pi999', turn_message_id: 'msg_zzz' });
  });

  test('retries a network failure, because a lost end leaves the row open for hours', async () => {
    let attempts = 0;
    const relay = buildTurnEndRelay({
      ...cfg,
      waitMs: async () => {},
      fetch: (async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('network down');
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    });

    await relay('idle');
    expect(attempts).toBe(3);
  });

  test('stops on ANY ok response — a non-ok 4xx is a definitive answer, not a retry', async () => {
    // Mirrors the daemon's own rule: apps/api answering "already finalized" is
    // an answer. Only network/5xx failures are worth another attempt.
    let attempts = 0;
    const relay = buildTurnEndRelay({
      ...cfg,
      waitMs: async () => {},
      fetch: (async () => {
        attempts += 1;
        return { ok: false, status: 409 } as Response;
      }) as unknown as typeof fetch,
    });

    await relay('idle');
    expect(attempts).toBe(1);
  });

  test('gives up after its budget rather than retrying forever', async () => {
    let attempts = 0;
    const relay = buildTurnEndRelay({
      ...cfg,
      waitMs: async () => {},
      fetch: (async () => {
        attempts += 1;
        throw new Error('still down');
      }) as unknown as typeof fetch,
    });

    await relay('idle');
    expect(attempts).toBe(4);
  });

  test('never throws — a failed relay must not take the turn down with it', async () => {
    const relay = buildTurnEndRelay({
      ...cfg,
      waitMs: async () => {},
      fetch: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    });
    await expect(relay('idle')).resolves.toBeUndefined();
  });

  test('is inert when the platform did not inject the wiring', async () => {
    // The bench runs the worker with no control plane at all. It must not
    // attempt a relay, and must not crash for the lack of one.
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    for (const missing of ['apiUrl', 'projectId', 'sessionId', 'kortixToken'] as const) {
      const relay = buildTurnEndRelay({ ...cfg, [missing]: undefined, fetch: spyFetch });
      await relay('idle');
    }
    expect(called).toBe(false);
  });
});

/**
 * The second half, and the one that fixes what a user actually sees.
 *
 * `buildTurnEndRelay` closes turns GOING FORWARD. It cannot touch a row that
 * was already stuck when it shipped — and on pi.kortix.com every session had
 * one, so re-entering any existing session still painted "Gathering thoughts…"
 * over a finished answer with the composer on Stop.
 *
 * A worker boots whenever a parked session is opened, and at that instant it is
 * provably running no turn: its messages were restored from the durable store
 * as history. That is the moment to tell the control plane the session is idle,
 * which closes whatever row a previous process left behind.
 *
 * The race it must not lose: a prompt delivered immediately after boot starts a
 * REAL turn, and closing that row would report a running turn as finished. So
 * the reconcile waits a beat and stands down entirely if a turn started.
 */
describe('scheduleBootReconcile', () => {
  const base = {
    apiUrl: 'https://api.example.test/v1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    kortixToken: 'tok-1',
  };

  test('closes a row left open by a previous process', async () => {
    const sent: string[] = [];
    const relay = async (status: TurnEndStatus) => void sent.push(status);
    const reconcile = scheduleBootReconcile({ relay, delayMs: 0, wait: async () => {} });
    await reconcile.run();
    expect(sent).toEqual(['idle']);
  });

  test('THE RACE: stands down when a turn started during the delay', async () => {
    const sent: string[] = [];
    const relay = async (status: TurnEndStatus) => void sent.push(status);
    const reconcile = scheduleBootReconcile({ relay, delayMs: 0, wait: async () => {} });
    // A prompt landed and the agent began work before the reconcile fired.
    reconcile.noteTurnStarted();
    await reconcile.run();
    expect(sent).toEqual([]);
  });

  test('fires at most once, however many times it is run', async () => {
    const sent: string[] = [];
    const relay = async (status: TurnEndStatus) => void sent.push(status);
    const reconcile = scheduleBootReconcile({ relay, delayMs: 0, wait: async () => {} });
    await reconcile.run();
    await reconcile.run();
    expect(sent).toEqual(['idle']);
  });

  test('a turn that starts AFTER the reconcile already fired does not re-arm it', async () => {
    const sent: string[] = [];
    const relay = async (status: TurnEndStatus) => void sent.push(status);
    const reconcile = scheduleBootReconcile({ relay, delayMs: 0, wait: async () => {} });
    await reconcile.run();
    reconcile.noteTurnStarted();
    await reconcile.run();
    expect(sent).toEqual(['idle']);
  });

  test('waits before firing, so an immediate prompt wins the race', async () => {
    const waits: number[] = [];
    const relay = async () => {};
    const reconcile = scheduleBootReconcile({
      relay,
      delayMs: 1500,
      wait: async (ms: number) => void waits.push(ms),
    });
    await reconcile.run();
    expect(waits).toEqual([1500]);
  });
});
