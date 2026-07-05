import { backendApi } from '../api-client';
import { unwrap } from './shared';

// ── Full v2 agent-config editor (the "agent builder", agent-first spec §2.2) ──
// Round-trips the WHOLE `agents.<name>` block in a kortix_version 2 manifest —
// every OpenCode-parity behavioral field (mode/model/temperature/top_p/steps/
// permission tree/…) plus every Kortix governance field (connectors/secrets/
// skills/kortix_cli/workspace). Distinct from setAgentScope (agent-scope.ts),
// which writes only the secrets/connectors grant subset into a v1 `[[agents]]`
// entry. Manager-gated server-side (project.customize.write); writes commit to
// kortix.yaml. v2-only: `editable:false` on the GET means a v1 project — the UI
// degrades to the limited scope editor.

/** A Kortix governance grant on the wire: an allowlist, or the sentinels. */
export type AgentGrantSetV2 = 'all' | 'none' | string[];

/** A single OpenCode permission action. */
export type PermissionAction = 'ask' | 'allow' | 'deny';

/** A permission rule: a bare action, or a glob-pattern → action map. */
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;

/** The OpenCode `permission` tree — a bare action, or a per-capability object. */
export type PermissionConfig = PermissionAction | Record<string, PermissionRule | PermissionAction>;

/** The nested `opencode:` behavior block — mirrors `OpencodeAgentConfigV2` in
 *  @kortix/manifest-schema. Runtime-specific; namespaced so a future
 *  `runtime: claude`/`codex` project has somewhere else for this to live. */
export interface OpencodeAgentConfig {
  mode?: 'primary' | 'subagent' | 'all';
  variant?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  hidden?: boolean;
  options?: Record<string, unknown>;
  color?: string;
  steps?: number;
  permission?: PermissionConfig;
}

/** The full v2 agent block — mirrors `AgentBlockV2` in @kortix/manifest-schema.
 *  Two layers: top-level Kortix (identity + governance + model, runtime-
 *  agnostic) and the nested `opencode` OpenCode-behavior block. */
export interface AgentConfigBlock {
  description?: string;
  enabled?: boolean;
  model?: string;
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
