import type { Event as OpenCodeEvent, Message, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";
import type { StoreApi } from "zustand";
import type { SyncState } from "./state";
import type { FileDiff, MessageError } from "./types";

export type SessionEventHelpers = {
	syntheticEventOrigin: (event: unknown) => "wire" | "local";
	deltaActiveParts: Map<string, Set<string>>;
	isRetryableTurnError: typeof import("../../../core/turns/open-turn").isRetryableTurnError;
	deltaEventTails: Map<string, Map<string, Set<string>>>;
	stubIdFor: (userId: string) => string;
	ascendingId: typeof import("./ascending-id").ascendingId;
	trackStub: (sessionID: string, stubId: string, parentId: string | null) => void;
};

export function applySessionEvent(event: OpenCodeEvent, get: StoreApi<SyncState>["getState"], set: StoreApi<SyncState>["setState"], eventHelpers: SessionEventHelpers): void {
	const store = get();
	const { syntheticEventOrigin, deltaActiveParts, isRetryableTurnError, deltaEventTails, stubIdFor, ascendingId, trackStub } = eventHelpers;
	switch (event.type) {
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
			// Keep the bounded event-id tail after completion: reconnects can
			// replay the final delta after idle. New turns use new part ids.
			return;
		}
		case "session.error": {
			const props = event.properties as { sessionID?: string; error?: MessageError };
			if (!props.sessionID || !props.error) return;
			const sid = props.sessionID;
			const error = props.error;
			// Most errors terminate the response. A RETRYABLE one does not:
			// OpenCode stamps `data.isRetryable === true` and keeps writing the
			// SAME assistant message, and apps/api reaches the same conclusion
			// from this same event (`isTerminalTurnEnd`,
			// apps/api/src/projects/sandbox-deadline-policy.ts:295). Writing
			// `idle` here made a live turn byte-identical to a finished one, and
			// `endedByRuntime` (core/session/working.ts) then vetoed the still-open
			// ledger row with no time bound — the Stop button disappeared mid-turn
			// and the partial answer read as complete.
			//
			// The status slot is LEFT ALONE rather than set to `retry`: the frame
			// already there is the runtime's own last word, and overwriting it
			// would re-stamp its arrival time and restart every freshness window
			// that depends on it.
			if (!isRetryableTurnError(error)) {
				store.setStatus(sid, { type: "idle" }, syntheticEventOrigin(event));
			}
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
}
