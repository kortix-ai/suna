import type { Message, Event as OpenCodeEvent, Part, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";
import type { FileDiff, MessageError, MessageWithParts, SessionRewindState } from "./types";

export interface SyncState {
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
