/**
 * Rewind must be served on the path the SDK actually calls.
 *
 * This is the abort bug's shape, and it is why this file exists separately from
 * the transcript tests. The SDK builds its OpenCode client with
 * `baseUrl = <backend>/p/<externalId>/8000`, so `session.revert()` resolves to
 * `<base>/session/:id/revert` — the RAW ROOT, no `/kortix/opencode` prefix.
 * Serving it anywhere else is indistinguishable from not implementing it: the
 * transcript tests would still pass and rewind would still do nothing.
 */
import { describe, expect, test } from 'bun:test';
import { mintRootId, RuntimeSurface } from './runtime-surface.ts';

// The surface DERIVES its root id from the session id; it is not passed in.
const SESSION = 's';
const ROOT = mintRootId(SESSION);

function surfaceWithHistory(): RuntimeSurface {
  const s = new RuntimeSurface({ sessionId: SESSION, token: 'tok' });
  for (const [id, role, text] of [
    ['msg_01', 'user', 'q1'],
    ['msg_02', 'assistant', 'a1'],
    ['msg_03', 'user', 'q2'],
    ['msg_04', 'assistant', 'a2'],
  ] as const) {
    s.transcript.apply({ type: 'message.updated', properties: { info: { id, role } } });
    s.transcript.apply({
      type: 'message.part.updated',
      properties: { part: { id: `${id}-p0`, messageID: id, type: 'text', text } },
    });
  }
  return s;
}

/** Drive one request through the raw-root handler and capture the response. */
async function call(
  surface: RuntimeSurface,
  method: string,
  path: string,
  body?: unknown,
  auth = 'Bearer tok',
): Promise<{ handled: boolean; status: number; json: any }> {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const req = {
    method,
    headers: auth ? { authorization: auth } : {},
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      return this;
    },
  } as never as import('node:http').IncomingMessage;

  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(text?: string) {
      payload = text ?? '';
      return this;
    },
  } as never as import('node:http').ServerResponse;

  const handled = surface.handleRawSessionList(req, res, new URL(`http://x${path}`));
  // The handler reads the body asynchronously; feed it after the call.
  for (const c of chunks) listeners.data?.forEach((cb) => cb(c));
  listeners.end?.forEach((cb) => cb());
  await new Promise((r) => setTimeout(r, 5));
  return { handled, status, json: payload ? JSON.parse(payload) : null };
}

const visible = (s: RuntimeSurface) =>
  s.transcript.page({ limit: 50, before: null }).messages.map((m) => m.info.id);

describe('POST /session/:id/revert at the RAW ROOT', () => {
  test('removes the tail and reports which ids went', async () => {
    const s = surfaceWithHistory();
    const r = await call(s, 'POST', `/session/${ROOT}/revert`, { messageID: 'msg_03' });
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.json.removed).toEqual(['msg_03', 'msg_04']);
    expect(visible(s)).toEqual(['msg_01', 'msg_02']);
  });

  test('unrevert puts it back', async () => {
    const s = surfaceWithHistory();
    await call(s, 'POST', `/session/${ROOT}/revert`, { messageID: 'msg_03' });
    const r = await call(s, 'POST', `/session/${ROOT}/unrevert`, {});
    expect(r.status).toBe(200);
    expect(r.json.restored).toEqual(['msg_03', 'msg_04']);
    expect(visible(s)).toEqual(['msg_01', 'msg_02', 'msg_03', 'msg_04']);
  });

  test('a revert with no messageID is a 400, not a silent no-op', async () => {
    const s = surfaceWithHistory();
    const r = await call(s, 'POST', `/session/${ROOT}/revert`, {});
    expect(r.status).toBe(400);
    expect(visible(s)).toHaveLength(4);
  });

  test('another session id is 404, never someone else’s transcript', async () => {
    const s = surfaceWithHistory();
    const r = await call(s, 'POST', '/session/ses_someone_else/revert', { messageID: 'msg_03' });
    expect(r.status).toBe(404);
    expect(visible(s)).toHaveLength(4);
  });

  test('an unauthenticated caller is refused before anything is removed', async () => {
    const s = surfaceWithHistory();
    const r = await call(s, 'POST', `/session/${ROOT}/revert`, { messageID: 'msg_03' }, '');
    expect(r.status).toBe(401);
    expect(visible(s)).toHaveLength(4);
  });

  test('GET is not a state change', async () => {
    const s = surfaceWithHistory();
    const r = await call(s, 'GET', `/session/${ROOT}/revert`);
    // Either unhandled or non-200 — what matters is that nothing was removed.
    expect(r.status).not.toBe(200);
    expect(visible(s)).toHaveLength(4);
  });
});
