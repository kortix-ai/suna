/**
 * Structural equality for the JSON-shaped values the store holds (message
 * infos and parts). Key order does not matter; `undefined` and a missing key
 * differ, as they would after a JSON round trip.
 */
export function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((value, index) => sameValue(value, b[index]));
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/**
 * A re-read of what the store already holds keeps the store's objects. Rows,
 * blocks and the rendered transcript are reused by identity, so a fresh object
 * for an unchanged message redraws it. Returns the message list to store (the
 * previous array itself when nothing changed) and swaps each unchanged part
 * list in `nextParts` back to the previous one.
 */
export function keepUnchanged<M extends { id: string }, P>(
	previous: readonly M[] | undefined,
	next: M[],
	previousParts: Record<string, P[] | undefined>,
	nextParts: Record<string, P[] | undefined>,
): M[] {
	const byId = new Map((previous ?? []).map((message) => [message.id, message]));
	const shared = next.map((message) => {
		const old = byId.get(message.id);
		return old && sameValue(old, message) ? old : message;
	});
	for (const message of shared) {
		const before = previousParts[message.id];
		const after = nextParts[message.id];
		if (before && after && before !== after && sameValue(before, after)) nextParts[message.id] = before;
	}
	const unchanged =
		previous !== undefined &&
		previous.length === shared.length &&
		shared.every((message, index) => message === previous[index]);
	return unchanged ? (previous as M[]) : shared;
}
