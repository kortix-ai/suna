"use client";

import { useEffect, useRef } from "react";
import { getAuthToken } from "@/lib/auth-token";
import { getSessionHealth, isRuntimeReady } from "@kortix/sdk/session";
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
// Tight cadence while a sandbox is booting/unhealthy. This is the gate between
// "sandbox active" and "OpenCode healthy" AND the enable-gate for the opencode
// session list — so every extra interval is visible dead time after the backend
// is already ready. 150ms keeps the healthy flip (and the session-list start)
// tracking actual daemon readiness tightly; the health probe is a cheap GET.
const POLL_FAILING = 150;
const POLL_UNREACHABLE = 5_000; // 5s when confirmed unreachable

const CHECK_TIMEOUT = 20_000;

function isImmediateOfflineStatus(status: number): boolean {
	return status === 502 || status === 503 || status === 504;
}

/**
 * useSandboxConnection — monitors the active server's reachability.
 *
 * Probes the SDK-owned `/kortix/health` endpoint (`getSessionHealth`) and maps
 * the result into the connection store. Behaviour:
 *   - On first failure, immediately switches to fast polling.
 *   - If the user was previously connected, the first failure moves to
 *     "connecting" and the second consecutive failure marks unreachable.
 *   - If it's the first connection, requires FAIL_THRESHOLD_FIRST failures.
 */
export function useSandboxConnection() {
	const activeServerId = useServerStore((s) => s.activeServerId);
	const serverVersion = useServerStore((s) => s.serverVersion);

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const isMountRef = useRef(true);
	const prevServerVersionRef = useRef(serverVersion);

	useEffect(() => {
		const isFirstMount = isMountRef.current;
		isMountRef.current = false;
		const isServerSwitch = serverVersion !== prevServerVersionRef.current;
		prevServerVersionRef.current = serverVersion;

		if (isFirstMount || isServerSwitch) {
			// Full reset — clears wasConnected, failCount, status, everything.
			// Each instance starts with a clean slate.
			resetForServerSwitch();
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

				const result = await getSessionHealth(url, { signal: controller.signal });
				clearTimeout(timer);

				if (!alive) return;

				if (result.status === 401 || result.status === 403) {
					// Treat auth errors like any other failure — respect the threshold
					// instead of immediately marking unreachable. During transitions
					// (e.g. provisioning → dashboard), the proxy may briefly return 401
					// before auth propagates.
					throw new Error(`Auth error: ${result.status}`);
				}

				if (result.status === 503) {
					const parsed = result.health;
					resetSandboxFail();
					setSandboxStatus("connected");
					setOpenCodeHealth(
						false,
						parsed?.version,
						parsed?.boot_error ?? parsed?.message ?? parsed?.reason ?? null,
					);
					if (parsed?.version) {
						setSandboxVersion(parsed.version);
					}
					return;
				}

				if (!result.ok) {
					const body = result.body;
					const offlineSignal =
						isImmediateOfflineStatus(result.status) ||
						/no service is responding|not reachable/i.test(body);
					const error = new Error(
						`Sandbox health check failed: ${result.status}${body ? ` ${body.slice(0, 120)}` : ""}`,
					) as Error & { immediateOffline?: boolean };
					error.immediateOffline = offlineSignal;
					throw error;
				}

				resetSandboxFail();
				setSandboxStatus("connected");
				const healthData = result.health;
				setOpenCodeHealth(
					isRuntimeReady(healthData),
					healthData?.version,
					healthData?.boot_error ?? healthData?.message ?? healthData?.reason ?? null,
				);
				if (healthData?.version) {
					setSandboxVersion(healthData.version);
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
				// Reschedule from finally so EVERY path re-arms the poll loop —
				// notably the 503 "OpenCode still booting" branch returns early; without
				// this it stops polling and `healthy` never flips, so useSessionSync and
				// the SSE (both gated on healthy) never subscribe and a fresh session's
				// first turn stays invisible until a manual reload.
				if (alive) {
					markInitialCheckDone();
					scheduleNext();
				}
			}
		}

		function scheduleNext() {
			if (!alive) return;
			if (timerRef.current) clearTimeout(timerRef.current);

			const { status, healthy } = useSandboxConnectionStore.getState();
			let delay: number;
			if (status === "connected" && healthy === false) {
				delay = POLL_FAILING;
			} else if (status === "connected") {
				delay = POLL_CONNECTED;
			} else if (status === "unreachable") {
				delay = POLL_UNREACHABLE;
			} else {
				// Initial "connecting" phase (sandbox just went active, opencode
				// still booting) — poll fast so the runtime appears the moment it's
				// healthy instead of waiting out a long interval.
				delay = POLL_FAILING;
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
