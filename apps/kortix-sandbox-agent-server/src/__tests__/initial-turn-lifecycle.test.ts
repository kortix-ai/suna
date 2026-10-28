import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { claimInitialTurn, claimedRuntimeSessionPin, relayTurnAccepted, resetInitialTurnClaimForTests } from '@/harness/shared/turn-relay';

const KEYS = [
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetInitialTurnClaimForTests();
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  // Module-level state: clear it on the way OUT too, or the next file in this
  // bun process inherits it (see test-state-reset-tripwire.test.ts).
  resetInitialTurnClaimForTests()
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Every fake server binds 127.0.0.1, the address the code under test calls. On
// macOS a wildcard port-0 bind can share its port with another process's
// 127.0.0.1 listener, and the fetch then reaches that process instead.
describe('daemon-delivered initial turn lifecycle', () => {
  test('claims the first prompt with the single session credential', async () => {
    let observed: { authorization: string | null; body: unknown } | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        observed = {
          authorization: request.headers.get('authorization'),
          body: await request.json(),
        };
        return Response.json({
          ok: true,
          initial_turn: {
            prompt: 'private prompt',
            context: '--- session contract ---',
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

      expect(await claimInitialTurn()).toEqual({
        prompt: 'private prompt',
        context: '--- session contract ---',
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

  // A box without a local pin file must resume the root the control plane
  // pinned, not adopt or create another (prod 2026-09-23: a converged legacy
  // box created an empty root and the session opened blank).
  test('records the durable root pin even when no prompt is pending', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        return Response.json({ ok: true, initial_turn: null, runtime_session_id: 'ses_durable', opencode_session_id: 'ses_durable' });
      },
    });
    try {
      process.env.KORTIX_PROJECT_ID = 'project-1';
      process.env.KORTIX_SESSION_ID = 'session-1';
      process.env.KORTIX_TOKEN = 'session-token';
      process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}/v1`;

      expect(claimedRuntimeSessionPin()).toBeNull();
      expect(await claimInitialTurn()).toBeNull();
      expect(claimedRuntimeSessionPin()).toBe('ses_durable');
    } finally {
      server.stop(true);
    }
  });

  test('an API that predates the pin field leaves no durable pin', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        return Response.json({ ok: true, initial_turn: null });
      },
    });
    try {
      process.env.KORTIX_PROJECT_ID = 'project-1';
      process.env.KORTIX_SESSION_ID = 'session-1';
      process.env.KORTIX_TOKEN = 'session-token';
      process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}/v1`;

      expect(await claimInitialTurn()).toBeNull();
      expect(claimedRuntimeSessionPin()).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test('retries a transient initial-turn claim failure', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
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

      expect(await claimInitialTurn()).toEqual({
        prompt: 'retry prompt',
        turnToken: 'retry-token',
        messageId: 'msg_retry',
      });
      expect(requests).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test('promotes the pre-created token with the sandbox credential and stable identities', async () => {
    let observed: { authorization: string | null; body: Record<string, unknown> } | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
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

      expect(await relayTurnAccepted('ses_root', 'msg_initial', 'turn-token')).toBe(
        true,
      );
      expect(observed as unknown).toEqual({
        authorization: 'Bearer session-token',
        body: {
          session_id: 'session-1',
          kind: 'turn_accepted',
          runtime_session_id: 'ses_root',
          turn_message_id: 'msg_initial',
          turn_token: 'turn-token',
        },
      });
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
      relayTurnAccepted('ses_root', 'msg_initial', 'turn-token'),
    ).rejects.toThrow('initial turn acceptance relay context is unavailable');
  });
});
