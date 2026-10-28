// Agent identities: the service account behind each agent, minted on first
// sight so every agent in every project can be assigned a role without being
// launched first. Core (Apache 2.0): the custom-roles picker in ee/ reads it.

import { ensureAgentServiceAccount } from '../../repositories/service-accounts';
import { loadConfigWithFilesCached } from '../../projects/surface';
import { mapLimit } from '@kortix/registry';
import { TimeoutError, withTimeout } from '../../shared/with-timeout';

// ─── Auto-provisioned agent identities (picker principal source) ───────────
//
// EAGER provisioning: every agent in every active project is assignable
// WITHOUT having to launch it first. Enumerate the project configs and
// get-or-create an identity per agent (incl. the implicit `default`).
// Best-effort + bounded; a repo that won't load just keeps whatever's
// already provisioned. `ensureAgentServiceAccount` is idempotent, so this
// only mints on first sight. Capped to bound the git work on accounts with
// a very large project count (the picker is a manager-only admin surface).
//
// Incident (2026-09-27): unbounded `Promise.all` over up to 50 projects fired
// 50 concurrent git reads at once, each doing several sub-reads (manifest +
// file listing) — 201 total git operations, 22.9s, ending in a 503. Three
// independent fixes, all needed:
//  1. `loadConfigWithFilesCached` — a 20s per-project TTL memo (see
//     project-resources.ts) so a picker opened repeatedly (or by several
//     admins) doesn't re-clone the same handful of projects every time.
//  2. `mapLimit` bounds how many project reads run at once, instead of
//     firing all of them into the git layer simultaneously.
//  3. A whole-phase deadline: if eager provisioning is still running past the
//     budget, return whatever is already in `byKey` (already-provisioned
//     identities, plus any project this loop finished before the deadline)
//     instead of letting the request hang to a 503. The straggler work is
//     left to finish in the background; the next call sees it via the
//     config-load cache and/or the now-provisioned DB rows.
export const AGENT_IDENTITIES_PROJECT_CAP = 50;
export const AGENT_IDENTITIES_CONCURRENCY = 8;
export const AGENT_IDENTITIES_PER_PROJECT_BUDGET_MS = 4_000;
export const AGENT_IDENTITIES_PHASE_BUDGET_MS = 8_000;

export type AgentIdentity = {
  service_account_id: string;
  name: string;
  project_id: string | null;
  agent_name: string | null;
};

export type EagerProvisionProjectRow = Parameters<typeof loadConfigWithFilesCached>[0];

export interface EagerProvisionDeps {
  // `enabled` is optional on purpose: the config summary lists disabled agents
  // (`enabled: false`) and this loader may stand in for one.
  loadConfig: (row: EagerProvisionProjectRow) => Promise<{ agents: Array<{ name: string; enabled?: boolean }> }>;
  ensureAccount: (args: { accountId: string; projectId: string; agentName: string }) => Promise<string>;
  concurrency: number;
  perProjectBudgetMs: number;
  phaseBudgetMs: number;
}

const defaultEagerProvisionDeps: EagerProvisionDeps = {
  loadConfig: loadConfigWithFilesCached,
  ensureAccount: ensureAgentServiceAccount,
  concurrency: AGENT_IDENTITIES_CONCURRENCY,
  perProjectBudgetMs: AGENT_IDENTITIES_PER_PROJECT_BUDGET_MS,
  phaseBudgetMs: AGENT_IDENTITIES_PHASE_BUDGET_MS,
};

/**
 * Mutates `byKey` in place with every agent identity discovered across
 * `projectRows`, bounded by concurrency and a whole-phase deadline. Never
 * throws: a timeout (the whole phase, or one project's config load) degrades
 * to whatever is already in `byKey` rather than failing the picker. Deps are
 * injectable so a test can assert concurrency/timeout behavior without a real
 * DB or git mirror.
 */
export async function eagerlyProvisionAgentIdentities(
  accountId: string,
  projectRows: readonly EagerProvisionProjectRow[],
  byKey: Map<string, AgentIdentity>,
  deps: EagerProvisionDeps = defaultEagerProvisionDeps,
): Promise<void> {
  const eagerProvisioning = mapLimit(projectRows as EagerProvisionProjectRow[], deps.concurrency, async (p) => {
    let agentNames: string[] = ['default'];
    try {
      const config = await withTimeout(deps.loadConfig(p), deps.perProjectBudgetMs, 'agent-identities config load');
      // The config summary lists disabled agents too (enabled: false); an
      // identity for an agent no session can launch is noise in the picker.
      agentNames = ['default', ...config.agents.filter((a) => a.enabled !== false).map((a) => a.name)];
    } catch {
      // repo momentarily unreachable or slow — still expose the implicit
      // `default`.
    }
    for (const agentName of agentNames) {
      const key = `${p.projectId}|${agentName}`;
      if (byKey.has(key)) continue;
      try {
        const serviceAccountId = await deps.ensureAccount({ accountId, projectId: p.projectId, agentName });
        byKey.set(key, {
          service_account_id: serviceAccountId,
          name: `${agentName} · ${p.name}`,
          project_id: p.projectId,
          agent_name: agentName,
        });
      } catch {
        // minting unavailable (e.g. API_KEY_SECRET unset) — skip this agent.
      }
    }
  });
  try {
    await withTimeout(eagerProvisioning, deps.phaseBudgetMs, 'agent-identities eager provisioning');
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    // Degrade: answer with whatever's provisioned so far (already-provisioned
    // identities are always in `byKey`; the loop's stragglers finish in the
    // background and land on the next call). Never let a slow project 503 the
    // whole picker.
  }
}
