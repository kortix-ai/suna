import { beforeEach, describe, expect, mock, test } from 'bun:test';

// A Teams channel binding is one thread (`19:…;messageid=…`). Its message
// carries the team's id but rarely its name, so a thread read as "General" in
// every channel of every team. The name now comes from the Bot Connector.

const TEAM = '19:team-root@thread.tacv2';
const DESIGN = '19:design@thread.tacv2';
const SERVICE_URL = 'https://smba.trafficmanager.net/emea/tenant-1/';

let teams: Record<string, { id: string; name: string } | null> = {};
let channels: Record<string, Array<{ id: string; name: string | null }> | null> = {};
const reads: string[] = [];
mock.module('../services/channels/teams-api', () => ({
  getTeamsTeam: async (_serviceUrl: string, teamId: string) => {
    reads.push(`team ${teamId}`);
    return teams[teamId] ?? null;
  },
  listTeamsTeamChannels: async (_serviceUrl: string, teamId: string) => {
    reads.push(`channels ${teamId}`);
    return channels[teamId] ?? null;
  },
}));

const ensured: Array<Record<string, unknown>> = [];
mock.module('../services/channels/teams/binding', () => ({
  ensureTeamsConversationBinding: async (input: Record<string, unknown>) => {
    ensured.push(input);
    return true;
  },
}));

const updates: Array<Record<string, unknown>> = [];
mock.module('../lib/db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  },
  hasDatabase: () => true,
}));

const {
  backfillTeamsBindingLabel,
  labelTeamsChannelBinding,
  needsTeamsNameBackfill,
  resetTeamsChannelLabelsForTest,
  resolveTeamsChannelName,
} = await import('../services/channels/teams/channel-label');

beforeEach(() => {
  resetTeamsChannelLabelsForTest();
  teams = { [TEAM]: { id: TEAM, name: 'Eng' } };
  channels = { [TEAM]: [{ id: TEAM, name: null }, { id: DESIGN, name: 'Design' }] };
  reads.length = 0;
  ensured.length = 0;
  updates.length = 0;
});

const resolve = (channelId: string, teamId = TEAM) =>
  resolveTeamsChannelName({ serviceUrl: SERVICE_URL, teamId, channelId, projectId: 'p1' });

describe('resolveTeamsChannelName', () => {
  test('the General channel is the one whose id is the team id: one read', async () => {
    expect(await resolve(TEAM)).toBe('Eng › General');
    expect(reads).toEqual([`team ${TEAM}`]);
  });

  test('another channel is named from the team channel list', async () => {
    expect(await resolve(DESIGN)).toBe('Eng › Design');
    expect(reads).toEqual([`team ${TEAM}`, `channels ${TEAM}`]);
  });

  test('a team is read once, then served from memory', async () => {
    await resolve(TEAM);
    await resolve(DESIGN);
    await resolve(DESIGN);
    await resolve(TEAM);
    expect(reads).toEqual([`team ${TEAM}`, `channels ${TEAM}`]);
  });

  test('an id that is not a team names nothing, and is not asked again on every read', async () => {
    expect(await resolve(DESIGN, DESIGN)).toBeNull();
    expect(await resolve(DESIGN, DESIGN)).toBeNull();
    expect(reads).toEqual([`team ${DESIGN}`]);
  });

  test('a channel missing from the list names nothing', async () => {
    expect(await resolve('19:gone@thread.tacv2')).toBeNull();
  });
});

describe('labelTeamsChannelBinding', () => {
  const thread = { projectId: 'p1', tenantId: 'tenant-1', conversationId: `${DESIGN};messageid=1700000000001` };
  const channelActivity = {
    serviceUrl: SERVICE_URL,
    conversation: { conversationType: 'channel', id: thread.conversationId },
    channelData: { team: { id: TEAM }, channel: { id: DESIGN } },
  };

  test('names the thread binding `Team › Channel`', async () => {
    await labelTeamsChannelBinding({ ...thread, activity: channelActivity });
    expect(ensured).toEqual([{ ...thread, channelName: 'Eng › Design', channelType: 'channel' }]);
  });

  test('asks Teams nothing when the activity names the team, or for a chat', async () => {
    await labelTeamsChannelBinding({
      ...thread,
      activity: { ...channelActivity, channelData: { team: { id: TEAM, name: 'Eng' }, channel: { id: DESIGN, name: 'Design' } } },
    });
    await labelTeamsChannelBinding({ ...thread, activity: { serviceUrl: SERVICE_URL, conversation: { conversationType: 'personal' } } });
    expect(reads).toEqual([]);
    expect(ensured).toEqual([]);
  });

  test('writes nothing when Teams does not answer', async () => {
    teams = {};
    await labelTeamsChannelBinding({ ...thread, activity: channelActivity });
    expect(ensured).toEqual([]);
  });
});

describe('the bindings list names a stored thread on read', () => {
  test('only a Teams channel thread whose name does not say its team', () => {
    const row = (channelId: string, channelName: string | null, platform = 'teams') => ({ platform, channelId, channelName });
    expect(needsTeamsNameBackfill(row(`${TEAM};messageid=1`, null))).toBe(true);
    expect(needsTeamsNameBackfill(row(`${TEAM};messageid=1`, 'General'))).toBe(true);
    expect(needsTeamsNameBackfill(row(`${TEAM};messageid=1`, 'Eng › General'))).toBe(false);
    expect(needsTeamsNameBackfill(row('19:chat@thread.v2', null))).toBe(false);
    expect(needsTeamsNameBackfill(row('a:1personal', null))).toBe(false);
    expect(needsTeamsNameBackfill(row(`${TEAM};messageid=1`, null, 'slack'))).toBe(false);
  });

  test('a thread of the General channel is named and stored', async () => {
    expect(await backfillTeamsBindingLabel({ bindingId: 'b1', channelId: `${TEAM};messageid=1` }, 'p1', SERVICE_URL)).toBe(
      'Eng › General',
    );
    expect(updates).toEqual([{ channelName: 'Eng › General', channelType: 'channel' }]);
  });

  test('a thread of another channel waits for its next message: its id says no team', async () => {
    teams = {};
    expect(await backfillTeamsBindingLabel({ bindingId: 'b2', channelId: `${DESIGN};messageid=2` }, 'p1', SERVICE_URL)).toBeNull();
    expect(updates).toEqual([]);
  });
});
