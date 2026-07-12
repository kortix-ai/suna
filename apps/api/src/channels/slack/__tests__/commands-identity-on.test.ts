import { describe, expect, mock, test } from 'bun:test';

// Turn the per-user identity feature ON before config is imported, so the gated
// `/login` / `/logout` subcommands and help rows become live.
process.env.SLACK_REQUIRE_USER_IDENTITY = 'true';

mock.module('../../../config', () => ({
  config: {
    FRONTEND_URL: 'https://app.test',
    SLACK_REQUIRE_USER_IDENTITY: true,
  },
}));
mock.module('../../../shared/db', () => ({ db: {}, hasDatabase: () => true }));
mock.module('../identity', () => ({
  lookupSlackIdentity: async () => null,
  revokeSlackIdentity: async () => true,
}));
mock.module('../../../accounts/core/app', () => ({
  lookupEmailsByUserIds: async () => new Map(),
}));
mock.module('../selection', () => ({
  currentChannelSelection: async () => null,
  setChannelAgent: async () => true,
  setChannelConversationPolicy: async () => true,
  setChannelModel: async () => true,
  listProjectAgents: async () => [],
  isValidModelId: () => true,
}));
mock.module('../model-gate', () => ({ channelModelContext: async () => null }));
mock.module('../participants', () => ({
  conversationPolicyLabel: () => 'Owner approval',
  normalizeConversationPolicy: () => 'owner_approval',
}));

const { handleSlashCommand } = await import('../commands');

const ctx = { teamId: 'T1', channelId: 'C1', slackUserId: 'U1', command: '/kortix' };

function actionIds(resp: any): string[] {
  const ids: string[] = [];
  for (const b of resp.blocks ?? []) {
    if (b.accessory?.action_id) ids.push(b.accessory.action_id);
    for (const el of b.elements ?? []) if (el.action_id) ids.push(el.action_id);
  }
  return ids;
}

describe('identity feature gated ON', () => {
  test('/login returns a connect prompt', async () => {
    const resp = await handleSlashCommand('login', '', ctx);
    expect(actionIds(resp)).toContain('slack_login_connect');
  });

  test('/logout revokes the binding', async () => {
    const resp = await handleSlashCommand('logout', '', ctx);
    expect(resp.text).toContain('Disconnected');
  });

  test('help advertises login', async () => {
    const resp = await handleSlashCommand('help', '', ctx);
    expect(JSON.stringify(resp.blocks ?? '')).toContain('runs as you');
  });
});
