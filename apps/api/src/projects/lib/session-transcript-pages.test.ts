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

test("a repeated cursor fails instead of looping or claiming a complete history", async () => {
  await expect(
    readTranscriptPages(async () => page([1], "same"), true),
  ).rejects.toThrow("cursor");
});

test("a failed older page rejects the capture instead of replacing good stored history", async () => {
  let reads = 0;
  await expect(
    readTranscriptPages(
      async () =>
        ++reads === 1 ? page([2], "older") : new Response("", { status: 503 }),
      true,
    ),
  ).rejects.toThrow("503");
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
