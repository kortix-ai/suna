"use client";

import type {
	Message,
	Event as OpenCodeEvent,
	Part,
	ReasoningPart,
	SessionStatus,
	TextPart,
	Todo,
} from "@opencode-ai/sdk/v2/client";
import { create } from "zustand";

import { ascendingId } from "./sync-store/ascending-id";
import { Binary } from "./sync-store/binary";
import { writeStreamCache } from "./sync-store/stream-cache";
import type { FileDiff, MessageError, MessageWithParts } from "./sync-store/types";

// Re-export moved helpers/types so the public surface stays byte-identical:
// `Binary`, `ascendingId`, and the `MessageWithParts` type remain importable
// from this module exactly as before.
export { ascendingId, Binary };
export type { MessageError, MessageWithParts };

/** The two `Part` variants that carry streaming `.text` (vs. tool/file/etc.
 *  parts, which don't). Narrows a `Part` down so `.text` is safe to read
 *  without a cast — every `Part` member shares `id`/`sessionID`/`messageID`/
 *  `type`, but only these two carry `text`. */
type TextLikePart = TextPart | ReasoningPart;
function isTextLikePart(part: Part): part is TextLikePart {
	return part.type === "text" || part.type === "reasoning";
}

// ============================================================================
// Store State
// ============================================================================

interface SyncState {
	// Core data (per-session, sorted arrays — matches SolidJS store shape)
	messages: Record<string, Message[]>;
	parts: Record<string, Part[]>;
	sessionStatus: Record<string, SessionStatus>;
	diffs: Record<string, FileDiff[]>;
	todos: Record<string, Todo[]>;

	// ---- Actions ----
	applyEvent: (event: OpenCodeEvent) => void;
	upsertMessage: (sessionID: string, message: Message) => void;
	removeMessage: (sessionID: string, messageID: string) => void;
	/**
	 * `sessionID` is optional. Omitted, the deltaActiveParts guard below reads
	 * `part.sessionID` directly. Pass it explicitly whenever the caller already
	 * resolved a more trustworthy session id than the wire part carries — see
	 * the `message.part.updated` handler in `applyEvent`, which falls back to
	 * scanning every session's message list specifically because
	 * `part.sessionID` can be absent on the wire. Without this parameter that
	 * resolved id has nowhere to go, and the guard silently no-ops for exactly
	 * the malformed events it exists to protect against.
	 *
	 * Kept optional (not merged into `part`, not required) because `upsertPart`
	 * has real callers outside this file (`apps/web` via `useSessionStateStore`)
	 * that only ever pass `(messageID, part)` — this stays source-compatible
	 * with them.
	 */
	upsertPart: (messageID: string, part: Part, sessionID?: string) => void;
	removePart: (messageID: string, partID: string) => void;
	/**
	 * `sessionID` is a new REQUIRED leading parameter (was `(messageID, partID,
	 * field, delta)`) — a breaking arity change for anyone calling this action
	 * directly. Deliberate, not silent: the only caller of `applyPartDelta` in
	 * this repo is this file's own `applyEvent` (`message.part.delta` case),
	 * which already has a reliable `sessionID` on the event itself — no
	 * "resolve it from an unreliable field" case like `upsertPart` above.
	 * Kept required, not optional-with-fallback, because there is no
	 * `part.sessionID`-equivalent to fall back to here that wouldn't be a
	 * guess. Verified no other in-repo caller exists (`apps/web`, `apps/mobile`
	 * both use their own stores/methods, not this one). This action is exported
	 * on `useSyncStore` (`./sync-store`, `./internal/sync-store`), which makes
	 * it technically part of the published surface, so an out-of-repo consumer
	 * calling it directly would fail to compile — that needs a semver-relevant
	 * callout in the next release notes.
	 */
	applyPartDelta: (
		sessionID: string,
		messageID: string,
		partID: string,
		field: string,
		delta: string,
	) => void;
	setStatus: (sessionID: string, status: SessionStatus) => void;
	setDiff: (sessionID: string, diffs: FileDiff[]) => void;
	setTodo: (sessionID: string, todos: Todo[]) => void;
	optimisticAdd: (
		sessionID: string,
		message: Message,
		messageParts: Part[],
	) => void;
	optimisticRemove: (sessionID: string, messageID: string) => void;
	/**
	 * Mark an optimistic message as actually POSTed to the server.
	 *
	 * Until this is called the message is `pending`: the server has never been
	 * told about it, so it cannot be a duplicate of anything the server returns.
	 * {@link SyncState.hydrate} relies on that to tell "still uploading" apart
	 * from "already echoed" — see the two-pass correlation there.
	 *
	 * Callers that never call this lose only the ordinal fallback; exact
	 * part-id correlation still supersedes their messages normally.
	 */
	markOptimisticDispatched: (sessionID: string, messageID: string) => void;
	clearOptimisticMessages: (sessionID: string) => void;
	/** True when the session's message list still holds an unconfirmed optimistic
	 *  message — lets the SSE reconciler avoid idling+clearing a brand-new session
	 *  whose first prompt the server hasn't registered yet. */
	hasOptimisticMessages: (sessionID: string) => boolean;
	clearSession: (sessionID: string) => void;
	/**
	 * Take a hold on `sessionID`'s transcript for one mounted consumer, and get
	 * back the release for it. The session's data stays resident until every
	 * hold is released; see {@link DETACHED_SESSION_LIMIT} for what happens
	 * after that.
	 *
	 * Returning the release rather than exposing a separate `releaseSession`
	 * makes the pairing structural — a caller cannot take a hold without
	 * receiving the matching release, and a React effect returns it directly:
	 *
	 * ```ts
	 * useEffect(() => useSyncStore.getState().retainSession(id), [id]);
	 * ```
	 *
	 * Same shape as `retainSessionSyncController` in session-sync-registry.ts.
	 * The release is idempotent: calling it twice drops one hold, not two.
	 */
	retainSession: (sessionID: string) => () => void;
	/**
	 * Join this session's messages with their parts, memoized on the identity of
	 * the arrays it read.
	 *
	 * Every consumer selects through here — `useSessionSync` and
	 * `useOpenCodeMessages` alike. It has to be one shared memo rather than one
	 * per hook: `getMessages` rebuilds via `.map()` on every call, so a raw
	 * selector returns a new array each time, fails `useSyncExternalStore`'s
	 * `Object.is` check and re-renders forever. The memo previously existed
	 * TWICE, once in each hook file, and neither copy was dropped when a
	 * session's data was — so an evicted transcript stayed reachable through
	 * whichever memo still held its rows. Keeping it in the store, next to the
	 * eviction that invalidates it, is what makes that impossible rather than
	 * merely fixed.
	 */
	buildSessionMessages: (
		sessionID: string,
		msgs: Message[] | undefined,
		parts: Record<string, Part[]>,
	) => MessageWithParts[];
	hydrate: (
		sessionID: string,
		msgs: Array<{ info: Message; parts: Part[] }>,
	) => void;
	reset: () => void;

