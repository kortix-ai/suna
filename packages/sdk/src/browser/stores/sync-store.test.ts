import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	Message,
	Part,
	TextPart,
	UserMessage,
} from "@opencode-ai/sdk/v2/client";
import { ascendingId, Binary, useSyncStore } from "./sync-store";

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
	test("inserts messages sorted by id, not by call order", () => {
		const store = useSyncStore.getState();
		store.upsertMessage("ses_1", userMessage("msg_b"));
		store.upsertMessage("ses_1", userMessage("msg_a"));
		store.upsertMessage("ses_1", userMessage("msg_c"));

		const ids = useSyncStore.getState().messages.ses_1.map((m) => m.id);
		expect(ids).toEqual(["msg_a", "msg_b", "msg_c"]);
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
	getItem(key: string): string | null {
		return this.map.has(key) ? (this.map.get(key) ?? null) : null;
	}
	setItem(key: string, value: string): void {
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

	test("message.part.delta accumulates text and writes the running total to sessionStorage", () => {
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
