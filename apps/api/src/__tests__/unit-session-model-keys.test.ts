import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sessionProviderSecretPools } from '@kortix/db';

// PUT /sessions/:id/model (services/sessions/session-model-keys.ts). The check used
// the owner's own keys: on dev (2026-09-25) a session shared with the project
// accepted `codex/gpt-6-astra` through its owner's personal ChatGPT
// connection, which the gateway never uses for a shared session — every turn
// would fail with "Connect Codex to use this model".

const OWNER = 'owner-user';
const OTHER = 'other-member';
const PROJECT_KEY = 'project-key';
const OWNER_KEY = 'owner-key';

/** What the gateway resolves as the session's personal user while it stays as it is. */
let gatewayPersonal: string | null = null;
/** False = the agent-principal flag is off: every session keeps its legacy owner. */
let agentPrincipal = true;
mock.module('../projects/lib/personal-resources', () => ({
  // The spec 2026-09-22 §2.3 rule: only a private session reaches a person's keys.
  resolveSessionPersonalOwner: async (input: { legacyUserId: string | null; visibility?: string }) => {
    if (!agentPrincipal) return input.legacyUserId;
    if (input.visibility && input.visibility !== 'private') return null;
    return gatewayPersonal;
  },
}));

// ChatGPT: the owner's own connection serves by default, but only in their
// private session. An API-key model never serves without a selection. Any
// selection serves when it holds a key. A stored selection serves through a
// key shared with the project in any session, through the owner's key only in
// their private one. A Kortix model serves when `managedServable` says so.
const probes: Array<Record<string, unknown>> = [];
let storedKeys: string[] | null = null;
let managedServable = false;
/** The gateway wire id: a stored session model carries OpenCode's `kortix/` prefix. */
const wire = (model: string) => model.replace(/^kortix\//, '');
mock.module('../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async (input: {
    model: string;
    personalUserId?: string | null;
    providerSecretPools?: Record<string, string[]>;
  }) => {
    probes.push(input);
    if (!wire(input.model).includes('/')) return managedServable;
    if (input.providerSecretPools) return Object.values(input.providerSecretPools).some((ids) => ids.length > 0);
    if (storedKeys) {
      return storedKeys.some((id) => id === PROJECT_KEY || (id === OWNER_KEY && input.personalUserId === OWNER));
    }
    return wire(input.model).startsWith('codex/') && input.personalUserId === OWNER;
  },
}));

const keyQueries: Array<Record<string, unknown>> = [];
let projectKeys: string[] = [PROJECT_KEY];
mock.module('../services/secrets/provider-key-selection', () => ({
  providerKeyOf: (model: string) =>
    wire(model).startsWith('codex/')
      ? { providerId: 'codex', envVar: 'CODEX_AUTH_JSON' }
      : wire(model).startsWith('anthropic/')
        ? { providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY' }
        : null,
  usableProviderKeys: async (input: { grantUserId: string | null; model: string }) => {
    keyQueries.push(input);
    const providerId = wire(input.model).startsWith('codex/') ? 'codex' : 'anthropic';
    const ids = [...projectKeys, ...(input.grantUserId === OWNER ? [OWNER_KEY] : [])];
    return ids.length ? { providerId, envVar: 'X', secretIds: ids, labels: ids } : null;
  },
}));

/** Stored selections, as `sessionId/providerId`. */
let selections = new Set<string>();
const selectionQueries: unknown[][] = [];
/** Rows the change stored. */
let stored: Array<{ sessionId: string; providerId: string; secretIds: string[] }> = [];
/** Rows a share stored, replacing any selection for that provider. */
let replaced: Array<{ sessionId: string; providerId: string; secretIds: string[] }> = [];
/** A selection another request stores between the check and the write. */
let concurrentSelection: string | null = null;
const dialect = new PgDialect();
mock.module('../lib/db', () => ({
  db: {
    insert: (table: unknown) => ({
      values: (row: { sessionId: string; providerId: string; secretIds: string[] }) => ({
        onConflictDoUpdate: async (config: { set: { secretIds: string[] } }) => {
          if (table !== sessionProviderSecretPools) throw new Error('unexpected table');
          if (config.set.secretIds !== row.secretIds) throw new Error('an update must store the same keys');
          selections.add(`${row.sessionId}/${row.providerId}`);
          replaced.push({ sessionId: row.sessionId, providerId: row.providerId, secretIds: row.secretIds });
        },
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== sessionProviderSecretPools) throw new Error('unexpected table');
            if (concurrentSelection) selections.add(concurrentSelection);
            const id = `${row.sessionId}/${row.providerId}`;
            if (selections.has(id)) return [];
            selections.add(id);
            stored.push(row);
            return [{ sessionId: row.sessionId }];
          },
        }),
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: SQL) => ({
          limit: async () => {
            if (table !== sessionProviderSecretPools) throw new Error('unexpected table');
            const [sessionId, providerId] = dialect.sqlToQuery(condition).params as string[];
            selectionQueries.push([sessionId, providerId]);
            return selections.has(`${sessionId}/${providerId}`) ? [{ sessionId }] : [];
          },
        }),
      }),
    }),
  },
}));

