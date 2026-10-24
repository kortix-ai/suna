export const META_AGENT_NAME = 'meta';
export const META_SANDBOX_SLUG = 'meta';
/** My Kortix — the built-in agent's DISPLAY name. The internal slug stays `meta`
 *  (it keys session rows, the token grant, the sandbox slug and image names, and
 *  the config-release variant); this is the name every UI renders. */
export const META_AGENT_DISPLAY_NAME = 'My Kortix';

export function isMetaAgentName(name: string | null | undefined): boolean {
  return name === META_AGENT_NAME;
}

/**
 * The built-in agents a project can turn on or off in `kortix.yaml`
 * (`builtin_agents.<key>: true|false`, absent = on). Each key maps once to the
 * agent slug the platform injects. Add a built-in here, nowhere else.
 */
export const BUILTIN_AGENTS = {
  my_kortix: { agent: META_AGENT_NAME, displayName: META_AGENT_DISPLAY_NAME, sandbox: META_SANDBOX_SLUG },
} as const;
export type BuiltinAgentKey = keyof typeof BUILTIN_AGENTS;
export const BUILTIN_AGENT_KEYS = Object.keys(BUILTIN_AGENTS) as BuiltinAgentKey[];

/** The `builtin_agents` key of a built-in agent slug, or `null` for a declared agent. */
export function builtinAgentKeyOf(agentName: string | null | undefined): BuiltinAgentKey | null {
  if (!agentName) return null;
  return BUILTIN_AGENT_KEYS.find((key) => BUILTIN_AGENTS[key].agent === agentName) ?? null;
}
