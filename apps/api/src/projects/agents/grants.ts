import type { AgentGrant } from '@kortix/db';
import { isMetaAgentName } from '@kortix/shared';
import { canonicalizeGrantActions, canonicalizeGrantConnectors } from '../../iam/agent-scope';
import type { GitBackedProject } from '../git';
import { platformMetaAgentGrant } from '../lib/platform-meta-agent';
import { loadProjectAgents } from './parse';
import type { AgentSpec, LoadedAgents } from './types';

/**
 * The non-binding agent sentinel. `project_sessions.agent_name` defaults to this
 * literal and NO agent is ever named `default` — the runtime resolves it to
 * OpenCode's configured `default_agent` (a general-purpose agent). Kept in sync
 * with the proxy's copy (sandbox-proxy/routes/preview.ts).
 */
export const DEFAULT_AGENT_SENTINEL = 'default';

/**
 * Resolve the per-agent grant to stamp onto a session token at birth.
 *
 * Backward-compatible + secure-on-adoption:
 *   - Manifest declares NO `[[agents]]` at all → returns `null` (no restriction;
 *     full access, capped at the launching user by the route's own role check).
 *     Every existing project keeps working exactly as today.
 *   - Agent IS listed → its declared overlay (connectors + kortix_permissions).
 *   - Project adopted `[[agents]]` but the agent is NOT listed → default-DENY
 *     (the agent still runs its `.md` behavior, but with no connectors and no
 *     Kortix permissions).
 *
 * The `∩ launching-user role` is NOT applied here — it's enforced for free at
 * the route layer (the account token resolves to the user, whose role is
 * already checked), so the grant carries the *declared* set. Net effect at a
 * route = userRole ∩ agentGrant.
 */
export async function resolveAgentGrant(
  agentName: string,
  project: GitBackedProject,
): Promise<AgentGrant | null> {
  return grantFromLoadedAgents(agentName, await loadProjectAgents(project));
}

/**
 * Agents every OpenCode runtime reports as `native` (verified against a live
 * sandbox roster, 2026-09-15: build, compaction, explore, general, plan,
 * summary, title).
 */
export const OPENCODE_BUILTIN_AGENT_NAMES: ReadonlySet<string> = new Set([
  'build',
  'compaction',
  'explore',
  'general',
  'plan',
  'summary',
  'title',
]);

/**
 * May `agentName` be the RUNNING agent of a session in this project?
 *
 * A session token's grant follows the agent a prompt names (see
 * `remintGrantForAgentSwitch`). Nothing may put a name on that token that the
 * project does not declare: INC-2026-09-15 wrote `chief-of-staff`, an agent of a
 * DIFFERENT project, onto ~50 session tokens of unrelated projects, and every
 * one of those sessions lost its CLI and connector access.
 *
 *   - `default`, the platform meta agent and OpenCode's built-in agents are
 *     always launchable: none of them is ever another project's agent.
 *   - A project with no per-agent governance (no specs, no parse errors) keeps
 *     the runtime roster as the authority, unchanged.
 *   - Otherwise the name must be a declared, enabled spec. A manifest that
 *     failed to parse proves nothing and answers `false`.
 *
 * Pure. Exported for tests and for the sandbox proxy.
 */
export function isLaunchableAgentName(agentName: string, loaded: LoadedAgents): boolean {
  const name = agentName.trim();
  if (!name) return false;
  if (name === DEFAULT_AGENT_SENTINEL || isMetaAgentName(name)) return true;
  // OpenCode ships these in every runtime and a governed project's picker can
  // still send one. They are the runtime's own, not another project's, so they
  // keep running exactly as before: an undeclared built-in resolves to the
  // deny-all grant in `grantFromLoadedAgents`, never a widening.
  if (OPENCODE_BUILTIN_AGENT_NAMES.has(name)) return true;
  if (loaded.specs.length === 0 && loaded.errors.length === 0) return true;
  return loaded.specs.some((s) => s.name === name && s.enabled);
}

