import { beforeEach, describe, expect, test } from "bun:test";

import {
	requestRuntimeReconnect,
	setOpenCodeHealth,
	setSandboxStatus,
	useSandboxConnectionStore,
} from "./sandbox-connection-store";

/**
 * `parked` is the one fact the connection store used to throw away.
 *
 * `use-runtime-reconnect` already distinguishes a PARKED box (the platform
 * answered the health probe from the session row — `hop === 'control_plane'`,
 * i.e. `503 sandbox not ready (status: stopped)`, nothing was ever dialled)
 * from a BOOTING one (the proxy reached the box and OpenCode is still coming
 * up). It passed that distinction to `setOpenCodeHealth` only to keep the
 * stall clock off, and then dropped it.
 *
 * Every other surface therefore had to guess, and the Files panel guessed
 * wrong: it treated the parked 503 as "waking", told the user "The sandbox is
 * starting. Files will appear automatically.", and re-issued the same refused
 * request every 3s forever. A parked box resumes only on the next SEND, so
 * nothing about that was true. Persisting the fact is what lets a surface say
 * "idle" instead of animating a wait that has no end.
 */
function resetStore() {
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
		bootingSinceAt: null,
		parked: false,
	});
}

describe("sandbox connection store: parked", () => {
	beforeEach(resetStore);

	test("defaults to not parked — nothing has claimed the box is asleep", () => {
		expect(useSandboxConnectionStore.getState().parked).toBe(false);
	});

	test("records a parked box so a surface can say 'idle' instead of 'waking'", () => {
		setOpenCodeHealth(false, "1.2.3", null, { parked: true });
		expect(useSandboxConnectionStore.getState().parked).toBe(true);
		expect(useSandboxConnectionStore.getState().healthy).toBe(false);
	});

	test("a BOOTING box is not parked — it really is coming up on its own", () => {
		setOpenCodeHealth(false, "1.2.3", "schema not ready");
		expect(useSandboxConnectionStore.getState().parked).toBe(false);
	});

	test("going healthy clears parked", () => {
		setOpenCodeHealth(false, "1.2.3", null, { parked: true });
		expect(useSandboxConnectionStore.getState().parked).toBe(true);
		setOpenCodeHealth(true, "1.2.3");
		expect(useSandboxConnectionStore.getState().parked).toBe(false);
	});

	test("a booting probe after a parked one clears parked", () => {
		setOpenCodeHealth(false, "1.2.3", null, { parked: true });
		setOpenCodeHealth(false, "1.2.3", "schema not ready");
		expect(useSandboxConnectionStore.getState().parked).toBe(false);
	});

	test("a manual retry clears parked — the user just asked for a fresh look", () => {
		setOpenCodeHealth(false, "1.2.3", null, { parked: true });
		requestRuntimeReconnect();
		expect(useSandboxConnectionStore.getState().parked).toBe(false);
	});

	test("parked leaves the stall clock off, exactly as before", () => {
		setOpenCodeHealth(false, "1.2.3", null, { parked: true });
		expect(useSandboxConnectionStore.getState().bootingSinceAt).toBeNull();
	});

	test("a booting box still arms the stall clock", () => {
		setOpenCodeHealth(false, "1.2.3", "schema not ready");
		expect(useSandboxConnectionStore.getState().bootingSinceAt).not.toBeNull();
	});

	test("status is untouched by parking — the row, not the socket, is what parked", () => {
		setSandboxStatus("connected");
		setOpenCodeHealth(false, "1.2.3", null, { parked: true });
		expect(useSandboxConnectionStore.getState().status).toBe("connected");
	});
});
