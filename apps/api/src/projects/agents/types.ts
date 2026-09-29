import type { AgentGrant } from '@kortix/db';

export const MANIFEST_FILENAME = 'kortix.toml';

/**
 * The non-binding agent sentinel. `project_sessions.agent_name` defaults to this
 * literal and NO agent is ever named `default` — the runtime resolves it to
 * OpenCode's configured `default_agent` (a general-purpose agent). Kept in sync
 * with the proxy's copy (sandbox-proxy/routes/preview.ts).
 */
export const DEFAULT_AGENT_SENTINEL = 'default';

/** `"all"` = every grantable action / every project connector (capped at the user). */
export type GrantSet = string[] | 'all';

export interface AgentSpec {
  /** Agent name — unique per project. Matches projectSessions.agentName + the `.md` filename. */
  name: string;
  /** e.g. `kortix.yaml#agents.<name>` (or the project's actual manifest filename) for UI / error reporting. */
  path: string;
  /** When false the overlay is skipped (the agent still runs from its `.md`, with default-deny scope). */
  enabled: boolean;
  /** Which connectors (by slug) this agent may use. `[]` = none (default). */
  connectors: GrantSet;
  /** Connectors that must resolve before the session starts. */
  connectorsRequired?: string[];
  /** Kortix permissions (project-scoped iam actions). `[]` = none (default). */
  permissions: GrantSet;
  /** Project-secret IDENTIFIERS (project_secrets.identifier, not raw env-var
   *  keys) this agent receives as sandbox env + may read via the secrets API.
   *  `'all'` = every secret in the project (default when the `env` key is
   *  omitted — a NEW dimension, so omitting it must not starve existing
   *  agents); an explicit list narrows it; `[]` = none. */
  env: GrantSet;
  /** Kortix Apps (by App slug) this agent may open when the App is
   *  `restricted`/`private` (spec 2026-09-22 §2.5). `[]` = none (default, both
   *  manifest versions). Optional so hand-built specs (tests, fixtures) need
   *  not set it; absent reads as none. */
  apps?: GrantSet;
  /** Optional behavior-file path override (defaults to the conventional `.md` by name). */
  file: string | null;
  /**
   * The agent's declarative default model (wire form `provider/model`), or null
   * for "Default" — resolve project → account → platform (`auto`). A
   * `model_preferences` row (scope=agent), set via the SDK/UI, overrides this at
   * run time without a code commit. Catalog-availability is validated at the
   * route/resolver layer (the parser stays catalog-free), same as everywhere the
   * gateway is the source of truth for entitlement.
   */
  model: string | null;
  /** Default sandbox template slug for sessions started with this agent. */
  sandbox?: string | null;
  /** Project file delivery mode for sessions started with this agent. */
  repositoryAccess?: boolean;
  legacyReadWorkspace?: boolean;
}

export interface AgentParseError {
  name: string;
  path: string;
  error: string;
}

export interface LoadedAgents {
  specs: AgentSpec[];
  errors: AgentParseError[];
  /** Where the specs came from: the manifest's blob sha and the commit it was
   *  read at. `null` revision/commit = synthesized (no manifest on disk) or a
   *  read with no git context; absent = the manifest could not be read at all.
   *  Grants derived from these specs carry the same provenance
   *  (`AgentGrant.manifestRevision` / `manifestCommit`). */
  manifest?: { revision: string | null; commit: string | null } | null;
  /**
   * The manifest's own top-level `default_agent` (v2; v1 has no such
   * field, so this is always `null` for a v1 manifest). Lets grant resolution
   * make the non-binding `"default"` sentinel resolve to a concrete declared
   * agent's grant for a governed project,
   * instead of falling back to the permissive `null` (unrestricted) v1
   * behavior — see `grantFromLoadedAgents` (spec §2.1).
   */
  defaultAgent?: string | null;
}

/** A session/trigger was rejected outright because the project requires
 *  declared agents and the requested identity doesn't resolve to one. */
export interface AgentNotDeclaredError {
  ok: false;
  error: string;
  code: 'AGENT_NOT_DECLARED';
}

export type GovernedAgentGrantResult = { ok: true; grant: AgentGrant | null } | AgentNotDeclaredError;
