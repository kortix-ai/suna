import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from './helpers/chat-identity-stub';

// `handleReview` checked only that the presser had SOME linked Kortix identity
// in the tenant — never that they had access to the project. So anyone in the
// Teams tenant who had ever run `/login` could Approve or Deny a review item
// for a project they are not a member of. The card is posted to the whole
// conversation, so the check has to happen on the press.
//
// Slack has applied the right bar since its own review cards shipped:
// "The actor must be a linked Kortix user with write access to this project."

const TENANT = 'tenant-1';
const CONVO = '19:abc@thread.tacv2';
const PROJECT = 'proj-1';
const ITEM_ACCOUNT = 'acct-owning-the-item';

const actorCalls: Array<{ tenantId: string; uid: string; accountId: string; projectId: string }> = [];
let actorResult: { userId: string } | { reason: 'unlinked' | 'not_member' } = { userId: 'user-1' };
mock.module('../channels/teams/identity', () => ({
  teamsUserId: () => '29:presser',
  notifyAdminsOfTeamsAccessRequest: async () => {},
}));
mock.module('../channels/core/identity', () =>
  chatIdentityStub({
  
  resolveChatActor: async (
    user: { workspaceId: string; platformUserId: string },
    project: { accountId: string; projectId: string },
  ) => {
    actorCalls.push({ tenantId: user.workspaceId, uid: user.platformUserId, accountId: project.accountId, projectId: project.projectId });
    return actorResult;
  },
  createChatAccessRequest: async () => null,
  resolveProjectChatActor: async () => ({ userId: 'user-1' }),
  lookupChatIdentity: async () => ({ userId: 'user-1' }),
}),
);

const verdicts: Array<Record<string, unknown>> = [];
mock.module('../projects/review-items', () => ({
  getReviewItemById: async () => ({
    reviewItemId: 'ri_1',
    accountId: ITEM_ACCOUNT,
    title: 'Delete the staging bucket',
  }),
  applyVerdict: async (_id: string, _pid: string, opts: Record<string, unknown>) => {
    verdicts.push(opts);
  },
}));

mock.module('../channels/teams/binding', () => ({
  resolveConversationProject: async () => PROJECT,
  setConversationProject: async () => {},
  teamsChannelCtx: () => ({ platform: 'teams', teamId: TENANT, channelId: CONVO }),
}));

mock.module('../channels/teams/session', () => ({
  createOrJoinTeamsConversationSession: async () => {},
}));

const activity = {
  type: 'invoke',
  id: 'act-1',
  conversation: { id: CONVO, tenantId: TENANT },
  from: { id: '29:presser', name: 'Someone' },
  value: { action: { verb: 'teams_review', data: { verb: 'teams_review', reviewItemId: 'ri_1', verdict: 'approve' } } },
};

const load = async () => await import('../channels/teams/interactivity');

beforeEach(() => {
  actorCalls.length = 0;
  verdicts.length = 0;
  actorResult = { userId: 'user-1' };
});

afterEach(() => {
  mock.restore();
});

describe('a review decision is authorized on the press', () => {
  test('a linked user WITHOUT project access cannot approve', async () => {
    actorResult = { reason: 'not_member' };
    const { handleAdaptiveCardAction } = await load();

    const res = await handleAdaptiveCardAction(activity as never);

    expect(verdicts).toEqual([]);
    expect(JSON.stringify(res.value)).toContain("don't have access");
  });

  test('an unlinked user is asked to connect, and nothing is applied', async () => {
    actorResult = { reason: 'unlinked' };
    const { handleAdaptiveCardAction } = await load();

    const res = await handleAdaptiveCardAction(activity as never);

    expect(verdicts).toEqual([]);
    expect(JSON.stringify(res.value)).toContain('/login');
  });

  test('a linked user WITH project access applies the verdict as themselves', async () => {
    const { handleAdaptiveCardAction } = await load();

    await handleAdaptiveCardAction(activity as never);

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].actingUserId).toBe('user-1');
    expect(verdicts[0].verdict).toBe('approve');
  });

  test('authorization is scoped to the ITEM`s account, not the presser`s', async () => {
    // Resolving against the wrong account would authorize against a project
    // the item does not belong to.
    const { handleAdaptiveCardAction } = await load();

    await handleAdaptiveCardAction(activity as never);

    expect(actorCalls).toEqual([
      { tenantId: TENANT, uid: '29:presser', accountId: ITEM_ACCOUNT, projectId: PROJECT },
    ]);
  });
});