/**
 * The `apps` part of a grant built from a spec: present only when the agent
 * declares at least one App (or `all`). An agent that declares none gets a
 * grant WITHOUT the key, identical to every grant minted before the field
 * existed — `agentMayOpenApp` reads absent as none.
 */
function appsGrantOf(spec: AgentSpec): Pick<AgentGrant, 'apps'> {
  const apps = spec.apps;
  if (apps === 'all') return { apps: 'all' };
  return apps && apps.length > 0 ? { apps: [...apps] } : {};
}

/**
 * The one grant construction from a declared spec: governed
 * (`resolveGovernedAgentGrant`) and ungoverned (`grantFromLoadedAgents`)
 * resolution both build here, so they cannot drift apart again.
 */
function grantFromSpec(agentName: string, spec: AgentSpec): AgentGrant | null {
  // Canonicalize the manifest's spellings here, ONCE, so every gate compares
  // canonical to canonical:
  //   * connectors — a manifest may say `email` or `kortix_email` and both
  //     must mean the same connector (catalog / call / session-create);
  //   * kortix_permissions actions — `project.cr.open` / `project.cr.merge` were
  //     collapsed into the gitops leaves (spec §2.4) and are no longer in the
  //     catalog, so a manifest written before that must be rewritten, not
  //     aliased at every check.
  return canonicalizeGrantActions(
    canonicalizeGrantConnectors({
      agent: agentName,
      permissions: spec.permissions,
      connectors: spec.connectors,
      env: spec.env,
      ...appsGrantOf(spec),
    }),
  );
}

/** Pure resolution rule (no I/O) — see `resolveAgentGrant`. Exported for tests. */
export function grantFromLoadedAgents(agentName: string, loaded: LoadedAgents): AgentGrant | null {
  // The reserved platform coordinator is injected by the platform and is NEVER
  // declared in a project manifest, so manifest resolution cannot answer for it:
  // a governed project falls through to the unlisted default-DENY below, and an
  // ungoverned one returns the UNRESTRICTED null. Both are wrong, and the wrong
  // answers were load-bearing — `remintGrantForAgentSwitch` re-resolves the
  // running agent's grant on EVERY prompt and writes it onto the session's
  // token, so the deny-all overwrote the coordinator's real grant on its first
  // turn (every later `kortix` call then 403'd) and the null made the re-mint
  // refuse the prompt outright. Its grant is platform-owned, at mint and here.
  if (isMetaAgentName(agentName)) return platformMetaAgentGrant();

  // No [[agents]] section parsed and no errors → project hasn't adopted
  // per-agent governance → no restriction (today's behavior).
  if (loaded.specs.length === 0 && loaded.errors.length === 0) return null;

  const spec = loaded.specs.find((s) => s.name === agentName && s.enabled);
  if (spec) {
    return grantFromSpec(agentName, spec);
  }

  // The `default` sentinel is non-binding for v1: no agent is ever named
  // `default`, so a `default`-booted session is OpenCode's configured
  // `default_agent` (a general-purpose agent, conventionally `kortix`, granted
  // "all") — NOT an unlisted concrete agent. Default-denying it stripped EVERY
  // connector from such sessions (the `kortix connectors ls` → [] bug,
  // and synthetic channel/computer connectors never reaching the agent) even
  // though OpenCode runs them as the fully-privileged default agent. Resolve
  // it the way the proxy already does: non-binding → null (no restriction,
  // still capped at the launching user's role; identical to a project that
  // never adopted [[agents]]).
  //
  // v2 changes this: the manifest declares a top-level `default_agent` that
  // MUST always resolve to a concrete declared agent (spec §2.1 — "closes
  // trigger seam 7(a) structurally"). `loaded.defaultAgent` is only ever
  // non-null for a v2 manifest (see `extractAgentsV2`), so this branch is
  // absent from v1 behavior — a v1 project (defaultAgent always null) falls
  // through to the unchanged `return null` below.
  if (agentName === DEFAULT_AGENT_SENTINEL) {
    if (loaded.defaultAgent) {
      const declared = loaded.specs.find((s) => s.name === loaded.defaultAgent && s.enabled);
      if (declared) {
        return grantFromSpec(loaded.defaultAgent, declared);
      }
    }
    // A project locks down its default by setting `default_agent` to a
    // CONCRETE declared agent, which reaches us by that name and gets its
    // (possibly narrow) grant — so this never weakens an intentionally-
    // restricted default. Falling through here means either v1 (no
    // manifest-level default_agent to honor) or a v2 manifest whose declared
    // default_agent doesn't resolve to an enabled spec (a validation-time
    // error the CR-merge gate should already have caught).
    //
    // EXCEPT when the manifest could not be read or parsed. `null` here means
    // NO RESTRICTION (agent-scope.ts), and the mint resolves this grant with
    // `.catch(() => null)` — so an unreadable manifest on a GOVERNED project
    // would hand the session a fully unrestricted token for the life of the
    // sandbox. Never widen on an error: a session that cannot prove what it is
    // allowed to use gets nothing, which is the same rule the secrets path
    // already follows (secret-grant.ts passes rethrowReadErrors for this).
    if (loaded.errors.length > 0) {
      return { agent: agentName, permissions: [], connectors: [], env: [] };
    }
    return null;
  }

  // Governance adopted but this concrete agent is unlisted → default-deny
  // everything, including secrets/env (an unlisted agent receives no project
  // secrets).
  return { agent: agentName, permissions: [], connectors: [], env: [] };
}

