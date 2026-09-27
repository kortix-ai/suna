import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  claimInitialTurnFromApi,
  publishInitialOpenCodeSessionAfterPrompt,
  reconcileInitialTurnAcceptanceToApi,
  relayInitialTurnAcceptedToApi,
  relayTurnBeginAfterInitialAcceptance,
  resetClaimedInitialTurnForTests,
} from '../harness/open-code/boot';
import type { OpenCodeBootState as SandboxBootState } from '../harness/open-code/boot-state';

const KEYS = [
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetClaimedInitialTurnForTests();
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  // Module-level state: clear it on the way OUT too, or the next file in this
  // bun process inherits it (see test-state-reset-tripwire.test.ts).
  resetClaimedInitialTurnForTests()
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('daemon-delivered initial turn lifecycle', () => {
  test('claims the first prompt with the single session credential', async () => {
    let observed: { authorization: string | null; body: unknown } | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        observed = {
          authorization: request.headers.get('authorization'),
          body: await request.json(),
        };
        return Response.json({
          ok: true,
          initial_turn: {
            prompt: 'private prompt',
            turn_token: 'turn-token',
            message_id: 'msg_initial',
          },
        });
      },
    });
    try {
      process.env.KORTIX_PROJECT_ID = 'project-1';
      process.env.KORTIX_SESSION_ID = 'session-1';
      process.env.KORTIX_TOKEN = 'session-token';
      process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}/v1`;

      expect(await claimInitialTurnFromApi()).toEqual({
        prompt: 'private prompt',
        turnToken: 'turn-token',
        messageId: 'msg_initial',
      });
      expect(observed as unknown).toEqual({
        authorization: 'Bearer session-token',
        body: { session_id: 'session-1', kind: 'initial_turn_claim' },
      });
    } finally {
      server.stop(true);
    }
  });

  test('retries a transient initial-turn claim failure', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        if (requests === 1) return Response.json({ error: 'temporary' }, { status: 503 });
        return Response.json({
          ok: true,
          initial_turn: {
            prompt: 'retry prompt',
            turn_token: 'retry-token',
            message_id: 'msg_retry',
          },
        });
      },
    });
    try {
      process.env.KORTIX_PROJECT_ID = 'project-1';
      process.env.KORTIX_SESSION_ID = 'session-1';
      process.env.KORTIX_TOKEN = 'session-token';
      process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}/v1`;

      expect(await claimInitialTurnFromApi()).toEqual({
        prompt: 'retry prompt',
        turnToken: 'retry-token',
        messageId: 'msg_retry',
      });
      expect(requests).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test('does not publish the root identity until OpenCode accepts the prompt', async () => {
    const bootState: SandboxBootState = {
      repoMaterializationError: null,
      timeline: [],
      initialOpenCodeSessionRequired: true,
      initialOpenCodeSessionId: null,
      initialOpenCodeSessionError: null,
    };
    let releaseDelivery: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });

    const publishing = publishInitialOpenCodeSessionAfterPrompt(
      bootState,
      'ses_root',
      async () => delivery,
    );
    await Bun.sleep(0);
    expect(bootState.initialOpenCodeSessionId).toBeNull();

    releaseDelivery?.();
    await publishing;
    expect(bootState.initialOpenCodeSessionId).toBe('ses_root');
  });

  test('promotes the pre-created token with the sandbox credential and stable identities', async () => {
    let observed: { authorization: string | null; body: Record<string, unknown> } | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        observed = {
          authorization: request.headers.get('authorization'),
          body: (await request.json()) as Record<string, unknown>,
        };
        return Response.json({ ok: true });
      },
    });
    try {
      process.env.KORTIX_PROJECT_ID = 'project-1';
      process.env.KORTIX_SESSION_ID = 'session-1';
      process.env.KORTIX_TOKEN = 'session-token';
      process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}/v1`;

      expect(await relayInitialTurnAcceptedToApi('ses_root', 'msg_initial', 'turn-token')).toBe(
        true,
      );
      expect(observed as unknown).toEqual({
        authorization: 'Bearer session-token',
        body: {
          session_id: 'session-1',
          kind: 'turn_accepted',
          opencode_session_id: 'ses_root',
          turn_message_id: 'msg_initial',
          turn_token: 'turn-token',
        },
      });
    } finally {
      server.stop(true);
    }
  });

  test('does not promote a new token from an older prompt on a reused root', async () => {
    const lifecycleRelays: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        // The routes the probe reads on OpenCode 1.18.23: `msg_new` was never
        // written to this root, so the by-id read is a 404 `NotFoundError`,
        // and an idle root is absent from `/session/status`.
        if (request.method === 'GET' && /\/message\/[^/]+$/.test(path)) {
          return Response.json(
            { name: 'NotFoundError', data: { message: 'Message not found: msg_new' } },
            { status: 404 },
          );
        }
        if (request.method === 'GET' && path.endsWith('/session/status')) {
          return Response.json({});
        }
        if (request.method === 'GET') {
          return Response.json([
            { info: { id: 'msg_older', role: 'user' } },
            {
              info: {
                id: 'msg_assistant',
                role: 'assistant',
                parentID: 'msg_older',
                time: { completed: 1234 },
              },
            },
          ]);
        }
        lifecycleRelays.push((await request.json()) as Record<string, unknown>);
        return Response.json({ ok: true });
      },
    });
    try {
      process.env.KORTIX_PROJECT_ID = 'project-1';
      process.env.KORTIX_SESSION_ID = 'session-1';
      process.env.KORTIX_TOKEN = 'sandbox-token';
      process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}/v1`;

      expect(
        await reconcileInitialTurnAcceptanceToApi(
          `http://127.0.0.1:${server.port}`,
          '/workspace',
          'ses_reused',
          'msg_new',
          'turn-token',
        ),
      ).toBe('inactive');
      expect(lifecycleRelays).toEqual([
        {
          session_id: 'session-1',
          kind: 'turn_abandoned',
          turn_token: 'turn-token',
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test('promotes only when the exact initial message is still in flight', async () => {
    let acceptanceRelays = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === 'GET') {
          if (new URL(request.url).pathname === '/session/status') {
            return Response.json({ ses_root: { type: 'busy' } });
          }
          return Response.json([{ info: { id: 'msg_initial', role: 'user' } }]);
        }
        acceptanceRelays += 1;
        return Response.json({ ok: true });
      },
    });
    try {
      process.env.KORTIX_PROJECT_ID = 'project-1';
      process.env.KORTIX_SESSION_ID = 'session-1';
      process.env.KORTIX_TOKEN = 'sandbox-token';
      process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}/v1`;

      expect(
        await reconcileInitialTurnAcceptanceToApi(
          `http://127.0.0.1:${server.port}`,
          '/workspace',
          'ses_root',
          'msg_initial',
          'turn-token',
        ),
      ).toBe('accepted');
      expect(acceptanceRelays).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  // OpenCode's prompt_async answers 204 before it writes the user message and
  // before its loop marks the root busy (1.18.23: absent at +11 ms, busy at
  // +308 ms). Boot reconciles right after delivery, so both shapes are the
  // normal start of a first turn. Reading them as abandoned stripped the turn
  // authority from ~99% of session-creating first turns on prod (2026-08-19
  // onward), so the stale-turn sweeps and the inbox saw a running turn as idle.
  describe('a first prompt this boot delivered and OpenCode has not picked up yet', () => {
    type Stage = 'absent' | 'unanswered' | 'busy';
    const pickupServer = (relays: Array<Record<string, unknown>>, stage: () => Stage) =>
      Bun.serve({
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (request.method === 'GET') {
            if (path === '/session/status') {
              return Response.json(stage() === 'busy' ? { ses_root: { type: 'busy' } } : {});
            }
            if (/\/message\/[^/]+$/.test(path)) {
              return Response.json({ name: 'NotFoundError' }, { status: 404 });
            }
            return Response.json(
              stage() === 'absent' ? [] : [{ info: { id: 'msg_initial', role: 'user' } }],
            );
          }
          relays.push((await request.json()) as Record<string, unknown>);
          return Response.json({ ok: true });
        },
      });

    const reconcileAgainst = (port: number | undefined, options?: { awaitingPickup?: boolean }) => {
      process.env.KORTIX_PROJECT_ID = 'project-1';
      process.env.KORTIX_SESSION_ID = 'session-1';
      process.env.KORTIX_TOKEN = 'sandbox-token';
      process.env.KORTIX_API_URL = `http://127.0.0.1:${port}/v1`;
      return reconcileInitialTurnAcceptanceToApi(
        `http://127.0.0.1:${port}`,
        '/workspace',
        'ses_root',
        'msg_initial',
        'turn-token',
        options,
      );
    };

    test('is unknown while absent or unanswered, then promoted once the root goes busy', async () => {
      const relays: Array<Record<string, unknown>> = [];
      let stage: Stage = 'absent';
      const server = pickupServer(relays, () => stage);
      try {
        expect(await reconcileAgainst(server.port, { awaitingPickup: true })).toBe('unknown');
        stage = 'unanswered';
        expect(await reconcileAgainst(server.port, { awaitingPickup: true })).toBe('unknown');
        expect(relays).toEqual([]);

        stage = 'busy';
        expect(await reconcileAgainst(server.port, { awaitingPickup: true })).toBe('accepted');
        expect(relays).toEqual([
          {
            session_id: 'session-1',
            kind: 'turn_accepted',
            opencode_session_id: 'ses_root',
            turn_message_id: 'msg_initial',
            turn_token: 'turn-token',
          },
        ]);
      } finally {
        server.stop(true);
      }
    });

    test('is abandoned once the pickup grace is over', async () => {
      for (const stage of ['absent', 'unanswered'] as const) {
        const relays: Array<Record<string, unknown>> = [];
        const server = pickupServer(relays, () => stage);
        try {
          expect(await reconcileAgainst(server.port, { awaitingPickup: false })).toBe('inactive');
          expect(relays).toEqual([
            { session_id: 'session-1', kind: 'turn_abandoned', turn_token: 'turn-token' },
          ]);
        } finally {
          server.stop(true);
        }
      }
    });

    test('delivery records when this boot delivered the prompt', async () => {
      const bootState = { timeline: [] } as unknown as SandboxBootState;
      const before = Date.now();
      await publishInitialOpenCodeSessionAfterPrompt(bootState, 'ses_root', async () => {});
      expect(bootState.initialPromptDeliveredAtMs).toBeGreaterThanOrEqual(before);
      expect(bootState.initialOpenCodeSessionId).toBe('ses_root');
    });
  });

  // The ledger has no row for the first message until acceptance, so a
  // `turn_begin` for it would be adopted under a second token.
  describe('a busy frame while the first turn is unaccepted', () => {
    test('promotes the pending first turn before any turn_begin', async () => {
      const calls: string[] = [];
      let pending = true;
      const outcome = await relayTurnBeginAfterInitialAcceptance({
        initialAcceptancePending: () => pending,
        reconcileInitialAcceptance: async () => {
          calls.push('reconcile');
          pending = false;
        },
        relayTurnBegin: async () => {
          calls.push('turn_begin');
        },
      });
      expect(outcome).toBe('relayed');
      expect(calls).toEqual(['reconcile', 'turn_begin']);
    });

    test('sends no turn_begin while the first turn is still unsettled', async () => {
      const calls: string[] = [];
      const outcome = await relayTurnBeginAfterInitialAcceptance({
        initialAcceptancePending: () => true,
        reconcileInitialAcceptance: async () => {
          calls.push('reconcile');
        },
        relayTurnBegin: async () => {
          calls.push('turn_begin');
        },
      });
      expect(outcome).toBe('deferred');
      expect(calls).toEqual(['reconcile']);
    });

    test('relays turn_begin directly for every later turn', async () => {
      const calls: string[] = [];
      await relayTurnBeginAfterInitialAcceptance({
        initialAcceptancePending: () => false,
        reconcileInitialAcceptance: async () => {
          calls.push('reconcile');
        },
        relayTurnBegin: async () => {
          calls.push('turn_begin');
        },
      });
      expect(calls).toEqual(['turn_begin']);
    });
  });

  test('requires the complete session relay context', async () => {
    process.env.KORTIX_PROJECT_ID = 'project-1';
    delete process.env.KORTIX_SESSION_ID;
    process.env.KORTIX_TOKEN = 'session-token';
    process.env.KORTIX_API_URL = 'http://127.0.0.1:1/v1';

    await expect(
      relayInitialTurnAcceptedToApi('ses_root', 'msg_initial', 'turn-token'),
    ).rejects.toThrow('initial turn acceptance relay context is unavailable');
  });
});
