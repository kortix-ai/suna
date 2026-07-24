// The CLI mints one stable Idempotency-Key per logical prompt and threads it to
// the delivery POST, so the SERVER proxy can dedupe its own 502/timeout retries
// instead of enqueueing the user's message twice. The CLI itself never retries;
// the key's only job is server-side dedupe. These tests pin that sendPrompt
// attaches the header to the prompt_async delivery POST and that ordinary (GET)
// reads don't.
//
// main's sendPrompt submits via `prompt_async` (a POST that returns immediately)
// then POLLS `/session/:id/message` + `/session/status` for the completed reply,
// so a successful call makes several fetches. The stub below is URL-aware: it
// accepts the delivery POST, echoes back a completed assistant reply parented to
// the generated messageID, and reports the session idle — so sendPrompt resolves
// and we can assert on the delivery POST specifically rather than a fetch count.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { opencodeClient } from '../api/sandbox-proxy.ts';

const ORIGINAL_FETCH = globalThis.fetch;

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
}
let captured: Captured[] = [];

function stubFetch() {
  captured = [];
  let deliveredMessageId: string | undefined;
  (globalThis as { fetch: unknown }).fetch = async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
    const method = i.method ?? 'GET';
    const u = String(url);
    captured.push({
      url: u,
      method,
      headers: (i.headers ?? {}) as Record<string, string>,
    });
    // Delivery POST: accept it, remember the client-generated messageID so the
    // polled reply below can parent itself to this turn.
    if (u.includes('/prompt_async')) {
      try {
        deliveredMessageId = (JSON.parse(i.body ?? '{}') as { messageID?: string }).messageID;
      } catch {
        /* ignore */
      }
      return new Response(null, { status: 200 });
    }
    // Session status map: empty ⇒ the session is idle (sendPrompt returns).
    if (u.includes('/session/status')) {
      return new Response('{}', { status: 200 });
    }
    // Message list poll: one completed assistant reply for the delivered turn.
    if (/\/session\/[^/]+\/message(?:$|[/?])/.test(u)) {
      return new Response(
        JSON.stringify([
          {
            info: {
              id: 'a-1',
              role: 'assistant',
              sessionID: 'oc-sess',
              parentID: deliveredMessageId,
              time: { created: 1, completed: 2 },
              finish: 'stop',
            },
            parts: [{ type: 'text', text: 'ok' }],
          },
        ]),
        { status: 200 },
      );
    }
    // Anything else (e.g. listSessions) → empty array.
    return new Response('[]', { status: 200 });
  };
}

const auth = {
  api_base: 'https://api.test',
  token: 'tok_test',
  user_id: 'u1',
  user_email: 'u@test',
  account_id: 'a1',
  logged_in_at: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

function deliveryPost(): Captured | undefined {
  return captured.find((c) => c.method === 'POST' && c.url.includes('/prompt_async'));
}

describe('sendPrompt idempotency key', () => {
  test('attaches the supplied Idempotency-Key header to the delivery POST', async () => {
    stubFetch();
    const oc = opencodeClient({ auth, sandboxId: 'sb-1' });
    await oc.sendPrompt('oc-sess', [{ type: 'text', text: 'hi' }], undefined, undefined, 'idem-abc-123');
    const post = deliveryPost();
    expect(post).toBeDefined();
    expect(post!.headers['Idempotency-Key']).toBe('idem-abc-123');
  });

  test('omits the header when no key is supplied (and on ordinary GET reads)', async () => {
    stubFetch();
    const oc = opencodeClient({ auth, sandboxId: 'sb-1' });
    await oc.sendPrompt('oc-sess', [{ type: 'text', text: 'hi' }]);
    await oc.listSessions();
    // No request — the delivery POST, the polls, or the GET — carries the header.
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect('Idempotency-Key' in c.headers).toBe(false);
    }
  });
});
