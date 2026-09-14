import { expect, test } from 'bun:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { startWorker } from './worker';
import { type SessionLogItem } from './session-store';
import { projectPiHistory, validatePiHistoryControlAppend, PiHistoryTransitionError } from '../../../packages/shared/src/pi-history';

test('worker replacement restores staged history, undo restores exact envelopes, and the next prompt uses only the selected model branch', async () => {
  const items: SessionLogItem[] = [];
  const store = Bun.serve({ port: 0, async fetch(req) {
    if (req.method === 'GET') return Response.json(items);
    const item = await req.json() as SessionLogItem;
    const existing = items.find(row => row._kortixAppendId === item._kortixAppendId);
    if (existing) return new Response(null, { status: JSON.stringify(existing) === JSON.stringify(item) ? 204 : 409 });
    try { validatePiHistoryControlAppend(items, item); }
    catch (error) {
      if (error instanceof PiHistoryTransitionError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
    items.push(item);
    return new Response(null, { status: 204 });
  } });
  const config = {
    port: 0, envUrl: 'http://127.0.0.1:1', envUrlExplicit: true, envCwd: '/workspace',
    systemPrompt: 'Follow the user.', modelMode: 'faux' as const,
    sessionId: `history-${crypto.randomUUID()}`, kortixToken: 'fixture-token', storeUrl: store.url.toString().replace(/\/$/, ''),
  };
  let worker = await startWorker(config);
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${worker.port}${path}`, {
    headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const id = (await (await request('/session')).json())[0].id;
  const history = async () => (await request(`/session/${id}/message`)).json() as Promise<any[]>;
  const restart = async () => {
    worker.server.closeAllConnections(); await worker.close();
    worker = await startWorker(config);
  };
  try {
    worker.faux!.setResponses([fauxAssistantMessage('FIRST_REPLY'), fauxAssistantMessage('SECOND_REPLY')]);
    for (const text of ['FIRST_INPUT', 'SECOND_INPUT']) {
      expect((await request(`/session/${id}/message`, { parts: [{ type: 'text', text }] })).status).toBe(200);
    }
    const original = await history();
    expect(original).toHaveLength(4);
    const native = items.filter(item => item.kind === 'entry');
    const boundary = native.find(item => item.entry.message?.kortixWireMessageId === original[2].info.id)!;
    const transition = {
      kind: 'history' as const, version: 1 as const, revision: 2, action: 'stage' as const,
      messageId: original[2].info.id, fromLeaf: native.at(-1)!.entry.id,
      toLeaf: boundary.entry.parentId, hiddenMessageIds: original.slice(2).map(message => message.info.id),
    };
    items.push(transition);
    await restart();
    expect(await history()).toEqual(original.slice(0, 2));
    expect(worker.env.calls).toHaveLength(0);
    items.push({ kind: 'history', version: 1, revision: 3, action: 'restore' });
    await restart();
    expect(await history()).toEqual(original);
    items.push({ ...transition, revision: 4 });
    await restart();
    worker.faux!.setResponses([context => {
      const input = JSON.stringify(context.messages);
      expect(input).toContain('FIRST_INPUT');
      expect(input).toContain('FIRST_REPLY');
      expect(input).toContain('NEXT_INPUT');
      expect(input).not.toContain('SECOND_INPUT');
      expect(input).not.toContain('SECOND_REPLY');
      return fauxAssistantMessage('SELECTED_BRANCH_REPLY');
    }]);
    expect((await request(`/session/${id}/message`, { parts: [{ type: 'text', text: 'NEXT_INPUT' }] })).status).toBe(200);
    expect(projectPiHistory(items).staged).toBeNull();
    const final = await history();
    expect(final.slice(0, 2)).toEqual(original.slice(0, 2));
    expect(final).toHaveLength(4);
    expect(final.at(-1).parts.some((part: any) => part.text === 'SELECTED_BRANCH_REPLY')).toBe(true);
    await restart();
    expect(await history()).toEqual(final);
    expect(worker.env.calls).toHaveLength(0);
    expect((await request(`/session/${id}/revert`, { messageID: final[2].info.id })).status).toBe(501);
  } finally {
    worker.server.closeAllConnections(); await worker.close(); store.stop(true);
  }
}, 15000);
