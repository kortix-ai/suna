import { backendApi } from '../api-client';
import { unwrap } from './shared';

// ── Full v2 agent-config editor (the "agent builder", agent-first spec §2.2,
// redirected 2026-07-05 — "one home per concern") ──
// Round-trips the agent's TWO homes as one wire shape: `block` (governance —
// connectors/secrets/skills/kortix_cli/workspace/enabled, written to
// kortix.yaml) and `block.opencode` (OpenCode BEHAVIOR — mode/model/
// temperature/top_p/steps/variant/color/hidden/permission/prompt, written to
// the agent's own native `.kortix/opencode/agents/<name>.md` frontmatter +
// body). The backend route is what merges the two files into this one
// response/request shape — see apps/api/src/projects/routes/agent-config.ts.
// Distinct from setAgentScope (agent-scope.ts), which writes only the
// secrets/connectors grant subset into a v1 `[[agents]]` entry. Manager-gated
// server-side (project.customize.write). v2-only: `editable:false` on the GET
// means a v1 project — the UI degrades to the limited scope editor.

/** A Kortix governance grant on the wire: an allowlist, or the sentinels. */
export type AgentGrantSetV2 = 'all' | 'none' | string[];

/** A single OpenCode permission action. */
export type PermissionAction = 'ask' | 'allow' | 'deny';

/** A permission rule: a bare action, or a glob-pattern → action map. */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;

/** The OpenCode `permission` tree — a bare action, or a per-capability object. */
export type PermissionConfig = PermissionAction | Record<string, PermissionRule | PermissionAction>;

/** The OpenCode BEHAVIOR half — everything that lives in the agent's own
 *  `.md` frontmatter (+ `prompt`, the file's BODY text, not a path). */
export interface OpencodeAgentConfig {
  description?: string;
  mode?: 'primary' | 'subagent' | 'all';
  model?: string;
  variant?: string;
  temperature?: number;
  top_p?: number;
  /** The agent's system prompt — the `.md`'s BODY text (frontmatter stripped),
   *  not a file path/reference. */
  prompt?: string;
  hidden?: boolean;
  options?: Record<string, unknown>;
  color?: string;
  steps?: number;
  permission?: PermissionConfig;
}

/** The full agent block on the wire — mirrors `AgentBlockV2` in
 *  @kortix/manifest-schema PLUS the merged `opencode` behavior half (a wire-
 *  only convenience; kortix.yaml itself never nests `opencode` — see the
 *  module doc above). */
export interface AgentConfigBlock {
  /** v3 logical routing fields. Runtime behavior remains in native config. */
  runtime?: string;
  agent?: string;
  enabled?: boolean;
  connectors?: AgentGrantSetV2;
  secrets?: AgentGrantSetV2;
  skills?: AgentGrantSetV2;
  kortix_cli?: AgentGrantSetV2;
  workspace?: 'runtime' | 'read' | 'branch';
  opencode?: OpencodeAgentConfig;
}

export interface AgentConfigResponse {
  agent: string;
  /** The manifest's declared schema version — 2 means the full editor applies. */
  schema_version: number;
  /** True iff the full block is editable (a kortix_version 2 manifest). */
  editable: boolean;
  /** The manifest's top-level `default_agent` (v2 only; null for v1). */
  default_agent: string | null;
  /** The declared block, or null for a v1 manifest / an agent not declared yet. */
  block: AgentConfigBlock | null;
  /** v3 named runtime profiles available to this project. */
  runtimes?: Record<string, { harness: 'claude' | 'codex' | 'opencode' | 'pi'; config_dir?: string }>;
}

export async function getAgentConfig(projectId: string, agentName: string) {
  return unwrap(
    await backendApi.get<AgentConfigResponse>(
      `/projects/${projectId}/agents/${encodeURIComponent(agentName)}/config`,
    ),
  );
}

export async function updateAgentConfig(
  projectId: string,
  agentName: string,
  block: AgentConfigBlock,
) {
  return unwrap(
    await backendApi.put<{
      ok: boolean;
      agent: string;
      schema_version: number;
      block: AgentConfigBlock | null;
    }>(`/projects/${projectId}/agents/${encodeURIComponent(agentName)}/config`, block),
  );
}

export interface UpdateProjectDefaultAgentResponse {
  ok: boolean;
  default_agent: string;
}

/** Set the declared project default in `kortix.yaml` (v2 projects). */
export async function updateProjectDefaultAgent(projectId: string, agentName: string) {
  return unwrap(
    await backendApi.put<UpdateProjectDefaultAgentResponse>(
      `/projects/${projectId}/default-agent`,
      { agent: agentName },
    ),
  );
}
