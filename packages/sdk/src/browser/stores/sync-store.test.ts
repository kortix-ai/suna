import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { STREAM_CACHE_FLUSH_MS } from "./sync-store/stream-cache";
import type {
	AssistantMessage,
	Message,
	Part,
	SessionStatus,
	TextPart,
	UserMessage,
} from "@opencode-ai/sdk/v2/client";
import { getTurnError, groupMessagesIntoTurns } from "../../core/turns";
import { ascendingId, Binary, sameSessionStatus, useSyncStore } from "./sync-store";

// ============================================================================
// Fixtures — minimal-but-valid Message/Part objects matching the real SDK
// shapes (every required field populated) so tests exercise the same
// discriminated-union narrowing the store's own code relies on.
// ============================================================================

function userMessage(id: string, sessionID = "ses_1"): UserMessage {
	return {
		id,
		sessionID,
		role: "user",
		time: { created: 1 },
		agent: "build",
		model: { providerID: "anthropic", modelID: "claude" },
	};
}

function assistantMessage(id: string, sessionID = "ses_1"): AssistantMessage {
	return {
		id,
		sessionID,
		role: "assistant",
		time: { created: 1 },
		parentID: "msg_parent",
		modelID: "claude",
		providerID: "anthropic",
		mode: "build",
		agent: "build",
		path: { cwd: "/", root: "/" },
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	};
}

function textPart(id: string, messageID: string, text: string, sessionID = "ses_1"): TextPart {
	return { id, sessionID, messageID, type: "text", text };
}

// ============================================================================
// Store reset between tests — the module-level optimistic/bridge/delta
// tracking sets aren't exposed, but `reset()` clears the store's own state
// and (per its implementation) the optimistic/bridged id sets too.
// ============================================================================

beforeEach(() => {
	useSyncStore.getState().reset();
});

/**
 * When each session's status frame LANDED — `sessionStatusAt`.
 *
 * The store used to keep no arrival time, so freshness was stamped by whichever
 * component happened to observe the slot: a remount re-stamped a dead stream's
 * last idle frame as brand new (`Date.now()` in the observing effect), and the
 * reconnect status fill had no way to tell a frame the live stream just
 * delivered from one a stream that died a minute ago left behind. Both readers
 * now use this stamp.
 */
describe("sessionStatusAt", () => {
	test("a status write stamps its arrival; a same-value rewrite keeps the stamp", () => {
		const sid = "ses_stamp_1";
		const store = useSyncStore.getState();
		const before = Date.now();
		store.setStatus(sid, { type: "busy" } as SessionStatus);
		const first = useSyncStore.getState().sessionStatusAt[sid];
		expect(first).toBeGreaterThanOrEqual(before);

		// Same value, same origin: neither the object identity nor the stamp
		// may move — a dead stream's frame must not look fresher over time.
		store.setStatus(sid, { type: "busy" } as SessionStatus);
		expect(useSyncStore.getState().sessionStatusAt[sid]).toBe(first);
	});

	test("a value change re-stamps", async () => {
		const sid = "ses_stamp_2";
		const store = useSyncStore.getState();
		store.setStatus(sid, { type: "busy" } as SessionStatus);
		const first = useSyncStore.getState().sessionStatusAt[sid];
		await new Promise((resolve) => setTimeout(resolve, 5));
		store.setStatus(sid, { type: "idle" } as SessionStatus);
		expect(useSyncStore.getState().sessionStatusAt[sid]).toBeGreaterThan(first);
	});

	test("an origin flip over an unchanged value re-stamps — it is a new observation", async () => {
		const sid = "ses_stamp_3";
		const store = useSyncStore.getState();
		store.setStatus(sid, { type: "busy" } as SessionStatus, "local");
		const first = useSyncStore.getState().sessionStatusAt[sid];
		await new Promise((resolve) => setTimeout(resolve, 5));
		store.setStatus(sid, { type: "busy" } as SessionStatus, "wire");
		expect(useSyncStore.getState().sessionStatusAt[sid]).toBeGreaterThan(first);
	});

	test("clearSession stamps its fabricated idle", () => {
		const sid = "ses_stamp_4";
		const store = useSyncStore.getState();
		store.setStatus(sid, { type: "busy" } as SessionStatus);
		store.clearSession(sid);
		const state = useSyncStore.getState();
		expect(state.sessionStatus[sid]).toEqual({ type: "idle" } as SessionStatus);
		expect(state.sessionStatusOrigin[sid]).toBe("local");
		expect(state.sessionStatusAt[sid]).toBeGreaterThan(0);
	});
});

/**
 * Runtime-read evidence for `projectWorking` (prod, 2026-08-26): with the SSE
 * stream dead, a stale wire idle frame vetoed the server's open turn row and
 * the projection answered idle over a running session. The only remaining
 * observer is the liveness poll's tail read — and its hydrate proved the
 * runtime was still producing output without telling anyone. Stamping
 * `sessionActivityAt` when a RUNTIME read shows the transcript moved mid-turn
 * hands that proof to the projection's content-first rule.
 *
 * Guards, each load-bearing:
 *  - an initial fill (no prior transcript) is not movement — it is history;
 *  - a completed tail is a finished turn — its history must not paint busy
 *    when a backgrounded tab returns hours later;
 *  - a cache repaint is this tab's own disk, not the runtime speaking.
 */
describe("hydrate stamps runtime activity for a moved, still-open transcript", () => {
	function openAssistant(id: string, sessionID: string): AssistantMessage {
		return { ...assistantMessage(id, sessionID) };
	}
	function completedAssistant(id: string, sessionID: string): AssistantMessage {
		const message = assistantMessage(id, sessionID);
		return { ...message, time: { ...message.time, completed: 2 } };
	}

	test("a new incomplete assistant tail on a held transcript stamps activity", () => {
		const sid = "ses_act_moved";
		const store = useSyncStore.getState();
		store.hydrate(sid, [{ info: userMessage("msg_u1", sid), parts: [] }]);
		// The initial fill is history, not movement.
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeUndefined();

		store.hydrate(sid, [
			{ info: userMessage("msg_u1", sid), parts: [] },
			{
				info: openAssistant("msg_a1", sid),
				parts: [textPart("prt_a1", "msg_a1", "stream…", sid)],
			},
		]);
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeGreaterThan(0);
	});

	test("grown text on a known part is movement too", () => {
		const sid = "ses_act_grown";
		const store = useSyncStore.getState();
		store.hydrate(sid, [
			{ info: userMessage("msg_u1", sid), parts: [] },
			{
				info: openAssistant("msg_a1", sid),
				parts: [textPart("prt_a1", "msg_a1", "hel", sid)],
			},
		]);
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeUndefined();

		store.hydrate(sid, [
			{ info: userMessage("msg_u1", sid), parts: [] },
			{
				info: openAssistant("msg_a1", sid),
				parts: [textPart("prt_a1", "msg_a1", "hello world", sid)],
			},
		]);
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeGreaterThan(0);
	});

	test("an unchanged transcript never stamps", () => {
		const sid = "ses_act_same";
		const page = [
			{ info: userMessage("msg_u1", sid), parts: [] },
			{
				info: openAssistant("msg_a1", sid),
				parts: [textPart("prt_a1", "msg_a1", "same", sid)],
			},
		];
		const store = useSyncStore.getState();
		store.hydrate(sid, page);
		store.hydrate(sid, page);
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeUndefined();
	});

	test("a completed tail never stamps — finished history is not activity", () => {
		const sid = "ses_act_done";
		const store = useSyncStore.getState();
		store.hydrate(sid, [{ info: userMessage("msg_u1", sid), parts: [] }]);
		store.hydrate(sid, [
			{ info: userMessage("msg_u1", sid), parts: [] },
			{
				info: completedAssistant("msg_a1", sid),
				parts: [textPart("prt_a1", "msg_a1", "done answer", sid)],
			},
		]);
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeUndefined();
	});

	test("a cache-sourced repaint never stamps — disk is not the runtime", () => {
		const sid = "ses_act_cache";
		const store = useSyncStore.getState();
		store.hydrate(sid, [{ info: userMessage("msg_u1", sid), parts: [] }]);
		store.hydrate(
			sid,
			[
				{ info: userMessage("msg_u1", sid), parts: [] },
				{
					info: openAssistant("msg_a1", sid),
					parts: [textPart("prt_a1", "msg_a1", "from disk", sid)],
				},
			],
			{ source: "cache" },
		);
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeUndefined();
	});
});

describe("Binary.search", () => {
	test("finds an existing id and reports its index", () => {
		const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const result = Binary.search(items, "b", (i) => i.id);
		expect(result).toEqual({ found: true, index: 1 });
	});

	test("reports the correct sorted-insertion index for a missing id", () => {
		const items = [{ id: "a" }, { id: "c" }, { id: "e" }];
		expect(Binary.search(items, "b", (i) => i.id)).toEqual({ found: false, index: 1 });
		expect(Binary.search(items, "f", (i) => i.id)).toEqual({ found: false, index: 3 });
		expect(Binary.search(items, "0", (i) => i.id)).toEqual({ found: false, index: 0 });
	});

	test("empty array reports not-found at index 0", () => {
		expect(Binary.search([], "x", (i: { id: string }) => i.id)).toEqual({
			found: false,
			index: 0,
		});
	});
});

describe("ascendingId", () => {
	test("prefixes ids with the given prefix", () => {
		expect(ascendingId("msg")).toMatch(/^msg_/);
		expect(ascendingId("prt")).toMatch(/^prt_/);
		expect(ascendingId()).toMatch(/^msg_/); // defaults to 'msg'
	});

	test("generates ids that sort in creation order across distinct timestamps", async () => {
		// The encoded timestamp+counter is hex-truncated to 12 chars, so
		// strict lexicographic order across a tight synchronous loop (many
		// ids sharing one `Date.now()` millisecond) isn't guaranteed — only
		// across calls separated in real time, which is the actual use case
		// (message/part ids created as events arrive, not batch-generated).
		const ids: string[] = [];
		for (let i = 0; i < 8; i++) {
			ids.push(ascendingId("msg"));
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		expect(ids).toEqual(sorted);
	});

	test("never repeats an id even when called synchronously in a tight loop", () => {
		const ids = new Set(Array.from({ length: 200 }, () => ascendingId("prt")));
		expect(ids.size).toBe(200);
	});
});

describe("useSyncStore — upsertMessage (ascending-id-ordered inserts)", () => {
	// Was "sorted by id, not by call order". The transcript is ordered by
	// `time.created` — the key the server itself pages by — because ids
	// stopped ascending with time in OpenCode 1.18.15. An id-sorted insert
	// dropped a brand-new SSE message into the middle of the transcript.
	test("inserts messages by time.created, not by call order and not by id", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", { ...userMessage("msg_b"), time: { created: 20 } });
		store.upsertMessage("ses_1", { ...userMessage("msg_c"), time: { created: 10 } });
		store.upsertMessage("ses_1", { ...userMessage("msg_a"), time: { created: 30 } });

		const ids = useSyncStore.getState().messages.ses_1.map((m) => m.id);
		expect(ids).toEqual(["msg_c", "msg_b", "msg_a"]);
	});

	test("updates an existing message in place instead of duplicating it", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_a"));
		const updated = { ...userMessage("msg_a"), agent: "plan" };
		store.upsertMessage("ses_1", updated);

		const msgs = useSyncStore.getState().messages.ses_1;
		expect(msgs).toHaveLength(1);
		expect((msgs[0] as UserMessage).agent).toBe("plan");
	});

	test("removeMessage drops the message and its parts", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_a"));
		store.upsertPart("msg_a", textPart("prt_1", "msg_a", "hello"));
		store.removeMessage("ses_1", "msg_a");

		expect(useSyncStore.getState().messages.ses_1).toEqual([]);
		expect(useSyncStore.getState().parts.msg_a).toBeUndefined();
	});
});

describe("useSyncStore — upsertPart / removePart (append + update)", () => {
	test("appends a new part in sorted position", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_b", "msg_1", "second"));
		store.upsertPart("msg_1", textPart("prt_a", "msg_1", "first"));

		const ids = useSyncStore.getState().parts.msg_1.map((p) => p.id);
		expect(ids).toEqual(["prt_a", "prt_b"]);
	});

	test("updates an existing part (monotonic prefix growth) in place", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "Hel"));
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "Hello"));

		const parts = useSyncStore.getState().parts.msg_1;
		expect(parts).toHaveLength(1);
		expect((parts[0] as TextPart).text).toBe("Hello");
	});

	test("rejects a non-prefix-growth text snapshot (stale/out-of-order update)", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "Hello world"));
		// A shorter, non-prefix snapshot arriving after — e.g. a stale
		// message.part.updated racing behind streamed deltas — must be dropped.
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "Hel"));

		const parts = useSyncStore.getState().parts.msg_1;
		expect((parts[0] as TextPart).text).toBe("Hello world");
	});

	test("accepts a prefix-growth update that extends the existing text", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "Hello"));
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "Hello world"));

		expect((useSyncStore.getState().parts.msg_1[0] as TextPart).text).toBe("Hello world");
	});

	test("removePart deletes a single part and cleans up an empty parts bucket", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "only part"));
		store.removePart("msg_1", "prt_1");

		expect(useSyncStore.getState().parts.msg_1).toBeUndefined();
	});

	test("applyPartDelta appends text incrementally onto an existing part", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "Hel"));
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", "lo");
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", " world");

		expect((useSyncStore.getState().parts.msg_1[0] as TextPart).text).toBe("Hello world");
	});
});

describe("useSyncStore — getMessages selector", () => {
	test("joins messages with their parts", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_a"));
		store.upsertPart("msg_a", textPart("prt_1", "msg_a", "hi"));

		const joined = useSyncStore.getState().getMessages("ses_1");
		expect(joined).toHaveLength(1);
		expect(joined[0].info.id).toBe("msg_a");
		expect(joined[0].parts).toHaveLength(1);
	});

	test("returns an empty array for a session with no messages", () => {
		expect(useSyncStore.getState().getMessages("nope")).toEqual([]);
	});
});

describe("useSyncStore — applyEvent(session.error) patches the last assistant message", () => {
	test("patches .error onto the last assistant message", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_a"));
		store.upsertMessage("ses_1", assistantMessage("msg_b"));

		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: { sessionID: "ses_1", error: { name: "UnknownError", data: { message: "boom" } } },
		} as never);

		const msgs = useSyncStore.getState().messages.ses_1;
		const assistant = msgs.find((m) => m.role === "assistant") as AssistantMessage;
		expect(assistant.error).toEqual({ name: "UnknownError", data: { message: "boom" } });
		// Errors terminate the response — status flips to idle.
		expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: "idle" });
	});

	test("creates a stub assistant message when none exists yet", () => {
		const store = useSyncStore.getState();
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: { sessionID: "ses_2", error: { name: "UnknownError", data: { message: "boom" } } },
		} as never);

		const msgs = useSyncStore.getState().messages.ses_2;
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe("assistant");
		expect((msgs[0] as AssistantMessage).error).toEqual({
			name: "UnknownError",
			data: { message: "boom" },
		});
	});

	test("does not overwrite an already-errored assistant message", () => {
		const store = useSyncStore.getState();
		const errored: AssistantMessage = {
			...assistantMessage("msg_b"),
			error: { name: "UnknownError", data: { message: "first" } } as never,
		};
		store.upsertMessage("ses_1", errored);

		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: { sessionID: "ses_1", error: { name: "UnknownError", data: { message: "second" } } },
		} as never);

		const assistant = useSyncStore.getState().messages.ses_1[0] as AssistantMessage;
		expect((assistant.error as { data: { message: string } }).data.message).toBe("first");
	});

	// T2: `data.reason` (the machine-readable abort WHY stamped by
	// `applyOptimisticAbort`/`markSessionAbortedLocally`, see
	// `core/http/abort-error.ts`) rides through `applyEvent` untouched — the
	// handler copies the whole `error` object it is given, it never
	// constructs one field-by-field, so any reason a producer sets survives.
	test("passes an abort error's data.reason through untouched", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_3", assistantMessage("msg_c"));

		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_3",
				error: {
					name: "AbortError",
					data: { message: "The operation was aborted because the runtime shut down.", reason: "runtime-disposed" },
				},
			},
		} as never);

		const assistant = useSyncStore.getState().messages.ses_3[0] as AssistantMessage;
		expect((assistant.error as { data: { reason?: string } }).data.reason).toBe("runtime-disposed");
	});

	test("passes an untagged (wire) abort error through with no reason", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_4", assistantMessage("msg_d"));

		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_4",
				error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } },
			},
		} as never);

		const assistant = useSyncStore.getState().messages.ses_4[0] as AssistantMessage;
		expect((assistant.error as { data: { reason?: string } }).data.reason).toBeUndefined();
	});

	// A RETRYABLE provider error is not the end of a turn. OpenCode stamps
	// `data.isRetryable === true` and keeps writing the SAME assistant message;
	// apps/api reaches the same conclusion from the same event
	// (`isTerminalTurnEnd`, sandbox-deadline-policy.ts:295). Flipping the status
	// to idle here handed `endedByRuntime` an unbounded veto over the still-open
	// ledger row, which is what removed the Stop button mid-turn (S7).
	test("a retryable error does NOT flip the session to idle", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_retry", userMessage("msg_a"));
		store.upsertMessage("ses_retry", assistantMessage("msg_b"));
		store.setStatus("ses_retry", { type: "busy" } as never, "wire");

		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_retry",
				error: { name: "APIError", data: { message: "429", isRetryable: true } },
			},
		} as never);

		// The status slot is untouched — the turn is still open.
		expect(useSyncStore.getState().sessionStatus.ses_retry).toEqual({ type: "busy" });
		// The error is still attached, so the UI can show the retry.
		const assistant = useSyncStore
			.getState()
			.messages.ses_retry.find((m) => m.role === "assistant") as AssistantMessage;
		expect((assistant.error as { data: { isRetryable: boolean } }).data.isRetryable).toBe(true);
	});

	test("a NON-retryable error still flips the session to idle", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_term", userMessage("msg_a"));
		store.upsertMessage("ses_term", assistantMessage("msg_b"));
		store.setStatus("ses_term", { type: "busy" } as never, "wire");

		store.applyEvent({
			id: "evt_2",
			type: "session.error",
			properties: {
				sessionID: "ses_term",
				error: { name: "ProviderAuthError", data: { message: "bad key" } },
			},
		} as never);

		expect(useSyncStore.getState().sessionStatus.ses_term).toEqual({ type: "idle" });
	});
});

