/**
 * Painting a saved v1 copy (the device's, or one a host hands in) while the
 * session's sandbox is still waking. Nothing here reads the network: the
 * session log is the only saved copy a client reads (`GET …/log`, P8.3).
 *
 * WHAT THIS REPLACES. An IndexedDB mirror used to do this and was deleted
 * (`5a7a43517f`) because its freshness test read the transcript's SHAPE —
 * message count, total part count, tail id — and the two things that end a turn
 * move none of them: `time.completed` stamped on the tail message, and the
 * `error` a Stop stamps. A stopped thread therefore cold-painted as still
 * running, with every message under it dimmed to "Queued".
 * `use-session-sync.ts` records the acceptance criterion for any replacement:
 * *it needs a mirror whose freshness test reads the MESSAGE, not its shape.*
 *
 * This one does, three ways:
 *
 *  1. The server writes the mirror BECAUSE a turn ended (the `turn-stream`
 *     `end`/`turn_end` relay), so freshness is a property of the write. There
 *     is no client-side freshness test left to get wrong.
 *  2. The payload carries OpenCode's `info` envelope VERBATIM, so
 *     `time.completed` and `error` travel with the message and every existing
 *     turn predicate reads the truth.
 *  3. The envelope names the OpenCode ROOT it was captured from, so a mirror
 *     belonging to a re-pinned box is REFUSED rather than painted as ghosts.
 *     The disk cache was keyed by a scope string and could not make this check.
 *
 * Painted messages are hydrated with `source: 'cache'`, so the store's existing
 * settle rule owns reconciliation: the first runtime read confirms every id it
 * contains and drops any it covers but lacks. That rule is unchanged — the
 * mirror simply gives it real OpenCode ids to settle, which is what the old
 * cache could not guarantee (it also held optimistic stubs that never existed
 * on the runtime).
 */

import type { Message, Part } from "../../core/runtime/runtime-types";
import type { SessionTranscriptSyncEnvelope } from "../../core/rest/projects-client/sessions";

export interface MirrorHydrateDecision {
	envelope: SessionTranscriptSyncEnvelope | null;
	/** The OpenCode root this hook is about to sync. */
	runtimeSessionId: string;
	/** The store already holds messages for that root. */
	hasMessages: boolean;
}

/**
 * May this mirror be painted? Pure, so every refusal is a test rather than a
 * convention.
 */
export function shouldHydrateFromMirror(input: MirrorHydrateDecision): boolean {
	const { envelope, runtimeSessionId, hasMessages } = input;
	if (!envelope) return false;
	// A live read WITH messages outranks a snapshot, always. An empty one does
	// not: it is evidence the box lost its state, whichever read lands first.
	if (hasMessages) return false;
	// No root yet means no identity to match against, so nothing can be proven
	// about the ids in the payload.
	if (!runtimeSessionId) return false;
	if (!envelope.available) return false;
	// `source` is the claim. An empty array is not one.
	if (envelope.source !== "mirror") return false;
	if (envelope.messages.length === 0) return false;
	// THE IDENTITY GUARD: ids from another OpenCode root can never be settled by
	// this root's runtime read.
	if ((envelope.runtime_session_id ?? envelope.opencode_session_id) !== runtimeSessionId) return false;
	return true;
}

/**
 * Envelope -> the exact shape `useSyncStore.hydrate` takes.
 *
 * A message with no `id` is DROPPED, never given one: an id the runtime will
 * not also produce is precisely the ghost the settle rule cannot reconcile.
 * Parts are id-sorted because the store's part lookup is a binary search that
 * assumes its writers sorted (see `sync-store.ts`).
 */
export function mirrorMessagesForHydrate(
	envelope: SessionTranscriptSyncEnvelope,
): Array<{ info: Message; parts: Part[] }> {
	const out: Array<{ info: Message; parts: Part[] }> = [];
	for (const row of envelope.messages) {
		const info = row?.info;
		if (!info || typeof info !== "object") continue;
		const id = typeof info.id === "string" ? info.id.trim() : "";
		if (!id) continue;
		const parts = (Array.isArray(row.parts) ? row.parts : [])
			.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
			.slice()
			// Byte order, as `reconcile-parts.ts` sorts and the store's binary
			// search reads. `localeCompare` is collation order and disagreed on
			// mixed-case ids (KRTX-2897).
			.sort((a, b) => {
				const x = String(a.id ?? "");
				const y = String(b.id ?? "");
				return x < y ? -1 : x > y ? 1 : 0;
			});
		out.push({ info: info as unknown as Message, parts: parts as unknown as Part[] });
	}
	return out;
}

/**
 * `${projectId}/${sessionId}` — the scope string `useSessionSync` already
 * carries for cache ownership. Parsed rather than threaded through as two more
 * options so the hook's published signature does not change.
 */
export function parseKortixSessionScope(
	scope: string | undefined,
): { projectId: string; sessionId: string } | null {
	if (!scope) return null;
	const slash = scope.indexOf("/");
	if (slash <= 0 || slash === scope.length - 1) return null;
	const projectId = scope.slice(0, slash);
	const sessionId = scope.slice(slash + 1);
	if (!projectId || !sessionId || sessionId.includes("/")) return null;
	return { projectId, sessionId };
}
