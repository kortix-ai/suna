import { create } from "zustand";
import { logger } from "../../core/http/logger";

export type SandboxConnectionStatus =
	| "connecting"
	| "connected"
	| "unreachable";

interface SandboxConnectionStore {
	status: SandboxConnectionStatus;
	/** How many consecutive health-check failures */
	failCount: number;
	/** True once at least one health check has completed (success or fail) */
	initialCheckDone: boolean;
	/** True if we were connected at some point and then lost connection */
	wasConnected: boolean;
	/** Total reconnect attempts since last successful connection */
	reconnectAttempts: number;
	/** Timestamp when status changed to unreachable/connecting (for "down since") */
	disconnectedAt: number | null;
	/** OpenCode server version from /global/health (e.g. "1.2.10") */
	openCodeVersion: string | null;
	/** Whether the OpenCode server reports healthy */
	healthy: boolean | null;
	/** Last runtime boot/readiness error reported by /kortix/health */
	runtimeError: string | null;
	manualRetryNonce: number;
	/**
	 * When the last live SSE event from the active runtime arrived. Proof of
	 * reachability that outranks a failed health probe: an event that just came
	 * over the wire cannot be stale, while a probe on a loaded box can time out
	 * even though the runtime is mid-turn and serving traffic. See
	 * `shouldIgnoreProbeFailure` in `react/use-runtime-reconnect`.
	 */
	lastRuntimeEvidenceAt: number | null;
	/**
	 * When the runtime last started waiting to become healthy — set the moment
	 * `healthy` isn't `true` and cleared the moment it is. Unlike
	 * `disconnectedAt` (which tracks `status`, and is CLEARED the instant a
	 * "booting" 503 classification calls `setSandboxStatus('connected')`), this
	 * survives an indefinite `connected`-but-not-`healthy` stretch — the case a
	 * wedged OpenCode boot produces: every probe gets a 503, which resets the
	 * failure counter each time, so `status` never crosses the unreachable
	 * threshold and `disconnectedAt` never even gets set. Without a clock that
	 * survives that shape, that case has no time bound at all. See
	 * `react/use-runtime-boot-stalled`.
	 */
	bootingSinceAt: number | null;
}

// ── Persist wasConnected across hard refreshes via sessionStorage ──
// On hard refresh, wasConnected resets to false which triggers a full-screen
// blocking overlay. By persisting it, users who were previously connected
// see the lightweight reconnect pill instead, making reconnection feel instant.
const STORAGE_KEY = "kortix-runtime-was-connected";
// Stronger than PROVISION_VERIFIED: POST /start already resolved stage='ready',
// which the backend only returns once it reached the daemon's /session (runtime
// proven healthy server-side). When this flag is set, the new instance starts
// optimistically connected+healthy so the chat shows WITHOUT waiting out an extra
// client-side /kortix/health round-trip. The poller still runs and self-corrects.
const RUNTIME_READY_VERIFIED_KEY = "kortix-runtime-ready";

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
	initialCheckDone: false,
	wasConnected: loadWasConnected(),
	reconnectAttempts: 0,
	disconnectedAt: null,
	openCodeVersion: null,
	healthy: null,
	runtimeError: null,
	manualRetryNonce: 0,
	lastRuntimeEvidenceAt: null,
	bootingSinceAt: null,
}));

export function requestRuntimeReconnect() {
	useSandboxConnectionStore.setState((state) => ({
		status: "connecting", healthy: null, failCount: 0, runtimeError: null,
		disconnectedAt: state.disconnectedAt ?? Date.now(), manualRetryNonce: state.manualRetryNonce + 1,
		// A manual retry is the user's own reset — give the stall clock a fresh
		// start too, instead of it re-firing on the very next tick.
		bootingSinceAt: Date.now(),
	}));
}

// ── Static actions (stable references, no re-render loops) ──

/** Only updates status if it actually changed. */
export function setSandboxStatus(next: SandboxConnectionStatus) {
	const state = useSandboxConnectionStore.getState();
	if (state.status === next) return;

	const updates: Partial<SandboxConnectionStore> = { status: next };

	if (next === "connected") {
		updates.failCount = 0;
		updates.wasConnected = true;
		updates.reconnectAttempts = 0;
		updates.disconnectedAt = null;
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
 * Exception: if POST /start already proved the runtime ready
 * (`markRuntimeReadyVerified`), we start connected+healthy so the chat
 * subscribes at the switch instead of after one more client health RTT.
 */
export function resetForServerSwitch() {
	const runtimeReady = loadRuntimeReadyVerified();
	clearRuntimeReadyVerified();

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
			openCodeVersion: null,
			healthy: true,
			runtimeError: null,
			manualRetryNonce: 0,
			lastRuntimeEvidenceAt: null,
			bootingSinceAt: null,
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
		openCodeVersion: null,
		healthy: null,
		runtimeError: null,
		manualRetryNonce: 0,
		lastRuntimeEvidenceAt: null,
		bootingSinceAt: Date.now(),
	});
	saveWasConnected(false);
}

/**
 * Record that a live SSE event from the active runtime just arrived. Cheap and
 * called per event, so it only writes when the timestamp actually moves the
 * freshness window (>= 1s granularity keeps store notifications rare).
 */
export function noteRuntimeEvidence(at: number = Date.now()) {
	const previous = useSandboxConnectionStore.getState().lastRuntimeEvidenceAt;
	if (previous !== null && at - previous < 1_000) return;
	useSandboxConnectionStore.setState({ lastRuntimeEvidenceAt: at });
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
	// Start (or keep) the stall clock while not healthy; clear it the instant
	// we are. A "booting" 503 classification resets `failCount` on every tick
	// (see `use-runtime-reconnect`'s `classifyProbeResult`), so it can repeat
	// forever without ever crossing the unreachable threshold — this clock is
	// the only thing that still bounds that case. See `bootingSinceAt`.
	if (healthy) {
		if (state.bootingSinceAt !== null) updates.bootingSinceAt = null;
	} else if (state.bootingSinceAt === null) {
		updates.bootingSinceAt = Date.now();
	}
	if (Object.keys(updates).length > 0) {
		useSandboxConnectionStore.setState(updates);
	}
}
