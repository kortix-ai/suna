import { backendApi } from '../../http/api-client';
import type { AgentGrantSetV2 } from './agent-config';
import { unwrap } from './shared';

// ── One agent's capability catalog ──
// Every tool, skill and extension a session of one agent can have, with the
// text that describes it. The API builds it (GET /projects/:id/agents/:name/
// capabilities) from the manifest registries, the Kortix skill files and the
// platform's tool and extension lists. Whether one is ON for the agent is its
// grant (`agents.<name>.tools`, `.skills`, `.extensions`): read it with
// `capabilityGranted`, change it with `setCapabilityGranted`.

/** `{ exclude: [...] }`: every name but the listed ones, including names added later. */
export interface AgentExcludeGrant {
  exclude: string[];
}

/** `agents.<name>.tools`, `.skills` or `.extensions` on the wire. */
export type AgentCapabilityGrant = AgentGrantSetV2 | AgentExcludeGrant;

export type AgentCapabilityToolGroup = 'workspace' | 'interaction' | 'kortix' | 'project';

export interface AgentCapabilityTool {
  /** The tool name, as `agents.<name>.tools` writes it. */
  id: string;
  group: AgentCapabilityToolGroup;
  description: string | null;
  /** Other names of the same tool (`task` for `agent`). A switch writes them with `id`. */
  aliases: string[];
  /** The repository module of a project tool, or of a project module that replaces a Kortix tool. Else null. */
  source: string | null;
}

export interface AgentCapabilitySkill {
  id: string;
  /** `builtin`: a Kortix skill every project has. `project`: registered under `skills:`. */
  group: 'builtin' | 'project';
  description: string | null;
  /** The project feature flag the skill exists behind, else null. */
  feature_flag: string | null;
  /** False while `feature_flag` is off for the project: no session has the skill. */
  available: boolean;
}

export interface AgentCapabilityExtension {
  id: string;
  /** `platform`: loaded by the runtime. `project`: registered under `extensions:`. */
  group: 'platform' | 'project';
  description: string | null;
  /** True for a platform extension that is always on and has no switch. */
  required: boolean;
  /** The tool whose switch turns this extension on and off (`agent`, `codemode`), else null. */
  controlled_by: string | null;
}

export interface AgentCapabilities {
  agent: string;
  /** The manifest's schema version. The catalog is complete from 3 on. */
  schema_version: number;
  tools: AgentCapabilityTool[];
  skills: AgentCapabilitySkill[];
  extensions: AgentCapabilityExtension[];
}

export async function getAgentCapabilities(projectId: string, agentName: string) {
  return unwrap(
    await backendApi.get<AgentCapabilities>(
      `/projects/${projectId}/agents/${encodeURIComponent(agentName)}/capabilities`,
      { showErrors: false },
    ),
  );
}

function excludeOf(grant: unknown): string[] | null {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return null;
  const exclude = (grant as { exclude?: unknown }).exclude;
  return Array.isArray(exclude) ? exclude.filter((name): name is string => typeof name === 'string') : null;
}

/**
 * Is `id` on under `grant`? `all` and `*` grant every id, `{ exclude }` every
 * id but those, a list its ids, `none` nothing. An omitted grant reads as
 * `omitted`: `all` for `tools`, `none` for v3 `skills` and `extensions`.
 */
export function capabilityGranted(
  grant: AgentCapabilityGrant | undefined,
  id: string,
  omitted: 'all' | 'none',
): boolean {
  const value = grant ?? omitted;
  const excluded = excludeOf(value);
  if (excluded) return !excluded.includes(id);
  if (value === 'all') return true;
  if (Array.isArray(value)) return value.includes(id) || value.includes('*');
  return false;
}

/**
 * The grant with `id` (and its aliases: pass an array) turned on or off, in
 * the smallest form: one item off under `all` is `{ exclude: [id] }`, the
 * last excluded item back on is `all`, one item on under `none` is `[id]`, and
 * an emptied list is `none`.
 */
export function setCapabilityGranted(
  grant: AgentCapabilityGrant | undefined,
  id: string | string[],
  on: boolean,
  omitted: 'all' | 'none',
): AgentCapabilityGrant {
  const ids = Array.isArray(id) ? id : [id];
  const value = grant ?? omitted;
  if (ids.every((name) => capabilityGranted(value, name, omitted) === on)) return value;
  const excluded = excludeOf(value) ?? (value === 'all' || (Array.isArray(value) && value.includes('*')) ? [] : null);
  if (excluded) {
    const next = on ? excluded.filter((name) => !ids.includes(name)) : [...excluded, ...ids.filter((name) => !excluded.includes(name))];
    return next.length === 0 ? 'all' : { exclude: next };
  }
  const list = Array.isArray(value) ? value : [];
  const next = on ? [...list, ...ids.filter((name) => !list.includes(name))] : list.filter((name) => !ids.includes(name));
  return next.length === 0 ? 'none' : next;
}
