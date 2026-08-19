import { canonicalConnectorAlias } from '../shared/connector-alias';
/**
 * Agent-session scope enforcement — the `kortix_cli` half of per-agent
 * authorization.
 *
 * This runs BESIDE the role check (`assertAuthorized` / `loadProjectForUser`),
 * not inside the IAM engine (which stays role-only). The account token a
 * session presents carries a resolved `agentGrant` (see projects/agents.ts);
 * a route asserts the Kortix action it performs is in that grant. Combined with
 * the route's existing user-role check, the net effect is `userRole ∩ agentGrant`
 * — an agent can never exceed the human who launched it, nor its own grant.
 *
 * A null grant (non-agent token: laptop CLI PAT, dashboard session, or a project
 * that hasn't adopted `[[agents]]`) imposes no restriction.
 */
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import type { AgentGrant } from '@kortix/db';

/** Read the agent grant off the request context (set by the auth middleware). */
export function getAgentGrant(c: Context): AgentGrant | null {
  return (c.get('agentGrant') as AgentGrant | null | undefined) ?? null;
}

export function isProjectSessionPrincipal(c: Context): boolean {
  if (c.get('authType') === 'supabase') return false;
  return c.get('sessionId') != null || getAgentGrant(c) != null;
}

/**
 * MANIFEST-INPUT NORMALIZATION, and nothing else.
 *
 * `project.cr.open` / `project.cr.merge` were the same capability as
 * `project.gitops.push` / `project.gitops.merge` under a second name: a route
 * gated CR creation as the former while the central capability fold gated the
 * underlying commit as the latter. Spec §2.4 collapsed them — neither string is
 * in `kortix.permissions`, so no route can assert one and no role can grant one.
 *
 * They survive in exactly ONE place: a hand-written `kortix_cli:` list in a
 * kortix.yaml an author wrote before the collapse. This table rewrites such a
 * list to the live spelling ONCE, when the grant is resolved
 * (`canonicalizeGrantActions`, called from projects/agents.ts beside the
 * connector canonicalization). It is a spelling correction on INPUT — NOT a
 * runtime alias table, and NOT a second permission model: after normalization
 * `agentMayPerform` is a plain membership test against the catalog's spelling.
 */
const MANIFEST_ACTION_ALIASES: Readonly<Record<string, string>> = {
  'project.cr.open': 'project.gitops.push',
  'project.cr.merge': 'project.gitops.merge',
};

/**
 * Rewrite a grant's `kortixCli` list to the catalog's spelling.
 *
 * Call this exactly where `canonicalizeGrantConnectors` is called — once, on the
 * resolved grant — so every gate compares canonical to canonical.
 */
export function canonicalizeGrantActions(grant: AgentGrant | null): AgentGrant | null {
  if (!grant || grant.kortixCli === 'all') return grant;
  const canonical = grant.kortixCli.map((a) => MANIFEST_ACTION_ALIASES[a] ?? a);
  return { ...grant, kortixCli: [...new Set(canonical)] };
}

/**
 * True if the agent-session grant permits `action` (or there is no grant).
 *
 * A plain membership test. The grant list is already in the catalog's spelling —
 * see `canonicalizeGrantActions`.
 */
export function agentMayPerform(grant: AgentGrant | null, action: string): boolean {
  if (!grant) return true; // no grant = no restriction
  if (grant.kortixCli === 'all') return true;
  return grant.kortixCli.includes(action);
}

/**
 * Normalize a grant's connector list to CANONICAL slugs.
 *
 * Three gates compare this grant, and they historically saw three different
 * spellings of the same connector: the catalog compared the public alias
 * (`email`), the call gate the raw slug (`kortix_email`), and session create the
 * caller's binding key. With an exact `includes()` match, whichever spelling a
 * manifest author picked satisfied one gate and failed another —
 * `connectors: ["email"]` made the connector VISIBLE in the catalog and then
 * 403'd on call, which looks like a platform bug rather than a grant typo.
 *
 * Canonicalizing ONCE here means every gate can compare canonical-to-canonical.
 */
export function canonicalizeGrantConnectors(grant: AgentGrant | null): AgentGrant | null {
  if (!grant || grant.connectors === 'all') return grant;
  const canonical = grant.connectors.map((slug) => canonicalConnectorAlias(slug));
  return { ...grant, connectors: [...new Set(canonical)] };
}

/**
 * True if the agent-session grant permits calling connector `slug` (or no grant).
 *
 * `slug` MUST already be canonical — call `canonicalConnectorAlias` on anything
 * that came from a manifest, a request body, or a stored row first.
 */
export function agentMayUseConnector(grant: AgentGrant | null, slug: string): boolean {
  if (!grant) return true; // no grant = no restriction
  if (grant.connectors === 'all') return true;
  return grant.connectors.includes(slug);
}

/** True if the agent may receive/read the project secret with this
 *  IDENTIFIER (or no grant). `env` is the grant's `secrets` allowlist — a list
 *  of secret IDENTIFIERS (not raw env-var keys; see project_secrets.identifier
 *  / resolveGrantedSecretEnv), optional for back-compat with tokens minted
 *  before the field existed — those are treated as 'all' (unrestricted). This
 *  is the SOLE gate on agent secret access — there is no resource-side
 *  allow-list on the secret itself. */
export function agentMayUseEnv(grant: AgentGrant | null, identifier: string): boolean {
  if (!grant) return true; // no grant = no restriction
  const env = grant.env ?? 'all';
  if (env === 'all') return true;
  // Identifiers are free-form-ish but a kortix.yaml `secrets:` allowlist
  // is hand-written and may use any case. Match case-insensitively so
  // `secrets: ["gmaps-primary"]` still admits identifier "GMAPS-primary".
  const target = identifier.toUpperCase();
  return env.some((e) => e.toUpperCase() === target);
}

/**
 * Throw 403 if the request is an agent-session token whose grant does not
 * include `action`. No-op for non-agent tokens (null grant).
 */
export function assertAgentScope(c: Context, action: string): void {
  const grant = getAgentGrant(c);
  if (agentMayPerform(grant, action)) return;
  throw new HTTPException(403, {
    message: `Agent "${grant!.agent}" is not granted "${action}". Add it to this agent's kortix_cli in kortix.yaml (CR-merged).`,
  });
}
