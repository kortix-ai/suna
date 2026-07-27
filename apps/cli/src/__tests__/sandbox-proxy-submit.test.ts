/**
 * `submitPrompt` is what makes the prompt line come back in one round trip.
 * `sendPrompt` (submit-and-block-to-idle) must stay exactly as it was for the
 * one-shot `--prompt` path.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import type { Auth } from '../api/auth.ts';
import { opencodeClient } from '../api/sandbox-proxy.ts';

const SESSION_ID = 'ses_submit';

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

function auth(): Auth {
  return {
    api_base: `http://127.0.0.1:${server!.port}`,
    token: 'kortix_pat_test',
    user_id: 'user_test',
    user_email: 'test@kortix.local',
    account_id: 'account_test',
    logged_in_at: '2026-07-27T00:00:00.000Z',
  };
}

describe('opencodeClient.submitPrompt', () => {
  test('posts prompt_async once, forwards the idempotency key, and reads no messages', async () => {
    const requests: Array<{ method: string; path: string; idempotency: string | null }> = [];
    let body: Record<string, unknown> = {};
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push({
          method: req.method,
          path: url.pathname,
          idempotency: req.headers.get('idempotency-key'),
        });
        if (url.pathname.endsWith('/prompt_async')) {
          body = (await req.json()) as Record<string, unknown>;
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      },
    });

    const oc = opencodeClient({ auth: auth(), sandboxId: 'sbx-1', port: 8000 });
    const messageID = await oc.submitPrompt(
      SESSION_ID,
      [{ type: 'text', text: 'hello' }],
      { agent: 'kortix-agi' },
      'idem-1',
    );

    expect(requests).toEqual([
      {
        method: 'POST',
        path: `/v1/p/sbx-1/8000/session/${SESSION_ID}/prompt_async`,
        idempotency: 'idem-1',
      },
    ]);
    // No message read at all — the turn is observed over SSE instead.
    expect(requests.some((r) => r.method === 'GET')).toBe(false);
    expect(body.messageID).toBe(messageID);
    expect(messageID.startsWith('msg_')).toBe(true);
    expect(body.agent).toBe('kortix-agi');
  });

  test('a lost 204 is not re-enqueued — the accepted message id settles it', async () => {
    let submits = 0;
    let messageReads = 0;
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith('/prompt_async')) {
          submits += 1;
          // The proxy delivered it but lost the response.
          return Response.json({ error: 'bad gateway' }, { status: 502 });
        }
        if (url.pathname.includes('/message/')) {
          messageReads += 1;
          const id = url.pathname.split('/').pop()!;
          return Response.json({
            info: { id, role: 'user', sessionID: SESSION_ID },
            parts: [],
          });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      },
    });

    const oc = opencodeClient({ auth: auth(), sandboxId: 'sbx-1', port: 8000 });
    await oc.submitPrompt(SESSION_ID, [{ type: 'text', text: 'hello' }]);

    expect(submits).toBe(1);
    expect(messageReads).toBe(1);
  });
});
