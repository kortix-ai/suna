/**
 * `agents` block parsing for `kortix.yaml` (a legacy v1 project may instead
 * declare `[[agents]]` in `kortix.toml` — both are parsed here).
 *
 * An agent's *behavior* still comes from its OpenCode `.md` (front matter:
 * prompt/model/mode/tools/permission/skill-perms). Once a project declares
 * `agents:`, this block is also the server-side launch roster and the
 * governance policy keyed by agent name. Its grant fields cover the two things
 * the agent `.md` can't express:
 *
 *   1. `connectors` — which connectors (by `connectors[].slug`) the
 *      agent may call. Default: none.
 *   2. `kortix_permissions` — what the agent may do to Kortix itself
 *      (project-scoped iam actions: deploy, open CRs, triggers, …), through
 *      any surface — CLI, API, git. `kortix_cli` is the deprecated alias.
 *      Default: none. Account-scoped admin actions are NEVER grantable.
 *
 * The effective grant at session birth is `declared ∩ launching-user role`
 * (agent ≤ human). The default `kortix` agent is granted everything (`"all"`),
 * which ∩ the user = exactly the user's own permissions.
 *
 * Example (kortix.yaml, v2):
 *
 *   agents:
 *     kortix: {}                          # default GP agent — connectors/kortix_permissions = "all" (∩ user)
 *     release-bot:
 *       connectors: ["github"]            # which connectors
 *       kortix_permissions: ["project.trigger.create", "project.gitops.push"]   # Kortix permissions
 *
 * Parser mirrors `projects/connectors.ts`: never throws on a bad entry, collects
 * them in `errors` so the UI can render them next to the good ones.
 */

export { GRANTABLE_KORTIX_PERMISSIONS, extractAgents, loadProjectAgents } from './agents/parse';
export {
  DEFAULT_AGENT_SENTINEL,
  OPENCODE_BUILTIN_AGENT_NAMES,
  grantFromLoadedAgents,
  grantsByAgent,
  grantsOfManifestText,
  isLaunchableAgentName,
  legacyReadWorkspaceFromLoadedAgents,
  projectRequiresDeclaredAgents,
  repositoryAccessFromLoadedAgents,
  requiredConnectorsForAgent,
  resolveAgentGrant,
  resolveGovernedAgentGrant,
  sandboxFromLoadedAgents,
  type AgentNotDeclaredError,
  type GovernedAgentGrantResult,
} from './agents/grants';
export { agentSpecToTomlEntry, applyAgentScope, manifestHashForAgent } from './agents/crud';
export type { AgentParseError, AgentSpec, GrantSet, LoadedAgents } from './agents/types';
