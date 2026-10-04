import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * A Slack binding is named once and the name is stored: the settings page,
 * the picker, and every later read then cost no Slack call. A lookup that
 * names nothing (a deleted channel, a DM whose person Slack cannot name) is
 * not repeated for 10 minutes, so polling the settings page cannot turn one
 * dead binding into one Slack call per poll.
 */

type Label = { name: string | null; type: string | null; unavailable: boolean };

let storedRow: { channelName: string | null; channelType: string | null } | null = null;
const updates: Array<Record<string, unknown>> = [];
let slackLabel: Label = { name: null, type: null, unavailable: false };
let slackCalls = 0;

function chain(rows: unknown[]): any {
  const c: any = {};
  for (const m of ['from', 'where', 'limit']) c[m] = () => c;
  c.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(resolve(rows));
  return c;
}

mock.module('../lib/db', () => ({
  db: {
    select: () => chain(storedRow ? [storedRow] : []),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return chain([]);
      },
    }),
  },
}));

mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb-test',
}));

mock.module('../channels/slack-api', () => ({
  describeSlackConversation: async () => {
    slackCalls += 1;
    return slackLabel;
  },
}));

const { backfillSlackBindingLabel, resetSlackLabelMissesForTest } = await import('../channels/slack/binding-label');

beforeEach(() => {
  storedRow = { channelName: null, channelType: null };
  updates.length = 0;
  slackCalls = 0;
  slackLabel = { name: null, type: null, unavailable: false };
  resetSlackLabelMissesForTest();
});

afterAll(() => {
  mock.restore();
});

describe('backfillSlackBindingLabel', () => {
  test('a stored name answers without asking Slack', async () => {
    storedRow = { channelName: 'general', channelType: 'channel' };

    expect(await backfillSlackBindingLabel('T0TEST', 'C0TEST1', 'project-1')).toEqual({
      name: 'general',
      type: 'channel',
      unavailable: false,
    });
    expect(slackCalls).toBe(0);
  });

  test('a channel Slack names is stored with its type', async () => {
    slackLabel = { name: 'launch-plan', type: 'private_channel', unavailable: false };

    const label = await backfillSlackBindingLabel('T0TEST', 'C0TEST2', 'project-1');

    expect(label as Label).toEqual(slackLabel);
    expect(updates).toEqual([{ channelName: 'launch-plan', channelType: 'private_channel' }]);
  });

  test("a direct message is stored under the other person's name", async () => {
    slackLabel = { name: 'Sam Rivera', type: 'im', unavailable: false };

    await backfillSlackBindingLabel('T0TEST', 'D0TEST1', 'project-1');

    expect(updates).toEqual([{ channelName: 'Sam Rivera', channelType: 'im' }]);
  });

  test('an unavailable channel is reported, stored as nothing, and not asked again for 10 minutes', async () => {
    slackLabel = { name: null, type: null, unavailable: true };

    expect((await backfillSlackBindingLabel('T0TEST', 'C0GONE1', 'project-1')).unavailable).toBe(true);
    expect((await backfillSlackBindingLabel('T0TEST', 'C0GONE1', 'project-1')).unavailable).toBe(true);

    expect(slackCalls).toBe(1);
    expect(updates).toEqual([]);
  });

  test('a DM whose person Slack cannot name keeps its type and is not asked again at once', async () => {
    slackLabel = { name: null, type: 'im', unavailable: false };

    await backfillSlackBindingLabel('T0TEST', 'D0TEST2', 'project-1');
    await backfillSlackBindingLabel('T0TEST', 'D0TEST2', 'project-1');

    expect(slackCalls).toBe(1);
    expect(updates).toEqual([{ channelType: 'im' }]);
  });

  test('a channel that is not bound answers nothing and asks Slack nothing', async () => {
    storedRow = null;

    expect(await backfillSlackBindingLabel('T0TEST', 'C0TEST3', 'project-1')).toEqual({
      name: null,
      type: null,
      unavailable: false,
    });
    expect(slackCalls).toBe(0);
  });
});