	// ---- Selector ----
	getMessages: (sessionID: string) => MessageWithParts[];

	// ---- Compat selectors (for old store consumers) ----
	// These mirror the old store shapes so external components can migrate gradually
	statuses: Record<string, SessionStatus>;
}

// ============================================================================
// Store Implementation
// Track optimistic message IDs so we can remove them when the server sends
// the real user message (which has a different, server-generated ID).
// Keyed by session, like every other field in this store. It used to be one
// process-wide `Set<string>` shared by every session in the tab, and
// `clearSession` never released its entries — so ids accumulated for the
// lifetime of the tab, and a leaked id made `hydrate` skip parts for any real
// message that happened to reuse it (`if (isOptimistic(...)) continue`).
const optimisticIds = new Map<string, Set<string>>();
// Optimistic ids whose prompt has actually been POSTed. An optimistic message
// starts `pending` (absent here) and becomes `dispatched` when the send goes
// out. `hydrate` never lets a `pending` message be superseded by an ordinal
// match: the server has not been told it exists, so nothing the server returns
// can be a copy of it.
const dispatchedOptimisticIds = new Map<string, Set<string>>();

function trackId(store: Map<string, Set<string>>, sessionID: string, id: string): void {
	const bucket = store.get(sessionID);
	if (bucket) bucket.add(id);
	else store.set(sessionID, new Set([id]));
}

function untrackId(store: Map<string, Set<string>>, sessionID: string, id: string): void {
	const bucket = store.get(sessionID);
	if (!bucket) return;
	bucket.delete(id);
	if (bucket.size === 0) store.delete(sessionID);
}

function hasTrackedId(
	store: Map<string, Set<string>>,
	sessionID: string,
	id: string,
): boolean {
	return store.get(sessionID)?.has(id) ?? false;
}

/** Release every id this session was tracking — called from `clearSession`
 *  and from eviction. */
function forgetSessionIds(sessionID: string): void {
	optimisticIds.delete(sessionID);
	dispatchedOptimisticIds.delete(sessionID);
	// The joined rows hold the very message and part arrays this session's
	// data is being dropped from. Left behind, they keep the transcript
	// reachable and the drop achieves nothing.
	sessionMessageRows.delete(sessionID);
	// A session cleared without ever going idle/erroring (the only other
	// release points, below) would otherwise leave a dead bucket in
	// deltaActiveParts for the lifetime of the tab — the exact leak class
	// this function exists to prevent for optimisticIds above.
	deltaActiveParts.delete(sessionID);
	// Same leak class, on bridgedPartIds: it used to be released only by
	// reset() (which application code never calls), not by clearSession, so
	// a message id stayed "bridged" forever once bridged once. If a LATER
	// message in a different session ever reused that id, upsertPart's
	// bridge-clearing branch fired for it too, wiping every part already
	// stored under it. See bridgedPartIds below.
	bridgedPartIds.delete(sessionID);
}

const isOptimistic = (sessionID: string, messageID: string) =>
	hasTrackedId(optimisticIds, sessionID, messageID);
const isDispatched = (sessionID: string, messageID: string) =>
	hasTrackedId(dispatchedOptimisticIds, sessionID, messageID);
// Track message IDs where optimistic parts were bridged to the real message,
// keyed by session — same shape and same reason as optimisticIds above. When
// the first real part arrives for a bridged message, the bridged parts are
// cleared so optimistic and real parts don't co-exist (which would
// double-render the user's text).
//
// It used to be one process-wide Set<string> shared by every session in the
// tab, cleared only by reset() — clearSession never released its entries, so
// ids accumulated for the lifetime of the tab. A leaked id made upsertPart
// treat any LATER message that reused it (in any session) as still-bridged:
// the first real text part for that id wiped every part already stored under
// it, even though nothing was ever bridged in that session. Keying by session
// and releasing only the ending session's bucket (via forgetSessionIds)
// fixes it.
const bridgedPartIds = new Map<string, Set<string>>();

// Track part IDs that have received at least one delta, keyed by session —
// same shape and same reason as optimisticIds above. Used by upsertPart to
// avoid overwriting delta-accumulated text with a stale message.part.updated
// snapshot that arrives in the same event batch. A session's entries are
// cleared when THAT session's stream goes idle or errors.
//
// It used to be one process-wide Set<string> shared by every session in the
// tab, cleared wholesale on session.idle/session.error. Session B going idle
// wiped session A's tracking while A was still streaming, so the guard below
// stopped protecting A — a stale snapshot could then overwrite A's
// delta-accumulated text. Keying by session and releasing only the ending
// session's bucket fixes it.
const deltaActiveParts = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Session retention — how a transcript ever LEAVES memory again.
//
// `messages` and `parts` are keyed by session and nothing removed a key.
// `clearSession` has one caller (a cache-ownership conflict in
// use-session-sync.ts) and `reset()` has none in application code, so every
// session a user opened kept its full transcript and every part for the
// lifetime of the tab. Open ten long sessions and memory climbs monotonically
// and never comes back.
//
// So: reference-count the mounted consumers of each session and free it once
// the last one is gone. Same idea as React Query's observer count, but bounded
// by COUNT rather than by a `gcTime` timer — memory pressure is "how many
// transcripts are resident", not "how old is this one", and a count needs no
// timer in a store that has none today and stays deterministic under test.
// ---------------------------------------------------------------------------

/**
 * How many sessions keep their transcript resident after their LAST consumer
 * unmounts, most-recently-detached first.
 *
 * Not zero, for two reasons:
 *  1. React StrictMode double-invokes effects (mount → cleanup → mount) in the
 *     same commit. Freeing the instant the count hits zero would blank the
 *     transcript on every dev mount, and again on every fast refresh.
 *  2. Back-and-forth between two or three sessions is the common navigation.
 *     Holding them costs nothing to correctness and skips a disk round trip —
 *     and a round trip is the GOOD case: `getCurrentCacheScope()` returns null
 *     when unauthenticated, and then nothing was ever written to disk to
 *     return to.
 *
 * Small, because memory must be TIGHTER than disk: `idb-sync-cache.ts` bounds
 * the on-disk cache at 50 sessions / 7 days.
 */
const DETACHED_SESSION_LIMIT = 3;

/**
 * The joined `MessageWithParts[]` rows, per session — see
 * {@link SyncState.buildSessionMessages}. Bounded, and dropped for real by
 * `forgetSessionIds`.
 */
const MESSAGE_ROWS_LIMIT = 20;
const sessionMessageRows = new Map<
	string,
	{
		msgs: Message[] | undefined;
		partRefs: (Part[] | undefined)[];
		result: MessageWithParts[];
	}
>();
const EMPTY_MESSAGE_ROWS: MessageWithParts[] = [];