// T16 — the `session.error` stub's own creation comment claims
// "hydrate can replace it"; nothing previously did. `ascendingId('msg')`
// sorts BELOW every server id, so a stub left in place after a real
// assistant message lands sits at the wrong position beside it forever.
describe("useSyncStore — session.error stub reconciliation on hydrate", () => {
	test("hydrate drops the stub once the server transcript contains a real assistant message", () => {
		const store = useSyncStore.getState();
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: { sessionID: "ses_1", error: { name: "UnknownError", data: { message: "boom" } } },
		} as never);

		const stubId = useSyncStore.getState().messages.ses_1[0].id;
		expect(useSyncStore.getState().messages.ses_1).toHaveLength(1);

		// The server's own transcript now contains a real assistant message.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_user"), parts: [] },
			{ info: assistantMessage("msg_real_asst"), parts: [] },
		]);

		const ids = useSyncStore.getState().messages.ses_1.map((m) => m.id);
		expect(ids).not.toContain(stubId);
		expect(ids).toContain("msg_real_asst");
	});

	test("a hydrate snapshot with no assistant message yet leaves the stub untouched", () => {
		const store = useSyncStore.getState();
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: { sessionID: "ses_1", error: { name: "UnknownError", data: { message: "boom" } } },
		} as never);
		const stubId = useSyncStore.getState().messages.ses_1[0].id;

		// Nothing has arrived yet to reconcile against.
		store.hydrate("ses_1", [{ info: userMessage("msg_user"), parts: [] }]);

		const ids = useSyncStore.getState().messages.ses_1.map((m) => m.id);
		expect(ids).toContain(stubId);
	});

	test("a stub in an UNRELATED session is untouched by another session's hydrate", () => {
		const store = useSyncStore.getState();
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: { sessionID: "ses_1", error: { name: "UnknownError", data: { message: "boom" } } },
		} as never);
		const stubId = useSyncStore.getState().messages.ses_1[0].id;

		store.hydrate("ses_2", [
			{ info: userMessage("msg_user", "ses_2"), parts: [] },
			{ info: assistantMessage("msg_real_asst", "ses_2"), parts: [] },
		]);

		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toContain(stubId);
	});
});

// ============================================================================
// A turn that fails BEFORE any assistant message exists (2026-08-19 prod
// report: `ModelNotFound: kortix/grok-4.6`, `session.error` ~2ms after the
// user message). The error belongs to THAT turn — the user message it
// answers — and nowhere else. Three failures were reported, and all three are
// one question the old handler could not answer: WHICH turn failed?
//
//  1. Nothing rendered at all. The session already held an earlier turn, so
//     the handler patched `.error` onto that turn's assistant message, far up
//     the transcript — and the `reconcileTail` hydrate that follows every
//     `session.error` overwrote that message with the server's own copy,
//     which carries no error. The failure left no trace.
//  2. The error rendered under the NEXT prompt instead of its own.
//  3. A later, successful answer kept the stale error pinned below it.
// ============================================================================

describe("useSyncStore — session.error attaches to the turn that failed", () => {
	test("does not patch a PREVIOUS turn's assistant message", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_0000000000010000000000"));
		store.upsertMessage("ses_1", {
			...assistantMessage("msg_0000000000020000000000"),
			parentID: "msg_0000000000010000000000",
		});
		// The prompt that fails. No assistant message for it exists yet.
		store.upsertMessage("ses_1", userMessage("msg_0000000000030000000000"));

		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "ModelNotFound: kortix/grok-4.6" } },
			},
		} as never);

		const msgs = useSyncStore.getState().messages.ses_1;
		const previous = msgs.find(
			(m) => m.id === "msg_0000000000020000000000",
		) as AssistantMessage;
		expect(previous.error).toBeUndefined();

		// The error rides an assistant message parented to the FAILING prompt,
		// positioned directly after it.
		const idx = msgs.findIndex((m) => m.id === "msg_0000000000030000000000");
		const stub = msgs[idx + 1] as AssistantMessage;
		expect(stub.role).toBe("assistant");
		expect(stub.parentID).toBe("msg_0000000000030000000000");
		expect((stub.error as { data: { message: string } }).data.message).toBe(
			"ModelNotFound: kortix/grok-4.6",
		);
		expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: "idle" });
	});

	test("renders inside the failing turn, and stays there when a later turn arrives", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_0000000000010000000000"));
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "boom" } },
			},
		} as never);

		// A later, SUCCESSFUL turn.
		store.upsertMessage("ses_1", userMessage("msg_0000000000030000000000"));
		store.upsertMessage("ses_1", {
			...assistantMessage("msg_0000000000040000000000"),
			parentID: "msg_0000000000030000000000",
		});

		const turns = groupMessagesIntoTurns(useSyncStore.getState().getMessages("ses_1"));
		expect(turns).toHaveLength(2);
		expect(getTurnError(turns[0])).toBe("boom");
		// The later turn is clean — nothing is pinned to the bottom of the thread.
		expect(getTurnError(turns[1])).toBeUndefined();
	});

	test("still patches an assistant message that already started THIS turn", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_0000000000010000000000"));
		store.upsertMessage("ses_1", {
			...assistantMessage("msg_0000000000020000000000"),
			parentID: "msg_0000000000010000000000",
		});

		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "mid-turn failure" } },
			},
		} as never);

		const msgs = useSyncStore.getState().messages.ses_1;
		expect(msgs).toHaveLength(2);
		expect(
			(msgs[1] as AssistantMessage).error as { data: { message: string } },
		).toEqual({ data: { message: "mid-turn failure" }, name: "UnknownError" } as never);
	});

	test("hydrate KEEPS the error when the server transcript has no reply for that turn", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_0000000000010000000000"));
		store.upsertMessage("ses_1", {
			...assistantMessage("msg_0000000000020000000000"),
			parentID: "msg_0000000000010000000000",
		});
		store.upsertMessage("ses_1", userMessage("msg_0000000000030000000000"));
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "boom" } },
			},
		} as never);

		// `reconcileTail('session-error')` — the server holds the earlier turn's
		// assistant message, and NOTHING for the failing turn. The old
		// session-wide rule read that as "a real assistant message landed" and
		// dropped the only record of the failure.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_0000000000010000000000"), parts: [] },
			{
				info: {
					...assistantMessage("msg_0000000000020000000000"),
					parentID: "msg_0000000000010000000000",
				},
				parts: [],
			},
			{ info: userMessage("msg_0000000000030000000000"), parts: [] },
		]);

		const turns = groupMessagesIntoTurns(useSyncStore.getState().getMessages("ses_1"));
		expect(turns).toHaveLength(2);
		expect(getTurnError(turns[1])).toBe("boom");
	});

	test("hydrate DROPS the error once the server holds a real reply for that turn", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_0000000000010000000000"));
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "boom" } },
			},
		} as never);

		store.hydrate("ses_1", [
			{ info: userMessage("msg_0000000000010000000000"), parts: [] },
			{
				info: {
					...assistantMessage("msg_0000000000020000000000"),
					parentID: "msg_0000000000010000000000",
				},
				parts: [],
			},
		]);

		const ids = useSyncStore.getState().messages.ses_1.map((m) => m.id);
		expect(ids).toEqual(["msg_0000000000010000000000", "msg_0000000000020000000000"]);
	});

	test("hydrate moves the error onto the server's own reply for that turn", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_0000000000010000000000"));
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "boom" } },
			},
		} as never);

		// The server DID persist an assistant message for the failed turn, but
		// its copy carries no error (opencode records the failure on the
		// session, not always on the message). Dropping the stub against it
		// would erase the only evidence the turn failed.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_0000000000010000000000"), parts: [] },
			{
				info: {
					...assistantMessage("msg_0000000000020000000000"),
					parentID: "msg_0000000000010000000000",
				},
				parts: [],
			},
		]);

		const msgs = useSyncStore.getState().messages.ses_1;
		expect(msgs.map((m) => m.id)).toEqual([
			"msg_0000000000010000000000",
			"msg_0000000000020000000000",
		]);
		const turns = groupMessagesIntoTurns(useSyncStore.getState().getMessages("ses_1"));
		expect(getTurnError(turns[0])).toBe("boom");
	});

	test("hydrate leaves the server's OWN error on that reply alone", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_0000000000010000000000"));
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "client copy" } },
			},
		} as never);

		store.hydrate("ses_1", [
			{ info: userMessage("msg_0000000000010000000000"), parts: [] },
			{
				info: {
					...assistantMessage("msg_0000000000020000000000"),
					parentID: "msg_0000000000010000000000",
					error: { name: "UnknownError", data: { message: "server copy" } },
				} as never,
				parts: [],
			},
		]);

		const turns = groupMessagesIntoTurns(useSyncStore.getState().getMessages("ses_1"));
		expect(getTurnError(turns[0])).toBe("server copy");
	});

	// The stub is part of `messages[sessionID]`, so the transcript cache mirrors
	// it to IndexedDB and the first paint after a reload brings it back. Its
	// tracking map does not survive the reload, so `hydrate` re-adopts it —
	// otherwise a restored stub could never be reconciled again.
	test("re-adopts a stub restored from the disk transcript cache", () => {
		const store = useSyncStore.getState();
		const stub = {
			...assistantMessage("msg_0000000000010000000000_error"),
			parentID: "msg_0000000000010000000000",
			error: { name: "UnknownError", data: { message: "boom" } },
		} as never as Message;

		// First paint, straight out of the cache.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_0000000000010000000000"), parts: [] },
			{ info: stub, parts: [] },
		]);
		expect(
			getTurnError(groupMessagesIntoTurns(useSyncStore.getState().getMessages("ses_1"))[0]),
		).toBe("boom");

		// The runtime reconcile behind it: the server now holds a real reply.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_0000000000010000000000"), parts: [] },
			{
				info: {
					...assistantMessage("msg_0000000000020000000000"),
					parentID: "msg_0000000000010000000000",
				},
				parts: [],
			},
		]);

		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_0000000000010000000000",
			"msg_0000000000020000000000",
		]);
	});

	test("follows its user message when a message.updated echo retires the optimistic one", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_optimistic00000000000"), [
			textPart("prt_1", "msg_optimistic00000000000", "hi"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_optimistic00000000000");
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "boom" } },
			},
		} as never);

		// The server's own copy of that prompt, over SSE this time.
		store.applyEvent({
			id: "evt_2",
			type: "message.updated",
			properties: { info: userMessage("msg_0000000000090000000000") },
		} as never);

		const msgs = useSyncStore.getState().messages.ses_1;
		expect(msgs.map((m) => m.id)).not.toContain("msg_optimistic00000000000");
		const stub = msgs.find((m) => m.role === "assistant") as AssistantMessage;
		expect(stub.parentID).toBe("msg_0000000000090000000000");
		const turns = groupMessagesIntoTurns(useSyncStore.getState().getMessages("ses_1"));
		expect(turns).toHaveLength(1);
		expect(getTurnError(turns[0])).toBe("boom");
	});

	test("follows its user message when the server echo supersedes the optimistic one", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_optimistic00000000000"), [
			textPart("prt_1", "msg_optimistic00000000000", "hi"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_optimistic00000000000");
		store.applyEvent({
			id: "evt_1",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "boom" } },
			},
		} as never);

		// The server's own copy of that prompt, correlated by part id.
		store.hydrate("ses_1", [
			{
				info: userMessage("msg_0000000000090000000000"),
				parts: [textPart("prt_1", "msg_0000000000090000000000", "hi")],
			},
		]);

		const msgs = useSyncStore.getState().messages.ses_1;
		expect(msgs.map((m) => m.id)).not.toContain("msg_optimistic00000000000");
		const stub = msgs.find((m) => m.role === "assistant") as AssistantMessage;
		expect(stub.parentID).toBe("msg_0000000000090000000000");
		const turns = groupMessagesIntoTurns(useSyncStore.getState().getMessages("ses_1"));
		expect(turns).toHaveLength(1);
		expect(getTurnError(turns[0])).toBe("boom");
	});
});

describe("useSyncStore — applyEvent(message.part.delta) creates a stub part + message", () => {
	test("auto-creates the assistant message + part so a delta before message.part.updated still renders", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_user"));

		store.applyEvent({
			id: "evt_1",
			type: "message.part.delta",
			properties: {
				messageID: "msg_asst",
				partID: "prt_1",
				sessionID: "ses_1",
				field: "text",
				delta: "Hello",
			},
		} as never);

		const msgs = useSyncStore.getState().messages.ses_1;
		expect(msgs.some((m) => m.id === "msg_asst" && m.role === "assistant")).toBe(true);
		expect((useSyncStore.getState().parts.msg_asst[0] as TextPart).text).toBe("Hello");
	});

	test("does not create a stub assistant message before any user message exists", () => {
		const store = useSyncStore.getState();
		store.applyEvent({
			id: "evt_1",
			type: "message.part.delta",
			properties: {
				messageID: "msg_asst",
				partID: "prt_1",
				sessionID: "ses_1",
				field: "text",
				delta: "Hello",
			},
		} as never);

		expect(useSyncStore.getState().messages.ses_1 ?? []).toEqual([]);
		// The part is still tracked as an orphan, ready to be picked up once
		// hydrate()/message.part.updated creates the real message.
		expect((useSyncStore.getState().parts.msg_asst[0] as TextPart).text).toBe("Hello");
	});
});

// T14 — `applyPartDelta` used to be `existing + delta` with no
// identity consulted anywhere in the pipeline, so a duplicate delivery of
// the SAME `message.part.delta` doubled the streamed text. `eventID` is the
// wire's own `EventMessagePartDelta.id` (a top-level field, not inside
// `properties`), threaded through from `applyEvent`.
describe("useSyncStore — applyPartDelta idempotency (part-delta duplicate delivery)", () => {
	test("a duplicate single delta (same eventID) is a no-op", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "Hel"));
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", "lo", "evt_1");
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", "lo", "evt_1"); // duplicate

		expect((useSyncStore.getState().parts.msg_1[0] as TextPart).text).toBe("Hello");
	});

	test("replaying an identical delta STREAM twice (a stacked second SSE connection) produces byte-identical text", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", ""));
		const deltas: Array<[string, string]> = [
			["evt_1", "Hel"],
			["evt_2", "lo "],
			["evt_3", "world"],
		];
		for (const [id, d] of deltas) {
			store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", d, id);
		}
		// A stacked second connection redelivers the exact same sequence.
		for (const [id, d] of deltas) {
			store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", d, id);
		}

		expect((useSyncStore.getState().parts.msg_1[0] as TextPart).text).toBe("Hello world");
	});

	test("an interleaved two-part stream is unaffected — dedupe is per (message, part, field)", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_a", "msg_1", ""));
		store.upsertPart("msg_1", textPart("prt_b", "msg_1", ""));

		store.applyPartDelta("ses_1", "msg_1", "prt_a", "text", "Hi ", "evt_a1");
		store.applyPartDelta("ses_1", "msg_1", "prt_b", "text", "Bye ", "evt_b1");
		store.applyPartDelta("ses_1", "msg_1", "prt_a", "text", "there", "evt_a2");
		store.applyPartDelta("ses_1", "msg_1", "prt_b", "text", "now", "evt_b2");

		const parts = useSyncStore.getState().parts.msg_1;
		expect((parts.find((p) => p.id === "prt_a") as TextPart).text).toBe("Hi there");
		expect((parts.find((p) => p.id === "prt_b") as TextPart).text).toBe("Bye now");
	});

	test("two GENUINELY distinct deltas with identical content both apply (no content-based false positive)", () => {
		// Guards the design choice documented on `deltaEventTails`: dedupe is by
		// EVENT IDENTITY, not delta content — streaming "..." one identical
		// character at a time must not be mistaken for a duplicate delivery.
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", ""));
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", ".", "evt_1");
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", ".", "evt_2");
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", ".", "evt_3");

		expect((useSyncStore.getState().parts.msg_1[0] as TextPart).text).toBe("...");
	});

	test("applyEvent(message.part.delta) threads the wire event's own id through, deduping a duplicate SSE delivery", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_user"));
		const deltaEvent = {
			id: "evt_dup",
			type: "message.part.delta",
			properties: {
				messageID: "msg_asst",
				partID: "prt_1",
				sessionID: "ses_1",
				field: "text",
				delta: "Hello",
			},
		} as never;

		store.applyEvent(deltaEvent);
		store.applyEvent(deltaEvent); // e.g. a stacked SSE connection redelivering it

		expect((useSyncStore.getState().parts.msg_asst[0] as TextPart).text).toBe("Hello");
	});

	// F1 review finding: the event-id was recorded as "applied" BEFORE the
	// `set()` callback even checked whether the target part existed — so a
	// delta that hit the not-found path (e.g. the extra was dropped by the
	// hydrate extras-filter, or simply arrived before the part was created)
	// still poisoned `deltaEventTails` for that event id. A later, LEGITIMATE
	// redelivery of the identical event (a stacked reconnect resuming the
	// stream) then hit the duplicate-no-op branch and was silently dropped —
	// even though nothing had ever actually been applied.
	test("a delta that finds no target part does not consume the event id — a later redelivery once the part exists still applies", () => {
		const store = useSyncStore.getState();
		// The part does not exist yet under msg_1 — this delta's target is
		// not found, so `set()` bails via its `!result.found` branch.
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", "Hello", "evt_1");
		expect(useSyncStore.getState().parts.msg_1).toBeUndefined();

		// The part is created afterward (e.g. a repair/upsert).
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", ""));

		// The SAME event id is redelivered (a stacked reconnect resuming the
		// stream) — it must actually apply now, not no-op against a tail
		// entry recorded when nothing was ever applied.
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", "Hello", "evt_1");

		expect((useSyncStore.getState().parts.msg_1[0] as TextPart).text).toBe("Hello");
	});

	test("clearSession releases a session's delta-tail tracking — a reused (message,part,eventID) after a fresh lifetime applies normally", () => {
		const store = useSyncStore.getState();
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", ""));
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", "Hi", "evt_1");
		store.clearSession("ses_1");

		store.upsertPart("msg_1", textPart("prt_1", "msg_1", ""));
		store.applyPartDelta("ses_1", "msg_1", "prt_1", "text", "Hi", "evt_1");

		expect((useSyncStore.getState().parts.msg_1[0] as TextPart).text).toBe("Hi");
	});
});

