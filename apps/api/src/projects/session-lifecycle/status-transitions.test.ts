import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  SANDBOX_TRANSITIONS,
  SESSION_TRANSITIONS,
  sessionTransitionLeaves,
  transitionSandbox,
  transitionSession,
} from './status-transitions';

/** A database handle that records the one UPDATE a transition issues. */
function recorder(returned: unknown[]) {
  const seen: { set?: Record<string, unknown>; where?: unknown } = {};
  const exec = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        seen.set = values;
        return {
          where: (where: unknown) => {
            seen.where = where;
            return { returning: async () => returned };
          },
        };
      },
    }),
  };
  return { exec: exec as never, seen };
}

const dialect = new PgDialect();
const render = (fragment: unknown) =>
  dialect.sqlToQuery(fragment as Parameters<PgDialect['sqlToQuery']>[0]);

describe('the transition table', () => {
  test('only the archive transitions produce `archived`, and nothing else leaves it', () => {
    for (const [name, rule] of Object.entries(SANDBOX_TRANSITIONS)) {
      const archives = name === 'archive' || name === 'archiveProvisioning';
      expect(rule.to === 'archived').toBe(archives);
      if (!archives) expect(rule.from as readonly string[]).not.toContain('archived');
    }
  });

  test('a deleted session only ever moves toward stopped', () => {
    for (const rule of Object.values(SESSION_TRANSITIONS)) {
      if ('appliesToDeleted' in rule && rule.appliesToDeleted) expect(rule.to).toBe('stopped');
    }
  });

  test('a stop keeps a dead-lettered `failed` park, and a second dead-letter is a no-op', () => {
    expect(sessionTransitionLeaves('stop', 'failed')).toBe(false);
    expect(sessionTransitionLeaves('fail', 'failed')).toBe(false);
    expect(sessionTransitionLeaves('stop', 'running')).toBe(true);
  });

  test('a delivery wakes only a stopped or completed session', () => {
    const woken = (['queued', 'branching', 'provisioning', 'running', 'stopped', 'failed', 'completed'] as const)
      .filter((status) => sessionTransitionLeaves('wake', status));
    expect(woken).toEqual(['stopped', 'completed']);
  });
});

describe('transitionSession', () => {
  test('guards on the from-set and the tombstone, and reports whether it applied', async () => {
    const { exec, seen } = recorder([{ sessionId: 's-1' }]);
    expect(await transitionSession('wake', 's-1', { error: null }, exec)).toBe(true);
    expect(seen.set).toMatchObject({ status: 'running', error: null });
    const where = render(seen.where);
    expect(where.sql).toContain('"status" in (');
    expect(where.params).toEqual(expect.arrayContaining(['stopped', 'completed']));
    expect(where.sql).toContain(`->>'deletedAt'`);
  });

  test('a refused transition returns false', async () => {
    const { exec } = recorder([]);
    expect(await transitionSession('wake', 's-1', {}, exec)).toBe(false);
  });

  test('a transition from any status adds no status predicate', async () => {
    const { exec, seen } = recorder([{ sessionId: 's-1' }]);
    await transitionSession('provision', 's-1', {}, exec);
    expect(render(seen.where).sql).not.toContain('"status"');
  });

  test('`delete` and `stop` also apply to a deleted session', async () => {
    for (const name of ['delete', 'stop', 'reconcileStuck'] as const) {
      const { exec, seen } = recorder([{ sessionId: 's-1' }]);
      await transitionSession(name, 's-1', {}, exec);
      expect(render(seen.where).sql).not.toContain(`->>'deletedAt'`);
    }
  });

  test('leaves `error` alone unless the caller sets it', async () => {
    const { exec, seen } = recorder([{ sessionId: 's-1' }]);
    await transitionSession('stop', 's-1', {}, exec);
    expect(seen.set).not.toHaveProperty('error');
    expect(seen.set).not.toHaveProperty('sandboxUrl');
  });
});

describe('transitionSandbox', () => {
  test('strips and merges metadata in SQL, never assigns an object', async () => {
    const { exec, seen } = recorder([{ sandboxId: 'b-1', status: 'stopped' }]);
    const row = await transitionSandbox(
      'stop',
      'b-1',
      { metadata: { strip: ['runtimeWakeId'], merge: { stopReason: 'manual' } } },
      exec,
    );
    expect(row).toEqual({ sandboxId: 'b-1', status: 'stopped' } as never);
    const metadata = render(seen.set?.metadata);
    expect(metadata.sql).toContain(`- 'runtimeWakeId'`);
    expect(metadata.sql).toContain('||');
    expect(metadata.params).toContain(JSON.stringify({ stopReason: 'manual' }));
  });

  test('a live-row transition excludes `archived` in its WHERE', async () => {
    const { exec, seen } = recorder([]);
    expect(await transitionSandbox('activate', 'b-1', {}, exec)).toBeNull();
    const where = render(seen.where);
    expect(where.sql).toContain('"status" in (');
    expect(where.params).not.toContain('archived');
  });
});
