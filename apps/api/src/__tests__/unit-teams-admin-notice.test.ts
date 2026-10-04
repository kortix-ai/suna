import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from './helpers/chat-identity-stub';

// Slack DMs every account admin who linked Slack when someone asks for project
// access. Teams now does the same in each admin's 1:1 chat with the bot, on top
// of the notice every manager gets in Kortix.

mock.module('../lib/config', () => ({ config: { FRONTEND_URL: 'https://app.example.test' } }));

const managerNotices: unknown[] = [];
mock.module('../projects/lib/access-requests', () => ({
  notifyProjectAccessRequestManagers: async (input: unknown) => {
    managerNotices.push(input);
  },
}));
mock.module('../iam/read-models', () => ({
  accountRoleMap: async () => new Map([
    ['owner-1', 'owner'],
    ['admin-2', 'admin'],
    ['member-3', 'member'],
    ['requester', 'admin'],
  ]),
  isAccountManagerRole: (role: string) => role === 'owner' || role === 'admin',
}));
mock.module('../projects/lib/access', () => ({ lookupEmailsByUserIds: async () => new Map([['requester', 'requester@example.test'], ['user-1', 'alex@example.test']]) }));
const teamsLinks: Record<string, string | null> = { 'owner-1': 'aad-owner', 'admin-2': 'aad-admin', requester: 'aad-requester', 'member-3': 'aad-member' };
mock.module('../channels/core/identity', () =>
  chatIdentityStub({ lookupChatUserForKortixUser: async (_p: string, _w: string, userId: string) => teamsLinks[userId] ?? null }),
);
let refusedFor = new Set<string>();
const sent: Array<{ to: string; card: string }> = [];
mock.module('../channels/teams-api', () => ({
  openDirectConversation: async (input: { userId: string }) =>
    refusedFor.has(input.userId) ? null : { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: `dm:${input.userId}` },
  sendCard: async (ref: { conversationId: string }, card: unknown) => {
    sent.push({ to: ref.conversationId, card: JSON.stringify(card) });
    return 'act-1';
  },
  sendTargetedCard: async (_ref: unknown, recipient: string, card: unknown) => {
    sent.push({ to: `targeted:${recipient}`, card: JSON.stringify(card) });
    return 'act-2';
  },
  updateCard: async (_ref: unknown, activityId: string, card: unknown) => {
    sent.push({ to: `replaced:${activityId}`, card: JSON.stringify(card) });
    return true;
  },
}));
mock.module('../channels/teams/login-card', () => ({ sendTeamsLoginPrompt: async () => {} }));
mock.module('../channels/teams/auth-resume', () => ({ createPendingTeamsAuthMessage: async () => 'p-1' }));

const { confirmTeamsConnected, notifyAdminsOfTeamsAccessRequest, postTeamsIdentityPrompt } = await import('../channels/teams/identity');
const request = { tenantId: 'tenant-1', projectId: 'proj-1', accountId: 'acct-1', requesterUserId: 'requester' };

beforeEach(() => {
  managerNotices.length = 0;
  sent.length = 0;
  refusedFor = new Set();
});
afterAll(() => mock.restore());

describe('notifyAdminsOfTeamsAccessRequest', () => {
  test('every admin who linked Teams gets a card in their 1:1 chat; members and the requester do not', async () => {
    await notifyAdminsOfTeamsAccessRequest(request);
    expect(managerNotices).toEqual([{ accountId: 'acct-1', projectId: 'proj-1', requesterUserId: 'requester' }]);
    expect(sent.map((s) => s.to)).toEqual(['dm:aad-owner', 'dm:aad-admin']);
    expect(sent[0]!.card).toContain('requester@example.test');
    expect(sent[0]!.card).toContain('https://app.example.test/projects/proj-1/customize/members');
  });

  test('an admin Teams will not open a chat with is skipped, and the rest still get theirs', async () => {
    refusedFor = new Set(['aad-owner']);
    await notifyAdminsOfTeamsAccessRequest(request);
    expect(sent.map((s) => s.to)).toEqual(['dm:aad-admin']);
  });

  test('an admin without a Teams link gets only the Kortix notice', async () => {
    teamsLinks['admin-2'] = null;
    await notifyAdminsOfTeamsAccessRequest(request);
    expect(sent.map((s) => s.to)).toEqual(['dm:aad-owner']);
    expect(managerNotices).toHaveLength(1);
    teamsLinks['admin-2'] = 'aad-admin';
  });
});

describe('confirmTeamsConnected', () => {
  const input = { projectId: 'proj-1', tenantId: 'tenant-1', teamsUserId: 'aad-user', userId: 'user-1' };

  test('after /login, the 1:1 chat says who they are linked as and that the message is picked up', async () => {
    await confirmTeamsConnected({ ...input, resumed: true, hasAccess: true });
    expect(sent.map((s) => s.to)).toEqual(['dm:aad-user']);
    expect(sent[0]!.card).toContain('alex@example.test');
    expect(sent[0]!.card).toContain('Picking up your message now.');
  });

  test('linked without access: the note offers Request access for the project', async () => {
    await confirmTeamsConnected({ ...input, resumed: false, hasAccess: false });
    expect(sent[0]!.card).toContain('teams_request_access');
    expect(sent[0]!.card).toContain('proj-1');
  });

  test('Teams will not open the chat: nothing is sent, and nothing throws', async () => {
    refusedFor = new Set(['aad-user']);
    await confirmTeamsConnected({ ...input, resumed: false, hasAccess: true });
    expect(sent).toEqual([]);
  });
});

// Only the person who has no project access can act on "Request access", so a
// channel or group chat shows it to them alone, as Slack's ephemeral.
describe('postTeamsIdentityPrompt: a linked member without project access', () => {
  const activity = (conversationType: string) => ({
    type: 'message',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    conversation: { id: 'conv-1', conversationType },
    from: { id: '29:member', aadObjectId: 'aad-member' },
    recipient: { id: '28:bot' },
  });

  test('a channel or group chat: the Request access card goes to them alone', async () => {
    for (const type of ['channel', 'groupChat']) {
      sent.length = 0;
      await postTeamsIdentityPrompt({ projectId: 'proj-1', tenantId: 'tenant-1', activity: activity(type), reason: 'not_member' });
      expect(sent.map((s) => s.to)).toEqual(['targeted:29:member']);
      expect(sent[0]!.card).toContain('teams_request_access');
    }
  });

  test("a 1:1 chat: the card replaces the person's own live card", async () => {
    await postTeamsIdentityPrompt({ projectId: 'proj-1', tenantId: 'tenant-1', activity: activity('personal'), reason: 'not_member', replaceActivityId: 'live-1' });
    expect(sent.map((s) => s.to)).toEqual(['replaced:live-1']);
  });
});