describe("useSyncStore — reset", () => {
	test("clears all session state", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_a"));
		store.setDiff("ses_1", []);
		store.setTodo("ses_1", []);
		store.reset();

		const s = useSyncStore.getState();
		expect(s.messages).toEqual({});
		expect(s.parts).toEqual({});
		expect(s.sessionStatus).toEqual({});
		expect(s.diffs).toEqual({});
		expect(s.todos).toEqual({});
	});
});

// ============================================================================
// stream-cache — writeStreamCache() is a side effect of the sync store's
// message.part.updated / message.part.delta handling. `window`/`sessionStorage`
// don't exist in bun's default test environment, so both are stubbed here.
// ============================================================================

class MemoryStorage {
	private map = new Map<string, string>();
	/** How many times the store actually reached for storage. */
	setItemCalls = 0;
	getItem(key: string): string | null {
		return this.map.has(key) ? (this.map.get(key) ?? null) : null;
	}
	setItem(key: string, value: string): void {
		this.setItemCalls++;
		this.map.set(key, value);
	}
	removeItem(key: string): void {
		this.map.delete(key);
	}
	clear(): void {
		this.map.clear();
	}
}

interface GlobalWithDom {
	window?: unknown;
	sessionStorage?: Storage;
}

describe("stream-cache (via applyEvent message.part.updated / message.part.delta)", () => {
	beforeEach(() => {
		(globalThis as GlobalWithDom).window = {};
		(globalThis as GlobalWithDom).sessionStorage = new MemoryStorage() as unknown as Storage;
	});

	afterEach(() => {
		delete (globalThis as GlobalWithDom).window;
		delete (globalThis as GlobalWithDom).sessionStorage;
	});

	function readCache(sessionID: string): { messageID: string; partID: string; text: string } | null {
		const raw = sessionStorage.getItem(`opencode_stream_cache:${sessionID}`);
		return raw ? JSON.parse(raw) : null;
	}

	function storage(): MemoryStorage {
		return (globalThis as GlobalWithDom).sessionStorage as unknown as MemoryStorage;
	}

	test("a burst of deltas writes to sessionStorage once, not once per delta", async () => {
		// The cost this pins down: every delta used to do getItem + JSON.parse +
		// JSON.stringify + setItem of the ENTIRE accumulated text, so a response
		// cost O(n^2) synchronous storage work as it streamed.
		const store = useSyncStore.getState();
		store.upsertMessage("ses_burst", userMessage("msg_user"));

		for (let i = 0; i < 20; i++) {
			store.applyEvent({
				id: `evt_${i}`,
				type: "message.part.delta",
				properties: {
					messageID: "msg_asst",
					partID: "prt_1",
					sessionID: "ses_burst",
					field: "text",
					delta: "chunk ",
				},
			} as never);
		}

		// One leading write. The other 19 coalesce into a single trailing one.
		expect(storage().setItemCalls).toBe(1);

		// And nothing is lost: the final text lands once the window closes. The
		// wait is derived from the implementation's own constant so the two
		// cannot drift apart.
		await new Promise((r) => setTimeout(r, STREAM_CACHE_FLUSH_MS + 50));
		expect(readCache("ses_burst")?.text).toBe("chunk ".repeat(20));
		expect(storage().setItemCalls).toBe(2);
	});

	test("a new part is written at once, not held behind the previous part's window", async () => {
		// The cache holds ONE entry per session, so a part switch is a change of
		// subject. Letting it wait out a window opened by the part it replaced
		// would leave the cache describing text the reader can no longer see.
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", assistantMessage("msg_a"));

		store.applyEvent({
			id: "evt_1",
			type: "message.part.updated",
			properties: { sessionID: "ses_1", time: Date.now(), part: textPart("prt_1", "msg_a", "first") },
		} as never);
		const afterFirst = storage().setItemCalls;

		store.applyEvent({
			id: "evt_2",
			type: "message.part.updated",
			properties: { sessionID: "ses_1", time: Date.now(), part: textPart("prt_2", "msg_a", "second") },
		} as never);

		// Synchronously, with no waiting.
		expect(storage().setItemCalls).toBe(afterFirst + 1);
		expect(readCache("ses_1")?.partID).toBe("prt_2");
		expect(readCache("ses_1")?.text).toBe("second");
	});

	test("message.part.updated with a text part writes the streamed text to sessionStorage", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", assistantMessage("msg_a"));

		store.applyEvent({
			id: "evt_1",
			type: "message.part.updated",
			properties: {
				sessionID: "ses_1",
				time: Date.now(),
				part: textPart("prt_1", "msg_a", "Hello there"),
			},
		} as never);

		const cached = readCache("ses_1");
		expect(cached?.text).toBe("Hello there");
		expect(cached?.messageID).toBe("msg_a");
		expect(cached?.partID).toBe("prt_1");
	});

	test("message.part.delta accumulates text and writes the running total to sessionStorage", async () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_user"));

		store.applyEvent({
			id: "evt_1",
			type: "message.part.delta",
			properties: {
				messageID: "msg_asst",
				partID: "prt_1",
				sessionID: "ses_1",
				field: "text",
				delta: "Hel",
			},
		} as never);
		store.applyEvent({
			id: "evt_2",
			type: "message.part.delta",
			properties: {
				messageID: "msg_asst",
				partID: "prt_1",
				sessionID: "ses_1",
				field: "text",
				delta: "lo",
			},
		} as never);

		// The assertion is unchanged — the running total reaches the cache. What
		// changed is that it no longer arrives on the delta itself: writes are
		// coalesced, so the second delta lands on the trailing flush. Asserting
		// synchronous write-through was asserting the performance bug.
		await new Promise((r) => setTimeout(r, STREAM_CACHE_FLUSH_MS + 50));
		expect(readCache("ses_1")?.text).toBe("Hello");
	});

	test("a shorter cached entry is overwritten, but a longer one already cached is kept (writeStreamCache's own guard)", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", assistantMessage("msg_a"));

		store.applyEvent({
			id: "evt_1",
			type: "message.part.updated",
			properties: { sessionID: "ses_1", time: Date.now(), part: textPart("prt_1", "msg_a", "Hello world") },
		} as never);
		expect(readCache("ses_1")?.text).toBe("Hello world");

		// A stale, shorter snapshot for the SAME part must not regress the cache.
		store.applyEvent({
			id: "evt_2",
			type: "message.part.updated",
			properties: { sessionID: "ses_1", time: Date.now(), part: textPart("prt_1", "msg_a", "Hello") },
		} as never);
		expect(readCache("ses_1")?.text).toBe("Hello world");
	});
});

// ============================================================================
// hydrate() vs. an in-flight optimistic send.
//
// The supersede rule used to be EXISTENTIAL: "if this page contains any real
// user message at all, every optimistic user message is a duplicate". In an
// ongoing conversation that is always true — the page is full of earlier
// turns — so a message sent one second ago, which the server has provably
// never received, was deleted along with its text.
//
// The window is wide open by construction: the rehydrate that calls this only
// runs for sessions whose status is `busy`, and `beginOptimisticSend` is what
// sets `busy`. The act of sending armed the thing that deleted the send.
//
// The rule is now identity-based. See `hydrate` in sync-store.ts.
// ============================================================================

describe("useSyncStore — hydrate vs. an un-acked optimistic send", () => {
	test("a message the server has never seen survives a hydrate of PRIOR turns", () => {
		const store = useSyncStore.getState();
		// The conversation already has one completed user turn on the server.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_server_001"), parts: [textPart("prt_s1", "msg_server_001", "first message")] },
		]);

		// The user sends a NEW message with a big attachment. The optimistic add
		// happens BEFORE the upload, so this state lasts the whole upload.
		store.optimisticAdd("ses_1", userMessage("msg_optimistic_new"), [
			textPart("prt_o1", "msg_optimistic_new", "here is the zip"),
		]);
		store.setStatus("ses_1", { type: "busy" });

		// Mid-upload, an SSE gap rehydrates every BUSY session. The page contains
		// only the PRIOR turn — the prompt has not been sent yet.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_server_001"), parts: [textPart("prt_s1", "msg_server_001", "first message")] },
		]);

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id);
		expect(ids).toContain("msg_optimistic_new");
		// The text must survive too — a surviving bubble with no text is the
		// same bug wearing a different shirt.
		expect(useSyncStore.getState().parts["msg_optimistic_new"]?.[0]).toMatchObject({
			text: "here is the zip",
		});
	});

	test("several messages in flight each survive independently", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [{ info: userMessage("msg_server_001"), parts: [] }]);
		store.optimisticAdd("ses_1", userMessage("msg_opt_a"), [textPart("prt_a", "msg_opt_a", "one")]);
		store.optimisticAdd("ses_1", userMessage("msg_opt_b"), [textPart("prt_b", "msg_opt_b", "two")]);

		store.hydrate("ses_1", [{ info: userMessage("msg_server_001"), parts: [] }]);

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id);
		expect(ids).toContain("msg_opt_a");
		expect(ids).toContain("msg_opt_b");
	});

	test("an optimistic message in ANOTHER session is untouched", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_2", userMessage("msg_opt_other", "ses_2"), [
			textPart("prt_other", "msg_opt_other", "other session", "ses_2"),
		]);

		store.hydrate("ses_1", [{ info: userMessage("msg_server_001"), parts: [] }]);

		expect(useSyncStore.getState().messages["ses_2"]?.map((m) => m.id)).toContain("msg_opt_other");
	});

	// The regression guard. `hydrate`'s supersede branch exists to stop a
	// double bubble once the server HAS echoed the message; identity-based
	// correlation must not trade one bug for the other.
	test("a genuinely echoed message IS superseded — no double bubble", () => {
		const store = useSyncStore.getState();
		// Optimistic send using a client-generated part id, which apps/web sends
		// with the prompt precisely so the echo updates the same part.
		store.optimisticAdd("ses_1", userMessage("msg_client_id"), [
			textPart("prt_shared", "msg_client_id", "hello"),
		]);

		// The server echoes it back under ITS id, carrying the same part id.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_server_echo"), parts: [textPart("prt_shared", "msg_server_echo", "hello")] },
		]);

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).toContain("msg_server_echo");
		expect(ids).not.toContain("msg_client_id");
		expect(ids.filter((id) => id === "msg_server_echo")).toHaveLength(1);
	});

	test("a DISPATCHED message is superseded by an echo with no parts yet, and its text is bridged", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_client_id"), [
			textPart("prt_shared", "msg_client_id", "hello"),
		]);
		// The prompt actually went out. An echo cannot exist otherwise, which is
		// why this must precede it.
		store.markOptimisticDispatched("ses_1", "msg_client_id");

		// Parts persistence lags the message: the server has the user message
		// but no parts for it yet, so there is no part id to correlate on. Without
		// the bridge this renders an empty bubble, which is why the bridge exists.
		store.hydrate("ses_1", [{ info: userMessage("msg_server_echo"), parts: [] }]);

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).not.toContain("msg_client_id");
		expect(useSyncStore.getState().parts["msg_server_echo"]?.[0]).toMatchObject({ text: "hello" });
	});

	test("a PENDING message is never consumed by an unrelated new user message", () => {
		// The other-tab case. A message this tab has not POSTed cannot be a copy
		// of anything the server returns, so the ordinal fallback must not pair
		// it with a message someone else sent.
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_uploading"), [
			textPart("prt_mine", "msg_uploading", "still uploading my zip"),
		]);
		// Deliberately NOT dispatched — the upload is still running.

		store.hydrate("ses_1", [
			{ info: userMessage("msg_from_other_tab"), parts: [textPart("prt_theirs", "msg_from_other_tab", "sent elsewhere")] },
		]);

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).toContain("msg_uploading");
		expect(ids).toContain("msg_from_other_tab");
		expect(useSyncStore.getState().parts["msg_uploading"]?.[0]).toMatchObject({
			text: "still uploading my zip",
		});
	});

	test("with two dispatched sends, each bridges to its OWN echo", () => {
		// The first-match bridge would graft one message's text onto the other's
		// bubble. `supersededBy` names the exact echo each one lost to.
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_c1"), [textPart("prt_p1", "msg_c1", "first")]);
		store.optimisticAdd("ses_1", userMessage("msg_c2"), [textPart("prt_p2", "msg_c2", "second")]);
		store.markOptimisticDispatched("ses_1", "msg_c1");
		store.markOptimisticDispatched("ses_1", "msg_c2");

		store.hydrate("ses_1", [
			{ info: userMessage("msg_e1"), parts: [textPart("prt_p1", "msg_e1", "first")] },
			{ info: userMessage("msg_e2"), parts: [] },
		]);

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).not.toContain("msg_c1");
		expect(ids).not.toContain("msg_c2");
		// msg_c1 matched msg_e1 exactly by part id; msg_c2 took the remaining echo.
		expect(useSyncStore.getState().parts["msg_e2"]?.[0]).toMatchObject({ text: "second" });
	});
});

// T16 — extras merge dedupe. `hydrate` used to keep every existing
// part absent from the incoming snapshot verbatim ("extras"), on the theory
// that the server simply hasn't persisted it yet. That's right for a part
// still in flight, but wrong when the server RE-ISSUED the same content
// under a NEW part id: the old SSE-accumulated twin stayed resident forever,
// duplicating the text inside one message.
describe("useSyncStore — hydrate extras dedupe by content identity", () => {
	test("a re-issued text part under a NEW id retires the old SSE-accumulated twin", () => {
		const store = useSyncStore.getState();
		// SSE accumulated partial text under prt_old.
		store.upsertMessage("ses_1", assistantMessage("msg_a"));
		store.upsertPart("msg_a", textPart("prt_old", "msg_a", "Hello wor"));

		// The server re-issues the SAME content, complete, under a NEW id.
		store.hydrate("ses_1", [
			{ info: assistantMessage("msg_a"), parts: [textPart("prt_new", "msg_a", "Hello world")] },
		]);

		const ids = useSyncStore.getState().parts.msg_a?.map((p) => p.id) ?? [];
		expect(ids).toEqual(["prt_new"]);
	});

	test("an existing extra with UNRELATED content is kept — not mistaken for a re-issue", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", assistantMessage("msg_a"));
		store.upsertPart("msg_a", textPart("prt_old", "msg_a", "totally unrelated text"));

		store.hydrate("ses_1", [
			{ info: assistantMessage("msg_a"), parts: [textPart("prt_new", "msg_a", "Hello world")] },
		]);

		const ids = useSyncStore.getState().parts.msg_a?.map((p) => p.id) ?? [];
		expect(ids).toContain("prt_old");
		expect(ids).toContain("prt_new");
	});

	test("negative: distinct non-text (tool-like) parts are never dropped by content matching", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", assistantMessage("msg_a"));
		store.upsertPart("msg_a", {
			id: "prt_tool_old",
			sessionID: "ses_1",
			messageID: "msg_a",
			type: "step-start",
		} as Part);

		// The server's snapshot carries a DIFFERENT non-text part — not a
		// re-issue of the old one, and non-text parts are never compared by
		// content in the first place.
		store.hydrate("ses_1", [
			{
				info: assistantMessage("msg_a"),
				parts: [{ id: "prt_tool_new", sessionID: "ses_1", messageID: "msg_a", type: "step-start" } as Part],
			},
		]);

		const ids = useSyncStore.getState().parts.msg_a?.map((p) => p.id) ?? [];
		expect(ids).toContain("prt_tool_old");
		expect(ids).toContain("prt_tool_new");
	});

	test("an empty-text extra is never dropped by the containment check (nothing meaningful to correlate)", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", assistantMessage("msg_a"));
		store.upsertPart("msg_a", textPart("prt_empty", "msg_a", ""));

		store.hydrate("ses_1", [
			{ info: assistantMessage("msg_a"), parts: [textPart("prt_new", "msg_a", "Hello world")] },
		]);

		const ids = useSyncStore.getState().parts.msg_a?.map((p) => p.id) ?? [];
		expect(ids).toContain("prt_empty");
		expect(ids).toContain("prt_new");
	});

	// F1 review finding: the prefix-containment heuristic assumes an "extra"
	// whose text is a prefix of an incoming sibling is always the ABANDONED
	// SSE-accumulated twin of a server re-issue. That is false for a part
	// that is still ACTIVELY streaming (tracked in `deltaActiveParts`) — a
	// live delta target is never a stale twin, no matter what it coincidentally
	// prefixes. Dropping it here doesn't just lose the row: `applyPartDelta`'s
	// not-found path (see the F1 test below) then permanently swallows every
	// later delta for it too, because the wire event ids were already
	// recorded as applied.
	test("an actively-streaming extra survives even when its text happens to prefix a completed sibling part", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", assistantMessage("msg_a"));
		// A COMPLETED part with the full text.
		store.upsertPart("msg_a", textPart("prt_a", "msg_a", "Let me check the file."));
		// A DIFFERENT part in the SAME message, still receiving live deltas.
		// Its accumulated text is coincidentally a PREFIX of prt_a's — NOT
		// because the server re-issued prt_a's content under this new id.
		store.upsertPart("msg_a", textPart("prt_b", "msg_a", "Let me c"));
		store.applyPartDelta("ses_1", "msg_a", "prt_b", "text", "heck", "evt_1");

		// A hydrate snapshot arrives carrying only the completed part — prt_b
		// hasn't persisted server-side yet, it's still in flight.
		store.hydrate("ses_1", [
			{ info: assistantMessage("msg_a"), parts: [textPart("prt_a", "msg_a", "Let me check the file.")] },
		]);

		const ids = useSyncStore.getState().parts.msg_a?.map((p) => p.id) ?? [];
		expect(ids).toContain("prt_b");
	});
});

