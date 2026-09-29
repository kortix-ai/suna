import type { Event as OpenCodeEvent, Message, Part, TextPart, ReasoningPart } from "@opencode-ai/sdk/v2/client";
import type { StoreApi } from "zustand";
import type { SyncState } from "./state";

export type MessageEventHelpers = {
	cancelledMessageIds: Map<string, Set<string>>;
	isOptimistic: (sessionID: string, messageID: string) => boolean;
	releaseOptimisticId: (sessionID: string, id: string) => void;
	trackId: (store: Map<string, Set<string>>, sessionID: string, id: string) => void;
	bridgedPartIds: Map<string, Set<string>>;
	isDispatched: (sessionID: string, messageID: string) => boolean;
	optimisticEchoes: Map<string, Map<string, string>>;
	hasTrackedId: (store: Map<string, Set<string>>, sessionID: string, id: string) => boolean;
	inboxBackedOptimisticIds: Map<string, Set<string>>;
	releaseConfirmedOptimisticId: (sessionID: string, optimisticID: string, echoID: string) => void;
	recordOptimisticEcho: (sessionID: string, optimisticID: string, echoID: string) => void;
	indexOfId: <T>(list: readonly T[], id: string, idOf: (item: T) => string) => number;
	insertIndexByTime: (list: readonly Message[], message: Message) => number;
	rekeyStubParent: (sessionID: string, list: readonly Message[], fromId: string, toId: string) => Message[];
	awaitsUserEcho: (sessionID: string, messageID: string) => boolean;
	isTextLikePart: (part: Part) => part is TextPart | ReasoningPart;
	writeStreamCache: typeof import("./stream-cache").writeStreamCache;
};

export function applyMessageEvent(event: OpenCodeEvent, get: StoreApi<SyncState>["getState"], set: StoreApi<SyncState>["setState"], eventHelpers: MessageEventHelpers): void {
	const store = get();
	const { cancelledMessageIds, isOptimistic, releaseOptimisticId, trackId, bridgedPartIds, isDispatched, optimisticEchoes, hasTrackedId, inboxBackedOptimisticIds, releaseConfirmedOptimisticId, recordOptimisticEcho, indexOfId, insertIndexByTime, rekeyStubParent, awaitsUserEcho, isTextLikePart, writeStreamCache } = eventHelpers;
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
						// A later update to an already placed user message is not a
						// new echo. The sole waiting prompt may be the only optimistic
						// message left after the running prompt was confirmed.
						if (msgs.some((message) => message.id === info.id)) {
							store.upsertMessage(info.sessionID, info);
							return;
						}
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
						// Correlate by part id or the inbox row's alias. Only a send
						// without an inbox row may use the ordinal fallback.
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
						// The ordinal guess is only available when there is exactly ONE
						// eligible send without an inbox row. With a burst in flight, a
						// part-less echo that matches neither a part id nor a
						// registered alias consumes NOTHING: taking the oldest
						// bubble handed one message's echo another message's text
						// (measured: the first bubble of a burst vanished).
						//
						// Consuming nothing is not the same as DISCARDING the echo,
						// and this branch used to `return` on it — dropping the
						// server's own message on the floor. Nothing re-reads a
						// healthy stream, so the delivered prompt stayed missing
						// until a reload, and the `message.part.updated` behind it
						// re-created the id as an ASSISTANT message: the user's
						// words in the agent's voice, with the real reply
						// re-parented onto whichever bubble happened to sort last.
						// That is the whole "only the first queued prompt shows up"
						// report. The echo is placed like any other message now; the
						// bubble it belongs to is retired the moment the inbox row
						// names the pairing (`registerOptimisticEcho`), one poll
						// behind at worst.
						const eligible = optimisticUsers.filter(
							(m) =>
								isDispatched(info.sessionID, m.id) &&
								!hasTrackedId(inboxBackedOptimisticIds, info.sessionID, m.id) &&
								// An optimistic message whose OWN echo is known to be a
								// DIFFERENT id must not be consumed by someone else's.
								!optimisticEchoes.get(info.sessionID)?.get(m.id),
						);
						const matched =
							byPartId ?? byAlias ?? (eligible.length === 1 ? eligible[0] : undefined);
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

				// The runtime just produced output. This is the evidence
				// `projectWorking` trusts above every observer — see
				// `sessionActivityAt`. Stamp AFTER the message-id fallback: some
				// producers omit sessionID from the part while still updating a
				// known message, and that visible output is runtime activity too.
				if (resolvedSessionID) get().noteSessionActivity(resolvedSessionID);

				const existingMsgs = resolvedSessionID
					? get().messages[resolvedSessionID]
					: undefined;
				// The `.some()` alone is authoritative; the binary search that used
				// to sit beside it as a first disjunct could only agree with it or
				// miss on a list that is not id-sorted.
				const exists = existingMsgs?.some((m) => m.id === part.messageID);
				// The net for a part that outran its own message frame — but never
				// over a send still waiting for its echo, and never as the FIRST
				// message of a session. `role: "assistant"` is a guess, and for the
				// echo of a re-minted prompt it is a guess that puts the user's own
				// words on screen twice, the second time in the agent's voice.
				//
				// `awaitsUserEcho` catches that when this tab painted the prompt.
				// It cannot on the project-home route, where the prompt is a
				// server-created inbox row and there is no optimistic message to
				// see — so the second condition carries it: an assistant part is a
				// REPLY, and a session with nothing to reply to yet is not what
				// this net is for. `message.part.delta` below has guarded on
				// exactly this since it was written; this is the same rule on the
				// frame that actually creates the message.
				//
				// The part is stored either way; only the invented message waits
				// for the frame that knows.
				const sessionHasUserMessage = existingMsgs?.some((m) => m.role === "user") ?? false;
				if (
					!exists &&
					resolvedSessionID &&
					sessionHasUserMessage &&
					!awaitsUserEcho(resolvedSessionID, part.messageID)
				) {
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
	}
}
