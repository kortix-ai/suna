import { describe, expect, test } from "bun:test";
import { hasRetryingAssistantTurn } from "../../core/turns/open-turn";
import type { SessionTranscriptSyncEnvelope } from "../../core/rest/projects-client/sessions";
import {
	mirrorMessagesForHydrate,
	shouldHydrateFromMirror,
} from "./server-transcript-mirror";

const ROOT = "ses_root";

function envelope(over: Partial<SessionTranscriptSyncEnvelope> = {}): SessionTranscriptSyncEnvelope {
	return {
		available: true,
		reason: null,
		source: "mirror",
		complete: true,
		captured_at: "2026-08-26T06:00:00.000Z",
		opencode_session_id: ROOT,
		message_count: 2,
		messages: [
			{
				info: { id: "msg_1", sessionID: ROOT, role: "user", time: { created: 1000 } },
				parts: [{ id: "prt_1", sessionID: ROOT, messageID: "msg_1", type: "text", text: "ping" }],
			},
			{
				info: {
					id: "msg_2",
					sessionID: ROOT,
					role: "assistant",
					parentID: "msg_1",
					time: { created: 1100, completed: 1200 },
				},
				parts: [
					{ id: "prt_2", sessionID: ROOT, messageID: "msg_2", type: "text", text: "pong" },
				],
			},
		],
		...over,
	};
}

describe("shouldHydrateFromMirror", () => {
	test("a mirror for THIS runtime root, into an empty store, is painted", () => {
		expect(
			shouldHydrateFromMirror({
				envelope: envelope(),
				runtimeSessionId: ROOT,
				hasMessages: false,
			}),
		).toBe(true);
	});

	test("a mirror for a DIFFERENT root is refused", () => {
		// This is the identity guard the deleted disk cache could not make. Its
		// key was a scope string, so a re-pinned box (a restart adopting a new
		// OpenCode root) painted messages whose ids the live tail will never
		// contain — ghosts the settle rule cannot reconcile, because it only
		// drops what the incoming page COVERS and these sort elsewhere entirely.
		expect(
			shouldHydrateFromMirror({
				envelope: envelope({ opencode_session_id: "ses_other" }),
				runtimeSessionId: ROOT,
				hasMessages: false,
			}),
		).toBe(false);
	});

	test("a store that already holds messages is never overwritten", () => {
		// The live read outranks a snapshot, always. The mirror is a first-paint
		// accelerator and nothing else.
		expect(
			shouldHydrateFromMirror({
				envelope: envelope(),
				runtimeSessionId: ROOT,
				hasMessages: true,
			}),
		).toBe(false);
	});

	test("only source 'mirror' paints — 'none' and an unavailable envelope do not", () => {
		for (const bad of [
			envelope({ source: "none", available: false, messages: [] }),
			envelope({ available: false }),
			envelope({ source: "live" }),
			envelope({ messages: [] }),
			null,
		]) {
			expect(
				shouldHydrateFromMirror({
					envelope: bad,
					runtimeSessionId: ROOT,
					hasMessages: false,
				}),
			).toBe(false);
		}
	});

	test("no runtime root yet means no identity to match, so nothing is painted", () => {
		expect(
			shouldHydrateFromMirror({ envelope: envelope(), runtimeSessionId: "", hasMessages: false }),
		).toBe(false);
	});
});