// ============================================================================
// The SAME existential bug, on the OTHER path.
//
// `hydrate` was one of two places that dropped optimistic user messages. The
// other is the `message.updated` SSE handler, which removes EVERY optimistic
// user message in the session the moment ANY real one arrives. With one send
// in flight that is correct and is why it exists — it swaps the bubble
// atomically so the user never sees it blink. With two in flight it takes the
// innocent one with it.
// ============================================================================

describe("useSyncStore — message.updated vs. a second send still in flight", () => {
	function userMessageUpdated(id: string, sessionID = "ses_1") {
		return {
			id: "evt_x",
			type: "message.updated",
			properties: { info: userMessage(id, sessionID) },
		} as never;
	}

	test("confirming ONE message does not delete another that is still uploading", () => {
		const store = useSyncStore.getState();
		// Two sends: the first is plain text, the second carries a big attachment
		// and is still uploading.
		store.optimisticAdd("ses_1", userMessage("msg_client_a"), [
			textPart("prt_a", "msg_client_a", "first"),
		]);
		store.optimisticAdd("ses_1", userMessage("msg_client_b"), [
			textPart("prt_b", "msg_client_b", "here is the zip"),
		]);

		// The server confirms only the FIRST one.
		store.applyEvent(userMessageUpdated("msg_server_a"));

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).toContain("msg_server_a");
		expect(ids).toContain("msg_client_b");
		expect(useSyncStore.getState().parts["msg_client_b"]?.[0]).toMatchObject({
			text: "here is the zip",
		});
	});

	test("a PENDING upload is not consumed by ANOTHER tab's confirmation", () => {
		// The generous fallback ("exactly one in flight, so retire it") had a
		// hole: a second tab sending on the same session produces a
		// message.updated for a message that is not ours, and the one message
		// we DO have in flight is still uploading. `hydrate` protects this
		// case; the SSE path must too, and it fires first in practice.
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_uploading"), [
			textPart("prt_mine", "msg_uploading", "still uploading my zip"),
		]);
		// Deliberately NOT dispatched — the upload is still running.

		store.applyEvent(userMessageUpdated("msg_from_other_tab"));

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).toContain("msg_uploading");
		expect(ids).toContain("msg_from_other_tab");
		expect(useSyncStore.getState().parts["msg_uploading"]?.[0]).toMatchObject({
			text: "still uploading my zip",
		});
	});

	test("the single-send swap still happens atomically — no double bubble", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_client_only"), [
			textPart("prt_only", "msg_client_only", "hello"),
		]);
		// A confirmation cannot exist for a message that was never sent.
		store.markOptimisticDispatched("ses_1", "msg_client_only");

		store.applyEvent(userMessageUpdated("msg_server_only"));

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).toContain("msg_server_only");
		expect(ids).not.toContain("msg_client_only");
	});
});

// ============================================================================
// Optimistic tracking is per session, like every other field in this store.
// ============================================================================

describe("useSyncStore — optimistic tracking is session-scoped", () => {
	// `clearSession` cleared the session's messages but left its ids in the
	// module-global tracking set, so they accumulated for the lifetime of the
	// tab. `hasOptimisticMessages` cannot see the leak — it is gated on the
	// message list, which IS cleared — so the observable consequence is the
	// one below: `hydrate` skips parts for any id it believes is optimistic
	// (`if (optimisticIds.has(mid)) continue`), and a leaked id makes it skip
	// a real server message forever.
	test("a cleared session's ids do not make hydrate skip a real message elsewhere", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_collide", "ses_1"), [
			textPart("prt_old", "msg_collide", "stale optimistic text", "ses_1"),
		]);
		store.clearSession("ses_1");

		// A DIFFERENT session receives a real server message that happens to
		// carry the same id. Its parts must land.
		store.hydrate("ses_2", [
			{
				info: userMessage("msg_collide", "ses_2"),
				parts: [textPart("prt_real", "msg_collide", "real server text", "ses_2")],
			},
		]);

		expect(useSyncStore.getState().parts["msg_collide"]?.[0]).toMatchObject({
			text: "real server text",
		});
	});

	test("clearing one session leaves another session's optimistic message alone", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_a", "ses_1"), []);
		store.optimisticAdd("ses_2", userMessage("msg_b", "ses_2"), []);

		store.clearSession("ses_1");

		expect(useSyncStore.getState().hasOptimisticMessages("ses_2")).toBe(true);
		expect(useSyncStore.getState().messages["ses_2"]?.map((m) => m.id)).toContain("msg_b");
	});
});

describe("useSyncStore — deltaActiveParts tracking is session-scoped", () => {
	// deltaActiveParts used to be one process-wide Set<string> shared by every
	// session in the tab, cleared wholesale on session.idle/session.error. A
	// second, unrelated session going idle wiped a still-streaming session's
	// delta tracking too, so upsertPart's stale-snapshot guard (line ~292)
	// stopped protecting it — a stale message.part.updated snapshot for the
	// still-streaming session could then overwrite its delta-accumulated text.
	test("session B going idle mid-stream does not let a stale snapshot overwrite session A's delta-accumulated part", () => {
		const store = useSyncStore.getState();

		// Session A: a delta has already landed for prt_a, accumulating text
		// under a stub message bucket (mirrors the message.part.delta handler,
		// which upserts a stub part before applying the delta).
		store.upsertPart("msg_a_stub", textPart("prt_a", "msg_a_stub", "Hel", "ses_a"));
		store.applyPartDelta("ses_a", "msg_a_stub", "prt_a", "text", "lo");
		expect((useSyncStore.getState().parts.msg_a_stub[0] as TextPart).text).toBe("Hello");

		// Session B, completely unrelated, finishes streaming and goes idle.
		store.applyEvent({
			id: "evt_idle_b",
			type: "session.idle",
			properties: { sessionID: "ses_b" },
		} as never);

		// A stale message.part.updated snapshot for session A's part arrives,
		// targeting a different (real) message bucket than the delta-created
		// stub — the exact race the comment above deltaActiveParts documents.
		// Session A is still streaming, so prt_a's delta tracking must have
		// survived session B's idle, and this stale insert must be rejected.
		store.upsertPart("msg_a_real", textPart("prt_a", "msg_a_real", "Hel", "ses_a"));

		expect(useSyncStore.getState().parts.msg_a_real).toBeUndefined();
		expect((useSyncStore.getState().parts.msg_a_stub[0] as TextPart).text).toBe("Hello");
	});

	// The `message.part.updated` handler resolves a session id through a
	// fallback chain (`part.sessionID ?? eventSessionID ?? <scan messages>`)
	// specifically because `part.sessionID` can be absent on the wire. The
	// guard above must consult THAT resolved id, not `part.sessionID` alone —
	// otherwise a wire part with no `sessionID` field silently disables the
	// guard even though the surrounding handler knew exactly which session it
	// belonged to.
	test("message.part.updated with part.sessionID absent still rejects a stale snapshot for a tracked part", () => {
		const store = useSyncStore.getState();

		store.upsertPart("msg_b_stub", textPart("prt_w", "msg_b_stub", "Hel", "ses_b"));
		store.applyPartDelta("ses_b", "msg_b_stub", "prt_w", "text", "lo");
		expect((useSyncStore.getState().parts.msg_b_stub[0] as TextPart).text).toBe("Hello");

		// The incoming part carries NO sessionID field at all (the exact wire
		// condition the fallback chain exists for). The event's own
		// properties.sessionID is "ses_b", so the handler's resolvedSessionID
		// still correctly identifies session B — that resolved id, not the
		// missing field, is what the guard must see.
		store.applyEvent({
			id: "evt_stale_no_session_on_part",
			type: "message.part.updated",
			properties: {
				sessionID: "ses_b",
				time: Date.now(),
				part: {
					id: "prt_w",
					messageID: "msg_b_real",
					type: "text",
					text: "Hel",
				},
			},
		} as never);

		expect(useSyncStore.getState().parts.msg_b_real).toBeUndefined();
		expect((useSyncStore.getState().parts.msg_b_stub[0] as TextPart).text).toBe("Hello");
	});

	test("session A's own idle clears its own bucket, allowing a later snapshot to land", () => {
		const store = useSyncStore.getState();

		store.upsertPart("msg_a_stub", textPart("prt_z", "msg_a_stub", "Hel", "ses_a"));
		store.applyPartDelta("ses_a", "msg_a_stub", "prt_z", "text", "lo");
		expect((useSyncStore.getState().parts.msg_a_stub[0] as TextPart).text).toBe("Hello");

		// Session A itself finishes streaming — unlike the cross-session test
		// above, THIS session's own idle must release its own tracking.
		store.applyEvent({
			id: "evt_idle_a",
			type: "session.idle",
			properties: { sessionID: "ses_a" },
		} as never);

		// A later snapshot for the same part id, targeting a different bucket,
		// now lands normally — session A is no longer streaming, so nothing
		// should still be guarding prt_a's stale-snapshot rejection.
		store.upsertPart("msg_a_real", textPart("prt_z", "msg_a_real", "Hel", "ses_a"));

		expect((useSyncStore.getState().parts.msg_a_real?.[0] as TextPart | undefined)?.text).toBe(
			"Hel",
		);
	});
});

