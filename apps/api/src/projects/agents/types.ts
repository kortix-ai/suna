import type { ManifestIssue } from '@kortix/manifest-schema';
import type { BuiltinAgentKey } from '@kortix/shared';

export { MANIFEST_FILENAME } from '@kortix/manifest-schema';

/** `"all"` = every grantable action / every project connector (capped at the user). */
export type GrantSet = string[] | 'all';

export interface AgentSpec {
  /** Agent name — unique per project. Matches projectSessions.agentName. */
  name: string;
  /** e.g. `kortix.yaml#agents.<name>` (or the project's actual manifest filename) for UI / error reporting. */
  path: string;
  /** False: the agent cannot start a session (`enabled: false`, or a validation error on its block). */
  enabled: boolean;
  /** Which connectors (by slug) this agent may use. `[]` = none (default). */
  connectors: GrantSet;
  /** Connectors that must resolve before the session starts. */
  connectorsRequired?: string[];
  /** Connector slug → the policy set (`connectors[].policy_sets`) this agent
   *  gets on that connector (`agents.<name>.policy_sets`). Absent key = the
   *  base rules. Kept AS WRITTEN, even when the set does not exist: the
   *  gateway then blocks that connector for this agent (`policy_set_missing`).
   *  Dropping a bad entry would fall back to the base rules, which fails open.
   *  Null-prototype object; see `readAgentPolicySets`. */
  policySets?: Record<string, string>;
  /** Kortix permissions (project-scoped iam actions). `[]` = none (default). */
  permissions: GrantSet;
  /** Project-secret IDENTIFIERS (project_secrets.identifier, not raw env-var
   *  keys) this agent receives as sandbox env + may read via the secrets API.
   *  `'all'` = every secret in the project; an explicit list narrows it;
   *  `[]` = none (the default, `secrets` omitted). */
  env: GrantSet;
  /** Kortix Apps (by App slug) this agent may open when the App is
   *  `restricted`/`private` (spec 2026-09-22 §2.5). `[]` = none (default). Optional so hand-built specs (tests, fixtures) need
   *  not set it; absent reads as none. */
  apps?: GrantSet;
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
   * The manifest's own top-level `default_agent`. Lets grant resolution make
   * the non-binding `"default"` sentinel resolve to a concrete declared
   * agent's grant for a governed project — see `grantFromLoadedAgents`
   * (spec §2.1).
   */
  defaultAgent?: string | null;
  /** The manifest's validation errors (`runtimeManifest`): an agent one of
   *  them names is off, and a refusal to start it names them. */
  issues?: ManifestIssue[];
  /** The manifest's explicit `builtin_agents` booleans. Absent key = not
   *  set; `resolveBuiltinAgents` (lib/platform-meta-agent.ts) adds the fallback. */
  builtinAgents?: Partial<Record<BuiltinAgentKey, boolean>>;
}
