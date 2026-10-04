import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * A Slack event names nobody: it carries `U0…` and `C0…` ids. The prompt the
 * agent gets, and the card the session page draws from it, showed those ids
 * where a Teams session shows a person's name. `slackMessageLabels` resolves
 * the names once per message, from cache when it can, and never holds a turn
 * back for longer than its budget.
 */

type Label = { name: string | null; type: string | null; unavailable: boolean };

let token: string | null = 'xoxb-test';
let bindingLabel: Label = { name: 'general', type: 'channel', unavailable: false };
const people: Record<string, string | null> = {};
let userLookups: string[] = [];
let userDelayMs = 0;

mock.module('../services/channels/install-store', () => ({
  loadSlackTokenForProject: async () => token,
}));

mock.module('../services/channels/slack/binding-label', () => ({
  backfillSlackBindingLabel: async () => bindingLabel,
}));

mock.module('../services/channels/slack-api', () => ({
  getSlackUserDisplayName: async (_token: string, userId: string) => {
    userLookups.push(userId);
    if (userDelayMs) await new Promise((r) => setTimeout(r, userDelayMs));
    return people[userId] ?? null;
  },
}));

const { slackMessageLabels, slackUserNames, resetSlackUserNamesForTest, setSlackLabelBudgetForTest } = await import(
  '../services/channels/slack/labels'
);

const event = (over: Record<string, unknown> = {}) =>
  ({ type: 'app_mention', channel: 'C0TEST1', user: 'U0TEST1', text: '<@U0BOT> check the release', ts: '1.1', ...over }) as any;

beforeEach(() => {
  token = 'xoxb-test';
  bindingLabel = { name: 'general', type: 'channel', unavailable: false };
  for (const k of Object.keys(people)) delete people[k];
  people.U0TEST1 = 'Sam Rivera';
  people.U0BOT = 'Kortix';
  userLookups = [];
  userDelayMs = 0;
  resetSlackUserNamesForTest();
  setSlackLabelBudgetForTest(null);
});

afterAll(() => {
  mock.restore();
});

describe('slackMessageLabels', () => {
  test('names the channel, the sender, and each person mentioned, keeping their ids', async () => {
    expect(await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event() })).toEqual({
      channel: '#general',
      user: 'Sam Rivera',
      text: '<@U0BOT|Kortix> check the release',
    });
  });

  test('a private channel is still #name; a DM and a group DM say what they are', async () => {
    bindingLabel = { name: 'launch-plan', type: 'private_channel', unavailable: false };
    expect((await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event() })).channel).toBe('#launch-plan');

    bindingLabel = { name: 'Sam Rivera', type: 'im', unavailable: false };
    expect((await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event({ channel: 'D0TEST1' }) })).channel).toBe(
      'Direct message',
    );

    bindingLabel = { name: 'sam, alex', type: 'mpim', unavailable: false };
    expect((await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event() })).channel).toBe('Group DM: sam, alex');
  });

  test('asks Slack once per person, then answers from cache', async () => {
    await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event() });
    await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event() });

    expect(userLookups.sort()).toEqual(['U0BOT', 'U0TEST1']);
  });

  test('a person Slack cannot name keeps the bare mention and no sender name', async () => {
    people.U0TEST1 = null;
    const labels = await slackMessageLabels({
      projectId: 'p1',
      teamId: 'T0TEST',
      event: event({ text: 'ask <@U0TEST2> please' }),
    });
    expect(labels.user).toBeNull();
    expect(labels.text).toBe('ask <@U0TEST2> please');
  });

  test('a mention already carrying a label is left as written', async () => {
    const labels = await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event({ text: 'hi <@U0BOT|bot>' }) });
    expect(labels.text).toBe('hi <@U0BOT|bot>');
  });

  test('no bot token: every label is unknown and the text is unchanged', async () => {
    token = null;
    expect(await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event() })).toEqual({
      channel: null,
      user: null,
      text: '<@U0BOT> check the release',
    });
  });

  test('a slow Slack answer never holds the turn past the budget', async () => {
    setSlackLabelBudgetForTest(20);
    userDelayMs = 200;
    const started = Date.now();

    const labels = await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event() });

    expect(Date.now() - started).toBeLessThan(150);
    expect(labels).toEqual({ channel: null, user: null, text: '<@U0BOT> check the release' });
  });
});

// The approval card names a user it receives as a connector parameter. It
// reads the same cache, under the same budget, as a message's labels.
describe('slackUserNames', () => {
  test('names each known user once, leaves an unknown one out, and shares the message cache', async () => {
    people.U0TEST2 = null;
    const names = await slackUserNames('xoxb-test', 'T0TEST', ['U0TEST1', 'U0TEST2', 'U0TEST1']);
    expect([...names]).toEqual([['U0TEST1', 'Sam Rivera']]);

    await slackMessageLabels({ projectId: 'p1', teamId: 'T0TEST', event: event({ text: 'hi' }) });
    expect(userLookups.sort()).toEqual(['U0TEST1', 'U0TEST2']);
  });

  test('asks at most ten people by default; a caller may raise the cap', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `U0CAP${String(i).padStart(2, '0')}`);
    for (const id of ids) people[id] = `Person ${id}`;

    expect((await slackUserNames('xoxb-test', 'T0TEST', ids)).size).toBe(10);
    resetSlackUserNamesForTest();
    userLookups = [];
    expect((await slackUserNames('xoxb-test', 'T0TEST', ids, 25)).size).toBe(12);
    expect(userLookups).toHaveLength(12);
  });

  test('no ids asks Slack nothing', async () => {
    expect((await slackUserNames('xoxb-test', 'T0TEST', [])).size).toBe(0);
    expect(userLookups).toEqual([]);
  });

  test('a slow Slack answer gives no names within the budget', async () => {
    setSlackLabelBudgetForTest(20);
    userDelayMs = 200;
    const started = Date.now();

    expect((await slackUserNames('xoxb-test', 'T0TEST', ['U0TEST1'])).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(150);
  });
});
