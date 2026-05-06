"use client";

import { useEffect, useRef } from "react";
import { authenticatedFetch, getAuthToken } from "@/lib/auth-token";
import {
	incrementSandboxFail,
	markInitialCheckDone,
	resetForServerSwitch,
	resetSandboxFail,
	setOpenCodeHealth,
	setSandboxStatus,
	setSandboxVersion,
	useSandboxConnectionStore,
} from "@/stores/sandbox-connection-store";
import { useServerStore } from "@/stores/server-store";

/**
 * Number of consecutive failures before marking as unreachable
 * when this is the FIRST connection (never been connected).
 * Set high enough to ride through transient proxy startup delays.
 */
const FAIL_THRESHOLD_FIRST = 5;

/**
 * For reconnection (was connected, then failed) — require two consecutive
 * failures before declaring the instance unreachable. The first miss drops
 * into a lightweight reconnecting state so transient timeouts don't kick the
 * user to an offline/error UI.
 */
const FAIL_THRESHOLD_RECONNECT = 2;

/** Interval between health checks (ms) */
const POLL_CONNECTED = 30_000; // 30s when healthy
const POLL_FAILING = 3_000; // 3s when any failure detected (fast retry)
const POLL_UNREACHABLE = 5_000; // 5s when confirmed unreachable

const CHECK_TIMEOUT = 20_000;

function isImmediateOfflineStatus(status: number): boolean {
	return status === 502 || status === 503 || status === 504;
}

/**
 * useSandboxConnection — monitors the active server's reachability.
 *
 * Key behaviour:
 *   - On first failure, immediately switches to fast polling (3s).
 *   - If the user was previously connected, the first failure moves to
 *     "connecting" and the second consecutive failure marks unreachable.
 *   - If it's the first connection, requires 3 failures (same as before).
 */
export function useSandboxConnection() {
	const activeServerId = useServerStore((s) => s.activeServerId);
	const serverVersion = useServerStore((s) => s.serverVersion);

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const isMountRef = useRef(true);
	const prevServerVersionRef = useRef(serverVersion);
	const portsFetchedRef = useRef(false);

	useEffect(() => {
		const isFirstMount = isMountRef.current;
		isMountRef.current = false;
		const isServerSwitch = serverVersion !== prevServerVersionRef.current;
		prevServerVersionRef.current = serverVersion;

		if (isFirstMount || isServerSwitch) {
			// Full reset — clears wasConnected, failCount, status, everything.
			// Each instance starts with a clean slate.
			resetForServerSwitch();
			portsFetchedRef.current = false;
		}

		let alive = true;

		async function check() {
			if (!alive) return;

			const url = useServerStore.getState().getActiveServerUrl();
			if (!url) {
				scheduleNext();
				return;
			}

			// Don't fire health checks until auth is ready — avoids naked requests
			// that return synthetic 401s and cause false "unreachable" status.
			const token = await getAuthToken();
			if (!token) {
				scheduleNext();
				return;
			}

			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			try {
				const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

				const res = await authenticatedFetch(`${url}/kortix/health`, {
					method: "GET",
					signal: controller.signal,
				}, { retryOnAuthError: false });
				clearTimeout(timer);

				if (!alive) return;

				if (res.status === 401) {
					// Treat 401 like any other failure — respect the threshold
					// instead of immediately marking unreachable. During transitions
					// (e.g. provisioning → dashboard), the proxy may briefly return 401
					// before auth propagates.
					throw new Error(`Auth error: ${res.status}`);
				}

				if (res.status === 403) {
					throw new Error(`Auth error: ${res.status}`);
				}

				if (res.status === 503) {
					const body = await res.text().catch(() => "");
					let parsed: any = null;
					try {
						parsed = body ? JSON.parse(body) : null;
					} catch {
						parsed = null;
					}
					resetSandboxFail();
					setSandboxStatus("connected");
					setOpenCodeHealth(false, parsed?.version);
					if (parsed?.version) {
						setSandboxVersion(parsed.version);
					}
					return;
				}

				if (!res.ok) {
					const body = await res.text().catch(() => "");
					const offlineSignal =
						isImmediateOfflineStatus(res.status) ||
						/no service is responding|not reachable/i.test(body);
					const error = new Error(
						`Sandbox health check failed: ${res.status}${body ? ` ${body.slice(0, 120)}` : ""}`,
					) as Error & { immediateOffline?: boolean };
					error.immediateOffline = offlineSignal;
					throw error;
				}

				resetSandboxFail();
				setSandboxStatus("connected");
				const healthData = await res.json().catch(() => null) as { status?: string; runtimeReady?: boolean; version?: string } | null;
				setOpenCodeHealth(
					healthData?.runtimeReady !== false && healthData?.status !== "starting",
					healthData?.version,
				);
				if (healthData?.version) {
					setSandboxVersion(healthData.version);
				}

				// Fetch port mappings once on first successful connection.
				if (!portsFetchedRef.current) {
					portsFetchedRef.current = true;
					try {
						const portsRes = await authenticatedFetch(`${url}/kortix/ports`, {
							signal: AbortSignal.timeout(8000),
						}, { retryOnAuthError: false });
						if (portsRes.ok) {
							const data = await portsRes.json();
							if (data.ports && Object.keys(data.ports).length > 0) {
								const activeId = useServerStore.getState().activeServerId;
								useServerStore.getState().updateServerSilent(activeId, {
									mappedPorts: data.ports,
									provider: "local_docker",
								});
							}
						}
					} catch {
						/* non-critical — proxy fallback still works */
					}
				}

			} catch (error) {
				if (!alive) return;
				if ((error as { immediateOffline?: boolean } | undefined)?.immediateOffline) {
					incrementSandboxFail();
					setSandboxStatus("unreachable");
				} else {
					incrementSandboxFail();

					const { failCount, wasConnected } =
						useSandboxConnectionStore.getState();
					const threshold = wasConnected
						? FAIL_THRESHOLD_RECONNECT
						: FAIL_THRESHOLD_FIRST;

					if (failCount >= threshold) {
						setSandboxStatus("unreachable");
					} else if (wasConnected) {
						setSandboxStatus("connecting");
					}
				}
			} finally {
				if (alive) {
					markInitialCheckDone();
				}
			}

			scheduleNext();
		}

		function scheduleNext() {
			if (!alive) return;
			if (timerRef.current) clearTimeout(timerRef.current);

			const { status, failCount, healthy } = useSandboxConnectionStore.getState();
			let delay: number;
			if (status === "connected" && healthy === false) {
				delay = POLL_FAILING;
			} else if (status === "connected") {
				delay = POLL_CONNECTED;
			} else if (status === "unreachable") {
				delay = POLL_UNREACHABLE;
			} else {
				delay = failCount > 0 ? POLL_FAILING : POLL_UNREACHABLE;
			}
			timerRef.current = setTimeout(check, delay);
		}

		check();

		return () => {
			alive = false;
			abortRef.current?.abort();
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [activeServerId, serverVersion]);
}
