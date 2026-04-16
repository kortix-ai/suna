"use client";

import type {
	FileDiff,
	Message,
	Part,
	PermissionRequest,
	QuestionRequest,
	SessionStatus,
	Todo,
} from "@opencode-ai/sdk/v2/client";
import { useEffect, useRef } from "react";
import { getClient } from "@/lib/opencode-sdk";
import {
	type MessageWithParts,
	useSyncStore,
} from "@/stores/opencode-sync-store";

const EMPTY_MESSAGES: MessageWithParts[] = [];
const EMPTY_PERMS: PermissionRequest[] = [];
const EMPTY_QUES: QuestionRequest[] = [];
const EMPTY_DIFFS: FileDiff[] = [];
const EMPTY_TODOS: Todo[] = [];
const IDLE_STATUS = { type: "idle" } as SessionStatus;

/**
 * Build MessageWithParts[] with reference caching.
 * Returns the same array reference if nothing relevant changed.
 * This is a module-level cache keyed by sessionId so multiple components
 * using the same sessionId share the cache (e.g. SessionLayout + SessionChat).
 */
const messageCache = new Map<
	string,
	{
		msgs: Message[] | undefined;
		partRefs: (Part[] | undefined)[];
		result: MessageWithParts[];
	}
>();

function buildMessages(
	sessionId: string,
	msgs: Message[] | undefined,
	parts: Record<string, Part[]>,
): MessageWithParts[] {
	if (!msgs || msgs.length === 0) return EMPTY_MESSAGES;

	const cached = messageCache.get(sessionId);
	if (cached && cached.msgs === msgs) {
		// Same message array — check if any part arrays changed
		let same = cached.partRefs.length === msgs.length;
		if (same) {
			for (let i = 0; i < msgs.length; i++) {
				if (parts[msgs[i].id] !== cached.partRefs[i]) {
					same = false;
					break;
				}
			}
		}
		if (same) return cached.result;
	}

	// Rebuild
	const partRefs: (Part[] | undefined)[] = [];
	const result: MessageWithParts[] = [];
	for (const info of msgs) {
		const pa = parts[info.id];
		partRefs.push(pa);
		result.push({ info, parts: pa ?? [] });
	}
	messageCache.set(sessionId, { msgs, partRefs, result });
	return result;
}

/**
 * Single hook that provides all session data from the sync store.
 * Replaces: useOpenCodeMessages + useOpenCodeSessionStatusStore + useOpenCodePendingStore
 *
 * On first access, fetches messages from the server and populates the store.
 * After that, SSE events keep the store updated in real time.
 */
