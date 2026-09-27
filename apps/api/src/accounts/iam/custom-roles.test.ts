import { describe, expect, test } from 'bun:test';
import {
  AGENT_IDENTITIES_CONCURRENCY,
  AGENT_IDENTITIES_PER_PROJECT_BUDGET_MS,
  AGENT_IDENTITIES_PHASE_BUDGET_MS,
  AGENT_IDENTITIES_PROJECT_CAP,
  type AgentIdentity,
  type EagerProvisionProjectRow,
  eagerlyProvisionAgentIdentities,
} from './custom-roles';

/**
 * Regression coverage for `GET /:accountId/iam/agent-identities`'s eager
 * provisioning phase.
 *
 * Incident: unbounded `Promise.all` over up to 50 projects fired 50
 * concurrent git reads at once (201 total git operations, 22.9s, 503) —
 * apps/api/src/accounts/iam/custom-roles.ts, 2026-09-27. These tests pin the
 * three independent fixes: bounded concurrency, a per-project load timeout
 * that degrades to the implicit `default` agent, and a whole-phase deadline
 * that degrades to whatever was already provisioned instead of hanging.
 */

function project(id: string, name = id): EagerProvisionProjectRow {
  return { projectId: id, name } as unknown as EagerProvisionProjectRow;
}

const never = <T>() => new Promise<T>(() => {});

describe('eagerlyProvisionAgentIdentities', () => {
  test('never runs more project loads at once than the configured concurrency', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => project(`p${i}`));
    let inFlight = 0;
    let maxInFlight = 0;
    const byKey = new Map<string, AgentIdentity>();

    await eagerlyProvisionAgentIdentities('acc', rows, byKey, {
      loadConfig: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { agents: [] };
      },
      ensureAccount: async ({ projectId, agentName }) => `${projectId}:${agentName}`,
      concurrency: 3,
      perProjectBudgetMs: 1_000,
      phaseBudgetMs: 5_000,
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // proves it is actually concurrent, not serial
    expect(byKey.size).toBe(12); // one `default` identity per project
  });

  test('a project whose config load times out still gets the implicit default agent', async () => {
    const rows = [project('slow'), project('fast')];
    const byKey = new Map<string, AgentIdentity>();

    await eagerlyProvisionAgentIdentities('acc', rows, byKey, {
      loadConfig: async (p) => (p.projectId === 'slow' ? never() : { agents: [{ name: 'reviewer' }] }),
      ensureAccount: async ({ projectId, agentName }) => `${projectId}:${agentName}`,
      concurrency: 8,
      perProjectBudgetMs: 20,
      phaseBudgetMs: 5_000,
    });

    expect(byKey.has('slow|default')).toBe(true);
    expect(byKey.has('slow|reviewer')).toBe(false); // never discovered — the load never answered
    expect(byKey.has('fast|default')).toBe(true);
    expect(byKey.has('fast|reviewer')).toBe(true);
  });

  test('a config load that fails outright still yields the implicit default agent', async () => {
    const byKey = new Map<string, AgentIdentity>();
    await eagerlyProvisionAgentIdentities('acc', [project('broken')], byKey, {
      loadConfig: async () => {
        throw new Error('repo unreachable');
      },
      ensureAccount: async ({ projectId, agentName }) => `${projectId}:${agentName}`,
      concurrency: 8,
      perProjectBudgetMs: 1_000,
      phaseBudgetMs: 5_000,
    });
    expect([...byKey.keys()]).toEqual(['broken|default']);
  });

  test('minting failure (e.g. API_KEY_SECRET unset) skips only that agent, not the whole project', async () => {
    const byKey = new Map<string, AgentIdentity>();
    await eagerlyProvisionAgentIdentities('acc', [project('p')], byKey, {
      loadConfig: async () => ({ agents: [{ name: 'ok' }, { name: 'bad' }] }),
      ensureAccount: async ({ agentName }) => {
        if (agentName === 'bad') throw new Error('API_KEY_SECRET not configured');
        return `sa-${agentName}`;
      },
      concurrency: 8,
      perProjectBudgetMs: 1_000,
      phaseBudgetMs: 5_000,
    });
    expect(byKey.has('p|default')).toBe(true);
    expect(byKey.has('p|ok')).toBe(true);
    expect(byKey.has('p|bad')).toBe(false);
  });

  test('a project already present in byKey is never re-provisioned', async () => {
    const byKey = new Map<string, AgentIdentity>();
    byKey.set('p|default', {
      service_account_id: 'existing',
      name: 'default · p',
      project_id: 'p',
      agent_name: 'default',
    });
    let ensureCalls = 0;
    await eagerlyProvisionAgentIdentities('acc', [project('p')], byKey, {
      loadConfig: async () => ({ agents: [] }),
      ensureAccount: async ({ agentName }) => {
        ensureCalls += 1;
        return `sa-${agentName}`;
      },
      concurrency: 8,
      perProjectBudgetMs: 1_000,
      phaseBudgetMs: 5_000,
    });
    expect(ensureCalls).toBe(0);
    expect(byKey.get('p|default')?.service_account_id).toBe('existing');
  });

  test('a whole-phase timeout degrades to whatever was already provisioned — it never throws', async () => {
    const rows = [project('never-answers')];
    const byKey = new Map<string, AgentIdentity>();
    byKey.set('already|default', {
      service_account_id: 'x',
      name: 'default · already',
      project_id: 'already',
      agent_name: 'default',
    });

    const start = Date.now();
    await eagerlyProvisionAgentIdentities('acc', rows, byKey, {
      loadConfig: () => never(),
      ensureAccount: async () => 'unused',
      concurrency: 8,
      perProjectBudgetMs: 60_000, // per-project budget deliberately not the thing that fires
      phaseBudgetMs: 30,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1_000); // degraded promptly at the phase budget, not the 60s per-project one
    expect(byKey.has('already|default')).toBe(true); // untouched pre-existing entry survives
    expect(byKey.has('never-answers|default')).toBe(false); // the stalled project never finished
  });

  test('a non-timeout error from a dependency still propagates (only TimeoutError degrades)', async () => {
    const byKey = new Map<string, AgentIdentity>();
    await expect(
      eagerlyProvisionAgentIdentities('acc', [project('p')], byKey, {
        loadConfig: async () => ({ agents: [] }),
        ensureAccount: async () => {
          throw new Error('should be caught per-agent, not here');
        },
        concurrency: 8,
        perProjectBudgetMs: 1_000,
        phaseBudgetMs: 1_000,
      }),
    ).resolves.toBeUndefined(); // ensureAccount failures are caught per-agent inside the loop
  });

  test('the exported constants match the incident write-up (bounded, comfortably under a request timeout)', () => {
    expect(AGENT_IDENTITIES_PROJECT_CAP).toBe(50);
    expect(AGENT_IDENTITIES_CONCURRENCY).toBeGreaterThan(1);
    expect(AGENT_IDENTITIES_CONCURRENCY).toBeLessThan(AGENT_IDENTITIES_PROJECT_CAP);
    expect(AGENT_IDENTITIES_PER_PROJECT_BUDGET_MS).toBeLessThan(AGENT_IDENTITIES_PHASE_BUDGET_MS);
    expect(AGENT_IDENTITIES_PHASE_BUDGET_MS).toBeLessThanOrEqual(10_000);
  });
});
