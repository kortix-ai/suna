/**
 * Paging the DURABLE transcript, for the window where the runtime cannot.
 *
 * `SessionSyncController` already pages older history — but every one of its
 * reads goes through `resolveClient`, which throws `RuntimeNotReadyError` while
 * the sandbox is stopped or still starting. That is exactly the window the
 * mirror exists to cover, so in that window the controller holds no cursor and
 * `hasOlder` is false: the saved history paints its first page and stops there,
 * however much more the server kept.
 *
 * These two decisions are the whole seam, kept pure so they are provable
 * without a store, a fetch, or a React tree.
 */

/** Which source can answer "give me the page before this one" right now. */
export function chooseOlderSource(input: {
	/** The controller has a runtime cursor — a live read can answer. */
	runtimeHasOlder: boolean;
	/** The newest mirror window's `next_cursor`, if it left one. */
	mirrorCursor: string | null | undefined;
}): 'runtime' | 'mirror' | null {
	// A live read outranks a snapshot, always — the same rule
	// `shouldHydrateFromMirror` enforces on the way in. When the runtime can
	// answer, its page is the true one and the mirror is at best a copy of it.
	if (input.runtimeHasOlder) return 'runtime';
	if (input.mirrorCursor) return 'mirror';
	return null;
}

/**
 * The cursor to carry forward after hydrating a mirror window.
 *
 * ABSENT IS AN ANSWER. `next_cursor` is optional on the envelope because an
 * older API — a self-host, a staging backend behind this client — does not send
 * it. Reading `undefined` as "ask again" would page forever against a server
 * that has no idea what it is being asked.
 */
export function mirrorCursorAfter(
	envelope: { next_cursor?: string | null } | null | undefined,
): string | null {
	return envelope?.next_cursor ?? null;
}