const { admitSessionModelChange, admitSessionSharingChange } = await import('../services/sessions/session-model-keys');

let callerMaySelect = true;
const change = (over: Partial<Parameters<typeof admitSessionModelChange>[0]> = {}) =>
  admitSessionModelChange({
    accountId: 'acct',
    projectId: 'proj',
    sessionId: 'sess',
    owner: OWNER,
    caller: OWNER,
    freeModelsOnly: false,
    model: 'codex/gpt-6-astra',
    mayPool: true,
    callerMaySelect: async () => callerMaySelect,
    ...over,
  });

beforeEach(() => {
  gatewayPersonal = null;
  agentPrincipal = true;
  probes.length = 0;
  storedKeys = null;
  managedServable = false;
  keyQueries.length = 0;
  projectKeys = [PROJECT_KEY];
  selections = new Set();
  selectionQueries.length = 0;
  stored = [];
  replaced = [];
  concurrentSelection = null;
  callerMaySelect = true;
});

describe('admitSessionModelChange — checked as the gateway runs the session', () => {
  test('a shared session never counts the owner`s own ChatGPT connection; it selects the project`s', async () => {
    expect(await change()).toBe(true);
    expect(probes[0]).toMatchObject({ userId: OWNER, sessionId: 'sess', personalUserId: null });
    expect(keyQueries[0]).toMatchObject({ grantUserId: null });
    expect(stored).toEqual([{ sessionId: 'sess', providerId: 'codex', secretIds: [PROJECT_KEY] }]);
  });

  test('the owner`s private session keeps using their own connection, and selects nothing', async () => {
    gatewayPersonal = OWNER;
    expect(await change()).toBe(true);
    expect(keyQueries).toHaveLength(0);
    expect(stored).toEqual([]);
  });

  test('in the owner`s private session their own keys are selected — only when the owner makes the change', async () => {
    gatewayPersonal = OWNER;
    expect(await change({ model: 'anthropic/claude-opus-4-8' })).toBe(true);
    // A manager changing it gets keys shared with the project, never the owner's.
    selections = new Set();
    expect(await change({ caller: OTHER, model: 'anthropic/claude-opus-4-8' })).toBe(true);
    expect(keyQueries.map((q) => q.grantUserId)).toEqual([OWNER, null]);
    expect(stored).toEqual([
      { sessionId: 'sess', providerId: 'anthropic', secretIds: [PROJECT_KEY, OWNER_KEY] },
      { sessionId: 'sess', providerId: 'anthropic', secretIds: [PROJECT_KEY] },
    ]);
  });

  test('a caller who may not select the keys gets none, and the model is refused', async () => {
    callerMaySelect = false;
    expect(await change()).toBe(false);
    expect(stored).toEqual([]);
  });

  test('a selection made on purpose stays: no new selection, the model is refused', async () => {
    selections.add('sess/codex');
    expect(await change()).toBe(false);
    expect(stored).toEqual([]);
    expect(selectionQueries).toEqual([['sess', 'codex']]);
    expect(keyQueries).toHaveLength(0);
  });

  test('a selection for another provider or another session does not count', async () => {
    selections = new Set(['sess/anthropic', 'other-sess/codex']);
    expect(await change()).toBe(true);
    expect(selectionQueries).toEqual([['sess', 'codex']]);
    expect(stored).toEqual([{ sessionId: 'sess', providerId: 'codex', secretIds: [PROJECT_KEY] }]);
  });

  test('without pooled keys (flag off, or a machine-owned session) nothing is selected', async () => {
    expect(await change({ mayPool: false })).toBe(false);
    expect(keyQueries).toHaveLength(0);
    expect(stored).toEqual([]);
  });

  test('a model no key pays for (a Kortix model) is only checked', async () => {
    expect(await change({ model: 'glm-5.3-flash' })).toBe(false);
    expect(probes).toHaveLength(1);
    expect(stored).toEqual([]);
  });
});

describe('admitSessionModelChange — stores the selection it makes', () => {
  test('a selected pool is stored for exactly this session and provider', async () => {
    expect(await change()).toBe(true);
    expect(stored).toEqual([{ sessionId: 'sess', providerId: 'codex', secretIds: [PROJECT_KEY] }]);
  });

  test('nothing is stored when no selection is made or the model stays refused', async () => {
    gatewayPersonal = OWNER;
    await change();
    projectKeys = [];
    gatewayPersonal = null;
    await change();
    callerMaySelect = false;
    projectKeys = [PROJECT_KEY];
    await change();
    await change({ mayPool: false });
    expect(stored).toEqual([]);
  });

  test('a selection another request stores first wins: the model is judged with it, nothing is overwritten', async () => {
    concurrentSelection = 'sess/codex';
    expect(await change()).toBe(false);
    expect(stored).toEqual([]);
    // The last probe asks as the session is stored, not with the keys this change chose.
    expect(probes.at(-1)).not.toHaveProperty('providerSecretPools');
    expect(probes).toHaveLength(3);
  });
});

