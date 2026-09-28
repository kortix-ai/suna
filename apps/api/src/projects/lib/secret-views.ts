import type {
  Secret,
  SecretDeliveryBlockedReason,
  SecretDeliveryStrategy,
} from '@kortix/api-contract';
import { projectSecrets } from '@kortix/db';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { ProjectConfigSummary } from '../git/types';

export const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';
export const PROJECT_GIT_AUTH_SECRET_NAME = 'KORTIX_GIT_AUTH_TOKEN';

export type SecretRow = typeof projectSecrets.$inferSelect;

/**
 * The slice of a loaded `ProjectConfigSummary` the agent-grant axis needs. A
 * `Pick`, so a route hands the whole loaded config straight through.
 */
export type SecretAgentGrantConfig = Pick<ProjectConfigSummary, 'agent_discovery' | 'agents'>;

/** Grant membership. Case-insensitive, mirroring `listAdmits` in
 *  ../../secrets/strategy.ts — a hand-written `secrets:` list in kortix.yaml may
 *  use any case, and the two answers must agree. */
function grantAdmits(list: string[], identifier: string): boolean {
  const target = identifier.toUpperCase();
  return list.some((entry) => entry.toUpperCase() === target);
}

/**
 * Can any agent receive this secret? Returns the block reason, or null.
 *
 * `resolveSecretDelivery` (../../secrets/strategy.ts) hands an `egress`/`broker`
 * secret to a session only when some agent's `secrets:` list is an explicit
 * ARRAY naming this IDENTIFIER. `'all'` and an absent list both withhold it as
 * `agent_grant_unscoped`, so neither counts as a grant here. Matching is by
 * identifier, never by the env-var `name` — several identifiers may share one
 * name.
 *
 * The tri-state forbids guessing, so read `agent_discovery` for what
 * `resolveConfigAgents` (../git/config.ts) actually means by it:
 *
 *   `opencode`   — the manifest yielded NO agent specs AND NO parse errors, i.e.
 *                  it declared no `agents:` at all (or there is no manifest).
 *                  `grantFromLoadedAgents` then resolves to a null grant, which
 *                  `resolveSecretDelivery` withholds. CERTAIN: no session can
 *                  ever receive this secret. A native `.opencode` agent does not
 *                  rescue it — grants come only from manifest specs.
 *   `declarative`, agents non-empty — the manifest parsed and its declarations
 *                  are the complete grant set. CERTAIN either way.
 *   `declarative`, agents EMPTY — the only ambiguous state, and it is reached by
 *                  a manifest that FAILED to parse (specs empty, errors present)
 *                  or one whose agents are all disabled. Report null.
 *
 * Getting this backwards would be worse than useless in both directions: silent
 * on the commonest broken setup (no `agents:` block), and crying wolf on a
 * manifest we merely failed to read.
 */
export function secretDeliveryBlockedReason(
  identifier: string,
  strategy: SecretDeliveryStrategy,
  config: SecretAgentGrantConfig | null | undefined,
): SecretDeliveryBlockedReason | null {
  if (strategy !== 'egress' && strategy !== 'broker') return null;
  if (!config) return null;
  if (config.agent_discovery === 'opencode') return 'no_agent_grant';
  // Anything other than the two known modes is a config we do not understand —
  // including a partial object from a caller that resolved only part of it.
  if (config.agent_discovery !== 'declarative') return null;
  const agents = config.agents;
  if (!Array.isArray(agents) || agents.length === 0) return null;
  const granted = agents.some((agent) => {
    const env = agent.scope?.env;
    return Array.isArray(env) && grantAdmits(env, identifier);
  });
  return granted ? null : 'no_agent_grant';
}

/**
 * The view of one project secret (one IDENTIFIER): the shared/project row
 * merged with the requesting member's own private override (used today only by
 * the CODEX_AUTH_JSON per-user provider login), plus which one wins at runtime.
 * Authorization is centralized on the agent grant (by identifier — see
 * agentMayUseEnv); every project member with read access sees every secret —
 * there is no per-secret member/group sharing and no resource-side agent
 * allow-list.
 */

