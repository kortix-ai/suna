/**
 * Whether to render the terminal "Couldn't start session" card. While a session
 * is FRESH (just minted client-side, create still settling) a /start error is the
 * create-vs-start race — boot noise, not a failure — so the instant shell stays
 * up. Once the fresh window has passed (see useSession's bounded grace), a real
 * error surfaces normally.
 */
export function shouldShowStartError(
  startError: { status?: number } | null,
  isFresh: boolean,
): boolean {
  return !!startError && !isFresh;
}
