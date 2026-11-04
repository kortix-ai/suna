/**
 * Where `/projects/<id>` lands. One answer for both of the page's navigations
 * (the `chat` redirect and the `?q=` strip), so they cannot race.
 *
 * - `wait`: draw nothing and navigate nowhere yet (the flag or the channel list is loading).
 * - `channel`: open the default channel; a `?q=` prompt rides in the prefill store.
 * - `home`: project home, as with channels off. Also with channels on when the
 *   person asked for a new session (`newSessionHref`: the sidebar Sessions `+`, Cmd+J).
 */
export type HomeLanding = { kind: 'wait' } | { kind: 'channel'; slug: string } | { kind: 'home' };

export function resolveHomeLanding(input: {
  flagLoading: boolean;
  channelsOn: boolean;
  /** `?new=1` (`isNewSessionRequested`): the new-session composer, never the default channel. */
  newSessionRequested?: boolean;
  spacesLoaded: boolean;
  spacesFailed: boolean;
  /** The slug of the channel with `is_default` (it can be renamed: never assume `general`). */
  defaultSlug: string | null | undefined;
}): HomeLanding {
  if (input.flagLoading) return { kind: 'wait' };
  if (!input.channelsOn || input.newSessionRequested) return { kind: 'home' };
  if (input.defaultSlug) return { kind: 'channel', slug: input.defaultSlug };
  // A failed list, or one with no default channel, keeps project home usable.
  return input.spacesFailed || input.spacesLoaded ? { kind: 'home' } : { kind: 'wait' };
}
