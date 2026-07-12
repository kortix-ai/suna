"use client";

import type {
	Message,
	Event as OpenCodeEvent,
	Part,
	ReasoningPart,
	SessionStatus,
	TextPart,
	Todo,
} from "../runtime/wire-types";
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
	upsertPart: (messageID: string, part: Part) => void;
	removePart: (messageID: string, partID: string) => void;
	applyPartDelta: (
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
	clearOptimisticMessages: (sessionID: string) => void;
	/** True when the session's message list still holds an unconfirmed optimistic
	 *  message — lets the SSE reconciler avoid idling+clearing a brand-new session
	 *  whose first prompt the server hasn't registered yet. */
	hasOptimisticMessages: (sessionID: string) => boolean;
	clearSession: (sessionID: string) => void;
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
const optimisticIds = new Set<string>();
// Track message IDs where optimistic parts were bridged to the real message.
// When the first real part arrives for a bridged message, the bridged parts
// are cleared so optimistic and real parts don't co-exist (which would
// double-render the user's text).
const bridgedPartIds = new Set<string>();

// Track part IDs that have received at least one delta.
// Used by upsertPart to avoid overwriting delta-accumulated text with a
// stale message.part.updated snapshot that arrives in the same event batch.
// Entries are cleared when the streaming session goes idle.
const deltaActiveParts = new Set<string>();

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

	upsertPart: (messageID, part) =>
		set((s) => {
			// If this message had bridged (optimistic) parts, clear them now
			// that a real part has arrived — prevents double-rendering.
			let list: Part[];
			let bridgeCleared = false;
			if (bridgedPartIds.has(messageID)) {
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
					bridgedPartIds.delete(messageID);
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
					if (deltaActiveParts.has(part.id) && isTextLikePart(part)) {
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

	applyPartDelta: (messageID, partID, field, delta) => {
		deltaActiveParts.add(partID);
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
		optimisticIds.add(message.id);
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

	optimisticRemove: (sessionID, messageID) => {
		optimisticIds.delete(messageID);
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
				.filter((m) => optimisticIds.has(m.id))
				.map((m) => m.id);
			if (optIds.length === 0) return s;
			for (const id of optIds) optimisticIds.delete(id);
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
			const existingMessages = s.messages[sessionID] ?? [];
			const nextParts = { ...s.parts };
			for (const message of existingMessages) delete nextParts[message.id];
			return {
				messages: { ...s.messages, [sessionID]: [] },
				parts: nextParts,
				sessionStatus: { ...s.sessionStatus, [sessionID]: { type: "idle" } as SessionStatus },
				diffs: { ...s.diffs, [sessionID]: [] },
				todos: { ...s.todos, [sessionID]: [] },
			};
		}),

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

			// Check if incoming messages contain real user messages. When the
			// server already has the user message, any optimistic (client-
			// generated) user messages are duplicates and must be removed.
			// Without this, hydrate() + optimistic coexist → visual double bubble.
			const incomingHasUserMessage = incoming.some(
				(m) => m.role === "user" && !optimisticIds.has(m.id),
			);

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
			for (const m of existing) {
				if (!seen.has(m.id)) {
					if (optimisticIds.has(m.id)) {
						// If the server already has a real user message, this
						// optimistic user message is a duplicate — drop it.
						if (incomingHasUserMessage && m.role === "user") {
							supersededOptimistic.push(m.id);
						} else {
							deferredOptimistic.push(m);
						}
					} else {
						const r = Binary.search(merged, m.id, (x) => x.id);
						merged.splice(r.index, 0, m);
					}
				}
			}
			// Clean up superseded optimistic IDs
			for (const id of supersededOptimistic) {
				optimisticIds.delete(id);
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
			const realUserMsg = incoming.find(
				(m) => m.role === "user" && !optimisticIds.has(m.id),
			);
			const realUserEntry = realUserMsg
				? msgs.find((m) => m.info.id === realUserMsg.id)
				: undefined;
			const serverHasRealUserParts =
				(realUserEntry?.parts?.length ?? 0) > 0;
			let bridge: Part[] | undefined;
			for (const id of supersededOptimistic) {
				if (!bridge && newParts[id]?.length) bridge = newParts[id];
				delete newParts[id];
			}
			if (
				bridge &&
				realUserMsg &&
				!serverHasRealUserParts &&
				!newParts[realUserMsg.id]?.length
			) {
				newParts[realUserMsg.id] = bridge;
				bridgedPartIds.add(realUserMsg.id);
			}
			for (const m of msgs) {
				if (!m?.info?.id) continue;
				const mid = m.info.id;
				if (optimisticIds.has(mid)) continue; // Don't touch optimistic parts

				const inParts = m.parts
					.filter((p) => !!p?.id)
					.sort((a, b) => cmp(a.id, b.id));
				// If this message still carries bridged optimistic parts, a hydrate
				// snapshot with real parts should replace them immediately. Otherwise
				// reconcile-by-extras can keep both copies and duplicate user text.
				if (bridgedPartIds.has(mid) && inParts.length > 0) {
					bridgedPartIds.delete(mid);
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
		bridgedPartIds.clear();
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
		return list.some((m) => optimisticIds.has(m.id));
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
				if (info.role === "user" && !optimisticIds.has(info.id)) {
					const msgs = get().messages[info.sessionID];
					if (msgs) {
						const optIds = msgs
							.filter((m) => m.role === "user" && optimisticIds.has(m.id))
							.map((m) => m.id);
						if (optIds.length > 0) {
							// Clean up optimistic tracking
							for (const id of optIds) optimisticIds.delete(id);
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
									bridgedPartIds.add(info.id);
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

				store.upsertPart(part.messageID, part);
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
						messageID: props.messageID,
						type: "text",
						[props.field]: "",
					} as unknown as Part);
				}

				store.applyPartDelta(
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
			// Streaming finished — clear delta tracking so future
			// message.part.updated snapshots are accepted normally.
			deltaActiveParts.clear();
			return;
		}
		case "session.error": {
			const props = event.properties as { sessionID?: string; error?: MessageError };
			if (!props.sessionID || !props.error) return;
			const sid = props.sessionID;
			const error = props.error;
			// Mark session idle — errors terminate the response.
			store.setStatus(sid, { type: "idle" });
			deltaActiveParts.clear();

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
