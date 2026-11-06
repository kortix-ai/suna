/**
 * Where `/workspaces/<id>` lands. One answer for both of the page's navigations
 * (the `chat` redirect and the `?q=` strip), so they cannot race.
 *
 * - `wait`: draw nothing and navigate nowhere yet (the flag is loading).
 * - `space`: open the person's own space (`/chat`, their chat with My
 *   Kortix); a `?q=` prompt rides in the prefill store.
 * - `home`: project home, as with Spaces off. Also with Spaces on when the
 *   person asked for a new session (`newSessionHref`: the sidebar Sessions `+`, Cmd+J).
 */
export type HomeLanding = { kind: 'wait' } | { kind: 'space' } | { kind: 'home' };

export function resolveHomeLanding(input: {
  flagLoading: boolean;
  channelsOn: boolean;
  /** `?new=1` (`isNewSessionRequested`): the new-session composer, never the person's space. */
  newSessionRequested?: boolean;
}): HomeLanding {
  if (input.flagLoading) return { kind: 'wait' };
  if (!input.channelsOn || input.newSessionRequested) return { kind: 'home' };
  // `/chat` creates the personal space on its first open: nothing to wait for.
  return { kind: 'space' };
}