export function useSessionSync(sessionId: string) {
	const fetchedRef = useRef<string | null>(null);

	// Fetch messages on first access (or session change).
	// On failure, retries with backoff (500ms, 1s, 2s) up to 3 times.
	// Without retry, a transient failure (server not ready on page refresh)
	// permanently prevents messages from loading because fetchedRef blocks re-fetch.
	useEffect(() => {
		if (!sessionId) return;

		// Guard against duplicate concurrent fetches for the same session.
		if (fetchedRef.current === sessionId) return;
		fetchedRef.current = sessionId;

		// NOTE: We intentionally do NOT skip the fetch when the store already
		// has messages from SSE. SSE only delivers events from the connection
		// point forward — it doesn't replay history. If the agent is actively
		// streaming when the user navigates to a session, SSE stub messages
		// would be the only messages in the store, missing the full thread
		// history. Always fetch and let hydrate() merge safely.

		let cancelled = false;
		const fetchWithRetry = async (attempt = 0) => {
			try {
				const res = await getClient().session.messages({
					sessionID: sessionId,
				});
				if (cancelled) return;
				const data = (res.data ?? []) as any[];

				if (data.length === 0) {
					let sessionExists = true;
					try {
						const sessionRes = await getClient().session.get({ sessionID: sessionId });
						sessionExists = Boolean(sessionRes?.data);
					} catch {
						sessionExists = false;
					}

					// Read fresh state AFTER the awaits — the pending-prompt
					// effect may have set status to "busy" and added an
					// optimistic message while the fetch was in flight.
					// Using a stale pre-await snapshot would see "idle" and
					// incorrectly call clearSession, wiping the optimistic
					// message and reverting the UI to the welcome screen.
					const freshState = useSyncStore.getState();
					const currentStatus = freshState.sessionStatus[sessionId] ?? IDLE_STATUS;
					if (!sessionExists || currentStatus.type === "idle") {
						// Double-check: don't clear if there are already messages
						// in the store (e.g. optimistic messages added by the
						// pending-prompt effect while this fetch was in flight).
						const existingMsgs = freshState.messages[sessionId];
						if (existingMsgs && existingMsgs.length > 0) {
							// Messages exist (likely optimistic) — skip clearing
							return;
						}
						freshState.clearSession(sessionId);
						return;
					}
				}

				if (res.data) {
					useSyncStore.getState().hydrate(sessionId, res.data as any);
				}
			} catch {
				if (cancelled) return;
				if (attempt < 3) {
					const delay = 500 * 2 ** attempt; // 500ms, 1s, 2s
					setTimeout(() => fetchWithRetry(attempt + 1), delay);
				} else {
					// All retries exhausted — reset so a future mount can try again
					fetchedRef.current = null;
				}
			}
		};
		fetchWithRetry();

		return () => {
			cancelled = true;
			// Reset so React 18 Strict Mode double-mount can re-fetch.
			// Without this, the second mount sees fetchedRef === sessionId
			// and skips the fetch, while the first mount's result is discarded
			// because cancelled was set to true by this cleanup.
			fetchedRef.current = null;
			// Evict stale cache entry to prevent unbounded memory growth
			messageCache.delete(sessionId);
		};
	}, [sessionId]);

	// ── Polling fallback ──
	// When the session is busy, SSE should deliver streaming events. But if
	// SSE is broken (502, ERR_QUIC_PROTOCOL_ERROR, etc.), no events arrive
	// and the UI is stuck on "Considering next steps..." forever. As a
	// fallback, poll for messages every 3s while the session is busy.
	// The poll stops as soon as the session goes idle or the component unmounts.
	const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const lastPartCountRef = useRef(0);

	useEffect(() => {
		if (!sessionId) return;

		const state = useSyncStore.getState();
		const currentStatus = state.sessionStatus[sessionId];
		const isBusyNow = currentStatus?.type === "busy" || currentStatus?.type === "retry";

		if (isBusyNow) {
			// Start polling if not already active
			if (!pollTimerRef.current) {
				// Track part count to detect SSE liveness — if parts are
				// growing between polls, SSE is working and we skip the fetch.
				const countParts = () => {
					const s = useSyncStore.getState();
					const msgs = s.messages[sessionId] ?? [];
					let count = 0;
					for (const m of msgs) {
						const parts = s.parts[m.id];
						if (parts) count += parts.length;
					}
					return count;
				};
				lastPartCountRef.current = countParts();

				pollTimerRef.current = setInterval(async () => {
					const s = useSyncStore.getState();
					const st = s.sessionStatus[sessionId];
					if (st?.type !== "busy" && st?.type !== "retry") {
						// Session went idle — stop polling
						if (pollTimerRef.current) {
							clearInterval(pollTimerRef.current);
							pollTimerRef.current = null;
						}
						return;
					}

					// Skip fetch if SSE is delivering data (part count grew)
					const currentCount = countParts();
					if (currentCount > lastPartCountRef.current) {
						lastPartCountRef.current = currentCount;
						return;
					}

					// SSE appears stalled — fetch messages AND session status
					try {
						const [msgRes, statusRes] = await Promise.all([
							getClient().session.messages({ sessionID: sessionId }),
							getClient().session.status().catch(() => null),
						]);
						if (msgRes.data) {
							useSyncStore.getState().hydrate(sessionId, msgRes.data as any);
						}
						// Update session status from server — without this,
						// a dead SSE means session.idle never arrives and the
						// UI stays stuck on "busy" forever.
						if (statusRes?.data) {
							const statuses = statusRes.data as Record<string, any>;
							const serverStatus = statuses[sessionId];
							if (serverStatus) {
								useSyncStore.getState().setStatus(sessionId, serverStatus);
							} else {
								// Session not in busy statuses map → it's idle
								useSyncStore.getState().setStatus(sessionId, { type: "idle" } as SessionStatus);
							}
						}
					} catch {
						// Silently ignore — will retry on next interval
					}
					lastPartCountRef.current = countParts();
				}, 3000);
			}
		} else {
			// Session is idle — stop polling
			if (pollTimerRef.current) {
				clearInterval(pollTimerRef.current);
				pollTimerRef.current = null;
			}
		}
	});

	// Cleanup polling on unmount
	useEffect(() => {
		return () => {
			if (pollTimerRef.current) {
				clearInterval(pollTimerRef.current);
				pollTimerRef.current = null;
			}
		};
	}, []);

	// Single selector that derives MessageWithParts[] with reference caching.
	// The buildMessages function returns the same array reference if nothing
	// relevant to this session changed — preventing unnecessary re-renders.
	const messages = useSyncStore((s) =>
		buildMessages(sessionId, s.messages[sessionId], s.parts),
	);

	const status = useSyncStore(
		(s) => s.sessionStatus[sessionId] ?? IDLE_STATUS,
	) as SessionStatus;
	const permissions = useSyncStore((s) => s.permissions[sessionId]) as
		| PermissionRequest[]
		| undefined;
	const questions = useSyncStore((s) => s.questions[sessionId]) as
		| QuestionRequest[]
		| undefined;
	const diffs = useSyncStore((s) => s.diffs[sessionId]) as
		| FileDiff[]
		| undefined;
	const todos = useSyncStore((s) => s.todos[sessionId]) as Todo[] | undefined;

	const isBusy = status?.type === "busy" || status?.type === "retry";
	const isLoading = !useSyncStore((s) => sessionId in s.messages);

	return {
		messages,
		status,
		isBusy,
		isLoading,
		permissions: permissions ?? EMPTY_PERMS,
		questions: questions ?? EMPTY_QUES,
		diffs: diffs ?? EMPTY_DIFFS,
		todos: todos ?? EMPTY_TODOS,
	};
}
