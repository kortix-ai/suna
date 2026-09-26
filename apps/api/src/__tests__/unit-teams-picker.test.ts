import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Multi-project tenant, nothing bound: Slack posts a project picker rather
 * than routing to the first install. These pin the Teams twin — the picker is
 * posted, a command still runs, and the pick replays the parked message.
 */

const TENANT = '36009a52-46d2-44bc-ba56-57a87e485e0a';
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
mock.module('../config', () => ({ SANDBOX_VERSION: 'test', config: { FRONTEND_URL: 'https://dev.kortix.com' } }));
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => true }));
mock.module('../channels/teams-api', () => ({
  sendCard: async (_ref: unknown, card: unknown) => {
    cards.push(card);
    return 'card-1';
  },
}));
mock.module('../channels/teams/binding', () => ({
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
const activity = (text: string) => {
  n += 1;
  return {
    type: 'message',
    id: `act-${n}`,
    text,
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    recipient: { id: '28:bot' },
    from: { id: '29:ivan', name: 'Ivan' },
    conversation: { id: CONV, conversationType: 'personal', tenantId: TENANT },
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

  test('a command still runs (against the first install) so /projects and /use work', async () => {
    await handleTeamsActivity(activity('/projects') as never);
    expect(commandsRun).toEqual(['projects']);
    expect(cards).toHaveLength(0);
  });

  test('a single install is not ambiguous — nothing is asked', async () => {
    resolution = { kind: 'project', projectId: 'p1' };
    await handleTeamsActivity(activity('hi') as never);
    expect(cards).toHaveLength(0);
  });
});
