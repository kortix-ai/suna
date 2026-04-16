"use client";

import type {
	Event as OpenCodeEvent,
	Part,
} from "@opencode-ai/sdk/v2/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { fileContentKeys } from "@/features/files/hooks/use-file-content";
import { fileListKeys } from "@/features/files/hooks/use-file-list";
import { gitStatusKeys } from "@/features/files/hooks/use-git-status";
import { clearConfigOverrides } from "@/hooks/opencode/use-opencode-config";
import { getSupabaseAccessToken, invalidateTokenCache } from "@/lib/auth-token";
import { logger } from "@/lib/logger";
import { getClient, resetClient } from "@/lib/opencode-sdk";
import { authenticatedFetch } from "@/lib/auth-token";
import { toast } from "@/lib/toast";
import {
	notifyPermissionRequest,
	notifyQuestion,
	notifySessionError,
	notifyTaskComplete,
} from "@/lib/web-notifications";
import { useDiagnosticsStore, parseDiagnosticsFromToolOutput } from "@/stores/diagnostics-store";
import { useOpenCodeCompactionStore } from "@/stores/opencode-compaction-store";
import { useOpenCodePendingStore } from "@/stores/opencode-pending-store";
import { useOpenCodeSessionStatusStore } from "@/stores/opencode-session-status-store";
import { useSyncStore } from "@/stores/opencode-sync-store";
import { useServerStore, getActiveOpenCodeUrl } from "@/stores/server-store";
import { ptyKeys } from "./use-opencode-pty";
import { opencodeKeys, type Session, type MessageWithParts } from "./use-opencode-sessions";

/**
 * Connects to OpenCode's SSE event stream via the SDK and
 * performs INCREMENTAL cache updates on React Query data.
 *
 * Instead of invalidating queries (which triggers full refetches),
 * we use setQueryData to surgically update messages, parts, sessions, etc.
 * This matches the SolidJS reference implementation's approach.
 */