describe("useSyncStore — bridgedPartIds tracking is session-scoped", () => {
	// bridgedPartIds used to be one process-wide Set<string> of message ids
	// whose optimistic parts were bridged onto a real message. It was cleared
	// only by reset() (which application code never calls) — clearSession did
	// not touch it — so ids accumulated for the lifetime of the tab. If a
	// LATER message in an unrelated session ever reused a leaked id,
	// upsertPart's bridge-clearing branch fired for it anyway: the first real
	// text part for that id wiped every part already stored under it, even
	// though nothing was ever bridged in that session. Same leak class as
	// optimisticIds ("optimistic tracking is session-scoped" above) and
	// deltaActiveParts ("deltaActiveParts tracking is session-scoped" above).
	test("clearing the bridging session stops a later, unrelated message that reuses its id from being wiped", () => {
		const store = useSyncStore.getState();

		// Session 1: an optimistic send bridges onto an echoed message with no
		// parts yet — mirrors "a DISPATCHED message is superseded by an echo
		// with no parts yet, and its text is bridged" above.
		store.optimisticAdd("ses_1", userMessage("msg_client"), [
			textPart("prt_bridge", "msg_client", "hello", "ses_1"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_client");
		store.hydrate("ses_1", [{ info: userMessage("msg_reused"), parts: [] }]);
		expect(useSyncStore.getState().parts["msg_reused"]?.[0]).toMatchObject({ text: "hello" });

		store.clearSession("ses_1");

		// A completely different session's message happens to reuse the same
		// id. It already has an unrelated (non-text) part before any text part
		// for it arrives.
		store.upsertPart("msg_reused", {
			id: "prt_step",
			sessionID: "ses_2",
			messageID: "msg_reused",
			type: "step-start",
		} as Part);

		// The first real text part for this id lands in ses_2. Nothing was
		// ever bridged in ses_2, so this must append, not wipe the step part
		// as if it were clearing session 1's stale bridge.
		store.upsertPart(
			"msg_reused",
			textPart("prt_text", "msg_reused", "unrelated text", "ses_2"),
		);

		const ids = useSyncStore.getState().parts["msg_reused"]?.map((p) => p.id) ?? [];
		expect(ids).toContain("prt_step");
		expect(ids).toContain("prt_text");
	});

	// The test above proves session-scoping (ses_1's bridge doesn't leak into
	// ses_2), but a Map keyed by session is scoped correctly by construction
	// even if `clearSession` never released anything — that test alone can't
	// tell "forgetSessionIds deletes bridgedPartIds's bucket" from "it
	// doesn't". This one reuses the id in the SAME session after
	// clearSession, which only passes if that release actually happens. The
	// realistic trigger: a cache-ownership conflict for the same session
	// calls clearSession(sessionId) and then re-hydrates the same message
	// ids (see use-session-sync.ts).
	test("clearSession releases the session's OWN bridged ids — reusing the id in the same session afterward is not treated as still-bridged", () => {
		const store = useSyncStore.getState();

		store.optimisticAdd("ses_1", userMessage("msg_client"), [
			textPart("prt_bridge", "msg_client", "hello", "ses_1"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_client");
		store.hydrate("ses_1", [{ info: userMessage("msg_reused"), parts: [] }]);
		expect(useSyncStore.getState().parts["msg_reused"]?.[0]).toMatchObject({ text: "hello" });

		store.clearSession("ses_1");

		// The SAME session, same message id, reused after the clear. It picks
		// up an unrelated (non-text) part before any text part arrives for it.
		store.upsertPart("msg_reused", {
			id: "prt_step",
			sessionID: "ses_1",
			messageID: "msg_reused",
			type: "step-start",
		} as Part);

		// The first real text part for this id lands in ses_1 again. If
		// clearSession released ses_1's bridge tracking, this appends normally.
		// If it didn't, this id is still marked bridged for ses_1 and the step
		// part is wiped.
		store.upsertPart(
			"msg_reused",
			textPart("prt_text", "msg_reused", "unrelated text", "ses_1"),
		);

		const ids = useSyncStore.getState().parts["msg_reused"]?.map((p) => p.id) ?? [];
		expect(ids).toContain("prt_step");
		expect(ids).toContain("prt_text");
	});
});

// T16 — bridge retirement used to fire ONLY when the first real part
// was NON-EMPTY text. A message whose first real part was a tool call (or an
// empty-text snapshot before content streamed in) kept the optimistic bridge
// beside the real parts — duplicating the user's text bubble.
describe("useSyncStore — bridge retirement on the first real part", () => {
	test("retires the bridge when the first real part is non-text (tool/step), not just non-empty text", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_client"), [
			textPart("prt_bridge", "msg_client", "hello", "ses_1"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_client");
		store.hydrate("ses_1", [{ info: userMessage("msg_reused"), parts: [] }]);
		expect(useSyncStore.getState().parts["msg_reused"]?.[0]).toMatchObject({ text: "hello" });

		// The server's FIRST real part for this message is a non-text step-start
		// part, not the echoed user text.
		store.upsertPart("msg_reused", {
			id: "prt_step",
			sessionID: "ses_1",
			messageID: "msg_reused",
			type: "step-start",
		} as Part);

		const parts = useSyncStore.getState().parts["msg_reused"] ?? [];
		expect(parts.map((p) => p.id)).toEqual(["prt_step"]);
	});

	test("retires the bridge on an empty-text first real part, not just non-empty text", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_client"), [
			textPart("prt_bridge", "msg_client", "hello", "ses_1"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_client");
		store.hydrate("ses_1", [{ info: userMessage("msg_reused"), parts: [] }]);

		store.upsertPart("msg_reused", textPart("prt_real", "msg_reused", "", "ses_1"));

		const parts = useSyncStore.getState().parts["msg_reused"] ?? [];
		expect(parts.map((p) => p.id)).toEqual(["prt_real"]);
	});

	test("still retires (and applies) on a non-empty real text part — the pre-existing case keeps working", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_client"), [
			textPart("prt_bridge", "msg_client", "hello", "ses_1"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_client");
		store.hydrate("ses_1", [{ info: userMessage("msg_reused"), parts: [] }]);

		store.upsertPart("msg_reused", textPart("prt_real", "msg_reused", "hello", "ses_1"));

		const parts = useSyncStore.getState().parts["msg_reused"] ?? [];
		expect(parts.map((p) => p.id)).toEqual(["prt_real"]);
		expect((parts[0] as TextPart).text).toBe("hello");
	});
});

describe("useSyncStore — session retention (memory eviction)", () => {
	// `messages` and `parts` are keyed by session and nothing ever removed a
	// key. `clearSession` had exactly one caller (a cache-ownership conflict in
	// use-session-sync.ts) and `reset()` had none in application code, so every
	// session a user opened kept its full transcript and every part in memory
	// for the lifetime of the tab. Open ten long sessions and memory climbed
	// monotonically and never came back.
	//
	// The fix is a consumer refcount: `retainSession` on mount, its returned
	// release on unmount, and the store frees a session once its LAST consumer
	// is gone. Freeing is deferred through a small window of detached sessions
	// so a remount (React StrictMode's mount → cleanup → mount, a fast refresh,
	// a tab flip) reclaims the transcript instead of repainting it from disk.

	/** Mirrors `DETACHED_SESSION_LIMIT` in sync-store.ts. */
	const RETENTION_BOUND = 3;

	function seedSession(sessionID: string): string {
		const messageID = `msg_${sessionID}`;
		const store = useSyncStore.getState();
		store.upsertMessage(sessionID, userMessage(messageID, sessionID));
		store.upsertPart(
			messageID,
			textPart(`prt_${sessionID}`, messageID, "hello", sessionID),
			sessionID,
		);
		store.setStatus(sessionID, { type: "busy" } as SessionStatus);
		store.setDiff(sessionID, []);
		store.setTodo(sessionID, []);
		return messageID;
	}

	function isResident(sessionID: string): boolean {
		return sessionID in useSyncStore.getState().messages;
	}

	/** Open a session and leave again — one full mount/unmount cycle. */
	function visit(sessionID: string): void {
		seedSession(sessionID);
		useSyncStore.getState().retainSession(sessionID)();
	}

	/** Browse `count` other sessions. Eviction happens on the NEXT mount, so
	 *  RETENTION_BOUND + 1 visits are what guarantee an already-detached
	 *  session is pushed out. */
	function browseAway(count: number): void {
		for (let i = 0; i < count; i++) visit(`ses_churn_${i}`);
	}

	test("the last consumer leaving eventually frees the session's messages and parts", () => {
		const messageIDs = ["ses_a", "ses_b", "ses_c", "ses_d"].map((id) => {
			const messageID = seedSession(id);
			useSyncStore.getState().retainSession(id)();
			return messageID;
		});

		// Four detached, three fit in the window — the oldest goes on the next
		// mount.
		seedSession("ses_e");
		useSyncStore.getState().retainSession("ses_e");

		expect(isResident("ses_a")).toBe(false);
		expect(useSyncStore.getState().parts[messageIDs[0]]).toBeUndefined();
		for (const id of ["ses_b", "ses_c", "ses_d"]) expect(isResident(id)).toBe(true);
	});

	test("freeing a session drops its diffs and todos too", () => {
		visit("ses_a");
		browseAway(RETENTION_BOUND + 1);

		const state = useSyncStore.getState();
		expect("ses_a" in state.diffs).toBe(false);
		expect("ses_a" in state.todos).toBe(false);
	});

	// `sessionStatus` is the one slice read for sessions that are deliberately
	// NOT resident: a parent's spawn-tool banner reads `sessionStatus[child]` to
	// show a child's retry state, for a child whose transcript the parent never
	// holds. Dropping it also bought nothing — every SSE `session.status` frame
	// and the connect-time `client.session.status()` poll re-add an entry for
	// every session on the runtime, evicted or not, so the delete was undone on
	// the next frame while the gap was visible to the user.
	test("freeing a session keeps its status — an unmounted child's banner still reads it", () => {
		visit("ses_a");
		browseAway(RETENTION_BOUND + 1);

		expect(isResident("ses_a")).toBe(false);
		expect(useSyncStore.getState().sessionStatus["ses_a"]).toEqual({
			type: "busy",
		} as SessionStatus);
	});

	// React runs every passive destroy before any passive create in a commit.
	// Pruning on release therefore let the unmount of the session being LEFT
	// evict the session being ENTERED, in the very commit that mounts it: it
	// was the oldest of four detached sessions at exactly the wrong moment.
	// Costs a loading flash and a disk round trip — or a permanently blank
	// transcript when nothing was ever written to disk (unauthenticated:
	// `getCurrentCacheScope()` returns null and `saveSessionToIDB` no-ops).
	test("returning to the oldest detached session does not evict it — unmount never frees", () => {
		for (const id of ["ses_a", "ses_x", "ses_y", "ses_b"]) visit(id);
		// Four detached and ses_a is the oldest. Now go back to it: React
		// destroys ses_b's effects first, then creates ses_a's.
		const messageID = `msg_ses_a`;

		useSyncStore.getState().retainSession("ses_a");

		expect(isResident("ses_a")).toBe(true);
		expect(useSyncStore.getState().parts[messageID]).toHaveLength(1);
	});

	test("nothing is freed by a release on its own — only by the next mount", () => {
		for (const id of ["ses_a", "ses_b", "ses_c", "ses_d"]) visit(id);
		// Over the bound, but no session has mounted since.
		for (const id of ["ses_a", "ses_b", "ses_c", "ses_d"]) {
			expect(isResident(id)).toBe(true);
		}

		seedSession("ses_e");
		useSyncStore.getState().retainSession("ses_e");
		expect(isResident("ses_a")).toBe(false);
	});

	// THE criterion most likely to be got wrong. Two components can render the
	// same live session at once (transcript + context modal, split view, or a
	// parent's spawn-tool preview of a child session). Tying eviction to a raw
	// unmount would free the data out from under the one still on screen.
	test("a session with two consumers survives one of them leaving", () => {
		const messageID = seedSession("ses_live");
		const releaseFirst = useSyncStore.getState().retainSession("ses_live");
		useSyncStore.getState().retainSession("ses_live");

		releaseFirst();

		// Not merely un-evicted — never even detached, so no amount of browsing
		// elsewhere can push it out of the window.
		browseAway(RETENTION_BOUND * 2);
		expect(isResident("ses_live")).toBe(true);
		expect(useSyncStore.getState().parts[messageID]).toHaveLength(1);
	});

	test("the second consumer leaving does free the session", () => {
		seedSession("ses_live");
		const releaseFirst = useSyncStore.getState().retainSession("ses_live");
		const releaseSecond = useSyncStore.getState().retainSession("ses_live");
		releaseFirst();
		releaseSecond();

		browseAway(RETENTION_BOUND + 1);
		expect(isResident("ses_live")).toBe(false);
	});

	// A release that ran twice would drop a hold the second consumer still
	// owns, which is the two-consumer bug through a side door. React can invoke
	// a cleanup once, but nothing stops a caller from holding onto it.
	test("releasing twice drops one hold, not two", () => {
		const messageID = seedSession("ses_live");
		const releaseFirst = useSyncStore.getState().retainSession("ses_live");
		useSyncStore.getState().retainSession("ses_live");

		releaseFirst();
		releaseFirst();

		browseAway(RETENTION_BOUND * 2);
		expect(isResident("ses_live")).toBe(true);
		expect(useSyncStore.getState().parts[messageID]).toHaveLength(1);
	});

	// StrictMode double-invokes effects in dev: mount → cleanup → mount, in the
	// same commit. Freeing the instant the count hits zero would blank the
	// transcript on every single mount, in development.
	test("StrictMode's mount → cleanup → mount does not free the session", () => {
		const messageID = seedSession("ses_strict");

		useSyncStore.getState().retainSession("ses_strict")();
		expect(isResident("ses_strict")).toBe(true);
		useSyncStore.getState().retainSession("ses_strict");

		browseAway(RETENTION_BOUND * 2);
		expect(isResident("ses_strict")).toBe(true);
		expect(useSyncStore.getState().parts[messageID]).toHaveLength(1);
	});

	// Hosts that read this store without ever retaining (apps/mobile drives it
	// from its own event pipeline) must keep exactly today's behaviour.
	test("a session that was never retained is never freed", () => {
		const messageID = seedSession("ses_unmanaged");

		browseAway(RETENTION_BOUND * 2);
		expect(isResident("ses_unmanaged")).toBe(true);
		expect(useSyncStore.getState().parts[messageID]).toHaveLength(1);
	});

	// The cache re-hydrate path in use-session-sync.ts paints from IndexedDB
	// only when the store holds nothing for the session — `shouldHydrateFromCache`
	// tests `sessionId in store.messages`, and `isLoading` tests the same key.
	// `clearSession` leaves `messages[id] = []`, which reads as "loaded, and
	// empty": a returning user would get a blank transcript that never repaints.
	// Eviction must DELETE the key.
	test("eviction deletes the session key rather than emptying it, so the cache can repaint", () => {
		seedSession("ses_a");

		useSyncStore.getState().clearSession("ses_a");
		expect("ses_a" in useSyncStore.getState().messages).toBe(true);
		expect(useSyncStore.getState().messages.ses_a).toEqual([]);

		useSyncStore.getState().retainSession("ses_a")();
		browseAway(RETENTION_BOUND + 1);
		expect("ses_a" in useSyncStore.getState().messages).toBe(false);
	});

	test("returning to a freed session repaints it from the cache without data loss", () => {
		const messageID = seedSession("ses_a");
		const cached = useSyncStore.getState().getMessages("ses_a");

		useSyncStore.getState().retainSession("ses_a")();
		browseAway(RETENTION_BOUND + 1);
		expect(isResident("ses_a")).toBe(false);

		// What the IDB cache round-trips: the same `{ info, parts }` rows.
		useSyncStore.getState().retainSession("ses_a");
		useSyncStore.getState().hydrate("ses_a", cached);

		expect(useSyncStore.getState().messages.ses_a.map((m) => m.id)).toEqual([messageID]);
		expect(useSyncStore.getState().parts[messageID]).toEqual([
			textPart(`prt_ses_a`, messageID, "hello", "ses_a"),
		]);
	});

	// Same leak class the four module-level tracking maps were fixed for: a
	// session whose data is gone must not leave its optimistic/bridge/delta
	// bookkeeping behind. Reuses the id in the SAME session afterwards, which
	// only passes if `forgetSessionIds` actually ran for it.
	test("eviction releases the session's optimistic and bridge tracking", () => {
		const store = useSyncStore.getState();

		store.optimisticAdd("ses_1", userMessage("msg_client"), [
			textPart("prt_bridge", "msg_client", "hello", "ses_1"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_client");
		store.hydrate("ses_1", [{ info: userMessage("msg_reused"), parts: [] }]);
		expect(useSyncStore.getState().parts["msg_reused"]?.[0]).toMatchObject({ text: "hello" });

		store.retainSession("ses_1")();
		browseAway(RETENTION_BOUND + 1);
		expect(isResident("ses_1")).toBe(false);

		// The same session id comes back and reuses the message id. It picks up
		// an unrelated (non-text) part before any text part arrives for it.
		store.upsertPart("msg_reused", {
			id: "prt_step",
			sessionID: "ses_1",
			messageID: "msg_reused",
			type: "step-start",
		} as Part);
		store.upsertPart(
			"msg_reused",
			textPart("prt_text", "msg_reused", "unrelated text", "ses_1"),
		);

		const ids = useSyncStore.getState().parts["msg_reused"]?.map((p) => p.id) ?? [];
		expect(ids).toContain("prt_step");
		expect(ids).toContain("prt_text");
	});

	// `parts` is keyed by messageID, and the sweep that frees a session walks
	// `messages[sessionID]` to find the buckets to delete. The delta handler
	// deliberately produces buckets no message points at: when `hasUserMsg` is
	// false it stores the part WITHOUT creating the assistant message
	// (sync-store.ts, `message.part.delta`), so hydrate can attach the real one
	// later. Those buckets are invisible to a messages-driven sweep and used to
	// survive every drop — the exact leak class this retention work exists to
	// close, still open on the page-refresh path that produces them.
	function orphanPartBucket(sessionID: string, messageID: string): void {
		useSyncStore.getState().applyEvent({
			type: "message.part.delta",
			properties: {
				sessionID,
				messageID,
				partID: `prt_orphan_${messageID}`,
				field: "text",
				delta: "streamed before the user message landed",
			},
		} as unknown as Parameters<ReturnType<typeof useSyncStore.getState>["applyEvent"]>[0]);
	}

	test("eviction frees part buckets that no message points at", () => {
		orphanPartBucket("ses_a", "msg_orphan");
		// The premise: a bucket exists with no message entry to reach it from.
		expect(useSyncStore.getState().parts["msg_orphan"]).toHaveLength(1);
		expect(useSyncStore.getState().messages["ses_a"]).toBeUndefined();

		seedSession("ses_a");
		useSyncStore.getState().retainSession("ses_a")();
		browseAway(RETENTION_BOUND + 1);

		expect(isResident("ses_a")).toBe(false);
		expect(useSyncStore.getState().parts["msg_orphan"]).toBeUndefined();
	});

	test("clearSession frees part buckets that no message points at", () => {
		orphanPartBucket("ses_a", "msg_orphan");

		useSyncStore.getState().clearSession("ses_a");

		expect(useSyncStore.getState().parts["msg_orphan"]).toBeUndefined();
	});

	test("freeing one session leaves another session's orphan buckets alone", () => {
		orphanPartBucket("ses_a", "msg_orphan_a");
		orphanPartBucket("ses_keep", "msg_orphan_keep");

		seedSession("ses_a");
		useSyncStore.getState().retainSession("ses_a")();
		browseAway(RETENTION_BOUND + 1);

		expect(useSyncStore.getState().parts["msg_orphan_a"]).toBeUndefined();
		expect(useSyncStore.getState().parts["msg_orphan_keep"]).toHaveLength(1);
	});

	// An id that can never hold runtime data — an empty string here, a Kortix
	// route UUID at the hook boundary — must not take one of the three slots.
	// Parking one evicts a real transcript a navigation early.
	test("an empty session id never takes a slot in the window", () => {
		visit("ses_a");
		// Whatever a caller does with an unusable id, it costs nothing.
		for (let i = 0; i < 5; i++) useSyncStore.getState().retainSession("")();
		visit("ses_b");
		visit("ses_c");

		// Three real sessions detached, exactly at the bound: nothing to evict.
		seedSession("ses_d");
		useSyncStore.getState().retainSession("ses_d");
		expect(isResident("ses_a")).toBe(true);
	});

	// A session whose agent is still running does not go quiet when it is
	// evicted — its SSE frames keep arriving and put `messages[id]` straight
	// back, holding only what streamed after the eviction. Coming back to it
	// then found `sessionId in store.messages` true, so the disk repaint stood
	// down and the user saw the fragment instead of their history. Before this
	// branch that history was simply resident, so this is a regression in what
	// the user sees, not a missed optimisation.
	//
	// Dropping those events instead would be worse: `useOpenCodeMessages` (the
	// spawn-tool preview of a child session) has no reconcile of its own and is
	// fed by SSE alone, so a child streaming before its preview mounts would
	// lose the frames outright. The events stay; the repaint decision is what
	// gets fixed.
	describe("a session evicted while it is still streaming", () => {
		function evict(sessionID: string): void {
			seedSession(sessionID);
			useSyncStore.getState().retainSession(sessionID)();
			browseAway(RETENTION_BOUND + 1);
			expect(isResident(sessionID)).toBe(false);
		}

		/** What the live SSE stream does to an evicted session: recreates its
		 *  key with only the tail that arrived after the eviction. */
		function streamInto(sessionID: string): void {
			const store = useSyncStore.getState();
			store.upsertMessage(sessionID, assistantMessage("msg_after", sessionID));
			store.upsertPart(
				"msg_after",
				textPart("prt_after", "msg_after", "post-eviction", sessionID),
				sessionID,
			);
		}

		test("is marked, so the disk repaint still runs when the user returns", () => {
			evict("ses_a");
			streamInto("ses_a");

			expect(isResident("ses_a")).toBe(true);
			expect(useSyncStore.getState().wasTranscriptEvicted("ses_a")).toBe(true);
		});

		test("a resident session that was never evicted is not marked", () => {
			seedSession("ses_a");
			expect(useSyncStore.getState().wasTranscriptEvicted("ses_a")).toBe(false);
		});

		test("the repaint clears the mark — hydrate is the authority again", () => {
			evict("ses_a");
			streamInto("ses_a");

			useSyncStore.getState().retainSession("ses_a");
			useSyncStore
				.getState()
				.hydrate("ses_a", [{ info: userMessage("msg_ses_a", "ses_a"), parts: [] }]);

			expect(useSyncStore.getState().wasTranscriptEvicted("ses_a")).toBe(false);
			// The merge keeps the streamed tail and restores the history under it.
			expect(useSyncStore.getState().messages["ses_a"].map((m) => m.id)).toEqual([
				"msg_after",
				"msg_ses_a",
			]);
		});

		// `hydrate`'s ordinal fallback pairs an in-flight optimistic user message
		// with the oldest unclaimed real one. Every message in the disk copy is
		// unclaimed by definition, so repainting under a live send would retire
		// the message the user just typed. The key-presence check used to make
		// that unreachable (optimisticAdd creates the key); the mark has to.
		test("a send in flight stands the repaint down rather than racing it", () => {
			evict("ses_a");
			streamInto("ses_a");

			useSyncStore
				.getState()
				.optimisticAdd("ses_a", userMessage("msg_client", "ses_a"), [
					textPart("prt_client", "msg_client", "just typed", "ses_a"),
				]);

			expect(useSyncStore.getState().wasTranscriptEvicted("ses_a")).toBe(false);
		});

		test("a deliberate clearSession is not something the cache may undo", () => {
			evict("ses_a");
			streamInto("ses_a");

			useSyncStore.getState().clearSession("ses_a");

			expect(useSyncStore.getState().wasTranscriptEvicted("ses_a")).toBe(false);
		});

		// Eviction takes the session out of the detach window, so the data SSE
		// puts back had no path out of memory again — the leak this branch closes,
		// reopened by the stream. The next mount of anything sweeps it.
		test("is freed again on the next mount, not left resident forever", () => {
			evict("ses_a");
			streamInto("ses_a");
			expect(isResident("ses_a")).toBe(true);

			seedSession("ses_next");
			useSyncStore.getState().retainSession("ses_next");

			expect(isResident("ses_a")).toBe(false);
			expect(useSyncStore.getState().parts["msg_after"]).toBeUndefined();
			// Still marked: it is still a session the user can come back to.
			expect(useSyncStore.getState().wasTranscriptEvicted("ses_a")).toBe(true);
		});

		test("the user returning is what stops the re-sweep, not luck", () => {
			evict("ses_a");
			streamInto("ses_a");

			useSyncStore.getState().retainSession("ses_a");
			seedSession("ses_next");
			useSyncStore.getState().retainSession("ses_next");

			expect(isResident("ses_a")).toBe(true);
		});
	});

	test("reset() clears the retention bookkeeping along with the data", () => {
		seedSession("ses_a");
		const release = useSyncStore.getState().retainSession("ses_a");

		useSyncStore.getState().reset();
		release();

		// The hold is gone with everything else, so a late unmount cannot park a
		// session the next page just opened.
		seedSession("ses_a");
		browseAway(RETENTION_BOUND * 2);
		expect(isResident("ses_a")).toBe(true);
	});
});

describe("useSyncStore — buildSessionMessages (the one shared join)", () => {
	// This memo used to exist TWICE — once in use-session-sync.ts, once in
	// use-opencode-sessions/messages.ts — and neither copy was dropped when a
	// session's data was. Every session the user opened stayed reachable
	// through whichever memo still held its rows, up to 20 transcripts per
	// copy, so freeing the store alone freed nothing. One memo, owned by the
	// store, beside the eviction that invalidates it.

	function rowsFor(sessionID: string) {
		const state = useSyncStore.getState();
		return state.buildSessionMessages(sessionID, state.messages[sessionID], state.parts);
	}

	test("returns a stable reference while the underlying arrays are unchanged", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_1"));
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "hi"), "ses_1");

		expect(rowsFor("ses_1")).toBe(rowsFor("ses_1"));
	});

	test("rebuilds when a part changes, so a new tail actually renders", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_1"));
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "hi"), "ses_1");
		const before = rowsFor("ses_1");

		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "hi there"), "ses_1");

		const after = rowsFor("ses_1");
		expect(after).not.toBe(before);
		expect((after[0].parts[0] as TextPart).text).toBe("hi there");
	});

	test("an empty session is a stable empty array, never a fresh one", () => {
		expect(rowsFor("ses_missing")).toBe(rowsFor("ses_other_missing"));
		expect(rowsFor("ses_missing")).toEqual([]);
	});

	// The actual leak assertion, and the only way to observe the memo from
	// outside: re-present the SAME arrays it memoized on. A surviving entry
	// hands back the identical rows — which is precisely the retention being
	// fixed, since those rows hold the whole transcript. Re-seeding the session
	// instead would prove nothing: `upsertMessage` builds a new array, so the
	// memo would rebuild whether or not the old entry was ever dropped.
	function capture(sessionID: string) {
		const state = useSyncStore.getState();
		const msgs = state.messages[sessionID];
		const parts = state.parts;
		return {
			rows: state.buildSessionMessages(sessionID, msgs, parts),
			rebuild: () =>
				useSyncStore.getState().buildSessionMessages(sessionID, msgs, parts),
		};
	}

	test("eviction drops the memoized rows, not just the store slices", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_1"));
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "hi"), "ses_1");
		const held = capture("ses_1");
		expect(held.rebuild()).toBe(held.rows); // memoized while resident

		store.retainSession("ses_1")();
		for (let i = 0; i < 4; i++) {
			const id = `ses_churn_${i}`;
			useSyncStore.getState().upsertMessage(id, userMessage(`msg_c${i}`, id));
			useSyncStore.getState().retainSession(id)();
		}
		useSyncStore.getState().retainSession("ses_fresh");

		expect("ses_1" in useSyncStore.getState().messages).toBe(false);
		expect(held.rebuild()).not.toBe(held.rows);
	});

	// The memo is bounded, or a tab that never navigates away still accumulates
	// one full set of rows per session it has ever rendered.
	test("the memo is bounded — the least recently used session is dropped", () => {
		// 21 distinct sessions rendered once each, never re-read: probing one
		// early would count as use and reorder the very thing under test.
		const held: Array<ReturnType<typeof capture>> = [];
		for (let i = 0; i < 21; i++) {
			const id = `ses_${i}`;
			useSyncStore.getState().upsertMessage(id, userMessage(`msg_${i}`, id));
			held.push(capture(id));
		}

		// 21 > MESSAGE_ROWS_LIMIT. Assert the survivor first — asking about an
		// evicted session re-inserts it and would evict this one.
		expect(held[1].rebuild()).toBe(held[1].rows);
		expect(held[0].rebuild()).not.toBe(held[0].rows);
	});

	test("a hit counts as use, so a stable session is not pushed out by other sessions", () => {
		const held: Array<ReturnType<typeof capture>> = [];
		for (let i = 0; i < 20; i++) {
			const id = `ses_${i}`;
			useSyncStore.getState().upsertMessage(id, userMessage(`msg_${i}`, id));
			held.push(capture(id));
		}

		// ses_0 renders again, unchanged — a memo HIT. That is use, so it is no
		// longer the least recently used; ses_1 is.
		expect(held[0].rebuild()).toBe(held[0].rows);

		useSyncStore.getState().upsertMessage("ses_20", userMessage("msg_20", "ses_20"));
		capture("ses_20");

		expect(held[0].rebuild()).toBe(held[0].rows);
		expect(held[1].rebuild()).not.toBe(held[1].rows);
	});

	test("clearSession drops the memoized rows too", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_1"));
		store.upsertPart("msg_1", textPart("prt_1", "msg_1", "hi"), "ses_1");
		const held = capture("ses_1");
		expect(held.rebuild()).toBe(held.rows);

		store.clearSession("ses_1");

		expect(held.rebuild()).not.toBe(held.rows);
	});
});

