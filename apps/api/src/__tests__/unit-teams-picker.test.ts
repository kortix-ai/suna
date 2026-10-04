import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Multi-project tenant, nothing bound: Slack posts a project picker rather
 * than routing to the first install. These pin the Teams twin — the picker is
 * posted, a command that needs no project still runs, a command about the
 * project asks for one first, and only a mention in a channel is answered.
 */

const TENANT = 'tenant-picker';
const CONV = '19:chan@thread.tacv2;messageid=1';

let resolution: unknown = { kind: 'ambiguous', projects: [{ projectId: 'p1', name: 'Alpha' }, { projectId: 'p2', name: 'Beta' }] };
const cards: unknown[] = [];
const commandsRun: string[] = [];
const sessionsStarted: string[] = [];
let parkedId: string | null = 'pending-1';

function chain(result: unknown[]): any {
  const c: any = {};
  for (const m of ['from', 'where', 'limit', 'values', 'onConflictDoNothing', 'returning', 'set']) c[m] = () => c;
  c.then = (r: (rows: unknown[]) => unknown) => Promise.resolve(r(result));
  c.catch = () => Promise.resolve(result);
  return c;
}
mock.module('../shared/db', () => ({ hasDatabase: true, db: { insert: () => chain([{ eventId: 'x' }]), delete: () => chain([]), select: () => chain([]) } }));
mock.module('../lib/config', () => ({ SANDBOX_VERSION: 'test', config: { FRONTEND_URL: 'https://dev.kortix.com' } }));
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => true }));
mock.module('../channels/teams-api', () => ({
  sendCard: async (_ref: unknown, card: unknown) => {
    cards.push(card);
    return 'card-1';
  },
}));
mock.module('../channels/teams/binding', () => ({
  listTenantProjects: async () => [],
  resolveConversationProjectDetailed: async () => resolution,
  resolveConversationProject: async () => 'p1',
}));
mock.module('../channels/teams/auth-resume', () => ({
  createPendingTeamsPickerMessage: async () => parkedId,
}));
mock.module('../channels/teams/commands', () => ({
  parseTeamsCommand: (t: string) => (t.startsWith('/') ? { verb: t.slice(1).split(' ')[0], arg: '' } : null),
  handleTeamsCommand: async (i: { command: { verb: string } }) => {
    commandsRun.push(i.command.verb);
    return true;
  },
}));
mock.module('../channels/teams/session', () => ({
  hasConversationSession: async () => false,
  createOrJoinTeamsConversationSession: async (i: { conversationId: string }) => {
    sessionsStarted.push(i.conversationId);
  },
}));

const { handleTeamsActivity } = await import('../channels/teams/dispatch');

let n = 0;
const activity = (text: string, where: 'personal' | 'channel' | 'mention' = 'personal') => {
  n += 1;
  return {
    type: 'message',
    id: `act-${n}`,
    text,
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    recipient: { id: '28:bot' },
    from: { id: '29:someone', name: 'Someone' },
    conversation: { id: CONV, conversationType: where === 'personal' ? 'personal' : 'channel', tenantId: TENANT },
    ...(where === 'mention' ? { entities: [{ type: 'mention', mentioned: { id: '28:bot' } }] } : {}),
  };
};

beforeEach(() => {
  resolution = { kind: 'ambiguous', projects: [{ projectId: 'p1', name: 'Alpha' }, { projectId: 'p2', name: 'Beta' }] };
  cards.length = 0;
  commandsRun.length = 0;
  sessionsStarted.length = 0;
  parkedId = 'pending-1';
});
afterAll(() => mock.restore());

describe('ambiguous tenant → project picker', () => {
  test('a task posts a picker listing every project (with the pending id for replay) and starts no session', async () => {
    await handleTeamsActivity(activity('summarize the repo') as never);
    expect(cards).toHaveLength(1);
    const flat = JSON.stringify(cards[0]);
    expect(flat).toContain('Alpha');
    expect(flat).toContain('Beta');
    expect(flat).toContain('pending-1');
    expect(flat).toContain('teams_pick_project');
    expect(sessionsStarted).toHaveLength(0);
  });

  test('a command that needs no project runs now (against the first install)', async () => {
    await handleTeamsActivity(activity('/use') as never);
    await handleTeamsActivity(activity('/login') as never);
    expect(commandsRun).toEqual(['use', 'login']);
    expect(cards).toHaveLength(0);
  });

  test('a command about the project gets the picker, parks nothing, and binds nothing', async () => {
    await handleTeamsActivity(activity('/models') as never);
    await handleTeamsActivity(activity('/projects') as never);
    expect(commandsRun).toEqual([]);
    expect(cards).toHaveLength(2);
    expect(JSON.stringify(cards[0])).toContain('teams_pick_project');
    expect(JSON.stringify(cards[0])).not.toContain('pending-1');
  });

  test('an un-mentioned channel line is not answered with a picker', async () => {
    await handleTeamsActivity(activity('lunch at noon?', 'channel') as never);
    expect(cards).toHaveLength(0);
    expect(sessionsStarted).toHaveLength(0);
  });

  test('a mention in a channel gets the picker', async () => {
    await handleTeamsActivity(activity('<at>Kortix</at> summarize the repo', 'mention') as never);
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain('pending-1');
  });

  test('a single install is not ambiguous — nothing is asked', async () => {
    resolution = { kind: 'project', projectId: 'p1' };
    await handleTeamsActivity(activity('hi') as never);
    expect(cards).toHaveLength(0);
  });
});
