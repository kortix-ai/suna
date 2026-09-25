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
mock.module('./identity', () =>
  chatIdentityStub({
    resolveProjectChatActor: async (_user: unknown, projectId: string) => {
      checked.push(projectId);
      return allowed.has(projectId) ? { userId: 'user-1' } : { reason: 'not_member' };
    },
  }),
);

const writes: Array<[string, unknown]> = [];
mock.module('../slack/selection', () => ({
  currentChannelSelection: async () =>
    bound ? { projectId: bound, agentName: null, opencodeModel: null, conversationPolicy: null } : null,
  setChannelModel: async (_c: unknown, m: string | null) => {
    writes.push(['model', m]);
    return true;
  },
  setChannelAgent: async (_c: unknown, a: string | null) => {
    writes.push(['agent', a]);
    return { ok: true };
  },
  setChannelConversationPolicy: async (_c: unknown, p: string) => {
    writes.push(['policy', p]);
    return true;
  },
}));
let gateway = true;
mock.module('../slack/model-gate', () => ({
  channelModelContext: async () => ({
    projectId: 'proj-1',
    accountId: 'acct-1',
    ownerUserId: 'owner-1',
    freeManagedOnly: false,
    llmGatewayEnabled: gateway,
  }),
}));
let servable = true;
mock.module('../../llm-gateway/resolution/default-model', () => ({ isModelServableForAccount: async () => servable }));

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
  writes.length = 0;
  gateway = true;
  servable = true;
});

describe('every setting is checked against the bound project', () => {
  test('without the capability nothing is written, and the bound project is the one checked', async () => {
    allowed.clear();
    expect(await settings.changeChannelModel(user, channel, 'default')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await settings.changeChannelAgent(user, channel, 'reviewer')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await settings.changeChannelPolicy(user, channel, 'owner_only')).toEqual({ ok: false, reason: 'forbidden' });
    expect(await settings.unbindChannel(user, channel)).toEqual({ ok: false, reason: 'forbidden' });
    expect(writes).toEqual([]);
    expect(deletes).toBe(0);
    expect(checked).toEqual(['proj-1', 'proj-1', 'proj-1', 'proj-1']);
  });

  test('an unbound channel has no settings to change', async () => {
    bound = null;
    expect(await settings.changeChannelModel(user, channel, 'default')).toEqual({ ok: false, reason: 'no_binding' });
    expect(checked).toEqual([]);
  });
});

describe('model', () => {
  test('default resets; a servable gateway id is stored as its OpenCode ref', async () => {
    expect(await settings.changeChannelModel(user, channel, 'default')).toEqual({ ok: true, model: null, native: false });
    const set = await settings.changeChannelModel(user, channel, 'kortix/glm-5.3-flash');
    expect(set).toMatchObject({ ok: true, native: false });
    expect(writes).toHaveLength(2);
  });

  test('an unservable, a spaced, or a non-native id is refused without a write', async () => {
    servable = false;
    expect(await settings.changeChannelModel(user, channel, 'nope/model')).toEqual({ ok: false, reason: 'not_servable' });
    expect(await settings.changeChannelModel(user, channel, 'a b')).toEqual({ ok: false, reason: 'invalid_id' });
    gateway = false;
    expect(await settings.changeChannelModel(user, channel, 'no-slash')).toEqual({ ok: false, reason: 'not_native' });
    expect(writes).toEqual([]);
  });

  test('a native project stores a provider/model ref verbatim', async () => {
    gateway = false;
    expect(await settings.changeChannelModel(user, channel, 'anthropic/claude-sonnet-4-6')).toEqual({
      ok: true,
      model: 'anthropic/claude-sonnet-4-6',
      native: true,
    });
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