/** Resolve the selected agent's sandbox template without repository I/O. */
export function sandboxFromLoadedAgents(agentName: string, loaded: LoadedAgents): string | null {
  const concreteName =
    agentName === DEFAULT_AGENT_SENTINEL && loaded.defaultAgent
      ? loaded.defaultAgent
      : agentName;
  return loaded.specs.find((spec) => spec.name === concreteName && spec.enabled)?.sandbox ?? null;
}

/** Resolve the selected agent's project file delivery mode without repository I/O. */
export function repositoryAccessFromLoadedAgents(agentName: string, loaded: LoadedAgents): boolean {
  const name = agentName === DEFAULT_AGENT_SENTINEL && loaded.defaultAgent ? loaded.defaultAgent : agentName;
  return loaded.specs.find((spec) => spec.name === name && spec.enabled)?.repositoryAccess ?? (loaded.specs.length === 0 && loaded.errors.length === 0);
}

/** Legacy read remains unavailable until its owner explicitly chooses a boolean policy. */
export function legacyReadWorkspaceFromLoadedAgents(agentName: string, loaded: LoadedAgents): boolean {
  const name = agentName === DEFAULT_AGENT_SENTINEL && loaded.defaultAgent ? loaded.defaultAgent : agentName;
  return loaded.specs.find((spec) => spec.name === name && spec.enabled)?.legacyReadWorkspace ?? false;
}

/**
 * Resolve the connectors that the selected agent requires at session start.
 * Each connector controls which connection owner is valid.
 */
export function requiredConnectorsForAgent(agentName: string, loaded: LoadedAgents): string[] {
  if (loaded.specs.length === 0 && loaded.errors.length === 0) return [];
  const spec =
    loaded.specs.find((s) => s.name === agentName && s.enabled) ??
    (agentName === DEFAULT_AGENT_SENTINEL && loaded.defaultAgent
      ? loaded.specs.find((s) => s.name === loaded.defaultAgent && s.enabled)
      : undefined);
  return spec?.connectorsRequired ?? [];
}

/**
 * Is this project subject to MANDATORY DECLARED AGENTS enforcement?
 *
 * There is no per-project flag store yet, so subjectness is:
 *   the platform-wide flag OR `project.metadata.require_declared_agents === true`.
 * New projects stamp the metadata flag at creation (see POST /projects/provision);
 * pre-existing projects stay non-subject (and therefore behave exactly as before)
 * until the platform flag flips or they're explicitly migrated.
 */
