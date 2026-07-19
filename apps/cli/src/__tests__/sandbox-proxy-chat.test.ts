import { afterEach, describe, expect, test } from 'bun:test';

import type { Auth } from '../api/auth.ts';
import { ApiError } from '../api/client.ts';
import { opencodeClient } from '../api/sandbox-proxy.ts';

const SESSION_ID = 'ses_chat';

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
    logged_in_at: '2026-07-19T00:00:00.000Z',
  };
}

function completedReply(parentID: string) {
  return {
    info: {
      id: 'msg_reply',
      role: 'assistant',
      sessionID: SESSION_ID,
      parentID,
      time: { created: 2, completed: 3 },
    },
    parts: [{ type: 'text', text: 'done' }],
  };
}

function idleStatus(req: Request): Response | null {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname.endsWith('/session/status')) {
    return Response.json({});
  }
  return null;
}

describe('OpenCode CLI chat transport', () => {
  test('submits with prompt_async and polls for the matching completed reply', async () => {
    const requests: Array<{ method: string; path: string }> = [];
    let submittedMessageID = '';
    let messageReads = 0;

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const status = idleStatus(req);
        if (status) return status;
        const url = new URL(req.url);
        requests.push({ method: req.method, path: url.pathname });
        if (req.method === 'POST' && url.pathname.endsWith(`/session/${SESSION_ID}/prompt_async`)) {
          const body = await req.json() as { messageID?: string };
          submittedMessageID = body.messageID ?? '';
          return new Response(null, { status: 204 });
        }
        if (req.method === 'GET' && url.pathname.endsWith(`/session/${SESSION_ID}/message`)) {
          messageReads += 1;
          if (messageReads === 1) {
            return Response.json([
              {
                info: { id: submittedMessageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
                parts: [{ type: 'text', text: 'hello' }],
              },
            ]);
          }
          return Response.json([
            completedReply('msg_unrelated'),
            {
              info: { id: submittedMessageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
              parts: [{ type: 'text', text: 'hello' }],
            },
            completedReply(submittedMessageID),
          ]);
        }
        return new Response('not found', { status: 404 });
      },
    });

    const client = opencodeClient({ auth: auth(), sandboxId: 'sbx_test' });
    const reply = await client.sendPrompt(SESSION_ID, [{ type: 'text', text: 'hello' }], undefined, 2_000);

    expect(submittedMessageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(reply.parts).toEqual([{ type: 'text', text: 'done' }]);
    expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/message'))).toBe(false);
    expect(messageReads).toBeGreaterThanOrEqual(2);
  });

  test('retries a transient prompt_async 502 with the same idempotency message id', async () => {
    const submittedIDs: string[] = [];

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const status = idleStatus(req);
        if (status) return status;
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname.endsWith(`/session/${SESSION_ID}/prompt_async`)) {
          const body = await req.json() as { messageID: string };
          submittedIDs.push(body.messageID);
          if (submittedIDs.length === 1) return new Response('transient', { status: 502 });
          return new Response(null, { status: 204 });
        }
        if (req.method === 'GET' && url.pathname.endsWith(`/session/${SESSION_ID}/message`)) {
          return Response.json([completedReply(submittedIDs[0]!)]);
        }
        return new Response('not found', { status: 404 });
      },
    });

    const client = opencodeClient({ auth: auth(), sandboxId: 'sbx_test' });
    const reply = await client.sendPrompt(SESSION_ID, [{ type: 'text', text: 'hello' }], undefined, 2_000);

    expect(submittedIDs).toHaveLength(2);
    expect(new Set(submittedIDs).size).toBe(1);
    expect(reply.info.parentID).toBe(submittedIDs[0]);
  });

  test('does not resubmit when a 502 lost the prompt_async acceptance response', async () => {
    let promptCalls = 0;
    let submittedMessageID = '';

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const status = idleStatus(req);
        if (status) return status;
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname.endsWith(`/session/${SESSION_ID}/prompt_async`)) {
          promptCalls += 1;
          submittedMessageID = ((await req.json()) as { messageID: string }).messageID;
          return new Response('upstream response lost', { status: 502 });
        }
        if (req.method === 'GET' && url.pathname.endsWith(`/session/${SESSION_ID}/message/${submittedMessageID}`)) {
          return Response.json({
            info: { id: submittedMessageID, role: 'user', sessionID: SESSION_ID, time: { created: 1 } },
            parts: [{ type: 'text', text: 'hello' }],
          });
        }
        if (req.method === 'GET' && url.pathname.endsWith(`/session/${SESSION_ID}/message`)) {
          return Response.json([completedReply(submittedMessageID)]);
        }
        return new Response('not found', { status: 404 });
      },
    });

    const client = opencodeClient({ auth: auth(), sandboxId: 'sbx_test' });
    const reply = await client.sendPrompt(SESSION_ID, [{ type: 'text', text: 'hello' }], undefined, 2_000);

    expect(promptCalls).toBe(1);
    expect(reply.info.parentID).toBe(submittedMessageID);
  });

  test('absorbs a transient 502 while polling without resubmitting the prompt', async () => {
    let promptCalls = 0;
    let messageReads = 0;
    let submittedMessageID = '';

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const status = idleStatus(req);
        if (status) return status;
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname.endsWith(`/session/${SESSION_ID}/prompt_async`)) {
          promptCalls += 1;
          submittedMessageID = ((await req.json()) as { messageID: string }).messageID;
          return new Response(null, { status: 204 });
        }
        if (req.method === 'GET' && url.pathname.endsWith(`/session/${SESSION_ID}/message`)) {
          messageReads += 1;
          if (messageReads === 1) return new Response('transient', { status: 502 });
          return Response.json([completedReply(submittedMessageID)]);
        }
        return new Response('not found', { status: 404 });
      },
    });

    const client = opencodeClient({ auth: auth(), sandboxId: 'sbx_test' });
    const reply = await client.sendPrompt(SESSION_ID, [{ type: 'text', text: 'hello' }], undefined, 2_000);

    expect(promptCalls).toBe(1);
    expect(messageReads).toBe(2);
    expect(reply.info.id).toBe('msg_reply');
  });

  test('waits for an idle turn and returns the final assistant message after a tool step', async () => {
    let submittedMessageID = '';
    let messageReads = 0;
    let statusReads = 0;

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname.endsWith(`/session/${SESSION_ID}/prompt_async`)) {
          submittedMessageID = ((await req.json()) as { messageID: string }).messageID;
          return new Response(null, { status: 204 });
        }
        if (req.method === 'GET' && url.pathname.endsWith(`/session/${SESSION_ID}/message`)) {
          messageReads += 1;
          const messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = [
            {
              info: {
                id: 'msg_tool_step',
                role: 'assistant',
                sessionID: SESSION_ID,
                parentID: submittedMessageID,
                finish: 'tool-calls',
                time: { created: 2, completed: 3 },
              },
              parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed' } }],
            },
          ];
          if (messageReads >= 2) {
            messages.push({
              info: {
                id: 'msg_final',
                role: 'assistant',
                sessionID: SESSION_ID,
                parentID: submittedMessageID,
                finish: 'stop',
                time: { created: 4, completed: 5 },
              },
              parts: [{ type: 'text', text: 'final answer' }],
            });
          }
          return Response.json(messages);
        }
        if (req.method === 'GET' && url.pathname.endsWith('/session/status')) {
          statusReads += 1;
          return Response.json(statusReads === 1 ? { [SESSION_ID]: { type: 'busy' } } : {});
        }
        return new Response('not found', { status: 404 });
      },
    });

    const client = opencodeClient({ auth: auth(), sandboxId: 'sbx_test' });
    const reply = await client.sendPrompt(SESSION_ID, [{ type: 'text', text: 'hello' }], undefined, 2_000);

    expect(messageReads).toBe(3);
    expect(statusReads).toBe(2);
    expect(reply.info.id).toBe('msg_final');
    expect(reply.parts).toEqual([{ type: 'text', text: 'final answer' }]);
  });

  test('surfaces a terminal 4xx without retrying or polling', async () => {
    let promptCalls = 0;
    let messageReads = 0;

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const status = idleStatus(req);
        if (status) return status;
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname.endsWith(`/session/${SESSION_ID}/prompt_async`)) {
          promptCalls += 1;
          return Response.json({ message: 'unknown model' }, { status: 400 });
        }
        if (req.method === 'GET') messageReads += 1;
        return new Response('not found', { status: 404 });
      },
    });

    const client = opencodeClient({ auth: auth(), sandboxId: 'sbx_test' });
    const result = client.sendPrompt(SESSION_ID, [{ type: 'text', text: 'hello' }], undefined, 2_000);

    await expect(result).rejects.toMatchObject({ status: 400, message: 'unknown model' });
    expect(promptCalls).toBe(1);
    expect(messageReads).toBe(0);
  });

  test('keeps the overall wait bounded with a clear timeout error', async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const status = idleStatus(req);
        if (status) return status;
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname.endsWith(`/session/${SESSION_ID}/prompt_async`)) {
          return new Response(null, { status: 204 });
        }
        if (req.method === 'GET' && url.pathname.endsWith(`/session/${SESSION_ID}/message`)) {
          return Response.json([]);
        }
        return new Response('not found', { status: 404 });
      },
    });

    const client = opencodeClient({ auth: auth(), sandboxId: 'sbx_test' });
    const started = Date.now();
    const result = client.sendPrompt(SESSION_ID, [{ type: 'text', text: 'hello' }], undefined, 100);

    await expect(result).rejects.toEqual(new ApiError(0, 'agent reply timed out after 100ms'));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
