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

import {
	commitSessionRewind,
	isWithinRewindWindow,
	stageSessionRewind,
} from "../../core/session/rewind";
import { ascendingId } from "./sync-store/ascending-id";
import { Binary } from "./sync-store/binary";
import { writeStreamCache } from "./sync-store/stream-cache";
import type {
	FileDiff,
	MessageError,
	MessageWithParts,
	SessionRewindState,
} from "./sync-store/types";

// Re-export moved helpers/types so the public surface stays byte-identical:
// `Binary`, `ascendingId`, and the `MessageWithParts` type remain importable
// from this module exactly as before.
export { ascendingId, Binary };
export type { MessageError, MessageWithParts, SessionRewindState };

/**
 * Do two `SessionStatus` values say the same thing?
 *
 * NOT a deep equality: it compares `type` plus exactly the fields the retry
 * readers actually read — `getRetryInfo` / `getRetryMessage` in
 * `core/turns/state.ts` take `attempt`, `message` and `next`. A blanket
 * deep-equal would also compare `action`, which nothing reads, and would then
 * mint a new observation for a change no surface can render.
 *
 * The point of the comparison is object identity, not the boolean: a status
 * frame is an OBSERVATION, and `useSessionWorking` dates it by the identity of
 * the object in the store. Two equal values are one observation.
 */
export function sameSessionStatus(
	a: SessionStatus | undefined,
	b: SessionStatus | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.type !== b.type) return false;
	if (a.type !== "retry" || b.type !== "retry") return true;
	return a.attempt === b.attempt && a.message === b.message && a.next === b.next;
}

/**
 * WHO minted a status-bearing event handed to `applyEvent`. A tab-synthesized
 * event (`markSessionIdleLocally`, `markSessionAbortedLocally`, the hydrate
 * snapshot fill) carries `synthetic: true` — a field no wire `Event` has — and
 * its status write lands with `'local'` origin so it can never contradict the
 * control plane's turn authority (`WorkingStreamInput.origin`). Everything off
 * the wire stays `'wire'`.
 */
function syntheticEventOrigin(event: unknown): "wire" | "local" {
	return (event as { synthetic?: boolean } | null | undefined)?.synthetic === true
		? "local"
		: "wire";
}

/** The two `Part` variants that carry streaming `.text` (vs. tool/file/etc.
 *  parts, which don't). Narrows a `Part` down so `.text` is safe to read
 *  without a cast — every `Part` member shares `id`/`sessionID`/`messageID`/
 *  `type`, but only these two carry `text`. */
type TextLikePart = TextPart | ReasoningPart;
function isTextLikePart(part: Part): part is TextLikePart {
	return part.type === "text" || part.type === "reasoning";
}

// ============================================================================
// Locating things in a list that is NOT id-sorted.
//
// `Binary.search` requires ascending ids. None of this store's lists are
// reliably ascending, for two independent reasons:
//
//  1. optimistic messages are appended out of order on purpose (see
//     `optimisticRemove`, which says so), and
//  2. OpenCode 1.18.15 retired the invariant that ids ascend with time
//     altogether — `MessageV2.latest()` orders by `time.created`, with the id
//     only as a tie-break, and `MessageV2.page()` (every transcript read this
//     store performs) has ALWAYS ordered by `time_created`.
//
// A binary HIT is still trustworthy: `Binary.search` reports `found` only on an
// exact id match. A binary MISS is not — on an unsorted list it is a coin
// flip, and treating it as proof of absence is how `upsertPart` spliced a
// duplicate part (restarting the visible stream), `removePart` no-opped (a
// cancelled tool call stayed on screen), and `applyPartDelta` dropped deltas
// (the assistant appeared to hang mid-sentence).
// ============================================================================

/**
 * How coarsely `sessionActivityAt` is stamped.
 *
 * One second: far finer than any consumer needs (the projection compares it
 * against observations bounded in tens of seconds) and coarse enough that a
 * runtime streaming at ~140ms per frame updates it once, not seven times.
 */
const ACTIVITY_STAMP_RESOLUTION_MS = 1_000;

/** The index of `id` in `list`, or `-1`. Binary first, linear on a miss. */
function indexOfId<T>(list: readonly T[], id: string, idOf: (item: T) => string): number {
	const result = Binary.search(list as T[], id, idOf);
	if (result.found && list[result.index] !== undefined && idOf(list[result.index]) === id) {
		return result.index;
	}
	return list.findIndex((item) => idOf(item) === id);
}

/**
 * Where a message the current snapshot did not contain belongs: the first
 * position holding a strictly newer message, or the end.
 *
 * Ordered by `time.created` with the id as the ONLY tie-break — the same order
 * the server's own `MessageV2.latest()` uses, and the key `MessageV2.page()`
 * pages by. That keeps a locally-known message (an SSE arrival, a re-keyed
 * stub) in the sequence the next page read will produce. A message with no
 * readable `time` — every `session.error` stub this store mints — cannot be
 * dated and goes last, which is where the newest thing we know about belongs.
 */
function insertIndexByTime(list: readonly Message[], message: Message): number {
	const created = message.time?.created;
	if (created === undefined) return list.length;
	for (let index = 0; index < list.length; index++) {
		const other = list[index].time?.created;
		if (other === undefined) continue;
		if (other > created) return index;
		if (other === created && list[index].id > message.id) return index;
	}
	return list.length;
}

/**
 * PARTS are the exception, and deliberately so: every writer of a `parts[…]`
 * array sorts it by id first (`optimisticAdd`'s `messageParts`, `hydrate`'s
 * `inParts`), and every later insert goes in at the position `Binary.search`
 * computed over an already-sorted list. That array is therefore id-sorted BY
 * CONSTRUCTION — not by any assumption about ids and time — so a binary search
 * over it is exact, and `upsertPart`/`removePart`/`applyPartDelta` need no
 * fallback. Delete either of those two sorts and that stops being true; the
 * three call sites would then need `indexOfId` exactly as the message paths do.
 */

// ============================================================================
// Store State
// ============================================================================

