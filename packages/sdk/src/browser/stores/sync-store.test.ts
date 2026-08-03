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
		store.applyPartDelta("msg_1", "prt_1", "text", "lo");
		store.applyPartDelta("msg_1", "prt_1", "text", " world");

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

	test("an echoed message with no parts yet still supersedes, and its text is bridged", () => {
		const store = useSyncStore.getState();
		store.optimisticAdd("ses_1", userMessage("msg_client_id"), [
			textPart("prt_shared", "msg_client_id", "hello"),
		]);

		// Parts persistence lags the message: the server has the user message
		// but no parts for it yet. Without the bridge this renders an empty
		// bubble, which is why the original code had one.
		store.hydrate("ses_1", [{ info: userMessage("msg_server_echo"), parts: [] }]);

		const ids = useSyncStore.getState().messages["ses_1"]?.map((m) => m.id) ?? [];
		expect(ids).not.toContain("msg_client_id");
		expect(useSyncStore.getState().parts["msg_server_echo"]?.[0]).toMatchObject({ text: "hello" });
	});
});
