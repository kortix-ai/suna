/**
 * The decisions of the Slack write confinement, against a fake ownership
 * source. The SQL behind the real source is proven on PostgreSQL in
 * `__tests__/integration-channel-write-scope.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { CHANNEL_READ_SCOPES, CONVERSATION_NOT_IN_PROJECT, type ChannelOwnership } from './channel-read-scope';
import { SLACK_WRITE_TARGETS, gateChannelWrite, slackWriteRefusal } from './channel-write-scope';
import { channelCatalog } from './channels';

const MINE = 'project-mine';
const OTHER = 'project-other';

interface Rows {
  workspaces?: string[];
  /** Channel id → the project it is bound to. */
  channels?: Record<string, string>;
  /** Thread root ts → the project whose session owns it. */
  threads?: Record<string, string>;
}

const ROWS: Rows = {
  channels: { C0MINE0001: MINE, C0OTHER001: OTHER, D0OTHERDM1: OTHER },
  threads: { '100.000100': OTHER, '200.000200': MINE },
};

function fake(rows: Rows = ROWS) {
  const lookups: string[] = [];
  const ownership: ChannelOwnership = {
    async installs() {
      lookups.push('installs');
      return { workspaceIds: rows.workspaces ?? ['T0SHARED'], shared: true };
    },
    async channelProjects(_p, _w, ids) {
      lookups.push(`channels:${ids.join(',')}`);
      return new Map(ids.filter((id) => rows.channels?.[id]).map((id) => [id, new Set([rows.channels![id]!])]));
    },
    async threadOwners(_p, _w, ids) {
      lookups.push(`threads:${ids.join(',')}`);
      return new Map(ids.filter((id) => rows.threads?.[id]).map((id) => [id, rows.threads![id]!]));
    },
  };
  return { ownership, lookups };
}

async function write(actionPath: string, args: Record<string, unknown>, rows?: Rows) {
  return (await gateChannelWrite({ projectId: MINE, platform: 'slack', actionPath, args }, fake(rows).ownership)).refusal;
}

async function refused(actionPath: string, args: Record<string, unknown>, rows?: Rows): Promise<string> {
  const refusal = await write(actionPath, args, rows);
  expect(refusal?.reason).toBe(CONVERSATION_NOT_IN_PROJECT);
  return refusal!.message;
}

describe('every Slack write is classified', () => {
  test('the write table covers exactly the catalog actions that are not reads', () => {
    const writes = channelCatalog('slack')
      .filter((a) => a.risk !== 'read')
      .map((a) => a.path)
      .sort();
    expect(Object.keys(SLACK_WRITE_TARGETS).sort()).toEqual(writes);
    expect(writes).toEqual(
      Object.entries(CHANNEL_READ_SCOPES.slack)
        .filter(([, scope]) => scope === 'write')
        .map(([path]) => path)
        .sort(),
    );
  });

  test('reads, other platforms and email are left to their own gates', async () => {
    expect(await write('get_history', { channel: 'C0OTHER001' })).toBeNull();
    expect(
      (await gateChannelWrite({ projectId: MINE, platform: 'email', actionPath: 'send_message', args: {} }, fake().ownership))
        .refusal,
    ).toBeNull();
    expect(
      (await gateChannelWrite({ projectId: MINE, platform: 'teams', actionPath: 'list_messages', args: {} }, fake().ownership))
        .refusal,
    ).toBeNull();
  });
});

