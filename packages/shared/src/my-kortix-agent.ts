/** My Kortix, the platform's built-in agent: its slug. Session rows, token
 *  grants, the sandbox slug, image names and the config-release variant key
 *  on it. */
export const MY_KORTIX_AGENT_NAME = 'mykortix';
/** The slug My Kortix had until 2026-10-30. Sessions, tokens and boxes made
 *  before the rename still carry it, so every read accepts it
 *  ({@link isMyKortixAgentName}); nothing new writes it. Drop it when no
 *  session or box from before the rename is live. */
export const LEGACY_MY_KORTIX_AGENT_NAME = 'meta';
export const MY_KORTIX_SANDBOX_SLUG = 'mykortix';
/** My Kortix — the built-in agent's DISPLAY name, the name every UI renders. */
export const MY_KORTIX_DISPLAY_NAME = 'My Kortix';

/** True for My Kortix under its slug, or the legacy `meta` slug of an older session. */
/**
 * How a person reads a session's message handle: My Kortix's own session has
 * the generated handle `mykortix-<short id>` (or the legacy `meta-…`), shown
 * as "My Kortix"; a named agent shows as `@name`.
 */
export function peerHandleLabel(handle: string): string {
  return /^(mykortix|meta)-[0-9a-f]{8}$/.test(handle) ? MY_KORTIX_DISPLAY_NAME : `@${handle}`;
}

export function isMyKortixAgentName(name: string | null | undefined): boolean {
  return name === MY_KORTIX_AGENT_NAME || name === LEGACY_MY_KORTIX_AGENT_NAME;
}

/** True for My Kortix's sandbox slug, or the legacy `meta` slug of an older box. */
export function isMyKortixSandboxSlug(slug: string | null | undefined): boolean {
  return slug === MY_KORTIX_SANDBOX_SLUG || slug === LEGACY_MY_KORTIX_AGENT_NAME;
}

/** The current slug for a name: `meta` becomes `mykortix`, any other name stays. */
export function canonicalAgentName<T extends string | null | undefined>(name: T): T | typeof MY_KORTIX_AGENT_NAME {
  return name === LEGACY_MY_KORTIX_AGENT_NAME ? MY_KORTIX_AGENT_NAME : name;
}

/**
 * The built-in agents a project can turn on or off in `kortix.yaml`
 * (`builtin_agents.<key>: true|false`, absent = on). Each key maps once to the
 * agent slug the platform injects. Add a built-in here, nowhere else.
 */
export const BUILTIN_AGENTS = {
  my_kortix: { agent: MY_KORTIX_AGENT_NAME, displayName: MY_KORTIX_DISPLAY_NAME, sandbox: MY_KORTIX_SANDBOX_SLUG },
} as const;
export type BuiltinAgentKey = keyof typeof BUILTIN_AGENTS;
export const BUILTIN_AGENT_KEYS = Object.keys(BUILTIN_AGENTS) as BuiltinAgentKey[];

/** The `builtin_agents` key of a built-in agent slug (legacy `meta` included), or `null` for a declared agent. */
export function builtinAgentKeyOf(agentName: string | null | undefined): BuiltinAgentKey | null {
  if (!agentName) return null;
  const name = canonicalAgentName(agentName);
  return BUILTIN_AGENT_KEYS.find((key) => BUILTIN_AGENTS[key].agent === name) ?? null;
}
