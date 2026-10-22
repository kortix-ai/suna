import { featureFlags } from '../../http/feature-flags';
import type { ProjectConfigSummary } from './projects';

/**
 * Seeded per project by the project paradigm. The file stays on disk after the
 * flag turns off, so the flag, not the file, decides whether it is offered.
 */
const PROJECT_ONLY_AGENTS = new Set(['project-manager']);

/** The fields the selectable-agent rule reads. Both the project config entry
 *  and the OpenCode `Agent` shape satisfy it. `native` is the runtime's own
 *  marker for its built-in agents (`build`, `plan`, …); a project config entry
 *  never carries it. */
export interface SelectableAgentFields {
  name: string;
  mode?: string | null;
  hidden?: boolean;
  enabled?: boolean;
  native?: boolean | null;
}

/**
 * The one rule for "a user can pick this agent to prompt": not a subagent, not
 * hidden, not disabled, not an OpenCode built-in, and not gated behind a
 * feature flag. Every agent picker on every host applies this rule and no
 * other.
 */
export function isSelectableAgent(agent: SelectableAgentFields): boolean {
  if (agent.native === true) return false;
  if (agent.mode === 'subagent' || agent.hidden || agent.enabled === false) return false;
  return featureFlags.enableProjects || !PROJECT_ONLY_AGENTS.has(agent.name);
}

/**
 * The agents a user can pick for a project, from the Kortix project config
 * (`GET /projects/:id/detail` → `config`), with the project default first.
 *
 * This is the source of truth for agent pickers. The sandbox runtime's own
 * agent list also contains the runtime's built-in agents, which are not
 * project agents; do not use it for a picker.
 */
export function selectableProjectAgents(
  config: ProjectConfigSummary,
): ProjectConfigSummary['agents'] {
  const agents = config.agents.filter(isSelectableAgent);
  const defaultName = config.default_agent ?? config.open_code_default_agent;
  if (!defaultName) return agents;
  return agents.sort((left, right) => {
    if (left.name === defaultName) return -1;
    if (right.name === defaultName) return 1;
    return 0;
  });
}
