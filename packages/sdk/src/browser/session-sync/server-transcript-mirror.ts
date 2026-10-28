/**
 * Painting a session's history from the SERVER's transcript mirror while its
 * sandbox is still waking.
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
import {
	type SessionTranscriptSyncEnvelope,
	getSessionTranscriptSync,
} from "../../core/rest/projects-client/sessions";
import type { SavedCopyStore } from "../../core/session-sync/saved-copy-store";
import { loadSavedTranscript } from "../../core/session-sync/saved-transcript";

/** How many mirrored messages a first paint asks for. Matches the sync
 *  controller's own initial tail, so the mirror and the read that replaces it
 *  cover the same window. */
export const MIRROR_HYDRATE_LIMIT = 40;

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

/**
 * Fetch the saved copy for a host that passed `useSessionSync` no `mirror`.
 * Never throws and never surfaces an error toast: a session that has never
 * been captured is an ordinary answer, not a failure, and this read is an
 * accelerator whose absence costs only the old blank wake.
 *
 * The conversation's window is THE saved-history read
 * (`loadSavedTranscript`): the session-open snapshot's window when one is in
 * flight or just answered, else the route. `useSession` passes its answer in,
 * so for a session it owns this never runs. A sub-agent's window is read here,
 * by `child`: the snapshot carries only the conversation's.
 *
 * @deprecated Reads the v1 saved copy. `useSessionSync` reads the session log first and calls this only when the log answers 404. Read the session log instead: `getSessionLogPage` (`kortix.session(p, s).log(query)`, `GET …/log`). Removed in the next major.
 */
export async function loadSessionTranscriptMirror(input: {
	kortixSessionScope: string | undefined;
	signal?: AbortSignal;
	/** A sub-agent's OpenCode session inside the scope: its own saved window. */
	child?: string;
}): Promise<SessionTranscriptSyncEnvelope | null> {
	const scope = parseKortixSessionScope(input.kortixSessionScope);
	if (!scope) return null;
	try {
		return input.child
			? await getSessionTranscriptSync(scope.projectId, scope.sessionId, {
					limit: MIRROR_HYDRATE_LIMIT,
					signal: input.signal,
					child: input.child,
				})
			: await loadSavedTranscript(scope.projectId, scope.sessionId, { signal: input.signal });
	} catch {
		return null;
	}
}

/**
 * The mirror window OLDER than `before`.
 *
 * Deliberately NOT `loadSessionTranscriptMirror` with an extra argument: that
 * function can answer from the session-open snapshot, which holds the FIRST
 * window and must never be handed back for an older one. This is always a
 * fresh read.
 *
 * `history: true` is not sent. It only adds the server's current-root check,
 * and `shouldHydrateFromMirror` already applies that guard client-side — the
 * rows are the same either way.
 *
 * Never throws, for the same reason the first window does not: paging further
 * back is an accelerator, and its absence costs only the page the user cannot
 * see yet.
 *
 * @deprecated Reads the v1 saved copy. Older log pages: `useSessionLogOlder` (`GET …/log?before_seq=`). Removed in the next major.
 */
export async function loadOlderSessionTranscriptMirror(input: {
	kortixSessionScope: string | undefined;
	before: string;
	limit?: number;
	signal?: AbortSignal;
	/** A sub-agent's OpenCode session inside the scope. */
	child?: string;
}): Promise<SessionTranscriptSyncEnvelope | null> {
	const scope = parseKortixSessionScope(input.kortixSessionScope);
	if (!scope) return null;
	try {
		return await getSessionTranscriptSync(scope.projectId, scope.sessionId, {
			limit: input.limit ?? MIRROR_HYDRATE_LIMIT,
			before: input.before,
			signal: input.signal,
			child: input.child,
		});
	} catch {
		return null;
	}
}

/** The route's largest window: an export walks the whole saved copy. */
const SAVED_EXPORT_WINDOW = 500;

/**
 * Every message of the saved copy, oldest first: each window back from the
 * newest, until the server leaves no cursor. For an export, which needs the
 * whole conversation while the computer cannot answer. Unlike the reads above
 * it throws on a failed read: a partial export must not pass for a whole one.
 *
 * @deprecated Reads the v1 saved copy. `loadSessionExportMessages` reads the session log first. Read the session log instead: `getSessionLogPage` (`kortix.session(p, s).log(query)`, `GET …/log`). Removed in the next major.
 */
export async function loadSavedSessionTranscriptMessages(
	scope: { projectId: string; sessionId: string },
	signal?: AbortSignal,
): Promise<Array<{ info: Message; parts: Part[] }>> {
	const windows: Array<Array<{ info: Message; parts: Part[] }>> = [];
	const seen = new Set<string>();
	let before: string | null = null;
	do {
		const envelope = await getSessionTranscriptSync(scope.projectId, scope.sessionId, {
			limit: SAVED_EXPORT_WINDOW,
			history: true,
			before,
			signal,
		});
		if (!envelope.available) break;
		windows.unshift(mirrorMessagesForHydrate(envelope));
		before = envelope.next_cursor ?? null;
		// A cursor the server already gave is a server that is not advancing.
		if (before !== null && seen.has(before)) break;
		if (before !== null) seen.add(before);
	} while (before !== null);
	return windows.flat();
}

/**
 * How long after a turn ends the device's copy is re-read. The server writes
 * its saved copy on the turn-end relay, a moment after the runtime goes idle;
 * reading at once would return the copy from the turn before.
 */
export const SAVED_COPY_REFRESH_DELAY_MS = 3_000;

/**
 * Replace the device's copy of one session with the server's current one.
 * Never throws: a failed read leaves the kept copy as it was.
 */
export async function refreshSavedCopy(
	store: SavedCopyStore,
	projectId: string,
	sessionId: string,
): Promise<void> {
	try {
		const envelope = await getSessionTranscriptSync(projectId, sessionId, {
			limit: MIRROR_HYDRATE_LIMIT,
		});
		if (envelope) await store.write(projectId, sessionId, envelope);
	} catch {
		// The kept copy stays; the next open reconciles anyway.
	}
}