export function projectRequiresDeclaredAgents(
  projectMetadata: unknown,
  platformFlag: boolean,
): boolean {
  if (platformFlag) return true;
  if (!projectMetadata || typeof projectMetadata !== 'object') return false;
  return (projectMetadata as Record<string, unknown>).require_declared_agents === true;
}

/** A session/trigger was rejected outright because the project requires
 *  declared agents and the requested identity doesn't resolve to one. */
export interface AgentNotDeclaredError {
  ok: false;
  error: string;
  code: 'AGENT_NOT_DECLARED';
}

export type GovernedAgentGrantResult = { ok: true; grant: AgentGrant | null } | AgentNotDeclaredError;

/**
 * Resolve the per-agent grant when the project MAY be subject to mandatory
 * declared agents. Pure (no I/O) — mirrors `grantFromLoadedAgents` for the
 * non-subject case exactly (same lookup, same fallback, byte-for-byte
 * unchanged behavior), so a non-subject project is provably unaffected.
 *
 * When subject:
 *   - a concrete agent name not declared (or disabled) in `[[agents]]` is
 *     REJECTED with an explicit error — never silently resolved to the
 *     permissive null grant `grantFromLoadedAgents` would return for an
 *     ungoverned project, and never silently default-denied-to-running either.
 *   - the `default` sentinel must resolve to the project's declared
 *     `default_agent`; a project with no `default_agent` configured, or one
 *     that doesn't name a declared/enabled agent, is rejected the same way —
 *     this is what closes trigger/spec seam 7(a) structurally (§2.1).
 *     `opts.projectDefaultAgent` (the DB `project.metadata.default_agent`
 *     mirror callers pass in) wins when set; `loaded.defaultAgent` (the v2
 *     manifest's own top-level `default_agent` — always null for v1) is the
 *     fallback, so a project that never separately configured the DB-side
 *     field still resolves the sentinel to what it actually declared in git.
 *
 * Exported for tests. Callers needing the historical `AgentGrant | null`
 * behavior unconditionally should keep using `grantFromLoadedAgents` /
 * `resolveAgentGrant` directly (e.g. the sandbox token mint, which must
 * never widen on a manifest-read hiccup — see session-sandbox.ts).
 */
export function resolveGovernedAgentGrant(
  agentName: string,
  loaded: LoadedAgents,
  opts: { subject: boolean; projectDefaultAgent: string | null },
): GovernedAgentGrantResult {
  if (!opts.subject) {
    return { ok: true, grant: grantFromLoadedAgents(agentName, loaded) };
  }

  const findDeclared = (name: string) => loaded.specs.find((s) => s.name === name && s.enabled);

  if (agentName === DEFAULT_AGENT_SENTINEL) {
    const declaredDefault = opts.projectDefaultAgent ?? loaded.defaultAgent;
    if (!declaredDefault) {
      return {
        ok: false,
        code: 'AGENT_NOT_DECLARED',
        error:
          'This project requires declared agents but has no default_agent configured — ' +
          'set one in the project settings or kortix.yaml before starting a session.',
      };
    }
    const spec = findDeclared(declaredDefault);
    if (!spec) {
      return {
        ok: false,
        code: 'AGENT_NOT_DECLARED',
        error: `This project's default agent "${declaredDefault}" is not declared (or is disabled) in \`agents\` — the "default" sentinel cannot resolve.`,
      };
    }
    return {
      ok: true,
      grant: grantFromSpec(declaredDefault, spec),
    };
  }

  const spec = findDeclared(agentName);
  if (!spec) {
    return {
      ok: false,
      code: 'AGENT_NOT_DECLARED',
      error: `Agent "${agentName}" is not declared in this project's \`agents\` manifest — this project requires every session/trigger to name a declared agent.`,
    };
  }
  return { ok: true, grant: grantFromSpec(agentName, spec) };
}