// ============================================================================
// T22 — session rewind/revert state mirrored from the server.
//
// `session.revert` is a STAGED pointer server-side: nothing is deleted until
// the replacement prompt COMMITS it. These tests cover the store's mirror of
// that lifecycle — `stageSessionRevert`/`commitSessionRevert`/
// `clearSessionRevert`/`applyCommittedRevert`, the three wire events that
// drive them through `applyEvent`, and `syncSessionRevertFromInfo` (the
// reload/cross-tab recovery path off a `Session.revert` field).
// ============================================================================

describe("useSyncStore — stageSessionRevert", () => {
	test("captures the watermark from the CURRENTLY KNOWN message list", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
			{ info: assistantMessage("msg_3"), parts: [] },
		]);

		store.stageSessionRevert("ses_1", "msg_2");

		expect(useSyncStore.getState().sessionRevert.ses_1).toEqual({
			messageId: "msg_2",
			watermark: "msg_3",
			hiddenIds: ["msg_2", "msg_3"],
			staged: true,
		});
	});

	test("re-staging the SAME boundary is a no-op — the original watermark is never widened", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
		]);
		store.stageSessionRevert("ses_1", "msg_2");
		expect(useSyncStore.getState().sessionRevert.ses_1?.watermark).toBe("msg_2");

		// More messages arrive locally (e.g. a stray echo) BEFORE the second
		// caller (the SSE confirmation of the same stage) runs.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
			{ info: assistantMessage("msg_3"), parts: [] },
		]);
		store.stageSessionRevert("ses_1", "msg_2");

		expect(useSyncStore.getState().sessionRevert.ses_1).toEqual({
			messageId: "msg_2",
			watermark: "msg_2",
			hiddenIds: ["msg_2"],
			staged: true,
		});
	});

	test("a DIFFERENT boundary replaces the tracked record with a fresh watermark", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [{ info: userMessage("msg_1"), parts: [] }]);
		store.stageSessionRevert("ses_1", "msg_1");

		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
		]);
		store.stageSessionRevert("ses_1", "msg_2");

		expect(useSyncStore.getState().sessionRevert.ses_1).toEqual({
			messageId: "msg_2",
			watermark: "msg_2",
			hiddenIds: ["msg_2"],
			staged: true,
		});
	});

	test("sessions are isolated", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");
		expect(useSyncStore.getState().sessionRevert.ses_2).toBeUndefined();
	});
});

describe("useSyncStore — commitSessionRevert / clearSessionRevert", () => {
	test("commit flips staged false and keeps the hide window", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");

		store.commitSessionRevert("ses_1");

		expect(useSyncStore.getState().sessionRevert.ses_1).toEqual({
			messageId: "msg_1",
			watermark: "msg_1",
			hiddenIds: ["msg_1"],
			staged: false,
		});
	});

	test("commit on a session with no staged revert is a no-op", () => {
		const store = useSyncStore.getState();
		store.commitSessionRevert("ses_never_staged");
		expect(useSyncStore.getState().sessionRevert.ses_never_staged).toBeUndefined();
	});

	test("clear drops the record entirely (unrevert / .cleared)", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");

		store.clearSessionRevert("ses_1");

		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();
	});
});

describe("useSyncStore — applyCommittedRevert (the explicit deletion)", () => {
	test("deletes every message AND its parts inside [boundary, watermark], keeps the rest", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [textPart("prt_2", "msg_2", "edited away")] },
			{ info: assistantMessage("msg_3"), parts: [textPart("prt_3", "msg_3", "old answer")] },
			{ info: userMessage("msg_4"), parts: [textPart("prt_4", "msg_4", "replacement")] },
		]);

		store.applyCommittedRevert("ses_1", "msg_2", "msg_3");

		const state = useSyncStore.getState();
		expect(state.messages.ses_1?.map((m) => m.id)).toEqual(["msg_1", "msg_4"]);
		expect(state.parts.msg_2).toBeUndefined();
		expect(state.parts.msg_3).toBeUndefined();
		expect(state.parts.msg_4).toBeDefined();
	});

	test("clears the local revert record once the rows are actually gone", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
		]);
		store.stageSessionRevert("ses_1", "msg_2");
		expect(useSyncStore.getState().sessionRevert.ses_1).not.toBeNull();

		store.applyCommittedRevert("ses_1", "msg_2", "msg_2");

		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();
	});

	test("a session with no local messages yet just clears the record, without error", () => {
		const store = useSyncStore.getState();
		expect(() => store.applyCommittedRevert("ses_never_synced", "msg_1", "msg_1")).not.toThrow();
		expect(useSyncStore.getState().sessionRevert.ses_never_synced).toBeNull();
	});
});

describe("useSyncStore — applyEvent(session.next.revert.staged/.cleared/.committed)", () => {
	test(".staged stages the boundary and freezes the watermark at the current tip", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
		]);

		store.applyEvent({
			id: "evt_1",
			type: "session.next.revert.staged",
			properties: {
				timestamp: 1,
				sessionID: "ses_1",
				revert: { messageID: "msg_2" },
			},
		} as never);

		expect(useSyncStore.getState().sessionRevert.ses_1).toEqual({
			messageId: "msg_2",
			watermark: "msg_2",
			hiddenIds: ["msg_2"],
			staged: true,
		});
	});

	test(".cleared drops the record (unrevert observed over the wire)", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");

		store.applyEvent({
			id: "evt_2",
			type: "session.next.revert.cleared",
			properties: { timestamp: 1, sessionID: "ses_1" },
		} as never);

		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();
	});

	test(".committed deletes [boundary, tracked watermark] and clears the record", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
			{ info: assistantMessage("msg_3"), parts: [] },
		]);
		store.stageSessionRevert("ses_1", "msg_2");

		store.applyEvent({
			id: "evt_3",
			type: "session.next.revert.committed",
			properties: { timestamp: 1, sessionID: "ses_1", messageID: "msg_2" },
		} as never);

		const state = useSyncStore.getState();
		expect(state.messages.ses_1?.map((m) => m.id)).toEqual(["msg_1"]);
		expect(state.sessionRevert.ses_1).toBeNull();
	});

	// F2 review finding: this fallback used to guess a watermark off
	// `newestMessageId(local messages)` when nothing was tracked locally —
	// dangerous, because "the newest local message" can be the user's own
	// REPLACEMENT prompt (and its answer) if its `message.updated` raced
	// ahead of this `.committed` event. That guess then deleted the very
	// message the user just typed. Fixed: with no tracked local record, do
	// NOT guess-and-delete. Leave messages alone and flag the session for a
	// tail reconcile instead — see the two tests below.
	test(".committed with NO locally tracked record does NOT delete anything — it flags a tail reconcile instead", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
			{ info: assistantMessage("msg_3"), parts: [] },
		]);
		// No prior stageSessionRevert — simulates a client that missed .staged
		// (reconnect gap, fresh mount, or a second tab) and only observes
		// .committed.

		store.applyEvent({
			id: "evt_4",
			type: "session.next.revert.committed",
			properties: { timestamp: 1, sessionID: "ses_1", messageID: "msg_2" },
		} as never);

		const state = useSyncStore.getState();
		expect(state.messages.ses_1?.map((m) => m.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
		expect(state.sessionRevertNeedsTailReconcile.ses_1).toBe(true);
	});

	test(".committed with NO locally tracked record does not delete a replacement prompt that raced ahead of it", () => {
		// The exact danger scenario: the user edits an earlier message, the
		// server stages then commits the rewind, and the replacement
		// prompt's `message.updated` (msg_4) lands in THIS tab BEFORE the
		// `.committed` event — e.g. a fresh mount / second tab that never
		// observed `.staged` at all. The removed newest-message-id fallback
		// would have computed a watermark of `msg_4` and deleted it (and
		// everything from `msg_2` onward) as if it were part of the
		// abandoned trajectory.
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
			{ info: assistantMessage("msg_3"), parts: [] },
		]);
		store.upsertMessage("ses_1", userMessage("msg_4")); // the replacement prompt, already visible

		store.applyEvent({
			id: "evt_5",
			type: "session.next.revert.committed",
			properties: { timestamp: 1, sessionID: "ses_1", messageID: "msg_2" },
		} as never);

		expect(useSyncStore.getState().messages.ses_1?.map((m) => m.id)).toEqual([
			"msg_1",
			"msg_2",
			"msg_3",
			"msg_4",
		]);
	});

	test(".committed WITH a tracked local record still deletes using its watermark, unaffected by F2", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
			{ info: assistantMessage("msg_3"), parts: [] },
		]);
		store.stageSessionRevert("ses_1", "msg_2"); // watermark frozen at msg_3

		store.applyEvent({
			id: "evt_6",
			type: "session.next.revert.committed",
			properties: { timestamp: 1, sessionID: "ses_1", messageID: "msg_2" },
		} as never);

		const state = useSyncStore.getState();
		expect(state.messages.ses_1?.map((m) => m.id)).toEqual(["msg_1"]);
		expect(state.sessionRevertNeedsTailReconcile.ses_1).toBeUndefined();
	});
});

describe("useSyncStore — sessionRevertNeedsTailReconcile (F2 consumer signal)", () => {
	test("markSessionRevertNeedsTailReconcile is idempotent and clearSessionRevertNeedsTailReconcile removes it", () => {
		const store = useSyncStore.getState();
		store.markSessionRevertNeedsTailReconcile("ses_1");
		store.markSessionRevertNeedsTailReconcile("ses_1");
		expect(useSyncStore.getState().sessionRevertNeedsTailReconcile.ses_1).toBe(true);

		store.clearSessionRevertNeedsTailReconcile("ses_1");
		expect(useSyncStore.getState().sessionRevertNeedsTailReconcile.ses_1).toBeUndefined();
	});

	test("clearing an unset session is a safe no-op", () => {
		const store = useSyncStore.getState();
		expect(() => store.clearSessionRevertNeedsTailReconcile("ses_never_flagged")).not.toThrow();
	});

	test("clearSession drops a pending reconcile flag for that session", () => {
		const store = useSyncStore.getState();
		store.markSessionRevertNeedsTailReconcile("ses_1");

		store.clearSession("ses_1");

		expect(useSyncStore.getState().sessionRevertNeedsTailReconcile.ses_1).toBeUndefined();
	});

	test("reset clears every session's reconcile flag", () => {
		const store = useSyncStore.getState();
		store.markSessionRevertNeedsTailReconcile("ses_1");

		store.reset();

		expect(useSyncStore.getState().sessionRevertNeedsTailReconcile).toEqual({});
	});
});

describe("useSyncStore — syncSessionRevertFromInfo (reload / cross-tab recovery)", () => {
	test("a present revert field seeds a fresh local record, watermark off currently known messages", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
		]);

		store.syncSessionRevertFromInfo("ses_1", { messageID: "msg_2" });

		expect(useSyncStore.getState().sessionRevert.ses_1).toEqual({
			messageId: "msg_2",
			watermark: "msg_2",
			hiddenIds: ["msg_2"],
			staged: true,
		});
	});

	test("an ALREADY-tracked boundary is left untouched (does not re-widen the watermark)", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [{ info: userMessage("msg_1"), parts: [] }]);
		store.stageSessionRevert("ses_1", "msg_1");
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
		]);

		store.syncSessionRevertFromInfo("ses_1", { messageID: "msg_1" });

		expect(useSyncStore.getState().sessionRevert.ses_1?.watermark).toBe("msg_1");
	});

	test("absence never clears an existing record — explicit events own clearing, not this", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");

		store.syncSessionRevertFromInfo("ses_1", null);
		store.syncSessionRevertFromInfo("ses_1", undefined);

		expect(useSyncStore.getState().sessionRevert.ses_1).not.toBeNull();
	});

	// F3 review finding: `syncSessionRevertFromInfo` ignored the store's OWN
	// null tombstone. `null` means "committed or cleared, deliberately" (set
	// by `applyCommittedRevert`/`clearSessionRevert`) — not "nothing tracked
	// yet" (which is `undefined`, the record simply absent). A stale
	// `session.updated` that raced the commit and still carries the OLD
	// `info.revert` pointer used to re-stage it with a FRESH watermark,
	// hiding every post-rewind message behind a phantom Restore offer.
	test("a stale session.updated does not re-stage an already-committed revert (tombstone wins)", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: userMessage("msg_1"), parts: [] },
			{ info: userMessage("msg_2"), parts: [] },
		]);
		store.stageSessionRevert("ses_1", "msg_2");
		store.applyCommittedRevert("ses_1", "msg_2", "msg_2");
		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();

		// A stale `session.updated` — read off a request that raced the
		// commit — still carries the OLD (now-committed) revert pointer.
		store.syncSessionRevertFromInfo("ses_1", { messageID: "msg_2" });

		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();
	});

	test("a stale session.updated does not re-stage a CLEARED (unrevert) revert either", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");
		store.clearSessionRevert("ses_1");
		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();

		store.syncSessionRevertFromInfo("ses_1", { messageID: "msg_1" });

		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();
	});

	// The escape hatch the tombstone must still allow: a genuinely NEW revert
	// arrives through the real `.staged` wire event (`stageSessionRevert`
	// directly, not through this info-snapshot recovery path), which
	// overwrites unconditionally and so clears any prior tombstone normally.
	test("a fresh .staged event (stageSessionRevert) still clears a prior tombstone normally", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");
		store.clearSessionRevert("ses_1");
		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();

		store.stageSessionRevert("ses_1", "msg_2");

		expect(useSyncStore.getState().sessionRevert.ses_1).toMatchObject({
			messageId: "msg_2",
			staged: true,
		});
	});
});

describe("useSyncStore — sessionRevert is released with the session (clearSession / reset)", () => {
	test("clearSession drops the tracked revert too", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");

		store.clearSession("ses_1");

		expect(useSyncStore.getState().sessionRevert.ses_1).toBeNull();
	});

	test("reset clears every session's revert state", () => {
		const store = useSyncStore.getState();
		store.stageSessionRevert("ses_1", "msg_1");

		store.reset();

		expect(useSyncStore.getState().sessionRevert).toEqual({});
	});
});

// ============================================================================
// setStatus — an OBSERVATION, never a heartbeat
// ============================================================================

/**
 * Object identity is what `useSessionWorking` stamps a stream observation
 * FROM: its effect re-runs on `[status, streamKey]`, and re-stamping restarts
 * `STREAM_OBSERVATION_MAX_MS` from zero. So a writer that re-parses an
 * equal-valued status every tick keeps the newest-observation clock pinned at
 * "just now" forever, and the bound that is supposed to stop a dead stream
 * from deciding is never reached — the latch, wearing a fresh timestamp.
 *
 * A value that did not change is not news. The store now says so.
 */
