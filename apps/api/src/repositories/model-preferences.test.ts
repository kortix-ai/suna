import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Account/agent/PROJECT-scoped default model preferences. A FIFO-ish chain mock
// captures select rows + insert values without a real DB.

let selectRows: any[] = [];
let insertedValues: any = null;
let conflictMode: 'update' | 'nothing' | null = null;

function chain(): any {
  const c: any = {};
  for (const m of ['select', 'from', 'where', 'update', 'set', 'delete', 'returning', 'limit']) {
    c[m] = () => c;
  }
  c.values = (v: any) => {
    insertedValues = v;
    return c;
  };
  c.onConflictDoUpdate = () => {
    conflictMode = 'update';
    return Promise.resolve();
  };
  c.onConflictDoNothing = () => {
    conflictMode = 'nothing';
    return Promise.resolve();
  };
  c.then = (resolve: (rows: any[]) => unknown) => Promise.resolve(resolve(selectRows));
  return c;
}
mock.module('../shared/db', () => ({
  db: { select: () => chain(), insert: () => chain(), delete: () => chain() },
  hasDatabase: () => true,
}));

const { getAccountModelDefaults, upsertAccountModelPreference, getSessionAgentContext } = await import(
  './model-preferences'
);

beforeEach(() => {
  selectRows = [];
  insertedValues = null;
  conflictMode = null;
});

describe('getAccountModelDefaults', () => {
  test('buckets account / agent / project rows', async () => {
    selectRows = [
      { scope: 'account', scopeKey: '', model: 'glm-5.2' },
      { scope: 'agent', scopeKey: 'reviewer', model: 'claude-opus-4.8' },
      { scope: 'project', scopeKey: 'p1', model: 'anthropic/claude-sonnet-4.6' },
      { scope: 'project', scopeKey: 'p2', model: 'qwen3.7-max' },
    ];
    const defaults = await getAccountModelDefaults('a1');
    expect(defaults.account).toBe('glm-5.2');
    expect(defaults.agents).toEqual({ reviewer: 'claude-opus-4.8' });
    expect(defaults.projects).toEqual({ p1: 'anthropic/claude-sonnet-4.6', p2: 'qwen3.7-max' });
  });

  test('empty → all buckets empty', async () => {
    expect(await getAccountModelDefaults('a1')).toEqual({ account: null, agents: {}, projects: {} });
  });
});

describe('upsertAccountModelPreference', () => {
  test('project scope writes scope_key = projectId', async () => {
    await upsertAccountModelPreference({ accountId: 'a1', scope: 'project', scopeKey: 'p1', model: 'glm-5.2' });
    expect(insertedValues).toMatchObject({ accountId: 'a1', scope: 'project', scopeKey: 'p1', model: 'glm-5.2' });
    expect(conflictMode).toBe('update');
  });

  test('account scope pins scope_key to empty string', async () => {
    await upsertAccountModelPreference({ accountId: 'a1', scope: 'account', model: 'glm-5.2' });
    expect(insertedValues.scopeKey).toBe('');
  });

  test('onlyIfAbsent uses INSERT … ON CONFLICT DO NOTHING (idempotent seed)', async () => {
    await upsertAccountModelPreference({
      accountId: 'a1',
      scope: 'project',
      scopeKey: 'p1',
      model: 'glm-5.2',
      onlyIfAbsent: true,
    });
    expect(conflictMode).toBe('nothing');
  });
});

// Persisted-session fixtures: getSessionAgentContext must dual-read the
// session's model override so pre-rename rows (opencode_model-only) keep
// resolving exactly as today.
describe('getSessionAgentContext', () => {
  test('a pre-rename row with ONLY opencode_model metadata resolves the model', async () => {
    selectRows = [
      { agentName: 'default', metadata: { opencode_model: 'anthropic/claude-opus-4-8' } },
    ];
    expect(await getSessionAgentContext('sess-1')).toEqual({
      agentName: 'default',
      model: 'anthropic/claude-opus-4-8',
    });
  });

  test('a new-style row with ONLY model metadata resolves the model', async () => {
    selectRows = [{ agentName: 'default', metadata: { model: 'kortix/glm-5.2' } }];
    expect(await getSessionAgentContext('sess-1')).toEqual({ agentName: 'default', model: 'kortix/glm-5.2' });
  });

  test('both keys present: model (neutral) wins — pins current precedence', async () => {
    selectRows = [
      {
        agentName: 'default',
        metadata: { model: 'kortix/glm-5.2', opencode_model: 'anthropic/claude-opus-4-8' },
      },
    ];
    expect(await getSessionAgentContext('sess-1')).toEqual({ agentName: 'default', model: 'kortix/glm-5.2' });
  });

  test('no row → null', async () => {
    selectRows = [];
    expect(await getSessionAgentContext('sess-missing')).toBeNull();
  });

  test('row with neither key → model is null', async () => {
    selectRows = [{ agentName: 'default', metadata: { existing: true } }];
    expect(await getSessionAgentContext('sess-1')).toEqual({ agentName: 'default', model: null });
  });
});
