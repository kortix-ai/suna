import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Proactive posting is the Teams twin of Slack's `send_message`: the agent
 * posts into a chat or channel it is not currently answering in.
 *
 * The conversation is addressed by id, and the bot credential is tenant-wide,
 * so the id ALONE must never be enough. The gate is `chat_channel_bindings`,
 * which only `ensureTeamsConversationBinding` writes and only after confirming
 * the tenant has an install for that project — the same class of check the
 * team-drive upload needed (CWE-862).
 */

const rows: Array<{ platform: string; channelId: string; projectId: string; workspaceId: string; channelName: string | null; channelType: string | null }> = [];
const sent: Array<{ conversationId: string; tenantId?: string; kind: 'card' | 'text' }> = [];
let cardOk = true;

describe('postToTeamsConversation', () => {
  beforeEach(() => {
    rows.length = 0;
    sent.length = 0;
    cardOk = true;
    rows.push({
      platform: 'teams',
      channelId: '19:mine@thread.tacv2',
      projectId: 'p1',
      workspaceId: 'tenant-1',
      channelName: 'General',
      channelType: 'channel',
    });
    rows.push({
      platform: 'teams',
      channelId: '19:someone-elses@thread.tacv2',
      projectId: 'p2',
      workspaceId: 'tenant-1',
      channelName: 'Secret',
      channelType: 'channel',
    });
  });

  test('posts into a conversation bound to this project', async () => {
    const { postToTeamsConversation } = await import('../channels/teams/post');
    const res = await postToTeamsConversation('p1', { conversationId: '19:mine@thread.tacv2', text: 'hello' });
    expect(res).toEqual({ ok: true, conversationId: '19:mine@thread.tacv2', delivered: 'card' });
    expect(sent).toHaveLength(1);
    // The tenant comes from the binding row, never from the caller.
    expect(sent[0]!.tenantId).toBe('tenant-1');
  });

  test("refuses a conversation bound to ANOTHER project in the same tenant", async () => {
    const { postToTeamsConversation } = await import('../channels/teams/post');
    const res = await postToTeamsConversation('p1', {
      conversationId: '19:someone-elses@thread.tacv2',
      text: 'hello',
    });
    expect(res.ok).toBe(false);
    // 404 — not addressable by this project. 403 is reserved for the caller
    // gate, so the two failures stay distinguishable.
    expect((res as { status: number }).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test('refuses a conversation nobody is bound to', async () => {
    const { postToTeamsConversation } = await import('../channels/teams/post');
    const res = await postToTeamsConversation('p1', { conversationId: '19:invented@thread.tacv2', text: 'x' });
    expect(res.ok).toBe(false);
    expect((res as { status: number }).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test('requires something to say', async () => {
    const { postToTeamsConversation } = await import('../channels/teams/post');
    const res = await postToTeamsConversation('p1', { conversationId: '19:mine@thread.tacv2' });
    expect(res.ok).toBe(false);
    expect((res as { status: number }).status).toBe(400);
  });

  test('falls back to a plain activity when the card is refused', async () => {
    cardOk = false;
    const { postToTeamsConversation } = await import('../channels/teams/post');
    const res = await postToTeamsConversation('p1', { conversationId: '19:mine@thread.tacv2', text: 'hello' });
    expect(res).toEqual({ ok: true, conversationId: '19:mine@thread.tacv2', delivered: 'text' });
    expect(sent.map((s) => s.kind)).toEqual(['card', 'text']);
  });

  test('lists only the project own conversations as targets', async () => {
    const { listTeamsPostTargets } = await import('../channels/teams/post');
    const targets = await listTeamsPostTargets('p1');
    expect(targets).toEqual([{ conversationId: '19:mine@thread.tacv2', name: 'General', type: 'channel' }]);
  });
});

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (pred: (r: (typeof rows)[number]) => boolean) => {
          const matched = rows.filter(pred);
          const result = matched.map((r) => ({
            workspaceId: r.workspaceId,
            channelId: r.channelId,
            channelName: r.channelName,
            channelType: r.channelType,
          }));
          return Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result.slice(0, 1)) });
        },
      }),
    }),
  },
}));

// The drizzle predicate builders are reduced to plain functions over the row.
mock.module('drizzle-orm', () => ({
  and:
    (...ps: Array<(r: unknown) => boolean>) =>
    (r: unknown) =>
      ps.every((p) => p(r)),
  eq: (col: { _name: string }, value: unknown) => (r: Record<string, unknown>) => r[col._name] === value,
}));

mock.module('@kortix/db', () => ({
  chatChannelBindings: {
    platform: { _name: 'platform' },
    channelId: { _name: 'channelId' },
    projectId: { _name: 'projectId' },
    workspaceId: { _name: 'workspaceId' },
    channelName: { _name: 'channelName' },
    channelType: { _name: 'channelType' },
  },
}));

mock.module('../channels/install-store', () => ({
  loadTeamsServiceUrlForProject: async () => 'https://smba.trafficmanager.net/emea/',
}));

mock.module('../channels/teams-api', () => ({
  sendCard: async (ref: { conversationId: string; tenantId?: string }) => {
    sent.push({ conversationId: ref.conversationId, tenantId: ref.tenantId, kind: 'card' });
    return cardOk;
  },
  sendActivity: async (ref: { conversationId: string; tenantId?: string }) => {
    sent.push({ conversationId: ref.conversationId, tenantId: ref.tenantId, kind: 'text' });
    return true;
  },
}));

mock.module('../channels/teams/cards', () => ({
  buildNoticeCard: (t: string) => ({ type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: t }] }),
}));