describe("useSyncStore — setStatus writes an observation, never a heartbeat", () => {
	test("an equal value keeps the SAME object identity", () => {
		const store = useSyncStore.getState();
		store.setStatus("ses_1", { type: "busy" });
		const first = useSyncStore.getState().sessionStatus.ses_1;

		store.setStatus("ses_1", { type: "busy" });

		expect(useSyncStore.getState().sessionStatus.ses_1).toBe(first);
	});

	test("a changed type mints a new object", () => {
		const store = useSyncStore.getState();
		store.setStatus("ses_1", { type: "busy" });
		const first = useSyncStore.getState().sessionStatus.ses_1;

		store.setStatus("ses_1", { type: "idle" });

		expect(useSyncStore.getState().sessionStatus.ses_1).not.toBe(first);
		expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: "idle" });
	});

	test("a changed retry field mints a new object", () => {
		// `getRetryInfo`/`getRetryMessage` read `attempt`, `message` and `next`.
		// A second attempt of the same retry is genuinely new news — the banner
		// counts it down — so identity has to move even though `type` did not.
		const store = useSyncStore.getState();
		const retry: SessionStatus = {
			type: "retry",
			attempt: 1,
			message: "upstream 503",
			next: 1000,
		};
		store.setStatus("ses_1", retry);
		const first = useSyncStore.getState().sessionStatus.ses_1;

		store.setStatus("ses_1", { ...retry, attempt: 2 });

		expect(useSyncStore.getState().sessionStatus.ses_1).not.toBe(first);
		expect(useSyncStore.getState().sessionStatus.ses_1).toMatchObject({ attempt: 2 });
	});

	test("an equal retry value is still not news", () => {
		const store = useSyncStore.getState();
		const retry: SessionStatus = {
			type: "retry",
			attempt: 1,
			message: "upstream 503",
			next: 1000,
		};
		store.setStatus("ses_1", retry);
		const first = useSyncStore.getState().sessionStatus.ses_1;

		store.setStatus("ses_1", { ...retry });

		expect(useSyncStore.getState().sessionStatus.ses_1).toBe(first);
	});

	test("a first status for a session is always news", () => {
		useSyncStore.getState().setStatus("ses_fresh", { type: "idle" });
		expect(useSyncStore.getState().sessionStatus.ses_fresh).toEqual({ type: "idle" });
	});

	test("one session's rewrite never disturbs another's identity", () => {
		const store = useSyncStore.getState();
		store.setStatus("ses_1", { type: "busy" });
		store.setStatus("ses_2", { type: "busy" });
		const other = useSyncStore.getState().sessionStatus.ses_2;

		store.setStatus("ses_1", { type: "idle" });

		expect(useSyncStore.getState().sessionStatus.ses_2).toBe(other);
	});
});

/**
 * WHO minted a frame travels with it. A tab-fabricated idle (the missing-busy
 * sweep, a synthetic abort, `clearSession`) is `'local'`; `projectWorking`
 * lets it answer for a silent session but never lets it contradict the
 * server's open `/turn` row. Unmarked, one fabricated frame vetoed the
 * lifecycle authority for the rest of a quiet turn (dev, 2026-08-24: busy
 * indicator gone, Send instead of Stop, transcript poll off — mid-run).
 */
describe("useSyncStore — sessionStatusOrigin: who minted the frame", () => {
	test("a plain write is wire by default", () => {
		useSyncStore.getState().setStatus("ses_1", { type: "busy" });
		expect(useSyncStore.getState().sessionStatusOrigin.ses_1).toBe("wire");
	});

	test("an explicit local write records local", () => {
		useSyncStore.getState().setStatus("ses_1", { type: "idle" }, "local");
		expect(useSyncStore.getState().sessionStatusOrigin.ses_1).toBe("local");
	});

	test("an equal value with a NEW origin updates origin but keeps identity", () => {
		// The identity rule above must hold — re-stamping an unchanged value
		// restarts the staleness clock — but who said it is still news: a wire
		// frame landing over a fabricated one restores its right to veto.
		const store = useSyncStore.getState();
		store.setStatus("ses_1", { type: "idle" }, "local");
		const first = useSyncStore.getState().sessionStatus.ses_1;

		store.setStatus("ses_1", { type: "idle" }, "wire");

		expect(useSyncStore.getState().sessionStatus.ses_1).toBe(first);
		expect(useSyncStore.getState().sessionStatusOrigin.ses_1).toBe("wire");
	});

	test("a synthetic session.idle event lands with local origin", () => {
		// `markSessionIdleLocally` routes through `applyEvent` with
		// `synthetic: true` — a field no wire `Event` carries.
		useSyncStore.getState().applyEvent({
			type: "session.idle",
			synthetic: true,
			properties: { sessionID: "ses_1" },
		} as never);
		expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: "idle" });
		expect(useSyncStore.getState().sessionStatusOrigin.ses_1).toBe("local");
	});

	test("a wire session.idle event lands with wire origin", () => {
		useSyncStore.getState().applyEvent({
			type: "session.idle",
			properties: { sessionID: "ses_1" },
		} as never);
		expect(useSyncStore.getState().sessionStatusOrigin.ses_1).toBe("wire");
	});

	test("a synthetic session.error marks its idle write local", () => {
		// `markSessionAbortedLocally` fires on `server.instance.disposed` for
		// EVERY non-idle session in the tab — an inference about the runtime,
		// never the runtime speaking.
		useSyncStore.getState().setStatus("ses_1", { type: "busy" });
		useSyncStore.getState().applyEvent({
			type: "session.error",
			synthetic: true,
			properties: {
				sessionID: "ses_1",
				error: { name: "AbortError", data: { message: "disposed" } },
			},
		} as never);
		expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: "idle" });
		expect(useSyncStore.getState().sessionStatusOrigin.ses_1).toBe("local");
	});

	test("clearSession's fabricated idle is local", () => {
		useSyncStore.getState().setStatus("ses_1", { type: "busy" });
		useSyncStore.getState().clearSession("ses_1");
		expect(useSyncStore.getState().sessionStatus.ses_1).toEqual({ type: "idle" });
		expect(useSyncStore.getState().sessionStatusOrigin.ses_1).toBe("local");
	});
});

describe("sameSessionStatus", () => {
	test("compares exactly the fields the retry readers read", () => {
		expect(sameSessionStatus({ type: "busy" }, { type: "busy" })).toBe(true);
		expect(sameSessionStatus({ type: "busy" }, { type: "idle" })).toBe(false);
		expect(sameSessionStatus(undefined, { type: "idle" })).toBe(false);
		expect(sameSessionStatus(undefined, undefined)).toBe(true);

		const retry: SessionStatus = {
			type: "retry",
			attempt: 1,
			message: "upstream 503",
			next: 1000,
		};
		expect(sameSessionStatus(retry, { ...retry })).toBe(true);
		expect(sameSessionStatus(retry, { ...retry, attempt: 2 })).toBe(false);
		expect(sameSessionStatus(retry, { ...retry, message: "gateway 429" })).toBe(false);
		expect(sameSessionStatus(retry, { ...retry, next: 2000 })).toBe(false);
	});
});

// ============================================================================
// ONE prompt = ONE id = ONE bubble. The optimistic message is minted with the
// WIRE id the inbox row carries, so the server's echo either confirms it in
// place (same id) or supersedes it under a re-minted id that the store
// aliases back to the original. And a message the control plane already holds
// (an inbox row landed) is never swept by a local idle.
// ============================================================================

describe("useSyncStore — an echo under the SAME id confirms the optimistic message in place", () => {
	function userMessageUpdated(id: string, sessionID = "ses_1") {
		return {
			id: "evt_x",
			type: "message.updated",
			properties: { info: userMessage(id, sessionID) },
		} as never;
	}

	test("message.updated with the optimistic id keeps ONE message, and the idle sweep no longer touches it", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), [
			textPart("prt_client", "msg_wire", "hello"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_wire");

		store.applyEvent(userMessageUpdated("msg_wire"));

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).toEqual(["msg_wire"]);
		// The optimistic text stands in until the real part lands.
		expect(useSyncStore.getState().parts["msg_wire"]?.[0]).toMatchObject({ text: "hello" });
		expect(useSyncStore.getState().hasOptimisticMessages("ses_1")).toBe(false);

		// Confirmed by the runtime: a sweep is not allowed to delete it.
		store.clearOptimisticMessages("ses_1");
		expect(useSyncStore.getState().messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_wire"]);
	});

	test("the first REAL part replaces the optimistic part instead of sitting beside it", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), [
			textPart("prt_client", "msg_wire", "hello"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_wire");
		store.applyEvent(userMessageUpdated("msg_wire"));

		store.upsertPart("msg_wire", textPart("prt_server", "msg_wire", "hello"), "ses_1");

		const parts = useSyncStore.getState().parts["msg_wire"] ?? [];
		expect(parts.map((p) => p.id)).toEqual(["prt_server"]);
	});

	test("hydrate with the optimistic id confirms it too, and real parts win", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), [
			textPart("prt_client", "msg_wire", "hello"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_wire");

		store.hydrate("ses_1", [
			{ info: userMessage("msg_wire"), parts: [textPart("prt_server", "msg_wire", "hello")] },
		] as never);

		const s = useSyncStore.getState();
		expect(s.messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_wire"]);
		expect(s.parts["msg_wire"]?.map((p) => p.id)).toEqual(["prt_server"]);
		expect(s.hasOptimisticMessages("ses_1")).toBe(false);
	});
});

describe("useSyncStore — an echo under a RE-MINTED id is aliased to the optimistic id", () => {
	function userMessageUpdated(id: string, sessionID = "ses_1") {
		return {
			id: "evt_x",
			type: "message.updated",
			properties: { info: userMessage(id, sessionID) },
		} as never;
	}

	test("SSE supersede records origin ↔ echo both ways", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), [
			textPart("prt_client", "msg_wire", "hello"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_wire");

		store.applyEvent(userMessageUpdated("msg_reminted"));

		const s = useSyncStore.getState();
		expect(s.messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_reminted"]);
		expect(s.optimisticEchoOf("ses_1", "msg_wire")).toBe("msg_reminted");
		expect(s.optimisticOriginOf("ses_1", "msg_reminted")).toBe("msg_wire");
		expect(s.optimisticOriginOf("ses_1", "msg_wire")).toBeUndefined();
	});

	test("hydrate supersede records the alias as well", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), [
			textPart("prt_client", "msg_wire", "hello"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_wire");

		store.hydrate("ses_1", [{ info: userMessage("msg_reminted"), parts: [] }] as never);

		const s = useSyncStore.getState();
		expect(s.messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_reminted"]);
		expect(s.optimisticEchoOf("ses_1", "msg_wire")).toBe("msg_reminted");
		expect(s.optimisticOriginOf("ses_1", "msg_reminted")).toBe("msg_wire");
	});

	test("aliases leave with the session", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), []);
		store.markOptimisticDispatched("ses_1", "msg_wire");
		store.applyEvent(userMessageUpdated("msg_reminted"));
		store.clearSession("ses_1");
		expect(useSyncStore.getState().optimisticEchoOf("ses_1", "msg_wire")).toBeUndefined();
	});
});

// ============================================================================
// A BURST of queued prompts. Three inbox-backed sends wait in the server queue;
// the drain delivers them one at a time, each under a RE-MINTED id. The echo
// carries no parts (they arrive as separate frames) and the row that names the
// re-mint is up to one poll behind — so neither correlation is available at the
// instant the echo lands.
//
// The store used to `return` there: no bubble may be consumed on a guess with
// several in flight, which is right, but it dropped the SERVER's message with
// it. Nothing re-reads a healthy stream, so the delivered prompt was missing
// until a reload — and the `message.part.updated` that followed re-created it
// as an ASSISTANT message, putting the user's own words in the agent's voice
// and re-parenting the reply onto the wrong bubble.
// ============================================================================

describe("useSyncStore — a burst of inbox-backed sends never loses an echo", () => {
	function userMessageUpdated(id: string, sessionID = "ses_1") {
		return {
			id: "evt_x",
			type: "message.updated",
			properties: { info: userMessage(id, sessionID) },
		} as never;
	}

	function partUpdated(part: Part, sessionID = "ses_1") {
		return {
			id: "evt_p",
			type: "message.part.updated",
			properties: { sessionID, part },
		} as never;
	}

	/**
	 * One prompt POSTed to the durable inbox: painted, dispatched, backed.
	 *
	 * UNTIMED, like the real stub — `beginOptimisticSend` omits `time.created`
	 * on purpose, so display order comes from the wire id rather than from a
	 * browser clock the box may be running ahead of.
	 */
	function queueSend(id: string, text: string): void {
		const store = useSyncStore.getState();
		const stub = { id, sessionID: "ses_1", role: "user", time: {} } as unknown as Message;
		store.optimisticAdd("ses_1", stub, [textPart(`prt_${id}`, id, text)]);
		store.markOptimisticDispatched("ses_1", id);
		store.markOptimisticInboxBacked("ses_1", id);
	}

	test("an echo that matches nothing joins the transcript instead of being discarded", () => {
		queueSend("msg_wire_a", "first");
		queueSend("msg_wire_b", "second");
		queueSend("msg_wire_c", "third");

		useSyncStore.getState().applyEvent(userMessageUpdated("msg_reminted_a"));

		const s = useSyncStore.getState();
		const rows = s.messages["ses_1"] ?? [];
		expect(rows.map((m) => m.id)).toContain("msg_reminted_a");
		// And it consumed nothing: with three in flight there is no safe guess,
		// so every bubble the user typed is still on screen.
		expect(rows.map((m) => m.id)).toEqual([
			"msg_wire_a",
			"msg_wire_b",
			"msg_wire_c",
			"msg_reminted_a",
		]);
	});

	test("the part frame that follows never re-creates the prompt as an assistant message", () => {
		queueSend("msg_wire_a", "first");
		queueSend("msg_wire_b", "second");

		const store = useSyncStore.getState();
		store.applyEvent(userMessageUpdated("msg_reminted_a"));
		store.applyEvent(partUpdated(textPart("prt_server_a", "msg_reminted_a", "first")));

		const row = useSyncStore
			.getState()
			.messages["ses_1"]?.find((m) => m.id === "msg_reminted_a");
		expect(row?.role).toBe("user");
	});

	test("the inbox row's alias, arriving after the echo, retires the bubble it names", () => {
		queueSend("msg_wire_a", "first");
		queueSend("msg_wire_b", "second");
		queueSend("msg_wire_c", "third");

		const store = useSyncStore.getState();
		store.applyEvent(userMessageUpdated("msg_reminted_a"));
		// One poll later the row lists both ids, which is the identity match the
		// echo did not carry.
		store.registerOptimisticEcho("ses_1", "msg_wire_a", "msg_reminted_a");

		const s = useSyncStore.getState();
		expect(s.messages["ses_1"]?.map((m) => m.id)).toEqual([
			"msg_wire_b",
			"msg_wire_c",
			"msg_reminted_a",
		]);
		expect(s.optimisticOriginOf("ses_1", "msg_reminted_a")).toBe("msg_wire_a");
		// The bubble's text bridges over, so it never blinks empty while the
		// server's own part is still in flight.
		expect(s.parts["msg_reminted_a"]?.[0]).toMatchObject({ text: "first" });
		expect(s.parts["msg_wire_a"]).toBeUndefined();
	});

	test("the delivered prompt owns its reply — one bubble, in the agent's turn", () => {
		// The whole timeline, in wire order: three prompts queue, the drain
		// delivers the first under a re-minted id, its text and its answer
		// stream in, and the row that names the pairing lands one poll later.
		// Real wire ids: `compareMessagesForDisplay` reads the id as the
		// message's POSITION for anything opencode placed, and the drain's
		// re-mint deliberately sorts above the ids this tab minted at Enter.
		const [wireA, wireB, wireC] = [
			"msg_000000000001aaaa",
			"msg_000000000002aaaa",
			"msg_000000000003aaaa",
		];
		const remintedA = "msg_000000000009aaaa";
		const replyA = "msg_00000000000aaaaa";
		queueSend(wireA, "first");
		queueSend(wireB, "second");
		queueSend(wireC, "third");

		const store = useSyncStore.getState();
		store.applyEvent(userMessageUpdated(remintedA));
		store.applyEvent(partUpdated(textPart("prt_server_a", remintedA, "first")));
		store.applyEvent({
			id: "evt_a",
			type: "message.updated",
			properties: { info: { ...assistantMessage(replyA), parentID: remintedA } },
		} as never);
		store.applyEvent(partUpdated(textPart("prt_reply_a", replyA, "on it")));
		store.registerOptimisticEcho("ses_1", wireA, remintedA);

		const turns = groupMessagesIntoTurns(useSyncStore.getState().getMessages("ses_1"));
		expect(
			turns.map((t) => ({
				user: t.userMessage.info.id,
				role: t.userMessage.info.role,
				assistants: t.assistantMessages.map((a) => a.info.id),
			})),
		).toEqual([
			// The two prompts still waiting keep the ids this tab minted, which
			// sort below the re-mint — they are drawn above the answer until the
			// drain reaches them and re-mints them too.
			{ user: wireB, role: "user", assistants: [] },
			{ user: wireC, role: "user", assistants: [] },
			// ONE bubble for the delivered prompt, as a USER message, with the
			// reply under it. Before this fix the echo was discarded, the part
			// frame re-created the id as an assistant message, and the reply
			// re-parented onto whichever bubble sorted last.
			{ user: remintedA, role: "user", assistants: [replyA] },
		]);
	});

	test("a late alias for a bubble the runtime never echoed changes nothing", () => {
		queueSend("msg_wire_a", "first");
		queueSend("msg_wire_b", "second");

		useSyncStore.getState().registerOptimisticEcho("ses_1", "msg_wire_a", "msg_reminted_a");

		const s = useSyncStore.getState();
		expect(s.messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_wire_a", "msg_wire_b"]);
		expect(s.optimisticEchoOf("ses_1", "msg_wire_a")).toBe("msg_reminted_a");
	});
});

describe("useSyncStore — optimisticRemove is a no-op for a message the runtime confirmed", () => {
	test("after a same-id echo the message is the transcript's; removing the queue row leaves it", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), []);
		store.markOptimisticDispatched("ses_1", "msg_wire");
		store.applyEvent({
			id: "evt_x",
			type: "message.updated",
			properties: { info: userMessage("msg_wire") },
		} as never);

		store.optimisticRemove("ses_1", "msg_wire");

		expect(useSyncStore.getState().messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_wire"]);
	});
});