/** Insert-or-refresh `sessionID` as the most recently used entry, dropping the
 *  least recently used one once the map is over {@link MESSAGE_ROWS_LIMIT}.
 *  Re-inserting is what moves a key to the end of a Map's iteration order. */
function touchSessionMessageRows(
	sessionID: string,
	entry: {
		msgs: Message[] | undefined;
		partRefs: (Part[] | undefined)[];
		result: MessageWithParts[];
	},
): void {
	sessionMessageRows.delete(sessionID);
	sessionMessageRows.set(sessionID, entry);
	if (sessionMessageRows.size > MESSAGE_ROWS_LIMIT) {
		const leastRecentlyUsed = sessionMessageRows.keys().next().value;
		if (leastRecentlyUsed) sessionMessageRows.delete(leastRecentlyUsed);
	}
}

/** Mounted consumers per session. Absent means "nobody ever retained this" —
 *  see the release returned by `retainSession`, which then leaves the session
 *  alone entirely. */
const sessionConsumers = new Map<string, number>();
/** Sessions at zero consumers, oldest first (Set preserves insertion order). */
const detachedSessions = new Set<string>();

type SyncData = Pick<
	SyncState,
	"messages" | "parts" | "sessionStatus" | "diffs" | "todos"
>;

/**
 * Free the part buckets belonging to `sessionIDs` that no message points at.
 *
 * `parts` is keyed by messageID, so every sweep that walks a session's
 * `messages` misses the buckets with no message entry to walk from — and the
 * store creates those on purpose. `message.part.delta` stores the part but
 * SKIPS creating the assistant message when the session holds no user message
 * yet (a delta that beats `hydrate()` after a page refresh), so `hydrate` can
 * attach the real one later. Nothing else ever revisits the bucket, so before
 * this it outlived both eviction and `clearSession`: the leak this file's
 * retention work exists to close, left open on the one path that produces it.
 *
 * Attribution is by `Part.sessionID`, which is what those stub parts carry.
 * `every` rather than `some` so a bucket is only freed when the whole thing is
 * this session's; a bucket whose parts arrived without a `sessionID` is
 * unattributable and deliberately left alone rather than guessed at.
 *
 * Mutates `parts` — a caller-owned copy in both call sites.
 */
function deleteOrphanPartBuckets(
	parts: Record<string, Part[]>,
	sessionIDs: readonly string[],
): void {
	const dropped = new Set(sessionIDs);
	for (const messageID of Object.keys(parts)) {
		const bucket = parts[messageID];
		if (!bucket || bucket.length === 0) continue;
		const owner = bucket[0].sessionID;
		if (!owner || !dropped.has(owner)) continue;
		if (bucket.every((part) => part.sessionID === owner)) delete parts[messageID];
	}
}

/**
 * Drop these sessions' data outright.
 *
 * DELETES the `messages` key rather than emptying it, unlike `clearSession`.
 * The difference is load-bearing: `use-session-sync.ts` reads `sessionId in
 * store.messages` both for `isLoading` and (via `shouldHydrateFromCache`) to
 * decide whether the IndexedDB transcript may repaint. An empty array reads as
 * "loaded, and empty", which would leave a returning user staring at a blank
 * transcript that never repaints.
 *
 * `sessionStatus` is deliberately NOT dropped. It is the one slice read for
 * sessions that are on purpose not resident — a parent's spawn-tool banner
 * reads `sessionStatus[child]` for a child whose transcript the parent never
 * holds (`tool/shared/sub-agent.tsx`, `tool/tools/removed-integration-tool.tsx`).
 * Dropping it bought no memory either: every `session.status` frame, and the
 * connect-time `client.session.status()` poll, re-add an entry for every
 * session on the runtime whether or not it is resident, so the delete was
 * undone on the next frame — while the gap was visible to the user. One small
 * status object per session is not the memory this eviction reclaims; the
 * transcript arrays are.
 */
function dropSessionData(state: SyncData, sessionIDs: readonly string[]): SyncData {
	const messages = { ...state.messages };
	const parts = { ...state.parts };
	const diffs = { ...state.diffs };
	const todos = { ...state.todos };
	for (const sessionID of sessionIDs) {
		for (const message of messages[sessionID] ?? []) delete parts[message.id];
		delete messages[sessionID];
		delete diffs[sessionID];
		delete todos[sessionID];
	}
	deleteOrphanPartBuckets(parts, sessionIDs);
	return { messages, parts, sessionStatus: state.sessionStatus, diffs, todos };
}

/**
 * Prune the detached window down to {@link DETACHED_SESSION_LIMIT}, freeing the
 * oldest sessions past it. Returns the ids it freed.
 *
 * Runs when a session is RETAINED, never when one is released. React runs every
 * passive destroy before any passive create in a commit, so pruning on release
 * would let the unmount of B evict A in the very commit that mounts A: visit
 * A → X → Y → B and go back to A, and A is the oldest of four detached
 * sessions at exactly the wrong moment. Pruning after the incoming session has
 * been removed from the window makes that unreachable, and keeps `set()` out of
 * the unmount path entirely.
 *
 * The window therefore holds at most LIMIT + (releases since the last retain),
 * and is back to LIMIT the moment any session mounts.
 *
 * Synchronous on purpose. Deferring it (a microtask, a post-commit hook) so
 * that every retain in a commit lands first would buy nothing, because the
 * ordering it would buy is already guaranteed. The case that motivates
 * deferral is a parent's spawn-tool preview of a child session, and the
 * preview's `useOpenCodeMessages(childId)` is always a React DESCENDANT of the
 * component that retains the parent (`SessionLayout` → the transcript → the
 * tool part). React runs passive effects bottom-up, so in any commit that
 * mounts both, the child's retain lands before the parent's — and therefore
 * before the prune the parent's retain triggers. Deferral would only cost the
 * determinism that keeps unmount out of the eviction path.
 *
 * (The argument this replaces claimed the child's data "arrives a commit or
 * more after the parent mounts". That is not universally true — a parent whose
 * transcript is already resident renders it in the mount commit — and the
 * conclusion never depended on it.)
 *
 * The residual hazard is narrower than it looks, and worth naming exactly.
 * Only a child session the user opened DIRECTLY and then left is ever an
 * eviction candidate; one that was only ever previewed was never retained, and
 * `retainSession` leaves sessions it has never seen alone. What such a child
 * loses is its `messages`/`parts` — `sessionStatus` survives eviction on
 * purpose (see `dropSessionData`), so a preview's retry banner keeps reading.
 * A preview showing a transcript has no repaint path of its own, so closing
 * the rest needs the reference declared before the data is read — either the
 * host retaining child ids when it parses the parent's transcript, or
 * `useOpenCodeMessages` reading the disk cache the way `useSessionSync` does.
 * The second needs the child's `kortixSessionScope` plumbed through from the
 * host: entries written for an opened session are keyed
 * `…:kortix-session:<scope>`, so a scopeless read looks up a different key and
 * misses (idb-sync-cache-key.ts:6-9).
 */
