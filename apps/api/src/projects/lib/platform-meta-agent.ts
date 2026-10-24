// No runtime imports beyond @kortix/shared: `projects/agents.ts` resolves the
// coordinator's grant from here, and `projects/git/config.ts` imports that —
// which `e2e-project-session-branch-git` loads in a `bun --eval` subprocess and
// parses stdout from. Pulling `feature-flags/registry` (and through it the
// config module, which banners on stdout) into that chain breaks it. The
// legacy per-project switch is read at each call site with the canonical
// `resolveFeatureFlag(metadata, 'meta_agent')` and passed to
// `resolveBuiltinAgents` below as the fallback.
//
// My Kortix is the platform's built-in agent. Its slug stays `meta`: session
// rows, token grants, the sandbox slug, image names and the config-release
// variant all key on it. Users only ever see the display name.
import {
  BUILTIN_AGENT_KEYS,
  BUILTIN_AGENTS,
  builtinAgentKeyOf,
  type BuiltinAgentKey,
  META_AGENT_NAME,
  META_SANDBOX_SLUG,
} from '@kortix/shared';
import type { AgentGrant } from '@kortix/db';
import type { ProjectConfigSummary } from '../git/types';

/** My Kortix's one-line description, the same in the agent list and the compiled config. */
export const MY_KORTIX_DESCRIPTION =
  'The one agent you talk to. It runs your agents, goals and spaces for you, with your permissions.';

/**
 * The `builtin_agents` values a manifest sets explicitly. Only booleans count;
 * an absent key (or a v1/v2 manifest, whose validator refuses the key) says
 * nothing.
 */
export function declaredBuiltinAgents(
  manifest: Record<string, unknown> | null | undefined,
): Partial<Record<BuiltinAgentKey, boolean>> {
  const node = manifest?.builtin_agents;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {};
  const declared: Partial<Record<BuiltinAgentKey, boolean>> = {};
  for (const key of BUILTIN_AGENT_KEYS) {
    const value = (node as Record<string, unknown>)[key];
    if (typeof value === 'boolean') declared[key] = value;
  }
  return declared;
}

/**
 * Which built-in agents this project runs. Per key: the manifest's boolean
 * (the repository is the source of truth), else the legacy per-project
 * `meta_agent` switch the caller resolved, else on.
 */
export function resolveBuiltinAgents(
  declared: Partial<Record<BuiltinAgentKey, boolean>>,
  legacyMetaAgent: boolean,
): Record<BuiltinAgentKey, boolean> {
  return { my_kortix: declared.my_kortix ?? legacyMetaAgent };
}

/**
 * The built-in agent `agentName` names, when the project runs it. `null` for a
 * declared agent, and for a built-in the project turned off: that name is then
 * an ordinary (undeclared) agent name.
 */
export function enabledBuiltinAgentKey(
  agentName: string | null | undefined,
  builtinAgents: Record<BuiltinAgentKey, boolean>,
): BuiltinAgentKey | null {
  const key = builtinAgentKeyOf(agentName);
  return key && builtinAgents[key] ? key : null;
}

/**
 * GET /agents/:name/config for a built-in agent. Its configuration is
 * platform-owned: never editable, no block. Answering 200 instead of the
 * declared-roster 404 keeps every host and the CLI from reporting
 * `No agent "meta" declared in kortix.yaml` for an agent the project lists.
 */
export function builtinAgentConfigView(key: BuiltinAgentKey, schemaVersion: number, defaultAgent: string | null) {
  return {
    agent: BUILTIN_AGENTS[key].agent,
    builtin: key,
    schema_version: schemaVersion,
    editable: false,
    default_agent: defaultAgent,
    block: null,
    harness: 'pi' as const,
    ignored_settings: [] as string[],
  };
}

/** The refusal for a write that targets a built-in agent's configuration. */
export function builtinAgentWriteRefusal(key: BuiltinAgentKey) {
  return {
    error: `${BUILTIN_AGENTS[key].displayName} is built in: Kortix maintains its prompt, tools and model. To remove it from this project, set \`builtin_agents: { ${key}: false }\` in kortix.yaml.`,
    code: 'builtin_agent_managed' as const,
  };
}

export function addPlatformMetaAgent(config: ProjectConfigSummary): ProjectConfigSummary {
  return {
    ...config,
    default_agent: META_AGENT_NAME,
    open_code_default_agent: META_AGENT_NAME,
    agents: [
      {
        name: META_AGENT_NAME,
        path: '/workspace/AGENTS.md',
        description: MY_KORTIX_DESCRIPTION,
        mode: 'primary',
        source: 'opencode',
        platform: true,
        enabled: true,
        sandbox: META_SANDBOX_SLUG,
        scope: {
          env: [],
          connectors: [],
          kortix_permissions: 'all',
          // Deprecated wire alias of kortix_permissions (pre-rename clients).
          kortix_cli: 'all',
        },
      },
      ...config.agents.filter((agent) => agent.name !== META_AGENT_NAME),
    ],
  };
}

export function buildPlatformMetaOpenCodeConfig(): string {
  return JSON.stringify({
    agent: {
      [META_AGENT_NAME]: {
        description: MY_KORTIX_DESCRIPTION,
        mode: 'primary',
        prompt:
          'You are My Kortix. Follow /workspace/AGENTS.md. Run the project through the Kortix CLI with the user\'s own permissions: answer and configure yourself, delegate every production task to a session of the narrowest project agent via --prompt, and report the verified result.',
      },
    },
  });
}

/**
 * The platform coordinator can manage every surface inside its bound project.
 *
 * The project-bound PAT and the launching user's IAM role remain the outer
 * authorization boundaries. Project secrets and connectors stay unavailable
 * because the coordinator delegates project work to specialized sessions.
 */
export function platformMetaAgentGrant(): AgentGrant {
  return {
    agent: META_AGENT_NAME,
    permissions: 'all',
    connectors: [],
    env: [],
  };
}

/**
 * The grant of a `meta` session in a project whose kortix.yaml turned My Kortix
 * off: no project action beyond reading it. The per-prompt re-mint writes it
 * onto a session that started while My Kortix was on.
 */
export function disabledPlatformMetaAgentGrant(): AgentGrant {
  return { agent: META_AGENT_NAME, permissions: [], connectors: [], env: [] };
}

export function resolvePlatformMetaSandbox(requestedSlug: string | null | undefined): string {
  if (requestedSlug && requestedSlug !== META_SANDBOX_SLUG) {
    throw new Error('META_SANDBOX_LOCKED');
  }
  return META_SANDBOX_SLUG;
}