describe("useSyncStore — an INBOX-BACKED optimistic message survives the idle sweep", () => {
	test("markOptimisticInboxBacked keeps it through clearOptimisticMessages; optimisticRemove still removes it", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), [
			textPart("prt_client", "msg_wire", "queued while asleep"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_wire");
		store.markOptimisticInboxBacked("ses_1", "msg_wire");
		// A second, NOT inbox-backed one — the sweep still takes it.
		store.optimisticAdd("ses_1", userMessage("msg_never_landed"), []);

		store.clearOptimisticMessages("ses_1");

		expect(useSyncStore.getState().messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_wire"]);
		expect(useSyncStore.getState().parts["msg_wire"]?.[0]).toMatchObject({
			text: "queued while asleep",
		});

		store.optimisticRemove("ses_1", "msg_wire");
		expect(useSyncStore.getState().messages["ses_1"] ?? []).toEqual([]);
	});

	test("an inbox-backed message is still superseded by its echo (SSE) — the backing never blocks confirmation", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_wire"), [
			textPart("prt_client", "msg_wire", "hi"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_wire");
		store.markOptimisticInboxBacked("ses_1", "msg_wire");

		store.applyEvent({
			id: "evt_x",
			type: "message.updated",
			properties: { info: userMessage("msg_reminted") },
		} as never);

		expect(useSyncStore.getState().messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_reminted"]);
		// Once superseded there is nothing left to protect — a later sweep is a no-op.
		store.clearOptimisticMessages("ses_1");
		expect(useSyncStore.getState().messages["ses_1"]?.map((m) => m.id)).toEqual(["msg_reminted"]);
	});
});

describe("useSyncStore — cache-sourced messages are provisional until the runtime confirms them", () => {
	test("a cache-sourced user message the runtime's own tail does not contain is dropped (a phantom)", () => {
		const store = useSyncStore.getState();
		// Disk repaint: two real messages and a phantom (an optimistic stub that
		// was mirrored to disk before its echo) — all plain messages by now.
		store.hydrate(
			"ses_1",
			[
				{ info: userMessage("msg_a"), parts: [] },
				{ info: userMessage("msg_phantom"), parts: [] },
				{ info: userMessage("msg_c"), parts: [] },
			],
			{ source: "cache" },
		);
		// The disk copy is stored in the order it was written, not re-sorted
		// by id — see `hydrate`.
		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_a",
			"msg_phantom",
			"msg_c",
		]);
		// The runtime's tail covers that range and knows nothing of the phantom.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_a"), parts: [] },
			{ info: userMessage("msg_c"), parts: [] },
		]);
		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual(["msg_a", "msg_c"]);
	});

	test("a cache-sourced message OLDER than the runtime's tail is kept (history the tail did not reach)", () => {
		const store = useSyncStore.getState();
		store.hydrate(
			"ses_1",
			[
				{ info: userMessage("msg_a"), parts: [] },
				{ info: userMessage("msg_b"), parts: [] },
			],
			{ source: "cache" },
		);
		// A bounded tail that starts at msg_b: msg_a is simply older than it.
		store.hydrate("ses_1", [
			{ info: userMessage("msg_b"), parts: [] },
			{ info: userMessage("msg_c"), parts: [] },
		]);
		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_a",
			"msg_b",
			"msg_c",
		]);
	});

	test("an optimistic message is reported as such, and a plain one is not", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_opt"), []);
		store.upsertMessage("ses_1", userMessage("msg_real"));
		expect(store.isOptimisticMessage("ses_1", "msg_opt")).toBe(true);
		expect(store.isOptimisticMessage("ses_1", "msg_real")).toBe(false);
	});
});

describe("useSyncStore — a removed user message the control plane still owns keeps its bubble", () => {
	test("message.removed for an inbox-backed message re-marks it optimistic instead of dropping it", () => {
		// The drain deletes a stranded copy of a forwarded prompt and re-places
		// it under a new id; the box emits message.removed for the old copy.
		// The user's bubble must not blink out between the two.
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_c"), [textPart("prt_1", "msg_c", "hi")]);
		store.markOptimisticDispatched("ses_1", "msg_c");
		store.markOptimisticInboxBacked("ses_1", "msg_c");
		// The echo confirms it in place (same id).
		store.hydrate("ses_1", [{ info: userMessage("msg_c"), parts: [textPart("prt_1", "msg_c", "hi")] }]);
		expect(store.isOptimisticMessage("ses_1", "msg_c")).toBe(false);

		store.applyEvent({
			type: "message.removed",
			properties: { sessionID: "ses_1", messageID: "msg_c" },
		} as never);
		const msgs = useSyncStore.getState().messages.ses_1;
		expect(msgs.map((m) => m.id)).toEqual(["msg_c"]);
		expect(useSyncStore.getState().parts.msg_c?.[0]?.id).toBe("prt_1");
		expect(useSyncStore.getState().isOptimisticMessage("ses_1", "msg_c")).toBe(true);

		// The re-placed copy arrives under a new id: it supersedes the bubble,
		// and the alias chain keeps pointing at the id the host keyed on.
		store.applyEvent({
			type: "message.updated",
			properties: { info: userMessage("msg_c2") },
		} as never);
		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual(["msg_c2"]);
		expect(useSyncStore.getState().optimisticOriginOf("ses_1", "msg_c2")).toBe("msg_c");
		expect(useSyncStore.getState().parts.msg_c2?.[0]?.id).toBe("prt_1");
	});

	test("a re-minted prompt taken back out by Stop is superseded by ITS OWN re-delivery", () => {
		// The stop-release path, end to end, for TWO prompts queued mid-turn:
		//
		//   opt  -> the id this tab painted (the wire id it minted)
		//   fwd  -> the drain re-mints above the live turn on the first delivery
		//   Stop -> the settle deletes the fwd copy (message.removed) and holds
		//           the row; the bubble goes back to being optimistic under `fwd`
		//   rel  -> the release re-mints AGAIN, so the echo carries a third id
		//
		// The inbox row always names {wire_message_id: opt, message_id: <newest>},
		// so the alias the host registers is opt -> rel. `opt` stopped being
		// optimistic at the first supersede, and the bubble on screen is `fwd`:
		// unless the alias follows that chain, the echo matches nothing, and with
		// two sends in flight the ordinal fallback refuses to guess — each echo is
		// inserted BESIDE its own bubble and the user sees every prompt twice.
		const store = useSyncStore.getState();
		for (const n of ["1", "2"]) {
			store.optimisticAdd("ses_1", userMessage(`msg_opt${n}`), [
				textPart(`prt_${n}`, `msg_opt${n}`, `prompt ${n}`),
			]);
			store.markOptimisticDispatched("ses_1", `msg_opt${n}`);
			store.markOptimisticInboxBacked("ses_1", `msg_opt${n}`);
			// First delivery: the row names the re-minted id before the echo lands.
			store.registerOptimisticEcho("ses_1", `msg_opt${n}`, `msg_fwd${n}`);
			store.applyEvent({
				type: "message.updated",
				properties: { info: userMessage(`msg_fwd${n}`) },
			} as never);
		}
		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_fwd1",
			"msg_fwd2",
		]);

		// Stop: the settle takes both copies back out of OpenCode.
		for (const n of ["1", "2"]) {
			store.applyEvent({
				type: "message.removed",
				properties: { sessionID: "ses_1", messageID: `msg_fwd${n}` },
			} as never);
		}
		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_fwd1",
			"msg_fwd2",
		]);

		// Release: the row re-mints once more and names the new id against the
		// SAME wire id it has always reported.
		for (const n of ["1", "2"]) {
			store.registerOptimisticEcho("ses_1", `msg_opt${n}`, `msg_rel${n}`);
		}
		for (const n of ["1", "2"]) {
			store.applyEvent({
				type: "message.updated",
				properties: { info: userMessage(`msg_rel${n}`) },
			} as never);
		}
		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_rel1",
			"msg_rel2",
		]);
		// And the host's key for each bubble still points at the id it painted.
		expect(useSyncStore.getState().optimisticOriginOf("ses_1", "msg_rel1")).toBe("msg_opt1");
		expect(useSyncStore.getState().optimisticOriginOf("ses_1", "msg_rel2")).toBe("msg_opt2");
	});

	test("message.removed for a message nobody owns still removes it", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_x"));
		store.applyEvent({
			type: "message.removed",
			properties: { sessionID: "ses_1", messageID: "msg_x" },
		} as never);
		expect(useSyncStore.getState().messages.ses_1).toEqual([]);
	});
});

// ============================================================================
// Ids are not a chronology.
//
// OpenCode 1.18.15 retired the invariant that message ids ascend with time:
// turn exit reads `lastAssistant.parentID === lastUser.id`, and
// `MessageV2.latest()` orders by `time.created` with the id only as a
// tie-break. `MessageV2.page()` — the endpoint every transcript read comes
// from — has ALWAYS ordered by `time_created` in both versions, so the store's
// job is to PRESERVE the page order, never to re-derive one from id strings.
// ============================================================================

/** A message whose id deliberately disagrees with its position in time. */
function timedUser(id: string, created: number, sessionID = "ses_1"): UserMessage {
	return { ...userMessage(id, sessionID), time: { created } };
}

/** An assistant message carrying NO `parentID` — the legacy wire shape the
 *  `m.id > parentId` comparison existed for. */
function parentlessAssistant(id: string, created: number, sessionID = "ses_1"): AssistantMessage {
	const { parentID: _parentID, ...rest } = assistantMessage(id, sessionID);
	return { ...rest, time: { created } } as AssistantMessage;
}

describe("hydrate preserves the server's page order", () => {
	test("a page whose ids descend is stored exactly as the server sent it", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: timedUser("msg_zz", 10), parts: [] },
			{ info: timedUser("msg_aa", 20), parts: [] },
		]);

		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_zz",
			"msg_aa",
		]);
	});

	test("a locally-known message the page lacks is placed by time, not by id", () => {
		const store = useSyncStore.getState();
		// Arrives over SSE first; the next page read has not caught up with it.
		store.upsertMessage("ses_1", timedUser("msg_aa", 30));
		store.hydrate("ses_1", [
			{ info: timedUser("msg_zz", 10), parts: [] },
			{ info: timedUser("msg_yy", 20), parts: [] },
		]);

		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_zz",
			"msg_yy",
			"msg_aa",
		]);
	});
});

describe("session.error stub reconciliation reads parentID and time, never id order", () => {
	function stageFailedTurn(userId: string, created: number): string {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", timedUser(userId, created));
		store.applyEvent({
			id: "evt_err",
			type: "session.error",
			properties: {
				sessionID: "ses_1",
				error: { name: "UnknownError", data: { message: "ModelNotFound" } },
			},
		} as never);
		const stub = useSyncStore.getState().messages.ses_1.find((m) => m.id.endsWith("_error"));
		expect(stub).toBeDefined();
		return stub!.id;
	}

	test("the real reply retires the stub even when its id sorts BELOW the prompt's", () => {
		const stubId = stageFailedTurn("msg_user", 10);

		// The turn's own answer, with no `parentID` on the wire and an id that
		// sorts below the prompt. `m.id > parentId` said "not a reply" and left
		// a stale error stub sitting beside the real answer forever.
		useSyncStore.getState().hydrate("ses_1", [
			{ info: timedUser("msg_user", 10), parts: [] },
			{ info: parentlessAssistant("msg_aaa", 20), parts: [] },
		]);

		const ids = useSyncStore.getState().messages.ses_1.map((m) => m.id);
		expect(ids).not.toContain(stubId);
		expect(ids).toContain("msg_aaa");
	});

	test("an EARLIER turn's parentless reply does not retire this turn's stub", () => {
		const stubId = stageFailedTurn("msg_user", 10);

		// An assistant message from a turn that finished BEFORE this prompt, and
		// whose id happens to sort above it. `m.id > parentId` called it this
		// turn's answer and deleted the only record of the failure — the
		// 2026-08-19 `ModelNotFound` report, where the turn rendered nothing.
		useSyncStore.getState().hydrate("ses_1", [
			{ info: parentlessAssistant("msg_zzz", 5), parts: [] },
			{ info: timedUser("msg_user", 10), parts: [] },
		]);

		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toContain(stubId);
	});
});

describe("the confirmed echo lands where the server put it", () => {
	test("message.updated inserts the real message by time, not at a binary index", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: timedUser("msg_zz", 10), parts: [] },
			{ info: parentlessAssistant("msg_yy", 20), parts: [] },
		]);
		store.optimisticAdd("ses_1", timedUser("msg_opt", 30), [
			textPart("prt_opt", "msg_opt", "next prompt"),
		]);
		store.markOptimisticDispatched("ses_1", "msg_opt");

		store.applyEvent({
			type: "message.updated",
			properties: { info: timedUser("msg_aa", 30) },
		} as never);

		expect(useSyncStore.getState().messages.ses_1.map((m) => m.id)).toEqual([
			"msg_zz",
			"msg_yy",
			"msg_aa",
		]);
	});
});

describe("a committed revert deletes the captured set, not a string range", () => {
	test("a reverted reply whose id sorts below the boundary is still deleted", () => {
		const store = useSyncStore.getState();
		store.hydrate("ses_1", [
			{ info: timedUser("msg_c", 10), parts: [] },
			{ info: timedUser("msg_b", 20), parts: [textPart("prt_b", "msg_b", "edited away")] },
			{ info: parentlessAssistant("msg_a", 30), parts: [] },
		]);
		store.stageSessionRevert("ses_1", "msg_b");

		store.applyEvent({
			type: "session.next.revert.committed",
			properties: { sessionID: "ses_1", messageID: "msg_b" },
		} as never);

		const state = useSyncStore.getState();
		expect(state.messages.ses_1?.map((m) => m.id)).toEqual(["msg_c"]);
		expect(state.parts.msg_b).toBeUndefined();
	});
});

describe("a streamed delta counts as runtime activity", () => {
	// `projectWorking` ranks "the runtime produced output"
	// (`sessionActivityAt`) FIRST — above the `/turn` ledger, which lags and,
	// on pi, leaves rows open. Only `message.part.updated` used to stamp it.
	// That was harmless while every runtime streamed snapshots; it stopped
	// being harmless when pi began sending real deltas (~280 deltas and ~6
	// snapshots per answer), because the stamp then went stale mid-generation
	// and the composer showed Stop off a poll instead of off the stream.
	test("message.part.delta stamps sessionActivityAt", () => {
		const sid = "ses_delta_activity";
		useSyncStore.setState({ sessionActivityAt: {}, messages: {}, parts: {} });
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeUndefined();

		useSyncStore.getState().applyEvent({
			type: "message.part.delta",
			properties: {
				sessionID: sid,
				messageID: "msg_1",
				partID: "msg_1-p0",
				field: "text",
				delta: "Hello",
			},
		} as never);

		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeGreaterThan(0);
	});

	test("a delta with no sessionID cannot stamp anything", () => {
		useSyncStore.setState({ sessionActivityAt: {}, messages: {}, parts: {} });
		useSyncStore.getState().applyEvent({
			type: "message.part.delta",
			properties: { messageID: "msg_1", partID: "msg_1-p0", field: "text", delta: "x" },
		} as never);
		expect(Object.keys(useSyncStore.getState().sessionActivityAt)).toHaveLength(0);
	});
});

describe("replayed frames are history, not live output", () => {
	// The stream replays the `since=` backlog on every connect — a reconnect,
	// and every page load. Stamping that replay with `Date.now()` made it look
	// like the runtime producing output NOW: `projectWorking` ranks activity
	// above everything, so opening a session whose answer had finished long
	// before pinned the composer on Stop for the full 45s observation window.
	test("activity is stamped with the frame's own emit time, not now", () => {
		const sid = "ses_replay";
		const longAgo = Date.now() - 10 * 60_000;
		useSyncStore.setState({ sessionActivityAt: {}, messages: {}, parts: {} });

		useSyncStore.getState().applyEvent({
			type: "message.part.delta",
			at: longAgo,
			properties: {
				sessionID: sid,
				messageID: "msg_1",
				partID: "msg_1-p0",
				field: "text",
				delta: "old",
			},
		} as never);

		const stamped = useSyncStore.getState().sessionActivityAt[sid];
		expect(stamped).toBe(longAgo);
		// The point: it must NOT read as fresh.
		expect(Date.now() - (stamped ?? 0)).toBeGreaterThan(60_000);
	});

	test("a live frame with no emit time still stamps now", () => {
		const sid = "ses_live_nostamp";
		useSyncStore.setState({ sessionActivityAt: {}, messages: {}, parts: {} });
		const before = Date.now();
		useSyncStore.getState().applyEvent({
			type: "message.part.delta",
			properties: {
				sessionID: sid,
				messageID: "msg_1",
				partID: "msg_1-p0",
				field: "text",
				delta: "x",
			},
		} as never);
		expect(useSyncStore.getState().sessionActivityAt[sid]).toBeGreaterThanOrEqual(before);
	});
});

describe("a replayed STATUS frame is history too", () => {
	// The activity stamp was only half of it. `streamAnswers` in projectWorking
	// reads `sessionStatusAt`, and that was also `Date.now()` — so a stale
	// `running` status replayed from the since= backlog read as a FRESH
	// observation and returned working/stream, which is what kept the Stop
	// button up on a session whose answer had finished the day before
	// (pi.kortix.com, 6/6 samples on a freshly loaded settled session).
	test("a replayed running status is stamped old, not now", () => {
		const sid = "ses_replay_status";
		const longAgo = Date.now() - 10 * 60_000;
		useSyncStore.setState({ sessionStatus: {}, sessionStatusAt: {}, sessionStatusOrigin: {} });

		useSyncStore.getState().applyEvent({
			type: "session.status",
			at: longAgo,
			properties: { sessionID: sid, status: { type: "running" } },
		} as never);

		expect(useSyncStore.getState().sessionStatusAt[sid]).toBe(longAgo);
	});

	test("a status with no emit time still stamps now", () => {
		const sid = "ses_live_status";
		useSyncStore.setState({ sessionStatus: {}, sessionStatusAt: {}, sessionStatusOrigin: {} });
		const before = Date.now();
		useSyncStore.getState().applyEvent({
			type: "session.status",
			properties: { sessionID: sid, status: { type: "running" } },
		} as never);
		expect(useSyncStore.getState().sessionStatusAt[sid]).toBeGreaterThanOrEqual(before);
	});
});
