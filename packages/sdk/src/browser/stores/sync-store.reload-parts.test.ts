/**
 * A page reload in the middle of a streaming step.
 *
 * OpenCode persists an open text or reasoning part EMPTY until the part ends,
 * and a `message.part.delta` frame names no part type. So after a reload the
 * store meets the open step from two sides at once: deltas for a part it has
 * never seen (the stub the delta handler creates is typed `text`, because the
 * frame carries no type), and a transcript page that names the real type but
 * may carry no text (or, from a runtime that overlays the streamed text, a
 * snapshot that overlaps the deltas already applied).
 *
 * These tests pin the rules that keep the reloaded step honest:
 *  - the SERVER names a part's type — a delta stub never turns reasoning into
 *    reply text;
 *  - an ENDED (`time.end`) snapshot is the complete text and always wins;
 *  - the streamed text and the page's snapshot merge without a duplicated or
 *    dropped span.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	Part,
	ReasoningPart,
	TextPart,
	UserMessage,
} from "@opencode-ai/sdk/v2/client";
import { useSyncStore } from "./sync-store";

const SID = "ses_reload";
const USER = "msg_0000000000010000000000";
const ASST = "msg_0000000000020000000000";

function userMessage(): UserMessage {
	return {
		id: USER,
		sessionID: SID,
		role: "user",
		time: { created: 1 },
		agent: "build",
		model: { providerID: "p", modelID: "m" },
	};
}

function assistantMessage(): AssistantMessage {
	return {
		id: ASST,
		sessionID: SID,
		role: "assistant",
		time: { created: 2 },
		parentID: USER,
		modelID: "m",
		providerID: "p",
		mode: "build",
		agent: "build",
		path: { cwd: "/", root: "/" },
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	};
}

function reasoning(id: string, text: string, time: { start: number; end?: number }): ReasoningPart {
	return { id, sessionID: SID, messageID: ASST, type: "reasoning", text, time };
}

function text(id: string, body: string, time?: { start: number; end?: number }): TextPart {
	return { id, sessionID: SID, messageID: ASST, type: "text", text: body, ...(time ? { time } : {}) };
}

let eventSeq = 0;
function delta(partID: string, chunk: string) {
	useSyncStore.getState().applyEvent({
		id: `evt_${++eventSeq}`,
		type: "message.part.delta",
		properties: { sessionID: SID, messageID: ASST, partID, field: "text", delta: chunk },
	} as never);
}

function partUpdated(part: Part) {
	useSyncStore.getState().applyEvent({
		id: `evt_${++eventSeq}`,
		type: "message.part.updated",
		properties: { sessionID: SID, part },
	} as never);
}

function hydrate(parts: Part[]) {
	useSyncStore.getState().hydrate(SID, [
		{ info: userMessage(), parts: [] },
		{ info: assistantMessage(), parts },
	]);
}

function part(id: string): Part | undefined {
	return useSyncStore.getState().parts[ASST]?.find((p) => p.id === id);
}

beforeEach(() => {
	useSyncStore.getState().reset();
	useSyncStore.getState().hydrate(SID, [{ info: userMessage(), parts: [] }]);
});

describe("reload mid-step — the server names a part's type, a delta stub never does", () => {
	test("hydrate re-types a delta stub as the reasoning the page names, and keeps the streamed words", () => {
		// Reload while the model is thinking: the reconnected stream delivers
		// reasoning deltas for a part this tab has never seen.
		delta("prt_r", "so the second option ");
		delta("prt_r", "is cheaper.");
		// The page read lands: the part is reasoning, open, persisted empty.
		hydrate([reasoning("prt_r", "", { start: 100 })]);

		const r = part("prt_r");
		expect(r?.type).toBe("reasoning");
		expect((r as ReasoningPart).text).toBe("so the second option is cheaper.");
		expect((r as ReasoningPart).time).toEqual({ start: 100 });
	});

	test("the ended reasoning snapshot replaces a delta stub even though the stub's text is only a fragment", () => {
		delta("prt_r", "second option is cheaper.");
		// No hydrate in between: the part ends first.
		partUpdated(reasoning("prt_r", "First, list them. The second option is cheaper.", { start: 100, end: 200 }));

		const r = part("prt_r");
		expect(r?.type).toBe("reasoning");
		expect((r as ReasoningPart).text).toBe("First, list them. The second option is cheaper.");
		expect((r as ReasoningPart).time.end).toBe(200);
	});

	test("after hydrate re-typed it, the ended snapshot still lands", () => {
		delta("prt_r", "second option is cheaper.");
		hydrate([reasoning("prt_r", "", { start: 100 })]);
		partUpdated(reasoning("prt_r", "First, list them. The second option is cheaper.", { start: 100, end: 200 }));

		const r = part("prt_r") as ReasoningPart;
		expect(r.type).toBe("reasoning");
		expect(r.text).toBe("First, list them. The second option is cheaper.");
		expect(r.time.end).toBe(200);
	});
});

describe("reload mid-step — an ended snapshot is the complete text", () => {
	test("hydrate takes the ENDED page text over longer streamed text", () => {
		partUpdated(text("prt_t", "", { start: 1 }));
		delta("prt_t", "Done.  \n");
		hydrate([text("prt_t", "Done.", { start: 1, end: 2 })]);
		expect((part("prt_t") as TextPart).text).toBe("Done.");
		expect((part("prt_t") as TextPart).time?.end).toBe(2);
	});

	test("message.part.updated with time.end replaces streamed text that is not its prefix", () => {
		partUpdated(text("prt_t", "", { start: 1 }));
		delta("prt_t", "Done.  \n");
		partUpdated(text("prt_t", "Done.", { start: 1, end: 2 }));
		expect((part("prt_t") as TextPart).text).toBe("Done.");
	});

	test("an open snapshot never reopens a part the store already holds as ended", () => {
		partUpdated(text("prt_t", "All of it.", { start: 1, end: 2 }));
		hydrate([text("prt_t", "All", { start: 1 })]);
		expect((part("prt_t") as TextPart).text).toBe("All of it.");
		expect((part("prt_t") as TextPart).time?.end).toBe(2);
	});
});

describe("reload mid-step — the page's in-flight text and the live deltas merge exactly", () => {
	test("a fragment the stream delivered before the page read is joined onto the page's text at their overlap", () => {
		// Stream connected first: it saw only the tail of the answer so far.
		delta("prt_t", "world, and ");
		delta("prt_t", "more");
		// The page (read after the stream connected) carries the answer up to
		// its read time — which overlaps the fragment's beginning.
		hydrate([text("prt_t", "Hello world, and", { start: 1 })]);
		expect((part("prt_t") as TextPart).text).toBe("Hello world, and more");
		// Live deltas keep appending after the merge.
		delta("prt_t", " again.");
		expect((part("prt_t") as TextPart).text).toBe("Hello world, and more again.");
	});

	test("a page that is AHEAD of the stream never makes the in-flight deltas land twice", () => {
		partUpdated(text("prt_t", "", { start: 1 }));
		delta("prt_t", "Hello world");
		// The runtime read raced ahead of the frames still in flight to this tab.
		hydrate([text("prt_t", "Hello world and beyond", { start: 1 })]);
		delta("prt_t", " and beyond");
		expect((part("prt_t") as TextPart).text).toBe("Hello world and beyond");
	});

	test("a fragment wholly inside the page's text keeps the tab's stream position", () => {
		delta("prt_t", "world");
		hydrate([text("prt_t", "Hello world and beyond", { start: 1 })]);
		delta("prt_t", " and beyond");
		expect((part("prt_t") as TextPart).text).toBe("Hello world and beyond");
	});

	test("a fragment with no overlap is kept after the page's text, and the ended snapshot repairs the gap", () => {
		delta("prt_t", "later words");
		hydrate([text("prt_t", "Early words. ", { start: 1 })]);
		expect((part("prt_t") as TextPart).text).toBe("Early words. later words");
		partUpdated(text("prt_t", "Early words. Middle words. later words", { start: 1, end: 2 }));
		expect((part("prt_t") as TextPart).text).toBe("Early words. Middle words. later words");
	});

	test("with no live stream for the part, the page's in-flight text is taken as-is", () => {
		hydrate([text("prt_t", "", { start: 1 })]);
		hydrate([text("prt_t", "Partial answer", { start: 1 })]);
		expect((part("prt_t") as TextPart).text).toBe("Partial answer");
	});

	test("a later page read that is persisted EMPTY never erases the streamed answer", () => {
		partUpdated(text("prt_t", "", { start: 1 }));
		delta("prt_t", "Streaming answer");
		hydrate([text("prt_t", "", { start: 1 })]);
		expect((part("prt_t") as TextPart).text).toBe("Streaming answer");
	});
});

describe("an ended part takes no more deltas", () => {
	test("deltas still in flight when the ended snapshot lands are not appended to the complete text", () => {
		partUpdated(text("prt_t", "", { start: 1 }));
		delta("prt_t", "P1: Rome ");
		// The tab lags the runtime: the part ends (a stop, or text-end) while
		// deltas it already contains are still on their way here.
		partUpdated(text("prt_t", "P1: Rome grew. P2: It fell.", { start: 1, end: 2 }));
		delta("prt_t", "grew. ");
		delta("prt_t", "P2: It fell.");
		expect((part("prt_t") as TextPart).text).toBe("P1: Rome grew. P2: It fell.");
	});
});