interface SyncState {
	// Core data (per-session, sorted arrays — matches SolidJS store shape)
	messages: Record<string, Message[]>;
	parts: Record<string, Part[]>;
	sessionStatus: Record<string, SessionStatus>;
	/**
	 * WHO minted each session's current `sessionStatus` value: `'wire'` for the
	 * runtime's own SSE frame, `'local'` for a tab-synthesized one (the
	 * missing-busy sweep, a synthetic abort, `clearSession`). Absent means
	 * `'wire'` — the field is additive.
	 *
	 * `useSessionWorking` threads this into `projectWorking`
	 * (`WorkingStreamInput.origin`): only the runtime's own idle frame may
	 * contradict the control plane's open `/turn` row. Without the bit, one
	 * fabricated idle vetoed the lifecycle authority for the rest of a quiet
	 * turn (dev, 2026-08-24).
	 */
	sessionStatusOrigin: Record<string, "wire" | "local">;
	/**
	 * When each session's current `sessionStatus` value LANDED in this store —
	 * stamped by `setStatus` on any state change (a new value, or an origin
	 * flip over an unchanged value, which is a new observation), and preserved
	 * across same-value rewrites exactly like the status object's identity.
	 *
	 * The store used to keep no arrival time, and freshness was stamped by
	 * whichever component observed the slot. Two failures grew out of that: a
	 * remount re-stamped a dead stream's last idle frame as brand new, and the
	 * reconnect status fill could not tell a frame the live stream just
	 * delivered from one a dead stream left behind — so it protected both
	 * (`shouldSkipStatusFill`). Absent means the slot predates this slice; the
	 * readers fall back to their old stamping.
	 */
	sessionStatusAt: Record<string, number>;
	/**
	 * When the RUNTIME'S OWN OUTPUT last reached this tab, per session.
	 *
	 * Not a status, not a poll — the instant a streamed part or message landed.
	 * `projectWorking` reads it as the one input that is not an observer of the
	 * runtime but the runtime itself (see `WorkingActivityInput`): a composer
	 * showing its send arrow over a transcript that is visibly streaming is what
	 * its absence looked like.
	 *
	 * QUANTIZED to `ACTIVITY_STAMP_RESOLUTION_MS`. A busy runtime emits parts
	 * every few tens of milliseconds; stamping each one would re-render every
	 * subscriber at that rate for a value nothing needs to the millisecond.
	 */
	sessionActivityAt: Record<string, number>;
	diffs: Record<string, FileDiff[]>;
	todos: Record<string, Todo[]>;
	/**
	 * T22 — the client's mirror of the server's staged/committed session
	 * revert, per session. `null` means "no revert pointer" (either never
	 * staged, or observed cleared/committed-and-deleted). Absent from the
	 * record entirely (`undefined` via plain lookup) means the same thing as
	 * `null` — no session has ever had one tracked.
	 *
	 * Driven by three independent sources that must all converge on the same
	 * shape: a local `rewind()` REST call (`useSession`), the wire events
	 * `session.next.revert.staged/.cleared/.committed` (below, via
	 * `applyEvent`), and a `Session.revert` field read off `session.created`/
	 * `session.updated` (`syncSessionRevertFromInfo`, called from
	 * `use-opencode-events/handle-event.ts` — the reload/cross-tab recovery
	 * path, since a hard reload observes neither of the other two).
	 */
	sessionRevert: Record<string, SessionRewindState | null>;
	/**
	 * F2 — set when a `session.next.revert.committed` event arrives for a
	 * session with NO tracked local `sessionRevert` record (a fresh mount, or
	 * a second tab that never observed `.staged`). The store deliberately
	 * does not guess a watermark and delete a range in that case — see
	 * `markSessionRevertNeedsTailReconcile`'s doc comment for why — so this
	 * is the signal a consumer (the sync controller / `use-opencode-events`)
	 * reads to know it must fetch the session's real transcript instead of
	 * trusting local messages. `true` means "reconcile owed"; absent or
	 * `false` means nothing is owed. Cleared by
	 * `clearSessionRevertNeedsTailReconcile` once a consumer has acted on it.
	 */
	sessionRevertNeedsTailReconcile: Record<string, boolean>;

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
	 *
	 * `eventID` (T14): the wire's own `message.part.delta` event id
	 * (`event.id`, not `event.properties.id` — see `deltaEventTails` above for
	 * why this is the correct duplicate-delivery key). Optional and additive:
	 * omitting it reproduces this function's exact pre-existing behavior, so
	 * the one in-repo caller change (`applyEvent`) is the only place this
	 * matters, and appending a trailing optional param is not a breaking
	 * arity change.
	 */
	applyPartDelta: (
		sessionID: string,
		messageID: string,
		partID: string,
		field: string,
		delta: string,
		eventID?: string,
	) => void;
	setStatus: (sessionID: string, status: SessionStatus, origin?: "wire" | "local") => void;
	setDiff: (sessionID: string, diffs: FileDiff[]) => void;
	setTodo: (sessionID: string, todos: Todo[]) => void;
	/**
	 * Stage a rewind's local hide window. Idempotent per boundary id: calling
	 * this again for the SAME `messageID` while already staged is a no-op —
	 * whichever caller stages first freezes the watermark, and a redundant
	 * echo (the local REST caller AND the wire's `.staged` confirmation both
	 * call this for the same action) must never widen it after messages have
	 * moved on. A DIFFERENT `messageID` replaces the record with a fresh
	 * watermark computed from the CURRENTLY known message list.
	 */
	stageSessionRevert: (sessionId: string, messageId: string) => void;
	/** Mark a staged rewind committed (Restore stops being offered) without
	 *  dropping its hide window — see `commitSessionRewind`'s doc comment.
	 *  No-op when nothing is tracked for this session. */
	commitSessionRevert: (sessionId: string) => void;
	/** Drop the local revert record entirely — `unrevert` succeeded, or a
	 *  `session.next.revert.cleared` wire event says the server dropped it.
	 *  The window was only ever HIDDEN while staged, never deleted, so
	 *  clearing alone is enough to make every row visible again. */
	clearSessionRevert: (sessionId: string) => void;
	/**
	 * The `.committed` event's actual cleanup: delete every message (and its
	 * parts) inside `[boundaryId, watermark]` and drop the revert record. The
	 * first explicit deletion this store performs for rewind — `hydrate`
	 * never deletes (see its own doc comment), by design; this is a
	 * dedicated, separately tested action instead of a weakening of that
	 * invariant. A session with no local messages (or nothing in range)
	 * safely clears the record and does nothing else.
	 */
	applyCommittedRevert: (
		sessionId: string,
		boundaryId: string,
		watermark: string,
		hiddenIds?: readonly string[],
	) => void;
	/**
	 * F2 — mark `sessionId` as owing a tail reconcile: a
	 * `session.next.revert.committed` event arrived with no tracked local
	 * `sessionRevert` record to source a trustworthy watermark from. The
	 * REMOVED fallback (`newestMessageId(local messages)`) could be the
	 * user's own REPLACEMENT prompt — if its `message.updated` happened to
	 * arrive before this `.committed` event, that fallback deleted the
	 * replacement and its answer along with the abandoned range. Deliberately
	 * does NOT touch `messages`/`parts`/`sessionRevert` — the server's own
	 * transcript (fetched by whatever the flagged consumer's reconcile reads)
	 * is the only trustworthy source of the real truncation here, not a
	 * local guess.
	 */
	markSessionRevertNeedsTailReconcile: (sessionId: string) => void;
	/** Consumer-side ack for {@link markSessionRevertNeedsTailReconcile} — call
	 *  once the flagged session's tail has actually been reconciled against
	 *  the server. */
	clearSessionRevertNeedsTailReconcile: (sessionId: string) => void;
	/**
	 * Reconcile the local revert record against a `Session.revert` field read
	 * off a `session.created`/`session.updated` event's `info` — the reload
	 * and cross-tab recovery path. A hard page reload observes neither a
	 * fresh `rewind()` call nor a `.staged` wire transition (that already
	 * happened, possibly in a different tab or before this tab existed), so
	 * this is the only way a reload can rediscover an already-staged revert.
	 *
	 * Deliberately asymmetric: a PRESENT `revert.messageID` seeds a fresh
	 * local record (via `stageSessionRevert`, so the same idempotency and
	 * watermark-freezing rules apply) — but an ABSENT one never clears an
	 * existing record. The three wire events are the sole authority for
	 * transitions; a stale or momentarily-absent `Session.revert` snapshot
	 * must never race ahead of (or override) them.
	 */
	syncSessionRevertFromInfo: (
		sessionId: string,
		revert: { messageID: string } | null | undefined,
	) => void;
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
	/**
	 * Mark an optimistic message as held DURABLY by the control plane — its
	 * prompt-inbox row landed (the POST returned). From here the message is not
	 * "unconfirmed": the server has it and will deliver it, so the local idle
	 * sweep ({@link SyncState.clearOptimisticMessages}) must not delete it. It
	 * leaves the transcript only by the runtime's echo (same id, or a re-minted
	 * one — see {@link SyncState.optimisticEchoOf}), by
	 * {@link SyncState.optimisticRemove}, or with the session.
	 */
	markOptimisticInboxBacked: (sessionID: string, messageID: string) => void;
	clearOptimisticMessages: (sessionID: string) => void;
	/** Record that the runtime produced output for this session just now. */
	noteSessionActivity: (sessionID: string, atMs?: number) => void;
	/**
	 * The runtime's id for an optimistic message that was superseded under a
	 * DIFFERENT id (the control plane re-mints a wire id that would sort below
	 * the transcript tip). Lets a host keep ONE identity for the prompt across
	 * the swap — a React key, an inbox row's `message_id` — instead of seeing
	 * two. Undefined for a message confirmed under its own id or never
	 * superseded.
	 */
	optimisticEchoOf: (sessionID: string, optimisticID: string) => string | undefined;
	/** The inverse of {@link SyncState.optimisticEchoOf}. */
	optimisticOriginOf: (sessionID: string, echoID: string) => string | undefined;
	/**
	 * Announce, AHEAD of the echo, which runtime id an optimistic message will
	 * come back under. The control plane re-mints a queued prompt's wire id at
	 * delivery and lists BOTH ids on the row — so the pairing is known before
	 * any `message.updated` arrives. With it recorded, the echo supersedes ITS
	 * OWN bubble; without it, an echo whose parts had not landed yet fell back
	 * to superseding the OLDEST in-flight optimistic message (measured: a
	 * burst's first bubble vanished, replaced by the second's echo).
	 */
	registerOptimisticEcho: (sessionID: string, optimisticID: string, echoID: string) => void;
	/**
	 * The user CANCELLED this message (`DELETE .../prompts`): drop its bubble
	 * and every claim on it — the reclaim that normally protects a
	 * control-plane-owned message from `message.removed` must not resurrect
	 * something the user explicitly removed.
	 */
	forgetControlPlaneMessage: (sessionID: string, messageID: string) => void;
	/** True when the session's message list still holds an unconfirmed optimistic
	 *  message — lets the SSE reconciler avoid idling+clearing a brand-new session
	 *  whose first prompt the server hasn't registered yet. */
	hasOptimisticMessages: (sessionID: string) => boolean;
	/** Is this message still this tab's optimistic stub (not yet confirmed
	 *  by the runtime)? Hosts use it to keep stubs out of anything that must
	 *  only hold what the runtime holds — the disk transcript cache. */
	isOptimisticMessage: (sessionID: string, messageID: string) => boolean;
	/**
	 * A `message.removed` for a user message the control plane still owns
	 * (an inbox-backed send the runtime confirmed) is a RE-PLACEMENT in
	 * progress — the server took the copy out to insert it again under a new
	 * id. Keeps the bubble as an optimistic stub for the next echo to
	 * supersede. Returns true when the removal was absorbed this way.
	 */
	reclaimRemovedMessage: (sessionID: string, messageID: string) => boolean;
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
	 * True when this session's `messages` entry — if it has one at all — is a
	 * post-eviction fragment rather than the transcript.
	 *
	 * Eviction deletes the key, and `use-session-sync.ts` reads its absence as
	 * "the disk copy may repaint". A session whose agent is still running defeats
	 * that on its own: its SSE frames put the key back within a second or two,
	 * holding only what streamed after the eviction, so the user came back to the
	 * fragment and had to `loadOlder` for everything before it.
	 *
	 * Answering this at the store is what makes the repaint decision correct
	 * without dropping any event — dropping events for a session nobody has
	 * mounted would blind the spawn-tool preview of a child session, which has no
	 * reconcile of its own and is fed by SSE alone.
	 *
	 * Goes false again the moment anything re-establishes the session:
	 * `hydrate` (the repaint, or a reconcile), `clearSession`, `optimisticAdd`.
	 */
	wasTranscriptEvicted: (sessionID: string) => boolean;
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
		/**
		 * Where this snapshot came from. `cache` (the disk transcript cache)
		 * paints messages PROVISIONALLY: the next runtime hydrate whose tail
		 * covers their position drops any it does not contain. Default:
		 * the runtime.
		 */
		opts?: { source?: "cache" | "runtime" },
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
// Optimistic ids whose prompt-inbox row LANDED (see `markOptimisticInboxBacked`).
// The idle sweep skips these: the control plane holds the message durably and
// will deliver it, so "the session went idle and this was never echoed" is
// not evidence it was lost.
const inboxBackedOptimisticIds = new Map<string, Set<string>>();
// optimistic id → the runtime id that superseded it, and the inverse. Written
// at supersede time (SSE and hydrate), so a host can keep one identity for a
// prompt across the swap. Bounded by the number of prompts sent from this tab
// per session; released with the session.
const optimisticEchoes = new Map<string, Map<string, string>>();
const optimisticOrigins = new Map<string, Map<string, string>>();
// Message ids the CONTROL PLANE still owns after the runtime confirmed them:
// the echo (same id or re-minted) of an inbox-backed optimistic send. The
// server can take such a message back out of the runtime and place it again
// under a new id — a stranded mid-turn prompt being re-placed, a Stop taking
// an unread prompt back into the queue. A `message.removed` for one of these
// is not "the message is gone", it is "the message is between two ids": the
// bubble is re-marked optimistic (dispatched, inbox-backed) and the next echo
// supersedes it, instead of the bubble blinking out and a new one appearing.
// Released with the session.
const controlPlaneOwnedIds = new Map<string, Set<string>>();
// Message ids the user explicitly CANCELLED (`DELETE .../prompts`). The
// runtime may keep a part-less husk of the message (a busy loop refuses the
// whole-message delete; the parts are emptied instead), and every later
// transcript read would resurrect it as an empty bubble. A tombstoned id is
// dropped from incoming reads and events. Released with the session.
const cancelledMessageIds = new Map<string, Set<string>>();
// Message ids that came from the DISK CACHE and have not yet been seen in a
// runtime read. The cache is a first-paint accelerator; a message it holds
// that the runtime's own tail — covering that message's position — does not,
// never existed there (an optimistic stub mirrored to disk before its echo)
// and must not outlive the first authoritative read.
const cacheSourcedIds = new Map<string, Set<string>>();

function recordOptimisticEcho(sessionID: string, optimisticID: string, echoID: string): void {
	if (optimisticID === echoID) return;
	// Chain through an earlier swap: a message that itself superseded an
	// optimistic id keeps pointing the host at that ORIGINAL id, so a second
	// re-placement does not change the identity the host keyed its bubble on.
	const origin = optimisticOrigins.get(sessionID)?.get(optimisticID) ?? optimisticID;
	let fwd = optimisticEchoes.get(sessionID);
	if (!fwd) optimisticEchoes.set(sessionID, (fwd = new Map()));
	fwd.set(origin, echoID);
	if (origin !== optimisticID) fwd.set(optimisticID, echoID);
	let rev = optimisticOrigins.get(sessionID);
	if (!rev) optimisticOrigins.set(sessionID, (rev = new Map()));
	rev.set(echoID, origin);
}

/** Forget every optimistic mark for one id — confirmed, superseded, or removed. */
function releaseOptimisticId(sessionID: string, id: string): void {
	untrackId(optimisticIds, sessionID, id);
	untrackId(dispatchedOptimisticIds, sessionID, id);
	untrackId(inboxBackedOptimisticIds, sessionID, id);
}

/** The runtime confirmed an inbox-backed optimistic send under `echoID`
 *  (same id, or re-minted): the control plane still owns that message. */
function releaseConfirmedOptimisticId(sessionID: string, optimisticID: string, echoID: string): void {
	if (hasTrackedId(inboxBackedOptimisticIds, sessionID, optimisticID)) {
		trackId(controlPlaneOwnedIds, sessionID, echoID);
	}
	releaseOptimisticId(sessionID, optimisticID);
}

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
	inboxBackedOptimisticIds.delete(sessionID);
	optimisticEchoes.delete(sessionID);
	optimisticOrigins.delete(sessionID);
	controlPlaneOwnedIds.delete(sessionID);
	cacheSourcedIds.delete(sessionID);
	cancelledMessageIds.delete(sessionID);
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
	// Same leak class, on the two T14 + T16 maps above.
	deltaEventTails.delete(sessionID);
	stubAssistantIds.delete(sessionID);
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
// Part-delta idempotency (T14).
//
// `applyPartDelta` used to be `existing + delta` with nothing consulted for
// identity — a duplicate delivery of the SAME `message.part.delta` doubled
// the streamed text. Realistic duplicate sources: the vendor SSE client's
// retry loop briefly stacking a second live connection before
// `event-stream.ts`'s own single-live-stream invariant (or the `sseMaxRetryAttempts:
// 1` pin) catches up, or a second mounted subscriber replaying the same
// stream.
//
// The wire's own `EventMessagePartDelta` (`@opencode-ai/sdk`'s
// `v2/gen/types.gen.d.ts`) carries a top-level `id: string` on every event —
// NOT inside `properties`, so `applyEvent`'s `message.part.delta` case now
// threads `event.id` through as `applyPartDelta`'s new optional trailing
// `eventID` param. Two independently-broadcast SSE readers of the SAME
// published event (a stacked connection, a second subscriber) both receive
// the identical event object and therefore the identical `id` — which makes
// event identity the correct dedupe key, not delta CONTENT: content-based
// dedupe (e.g. "reject a delta whose text matches the last one applied at
// this length") would false-positive on legitimately-repeated content, such
// as streaming "..." one identical character at a time.
//
// Keyed by session (same shape/reason as the maps above), then by
// `${messageID}:${partID}:${field}` (a part could in principle accumulate
// more than one delta-bearing field) to the SET of event ids already applied
// for that key. A stacked duplicate connection can redeliver a whole tail of
// the stream, not just the single most-recent event — "replay the last N
// deltas again" is exactly what a reconnect-and-resume does — so every
// applied id for the key is kept, not just the last one; a Set lookup stays
// O(1) either way. Bounded by the per-session clears below, so this never
// grows across an entire session's lifetime, only within one streaming turn.
// A delta that arrives with no `eventID` (a caller predating this change, or
// a hand-built synthetic delta) gets NO protection — identical to this
// function's behavior before this change — rather than risk a content-based
// false positive (see the module comment above for why content isn't used).
//
// Cleared per-session on `session.idle`/`session.error` (a new turn's deltas
// use brand-new part ids anyway, so nothing realistic is lost) and released
// wholesale by `forgetSessionIds`/`reset()`, matching `deltaActiveParts`.
const deltaEventTails = new Map<string, Map<string, Set<string>>>();

/** Session-scoped tracking for `session.error`'s stub assistant message (see
 *  the handler below) — same shape/reason as the maps above, except the value
 *  is a MAP: stub message id → the id of the user message whose turn failed
 *  (`null` only when the session held no user message at all).
 *
 *  The parent is tracked, not merely implied, because every question asked
 *  about a stub afterwards is a question about its TURN. A stub stands in for
 *  the assistant message that turn never produced, so `hydrate` may drop it
 *  only once the server's transcript answers THAT turn — a session-wide "any
 *  assistant message exists" test deleted the only record of a failure the
 *  moment an EARLIER turn's reply arrived (the 2026-08-19 report: the first
 *  `ModelNotFound` rendered nothing at all).
 *
 *  Released wholesale by `forgetSessionIds`/`reset()`; NOT cleared on
 *  idle/error — the stub message it names still lives in `messages[sessionID]`
 *  until hydrate reconciles it or the session itself ends. */
const stubAssistantIds = new Map<string, Map<string, string | null>>();

/** Remember `stubId` as this session's stand-in for the turn `parentId` opened. */
function trackStub(sessionID: string, stubId: string, parentId: string | null): void {
	const bucket = stubAssistantIds.get(sessionID);
	if (bucket) bucket.set(stubId, parentId);
	else stubAssistantIds.set(sessionID, new Map([[stubId, parentId]]));
}

function untrackStub(sessionID: string, stubId: string): void {
	const bucket = stubAssistantIds.get(sessionID);
	if (!bucket) return;
	bucket.delete(stubId);
	if (bucket.size === 0) stubAssistantIds.delete(sessionID);
}

/** The stub id for the turn `userId` opened.
 *
 *  Derived from the user message's own id so it is IDEMPOTENT — a second
 *  `session.error` for the same turn finds the stub it already made instead of
 *  appending another. The stub is always PLACED directly after its user
 *  message (see `rekeyStubParent` and `hydrate`), and carries `parentID`;
 *  neither its position nor its linkage is inferred from the id. */
const stubIdFor = (userId: string) => `${userId}_error`;

/** A stub id as seen from a list that has no tracking map to hand (`hydrate`'s
 *  incoming server snapshot, which can never legitimately contain one). */
const isStubShaped = (id: string) => id.endsWith("_error");

/** The index in `messages` of the assistant message answering the turn
 *  `parentId` opened, or `-1`.
 *
 *  `parentID` is the linkage `groupMessagesIntoTurns` reads and the only
 *  authoritative one. A wire assistant message that carries none is matched by
 *  TIME instead — `time.created` at or after the prompt's. It used to be
 *  matched by `m.id > parentId`, on the rationale "ids ascend, so a greater id
 *  is a later message". OpenCode 1.18.15 retired that invariant (turn exit now
 *  reads `lastAssistant.parentID === lastUser.id`, and `MessageV2.latest()`
 *  orders by `time.created`), and the comparison failed both ways: a real
 *  reply with a lower id left a stale `session.error` stub beside it, and an
 *  EARLIER turn's parentless reply with a higher id deleted the only record
 *  that this turn failed (the 2026-08-19 `ModelNotFound` report).
 *
 *  A parentless candidate that cannot be dated — because it carries no `time`,
 *  or because the prompt itself is not in `messages` — is not a match: keeping
 *  a stub that turns out to be redundant is recoverable on the next snapshot;
 *  deleting the only evidence of a failed turn is not.
 *
 *  With no parent turn to speak of, any assistant message answers. */
function findAssistantForTurn(
	messages: readonly Message[],
	parentId: string | null,
): number {
	const parentCreated = parentId
		? messages.find((m) => m.id === parentId)?.time?.created
		: undefined;
	return messages.findIndex(
		(m) =>
			m.role === "assistant" &&
			!isStubShaped(m.id) &&
			(!parentId ||
				m.parentID === parentId ||
				(!m.parentID &&
					parentCreated !== undefined &&
					m.time?.created !== undefined &&
					m.time.created >= parentCreated)),
	);
}

/** Does `messages` hold an assistant message answering the turn `parentId`
 *  opened? See {@link findAssistantForTurn}. */
function hasAssistantForTurn(
	messages: readonly Message[],
	parentId: string | null,
): boolean {
	return findAssistantForTurn(messages, parentId) !== -1;
}

/** Move this session's `session.error` stubs from the optimistic user message
 *  `fromId` onto the server's own copy of that prompt, `toId`.
 *
 *  Both paths that retire an optimistic user message call this — `hydrate`'s
 *  correlation and the `message.updated` echo — because a stub whose parent id
 *  no longer names a message in the list has lost the only link that says which
 *  turn failed, and `groupMessagesIntoTurns` would fall back to "the last turn
 *  seen", i.e. the bottom of the thread. Returns the list unchanged when this
 *  session has no stub on `fromId`. */
function rekeyStubParent(
	sessionID: string,
	list: readonly Message[],
	fromId: string,
	toId: string,
): Message[] {
	const bucket = stubAssistantIds.get(sessionID);
	if (!bucket) return list as Message[];
	const moved = [...bucket.entries()].filter(([, parentId]) => parentId === fromId);
	if (moved.length === 0) return list as Message[];
	let next = [...list];
	for (const [stubId] of moved) {
		untrackStub(sessionID, stubId);
		const idx = next.findIndex((m) => m.id === stubId);
		if (idx === -1) continue;
		const nextId = stubIdFor(toId);
		trackStub(sessionID, nextId, toId);
		const rekeyed = { ...next[idx], id: nextId, parentID: toId } as Message;
		next.splice(idx, 1);
		const parentIdx = next.findIndex((m) => m.id === toId);
		if (parentIdx === -1) next = [...next, rekeyed];
		else next.splice(parentIdx + 1, 0, rekeyed);
	}
	return next;
}

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
/**
 * Sessions whose transcript eviction freed, and which nothing authoritative has
 * reloaded since. See {@link SyncState.wasTranscriptEvicted} for what reads it
 * and {@link pruneDetachedSessions} for the second thing it is for.
 *
 * Holds ids, not data. It is cleared wholesale by `reset()`, and per-session by
 * every path that re-establishes the session — `hydrate`, `clearSession`,
 * `optimisticAdd`.
 */
const evictedSessions = new Set<string>();

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
 * holds (`tool/shared/sub-agent.tsx`, `tool/tools/removed-connector-tool.tsx`).
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
 * oldest sessions past it, plus any already-evicted session the live stream has
 * since refilled. Returns the ids it freed.
 *
 * The second half is what keeps eviction from being a one-shot. Eviction takes
 * a session OUT of the detach window, so an agent still running in it puts
 * `messages[id]` back — through SSE, with nobody watching — and that data then
 * has no path out of memory again. Re-checking {@link evictedSessions} on every
 * prune gives it one: the next mount of any session sweeps it, exactly like the
 * first time. It stays marked, because the user can still come back to it.
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
function pruneDetachedSessions(messages: Record<string, Message[]>): string[] {
	const evicted: string[] = [];
	while (detachedSessions.size > DETACHED_SESSION_LIMIT) {
		const oldest: string | undefined = detachedSessions.values().next().value;
		if (oldest === undefined) break;
		detachedSessions.delete(oldest);
		evicted.push(oldest);
	}
	// Refilled since it was last freed, and still nobody's. Gated on the key
	// actually being back so a quiet evicted session never provokes a `set()`
	// that changes nothing and re-renders every consumer of this store.
	for (const sessionID of evictedSessions) {
		if (sessionConsumers.has(sessionID) || detachedSessions.has(sessionID)) continue;
		if (sessionID in messages) evicted.push(sessionID);
	}
	return evicted;
}

// ============================================================================

export const useSyncStore = create<SyncState>()((set, get) => ({
	messages: {},
	parts: {},
	sessionStatus: {},
	sessionStatusOrigin: {},
	sessionStatusAt: {},
	sessionActivityAt: {},
	diffs: {},
	todos: {},
	sessionRevert: {},
	sessionRevertNeedsTailReconcile: {},

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
			// New message — placed by `time.created`, the key the server's own
			// `MessageV2.page()` orders by. It used to go in at the binary index,
			// which was only ever meaningful while `hydrate` re-sorted the
			// transcript by id. It no longer does (the page order IS the order),
			// and ids stopped ascending with time in OpenCode 1.18.15 — so an
			// id-sorted insert dropped a brand-new SSE message into the MIDDLE of
			// the transcript. See `insertIndexByTime`.
			const next = [...list];
			next.splice(insertIndexByTime(next, message), 0, message);
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
				// T16 — retire the bridge on ANY real part arrival for this
				// message: text, non-text (tool/file/step/…), or an empty-text
				// snapshot. This used to retire ONLY on a non-empty text part, so a
				// message whose first real part was a tool call (or an empty text
				// snapshot before content streamed in) kept the optimistic bridge
				// alongside the real parts — duplicating the user's text bubble.
				// The server has started sending this message's real parts either
				// way, so the bridge's job — standing in until real data exists —
				// is done the moment ANY of them arrives.
				untrackId(bridgedPartIds, partSessionID, messageID);
				list = [];
				bridgeCleared = true;
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

	applyPartDelta: (sessionID, messageID, partID, field, delta, eventID) => {
		trackId(deltaActiveParts, sessionID, partID);
		set((s) => {
			const list = s.parts[messageID];
			if (!list) return s;
			const result = Binary.search(list, partID, (p) => p.id);
			if (!result.found) return s;
			// Duplicate-delivery no-op — see `deltaEventTails` above. Only acts
			// when the caller supplied an event id (every real wire delta does);
			// a delta with no id gets no protection here, same as before this
			// change. Checked and RECORDED here, inside the actual-apply
			// branch (after the list/found checks above), not before `set()`
			// runs at all: recording it earlier marked an event id "applied"
			// even on the not-found path — a delta whose target part doesn't
			// exist yet (or was dropped) — which then permanently blocked a
			// later LEGITIMATE redelivery of that same event once the part
			// did exist. See "a delta that finds no target part does not
			// consume the event id" in the test file.
			if (eventID) {
				const tailKey = `${messageID}:${partID}:${field}`;
				let sessionTails = deltaEventTails.get(sessionID);
				if (!sessionTails) {
					sessionTails = new Map();
					deltaEventTails.set(sessionID, sessionTails);
				}
				let appliedIds = sessionTails.get(tailKey);
				if (appliedIds?.has(eventID)) return s;
				if (!appliedIds) {
					appliedIds = new Set();
					sessionTails.set(tailKey, appliedIds);
				}
				appliedIds.add(eventID);
			}
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

	setStatus: (sessionID, status, origin = "wire") =>
		set((s) => {
			// A value that did not change is not news. `useSessionWorking` stamps
			// its stream observation from this object's IDENTITY, so an
			// equal-valued rewrite that minted a new object re-started
			// `STREAM_OBSERVATION_MAX_MS` from zero on every write — the bound
			// that stops a dead stream from deciding was never reached. See
			// `sameSessionStatus`.
			if (sameSessionStatus(s.sessionStatus[sessionID], status)) {
				// The VALUE is not news, but who said it can be: a wire frame
				// landing over a fabricated one (or the reverse) changes what the
				// frame is allowed to decide. Update only the origin — the status
				// object keeps its identity so nothing re-stamps a stale value.
				// The arrival stamp DOES move: an origin flip is a new observation
				// (`use-session-working` re-stamps on it for the same reason).
				if ((s.sessionStatusOrigin[sessionID] ?? "wire") === origin) return s;
				return {
					sessionStatusOrigin: { ...s.sessionStatusOrigin, [sessionID]: origin },
					sessionStatusAt: { ...s.sessionStatusAt, [sessionID]: Date.now() },
				};
			}
			return {
				sessionStatus: { ...s.sessionStatus, [sessionID]: status },
				sessionStatusOrigin: { ...s.sessionStatusOrigin, [sessionID]: origin },
				sessionStatusAt: { ...s.sessionStatusAt, [sessionID]: Date.now() },
			};
		}),

	setDiff: (sessionID, diffs) =>
		set((s) => ({
			diffs: { ...s.diffs, [sessionID]: diffs },
		})),

	setTodo: (sessionID, todos) =>
		set((s) => ({
			todos: { ...s.todos, [sessionID]: todos },
		})),

	stageSessionRevert: (sessionId, messageId) =>
		set((s) => {
			const current = s.sessionRevert[sessionId];
			if (current?.staged && current.messageId === messageId) return s;
			return {
				sessionRevert: {
					...s.sessionRevert,
					[sessionId]: stageSessionRewind(get().getMessages(sessionId), messageId),
				},
			};
		}),

	commitSessionRevert: (sessionId) =>
		set((s) => {
			const current = s.sessionRevert[sessionId] ?? null;
			const next = commitSessionRewind(current);
			if (next === current) return s;
			return { sessionRevert: { ...s.sessionRevert, [sessionId]: next } };
		}),

	clearSessionRevert: (sessionId) =>
		set((s) => {
			if (!s.sessionRevert[sessionId]) return s;
			return { sessionRevert: { ...s.sessionRevert, [sessionId]: null } };
		}),

	applyCommittedRevert: (sessionId, boundaryId, watermark, hiddenIds) =>
		set((s) => {
			const list = s.messages[sessionId];
			if (!list || list.length === 0) {
				return { sessionRevert: { ...s.sessionRevert, [sessionId]: null } };
			}
			// `hiddenIds` is the set captured when the rewind was staged, and it
			// is what decides. `watermark` only still answers for a caller that
			// has no captured set — see `isWithinRewindWindow`.
			const rewind: SessionRewindState = {
				messageId: boundaryId,
				watermark,
				...(hiddenIds ? { hiddenIds } : {}),
				staged: false,
			};
			const removedIds: string[] = [];
			const kept = list.filter((m) => {
				if (isWithinRewindWindow(m.id, rewind)) {
					removedIds.push(m.id);
					return false;
				}
				return true;
			});
			const nextParts = { ...s.parts };
			for (const id of removedIds) delete nextParts[id];
			return {
				messages: { ...s.messages, [sessionId]: kept },
				parts: nextParts,
				sessionRevert: { ...s.sessionRevert, [sessionId]: null },
			};
		}),

	markSessionRevertNeedsTailReconcile: (sessionId) =>
		set((s) => {
			if (s.sessionRevertNeedsTailReconcile[sessionId]) return s;
			return {
				sessionRevertNeedsTailReconcile: {
					...s.sessionRevertNeedsTailReconcile,
					[sessionId]: true,
				},
			};
		}),

	clearSessionRevertNeedsTailReconcile: (sessionId) =>
		set((s) => {
			if (!s.sessionRevertNeedsTailReconcile[sessionId]) return s;
			const { [sessionId]: _, ...rest } = s.sessionRevertNeedsTailReconcile;
			return { sessionRevertNeedsTailReconcile: rest };
		}),

	syncSessionRevertFromInfo: (sessionId, revert) => {
		if (!revert?.messageID) return;
		const current = get().sessionRevert[sessionId];
		// F3 review finding: `null` is a deliberate tombstone — this store's
		// own record of "committed or cleared, on purpose" (set by
		// `applyCommittedRevert`/`clearSessionRevert`) — distinct from
		// `undefined` ("nothing ever tracked here"). A `session.updated` that
		// raced one of those two events can still carry the OLD `info.revert`
		// pointer; re-staging off it here would hide every post-rewind
		// message behind a phantom Restore. The tombstone wins until a
		// genuinely fresh revert arrives through the real `.staged` wire
		// event (`stageSessionRevert`, called directly, which overwrites
		// unconditionally and so clears the tombstone normally) — never
		// through this best-effort info-snapshot recovery path.
		if (current === null) return;
		if (current?.messageId === revert.messageID) return;
		get().stageSessionRevert(sessionId, revert.messageID);
	},

	optimisticAdd: (sessionID, message, messageParts) => {
		trackId(optimisticIds, sessionID, message.id);
		// The user has typed into this session, so the disk repaint stands down.
		// `hydrate`'s ordinal fallback pairs an in-flight optimistic message with
		// the oldest unclaimed real user message, and EVERY message in a disk
		// copy is unclaimed — a repaint landing mid-send would retire the message
		// that was just typed. The key-presence check used to make that
		// unreachable (this action creates the key); the mark has to.
		evictedSessions.delete(sessionID);
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

	markOptimisticInboxBacked: (sessionID, messageID) => {
		if (isOptimistic(sessionID, messageID))
			trackId(inboxBackedOptimisticIds, sessionID, messageID);
	},

	optimisticEchoOf: (sessionID, optimisticID) =>
		optimisticEchoes.get(sessionID)?.get(optimisticID),

	optimisticOriginOf: (sessionID, echoID) => optimisticOrigins.get(sessionID)?.get(echoID),

	isOptimisticMessage: (sessionID, messageID) => isOptimistic(sessionID, messageID),

	forgetControlPlaneMessage: (sessionID, messageID) => {
		untrackId(controlPlaneOwnedIds, sessionID, messageID);
		releaseOptimisticId(sessionID, messageID);
		trackId(cancelledMessageIds, sessionID, messageID);
		get().removeMessage(sessionID, messageID);
	},

	registerOptimisticEcho: (sessionID, optimisticID, echoID) => {
		if (optimisticID === echoID) return;
		// The caller always names the id the ROW reports as this prompt's origin
		// — its `wire_message_id`, the id this tab minted and painted. That id
		// stops being optimistic the moment the FIRST echo supersedes it, and
		// after a Stop takes the prompt back out of the runtime the bubble on
		// screen is that echo (`reclaimRemovedMessage` re-marks it optimistic),
		// not the wire id. Registering against the wire id alone therefore did
		// nothing on every second and later re-mint, and the drain re-mints on
		// every one of them: the re-delivery's echo then matched no alias, and
		// with more than one send in flight the ordinal fallback correctly
		// refuses to guess — so the echo was dropped and the prompt stayed on
		// screen as a bubble nothing would ever confirm.
		//
		// Follow the chain to the id that IS on screen and register from there.
		const live = isOptimistic(sessionID, optimisticID)
			? optimisticID
			: optimisticEchoes.get(sessionID)?.get(optimisticID);
		if (!live || live === echoID || !isOptimistic(sessionID, live)) return;
		recordOptimisticEcho(sessionID, live, echoID);
	},

	reclaimRemovedMessage: (sessionID, messageID) => {
		// See `controlPlaneOwnedIds`: a removal of a message the control plane
		// still owns is a re-placement in progress, not a deletion. Keep the
		// message and its parts; put the optimistic marks back (dispatched, so
		// the ordinal echo match may claim it; inbox-backed, so the idle sweep
		// leaves it) and let the next echo supersede it.
		if (!hasTrackedId(controlPlaneOwnedIds, sessionID, messageID)) return false;
		const list = get().messages[sessionID];
		const message = list?.find((m) => m.id === messageID);
		if (!message || message.role !== "user") return false;
		untrackId(controlPlaneOwnedIds, sessionID, messageID);
		trackId(optimisticIds, sessionID, messageID);
		trackId(dispatchedOptimisticIds, sessionID, messageID);
		trackId(inboxBackedOptimisticIds, sessionID, messageID);
		return true;
	},

	optimisticRemove: (sessionID, messageID) => {
		// Only an OPTIMISTIC message can be removed this way. One the runtime has
		// confirmed (same-id echo, or the store never tracked it) is the
		// transcript's; a host that removes its inbox row must not take the
		// persisted message with it.
		if (!isOptimistic(sessionID, messageID)) return;
		releaseOptimisticId(sessionID, messageID);
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

	noteSessionActivity: (sessionID, atMs) => {
		if (!sessionID) return;
		const now = atMs ?? Date.now();
		const previous = get().sessionActivityAt[sessionID];
		// Quantized: a busy runtime emits parts every few tens of milliseconds and
		// nothing reads this to the millisecond. Without the floor, every
		// subscriber re-renders at the stream's own rate for a timestamp.
		if (previous !== undefined && now - previous < ACTIVITY_STAMP_RESOLUTION_MS) return;
		set((s) => ({ sessionActivityAt: { ...s.sessionActivityAt, [sessionID]: now } }));
	},

	clearOptimisticMessages: (sessionID) => {
		set((s) => {
			const list = s.messages[sessionID];
			if (!list) return s;
			// An inbox-backed message is held by the control plane and will be
			// delivered; a local idle is not evidence it was lost. It stays.
			const optIds = list
				.filter(
					(m) =>
						isOptimistic(sessionID, m.id) &&
						!hasTrackedId(inboxBackedOptimisticIds, sessionID, m.id),
				)
				.map((m) => m.id);
			if (optIds.length === 0) return s;
			for (const id of optIds) releaseOptimisticId(sessionID, id);
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
			// Emptied on purpose (a cache-ownership conflict). The disk copy is
			// exactly what must NOT come back, so drop any eviction mark with it.
			evictedSessions.delete(sessionID);
			const existingMessages = s.messages[sessionID] ?? [];
			const nextParts = { ...s.parts };
			for (const message of existingMessages) delete nextParts[message.id];
			deleteOrphanPartBuckets(nextParts, [sessionID]);
			const nextActivity = { ...s.sessionActivityAt };
			delete nextActivity[sessionID];
			return {
				messages: { ...s.messages, [sessionID]: [] },
				parts: nextParts,
				sessionActivityAt: nextActivity,
				sessionStatus: { ...s.sessionStatus, [sessionID]: { type: "idle" } as SessionStatus },
				// Fabricated, not observed — a cache handoff says nothing about
				// whether the runtime is running. Marked local so it can never
				// veto the control plane's open turn (`WorkingStreamInput.origin`).
				sessionStatusOrigin: { ...s.sessionStatusOrigin, [sessionID]: "local" as const },
				sessionStatusAt: { ...s.sessionStatusAt, [sessionID]: Date.now() },
				diffs: { ...s.diffs, [sessionID]: [] },
				todos: { ...s.todos, [sessionID]: [] },
				sessionRevert: { ...s.sessionRevert, [sessionID]: null },
				sessionRevertNeedsTailReconcile: (() => {
					const { [sessionID]: _, ...rest } = s.sessionRevertNeedsTailReconcile;
					return rest;
				})(),
			};
		}),

	retainSession: (sessionID) => {
		if (!sessionID) return () => {};
		// Out of the detach window BEFORE pruning it, so mounting a session can
		// never be what evicts it.
		detachedSessions.delete(sessionID);
		sessionConsumers.set(sessionID, (sessionConsumers.get(sessionID) ?? 0) + 1);

		const evicted = pruneDetachedSessions(get().messages);
		if (evicted.length > 0) {
			for (const id of evicted) {
				forgetSessionIds(id);
				evictedSessions.add(id);
			}
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

	wasTranscriptEvicted: (sessionID) => evictedSessions.has(sessionID),

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

	hydrate: (sessionID, msgs, opts) => {
		// Set inside the updater below when a RUNTIME read shows the transcript
		// moved while its tail is still open — the runtime's own output reaching
		// this tab by pull instead of push. Stamped after the set() commits.
		let stampRuntimeActivity = false;
		set((s) => {
			// An authoritative load — the disk repaint itself, or a reconcile —
			// re-establishes the session, so its entry is no longer a fragment.
			evictedSessions.delete(sessionID);
			const tombstones = cancelledMessageIds.get(sessionID);
			// NOT re-sorted. `MessageV2.page()` orders by `time_created`
			// server-side and always has, so the snapshot arrives in the only
			// order that is true. Re-deriving one from id strings was wrong the
			// moment OpenCode 1.18.15 retired "ids ascend with time" — and the
			// mobile store did the same re-sort with `localeCompare`, which is
			// not even byte order, so the two hosts disagreed on identical data.
			const incoming = msgs
				.filter((m) => !!m?.info?.id && !tombstones?.has(m.info.id))
				.map((m) => m.info);
			const fromCache = opts?.source === "cache";
			if (fromCache) {
				for (const m of incoming) trackId(cacheSourcedIds, sessionID, m.id);
			}
			// A RUNTIME read settles the cache's provisional messages: the ones
			// it contains are real; the ones it lacks but whose position it
			// COVERS (at or above the oldest message it returned) never existed
			// there and are dropped. Older ones are history the bounded tail did
			// not reach — kept, still provisional.
			//
			// The bound is derived by VALUE, not by position: `incoming` is now the
			// server's own page order, which is not an id order, so `incoming[0].id`
			// is no longer the smallest id in the page. (That this comparison is an
			// id comparison at all is a separate open question — see B-note in
			// deliberately left as-is here.)
			let droppedPhantoms: Set<string> | null = null;
			const provisional = fromCache ? undefined : cacheSourcedIds.get(sessionID);
			if (provisional && provisional.size > 0 && incoming.length > 0) {
				let oldestIncoming = incoming[0].id;
				for (const m of incoming) if (m.id < oldestIncoming) oldestIncoming = m.id;
				const incomingIds = new Set(incoming.map((m) => m.id));
				for (const id of [...provisional]) {
					if (incomingIds.has(id)) {
						untrackId(cacheSourcedIds, sessionID, id);
						continue;
					}
					if (id >= oldestIncoming && !isOptimistic(sessionID, id)) {
						untrackId(cacheSourcedIds, sessionID, id);
						(droppedPhantoms ??= new Set()).add(id);
					}
				}
			}

			// T16 — a `session.error` stub assistant message is reconciled
			// PER TURN, after the optimistic correlation below has run (see
			// `pendingStubs`). It only ever stood in for the assistant message
			// its own turn never produced, so the question is not "does this
			// session have an assistant message" — an earlier turn's answer is
			// no answer at all — but "does the server now answer THAT turn".

			// Re-adopt a stub that arrives IN the snapshot. The transcript cache
			// mirrors `messages[sessionID]` to IndexedDB, stubs included, so the
			// first paint after a reload brings one back — while
			// `stubAssistantIds` (module state) did not survive the reload. An
			// unadopted stub is unreconcilable: it would sit beside the server's
			// own reply forever. Only the runtime ever produces these ids, so
			// nothing else can be mistaken for one.
			for (const info of incoming) {
				if (info.role !== "assistant" || !isStubShaped(info.id)) continue;
				if (!(info as { error?: unknown }).error) continue;
				if (stubAssistantIds.get(sessionID)?.has(info.id)) continue;
				trackStub(sessionID, info.id, info.parentID ?? null);
			}

			const trackedStubIds = stubAssistantIds.get(sessionID);
			/** Stubs held back from the merge below until their parent turn is
			 *  known (an optimistic parent may be superseded by the server's own
			 *  copy in this very snapshot). */
			const pendingStubs: Message[] = [];

			// Merge incoming messages with existing ones — never delete messages
			// that exist in the sync store but are missing from the fetch (they may
			// be from a newer turn that the server hasn't persisted yet).
			const existingAll = s.messages[sessionID] ?? [];
			const existing = droppedPhantoms
				? existingAll.filter((m) => !droppedPhantoms!.has(m.id))
				: existingAll;
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

			// ---- Runtime-read activity evidence. ----
			// Movement on a transcript this tab ALREADY held, with the tail still
			// open, observed by a runtime read: the runtime is producing output
			// right now, whatever the stream's last status frame claimed. Guards,
			// each load-bearing (asserted in the test file): an initial fill is
			// history, not movement; a completed tail is a finished turn and must
			// not paint busy on a returning tab; a cache repaint is this tab's own
			// disk, not the runtime speaking.
			if (!fromCache && existingAll.length > 0) {
				const tail = incoming[incoming.length - 1];
				const tailOpen =
					!!tail &&
					tail.role === "assistant" &&
					!(tail as { time?: { completed?: number } }).time?.completed &&
					!(tail as { error?: unknown }).error;
				if (tailOpen) {
					stampRuntimeActivity =
						incoming.some((m) => !existingIds.has(m.id)) ||
						msgs.some((entry) => {
							const mid = entry?.info?.id;
							if (!mid || isOptimistic(sessionID, mid) || !existingIds.has(mid)) {
								return false;
							}
							const prev = s.parts[mid];
							if (!prev || prev.length === 0) return (entry.parts?.length ?? 0) > 0;
							const prevById = new Map(prev.map((p) => [p.id, p]));
							return (entry.parts ?? []).some((p) => {
								if (!p?.id) return false;
								const prevPart = prevById.get(p.id);
								if (!prevPart) return true;
								return (
									isTextLikePart(p) &&
									isTextLikePart(prevPart) &&
									(p.text?.length ?? 0) > (prevPart.text?.length ?? 0)
								);
							});
						});
				}
			}

			// The echo may arrive under the optimistic message's OWN id: the host
			// minted the wire id and painted the bubble with it. That is a
			// confirmation, not a duplicate — release the marks so the message is
			// ordinary from here (the sweep leaves it alone, real parts win), and
			// bridge its optimistic parts until real ones land.
			for (const m of incoming) {
				if (m.role !== "user" || !isOptimistic(sessionID, m.id)) continue;
				releaseConfirmedOptimisticId(sessionID, m.id, m.id);
				const optimisticParts = s.parts[m.id];
				const entry = msgs.find((x) => x.info.id === m.id);
				if ((entry?.parts?.length ?? 0) === 0 && optimisticParts?.length) {
					trackId(bridgedPartIds, sessionID, m.id);
				}
			}

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
					if (trackedStubIds?.has(m.id)) {
						// Placed (or dropped) after the correlation passes below,
						// because where it belongs depends on what happened to the
						// user message it is parented to.
						pendingStubs.push(m);
						continue;
					}
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
						// By TIME, not by a binary index over ids the snapshot never
						// ordered that way — see `insertIndexByTime`.
						merged.splice(insertIndexByTime(merged, m), 0, m);
					}
				}
			}

			// Pass 2 — ordinal fallback, for an echo the server accepted but whose
			// parts have not landed yet (no part ids to match on). Restricted to
			// DISPATCHED messages: one that has not been POSTed cannot be a
			// duplicate of anything the server holds, so it is never eligible.
			// That restriction is what keeps a message sent from another tab from
			// consuming this tab's in-flight bubble.
			const claimed = new Set<string>();
			for (const m of unmatchedOptimisticUsers) {
				// Alias first: the inbox row announced this message's echo id.
				const alias = optimisticEchoes.get(sessionID)?.get(m.id);
				if (alias && unclaimedEchoes.has(alias) && !claimed.has(alias)) {
					claimed.add(alias);
					supersededOptimistic.push(m.id);
					supersededBy.set(m.id, alias);
				}
			}
			const claimable = candidateEchoes.filter(
				(m) => unclaimedEchoes.has(m.id) && !claimed.has(m.id),
			);
			let next = 0;
			for (const m of unmatchedOptimisticUsers) {
				if (supersededBy.has(m.id)) continue;
				const echo =
					isDispatched(sessionID, m.id) &&
					// Known-different echo → never consume someone else's.
					!optimisticEchoes.get(sessionID)?.get(m.id)
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

			// Clean up superseded optimistic IDs, remembering which runtime id
			// each one became.
			for (const id of supersededOptimistic) {
				const echoId = supersededBy.get(id);
				if (echoId) {
					releaseConfirmedOptimisticId(sessionID, id, echoId);
					recordOptimisticEcho(sessionID, id, echoId);
				} else {
					releaseOptimisticId(sessionID, id);
				}
			}
			// Append surviving optimistic messages at the end
			for (const m of deferredOptimistic) {
				merged.push(m);
			}

			// Now place (or retire) each `session.error` stub, with its turn
			// finally settled. Three outcomes, in order:
			//
			//  - its user message was superseded by the server's own copy in this
			//    snapshot → the stub follows it, re-keyed onto the real id;
			//  - the server now holds a real assistant message for that turn →
			//    the stub was a stand-in for exactly that message, so it goes;
			//  - otherwise → it stays, directly after its user message. This is
			//    the case the reported bug turned on: the `reconcileTail` that
			//    every `session.error` triggers returns a transcript with NO
			//    reply for the failed turn, and dropping the stub there left the
			//    user staring at their own prompt and nothing else.
			for (const stub of pendingStubs) {
				const trackedParent = trackedStubIds?.get(stub.id) ?? null;
				const parentId = (trackedParent && supersededBy.get(trackedParent)) || trackedParent;
				untrackStub(sessionID, stub.id);
				// The server DOES hold a reply for this turn — the stub stood in
				// for exactly that message, so it goes. Its error moves onto the
				// real message first, unless the server's copy carries one of its
				// own: `session.error` is the runtime's report of THIS turn
				// failing, and the transcript read that follows it does not always
				// carry the failure back (the same race
				// `use-opencode-events`'s cache patch exists for). Dropping the
				// stub against an error-free server copy would erase the only
				// evidence the turn failed.
				if (hasAssistantForTurn(incoming, parentId)) {
					const replyIdx = findAssistantForTurn(merged, parentId);
					const reply = replyIdx === -1 ? undefined : merged[replyIdx];
					const stubError = (stub as { error?: unknown }).error;
					if (reply && !(reply as { error?: unknown }).error && stubError) {
						merged[replyIdx] = { ...reply, error: stubError } as Message;
					}
					continue;
				}
				const stubId = parentId ? stubIdFor(parentId) : stub.id;
				const placed =
					stubId === stub.id && (stub as { parentID?: string }).parentID === (parentId ?? undefined)
						? stub
						: ({ ...stub, id: stubId, ...(parentId ? { parentID: parentId } : {}) } as Message);
				trackStub(sessionID, stubId, parentId);
				const parentIdx = parentId ? merged.findIndex((m) => m.id === parentId) : -1;
				if (parentIdx !== -1) {
					merged.splice(parentIdx + 1, 0, placed);
					continue;
				}
				// Its user message is not in the transcript at all. Linear on a
				// miss so a re-keyed stub never lands twice (`stubIdFor(parentId)`
				// can name a stub already merged), and by time otherwise — a stub
				// carries no `time`, so it goes last.
				if (indexOfId(merged, placed.id, (x) => x.id) === -1) {
					merged.splice(insertIndexByTime(merged, placed), 0, placed);
				}
			}

			// Merge parts: for each message, reconcile by part ID.
			// If a message is optimistic (still in optimisticIds), keep existing
			// parts entirely — they're from the client and shouldn't be overwritten.
			// Otherwise, incoming parts win (server is authoritative), but keep
			// any extra parts from SSE that aren't in the fetch response.
			const newParts = { ...s.parts };
			if (droppedPhantoms) for (const id of droppedPhantoms) delete newParts[id];
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

				// Parts, not messages: this sort is untouched by the message-order
				// work and keeps its own byte-order comparison.
				const inParts = m.parts
					.filter((p) => !!p?.id)
					.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
				// T16 — dedupe extras by content identity. An "extra" is an
				// existing part whose id the incoming snapshot no longer has — the
				// server may simply not have persisted it yet (kept, as before), OR
				// the server RE-ISSUED the same content under a NEW part id (a real
				// defect: the old SSE-accumulated twin stayed in `exParts` forever,
				// duplicating the text inside this one message). Distinguish the two
				// conservatively: drop an extra only when it is text-like AND its own
				// accumulated text is a PREFIX of (or equal to) some incoming
				// text-like part of the SAME type — i.e. the incoming copy confidently
				// re-issues it, not merely resembles it. Non-text-like extras (tool,
				// permission, file, step, …) are never dropped by content — they carry
				// distinct identity per id and a coincidental text match doesn't apply
				// to them at all.
				//
				// F1 review finding: an extra still tracked in `deltaActiveParts` (this
				// session is actively applying deltas to it right now) is EXEMPT from
				// this filter regardless of what it prefixes. The heuristic above
				// assumes a text-prefix match means the server re-issued the SAME
				// content under a new id and the extra is an abandoned twin — but a
				// live streaming target is never abandoned, and dropping it here also
				// permanently blocks its later deltas (their event ids would already
				// be recorded as applied — see `applyPartDelta`'s not-found path).
				const survivingExtras = extras.filter((extra) => {
					if (hasTrackedId(deltaActiveParts, sessionID, extra.id)) return true;
					if (!isTextLikePart(extra) || extra.text.length === 0) return true;
					return !inParts.some(
						(inP) =>
							inP.type === extra.type &&
							isTextLikePart(inP) &&
							inP.text.startsWith(extra.text),
					);
				});
				for (const ep of survivingExtras) {
					const r = Binary.search(reconciled, ep.id, (p) => p.id);
					if (!r.found) reconciled.splice(r.index, 0, ep);
				}
				newParts[mid] = reconciled;
			}
			return {
				messages: { ...s.messages, [sessionID]: merged },
				parts: newParts,
			};
		});
		// Outside the updater: `noteSessionActivity` runs its own set(), and the
		// stamp is quantized there. This is the evidence `projectWorking`'s
		// content-first rule needs to outrank a stale wire idle frame whose veto
		// would otherwise silence every fresh `/turn` read for the rest of a turn
		// the SSE stream stopped reporting (prod, 2026-08-26).
		if (stampRuntimeActivity) get().noteSessionActivity(sessionID);
	},

	reset: () => {
		optimisticIds.clear();
		dispatchedOptimisticIds.clear();
		inboxBackedOptimisticIds.clear();
		optimisticEchoes.clear();
		optimisticOrigins.clear();
		bridgedPartIds.clear();
		deltaActiveParts.clear();
		deltaEventTails.clear();
		stubAssistantIds.clear();
		// The data these holds protected is gone, so the holds are too —
		// otherwise a late unmount could free a session the next page opened.
		sessionConsumers.clear();
		detachedSessions.clear();
		evictedSessions.clear();
		sessionMessageRows.clear();
		set({
			messages: {},
			parts: {},
			sessionStatus: {},
			sessionStatusOrigin: {},
			sessionStatusAt: {},
			sessionActivityAt: {},
			diffs: {},
			todos: {},
			sessionRevert: {},
			sessionRevertNeedsTailReconcile: {},
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
				{
					const info = (event.properties as { info?: { sessionID?: string } })?.info;
					const sid =
						info?.sessionID ?? (event.properties as { sessionID?: string })?.sessionID;
					if (sid) get().noteSessionActivity(sid);
				}
				const info = (event.properties as { info: Message }).info;
				if (!info?.sessionID) return;
				// The user cancelled this message; the runtime's husk stays dead.
				if (cancelledMessageIds.get(info.sessionID)?.has(info.id)) return;
					// When a real user message arrives from the server, swap out the
				// optimistic message(s) in a SINGLE atomic set() call.
				// This prevents the intermediate render where the user bubble
				// vanishes (optimistic removed) before the real one appears.
				if (info.role === "user" && isOptimistic(info.sessionID, info.id)) {
					// The echo under the optimistic message's OWN id (the host minted
					// the wire id and painted with it): confirmed in place. Release the
					// marks — it is an ordinary message from here — and bridge the
					// optimistic parts until the real ones arrive, so the bubble never
					// blinks empty and never shows both.
					releaseOptimisticId(info.sessionID, info.id);
					if (get().parts[info.id]?.length) {
						trackId(bridgedPartIds, info.sessionID, info.id);
					}
					store.upsertMessage(info.sessionID, info);
					return;
				}
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
						// A pre-registered alias (`registerOptimisticEcho`) is an identity
						// match: the row named this echo id before it arrived.
						const byAlias = optimisticUsers.find(
							(m) => optimisticEchoes.get(info.sessionID)?.get(m.id) === info.id,
						);
						// The ordinal guess is only safe when there is exactly ONE
						// in-flight send it could be. With a burst in flight, a
						// part-less echo that matches neither a part id nor a
						// registered alias WAITS: the hydrate that follows carries
						// the parts (identity match), and consuming the oldest
						// bubble here handed one message's echo another message's
						// text (measured: the first bubble of a burst vanished).
						const eligible = optimisticUsers.filter(
							(m) =>
								isDispatched(info.sessionID, m.id) &&
								// An optimistic message whose OWN echo is known to be a
								// DIFFERENT id must not be consumed by someone else's.
								!optimisticEchoes.get(info.sessionID)?.get(m.id),
						);
						const matched =
							byPartId ?? byAlias ?? (eligible.length === 1 ? eligible[0] : undefined);
						if (!matched && eligible.length > 1) return;
						const optIds = matched ? [matched.id] : [];
						if (optIds.length > 0) {
							// Clean up optimistic tracking, remembering the runtime id
							// each superseded message became.
							for (const id of optIds) {
								releaseConfirmedOptimisticId(info.sessionID, id, info.id);
								recordOptimisticEcho(info.sessionID, id, info.id);
							}
							// Atomic: remove optimistic + insert real in one set()
							set((s) => {
								const list = s.messages[info.sessionID] ?? [];
								// Remove all optimistic user messages
								const without = list.filter((m) => !optIds.includes(m.id));
								// Place the real message. Linear on a miss, then by TIME: a
								// false miss spliced a SECOND copy of a message already in
								// the transcript, at a binary index that means nothing on a
								// list the server never ordered by id.
								const at = indexOfId(without, info.id, (m) => m.id);
								let next = [...without];
								if (at !== -1) {
									next[at] = info;
								} else {
									next.splice(insertIndexByTime(next, info), 0, info);
								}
								// A turn that failed before this confirmation arrived
								// has a `session.error` stub keyed to the optimistic id
								// being retired here. Re-key it, or its error detaches
								// from the turn and drifts to the bottom of the thread.
								for (const id of optIds) {
									next = rekeyStubParent(info.sessionID, next, id, info.id);
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
				if (store.reclaimRemovedMessage(props.sessionID, props.messageID)) return;
				store.removeMessage(props.sessionID, props.messageID);
				return;
			}
			case "message.part.updated": {
				const part = (event.properties as { part: Part }).part;
				if (!part?.messageID) return;
				// The runtime just produced output. This is the evidence
				// `projectWorking` trusts above every observer — see
				// `sessionActivityAt`.
				{
					const sid =
						part.sessionID ?? (event.properties as { sessionID?: string })?.sessionID;
					if (sid) get().noteSessionActivity(sid);
				}

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
				// The `.some()` alone is authoritative; the binary search that used
				// to sit beside it as a first disjunct could only agree with it or
				// miss on a list that is not id-sorted.
				const exists = existingMsgs?.some((m) => m.id === part.messageID);
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

				// A delta IS runtime output — the same evidence
				// `message.part.updated` stamps above, and the input
				// `projectWorking` ranks first ("CONTENT FIRST" in
				// core/session/working.ts). Only the snapshot path stamped it,
				// which was harmless while every runtime streamed snapshots.
				// It stopped being harmless when pi started sending real
				// deltas: its text then arrived as ~280 deltas and ~6
				// snapshots per answer, so `sessionActivityAt` went stale
				// mid-generation and the projection fell back to the `/turn`
				// ledger — the laggy observer, which on pi leaves rows open —
				// and the composer showed Stop off a poll instead of off the
				// stream.
				if (props.sessionID) get().noteSessionActivity(props.sessionID);

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

				// `event.id` is a top-level field of every wire event (see
				// `deltaEventTails` above) — never inside `properties`, so it is
				// read directly off `event`, not `props`.
				store.applyPartDelta(
					props.sessionID,
					props.messageID,
					props.partID,
					props.field,
					props.delta,
					event.id,
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
					store.setStatus(props.sessionID, props.status, syntheticEventOrigin(event));
				return;
			}
		case "session.idle": {
			const sessionID = (event.properties as { sessionID: string }).sessionID;
			if (sessionID) store.setStatus(sessionID, { type: "idle" }, syntheticEventOrigin(event));
			// Streaming finished for THIS session — clear only its own delta
			// tracking so future message.part.updated snapshots for it are
			// accepted normally. Never the whole map: another session may
			// still be streaming (see comment above deltaActiveParts).
			if (sessionID) deltaActiveParts.delete(sessionID);
			// Same reasoning for the delta event-id tails (T14): a new
			// turn's deltas use brand-new part ids anyway, so nothing realistic
			// is lost by dropping this session's tracking here.
			if (sessionID) deltaEventTails.delete(sessionID);
			return;
		}
		case "session.error": {
			const props = event.properties as { sessionID?: string; error?: MessageError };
			if (!props.sessionID || !props.error) return;
			const sid = props.sessionID;
			const error = props.error;
			// Mark session idle — errors terminate the response.
			store.setStatus(sid, { type: "idle" }, syntheticEventOrigin(event));
			// Clear only this session's delta tracking — see the idle handler
			// above and the comment above deltaActiveParts.
			deltaActiveParts.delete(sid);
			deltaEventTails.delete(sid);

			// Attach the error to the TURN THAT FAILED, which is the turn the
			// last user message opened: `session.error` terminates the turn the
			// runtime was running, and the runtime runs one at a time.
			//
			// When that turn already produced an assistant message the error is
			// patched onto it, as before. When it produced none — the whole
			// class of failures that die before generation starts, e.g.
			// `ModelNotFound`, which arrives ~2ms after the prompt — a stub
			// assistant message stands in for it, parented to that user message
			// and positioned directly after it.
			//
			// It used to be "the last assistant message ANYWHERE, else append a
			// stub at the end", and both halves put the error in the wrong turn:
			// the patch landed on the previous turn's answer (where the
			// `reconcileTail` hydrate that follows every `session.error` then
			// overwrote it with the server's error-free copy, so the failure
			// rendered NOTHING), and the appended stub rode the bottom of the
			// thread, reappearing under whichever prompt came next.
			//
			// The event handler in use-opencode-events.ts also fetches real
			// messages from the server, which brings in the authoritative data
			// via hydrate().
			set((s) => {
				const msgs = s.messages[sid] ?? [];
				// The prompt this error answers.
				let userIdx = -1;
				for (let i = msgs.length - 1; i >= 0; i--) {
					if (msgs[i].role === "user") {
						userIdx = i;
						break;
					}
				}
				const userId = userIdx === -1 ? null : msgs[userIdx].id;

				// An assistant message that already belongs to THAT turn takes
				// the error. Scanning back only as far as the user message is
				// what keeps an earlier turn's answer out of it.
				for (let i = msgs.length - 1; i > userIdx; i--) {
					const msg = msgs[i];
					if (msg.role !== "assistant") continue;
					if (userId && msg.parentID && msg.parentID !== userId) continue;
					if (msg.error) return s; // already has error
					const next = [...msgs];
					// `error` may be the client-synthesized `SyntheticAbortError`
					// (see `MessageError`), which the SDK's own `AssistantMessage.error`
					// union doesn't declare — the assertion is the documented, narrow
					// exception for that one extra shape.
					next[i] = { ...msg, error } as typeof msg;
					return { messages: { ...s.messages, [sid]: next } };
				}

				// No assistant message for this turn yet — stand one in so the
				// error renders under the prompt it answers. Tracked in
				// `stubAssistantIds` (T16) with its parent so `hydrate` can
				// reconcile it away once the server's own transcript answers
				// THAT turn — see that map's doc comment and the reconciliation
				// in `hydrate` below.
				const stubId = userId ? stubIdFor(userId) : ascendingId("msg");
				if (msgs.some((m) => m.id === stubId)) return s;
				trackStub(sid, stubId, userId);
				const stubMsg: Message = {
					id: stubId,
					sessionID: sid,
					role: "assistant",
					...(userId ? { parentID: userId } : {}),
					error,
				} as Message;
				const next = [...msgs];
				next.splice(userIdx === -1 ? next.length : userIdx + 1, 0, stubMsg);
				return { messages: { ...s.messages, [sid]: next } };
			});
			return;
		}
			case "session.next.revert.staged": {
				const props = event.properties as {
					sessionID: string;
					revert: { messageID: string };
				};
				if (props.sessionID && props.revert?.messageID) {
					store.stageSessionRevert(props.sessionID, props.revert.messageID);
				}
				return;
			}
			case "session.next.revert.cleared": {
				const props = event.properties as { sessionID: string };
				if (props.sessionID) store.clearSessionRevert(props.sessionID);
				return;
			}
			case "session.next.revert.committed": {
				const props = event.properties as { sessionID: string; messageID: string };
				if (props.sessionID && props.messageID) {
					const tracked = get().sessionRevert[props.sessionID];
					if (tracked) {
						// The captured set only describes the boundary it was staged for.
					// A `.committed` naming a different one falls back to the legacy
					// range rather than deleting the wrong trajectory.
					store.applyCommittedRevert(
						props.sessionID,
						props.messageID,
						tracked.watermark,
						tracked.messageId === props.messageID ? tracked.hiddenIds : undefined,
					);
					} else {
						// F2 — no tracked local record (fresh mount / second tab that
						// never saw `.staged`). The REMOVED fallback guessed a
						// watermark from `newestMessageId(local messages)`, which can
						// be the user's own REPLACEMENT prompt if its
						// `message.updated` arrived before this `.committed` event —
						// deleting the replacement and its answer. Do not guess: flag
						// this session for a tail reconcile (see
						// `markSessionRevertNeedsTailReconcile`'s doc comment) and
						// leave messages alone. The server's actual (already-
						// truncated) transcript arrives through whatever reads that
						// flag.
						store.markSessionRevertNeedsTailReconcile(props.sessionID);
					}
				}
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