export function buildSecretView(input: {
  identifier: string;
  name: string;
  shared?: SecretRow;
  personal?: SecretRow;
  canManageShared: boolean;
  /** The project's loaded config, for the agent-grant axis. Omit it and every
   *  pre-existing field is unchanged; `delivery_blocked_reason` reports null. */
  agentGrants?: SecretAgentGrantConfig | null;
}): Secret {
  const { identifier, name, shared, personal, canManageShared } = input;
  const system = isSystemProjectSecretName(name);
  const isGitAuth = name === PROJECT_GIT_AUTH_SECRET_NAME;
  const mineActive = Boolean(personal?.active);
  const effectiveSource: 'mine' | 'shared' | 'none' =
    personal && mineActive ? 'mine' : shared ? 'shared' : 'none';
  const deliveryRow = shared ?? personal;
  const strategy = deliveryRow?.strategy ?? 'runtime';
  const requiresRotation =
    strategy !== 'runtime' &&
    (!deliveryRow?.rotatedAt || deliveryRow.rotatedAt < deliveryRow.updatedAt);
  const backend = deliveryRow?.egressPolicy?.backend;
  const legacyConsumer =
    strategy === 'runtime'
      ? 'sandbox'
      : strategy === 'denied'
        ? null
        : strategy === 'egress'
          ? 'network'
          : backend === 'llm_gateway'
            ? 'llm_gateway'
            : backend === 'connector'
              ? 'connector'
              : backend === 'git_proxy'
                ? 'git_proxy'
                : backend === 'kortix_fetch'
                  ? 'http_broker'
                  : null;
  const storedConsumer =
    strategy === 'denied'
      ? null
      : deliveryRow?.scope === 'connector'
        ? 'connector'
        : (deliveryRow?.consumer ?? legacyConsumer);
  const consumer = storedConsumer;
  return {
    identifier,
    name,
    // biome-ignore lint/style/noNonNullAssertion: Callers supply at least one secret row.
    project_id: (shared ?? personal)!.projectId,
    secret_id: shared?.secretId ?? null,
    created_by: shared?.createdBy ?? null,
    created_at: (shared?.createdAt ?? personal?.createdAt)?.toISOString() ?? null,
    updated_at: (shared?.updatedAt ?? personal?.updatedAt)?.toISOString() ?? null,
    system,
    readonly: system,
    purpose: isGitAuth ? 'git_auth' : null,
    can_rotate: isGitAuth,
    managed_by: isGitAuth ? 'project_secret' : null,
    // Is a shared project value set at all.
    configured: Boolean(shared),
    // MY private override (value never returned), and whether I'm using it.
    mine: personal
      ? { active: personal.active, updated_at: personal.updatedAt.toISOString() }
      : null,
    // What actually gets injected into my sessions for this identifier.
    effective_source: effectiveSource,
    // Members manage only their own override; managers also manage the shared row.
    can_manage_shared: canManageShared && !system,
    strategy,
    consumer,
    delivery_status:
      (strategy === 'runtime' && consumer === 'sandbox') ||
      (strategy === 'broker' && consumer === 'llm_gateway') ||
      (strategy === 'broker' && consumer === 'git_proxy') ||
      (strategy === 'broker' && consumer === 'http_broker' && backend === 'kortix_fetch') ||
      (strategy === 'egress' && consumer === 'network') ||
      consumer === 'connector'
        ? 'available'
        : strategy === 'denied'
          ? 'disabled'
          : 'unavailable',
    // Two axes, deliberately not folded together. `delivery_status` answers
    // "does this deployment support the mode" and stays 'available' on a missing
    // grant, because the CLI, the SDK and the web chip all key off that meaning.
    // The grant axis is per-project and lives here.
    delivery_blocked_reason: secretDeliveryBlockedReason(identifier, strategy, input.agentGrants),
    // Always true since the exposure/usage model: one mechanism serves every
    // provider, so there is no deployment where egress-enforced delivery is missing. Kept on
    // the wire because published SDK and CLI versions still read it — an absent
    // field reads as "unknown" to them, a `false` would falsely disable the UI.
    network_boundary_available: true,
    egress_policy: deliveryRow?.egressPolicy ?? null,
    strategy_locked: deliveryRow?.strategyLocked ?? false,
    last_rotated_at: deliveryRow?.rotatedAt?.toISOString() ?? null,
    requires_rotation: requiresRotation,
  };
}

/**
 * Load every secret IDENTIFIER in a project as the per-user view (shared + my
 * own override merged). Used by the secrets list + returned after a write.
 */

export async function loadSecretViewsForUser(input: {
  projectId: string;
  /** Whose personal overrides merge in; null = shared rows only (an
   *  agent-principal session with no on-behalf-of human, spec 2026-09-22 §2.3). */
  userId: string | null;
  canManageShared: boolean;
  /** The project's loaded config. Callers that have already read it pass it so
   *  every row reports the agent-grant axis; omitting it reports null. */
  agentGrants?: SecretAgentGrantConfig | null;
}): Promise<ReturnType<typeof buildSecretView>[]> {
  // NAMED, not positional: an `unknown`-typed argument in a positional slot
  // silently swallowed the `agentGrants` a call site passed there, and
  // typechecked while doing it.
  const { projectId, userId, canManageShared, agentGrants } = input;
  const rows = await db
    .select()
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        userId
          ? or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, userId))
          : isNull(projectSecrets.ownerUserId),
      ),
    )
    .orderBy(desc(projectSecrets.updatedAt));

  const byIdentifier = new Map<string, { shared?: SecretRow; personal?: SecretRow }>();
  for (const row of rows) {
    const slot = byIdentifier.get(row.identifier) ?? {};
    if (row.ownerUserId === null) slot.shared = row;
    else slot.personal = row;
    byIdentifier.set(row.identifier, slot);
  }

  return [...byIdentifier.entries()].map(([identifier, slot]) =>
    buildSecretView({
      identifier,
      // biome-ignore lint/style/noNonNullAssertion: Every map slot is populated from a row.
      name: (slot.shared ?? slot.personal)!.name,
      shared: slot.shared,
      personal: slot.personal,
      canManageShared,
      agentGrants,
    }),
  );
}

export function isSystemProjectSecretName(name: string): boolean {
  return name.toUpperCase().startsWith('KORTIX_');
}
