import { create } from "zustand";
import { logger } from "@/lib/logger";

export type SandboxConnectionStatus =
	| "connecting"
	| "connected"
	| "unreachable";

export type SandboxRecoveryPhase =
	| "idle"
	| "restarting_workload"
	| "restarting_runtime"
	| "restarting_host";

interface SandboxConnectionStore {
	status: SandboxConnectionStatus;
	/** How many consecutive health-check failures */
	failCount: number;
	/** When the connection was last confirmed */
	lastConnectedAt: number | null;
	/** True once at least one health check has completed (success or fail) */
	initialCheckDone: boolean;
	/** True if we were connected at some point and then lost connection */
	wasConnected: boolean;
	/** Total reconnect attempts since last successful connection */
	reconnectAttempts: number;
	/** Timestamp when status changed to unreachable/connecting (for "down since") */
	disconnectedAt: number | null;
	/** Current sandbox version from /kortix/health (e.g. "0.5.1") */
	sandboxVersion: string | null;
	/** OpenCode server version from /global/health (e.g. "1.2.10") */
	openCodeVersion: string | null;
	/** Whether the OpenCode server reports healthy */
	healthy: boolean | null;
	/** Last runtime boot/readiness error reported by /kortix/health */
	runtimeError: string | null;
	recoveryPhase: SandboxRecoveryPhase;
	restartRequestedAt: number | null;
}

// ── Persist wasConnected across hard refreshes via sessionStorage ──
// On hard refresh, wasConnected resets to false which triggers a full-screen
// blocking overlay. By persisting it, users who were previously connected
// see the lightweight reconnect pill instead, making reconnection feel instant.
const STORAGE_KEY = "kortix-sandbox-was-connected";
const PROVISION_VERIFIED_KEY = "kortix-sandbox-provision-verified";
// Stronger than PROVISION_VERIFIED: POST /start already resolved stage='ready',
// which the backend only returns once it reached the daemon's /session (runtime
// proven healthy server-side). When this flag is set, the new instance starts
// optimistically connected+healthy so the chat shows WITHOUT waiting out an extra
// client-side /kortix/health round-trip. The poller still runs and self-corrects.
const RUNTIME_READY_VERIFIED_KEY = "kortix-sandbox-runtime-ready";