describe('Slack posts', () => {
  test("a new message: this project's channel and a channel no project owns are fine, another project's channel is refused", async () => {
    expect(await write('send_message', { channel: 'C0MINE0001', text: 'hi' })).toBeNull();
    expect(await write('send_message', { channel: 'C0NOBODY01', text: 'hi' })).toBeNull();
    expect(await refused('send_message', { channel: 'C0OTHER001', text: 'hi' })).toBe(
      "Slack conversation C0OTHER001 belongs to another Kortix project. This project's agent does not post in, change, or react to messages in another project's channels. Post in a channel of this project, in a channel no project is connected to, or in a direct message.",
    );
  });

  test("a direct message reaches a person even when that person's DM is bound to another project", async () => {
    expect(await write('send_message', { channel: 'D0OTHERDM1', text: 'build is green' })).toBeNull();
    expect(await write('send_message', { channel: 'U0PERSON01', text: 'build is green' })).toBeNull();
    expect(await write('send_message', { channel: 'W0PERSON01', text: 'build is green' })).toBeNull();
  });

  test("a reply into another project's thread is refused everywhere, even in a DM or this project's channel", async () => {
    for (const channel of ['D0OTHERDM1', 'U0PERSON01', 'C0MINE0001', 'C0NOBODY01']) {
      expect(await refused('send_message', { channel, thread_ts: '100.000100', text: 'hi' })).toBe(
        `Slack thread 100.000100 in ${channel} belongs to another Kortix project. This project's agent does not post in, change, or react to another project's threads.`,
      );
    }
  });

  test("a reply into this project's own thread is fine, even inside another project's channel", async () => {
    expect(await write('send_message', { channel: 'C0OTHER001', thread_ts: '200.000200', text: 'follow-up' })).toBeNull();
  });

  test("a reply into a thread no session owns follows the channel: adopting a thread in another project's channel is refused", async () => {
    expect(await write('send_message', { channel: 'C0NOBODY01', thread_ts: '300.000300', text: 'hi' })).toBeNull();
    expect(await refused('send_message', { channel: 'C0OTHER001', thread_ts: '300.000300', text: 'hi' })).toContain(
      'Slack conversation C0OTHER001 belongs to another Kortix project',
    );
  });
});

describe('Slack edits, deletes, reactions and joins', () => {
  test("they need the message ts, and another project's thread root is refused", async () => {
    for (const [action, arg] of [
      ['update_message', 'ts'],
      ['delete_message', 'ts'],
      ['add_reaction', 'timestamp'],
      ['remove_reaction', 'timestamp'],
    ] as const) {
      expect(await refused(action, { channel: 'D0OTHERDM1', name: 'eyes' })).toBe(`\`${arg}\` is required.`);
      expect(await refused(action, { channel: 'D0OTHERDM1', [arg]: '100.000100', name: 'eyes' })).toContain(
        'Slack thread 100.000100',
      );
      expect(await refused(action, { channel: 'C0OTHER001', [arg]: '999.000999', name: 'eyes' })).toContain(
        'Slack conversation C0OTHER001',
      );
      expect(await write(action, { channel: 'C0OTHER001', [arg]: '200.000200', name: 'eyes' })).toBeNull();
      expect(await write(action, { channel: 'D0OTHERDM1', [arg]: '999.000999', name: 'eyes' })).toBeNull();
    }
  });

  test("joining another project's channel is refused; any other channel is fine", async () => {
    expect(await refused('join_channel', { channel: 'C0OTHER001' })).toContain('Slack conversation C0OTHER001');
    expect(await write('join_channel', { channel: 'C0NOBODY01' })).toBeNull();
  });
});

