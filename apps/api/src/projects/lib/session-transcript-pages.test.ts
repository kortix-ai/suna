import { expect, test } from "bun:test";
import {
  readTranscriptPages,
  retryTranscriptCapture,
} from "./session-transcript-pages";

const page = (ids: number[], next?: string) =>
  Response.json(
    ids.map((id) => ({
      info: {
        id: `msg_${id}`,
        role: "assistant",
        time: { created: id, completed: id + 1 },
      },
      parts: [{ id: `p_${id}`, type: "text", text: `reply ${id}` }],
    })),
    { headers: next ? { "x-next-cursor": next } : {} },
  );

test("full capture follows every cursor and keeps messages beyond the old tail limit", async () => {
  const cursors: Array<string | undefined> = [];
  const pages = [page([5, 6], "older"), page([3, 4], "oldest"), page([1, 2])];
  const result = await readTranscriptPages(async (cursor) => {
    cursors.push(cursor);
    return pages.shift()!;
  }, true);
  expect(cursors).toEqual([undefined, "older", "oldest"]);
  expect(result.rows.map((row) => row.info.id)).toEqual([
    "msg_1",
    "msg_2",
    "msg_3",
    "msg_4",
    "msg_5",
    "msg_6",
  ]);
  expect(result.headComplete).toBe(true);
});

test("legacy capture reads one page and does not claim it is complete", async () => {
  let reads = 0;
  const result = await readTranscriptPages(async () => {
    reads++;
    return page([5, 6], "older");
  }, false);
  expect(reads).toBe(1);
  expect(result.headComplete).toBe(false);
});

test("a repeated cursor stops the walk instead of looping, and claims nothing", async () => {
  // CHANGED EXPECTATION, deliberately. This used to assert a throw. The two
  // things it protects — do not loop, do not claim a complete history — are
  // both still asserted here; discarding the pages that landed was never one
  // of them, and a repeat can only be seen with a page already in hand.
  let reads = 0;
  const result = await readTranscriptPages(async () => {
    reads += 1;
    if (reads > 5) throw new Error("looped");
    return page([1], "same");
  }, true);
  expect(reads).toBe(2);
  expect(result.headComplete).toBe(false);
  expect(result.complete).toBe(false);
  expect(result.rows.map((row) => row.info.id)).toEqual(["msg_1"]);
});

test("a repeated cursor AFTER pages landed keeps them instead of looping", async () => {
  let reads = 0;
  const result = await readTranscriptPages(async () => {
    reads += 1;
    return reads === 1 ? page([3, 4], "older") : page([1, 2], "older");
  }, true);
  expect(result.rows.map((row) => row.info.id)).toEqual([
    "msg_1",
    "msg_2",
    "msg_3",
    "msg_4",
  ]);
  expect(result.complete).toBe(false);
});

test("a failed older page keeps the pages that were read and says it is incomplete", async () => {
  // CHANGED EXPECTATION, deliberately. This used to reject, because the writer
  // deleted the session's whole history before re-inserting: a partial read
  // there would have REPLACED good stored history with a fragment. The writer
  // now merges and only deletes ids a COMPLETE read proves are gone, so a
  // partial read can no longer destroy anything — and throwing away the pages
  // it did read means the newest turn stays unmirrored until some later
  // capture happens to succeed.
  let reads = 0;
  const result = await readTranscriptPages(
    async () =>
      ++reads === 1 ? page([2], "older") : new Response("", { status: 503 }),
    true,
  );
  expect(result.rows.map((row) => row.info.id)).toEqual(["msg_2"]);
  expect(result.complete).toBe(false);
  expect(result.headComplete).toBe(false);
});

test("a FIRST page that fails still throws — nothing was read at all", async () => {
  // Distinct from the case above: no page landed, so there is nothing to keep
  // and the box is simply unreachable. That is what the capture retries.
  await expect(
    readTranscriptPages(async () => new Response("", { status: 503 }), true),
  ).rejects.toThrow("503");
});

