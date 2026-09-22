import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { parseTeamsCommand as realParse } from '../channels/teams/util';

/**
 * With the `ChannelMessage.Read.Group` RSC permission, Teams delivers EVERY
 * channel message to the bot. These pin what the bot does with a message that
 * does not @-mention it: continue a thread it already owns, and nothing else.
 */

const PROJECT_ID = '40c2e222-c4c2-47f6-ba40-05e8f40098b3';
const TENANT_ID = '36009a52-46d2-44bc-ba56-57a87e485e0a';
const BOT = '28:bot';

let threadHasSession = false;
const started: string[] = [];
const commands: string[] = [];

function chain(result: unknown[]): any {
  const c: any = {};
  for (const m of ['from', 'where', 'limit', 'values', 'onConflictDoNothing', 'returning', 'set']) c[m] = () => c;
  c.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(result));
  c.catch = () => Promise.resolve(result);
  return c;
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    insert: () => chain([{ eventId: 'fresh' }]),
    delete: () => chain([]),
    select: () => chain([]),
  },
}));
mock.module('../config', () => ({ SANDBOX_VERSION: 'test', config: { FRONTEND_URL: 'https://dev.kortix.com' } }));
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => true }));
mock.module('../channels/teams-api', () => ({ sendCard: async () => 'card-1' }));
mock.module('../channels/teams/binding', () => ({
  resolveConversationProject: async () => PROJECT_ID,
  resolveConversationProjectDetailed: async () => ({ kind: 'project', projectId: PROJECT_ID }),
}));
mock.module('../channels/teams/auth-resume', () => ({ createPendingTeamsPickerMessage: async () => null }));
mock.module('../channels/teams/commands', () => ({
  parseTeamsCommand: realParse,
  handleTeamsCommand: async (input: { command: { verb: string } }) => {
    commands.push(input.command.verb);
    return true;
  },
}));
mock.module('../channels/teams/session', () => ({
  hasConversationSession: async () => threadHasSession,
  createOrJoinTeamsConversationSession: async (input: { conversationId: string }) => {
    started.push(input.conversationId);
  },
}));

const { handleTeamsActivity } = await import('../channels/teams/dispatch');

let n = 0;
function activity(over: Record<string, unknown>) {
  n += 1;
  return {
    type: 'message',
    id: `act-${n}`,
    text: 'hmm',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    recipient: { id: BOT },
    from: { id: '29:ivan', name: 'Ivan Bagaric' },
    conversation: { id: '19:chan@thread.tacv2;messageid=1', conversationType: 'channel', tenantId: TENANT_ID },
    ...over,
  };
}

const mention = [{ type: 'mention', mentioned: { id: BOT, name: 'Kortix Dev' }, text: '<at>Kortix Dev</at>' }];

beforeEach(() => {
  threadHasSession = false;
  started.length = 0;
  commands.length = 0;
});

afterAll(() => mock.restore());

describe('un-mentioned channel messages', () => {
  test('in a thread the bot owns → delivered as a follow-up', async () => {
    threadHasSession = true;
    await handleTeamsActivity(activity({}) as never);
    expect(started).toEqual(['19:chan@thread.tacv2;messageid=1']);
  });

  test('in a thread the bot does not own → ignored, no session started', async () => {
    await handleTeamsActivity(activity({}) as never);
    expect(started).toEqual([]);
  });

  test('a /help typed in a channel without mentioning the bot → ignored (no command runs)', async () => {
    await handleTeamsActivity(activity({ text: '/help' }) as never);
    expect(commands).toEqual([]);
    expect(started).toEqual([]);
  });

  test('an un-mentioned follow-up that looks like a command is still just text for the session', async () => {
    threadHasSession = true;
    await handleTeamsActivity(activity({ text: '/status' }) as never);
    expect(commands).toEqual([]);
    expect(started).toHaveLength(1);
  });
});

describe('mentioned and personal messages are unchanged', () => {
  test('a mention in a channel starts a session even with no owned thread', async () => {
    await handleTeamsActivity(activity({ text: '<at>Kortix Dev</at> summarize the README', entities: mention }) as never);
    expect(started).toHaveLength(1);
  });

  test('a mentioned /help in a channel runs the command', async () => {
    await handleTeamsActivity(activity({ text: '<at>Kortix Dev</at> /help', entities: mention }) as never);
    expect(commands).toEqual(['help']);
  });

  test('a personal-chat message needs no mention and no owned thread', async () => {
    await handleTeamsActivity(
      activity({ conversation: { id: 'a:personal', conversationType: 'personal', tenantId: TENANT_ID } }) as never,
    );
    expect(started).toEqual(['a:personal']);
  });
});