describe('ids and installs', () => {
  test('a channel name, a lowercase id or a padded id is refused without a lookup: Slack resolves names', async () => {
    for (const channel of ['general', '#general', 'c0other001', ' C0OTHER001', 'C0OTHER001\n', ['C0MINE0001'], 42, undefined]) {
      const { ownership, lookups } = fake();
      const refusal = await slackWriteRefusal(MINE, { channel }, ownership);
      expect(refusal?.kind).toBe('invalid');
      expect(refusal?.message).toContain('`channel` must be one Slack conversation or user id');
      expect(lookups).toEqual([]);
    }
  });

  test('a malformed thread_ts is refused; an empty one means no thread', async () => {
    expect(await refused('send_message', { channel: 'C0MINE0001', thread_ts: 1700000000.0001 })).toBe(
      '`thread_ts` must be one Slack message timestamp, for example 1700000000.000100.',
    );
    expect(await refused('send_message', { channel: 'C0MINE0001', thread_ts: 'latest' })).toContain('`thread_ts`');
    expect(await write('send_message', { channel: 'C0MINE0001', thread_ts: '', text: 'hi' })).toBeNull();
  });

  test('without an install on record no write runs', async () => {
    const { ownership } = fake({ ...ROWS, workspaces: [] });
    expect(await slackWriteRefusal(MINE, { channel: 'C0NOBODY01' }, ownership)).toEqual({
      kind: 'install',
      message:
        'This project has no Slack install on record, so the connector cannot tell which conversations are its own. Connect Slack again in Settings → Channels.',
    });
  });

  test('the refusal kinds the routes map to statuses', async () => {
    const kinds = async (target: Parameters<typeof slackWriteRefusal>[1]) =>
      (await slackWriteRefusal(MINE, target, fake().ownership))?.kind ?? null;
    expect(await kinds({ channel: 'nope' })).toBe('invalid');
    expect(await kinds({ channel: 'D0OTHERDM1', ts: '100.000100' })).toBe('thread');
    expect(await kinds({ channel: 'C0OTHER001' })).toBe('channel');
    expect(await kinds({ channel: 'C0MINE0001', ts: '200.000200' })).toBeNull();
  });
});

describe('where a post landed', () => {
  const gate = (actionPath: string, args: Record<string, unknown>) =>
    gateChannelWrite({ projectId: MINE, platform: 'slack', actionPath, args }, fake().ownership);

  test('a post that landed in the checked conversation, or a DM for a user id, stands', async () => {
    expect((await gate('send_message', { channel: 'C0NOBODY01', text: 'hi' })).misfire({ ok: true, channel: 'C0NOBODY01', ts: '1.2' })).toBeNull();
    expect((await gate('send_message', { channel: 'U0PERSON01', text: 'hi' })).misfire({ ok: true, channel: 'D0PERSON01', ts: '1.2' })).toBeNull();
    expect((await gate('send_message', { channel: 'U0PERSON01', text: 'hi' })).misfire({ ok: true, channel: 'U0PERSON01', ts: '1.2' })).toBeNull();
  });

  test('a post Slack delivered elsewhere (a resolved name) is refused, with the call that takes it back', async () => {
    const byName = await gate('send_message', { channel: 'GENERAL', text: 'hi' });
    expect(byName.refusal).toBeNull();
    expect(byName.misfire({ ok: true, channel: 'C0OTHER001', ts: '1700000900.000900' })).toEqual({
      refusal: {
        reason: CONVERSATION_NOT_IN_PROJECT,
        message:
          'Slack posted the message to C0OTHER001, not to GENERAL, the conversation that was checked. Address a conversation by its id.',
      },
      undo: { path: '/chat.delete', args: { channel: 'C0OTHER001', ts: '1700000900.000900' } },
    });
    // "User id" that Slack read as a channel name: it landed in a channel, not a DM.
    expect((await gate('send_message', { channel: 'UIUX', text: 'hi' })).misfire({ ok: true, channel: 'C0UIUX0001', ts: '1.2' })?.undo)
      .toEqual({ path: '/chat.delete', args: { channel: 'C0UIUX0001', ts: '1.2' } });
    // An answer that names no conversation cannot be trusted or taken back.
    expect((await gate('send_message', { channel: 'C0NOBODY01', text: 'hi' })).misfire({ ok: true })?.undo).toBeNull();
  });

  test('only a post is checked where it landed: every other write takes an id', async () => {
    const reaction = await gate('add_reaction', { channel: 'C0MINE0001', timestamp: '1.2', name: 'eyes' });
    expect(reaction.misfire({ ok: true, channel: 'C0ELSEWHERE' })).toBeNull();
  });
});
