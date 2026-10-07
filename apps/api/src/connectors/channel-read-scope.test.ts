/**
 * The decisions of the Slack/Teams read confinement, against a fake ownership
 * source. The SQL behind the real source is proven on PostgreSQL in
 * `__tests__/integration-channel-read-scope.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import {
  CHANNEL_READ_SCOPES,
  CONVERSATION_NOT_IN_PROJECT,
  type ChannelOwnership,
  type ChannelReadGate,
  gateChannelRead,
} from './channel-read-scope';
import { channelCatalog } from './channels';

const MINE = 'project-mine';
const OTHER = 'project-other';
const WS = 'T0WORKSPACE';

interface Rows {
  /** No install on record when empty. */
  workspaces?: string[];
  /** Another project is connected to the workspace. */
  shared?: boolean;
  /** Normalized channel id → projects with a conversation in it. */
  channels?: Record<string, string[]>;
  /** Normalized thread id → owning project. */
  threads?: Record<string, string>;
}

function fake(rows: Rows) {
  const lookups: string[] = [];
  const ownership: ChannelOwnership = {
    async installs() {
      lookups.push('installs');
      return { workspaceIds: rows.workspaces ?? [WS], shared: rows.shared ?? false };
    },
    async channelProjects(_platform, _ws, ids) {
      lookups.push(`channels:${ids.join(',')}`);
      return new Map(ids.filter((id) => rows.channels?.[id]).map((id) => [id, new Set(rows.channels![id])]));
    },
    async threadOwners(_platform, _ws, ids) {
      lookups.push(`threads:${ids.join(',')}`);
      return new Map(ids.filter((id) => rows.threads?.[id]).map((id) => [id, rows.threads![id]!]));
    },
  };
  return { ownership, lookups };
}

function gate(
  rows: Rows,
  platform: string,
  actionPath: string,
  args: Record<string, unknown> = {},
  risk = 'read',
): Promise<ChannelReadGate> {
  return gateChannelRead({ projectId: MINE, platform, actionPath, args, risk }, fake(rows).ownership);
}