function pruneDetachedSessions(): string[] {
	const evicted: string[] = [];
	while (detachedSessions.size > DETACHED_SESSION_LIMIT) {
		const oldest: string | undefined = detachedSessions.values().next().value;
		if (oldest === undefined) break;
		detachedSessions.delete(oldest);
		evicted.push(oldest);
	}
	return evicted;
}

// ============================================================================

export const useSyncStore = create<SyncState>()((set, get) => ({
	messages: {},
	parts: {},
	sessionStatus: {},
	diffs: {},
	todos: {},

	// Compat alias
	get statuses() {
		return get().sessionStatus;
	},

	// ---- Core mutations ----

	upsertMessage: (sessionID, message) =>
		set((s) => {
			const list = s.messages[sessionID] ?? [];
			// First try binary search (fast path for sorted lists).
			const result = Binary.search(list, message.id, (m) => m.id);
			// Verify the binary search result — the list may be temporarily
			// unsorted due to optimistic messages appended at the end.
			const bsValid = result.found && list[result.index]?.id === message.id;
			if (bsValid) {
				const next = [...list];
				next[result.index] = message;
				return { messages: { ...s.messages, [sessionID]: next } };
			}
			// Fall back to linear scan to handle unsorted optimistic entries.
			const linearIdx = list.findIndex((m) => m.id === message.id);
			if (linearIdx !== -1) {
				const next = [...list];
				next[linearIdx] = message;
				return { messages: { ...s.messages, [sessionID]: next } };
			}
			// New message — insert at sorted position via binary search.
			const next = [...list];
			next.splice(result.index, 0, message);
			return { messages: { ...s.messages, [sessionID]: next } };
		}),

	removeMessage: (sessionID, messageID) =>
		set((s) => {
			const list = s.messages[sessionID];
			if (!list) return s;
			// Try binary search first, fall back to linear for unsorted lists.
			const result = Binary.search(list, messageID, (m) => m.id);
			const idx = (result.found && list[result.index]?.id === messageID)
				? result.index
				: list.findIndex((m) => m.id === messageID);
			if (idx === -1) return s;
			const next = [...list];
			next.splice(idx, 1);
			const { [messageID]: _, ...restParts } = s.parts;
			return {
				messages: { ...s.messages, [sessionID]: next },
				parts: restParts,
			};
		}),

	upsertPart: (messageID, part, sessionID) =>
		set((s) => {
			// See the `sessionID` param doc above: prefer the caller-resolved id,
			// fall back to the part's own field only when no caller passed one.
			const partSessionID = sessionID ?? part.sessionID;
			// If this message had bridged (optimistic) parts, clear them now
			// that a real part has arrived — prevents double-rendering.
			let list: Part[];
			let bridgeCleared = false;
			if (hasTrackedId(bridgedPartIds, partSessionID, messageID)) {
				// Only retire the optimistic/bridged user text once a REAL text
				// part with actual content arrives. A stray non-text part — or an
				// empty text snapshot — must NOT wipe the bridge, otherwise the
				// user's message renders as an empty bubble.
				const incoming = part as { type?: string; text?: unknown };
				const incomingIsRealText =
					incoming?.type === "text" &&
					typeof incoming.text === "string" &&
					incoming.text.length > 0;
				if (incomingIsRealText) {
					untrackId(bridgedPartIds, partSessionID, messageID);
					list = [];
					bridgeCleared = true;
				} else {
					list = s.parts[messageID] ?? [];
				}
			} else {
				list = s.parts[messageID] ?? [];
			}
			const result = Binary.search(list, part.id, (p) => p.id);
			if (result.found) {
				const prev = list[result.index];
				const prevIsTextLike = isTextLikePart(prev);
				const incomingIsTextLike = isTextLikePart(part);
				const tracksStreamingText = prevIsTextLike && incomingIsTextLike;
				const prevText = prevIsTextLike ? prev.text : null;
				const incomingText = incomingIsTextLike ? part.text : null;

				// Guard against out-of-order/stale part snapshots that can cause
				// the stream to jump or start from the middle.
				// For existing text parts, only accept full-text replacements that
				// are monotonic prefix growth (incoming starts with previous).
				// Otherwise keep the existing part as-is — returning `s` avoids
				// creating a new state reference which would cause infinite
				// re-render loops in consuming components.
				if (
					tracksStreamingText &&
					prevText !== null &&
					incomingText !== null &&
					prevText.length > 0
				) {
					const isPrefixGrowth = incomingText.startsWith(prevText);
					if (!isPrefixGrowth) {
						// Incoming text is not a prefix extension — reject the update
						// entirely. Returning `s` preserves referential equality and
						// prevents downstream selectors from re-firing.
						if (!bridgeCleared) return s;
						// Bridge was cleared but we still need to keep the existing part.
						const next = [...list];
						next[result.index] = prev;
						return { parts: { ...s.parts, [messageID]: next } };
					}
				}
			}
			const next = [...list];
			if (result.found) {
				next[result.index] = part;
			} else {
				// For NEW text/reasoning parts: if deltas have already been
				// applied for this part ID, the part was created by the delta
				// handler with correct accumulated text. A message.part.updated
				// snapshot arriving later in the same batch could carry stale
				// text (missing the beginning). Skip the insert — the delta-
				// created version already exists in the parts list under the
				// message entry created by the delta handler.
					if (hasTrackedId(deltaActiveParts, partSessionID, part.id) && isTextLikePart(part)) {
					// Delta-created part already exists — check all messageID
					// buckets since the delta handler may have stored it under
					// a different (stub) message entry.
					const allParts = Object.values(s.parts);
					for (const pl of allParts) {
						if (pl && pl.some((p) => p.id === part.id)) {
							return s;
						}
					}
				}
				next.splice(result.index, 0, part);
			}
			return { parts: { ...s.parts, [messageID]: next } };
		}),

	removePart: (messageID, partID) =>
		set((s) => {
			const list = s.parts[messageID];
			if (!list) return s;
			const result = Binary.search(list, partID, (p) => p.id);
			if (!result.found) return s;
			const next = [...list];
			next.splice(result.index, 1);
			if (next.length === 0) {
				const { [messageID]: _, ...restParts } = s.parts;
				return { parts: restParts };
			}
			return { parts: { ...s.parts, [messageID]: next } };
		}),

	applyPartDelta: (sessionID, messageID, partID, field, delta) => {
		trackId(deltaActiveParts, sessionID, partID);
		set((s) => {
			const list = s.parts[messageID];
			if (!list) return s;
			const result = Binary.search(list, partID, (p) => p.id);
			if (!result.found) return s;
			const next = [...list];
			const part = { ...next[result.index] };
			const existing = (part as Record<string, unknown>)[field] as
				| string
				| undefined;
			(part as Record<string, unknown>)[field] = (existing ?? "") + delta;
			next[result.index] = part as Part;
			return { parts: { ...s.parts, [messageID]: next } };
		});
	},

	setStatus: (sessionID, status) =>
		set((s) => ({
			sessionStatus: { ...s.sessionStatus, [sessionID]: status },
		})),

	setDiff: (sessionID, diffs) =>
		set((s) => ({
			diffs: { ...s.diffs, [sessionID]: diffs },
		})),

	setTodo: (sessionID, todos) =>
		set((s) => ({
			todos: { ...s.todos, [sessionID]: todos },
		})),

	optimisticAdd: (sessionID, message, messageParts) => {
		trackId(optimisticIds, sessionID, message.id);
		set((s) => {
			const list = s.messages[sessionID] ?? [];
			// Always append optimistic messages at the end of the list.
			// Client-generated IDs can sort before server IDs due to clock skew
			// (browser vs Docker). Appending ensures the user message appears
			// at the bottom of the chat. The list may be temporarily unsorted,
			// but upsertMessage and optimisticRemove handle this correctly.
			const nextMsgs = [...list.filter((m) => m.id !== message.id), message];
			const sorted = messageParts
				.filter((p) => !!p?.id)
				.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			return {
				messages: { ...s.messages, [sessionID]: nextMsgs },
				parts: { ...s.parts, [message.id]: sorted },
			};
		});
	},

	markOptimisticDispatched: (sessionID, messageID) => {
		if (isOptimistic(sessionID, messageID))
			trackId(dispatchedOptimisticIds, sessionID, messageID);
	},

	optimisticRemove: (sessionID, messageID) => {
		untrackId(optimisticIds, sessionID, messageID);
		untrackId(dispatchedOptimisticIds, sessionID, messageID);
		set((s) => {
			const list = s.messages[sessionID];
			if (!list) return s;
			// Use linear search — optimistic messages may be appended out of
			// sorted order, so Binary.search can miss them.
			const idx = list.findIndex((m) => m.id === messageID);
			if (idx === -1) return s;
			const nextMsgs = [...list];
			nextMsgs.splice(idx, 1);
			const { [messageID]: _, ...restParts } = s.parts;
			return {
				messages: { ...s.messages, [sessionID]: nextMsgs },
				parts: restParts,
			};
		});
	},

	clearOptimisticMessages: (sessionID) => {
		set((s) => {
			const list = s.messages[sessionID];
			if (!list) return s;
			const optIds = list
				.filter((m) => isOptimistic(sessionID, m.id))
				.map((m) => m.id);
			if (optIds.length === 0) return s;
			for (const id of optIds) {
				untrackId(optimisticIds, sessionID, id);
				untrackId(dispatchedOptimisticIds, sessionID, id);
			}
			const filtered = list.filter((m) => !optIds.includes(m.id));
			const newParts = { ...s.parts };
			for (const id of optIds) delete newParts[id];
			return {
				messages: { ...s.messages, [sessionID]: filtered },
				parts: newParts,
			};
		});
	},

	clearSession: (sessionID) =>
		set((s) => {
			// Release this session's optimistic tracking along with its messages.
			// Skipping it is what let ids accumulate for the lifetime of the tab.
			forgetSessionIds(sessionID);
			const existingMessages = s.messages[sessionID] ?? [];
			const nextParts = { ...s.parts };
			for (const message of existingMessages) delete nextParts[message.id];
			deleteOrphanPartBuckets(nextParts, [sessionID]);
			return {
				messages: { ...s.messages, [sessionID]: [] },
				parts: nextParts,
				sessionStatus: { ...s.sessionStatus, [sessionID]: { type: "idle" } as SessionStatus },
				diffs: { ...s.diffs, [sessionID]: [] },
				todos: { ...s.todos, [sessionID]: [] },
			};
		}),

	retainSession: (sessionID) => {
		if (!sessionID) return () => {};
		// Out of the detach window BEFORE pruning it, so mounting a session can
		// never be what evicts it.
		detachedSessions.delete(sessionID);
		sessionConsumers.set(sessionID, (sessionConsumers.get(sessionID) ?? 0) + 1);

		const evicted = pruneDetachedSessions();
		if (evicted.length > 0) {
			for (const id of evicted) forgetSessionIds(id);
			set((s) => dropSessionData(s, evicted));
		}

		let released = false;
		return () => {
			if (released) return;
			released = true;
			const held = sessionConsumers.get(sessionID);
			if (held === undefined) return;
			// Another consumer still has this session on screen. THE case a raw
			// unmount gets wrong: a transcript and a context modal, a split
			// view, or a parent's spawn-tool preview of a child session.
			if (held > 1) {
				sessionConsumers.set(sessionID, held - 1);
				return;
			}
			sessionConsumers.delete(sessionID);
			// Re-insert so this session is the NEWEST detached one, not wherever
			// a previous detach left it. Nothing is freed here — see
			// `pruneDetachedSessions`.
			detachedSessions.delete(sessionID);
			detachedSessions.add(sessionID);
		};
	},

	buildSessionMessages: (sessionID, msgs, parts) => {
		if (!msgs || msgs.length === 0) return EMPTY_MESSAGE_ROWS;

		const cached = sessionMessageRows.get(sessionID);
		if (cached && cached.msgs === msgs) {
			let same = cached.partRefs.length === msgs.length;
			if (same) {
				for (let i = 0; i < msgs.length; i++) {
					if (parts[msgs[i].id] !== cached.partRefs[i]) {
						same = false;
						break;
					}
				}
			}
			if (same) {
				// A hit is USE. Without this the order is insertion order, not
				// recency, and a stable session that renders unchanged for
				// minutes is pushed out by other sessions' rebuilds — costing it
				// a needless rebuild and one extra render.
				touchSessionMessageRows(sessionID, cached);
				return cached.result;
			}
		}

		const partRefs: (Part[] | undefined)[] = [];
		const result: MessageWithParts[] = [];
		for (const info of msgs) {
			const messageParts = parts[info.id];
			partRefs.push(messageParts);
			result.push({ info, parts: messageParts ?? [] });
		}
		touchSessionMessageRows(sessionID, { msgs, partRefs, result });
		return result;
	},

	hydrate: (sessionID, msgs) =>
		set((s) => {
			const cmp = (a: string, b: string) =>
				a < b ? -1 : a > b ? 1 : 0;
			const incoming = msgs
				.filter((m) => !!m?.info?.id)
				.map((m) => m.info)
				.sort((a, b) => cmp(a.id, b.id));

			// Merge incoming messages with existing ones — never delete messages
			// that exist in the sync store but are missing from the fetch (they may
			// be from a newer turn that the server hasn't persisted yet).
			const existing = s.messages[sessionID] ?? [];
			const merged: typeof existing = [];
			const seen = new Set<string>();

			// Which optimistic user messages has the server actually echoed?
			//
			// This test used to be EXISTENTIAL: "if this page holds any real user
			// message at all, every optimistic user message is a duplicate". In an
			// ongoing conversation that is always true — the page is full of
			// earlier turns — so a message sent one second ago, which the server
			// had provably never received, was deleted along with its text. The
			// window was wide open by construction: the rehydrate that calls this
			// only runs for sessions whose status is `busy`, and the optimistic
			// add is what sets `busy`. Sending armed the thing that deleted the
			// send.
			//
			// The rule is now identity-based, in two passes.
			const existingIds = new Set(existing.map((m) => m.id));

			// Pass 0 — candidate echoes. A real user message we have NEVER seen
			// before may be the server's copy of something still in flight. One we
			// already held is history, and history cannot supersede the present.
			// This single condition is what fixes the reported bug.
			const candidateEchoes = incoming.filter(
				(m) =>
					m.role === "user" &&
					!isOptimistic(sessionID, m.id) &&
					!existingIds.has(m.id),
			);
			const unclaimedEchoes = new Set(candidateEchoes.map((m) => m.id));

			// Pass 1 — exact correlation by part id. Hosts generate the text part
			// id up front and send it WITH the prompt precisely so the echo
			// updates the same part, which makes this an identity match rather
			// than a guess.
			const echoByPartId = new Map<string, string>();
			for (const echo of candidateEchoes) {
				const entry = msgs.find((m) => m.info.id === echo.id);
				for (const p of entry?.parts ?? []) {
					if (p?.id) echoByPartId.set(p.id, echo.id);
				}
			}

			// Start with all incoming messages
			for (const m of incoming) {
				merged.push(m);
				seen.add(m.id);
			}
			// Add any existing messages not in incoming (optimistic or from live SSE).
			// Optimistic messages go at the end to avoid clock-skew sorting issues;
			// non-optimistic ones are inserted at their sorted position.
			const deferredOptimistic: typeof existing = [];
			const supersededOptimistic: string[] = [];
			/** optimistic id → the incoming message that superseded it. */
			const supersededBy = new Map<string, string>();
			const unmatchedOptimisticUsers: typeof existing = [];
			for (const m of existing) {
				if (!seen.has(m.id)) {
					if (isOptimistic(sessionID, m.id)) {
						if (m.role !== "user") {
							deferredOptimistic.push(m);
							continue;
						}
						const echoId = (s.parts[m.id] ?? [])
							.map((p) => echoByPartId.get(p.id))
							.find((id): id is string => !!id);
						if (echoId) {
							supersededOptimistic.push(m.id);
							supersededBy.set(m.id, echoId);
							unclaimedEchoes.delete(echoId);
						} else {
							// Undecided until pass 2 — it may still pair with an
							// echo whose parts the server has not persisted yet.
							unmatchedOptimisticUsers.push(m);
						}
					} else {
						const r = Binary.search(merged, m.id, (x) => x.id);
						merged.splice(r.index, 0, m);
					}
				}
			}

			// Pass 2 — ordinal fallback, for an echo the server accepted but whose
			// parts have not landed yet (no part ids to match on). Restricted to
			// DISPATCHED messages: one that has not been POSTed cannot be a
			// duplicate of anything the server holds, so it is never eligible.
			// That restriction is what keeps a message sent from another tab from
			// consuming this tab's in-flight bubble.
			const claimable = candidateEchoes.filter((m) => unclaimedEchoes.has(m.id));
			let next = 0;
			for (const m of unmatchedOptimisticUsers) {
				const echo = isDispatched(sessionID, m.id)
					? claimable[next]
					: undefined;
				if (echo) {
					next += 1;
					supersededOptimistic.push(m.id);
					supersededBy.set(m.id, echo.id);
				} else {
					deferredOptimistic.push(m);
				}
			}

			// Clean up superseded optimistic IDs
			for (const id of supersededOptimistic) {
				untrackId(optimisticIds, sessionID, id);
				untrackId(dispatchedOptimisticIds, sessionID, id);
			}
			// Append surviving optimistic messages at the end
			for (const m of deferredOptimistic) {
				merged.push(m);
			}

			// Merge parts: for each message, reconcile by part ID.
			// If a message is optimistic (still in optimisticIds), keep existing
			// parts entirely — they're from the client and shouldn't be overwritten.
			// Otherwise, incoming parts win (server is authoritative), but keep
			// any extra parts from SSE that aren't in the fetch response.
			const newParts = { ...s.parts };
			// When superseding an optimistic user message, bridge its parts to
			// the real user message ID if the server hasn't sent parts yet.
			// Mirrors the message.updated SSE handler (see above) — without
			// this, a fetch/hydrate that races ahead of parts persistence
			// would drop the user's text and render an empty bubble.
			// Bridge along the pairing established above, not to "whichever real
			// user message came first". With more than one message in flight the
			// first-match version could graft one message's text onto another's
			// bubble; `supersededBy` names the exact echo each optimistic message
			// lost to.
			for (const id of supersededOptimistic) {
				const echoId = supersededBy.get(id);
				const bridge = newParts[id];
				delete newParts[id];
				if (!echoId || !bridge?.length) continue;
				const echoEntry = msgs.find((m) => m.info.id === echoId);
				const serverHasParts = (echoEntry?.parts?.length ?? 0) > 0;
				if (serverHasParts || newParts[echoId]?.length) continue;
				newParts[echoId] = bridge;
				trackId(bridgedPartIds, sessionID, echoId);
			}
			for (const m of msgs) {
				if (!m?.info?.id) continue;
				const mid = m.info.id;
				if (isOptimistic(sessionID, mid)) continue; // Don't touch optimistic parts

				const inParts = m.parts
					.filter((p) => !!p?.id)
					.sort((a, b) => cmp(a.id, b.id));
				// If this message still carries bridged optimistic parts, a hydrate
				// snapshot with real parts should replace them immediately. Otherwise
				// reconcile-by-extras can keep both copies and duplicate user text.
				if (hasTrackedId(bridgedPartIds, sessionID, mid) && inParts.length > 0) {
					untrackId(bridgedPartIds, sessionID, mid);
					newParts[mid] = inParts;
					continue;
				}
				const exParts = newParts[mid];
				if (!exParts || exParts.length === 0) {
					newParts[mid] = inParts;
					continue;
				}
				// Reconcile by key: incoming parts are generally authoritative,
				// but for text/reasoning parts during active streaming, SSE-accumulated
				// parts may have MORE content than the server snapshot (the
				// server may return empty/stale text for in-progress parts).
				// In that case, prefer the existing (SSE) version.
				const exById = new Map(exParts.map((p) => [p.id, p]));
				const inIds = new Set(inParts.map((p) => p.id));
				const extras = exParts.filter((p) => !inIds.has(p.id));
				const reconciled = inParts.map((inP) => {
					const exP = exById.get(inP.id);
					if (!exP) return inP;
					// For text/reasoning parts: prefer whichever has more text content.
					// This prevents hydrate from clobbering SSE-streamed content
					// with an empty/stale server snapshot during active streaming.
					if (
						isTextLikePart(inP) &&
						isTextLikePart(exP) &&
						exP.text.length > inP.text.length
					) {
						return exP;
					}
					return inP;
				});
				for (const ep of extras) {
					const r = Binary.search(reconciled, ep.id, (p) => p.id);
					if (!r.found) reconciled.splice(r.index, 0, ep);
				}
				newParts[mid] = reconciled;
			}
			return {
				messages: { ...s.messages, [sessionID]: merged },
				parts: newParts,
			};
		}),

	reset: () => {
		optimisticIds.clear();
		dispatchedOptimisticIds.clear();
		bridgedPartIds.clear();
		deltaActiveParts.clear();
		// The data these holds protected is gone, so the holds are too —
		// otherwise a late unmount could free a session the next page opened.
		sessionConsumers.clear();
		detachedSessions.clear();
		sessionMessageRows.clear();
		set({
			messages: {},
			parts: {},
			sessionStatus: {},
			diffs: {},
			todos: {},
		});
	},

	// ---- Selector: join messages + parts into MessageWithParts[] ----

	hasOptimisticMessages: (sessionID) => {
		const list = get().messages[sessionID];
		if (!list || list.length === 0) return false;
		return list.some((m) => isOptimistic(sessionID, m.id));
	},

	getMessages: (sessionID) => {
		const s = get();
		const msgs = s.messages[sessionID];
		if (!msgs) return [];
		return msgs.map((info) => ({
			info,
			parts: s.parts[info.id] ?? [],
		}));
	},

	// ---- Event reducer (matches SolidJS event-reducer.ts 1:1) ----

	applyEvent: (event) => {
		const store = get();
		switch (event.type) {
			case "message.updated": {
				const info = (event.properties as { info: Message }).info;
				if (!info?.sessionID) return;
					// When a real user message arrives from the server, swap out the
				// optimistic message(s) in a SINGLE atomic set() call.
				// This prevents the intermediate render where the user bubble
				// vanishes (optimistic removed) before the real one appears.
				if (info.role === "user" && !isOptimistic(info.sessionID, info.id)) {
					const msgs = get().messages[info.sessionID];
					if (msgs) {
						// ONE confirmation retires ONE optimistic message.
						//
						// This used to retire every optimistic user message in the
						// session. With a single send in flight that is correct, and
						// is the whole point of this branch — it swaps the bubble in
						// one `set()` so the user never sees it blink. With two in
						// flight it took the innocent one with it: confirm the plain
						// message and the one still uploading its attachment vanished
						// too. Same defect `hydrate` had, on the SSE path.
						//
						// Correlate the same way `hydrate` does: exact part id first
						// (hosts send the client-generated id WITH the prompt), then
						// the oldest dispatched message as a fallback for a
						// confirmation that carries no parts yet.
						const state = get();
						const optimisticUsers = msgs.filter(
							(m) => m.role === "user" && isOptimistic(info.sessionID, m.id),
						);
						const incomingPartIds = new Set(
							(state.parts[info.id] ?? []).map((p) => p.id),
						);
						const byPartId = optimisticUsers.find((m) =>
							(state.parts[m.id] ?? []).some((p) => incomingPartIds.has(p.id)),
						);
						// The fallback requires `dispatched`, matching `hydrate`.
						//
						// It briefly did not: "with exactly one optimistic message in
						// flight there is nothing to be ambiguous about, so retire it".
						// That had a hole. A SECOND TAB on the same session produces a
						// `message.updated` for a message that is not ours, and the one
						// message we do have in flight may still be uploading — so the
						// single-in-flight rule handed the other tab's confirmation our
						// un-sent message and deleted it. Exactly the bug this whole
						// change set exists to fix, through a side door.
						//
						// The argument for being generous was that a host which calls
						// `beginOptimisticSend` and then POSTs by hand, never marking
						// dispatch, would keep its bubble forever. That is checkable
						// rather than hypothetical: `optimisticAdd` has exactly one
						// caller, and every send path through this SDK
						// (`sendAndRecover`, `replayStartStash`, `useSession.sendParts`)
						// marks dispatch. Losing a message the user typed is worse than
						// a double bubble on a host that does not exist.
						//
						// Note this fallback is the LIVE path here, not part-id
						// matching: at `message.updated` time the confirmed message
						// usually has no parts in the store yet (they arrive separately
						// via `message.part.updated`).
						const matched =
							byPartId ?? optimisticUsers.find((m) => isDispatched(info.sessionID, m.id));
						const optIds = matched ? [matched.id] : [];
						if (optIds.length > 0) {
							// Clean up optimistic tracking
							for (const id of optIds) {
								untrackId(optimisticIds, info.sessionID, id);
								untrackId(dispatchedOptimisticIds, info.sessionID, id);
							}
							// Atomic: remove optimistic + insert real in one set()
							set((s) => {
								const list = s.messages[info.sessionID] ?? [];
								// Remove all optimistic user messages
								const without = list.filter((m) => !optIds.includes(m.id));
								// Insert the real message at sorted position
								const r = Binary.search(without, info.id, (m) => m.id);
								const next = [...without];
								if (r.found) {
									next[r.index] = info;
								} else {
									next.splice(r.index, 0, info);
								}
								// Bridge optimistic parts to the real message ID so
								// the user bubble never flickers empty while waiting
								// for real parts to arrive via message.part.updated.
								const newParts = { ...s.parts };
								let bridge: Part[] | undefined;
								for (const id of optIds) {
									if (!bridge && newParts[id]?.length) {
										bridge = newParts[id];
									}
									delete newParts[id];
								}
								if (bridge && !newParts[info.id]?.length) {
									newParts[info.id] = bridge;
									trackId(bridgedPartIds, info.sessionID, info.id);
								}
								return {
									messages: { ...s.messages, [info.sessionID]: next },
									parts: newParts,
								};
							});
							return;
						}
					}
				}
				store.upsertMessage(info.sessionID, info);
				return;
			}
			case "message.removed": {
				const props = event.properties as {
					sessionID: string;
					messageID: string;
				};
				if (!props.sessionID || !props.messageID) return;
				store.removeMessage(props.sessionID, props.messageID);
				return;
			}
			case "message.part.updated": {
				const part = (event.properties as { part: Part }).part;
				if (!part?.messageID) return;

				const eventSessionID =
					(event.properties as { sessionID?: string })?.sessionID;
				let resolvedSessionID: string | undefined =
					part.sessionID ?? eventSessionID;

				if (!resolvedSessionID) {
					const sessionsById = get().messages;
					for (const [sid, msgs] of Object.entries(sessionsById)) {
						if (msgs?.some((m) => m.id === part.messageID)) {
							resolvedSessionID = sid;
							break;
						}
					}
				}

				const existingMsgs = resolvedSessionID
					? get().messages[resolvedSessionID]
					: undefined;
				const bsResult = existingMsgs && Binary.search(existingMsgs, part.messageID, (m) => m.id);
				const exists = existingMsgs && (
					(bsResult && bsResult.found && existingMsgs[bsResult.index]?.id === part.messageID) ||
					existingMsgs.some((m) => m.id === part.messageID)
				);
				if (!exists && resolvedSessionID) {
					store.upsertMessage(resolvedSessionID, {
						id: part.messageID,
						sessionID: resolvedSessionID,
						role: "assistant",
					} as Message);
				}

				// Pass resolvedSessionID explicitly — part.sessionID can be absent
				// on the wire (the fallback chain above exists for exactly that),
				// and the deltaActiveParts guard in upsertPart must not silently
				// no-op just because that field is missing.
				store.upsertPart(part.messageID, part, resolvedSessionID);
				if (isTextLikePart(part)) {
					if (!resolvedSessionID) return;
					const msgInfo = get().messages[resolvedSessionID]?.find(
						(m) => m.id === part.messageID,
					);
					writeStreamCache(
						resolvedSessionID,
						part.messageID,
						part.id,
						part.text,
						msgInfo?.role === "assistant" ? msgInfo.parentID : undefined,
					);
				}
				return;
			}
			case "message.part.removed": {
				const props = event.properties as { messageID: string; partID: string };
				if (!props.messageID || !props.partID) return;
				store.removePart(props.messageID, props.partID);
				return;
			}
			case "message.part.delta": {
				const props = event.properties as {
					messageID: string;
					partID: string;
					sessionID: string;
					field: string;
					delta: string;
				};
				if (!props.messageID || !props.partID || !props.field) return;

				// Ensure the part exists before applying the delta.
				// message.part.delta can arrive before message.part.updated
				// (which normally creates the message + part). Without a
				// stub part, deltas are silently dropped by applyPartDelta,
				// causing the streamed text to never appear.
				const partList = get().parts[props.messageID];
				const partExists = partList && partList.some((p) => p.id === props.partID);
				if (!partExists) {
					// Auto-create the assistant message so the part can
					// render, BUT only if the session already has a user
					// message. On page refresh, hydrate() may not have
					// completed yet — creating a stub assistant message
					// before the user message exists causes turn grouping
					// to attach streaming text to the wrong bubble.
					// In that case, the part is stored as an orphan and
					// will be picked up once hydrate() or
					// message.part.updated creates the real message.
					if (props.sessionID) {
						const existingMsgs = get().messages[props.sessionID];
						const hasUserMsg = existingMsgs?.some(
							(m) => m.role === "user",
						);
						const msgExists = existingMsgs?.some(
							(m) => m.id === props.messageID,
						);
						if (!msgExists && hasUserMsg) {
							store.upsertMessage(props.sessionID, {
								id: props.messageID,
								sessionID: props.sessionID,
								role: "assistant",
							} as Message);
						}
					}
					store.upsertPart(props.messageID, {
						id: props.partID,
						sessionID: props.sessionID,
						messageID: props.messageID,
						type: "text",
						[props.field]: "",
					} as unknown as Part);
				}

				store.applyPartDelta(
					props.sessionID,
					props.messageID,
					props.partID,
					props.field,
					props.delta,
				);
				if (props.field === "text") {
					const updated = get().parts[props.messageID]?.find(
						(p) => p.id === props.partID,
					);
					if (updated && isTextLikePart(updated) && updated.text.length > 0) {
						const msgInfo = get().messages[props.sessionID]?.find(
							(m) => m.id === props.messageID,
						);
						writeStreamCache(
							props.sessionID,
							props.messageID,
							props.partID,
							updated.text,
							msgInfo?.role === "assistant" ? msgInfo.parentID : undefined,
						);
					}
				}
				return;
			}
			case "session.status": {
				const props = event.properties as {
					sessionID: string;
					status: SessionStatus;
				};
				if (props.sessionID && props.status)
					store.setStatus(props.sessionID, props.status);
				return;
			}
		case "session.idle": {
			const sessionID = (event.properties as { sessionID: string }).sessionID;
			if (sessionID) store.setStatus(sessionID, { type: "idle" });
			// Streaming finished for THIS session — clear only its own delta
			// tracking so future message.part.updated snapshots for it are
			// accepted normally. Never the whole map: another session may
			// still be streaming (see comment above deltaActiveParts).
			if (sessionID) deltaActiveParts.delete(sessionID);
			return;
		}
		case "session.error": {
			const props = event.properties as { sessionID?: string; error?: MessageError };
			if (!props.sessionID || !props.error) return;
			const sid = props.sessionID;
			const error = props.error;
			// Mark session idle — errors terminate the response.
			store.setStatus(sid, { type: "idle" });
			// Clear only this session's delta tracking — see the idle handler
			// above and the comment above deltaActiveParts.
			deltaActiveParts.delete(sid);

			// Patch the error onto the last assistant message in the sync store.
			// If no assistant message exists yet, create a temporary one so the
			// error is visible immediately. The event handler in
			// use-opencode-events.ts will also fetch real messages from the
			// server which will bring in the authoritative data via hydrate().
			set((s) => {
				const msgs = s.messages[sid] ?? [];
				// Find last assistant message and patch .error onto it
				for (let i = msgs.length - 1; i >= 0; i--) {
					const msg = msgs[i];
					if (msg.role === "assistant") {
						if (msg.error) return s; // already has error
						const next = [...msgs];
						// `error` may be the client-synthesized `SyntheticAbortError`
						// (see `MessageError`), which the SDK's own `AssistantMessage.error`
						// union doesn't declare — the assertion is the documented, narrow
						// exception for that one extra shape.
						next[i] = { ...msg, error } as typeof msg;
						return { messages: { ...s.messages, [sid]: next } };
					}
				}

				// No assistant message yet — create a stub so the error shows.
				// Mark it as a client-side stub so hydrate can replace it.
				const stubId = ascendingId("msg");
				const stubMsg: Message = {
					id: stubId,
					sessionID: sid,
					role: "assistant",
					error,
				} as Message;
				return {
					messages: { ...s.messages, [sid]: [...msgs, stubMsg] },
				};
			});
			return;
		}
			case "session.diff": {
				const props = event.properties as {
					sessionID: string;
					diff: FileDiff[];
				};
				if (props.sessionID) store.setDiff(props.sessionID, props.diff);
				return;
			}
			case "todo.updated": {
				const props = event.properties as { sessionID: string; todos: Todo[] };
				if (props.sessionID) store.setTodo(props.sessionID, props.todos);
				return;
			}
			default:
				return;
		}
	},
}));
