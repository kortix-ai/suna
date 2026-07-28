import type { CreateProjectSessionInput } from '@kortix/sdk';

/**
 * The overrides a new session can be started with, and the exact create body
 * they turn into.
 *
 * Every one of these is CREATE-ONLY (see `mid-session-change.ts`), which is why
 * they are chosen in a dialog before the session exists rather than adjusted in
 * the workbench afterwards. The builder is pure so what the demo sends can be
 * asserted without booting anything.
 *
 * The rule throughout: an unset override is OMITTED, never sent as a guess.
 * A guessed `secrets: []` would boot a sandbox with no secrets at all, and a
 * guessed binding would pin the session to a connection nobody chose.
 */

/** Which project secrets a session may read. `null` = don't narrow at all. */
export type SecretsAllowlist = string[] | null;

export interface SessionOverrides {
  /** Agent name; null = the project's default agent. */
  agent: string | null;
  /** Secret IDENTIFIERS (not env keys — several identifiers can share a key). */
  secrets: SecretsAllowlist;
  /** Connector alias -> connection profile id. Empty = bind nothing. */
  bindings: Record<string, string>;
}

export const NO_OVERRIDES: SessionOverrides = { agent: null, secrets: null, bindings: {} };

/** Labels for the connections that were bound, keyed by alias — see
 *  `BOUND_CONNECTIONS_KEY`. */
export type BoundConnectionLabels = Record<string, string>;

/**
 * Where this wrapper records WHICH connections it bound.
 *
 * The platform has no read-back for a session's connector bindings — they are
 * accepted at create and never serialized onto the session — so a wrapper that
 * wants to show a running session's bindings has to remember them itself.
 * Session metadata is the session-scoped place to do that, and it is withheld
 * from viewers who can't open the session, same as the allowlist.
 */
export const BOUND_CONNECTIONS_KEY = 'lumen_bound_connections';

export interface SessionCreateExtras {
  sessionId: string;
  name?: string;
  sandboxSlug?: string;
  /** Display labels for the bound connections, recorded in session metadata. */
  connectionLabels?: BoundConnectionLabels;
}

export function buildSessionCreateInput(
  overrides: SessionOverrides,
  extras: SessionCreateExtras,
): CreateProjectSessionInput {
  const aliases = Object.keys(overrides.bindings);

  return {
    session_id: extras.sessionId,
    ...(extras.name ? { name: extras.name } : {}),
    ...(extras.sandboxSlug && extras.sandboxSlug !== 'default'
      ? { sandbox_slug: extras.sandboxSlug }
      : {}),
    ...(overrides.agent ? { agent_name: overrides.agent } : {}),
    // An empty allowlist is a real choice (inject zero project secrets), so the
    // "don't narrow" signal has to be null rather than an empty array.
    ...(overrides.secrets ? { secrets: overrides.secrets } : {}),
    ...(aliases.length > 0
      ? {
          connector_bindings: Object.fromEntries(
            aliases.map((alias) => [alias, { profile_id: overrides.bindings[alias]! }]),
          ),
          // Binding ANY alias otherwise switches every other alias off its
          // project default ("all-or-nothing"). Picking one connection in this
          // dialog must not silently unplug the connectors nobody touched.
          inherit_unbound: true,
          metadata: {
            [BOUND_CONNECTIONS_KEY]: Object.fromEntries(
              aliases.map((alias) => [
                alias,
                extras.connectionLabels?.[alias] ?? overrides.bindings[alias]!,
              ]),
            ),
          },
        }
      : {}),
  };
}
