import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// "Open in Kortix" on a message's ⋯ menu: Slack's message shortcut. It answers
// which session a conversation (or a channel thread) belongs to, with a link.

mock.module('../lib/config', () => ({ config: { FRONTEND_URL: 'https://app.example.test' } }));

const CHANNEL = '19:c@thread.tacv2';
const sessions: Record<string, { sessionId: string; projectId: string }> = {
  [`${CHANNEL};messageid=root-1`]: { sessionId: 'sess-thread', projectId: 'proj-1' },
  'a:personal': { sessionId: 'sess-dm', projectId: 'proj-1' },
};
const sessionLookups: Array<{ id: string; scope?: string }> = [];
mock.module('../channels/teams/binding', () => ({
  conversationSession: async (_t: string, id: string, scope?: string) => {
    sessionLookups.push({ id, scope });
    return sessions[id] ? { sessionId: sessions[id]!.sessionId, status: 'running' } : null;
  },
}));
mock.module('../channels/teams/inbound', () => ({
  conversationProjectFor: async (_inbound: unknown, _t: string, id: string) => sessions[id]?.projectId ?? (id.startsWith(CHANNEL) ? 'proj-1' : null),
}));

const { handleOpenInKortixAction, sessionConversationIds } = await import('../channels/teams/message-action');
const MANAGED = { kind: 'managed' } as never;
const invoke = (conversationId: string, value: Record<string, unknown>) =>
  ({ type: 'invoke', name: 'composeExtension/fetchTask', conversation: { id: conversationId, tenantId: 'tenant-1' }, value }) as never;

beforeEach(() => {
  sessionLookups.length = 0;
});
afterAll(() => mock.restore());

describe('Open in Kortix', () => {
  test('a message in a channel thread opens that thread\'s session, found by its root', async () => {
    const r = JSON.stringify(await handleOpenInKortixAction(invoke(CHANNEL, { commandId: 'openInKortix', messagePayload: { id: 'reply-9', replyToId: 'root-1' } }), MANAGED));
    expect(r).toContain('"type":"continue"');
    expect(r).toContain('https://app.example.test/projects/proj-1/sessions/sess-thread');
    expect(sessionLookups.map((l) => l.id)).toEqual([CHANNEL, `${CHANNEL};messageid=root-1`]);
  });

  test('a 1:1 chat opens its session directly', async () => {
    const r = JSON.stringify(await handleOpenInKortixAction(invoke('a:personal', { commandId: 'openInKortix', messagePayload: { id: 'm1' } }), MANAGED));
    expect(r).toContain('/sessions/sess-dm');
  });

  test('no session yet, or another command, answers with a message and no link', async () => {
    const none = JSON.stringify(await handleOpenInKortixAction(invoke(CHANNEL, { commandId: 'openInKortix', messagePayload: { id: 'lonely' } }), MANAGED));
    expect(none).toContain('"type":"message"');
    expect(none).toContain('No Kortix session');
    const other = JSON.stringify(await handleOpenInKortixAction(invoke('a:personal', { commandId: 'somethingElse' }), MANAGED));
    expect(other).toContain("isn't available");
  });

  test('a per-project bot only finds its own project\'s sessions', async () => {
    await handleOpenInKortixAction(invoke('a:personal', { commandId: 'openInKortix', messagePayload: { id: 'm1' } }), { kind: 'project', projectId: 'proj-9' } as never);
    expect(sessionLookups).toEqual([{ id: 'a:personal', scope: 'proj-9' }]);
  });

  test('the thread-root candidates: an id that already names a thread is used as is', () => {
    expect(sessionConversationIds(`${CHANNEL};messageid=r`, { messagePayload: { id: 'x' } })).toEqual([`${CHANNEL};messageid=r`]);
    expect(sessionConversationIds(CHANNEL, { messagePayload: { id: 'x' } })).toEqual([CHANNEL, `${CHANNEL};messageid=x`]);
    expect(sessionConversationIds(CHANNEL, {})).toEqual([CHANNEL]);
  });
});
