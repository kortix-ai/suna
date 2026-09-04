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

import type { Message, Part } from "@opencode-ai/sdk/v2/client";
import {
	type SessionTranscriptSyncEnvelope,
	getSessionTranscriptSync,
} from "../../core/rest/projects-client/sessions";
import { claimOpenBundle, takeOpenBundleTranscript } from "../../core/session/open-bundle";

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
	// A live read outranks a snapshot, always.
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
	if (envelope.opencode_session_id !== runtimeSessionId) return false;
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
			.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
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
 * Fetch the mirror. Never throws and never surfaces an error toast: a session
 * that has never been captured is an ordinary answer, not a failure, and this
 * read is an accelerator whose absence costs only the old blank wake.
 */
export async function loadSessionTranscriptMirror(input: {
	kortixSessionScope: string | undefined;
	limit?: number;
	signal?: AbortSignal;
}): Promise<SessionTranscriptSyncEnvelope | null> {
	const scope = parseKortixSessionScope(input.kortixSessionScope);
	if (!scope) return null;
	// The SESSION-OPEN BUNDLE fetches this mirror in the same round trip that
	// answers the turn and the queue. This hydrate runs at MOUNT, while that
	// read is still in flight, so it waits for the read it is riding rather
	// than starting a second one — the wait costs nothing (the bundle is
	// already on the wire) and saves a full transcript request per open.
	//
	// The stash is ONE-SHOT: this is the only reader allowed to paint a
	// snapshot, and a second paint over a store the runtime has already filled
	// is how a transcript grows ghosts.
	const claimed = claimOpenBundle(scope.projectId, scope.sessionId);
	if (claimed) await claimed;
	const stashed = takeOpenBundleTranscript(scope.projectId, scope.sessionId);
	if (stashed) return stashed;
	try {
		return await getSessionTranscriptSync(scope.projectId, scope.sessionId, {
			limit: input.limit ?? MIRROR_HYDRATE_LIMIT,
			signal: input.signal,
		});
	} catch {
		return null;
	}
}