// PUT /sessions/:id/sharing. On dev (2026-09-25) a private session that ran on
// a key granted only to its owner was shared with the project (200); the
// gateway then used none of the owner's keys, and the session could no longer
// run its model: `PUT /model` answered 400 INVALID_SESSION_MODEL and every turn
// would have failed with "Connect Codex".
const share = (over: Partial<Parameters<typeof admitSessionSharingChange>[0]> = {}) =>
  admitSessionSharingChange({
    accountId: 'acct',
    projectId: 'proj',
    sessionId: 'sess',
    owner: OWNER,
    freeModelsOnly: false,
    model: 'kortix/codex/gpt-6-astra',
    visibility: 'project',
    mayPool: true,
    callerMaySelect: async () => callerMaySelect,
    ...over,
  });

describe('admitSessionSharingChange — a share never strands the session on a key it cannot use', () => {
  beforeEach(() => {
    gatewayPersonal = OWNER;
  });

  test('a session on its owner`s own ChatGPT connection switches to the project`s', async () => {
    expect(await share()).toEqual({ ok: true });
    expect(replaced).toEqual([{ sessionId: 'sess', providerId: 'codex', secretIds: [PROJECT_KEY] }]);
    // Only keys a shared session can use: never the owner's own.
    expect(keyQueries).toEqual([expect.objectContaining({ userId: OWNER, grantUserId: null })]);
    expect(probes.at(-1)).toMatchObject({ personalUserId: null, providerSecretPools: { codex: [PROJECT_KEY] } });
  });

  test('a selection of keys granted to the owner is replaced by the keys shared with the project', async () => {
    storedKeys = [OWNER_KEY];
    expect(await share({ model: 'kortix/anthropic/claude-opus-4-8' })).toEqual({ ok: true });
    expect(replaced).toEqual([{ sessionId: 'sess', providerId: 'anthropic', secretIds: [PROJECT_KEY] }]);
  });

  test('with no key shared with the project, the share is refused and nothing is stored', async () => {
    projectKeys = [];
    expect(await share()).toEqual({ ok: false, model: 'codex/gpt-6-astra' });
    expect(replaced).toEqual([]);
  });

  test('a caller who may not select the project`s keys is refused, not switched', async () => {
    callerMaySelect = false;
    expect(await share()).toEqual({ ok: false, model: 'codex/gpt-6-astra' });
    expect(replaced).toEqual([]);
  });

  test('without pooled keys there is nothing to switch to: refused', async () => {
    expect(await share({ mayPool: false })).toEqual({ ok: false, model: 'codex/gpt-6-astra' });
    expect(keyQueries).toHaveLength(0);
    expect(replaced).toEqual([]);
  });

  test('a selection that already holds a key shared with the project stays as it is', async () => {
    storedKeys = [OWNER_KEY, PROJECT_KEY];
    expect(await share({ model: 'kortix/anthropic/claude-opus-4-8' })).toEqual({ ok: true });
    expect(keyQueries).toHaveLength(0);
    expect(replaced).toEqual([]);
  });

  test('a Kortix model runs in any session: unchanged', async () => {
    managedServable = true;
    expect(await share({ model: 'kortix/glm-5.3-flash' })).toEqual({ ok: true });
    expect(keyQueries).toHaveLength(0);
    expect(replaced).toEqual([]);
  });

  test('a session that cannot run its model already is not the share`s doing: unchanged', async () => {
    storedKeys = [];
    expect(await share({ model: 'kortix/anthropic/claude-opus-4-8' })).toEqual({ ok: true });
    expect(keyQueries).toHaveLength(0);
    expect(replaced).toEqual([]);
  });

  test('no change of scope, nothing to check: already shared, staying private, flag off, no model', async () => {
    for (const run of [
      () => {
        gatewayPersonal = null;
        return share();
      },
      () => share({ visibility: 'private' }),
      () => {
        agentPrincipal = false;
        return share({ visibility: 'restricted' });
      },
      () => share({ model: null }),
    ]) {
      probes.length = 0;
      agentPrincipal = true;
      gatewayPersonal = OWNER;
      expect(await run()).toEqual({ ok: true });
      expect(probes).toHaveLength(0);
    }
    expect(replaced).toEqual([]);
  });

  test('sharing with chosen people is a shared session too', async () => {
    expect(await share({ visibility: 'restricted' })).toEqual({ ok: true });
    expect(replaced).toEqual([{ sessionId: 'sess', providerId: 'codex', secretIds: [PROJECT_KEY] }]);
  });
});