function refusalOf(g: ChannelReadGate): string {
  expect(g.refusal?.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  return g.refusal!.message;
}

async function answered(g: ChannelReadGate, data: unknown): Promise<unknown> {
  expect(g.refusal).toBeNull();
  const res = await g.answer(data);
  if ('refusal' in res) throw new Error(`answer refused: ${res.refusal.message}`);
  return res.data;
}

async function answerRefusal(g: ChannelReadGate, data: unknown): Promise<string> {
  expect(g.refusal).toBeNull();
  const res = await g.answer(data);
  if (!('refusal' in res)) throw new Error('answer was not refused');
  expect(res.refusal.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  return res.refusal.message;
}

describe('every catalog action is classified', () => {
  for (const platform of ['slack', 'teams'] as const) {
    test(`${platform}: the scope table covers exactly the catalog, and only non-reads are writes`, () => {
      const catalog = channelCatalog(platform);
      expect(Object.keys(CHANNEL_READ_SCOPES[platform]).sort()).toEqual(catalog.map((a) => a.path).sort());
      for (const action of catalog) {
        const scope = CHANNEL_READ_SCOPES[platform][action.path];
        expect(`${action.path}:${scope === 'write'}`).toBe(`${action.path}:${action.risk !== 'read'}`);
      }
    });
  }

  test('an unclassified read is refused; an unclassified write and other platforms pass', async () => {
    expect(refusalOf(await gate({}, 'slack', 'pins_list'))).toContain('pins_list');
    expect((await gate({}, 'slack', 'pins_add', {}, 'write')).refusal).toBeNull();
    expect((await gate({}, 'email', 'list_messages')).refusal).toBeNull();
    expect((await gate({}, 'slack', 'constructor')).refusal?.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  });

  test('directory reads and writes run without a single ownership lookup', async () => {
    for (const [platform, action] of [
      ['slack', 'list_users'],
      ['slack', 'auth_test'],
      ['slack', 'send_message'],
      ['teams', 'get_user'],
      ['teams', 'list_teams'],
    ] as const) {
      const { ownership, lookups } = fake({ shared: true });
      const g = await gateChannelRead(
        { projectId: MINE, platform, actionPath: action, args: { channel: 'C0OTHER' }, risk: 'read' },
        ownership,
      );
      expect(g.refusal).toBeNull();
      expect(await g.answer({ ok: true })).toEqual({ data: { ok: true } });
      expect(lookups).toEqual([]);
    }
  });
});

describe('Slack channel reads (get_history)', () => {
  const rows: Rows = { shared: true, channels: { C0MINE: [MINE], C0OTHER: [OTHER] } };

  test("this project's channel is read; another project's is refused before the call", async () => {
    expect((await gate(rows, 'slack', 'get_history', { channel: 'C0MINE' })).refusal).toBeNull();
    expect(refusalOf(await gate(rows, 'slack', 'get_history', { channel: 'C0OTHER' }))).toBe(
      "Slack conversation C0OTHER belongs to another Kortix project. This project's Slack connector reads only its own conversations.",
    );
  });

  test('a lowercase id is looked up as the uppercase id Slack stores', async () => {
    expect(refusalOf(await gate(rows, 'slack', 'get_history', { channel: 'c0other' }))).toContain('another Kortix project');
  });

  test('a conversation no project owns: read while alone in the workspace, refused once it is shared', async () => {
    expect((await gate({ shared: false }, 'slack', 'get_history', { channel: 'D0UNBOUND' })).refusal).toBeNull();
    expect(refusalOf(await gate({ shared: true }, 'slack', 'get_history', { channel: 'D0UNBOUND' }))).toContain(
      'run `/kortix switch` in that conversation',
    );
  });

  test('without an install on record nothing is readable, not even an unowned conversation', async () => {
    expect(refusalOf(await gate({ workspaces: [] }, 'slack', 'get_history', { channel: 'C0ANY' }))).toContain(
      'no Slack install on record',
    );
  });

  test('an id of any other shape is refused without a lookup', async () => {
    for (const channel of [['C0MINE', 'C0OTHER'], ' C0OTHER', 'C0OTHER\n', '', 'C0-OTHER', undefined]) {
      const { ownership, lookups } = fake(rows);
      const g = await gateChannelRead(
        { projectId: MINE, platform: 'slack', actionPath: 'get_history', args: { channel }, risk: 'read' },
        ownership,
      );
      expect(refusalOf(g)).toContain('`channel` must be one Slack conversation id');
      expect(lookups).toEqual(['installs']);
    }
  });

  test('the answer drops every message of a thread another project owns: its root and its broadcasts', async () => {
    const g = await gate({ ...rows, threads: { '100.1': OTHER, '200.2': MINE } }, 'slack', 'get_history', { channel: 'C0MINE' });
    const data = await answered(g, {
      ok: true,
      has_more: false,
      messages: [
        { ts: '300.3', text: 'plain' },
        { ts: '200.2', thread_ts: '200.2', text: 'mine' },
        { ts: '100.1', thread_ts: '100.1', text: 'other root' },
        { ts: '150.5', thread_ts: '100.1', subtype: 'thread_broadcast', text: 'other broadcast' },
      ],
    });
    expect(data).toEqual({
      ok: true,
      has_more: false,
      messages: [
        { ts: '300.3', text: 'plain' },
        { ts: '200.2', thread_ts: '200.2', text: 'mine' },
      ],
    });
  });
});

describe('Slack thread reads (get_thread)', () => {
  test("this project's thread is read even inside another project's channel", async () => {
    const rows: Rows = { shared: true, channels: { C0OTHER: [OTHER] }, threads: { '100.1': MINE } };
    expect((await gate(rows, 'slack', 'get_thread', { channel: 'C0OTHER', ts: '100.1' })).refusal).toBeNull();
  });

  test("another project's thread is refused even inside this project's channel", async () => {
    const rows: Rows = { shared: true, channels: { C0MINE: [MINE] }, threads: { '100.1': OTHER } };
    expect(refusalOf(await gate(rows, 'slack', 'get_thread', { channel: 'C0MINE', ts: '100.1' }))).toBe(
      "Slack thread 100.1 in C0MINE belongs to another Kortix project. This project's Slack connector reads only its own conversations.",
    );
  });

  test('a thread no session owns follows its channel', async () => {
    const rows: Rows = { shared: true, channels: { C0MINE: [MINE], C0OTHER: [OTHER] } };
    expect((await gate(rows, 'slack', 'get_thread', { channel: 'C0MINE', ts: '100.1' })).refusal).toBeNull();
    expect(refusalOf(await gate(rows, 'slack', 'get_thread', { channel: 'C0OTHER', ts: '100.1' }))).toContain(
      'another Kortix project',
    );
    expect(refusalOf(await gate(rows, 'slack', 'get_thread', { channel: 'C0MINE', ts: 'latest' }))).toContain('`ts`');
  });

  test("a reply's ts that Slack answers with another project's thread is refused on the answer", async () => {
    const rows: Rows = { shared: true, channels: { C0MINE: [MINE] }, threads: { '100.1': OTHER } };
    const g = await gate(rows, 'slack', 'get_thread', { channel: 'C0MINE', ts: '150.5' });
    const message = await answerRefusal(g, {
      ok: true,
      messages: [
        { ts: '100.1', thread_ts: '100.1', text: 'other root' },
        { ts: '150.5', thread_ts: '100.1', text: 'other reply' },
      ],
    });
    expect(message).toContain('another Kortix project');
  });

  test('the checked thread itself is not looked up again on the answer', async () => {
    const { ownership, lookups } = fake({ shared: true, threads: { '100.1': MINE } });
    const g = await gateChannelRead(
      { projectId: MINE, platform: 'slack', actionPath: 'get_thread', args: { channel: 'C0ANY', ts: '100.1' }, risk: 'read' },
      ownership,
    );
    await answered(g, { ok: true, messages: [{ ts: '100.1', thread_ts: '100.1' }, { ts: '100.2', thread_ts: '100.1' }] });
    expect(lookups).toEqual(['installs', 'threads:100.1']);
  });
});

describe('Slack reads decided on the answer', () => {
  const rows: Rows = { shared: true, channels: { C0MINE: [MINE], G0MINE: [MINE], C0OTHER: [OTHER], G0OTHER: [OTHER], D0MINE: [MINE], D0OTHER: [OTHER] } };

  test('list_channels keeps public channels and this project\'s private conversations only', async () => {
    const data = await answered(await gate(rows, 'slack', 'list_channels'), {
      ok: true,
      channels: [
        { id: 'C0PUBLIC', is_private: false, is_channel: true },
        { id: 'C0OTHER', is_private: false, is_channel: true },
        { id: 'G0MINE', is_private: true },
        { id: 'G0OTHER', is_private: true },
        { id: 'G0UNOWNED', is_private: true },
        { id: 'D0MINE', is_im: true },
        { id: 'D0OTHER', is_im: true, is_private: false },
        { id: 'C0NOFLAG' },
      ],
      response_metadata: { next_cursor: '' },
    });
    expect((data as { channels: Array<{ id: string }> }).channels.map((c) => c.id)).toEqual([
      'C0PUBLIC',
      'C0OTHER',
      'G0MINE',
      'D0MINE',
    ]);
  });

  test('list_channels keeps unowned private conversations while this project is alone', async () => {
    const data = await answered(await gate({ shared: false }, 'slack', 'list_channels'), {
      ok: true,
      channels: [{ id: 'G0UNOWNED', is_private: true }],
    });
    expect((data as { channels: unknown[] }).channels).toHaveLength(1);
  });

  test('channel_info: a public channel is directory data; a private one follows its owner', async () => {
    const publicInfo = { ok: true, channel: { id: 'C0OTHER', is_private: false, name: 'general' } };
    expect(await answered(await gate(rows, 'slack', 'channel_info', { channel: 'C0OTHER' }), publicInfo)).toEqual(publicInfo);
    const privateInfo = { ok: true, channel: { id: 'G0OTHER', is_private: true, name: 'secret' } };
    expect(await answerRefusal(await gate(rows, 'slack', 'channel_info', { channel: 'G0OTHER' }), privateInfo)).toContain(
      'Slack conversation G0OTHER belongs to another Kortix project',
    );
    const mineInfo = { ok: true, channel: { id: 'G0MINE', is_private: true } };
    expect(await answered(await gate(rows, 'slack', 'channel_info', { channel: 'G0MINE' }), mineInfo)).toEqual(mineInfo);
  });

  test('file_info: readable when one conversation it is shared in is readable', async () => {
    const file = (channels: string[], groups: string[] = []) => ({ ok: true, file: { id: 'F0FILE', channels, groups, ims: [] } });
    await answered(await gate(rows, 'slack', 'file_info', { file: 'F0FILE' }), file(['C0OTHER'], ['G0MINE']));
    expect(await answerRefusal(await gate(rows, 'slack', 'file_info', { file: 'F0FILE' }), file(['C0OTHER']))).toContain(
      'Slack file F0FILE belongs to another Kortix project',
    );
    expect(await answerRefusal(await gate(rows, 'slack', 'file_info', { file: 'F0FILE' }), file([]))).toContain(
      'connected to more than one Kortix project',
    );
    await answered(await gate({ shared: false }, 'slack', 'file_info', { file: 'F0FILE' }), file([]));
  });

  // A reply in a thread this project's session owns can carry a file, in a
  // channel no project is bound to (or another project's). The prompt tells the
  // agent to download it; the channel alone refused it.
  test('file_info: readable when it is shared in a thread this project owns, in any channel', async () => {
    const threaded = { shared: true, channels: { C0OTHER: [OTHER] }, threads: { '100.1': MINE, '300.3': OTHER } };
    const file = (shares: Record<string, unknown>) => ({
      ok: true,
      file: { id: 'F0FILE', channels: Object.keys(shares), groups: [], ims: [], shares: { public: shares } },
    });
    await answered(
      await gate(threaded, 'slack', 'file_info', { file: 'F0FILE' }),
      file({ C0OTHER: [{ ts: '100.2', thread_ts: '100.1' }] }),
    );
    await answered(
      await gate(threaded, 'slack', 'file_info', { file: 'F0FILE' }),
      file({ C0UNBOUND: [{ ts: '100.3', thread_ts: '100.1' }] }),
    );
    expect(
      await answerRefusal(await gate(threaded, 'slack', 'file_info', { file: 'F0FILE' }), file({ C0OTHER: [{ ts: '200.2' }] })),
    ).toContain('belongs to another Kortix project');
    expect(
      await answerRefusal(
        await gate(threaded, 'slack', 'file_info', { file: 'F0FILE' }),
        file({ C0UNBOUND: [{ ts: '300.4', thread_ts: '300.3' }] }),
      ),
    ).toContain('connected to more than one Kortix project');
  });

  test('search_messages runs only while this project is alone in the workspace', async () => {
    expect(refusalOf(await gate({ shared: true }, 'slack', 'search_messages', { query: 'in:#secret' }))).toContain(
      'a search cannot be limited to this project',
    );
    expect((await gate({ shared: false }, 'slack', 'search_messages', { query: 'hi' })).refusal).toBeNull();
    expect(refusalOf(await gate({ workspaces: [] }, 'slack', 'search_messages', { query: 'hi' }))).toContain('no Slack install');
  });
});

describe('Teams reads', () => {
  const CH = '19:chan@thread.tacv2';
  const ONLY_OTHER = '19:onlyother@thread.tacv2';
  const rows: Rows = {
    shared: true,
    channels: { [CH]: [MINE, OTHER], [ONLY_OTHER]: [OTHER] },
    threads: { [`${CH};messageid=1`]: MINE, [`${CH};messageid=2`]: OTHER },
  };

  test('a channel this project has a conversation in is read; the answer drops other projects\' threads', async () => {
    const g = await gate(rows, 'teams', 'list_messages', { 'team-id': 'team', 'channel-id': CH });
    const data = await answered(g, {
      '@odata.context': 'ctx',
      value: [
        { id: '1', replyToId: null, body: { content: 'mine' } },
        { id: '2', replyToId: null, body: { content: 'other' } },
        { id: '3', replyToId: null, body: { content: 'nobody' } },
      ],
    });
    expect((data as { value: Array<{ id: string }> }).value.map((m) => m.id)).toEqual(['1', '3']);
  });

  test('a channel only other projects have conversations in is refused', async () => {
    expect(refusalOf(await gate(rows, 'teams', 'list_messages', { 'team-id': 't', 'channel-id': ONLY_OTHER }))).toBe(
      "Teams channel 19:onlyother@thread.tacv2 belongs to another Kortix project. This project's Microsoft Teams connector reads only its own conversations.",
    );
  });

  test('a channel no project has a conversation in: read while alone in the tenant, refused once shared', async () => {
    const args = { 'team-id': 't', 'channel-id': '19:quiet@thread.tacv2' };
    expect((await gate({ shared: false }, 'teams', 'list_messages', args)).refusal).toBeNull();
    expect(refusalOf(await gate({ shared: true }, 'teams', 'list_messages', args))).toContain('Mention the bot in that channel');
  });

  test('ids compare lowercase on both sides; other shapes are refused', async () => {
    expect(refusalOf(await gate(rows, 'teams', 'list_messages', { 'channel-id': '19:ONLYOTHER@thread.tacv2' }))).toContain(
      'another Kortix project',
    );
    for (const id of [`${CH};messageid=1`, `${CH} `, '19:a/../b@thread.tacv2', 'chan', 42]) {
      expect(refusalOf(await gate(rows, 'teams', 'list_messages', { 'channel-id': id }))).toContain('`channel-id`');
    }
  });

  test('a thread follows its own owner first, then its channel', async () => {
    const args = (m: string) => ({ 'team-id': 't', 'channel-id': CH, 'message-id': m });
    expect((await gate(rows, 'teams', 'get_message', args('1'))).refusal).toBeNull();
    expect(refusalOf(await gate(rows, 'teams', 'list_replies', args('2')))).toContain('Teams thread 2 in 19:chan@thread.tacv2');
    expect((await gate(rows, 'teams', 'list_replies', args('3'))).refusal).toBeNull();
    expect(refusalOf(await gate(rows, 'teams', 'get_message', args('x')))).toContain('`message-id`');
  });

  test('a message answered from another project\'s thread is refused on the answer', async () => {
    const g = await gate(rows, 'teams', 'get_message', { 'team-id': 't', 'channel-id': CH, 'message-id': '3' });
    expect(await answerRefusal(g, { id: '9', replyToId: '2', body: { content: 'reply' } })).toContain('another Kortix project');
  });

  test('channel metadata: standard channels are directory data, private ones follow their owner', async () => {
    const standard = { id: ONLY_OTHER, membershipType: 'standard', displayName: 'General' };
    expect(await answered(await gate(rows, 'teams', 'get_channel', { 'channel-id': ONLY_OTHER }), standard)).toEqual(standard);
    const priv = { id: ONLY_OTHER, membershipType: 'private', displayName: 'Secret' };
    expect(await answerRefusal(await gate(rows, 'teams', 'get_channel', { 'channel-id': ONLY_OTHER }), priv)).toContain(
      'another Kortix project',
    );
    const list = await answered(await gate(rows, 'teams', 'list_channels', { 'team-id': 't' }), {
      value: [
        { id: ONLY_OTHER, membershipType: 'standard' },
        { id: CH, membershipType: 'private' },
        { id: '19:secret@thread.tacv2', membershipType: 'shared' },
        { id: ONLY_OTHER, membershipType: 'private' },
      ],
    });
    expect((list as { value: Array<{ id: string; membershipType: string }> }).value).toEqual([
      { id: ONLY_OTHER, membershipType: 'standard' },
      { id: CH, membershipType: 'private' },
    ]);
  });
});