test("a complete walk reports complete", async () => {
  const pages = [page([3, 4], "older"), page([1, 2])];
  const result = await readTranscriptPages(async () => pages.shift()!, true);
  expect(result.complete).toBe(true);
  expect(result.headComplete).toBe(true);
});

test("a bounded tail read is not complete — it never tried to reach the head", async () => {
  const result = await readTranscriptPages(async () => page([5, 6], "older"), false);
  expect(result.complete).toBe(false);
  expect(result.headComplete).toBe(false);
});

test("overlapping pages preserve the newest copy of each message once", async () => {
  const pages = [page([2, 3], "older"), page([1, 2])];
  const result = await readTranscriptPages(async () => pages.shift()!, true);
  expect(result.rows.map((row) => row.info.id)).toEqual([
    "msg_1",
    "msg_2",
    "msg_3",
  ]);
});

test("capture retries transient read and write failures with bounded backoff", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retryTranscriptCapture(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("database unavailable");
      if (attempts === 2) return null;
      return { captured: 120 };
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  expect(result).toEqual({ captured: 120 });
  expect(attempts).toBe(3);
  expect(waits).toEqual([250, 500]);
});

test("capture reports failure after three attempts without an infinite retry", async () => {
  let attempts = 0;
  await expect(
    retryTranscriptCapture(
      async () => {
        attempts++;
        throw new Error("offline");
      },
      async () => {},
    ),
  ).rejects.toThrow("offline");
  expect(attempts).toBe(3);
});

test("prepares attachment bytes before sanitizing transcript pages", async () => {
  const url =
    "kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333";
  const result = await readTranscriptPages(
    async () =>
      Response.json([
        {
          info: { id: "msg_file", role: "user" },
          parts: [{ type: "file", url: "data:text/plain;base64,YQ==" }],
        },
      ]),
    true,
    async (messages) => {
      const message = messages[0] as any;
      expect(message.parts[0].url).toBe("data:text/plain;base64,YQ==");
      return [{ ...message, parts: [{ ...message.parts[0], url }] }];
    },
  );
  expect(result.rows[0]!.parts[0]!.url).toBe(url);
});

test("the walk stops at history it already holds, and says so", async () => {
  // Every turn end re-read the WHOLE session. On a 600-message thread that is
  // eight pages against the sandbox, per turn, for the two messages the turn
  // added. Once a page is entirely captured already, everything older is too.
  const pages = [page([9, 10], "p2"), page([7, 8], "p3"), page([5, 6], "p4")];
  let seen = 0;
  const result = await readTranscriptPages(
    async () => pages.shift()!,
    true,
    undefined,
    (rows) => {
      seen += 1;
      // The second page is the one we already have.
      return seen === 2 && rows.length > 0;
    },
  );
  expect(pages).toHaveLength(1);
  expect(result.caughtUp).toBe(true);
  // NOT complete: it never reached the head, so it cannot speak for what the
  // session no longer contains below the rows it read.
  expect(result.complete).toBe(false);
  expect(result.headComplete).toBe(false);
  expect(result.rows.map((row) => row.info.id)).toEqual([
    "msg_7",
    "msg_8",
    "msg_9",
    "msg_10",
  ]);
});

test("a walk nobody stops still reaches the head", async () => {
  const pages = [page([3, 4], "older"), page([1, 2])];
  const result = await readTranscriptPages(
    async () => pages.shift()!,
    true,
    undefined,
    () => false,
  );
  expect(result.caughtUp).toBe(false);
  expect(result.complete).toBe(true);
});

test("an empty page cannot mean caught up", async () => {
  // `every` over nothing is true. A page with no rows says the walk ran past
  // the end, never that the rows below it are already stored.
  const pages = [page([]), page([1, 2])];
  const result = await readTranscriptPages(
    async () => pages.shift() ?? page([1, 2]),
    true,
    undefined,
    (rows) => rows.length === 0,
  );
  expect(result.caughtUp).toBe(false);
});