function loadWasConnected(): boolean {
	try {
		return sessionStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

function saveWasConnected(value: boolean) {
	try {
		if (value) {
			sessionStorage.setItem(STORAGE_KEY, "1");
		} else {
			sessionStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		/* SSR or storage unavailable */
	}
}

function loadProvisionVerified(): boolean {
	try {
		return sessionStorage.getItem(PROVISION_VERIFIED_KEY) === "1";
	} catch {
		return false;
	}
}

function clearProvisionVerified() {
	try {
		sessionStorage.removeItem(PROVISION_VERIFIED_KEY);
	} catch {
		/* SSR or storage unavailable */
	}
}

function loadRuntimeReadyVerified(): boolean {
	try {
		return sessionStorage.getItem(RUNTIME_READY_VERIFIED_KEY) === "1";
	} catch {
		return false;
	}
}

function clearRuntimeReadyVerified() {
	try {
		sessionStorage.removeItem(RUNTIME_READY_VERIFIED_KEY);
	} catch {
		/* SSR or storage unavailable */
	}
}

export const useSandboxConnectionStore = create<SandboxConnectionStore>(() => ({
	status: "connecting",
	failCount: 0,
	lastConnectedAt: null,
	initialCheckDone: false,
	wasConnected: loadWasConnected(),
	reconnectAttempts: 0,
	disconnectedAt: null,
	sandboxVersion: null,
	openCodeVersion: null,
	healthy: null,
	runtimeError: null,
	recoveryPhase: "idle",
	restartRequestedAt: null,
}));

// ── Static actions (stable references, no re-render loops) ──

/** Only updates status if it actually changed. */
export function setSandboxStatus(next: SandboxConnectionStatus) {
	const state = useSandboxConnectionStore.getState();
	if (state.status === next) return;

	const updates: Partial<SandboxConnectionStore> = { status: next };

	if (next === "connected") {
		updates.lastConnectedAt = Date.now();
		updates.failCount = 0;
		updates.wasConnected = true;
		updates.reconnectAttempts = 0;
		updates.disconnectedAt = null;
		updates.recoveryPhase = "idle";
		updates.restartRequestedAt = null;
		saveWasConnected(true);

		if (state.status === "unreachable") {
			logger.info("Sandbox connection restored", {
				previousStatus: state.status,
				reconnectAttempts: state.reconnectAttempts,
			});
		}
	} else if (next === "unreachable") {
		if (!state.disconnectedAt) {
			updates.disconnectedAt = Date.now();
		}
		logger.warn("Sandbox became unreachable", {
			failCount: state.failCount,
			reconnectAttempts: state.reconnectAttempts,
			wasConnected: state.wasConnected,
		});
	} else if (next === "connecting") {
		// Track when we first went down (don't overwrite if already set)
		if (!state.disconnectedAt) {
			updates.disconnectedAt = Date.now();
		}
	}

	useSandboxConnectionStore.setState(updates);
}

export function markInitialCheckDone() {
	if (useSandboxConnectionStore.getState().initialCheckDone) return; // no-op
	useSandboxConnectionStore.setState({ initialCheckDone: true });
}

export function incrementSandboxFail() {
	const state = useSandboxConnectionStore.getState();
	logger.warn("Sandbox health-check failed", {
		failCount: state.failCount + 1,
		reconnectAttempts: state.reconnectAttempts + 1,
	});
	useSandboxConnectionStore.setState((s) => ({
		failCount: s.failCount + 1,
		reconnectAttempts: s.reconnectAttempts + 1,
	}));
}

export function resetSandboxFail() {
	const { failCount } = useSandboxConnectionStore.getState();
	if (failCount === 0) return; // no-op — avoids unnecessary re-renders
	useSandboxConnectionStore.setState({ failCount: 0 });
}

/**
 * Full reset for server switches — clears ALL connection state so the new
 * instance starts fresh. Without this, `wasConnected` from a previous instance
 * leaks into the new one, causing wrong thresholds and stale UI.
 *
 * Exception: if the provisioning page just verified health and set the
 * PROVISION_VERIFIED_KEY flag, we start as "connected" with wasConnected=true
 * so the dashboard doesn't show a blocking overlay during the transition.
 */
export function resetForServerSwitch() {
	const runtimeReady = loadRuntimeReadyVerified();
	const fromProvisioning = loadProvisionVerified();
	clearRuntimeReadyVerified();
	clearProvisionVerified();

	if (runtimeReady) {
		// /start already resolved stage==='ready' (markRuntimeReadyVerified is set
		// ONLY then — page.tsx), which the backend returns only after it reached the
		// daemon and OpenCode answered: the runtime is PROVEN healthy server-side.
		// So seed healthy=true (optimistic) — NOT healthy=null. The SSE event stream
		// (use-opencode-events) AND message sync (use-session-sync) both gate on this
		// same `healthy` flag, so seeding null left the FE UNSUBSCRIBED until the
		// ~350ms client health poll flipped it green — by which point the server-side
		// first turn (KORTIX_INITIAL_PROMPT, delivered during boot) had accumulated
		// and bulk-rendered AT ONCE instead of streaming. healthy=true subscribes at
		// the switch, so part.updated events render token-by-token, and also reclaims
		// the redundant health RTT. The 350ms poller still runs and self-corrects to
		// healthy=false (reconnect pill) if the browser genuinely can't reach the box,
		// so this only narrows to the ready path where health was actually proven.
		useSandboxConnectionStore.setState({
			status: "connected",
			failCount: 0,
			initialCheckDone: true,
			wasConnected: true,
			reconnectAttempts: 0,
			disconnectedAt: null,
			sandboxVersion: null,
			openCodeVersion: null,
			healthy: true,
			runtimeError: null,
			recoveryPhase: "idle",
			restartRequestedAt: null,
		});
		saveWasConnected(true);
		return;
	}

	if (fromProvisioning) {
		// Provisioning already verified health — skip the blocking overlay.
		// The health poller will still run and correct the status if needed.
		useSandboxConnectionStore.setState({
			status: "connecting",
			failCount: 0,
			initialCheckDone: false,
			wasConnected: true, // lightweight reconnect pill instead of blocking overlay
			reconnectAttempts: 0,
			disconnectedAt: null,
			sandboxVersion: null,
			openCodeVersion: null,
			healthy: null,
			runtimeError: null,
			recoveryPhase: "idle",
			restartRequestedAt: null,
		});
		saveWasConnected(true);
		return;
	}

	useSandboxConnectionStore.setState({
		status: "connecting",
		failCount: 0,
		initialCheckDone: false,
		wasConnected: false,
		reconnectAttempts: 0,
		disconnectedAt: null,
		sandboxVersion: null,
		openCodeVersion: null,
		healthy: null,
		runtimeError: null,
		recoveryPhase: "idle",
		restartRequestedAt: null,
	});
	saveWasConnected(false);
}

/**
 * Called by the provisioning page right before redirecting to the dashboard.
 * Signals that the sandbox was already verified as healthy, so the dashboard
 * should NOT show a full-screen blocking overlay on first load.
 */
export function markProvisioningVerified() {
	try {
		sessionStorage.setItem(PROVISION_VERIFIED_KEY, "1");
	} catch {
		/* SSR or storage unavailable */
	}
}

/**
 * Called right before switching to a sandbox whose POST /start already returned
 * stage='ready' (runtime proven healthy server-side). The next server-switch
 * reset starts optimistically connected+healthy so the chat shows without an
 * extra client health RTT. Implies provisioning-verified.
 */
export function markRuntimeReadyVerified() {
	try {
		sessionStorage.setItem(RUNTIME_READY_VERIFIED_KEY, "1");
	} catch {
		/* SSR or storage unavailable */
	}
}

export function setSandboxVersion(version: string | null) {
	const current = useSandboxConnectionStore.getState().sandboxVersion;
	if (current === version) return;
	useSandboxConnectionStore.setState({ sandboxVersion: version });
}

export function setOpenCodeHealth(healthy: boolean, version?: string, runtimeError?: string | null) {
	const state = useSandboxConnectionStore.getState();
	const updates: Partial<SandboxConnectionStore> = {};
	if (state.healthy !== healthy) updates.healthy = healthy;
	if (version !== undefined && state.openCodeVersion !== version) updates.openCodeVersion = version;
	const nextRuntimeError = healthy ? null : runtimeError;
	if (runtimeError !== undefined && state.runtimeError !== nextRuntimeError) {
		updates.runtimeError = nextRuntimeError;
	} else if (healthy && state.runtimeError !== null) {
		updates.runtimeError = null;
	}
	if (Object.keys(updates).length > 0) {
		useSandboxConnectionStore.setState(updates);
	}
}