export function useOpenCodeEventStream() {
	const queryClient = useQueryClient();
	const setStatus = useOpenCodeSessionStatusStore((s) => s.setStatus);
	const clearStatuses = useOpenCodeSessionStatusStore((s) => s.setStatuses);
	const addPermission = useOpenCodePendingStore((s) => s.addPermission);
	const removePermission = useOpenCodePendingStore((s) => s.removePermission);
	const addQuestion = useOpenCodePendingStore((s) => s.addQuestion);
	const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);
	const clearPending = useOpenCodePendingStore((s) => s.clear);
	const stopCompaction = useOpenCodeCompactionStore((s) => s.stopCompaction);
	const applySyncEvent = useSyncStore((s) => s.applyEvent);
	const serverVersion = useServerStore((s) => s.serverVersion);
	const activeServerUrl = useServerStore((s) => s.getActiveServerUrl());
	const abortRef = useRef<AbortController | null>(null);
	const isMountRef = useRef(true);
	const prevServerVersionRef = useRef(serverVersion);
	const prevServerUrlRef = useRef(activeServerUrl);

	/**
	 * Resolve an absolute sandbox path to a project-relative path by stripping
	 * known worktree/directory prefixes from the React Query cache.
	 *
	 * For example: `/workspace/desktop/express-crud-app/src/server.js` → `src/server.js`
	 *
	 * This is critical for LSP diagnostics: the backend sends absolute paths,
	 * but the frontend file tree / file viewer uses project-relative paths.
	 */
	const normalizeLspPath = useRef((absPath: string): string => {
		if (!absPath || !absPath.startsWith('/')) return absPath;

		// Collect prefixes from cached project/path data
		const prefixes: string[] = [];
		try {
			const project = queryClient.getQueryData<any>(opencodeKeys.currentProject());
			if (project?.worktree) prefixes.push(project.worktree);
			const pathInfo = queryClient.getQueryData<any>(opencodeKeys.pathInfo());
			if (pathInfo?.directory) prefixes.push(pathInfo.directory);
			if (pathInfo?.worktree) prefixes.push(pathInfo.worktree);
		} catch {
			// non-critical
		}

		// Deduplicate and sort longest first (most specific prefix wins)
		const unique = [...new Set(prefixes.filter(Boolean))].sort((a, b) => b.length - a.length);

		for (const wt of unique) {
			if (!wt || wt === '/') continue;
			const prefix = wt.endsWith('/') ? wt : wt + '/';
			if (absPath.startsWith(prefix)) {
				return absPath.slice(prefix.length);
			}
		}

		return absPath;
	});

	/** Normalize all keys in a diagnostic map from absolute to relative paths */
	const normalizeDiagnosticPaths = useRef((
		diagsByFile: Record<string, any[]>,
	): Record<string, any[]> => {
		const normalized: Record<string, any[]> = {};
		for (const [file, diags] of Object.entries(diagsByFile)) {
			const relPath = normalizeLspPath.current(file);
			normalized[relPath] = diags;
		}
		return normalized;
	});

	/**
	 * Debounced fetch of all LSP diagnostics from the backend.
	 *
	 * The `lsp.client.diagnostics` SSE event only carries { serverID, path }
	 * (no actual diagnostic data). Multiple events fire in rapid succession
	 * as the language server reports diagnostics for different files, so we
	 * debounce and fetch the full diagnostics map from GET /lsp/diagnostics.
	 */
	const fetchLspDiagnosticsDebounced = useRef((() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		return () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(async () => {
				timer = null;
				try {
					const baseUrl = getActiveOpenCodeUrl();
					const resp = await authenticatedFetch(`${baseUrl}/lsp/diagnostics`);
					if (!resp.ok) return;
					const data = await resp.json() as Record<string, any[]>;
					if (data && typeof data === "object") {
						const normalized = normalizeDiagnosticPaths.current(data);
						// The endpoint returns the *complete* diagnostics state,
						// so clear stale entries before applying the fresh data.
						const store = useDiagnosticsStore.getState();
						store.clearAll();
						store.setFromLspEvent(normalized);
					}
				} catch {
					// Silently ignore — diagnostics are non-critical and the
					// endpoint may not be available on older OpenCode versions.
				}
			}, 250);
		};
	})());

	const markSessionAbortedLocally = useRef((
		sessionID: string,
		message = "The operation was aborted because the runtime shut down.",
	) => {
		if (!sessionID) return;
		const error = {
			name: "AbortError",
			data: { message },
		};
		stopCompaction(sessionID);
		applySyncEvent({
			type: "session.error",
			properties: { sessionID, error },
		} as any);
		setStatus(sessionID, { type: "idle" } as any);
		useSyncStore.getState().clearOptimisticMessages(sessionID);
	});

	const markSessionIdleLocally = useRef((sessionID: string) => {
		if (!sessionID) return;
		stopCompaction(sessionID);
		applySyncEvent({
			type: "session.idle",
			properties: { sessionID },
		} as any);
		setStatus(sessionID, { type: "idle" } as any);
		useSyncStore.getState().clearOptimisticMessages(sessionID);
	});

	const reconcileMissingBusySessions = useRef((nextStatuses: Record<string, any>) => {
		const previousStatuses = useOpenCodeSessionStatusStore.getState().statuses;
		for (const [sessionID, status] of Object.entries(previousStatuses)) {
			if (status?.type !== "idle" && !nextStatuses[sessionID]) {
				markSessionIdleLocally.current(sessionID);
			}
		}
	});

	useEffect(() => {
		// On first mount, always start clean — the provider may have remounted
		// after navigating from a non-dashboard page (e.g. /instances) where
		// the server was switched while this component wasn't mounted. The ref
		// would have been initialized to the post-switch serverVersion so the
		// isServerSwitch check below would miss the change.
		const isFirstMount = isMountRef.current;
		isMountRef.current = false;

		// Only nuke caches on actual server switches (not URL/port updates)
		const isServerSwitch = prevServerVersionRef.current !== serverVersion;
		prevServerVersionRef.current = serverVersion;
		const didServerUrlChange = prevServerUrlRef.current !== activeServerUrl;
		prevServerUrlRef.current = activeServerUrl;

		// Only reset the SDK client on actual server switches — NOT on URL/port
		// updates. Resetting on every urlVersion change tears down the client
		// unnecessarily, causing SSE disconnection → reconnection → cache
		// invalidation cascade that manifests as random loading flashes.
		if (isFirstMount || isServerSwitch) {
			resetClient();
			clearConfigOverrides();
			clearStatuses({});
			clearPending();
			useSyncStore.getState().reset();
			useDiagnosticsStore.getState().clearAll();
			queryClient.removeQueries({ queryKey: opcodeKeys.all });
		} else if (didServerUrlChange) {
			// URL changed on the same logical server (e.g. sandbox/proxy refresh).
			// Recreate the SDK client so SSE reconnects to the new endpoint, but
			// keep caches/status intact to avoid loading flashes.
			resetClient();
		}

		// During initial cloud bootstrap, the active server URL may be unresolved
		// briefly (rehydration gap). Skip SSE setup until a URL exists.
		if (!activeServerUrl) return;

		const client = getClient();

		// ---- CONSOLIDATED hydration function ----
		// Single function for hydrating permissions, questions, and session statuses.
		// Called both on initial connect and on SSE reconnect (gap > 5s).
		// Previously this logic was duplicated in two places.
		const hydrateCore = (options?: { refetchSessions?: boolean; rehydrateMessages?: boolean }) => {
			client.permission
				.list()
				.then((res) => {
					if (Array.isArray(res.data)) res.data.forEach(addPermission);
				})
				.catch((err) => {
					logger.error("Failed to hydrate pending permissions", {
						error: String(err),
					});
				});

			client.question
				.list()
				.then((res) => {
					if (Array.isArray(res.data)) res.data.forEach(addQuestion);
				})
				.catch((err) => {
					logger.error("Failed to hydrate pending questions", {
						error: String(err),
					});
				});

			client.session
				.status()
				.then((res) => {
					if (res.data) {
						const statuses = res.data as Record<string, any>;
						for (const [sessionID, status] of Object.entries(statuses)) {
							applySyncEvent({
								type: "session.status",
								properties: { sessionID, status },
							} as any);
						}
						reconcileMissingBusySessions.current(statuses);
					} else {
						reconcileMissingBusySessions.current({});
					}
				})
				.catch((err) => {
					logger.error("Failed to hydrate session statuses", {
						error: String(err),
					});
				});

			// Fetch current LSP diagnostics so errors/warnings show immediately
			// on page load (or reconnect) without waiting for agent tool output.
			fetchLspDiagnosticsDebounced.current();

			if (options?.refetchSessions) {
				queryClient.refetchQueries({
					queryKey: opcodeKeys.sessions(),
					type: 'active',
				});
			}

			if (options?.rehydrateMessages) {
				const syncState = useSyncStore.getState();
				const loadedSessionIds = Object.keys(syncState.messages);
				for (const sid of loadedSessionIds) {
					client.session
						.messages({ sessionID: sid })
						.then((res) => {
							if (res.data)
								useSyncStore.getState().hydrate(sid, res.data as any);
						})
						.catch(() => {});
				}
			}
		};

		// Hydrate on initial connect — permissions, questions, and statuses
		hydrateCore();

		// Set up SSE via the SDK's AsyncGenerator
		const abortController = new AbortController();
		abortRef.current = abortController;

		// Track last stream activity (connect or event) to gate reconnect hydration.
		// Using only "last event" causes hydrate storms when the server rotates
		// idle SSE connections that carried no events.
		let lastStreamActivityTime = Date.now();
		// Track when the stream connected and whether it delivered any events.
		// We reset reconnect backoff only after a healthy connection (events received
		// or sustained >10s). Brief connect→drop loops keep backoff growth.
		let streamConnectedAt = 0;

		// Event coalescing queue (like the SolidJS reference)
		let queue: ({ type: string; event: OpenCodeEvent } | undefined)[] = [];
		let flushTimer: ReturnType<typeof setTimeout> | undefined;
		let lastFlush = 0;

		// Coalescing map — replaces earlier events of the same key
		const coalesced = new Map<string, number>();

		// Coalescing keys — determines which events can replace earlier ones
		// in the same 16ms flush batch.
		// NOTE: message.part.updated is intentionally NOT coalesced. While the
		// server sends full part state each time, coalescing can cause a stale
		// snapshot to be the sole survivor of a batch. When that stale snapshot
		// is processed before any deltas, it inserts the part with wrong/partial
		// text (prefix-growth guard can't help — nothing to compare against).
		// The upsertPart prefix-growth guard efficiently rejects stale snapshots
		// with a no-op return, so processing every snapshot has minimal cost.
		function getCoalesceKey(event: OpenCodeEvent): string | undefined {
			if (event.type === "session.status") {
				return `session.status:${(event.properties as any).sessionID}`;
			}
			if (event.type === "lsp.updated") return "lsp.updated";
			return undefined;
		}

		const flush = () => {
			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = undefined;
			if (queue.length === 0) return;

			const events = queue;
			queue = [];
			coalesced.clear();
			lastFlush = Date.now();
			lastStreamActivityTime = Date.now();

			for (const item of events) {
				if (!item) continue;
				handleEvent(item.event);
			}
		};

		const schedule = () => {
			if (flushTimer) return;
			const elapsed = Date.now() - lastFlush;
			flushTimer = setTimeout(flush, Math.max(0, 16 - elapsed));
		};

		// Consume the stream in the background with automatic retry
		(async () => {
			let retryCount = 0;
			while (!abortController.signal.aborted) {
				let streamHadEvents = false;
				let stableConnection = false;
				let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
				try {
					const result = await client.global.event({
						signal: abortController.signal,
						sseDefaultRetryDelay: 3000,
						sseMaxRetryDelay: 30000,
					} as any);
					const { stream } = result;
					streamConnectedAt = Date.now();
					lastStreamActivityTime = streamConnectedAt;

					// Heartbeat timeout — matching the reference. If no events
					// arrive for 15s, abort and reconnect. This is the ONLY
					// recovery mechanism we need — replaces the stall watchdog,
					// reconciler, and visibility handler.
					let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
					const HEARTBEAT_MS = 15_000;
					const heartbeatAbort = new AbortController();
					const resetHeartbeat = () => {
						clearTimeout(heartbeatTimer);
						heartbeatTimer = setTimeout(() => {
							logger.warn("SSE heartbeat timeout, forcing reconnect");
							heartbeatAbort.abort();
						}, HEARTBEAT_MS);
					};
					resetHeartbeat();

					// Consume stream: queue + coalesce + 16ms flush + yield every 8ms
					let yieldedAt = Date.now();
					for await (const event of stream) {
						if (abortController.signal.aborted || heartbeatAbort.signal.aborted) break;
						streamHadEvents = true;
						resetHeartbeat();
						const raw = event as any;
						const e = (
							raw && typeof raw === "object" && "payload" in raw
								? raw.payload
								: raw
						) as OpenCodeEvent;
						if (!e?.type) continue;

						const ck = getCoalesceKey(e);
						if (ck) {
							const existing = coalesced.get(ck);
							if (existing !== undefined) {
								queue[existing] = undefined;
							}
							coalesced.set(ck, queue.length);
						}
						queue.push({ type: (e as any).type, event: e });
						schedule();

						if (Date.now() - yieldedAt < 8) continue;
						yieldedAt = Date.now();
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
					}

					// Healthy stream if it delivered events, or if it stayed open for >10s.
					stableConnection =
						streamHadEvents || Date.now() - streamConnectedAt > 10_000;
				} catch (err) {
					if (abortController.signal.aborted) break;
					const errStr = String(err);
					const isAuthError =
						errStr.includes("401") ||
						errStr.includes("403") ||
						errStr.includes("Unauthorized") ||
						errStr.includes("Token refresh failed");
					logger.error("SSE event stream error", {
						error: errStr,
						retryCount,
						isAuthError,
					});

					// On auth errors, invalidate the token cache and fetch a fresh token.
					// This ensures all callers (SSE, health check, SDK) immediately use
					// the refreshed token instead of serving stale cached ones for 30s.
					if (isAuthError) {
						try {
							invalidateTokenCache();
							await getSupabaseAccessToken();
							logger.info("SSE: refreshed auth token after auth error");
						} catch (refreshErr) {
							logger.error("SSE: failed to refresh auth token", {
								error: String(refreshErr),
							});
						}
					}
				} finally {
					clearTimeout(heartbeatTimer);
					flush();
				}

			// Stream ended or errored — reconnect with exponential backoff.
			// ERR_INCOMPLETE_CHUNKED_ENCODING is normal when the server closes
			// the SSE connection between response cycles.
			// Minimum 1s delay even on first retry to avoid reconnection storms
			// when the server is flapping (connect → immediate disconnect loops).
			if (abortController.signal.aborted) break;

			// Re-hydrate messages for loaded sessions when the SSE gap was
			// significant (>5s). Events missed during the gap (e.g. streaming
			// assistant response) would never arrive, leaving the UI stale
			// until the user manually refreshes.
			const gap = Date.now() - lastStreamActivityTime;
			if (gap > 5_000) {
				hydrateCore({ rehydrateMessages: true });
			}

			if (stableConnection) {
				// Fast reconnect after healthy streams so live streaming resumes immediately.
				retryCount = 0;
			} else {
				retryCount++;
				if (retryCount > 1) {
					logger.warn("SSE event stream reconnecting", { retryCount });
				}
			}
			const delay = stableConnection
				? 250
				: Math.min(1000 * 2 ** Math.min(retryCount - 1, 5), 30000);
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, delay);
					const onAbort = () => {
						clearTimeout(timer);
						resolve();
					};
					abortController.signal.addEventListener("abort", onAbort, {
						once: true,
					});
				});
			}
		})();

		// Helper: look up a session title from the React Query cache for notifications
		function getSessionTitle(sessionID: string): string | undefined {
			const sessions = queryClient.getQueryData<any[]>(opencodeKeys.sessions());
			if (sessions) {
				const s = sessions.find((s: any) => s.id === sessionID);
				if (s?.title) return s.title;
			}
			const session = queryClient.getQueryData<any>(
				opencodeKeys.session(sessionID),
			);
			return session?.title || undefined;
		}

		function handleEvent(event: OpenCodeEvent) {
			// Sync store is the SINGLE source of truth for messages & parts.
			// This matches OpenCode's architecture where the SolidJS store is
			// the only place message/part data lives.
			applySyncEvent(event);

			switch (event.type) {
				// ---- Message events — handled by sync store only ----
				case "message.updated":
				case "message.removed":
					break;

				case "message.part.updated": {
					// Extract diagnostics from tool output and/or metadata
					const part = (event.properties as any).part as Part;
					const partState = (part as any)?.state;

					// --- Primary path: parse diagnostics from tool output text ---
					// The OpenCode backend embeds diagnostics as plain text inside
					// <file_diagnostics> / <project_diagnostics> XML tags in the
					// tool's text output (e.g. after write, edit, diagnostics tools).
					if (partState?.status === "completed" && partState.output) {
						const output = partState.output as string;
						if (output.includes("<file_diagnostics>") || output.includes("<project_diagnostics>")) {
							const parsed = parseDiagnosticsFromToolOutput(output);
							const fileCount = Object.keys(parsed).length;
							if (fileCount > 0) {
								// Normalize absolute sandbox paths to project-relative
								const normalized = normalizeDiagnosticPaths.current(parsed);
								// Convert LspDiagnostic[] to RawDiagnostic[] format for the store
								const asRaw: Record<string, any[]> = {};
								for (const [file, diags] of Object.entries(normalized)) {
									asRaw[file] = diags.map((d) => ({
										range: {
											start: { line: d.line, character: d.column },
										},
										severity: d.severity,
										message: d.message,
										source: d.source,
									}));
								}
								useDiagnosticsStore.getState().setFromLspEvent(asRaw);
							}
						}
					}

					// --- Fallback: check metadata.diagnostics (legacy / fork path) ---
					const partMeta = partState?.metadata;
					if (
						partMeta?.diagnostics &&
						typeof partMeta.diagnostics === "object"
					) {
						const diagsByFile = partMeta.diagnostics as Record<string, any[]>;
						const validEntries: Record<string, any[]> = {};
						let hasValid = false;
						for (const [file, diags] of Object.entries(diagsByFile)) {
							if (Array.isArray(diags) && diags.length > 0) {
								validEntries[file] = diags;
								hasValid = true;
							}
						}
						if (hasValid) {
							const normalized = normalizeDiagnosticPaths.current(validEntries);
							useDiagnosticsStore.getState().setFromLspEvent(normalized);
						}
					}
					break;
				}

				case "message.part.removed":
					break;

			// ---- Session lifecycle — surgical cache mutations (zero HTTP) ----
			//
			// IMPORTANT: Return the old array reference when nothing changed.
			// Creating new arrays on every SSE event causes cascading re-renders
			// in all session list consumers, which triggers a Radix UI compose-refs
			// infinite loop (Maximum update depth exceeded).
			case "session.created": {
				const info = (event.properties as any)?.info as Session | undefined;
				if (info) {
					queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
						if (!old) return [info];
						const exists = old.findIndex((s) => s.id === info.id);
						if (exists >= 0) {
							// Already exists — check if actually changed
							if (old[exists].time.updated === info.time.updated) return old;
							const next = [...old];
							next[exists] = info;
							return next.sort((a, b) => b.time.updated - a.time.updated);
						}
						return [info, ...old].sort((a, b) => b.time.updated - a.time.updated);
					});
					queryClient.setQueryData(opencodeKeys.session(info.id), info);
				}
				break;
			}

			case "session.updated": {
				const info = (event.properties as any)?.info as Session | undefined;
				if (info) {
					// Only update individual session cache (cheap, targeted)
					queryClient.setQueryData(opencodeKeys.session(info.id), info);
					// Update session list only if the session actually changed
					queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
						if (!old) return old;
						const idx = old.findIndex((s) => s.id === info.id);
						if (idx < 0) return old;
						// Shallow check: skip if the updated timestamp is identical
						if (old[idx].time.updated === info.time.updated) return old;
						const next = [...old];
						next[idx] = info;
						return next.sort((a, b) => b.time.updated - a.time.updated);
					});
				}
				break;
			}

			case "session.deleted": {
				const info = (event.properties as any)?.info as Session | undefined;
				if (info) {
					queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
						if (!old) return old;
						const found = old.some((s) => s.id === info.id);
						if (!found) return old; // Already gone — preserve reference
						return old.filter((s) => s.id !== info.id);
					});
					queryClient.removeQueries({ queryKey: opencodeKeys.session(info.id) });
					queryClient.removeQueries({ queryKey: opencodeKeys.messages(info.id) });
				}
				break;
			}

			case "session.compacted": {
				const sessionID = (event.properties as any).sessionID;
				if (sessionID) {
					stopCompaction(sessionID);
					// Full refetch after compaction since messages changed significantly.
					// Rehydrate the sync store (the single source of truth for messages).
					const client = getClient();
					client.session
						.messages({ sessionID })
						.then((res) => {
							if (res.data)
								useSyncStore.getState().hydrate(sessionID, res.data as any);
						})
						.catch(() => {});
					// Refetch the individual session to clear time.compacting
					// (targeted refetch, not full session list invalidation)
					client.session
						.get({ sessionID })
						.then((res) => {
							if (res.data) {
								const session = res.data as Session;
								queryClient.setQueryData(opencodeKeys.session(sessionID), session);
								// Also update in session list
								queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
									if (!old) return old;
									const idx = old.findIndex((s) => s.id === sessionID);
									if (idx < 0) return old;
									const next = [...old];
									next[idx] = session;
									return next;
								});
							}
						})
						.catch(() => {});
				}
				break;
			}

				// ---- Session status ----
				case "session.status": {
					const { sessionID, status } = event.properties as any;
					if (sessionID && status) {
						// Detect busy/retry → idle transition BEFORE updating the store
						// (coalescing can drop intermediate busy events, so we check here)
						const prevStatus =
							useOpenCodeSessionStatusStore.getState().statuses[sessionID];
						setStatus(sessionID, status);
						if (
							status.type === "idle" &&
							prevStatus &&
							prevStatus.type !== "idle"
						) {
							notifyTaskComplete(sessionID, getSessionTitle(sessionID));
						}
					}
					break;
				}

				case "session.idle": {
					const sessionID = (event.properties as any).sessionID;
					if (sessionID) {
						const prevStatus =
							useOpenCodeSessionStatusStore.getState().statuses[sessionID];
						setStatus(sessionID, { type: "idle" });
						if (prevStatus && prevStatus.type !== "idle") {
							notifyTaskComplete(sessionID, getSessionTitle(sessionID));
						}
					}
					break;
				}

				// ---- Session errors ----
			case "session.error": {
				const props = event.properties as { sessionID?: string; error?: any };
				console.log("[sse-handler] session.error event received", { sessionID: props.sessionID, error: props.error });
				if (props.sessionID && props.error) {
					stopCompaction(props.sessionID);
					// Fire browser notification
						const errorTitle =
							props.error?.name ||
							props.error?.data?.message ||
							"An error occurred";
						notifySessionError(
							props.sessionID,
							errorTitle,
							getSessionTitle(props.sessionID),
						);

						// Patch the error onto the last assistant message in cache.
						// This is critical because:
						// 1. session.error arrives BEFORE message.updated with .error
						// 2. Some error paths (model-not-found, agent-not-found) never
						//    emit message.updated with .error at all
						// 3. Polling can race and overwrite the error from message.updated
						const key = opencodeKeys.messages(props.sessionID);
						queryClient.cancelQueries({ queryKey: key });
						queryClient.setQueryData<MessageWithParts[]>(key, (old) => {
							if (!old || old.length === 0) return old;
							// Find the last assistant message and patch error onto it
							for (let i = old.length - 1; i >= 0; i--) {
								if (old[i].info.role === "assistant") {
									if ((old[i].info as any).error) return old; // already has error
									const updated = [...old];
									updated[i] = {
										...old[i],
										info: { ...old[i].info, error: props.error } as any,
									};
									return updated;
								}
							}
							return old;
						});

						// Fetch real messages from the server to bring in
						// authoritative data. In error paths the server may never
						// send message.updated for the user message, leaving the
						// optimistic duplicate. After hydrating server data,
						// clear any optimistic messages (now superseded by real
						// ones) to prevent double user bubbles.
						//
						// EXCEPTION: On abort, skip the fetch+hydrate — the server
						// may not have persisted the partial assistant response yet,
						// so hydrating would wipe the streamed content the user saw.
						// The error is already patched onto the message above.
						const isAbortError =
							props.error?.name === "AbortError" ||
							String(props.error?.data?.message || props.error?.message || "").toLowerCase().includes("abort");
						const sid = props.sessionID;
						if (!isAbortError) {
							client.session
								.messages({ sessionID: sid })
								.then((res) => {
									if (!res.data) return;
									useSyncStore.getState().hydrate(sid, res.data as any);
									useSyncStore.getState().clearOptimisticMessages(sid);
								})
								.catch(() => {});
						} else {
							// Still clear optimistic messages on abort — the real
							// user message should have arrived via SSE by now.
							useSyncStore.getState().clearOptimisticMessages(sid);
						}
					}
					break;
				}

				// ---- Permissions ----
				case "permission.asked": {
					const props = event.properties as any;
					if (props.id && props.sessionID) {
						addPermission(props);
						// Fire browser notification for permission requests
						const toolName = props.tool || props.type || "a tool";
						notifyPermissionRequest(
							props.sessionID,
							toolName,
							getSessionTitle(props.sessionID),
						);
					}
					break;
				}
				case "permission.replied": {
					const requestID = (event.properties as any).requestID;
					if (requestID) removePermission(requestID);
					break;
				}

				// ---- Questions ----
				case "question.asked": {
					const props = event.properties as any;
					if (props.id && props.sessionID) {
						addQuestion(props);
						// Fire browser notification for questions needing user input
						const questionText =
							props.questions?.[0]?.question ||
							props.questions?.[0]?.header ||
							"Kortix needs your input";
						notifyQuestion(
							props.sessionID,
							questionText,
							getSessionTitle(props.sessionID),
						);
					}
					break;
				}
				case "question.replied":
				case "question.rejected": {
					const requestID = (event.properties as any).requestID;
					if (requestID) removeQuestion(requestID);
					break;
				}

				// ---- Session diff ----
				case "session.diff": {
					const props = event.properties as { sessionID: string; diff: any[] };
					if (props.sessionID) {
						queryClient.setQueryData(
							["opencode", "session-diff", props.sessionID],
							props.diff,
						);
					}
					break;
				}

				// ---- Todo updated ----
				case "todo.updated": {
					const props = event.properties as { sessionID: string; todos: any[] };
					if (props.sessionID) {
						queryClient.setQueryData(
							["opencode", "session-todo", props.sessionID],
							props.todos,
						);
					}
					break;
				}

				// ---- VCS branch ----
				case "vcs.branch.updated": {
					const props = event.properties as { branch: string };
					queryClient.setQueryData(["opencode", "vcs"], {
						branch: props.branch,
					});
					break;
				}

			// ---- Server disposed ----
			case "server.instance.disposed": {
				for (const [sessionID, status] of Object.entries(
					useOpenCodeSessionStatusStore.getState().statuses,
				)) {
					if (status?.type !== "idle") {
						markSessionAbortedLocally.current(
							sessionID,
							"The operation was aborted because the server instance was disposed.",
						);
					}
				}
				// Instance dispose means the server rescanned skills, agents,
				// tools, and commands. Invalidate all cached app metadata so
				// the UI picks up newly installed marketplace components or
				// agent-created skills/agents immediately.
				queryClient.invalidateQueries({ queryKey: opcodeKeys.sessions(), type: 'active' });
				queryClient.invalidateQueries({ queryKey: opcodeKeys.mcpStatus(), type: 'active' });
				queryClient.invalidateQueries({ queryKey: opcodeKeys.skills(), type: 'active' });
				queryClient.invalidateQueries({ queryKey: opcodeKeys.agents(), type: 'active' });
				queryClient.invalidateQueries({ queryKey: opcodeKeys.toolIds(), type: 'active' });
				queryClient.invalidateQueries({ queryKey: opcodeKeys.commands(), type: 'active' });
				break;
			}

				// ---- LSP updated ----
				case "lsp.updated": {
					queryClient.invalidateQueries({ queryKey: ["opencode", "lsp"], type: 'active' });
					// A new LSP client connected — fetch diagnostics after a short
					// delay to give the language server time to produce initial results.
					fetchLspDiagnosticsDebounced.current();
					break;
				}

				// ---- LSP client diagnostics (per-file notification) ----
				case "lsp.client.diagnostics": {
					// This event signals diagnostics changed for a specific file.
					// The event only carries { serverID, path } — actual diagnostic
					// data must be fetched from the /lsp/diagnostics endpoint.
					fetchLspDiagnosticsDebounced.current();
					break;
				}

			// ---- MCP tools changed ----
			case "mcp.tools.changed": {
				// MCP server tools were added/removed/changed — refresh status + tool lists.
				// Only refetch if queries are actively mounted (type: 'active').
				queryClient.refetchQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
				queryClient.refetchQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
				break;
			}

				// ---- PTY events ----
				case "pty.created":
				case "pty.updated":
				case "pty.exited":
				case "pty.deleted": {
					queryClient.invalidateQueries({ queryKey: ptyKeys.listPrefix(), type: 'active' });
					break;
				}

				// ---- Worktree events — disabled for now ----
				case "worktree.ready": {
					queryClient.invalidateQueries({ queryKey: opencodeKeys.worktrees(), type: 'active' });
					queryClient.invalidateQueries({ queryKey: opencodeKeys.projects(), type: 'active' });
					break;
				}

				case "worktree.failed": {
					queryClient.invalidateQueries({ queryKey: opencodeKeys.worktrees(), type: 'active' });
					break;
				}

			// ---- Project updated ----
			case "project.updated": {
				// Targeted refetch — project data is small and changes rarely,
				// but we need the full response. Use refetchQueries to only
				// refetch if the query is currently mounted (no orphan requests).
				queryClient.refetchQueries({ queryKey: opencodeKeys.projects(), type: 'active' });
				queryClient.refetchQueries({ queryKey: opencodeKeys.currentProject(), type: 'active' });
				break;
			}

				// ---- File edited (outside agent, e.g. user edits in editor) ----
				case "file.edited": {
					const fileProps = event.properties as { file?: string };
					queryClient.invalidateQueries({ queryKey: fileListKeys.all, type: 'active' });
					queryClient.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
					if (fileProps.file) {
						queryClient.invalidateQueries({ queryKey: fileContentKeys.all, type: 'active' });
					}
					break;
				}

				// ---- Installation events ----
				case "installation.updated": {
					const installProps = event.properties as { version?: string };
					const versionStr = installProps.version
						? ` (v${installProps.version})`
						: "";
					toast.info(
						`Installation updated${versionStr}. Restart to apply changes.`,
						{
							duration: 10_000,
						},
					);
					break;
				}

				case "installation.update-available": {
					const updateProps = event.properties as { version?: string };
					const versionLabel = updateProps.version
						? `v${updateProps.version}`
						: "A new version";
					toast.info(
						`${versionLabel} is available. Update when you're ready.`,
						{
							duration: 15_000,
						},
					);
					break;
				}

				default:
					break;
			}
		}

		return () => {
			abortController.abort();
			abortRef.current = null;
			if (flushTimer) clearTimeout(flushTimer);
		};
		// NOTE: urlVersion is intentionally excluded from deps. We only reconnect
		// when the resolved activeServerUrl actually changes, which avoids
		// reconnecting on metadata-only updates while still recovering from
		// stale SSE connections after sandbox/proxy URL changes.
	}, [
		queryClient,
		setStatus,
		clearStatuses,
		addPermission,
		removePermission,
		addQuestion,
		removeQuestion,
		clearPending,
		serverVersion,
		activeServerUrl,
		applySyncEvent,
		stopCompaction,
	]);
}

// Use the correct key reference
const opcodeKeys = opencodeKeys;

/**
 * Headless provider component that connects the SSE event stream.
 * Renders nothing — just call useOpenCodeEventStream().
 *
 * Mount this once on any page that needs live session updates
 * (dashboard layout, onboarding page, etc.).
 */
export function OpenCodeEventStreamProvider() {
	useOpenCodeEventStream();
	return null;
}