describe("mirrorMessagesForHydrate", () => {
	test("a message with no id is dropped — an unsettleable id is a ghost", () => {
		const msgs = mirrorMessagesForHydrate(
			envelope({
				messages: [
					{ info: { role: "user" }, parts: [] },
					{ info: { id: "msg_ok", role: "user" }, parts: [] },
				],
			}),
		);
		expect(msgs.map((m) => m.info.id)).toEqual(["msg_ok"]);
	});

	test("parts are id-sorted, because the store's part search assumes it", () => {
		const msgs = mirrorMessagesForHydrate(
			envelope({
				messages: [
					{
						info: { id: "msg_1", role: "user" },
						parts: [
							{ id: "prt_9", messageID: "msg_1", type: "text", text: "b" },
							{ id: "prt_1", messageID: "msg_1", type: "text", text: "a" },
						],
					},
				],
			}),
		);
		expect(msgs[0].parts.map((p) => p.id)).toEqual(["prt_1", "prt_9"]);
	});

	test("THE REGRESSION: a finished turn survives hydration as FINISHED", () => {
		// The deleted disk mirror could not tell a finished turn from a running
		// one: its freshness test read the transcript's SHAPE (message count,
		// part count, tail id), and the two things that end a turn move none of
		// them — `time.completed`, and the `error` a Stop stamps. A stopped
		// thread therefore cold-painted as still running and every message
		// under it dimmed to "Queued". The server mirror carries `info`
		// verbatim; this asserts it arrives intact.
		const msgs = mirrorMessagesForHydrate(envelope());
		expect(msgs[1].info.time).toEqual({ created: 1100, completed: 1200 });
		expect(hasRetryingAssistantTurn(msgs as never)).toBe(false);
	});

	test("an ABORTED turn survives as terminal, not as still running", () => {
		const msgs = mirrorMessagesForHydrate(
			envelope({
				messages: [
					{
						info: {
							id: "msg_2",
							sessionID: ROOT,
							role: "assistant",
							time: { created: 1100 },
							error: { name: "MessageAbortedError", data: { message: "stopped" } },
						},
						parts: [],
					},
				],
			}),
		);
		expect((msgs[0].info as { error?: unknown }).error).toEqual({
			name: "MessageAbortedError",
			data: { message: "stopped" },
		});
		expect(hasRetryingAssistantTurn(msgs as never)).toBe(false);
	});

	test("a RETRYING turn still reads as retrying — the mirror does not flatten it", () => {
		const msgs = mirrorMessagesForHydrate(
			envelope({
				messages: [
					{
						info: {
							id: "msg_2",
							sessionID: ROOT,
							role: "assistant",
							time: { created: 1100 },
							error: { name: "ApiError", data: { isRetryable: true, message: "429" } },
						},
						parts: [],
					},
				],
			}),
		);
		expect(hasRetryingAssistantTurn(msgs as never)).toBe(true);
	});
});

describe("the mirror settles against the runtime instead of duplicating", () => {
	test("a runtime read of the same ids leaves ONE copy of each message", async () => {
		// The whole reason the payload carries OpenCode's real ids. Hydrating
		// with `source: 'cache'` marks them provisional; the first runtime read
		// that contains them confirms them in place. A mirror keyed on anything
		// else would append a second copy of every message the moment the box
		// answered — the ghost the last mirror was deleted for.
		const { useSyncStore } = await import("../stores/sync-store");
		const store = useSyncStore.getState();
		store.clearSession(ROOT);
		const msgs = mirrorMessagesForHydrate(envelope());

		store.hydrate(ROOT, msgs, { source: "cache" });
		expect(useSyncStore.getState().messages[ROOT]?.map((m) => m.id)).toEqual([
			"msg_1",
			"msg_2",
		]);

		// The runtime answers with the same thread.
		useSyncStore.getState().hydrate(ROOT, msgs);
		expect(useSyncStore.getState().messages[ROOT]?.map((m) => m.id)).toEqual([
			"msg_1",
			"msg_2",
		]);
		useSyncStore.getState().clearSession(ROOT);
	});

	test("a mirrored message the runtime's own tail no longer contains is dropped", async () => {
		// Strand repair DELETEs a message from the OpenCode thread, so a mirror
		// written before that repair can hold one the runtime does not. The
		// existing settle rule already answers this and needs no extension: a
		// provisional id the incoming page COVERS but does not contain is a
		// phantom.
		const { useSyncStore } = await import("../stores/sync-store");
		const store = useSyncStore.getState();
		store.clearSession(ROOT);
		store.hydrate(ROOT, mirrorMessagesForHydrate(envelope()), { source: "cache" });

		const live = mirrorMessagesForHydrate(
			envelope({ messages: envelope().messages.slice(0, 1) }),
		);
		useSyncStore.getState().hydrate(ROOT, live);
		expect(useSyncStore.getState().messages[ROOT]?.map((m) => m.id)).toEqual(["msg_1"]);
		useSyncStore.getState().clearSession(ROOT);
	});
});
