import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  claimInitialTurnFromApi,
  publishInitialOpenCodeSessionAfterPrompt,
  reconcileInitialTurnAcceptanceToApi,
  relayInitialTurnAcceptedToApi,
  resetClaimedInitialTurnForTests,
} from '../main';
import { type SandboxBootState, resolveTurnObservationIdentity } from '../routes/health';

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

  test('uses the pinned root for exact recovery when prompt delivery times out ambiguously', () => {
    expect(resolveTurnObservationIdentity(undefined, 'msg_initial', 'ses_pinned')).toEqual({
      sessionId: 'ses_pinned',
      messageId: 'msg_initial',
    });
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
