import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from '../../__tests__/helpers/chat-identity-stub';

// core/settings.ts is the one place a chat channel's settings change. These
// pin its rules through its interface; the Slack and Teams adapter tests pin
// the wording.

let bound: string | null = 'proj-1';
let installed = true;
const inserts: unknown[] = [];
let deletes = 0;
function chain(rows: () => unknown[]): any {
  const c: any = {};
  for (const m of ['from', 'where', 'limit']) c[m] = () => c;
  c.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(resolve(rows()));
  return c;
}
mock.module('../../shared/db', () => ({
  db: {
    select: () => chain(() => (installed ? [{ id: 'install-1' }] : [])),
    insert: () => ({
      values: (v: unknown) => {
        inserts.push(v);
        return { onConflictDoUpdate: async () => [] };
      },
    }),
    delete: () => {
      deletes++;
      return chain(() => []);
    },
  },
  hasDatabase: () => true,
}));

const allowed = new Set<string>();
const checked: string[] = [];
const actions: string[] = [];
mock.module('./identity', () =>
  chatIdentityStub({
    resolveProjectChatActor: async (_user: unknown, projectId: string, action: string) => {
      checked.push(projectId);
      actions.push(action);
      return allowed.has(projectId) ? { userId: 'user-1' } : { reason: 'not_member' };
    },
  }),
);

const writes: Array<[string, unknown]> = [];
mock.module('../slack/selection', () => ({
  currentChannelSelection: async () =>
    bound ? { projectId: bound, agentName: null, opencodeModel: null, conversationPolicy: null } : null,
  setChannelAgent: async (_c: unknown, a: string | null) => {
    writes.push(['agent', a]);
    return { ok: true };
  },
  setChannelConversationPolicy: async (_c: unknown, p: string) => {
    writes.push(['policy', p]);
    return true;
  },
}));
const settings = await import('./settings');
const user = { platform: 'slack' as const, workspaceId: 'T1', platformUserId: 'U1' };
const channel = { teamId: 'T1', channelId: 'C1' };

beforeEach(() => {
  bound = 'proj-1';
  installed = true;
  inserts.length = 0;
  deletes = 0;
  allowed.clear();
  allowed.add('proj-1');
  checked.length = 0;
  actions.length = 0;
  writes.length = 0;
});

describe('every setting is checked against the bound project', () => {
  test('without the capability nothing is written, and the bound project is the one checked', async () => {
    allowed.clear();
    expect(await settings.authorizeChannelChange(user, channel)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await settings.changeChannelAgent(user, channel, 'reviewer')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await settings.changeChannelPolicy(user, channel, 'owner_only')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await settings.unbindChannel(user, channel)).toEqual({ ok: false, reason: 'forbidden' });
    expect(writes).toEqual([]);
    expect(deletes).toBe(0);
    expect(checked).toEqual(['proj-1', 'proj-1', 'proj-1', 'proj-1']);
  });

  test('an unbound channel has no settings to change', async () => {
    bound = null;
    expect(await settings.authorizeChannelChange(user, channel)).toEqual({ ok: false, reason: 'no_binding' });
    expect(checked).toEqual([]);
  });
});

describe('shared channel versus one-to-one conversation', () => {
  test('a shared channel needs project.connector.write', async () => {
    await settings.authorizeChannelChange(user, channel);
    expect(actions).toEqual(['project.connector.write']);
  });

  test('a DM or personal chat with the bot needs project.write, the bar for sending a message', async () => {
    expect(await settings.authorizeChannelChange(user, { ...channel, oneToOne: true })).toMatchObject({ ok: true });
    await settings.changeChannelAgent(user, { ...channel, oneToOne: true }, 'reviewer');
    expect(actions).toEqual(['project.write', 'project.write']);
    expect(writes).toEqual([['agent', 'reviewer']]);
  });
});

describe('switch', () => {
  test('re-pointing a bound channel needs the capability on both projects', async () => {
    expect(await settings.switchChannelProject(user, channel, 'proj-2')).toEqual({ ok: false, reason: 'forbidden' });
    expect(checked).toEqual(['proj-1', 'proj-2']);
    expect(inserts).toEqual([]);

    allowed.add('proj-2');
    expect(await settings.switchChannelProject(user, channel, 'proj-2')).toEqual({ ok: true });
    expect(inserts).toEqual([{ platform: 'slack', workspaceId: 'T1', channelId: 'C1', projectId: 'proj-2', pickerTs: null }]);
  });

  test('without the capability on the bound project, the target does not matter', async () => {
    allowed.clear();
    allowed.add('proj-2');
    expect(await settings.switchChannelProject(user, channel, 'proj-2')).toEqual({ ok: false, reason: 'forbidden' });
    expect(checked).toEqual(['proj-1']);
  });

  test('the first binding of an unbound channel stays open, as the project picker is', async () => {
    bound = null;
    allowed.clear();
    expect(await settings.switchChannelProject(user, channel, 'proj-2')).toEqual({ ok: true });
    expect(checked).toEqual([]);
  });

  test('a project not installed in the workspace is refused', async () => {
    installed = false;
    allowed.add('proj-2');
    expect(await settings.switchChannelProject(user, channel, 'proj-2')).toEqual({ ok: false, reason: 'not_installed' });
    expect(inserts).toEqual([]);
  });
});
