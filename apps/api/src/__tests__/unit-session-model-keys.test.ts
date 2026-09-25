import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sessionProviderSecretPools } from '@kortix/db';

// PUT /sessions/:id/model (projects/lib/session-model-keys.ts). The check used
// the owner's own keys: on dev (2026-09-25) a session shared with the project
// accepted `codex/gpt-6-astra` through its owner's personal ChatGPT
// connection, which the gateway never uses for a shared session — every turn
// would fail with "Connect Codex to use this model".

const OWNER = 'owner-user';
const OTHER = 'other-member';
const PROJECT_KEY = 'project-key';
const OWNER_KEY = 'owner-key';

/** What the gateway resolves as the session's personal user. */
let gatewayPersonal: string | null = null;
mock.module('../projects/lib/personal-resources', () => ({
  resolveSessionPersonalOwner: async () => gatewayPersonal,
}));

// ChatGPT: the owner's own connection serves by default, but only in their
// private session. An API-key model never serves without a selection. Any
// selection serves when it holds a key.
const probes: Array<Record<string, unknown>> = [];
mock.module('../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async (input: {
    model: string;
    personalUserId?: string | null;
    providerSecretPools?: Record<string, string[]>;
  }) => {
    probes.push(input);
    if (input.providerSecretPools) return Object.values(input.providerSecretPools).some((ids) => ids.length > 0);
    return input.model.includes('codex/') && input.personalUserId === OWNER;
  },
}));

const keyQueries: Array<Record<string, unknown>> = [];
let projectKeys: string[] = [PROJECT_KEY];
mock.module('../secrets/provider-key-selection', () => ({
  providerKeyOf: (model: string) =>
    model.includes('codex/')
      ? { providerId: 'codex', envVar: 'CODEX_AUTH_JSON' }
      : model.startsWith('anthropic/')
        ? { providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY' }
        : null,
  usableProviderKeys: async (input: { grantUserId: string | null; model: string }) => {
    keyQueries.push(input);
    const providerId = input.model.includes('codex/') ? 'codex' : 'anthropic';
    const ids = [...projectKeys, ...(input.grantUserId === OWNER ? [OWNER_KEY] : [])];
    return ids.length ? { providerId, envVar: 'X', secretIds: ids, labels: ids } : null;
  },
}));

/** Stored selections, as `sessionId/providerId`. */
let selections = new Set<string>();
const selectionQueries: unknown[][] = [];
/** Rows the change stored. */
let stored: Array<{ sessionId: string; providerId: string; secretIds: string[] }> = [];
/** A selection another request stores between the check and the write. */
let concurrentSelection: string | null = null;
const dialect = new PgDialect();
mock.module('../shared/db', () => ({
  db: {
    insert: (table: unknown) => ({
      values: (row: { sessionId: string; providerId: string; secretIds: string[] }) => ({
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

const { admitSessionModelChange } = await import('../projects/lib/session-model-keys');

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
  probes.length = 0;
  keyQueries.length = 0;
  projectKeys = [PROJECT_KEY];
  selections = new Set();
  selectionQueries.length = 0;
  stored = [];
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

  test('a shared session with no key shared with the project is refused, not accepted and then failed', async () => {
    projectKeys = [];
    expect(await change()).toBe(false);
    expect(stored).toEqual([]);
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
