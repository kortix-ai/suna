import { afterEach, beforeEach, expect, test } from "bun:test";
import { configureKortix } from "../../http/config";
import {
  fetchSessionAttachment,
  findSessionAttachments,
  uploadSessionAttachment,
} from "./session-attachments";

const projectId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const attachmentId = "33333333-3333-4333-8333-333333333333";
const ref = `kortix-attachment://${projectId}/${sessionId}/${attachmentId}`;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  configureKortix({
    backendUrl: "https://api.test/v1",
    getToken: async () => "test-token",
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("uploads bytes to the session API without binding or starting a runtime", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(String(url));
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    expect(init?.method).toBe("POST");
    const body = init?.body as FormData;
    expect(body.get("attachment_id")).toBe(attachmentId);
    const file = body.get("file") as File;
    expect(file.name).toBe("notes.txt");
    expect(await file.text()).toBe("saved before wake");
    return Response.json({
      attachment_id: attachmentId,
      url: ref,
      filename: "notes.txt",
      mime: "text/plain",
      size: file.size,
    });
  }) as typeof fetch;
  const result = await uploadSessionAttachment(
    projectId,
    sessionId,
    new File(["saved before wake"], "notes.txt", { type: "text/plain" }),
    { attachmentId },
  );
  expect(result.url).toBe(ref);
  expect(requests).toEqual([
    `https://api.test/v1/projects/${projectId}/sessions/${sessionId}/attachments`,
  ]);
});

test("reads saved attachment bytes with authentication and no runtime", async () => {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(
      `https://api.test/v1/projects/${projectId}/sessions/${sessionId}/attachments/${attachmentId}`,
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    return new Response(new TextEncoder().encode("saved file"), {
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  }) as typeof fetch;
  const blob = await fetchSessionAttachment(ref);
  expect(await blob.text()).toBe("saved file");
  expect(blob.type).toBe("text/plain;charset=utf-8");
});

test("rejects external and traversal references before sending credentials", async () => {
  globalThis.fetch = (() => {
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  for (const value of [
    "https://outside.test/file",
    `kortix-attachment://${projectId}/../${attachmentId}`,
  ]) {
    await expect(fetchSessionAttachment(value)).rejects.toThrow(
      "Invalid attachment reference",
    );
  }
});

test("rejects files over 50 MiB before uploading", async () => {
  globalThis.fetch = (() => {
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  await expect(
    uploadSessionAttachment(
      projectId,
      sessionId,
      new File([new Uint8Array(50 * 1024 * 1024 + 1)], "large.zip"),
      { attachmentId },
    ),
  ).rejects.toThrow("50 MiB");
});

test("reuses successful uploads and retry IDs only within the same session", async () => {
  const calls: Array<{ url: string; id: string }> = [];
  let fail = true;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const id = (init!.body as FormData).get("attachment_id") as string;
    calls.push({ url: String(url), id });
    if (fail) return Response.json({ error: "offline" }, { status: 400 });
    return Response.json({
      attachment_id: id,
      url: ref,
      filename: "notes.txt",
      mime: "text/plain",
      size: 5,
    });
  }) as typeof fetch;
  const file = new File(["hello"], "notes.txt");
  await expect(
    uploadSessionAttachment(projectId, sessionId, file),
  ).rejects.toThrow();
  fail = false;
  await uploadSessionAttachment(projectId, sessionId, file);
  await uploadSessionAttachment(projectId, sessionId, file);
  await uploadSessionAttachment(projectId, attachmentId, file);
  expect(calls).toHaveLength(3);
  expect(calls[1]!.id).toBe(calls[0]!.id);
  expect(calls[2]!.id).not.toBe(calls[0]!.id);
  expect(calls[2]!.url).toContain(`/sessions/${attachmentId}/attachments`);
});

test('accepts a 30 MiB saved file under the shared 50 MiB composer limit', async () => {
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const file = (init!.body as FormData).get('file') as File;
    expect(file.size).toBe(30 * 1024 * 1024);
    return Response.json({ attachment_id: attachmentId, filename: file.name, mime: file.type, size: file.size, url: ref });
  }) as typeof fetch;
  const result = await uploadSessionAttachment(projectId, sessionId, new File([new Uint8Array(30 * 1024 * 1024)], 'large.zip', { type: 'application/zip' }), { attachmentId });
  expect(result.size).toBe(30 * 1024 * 1024);
});

// ── findSessionAttachments ─────────────────────────────────────────────────

const refB = `kortix-attachment://${projectId}/${sessionId}/44444444-4444-4444-8444-444444444444`;
const refC = `kortix-attachment://${projectId}/${sessionId}/55555555-5555-4555-8555-555555555555`;

test("finds every stored attachment a transcript references, in order", () => {
  const found = findSessionAttachments([
    {
      info: { id: "msg_user", role: "user" },
      parts: [
        { id: "p1", type: "file", filename: "photo.png", mime: "image/png", url: ref },
        {
          id: "p2",
          type: "text",
          text: `Read this. <file path="/workspace/uploads/R&amp;D.txt" mime="text/plain" filename="R&amp;D.txt" attachment="${refB}">Uploaded</file>`,
        },
      ],
    },
    {
      info: { id: "msg_agent", role: "assistant" },
      parts: [
        { id: "p3", type: "text", text: "Here is the chart." },
        {
          id: "p4",
          type: "tool",
          tool: "show",
          state: {
            status: "completed",
            input: { type: "image", path: "/workspace/out/revenue.png", attachment: refC },
          },
        },
      ],
    },
  ]);
  expect(found).toEqual([
    { url: ref, attachment_id: attachmentId, filename: "photo.png", mime: "image/png", message_id: "msg_user", role: "user" },
    {
      url: refB,
      attachment_id: "44444444-4444-4444-8444-444444444444",
      filename: "R&D.txt",
      mime: "text/plain",
      message_id: "msg_user",
      role: "user",
    },
    {
      url: refC,
      attachment_id: "55555555-5555-4555-8555-555555555555",
      filename: "revenue.png",
      mime: null,
      message_id: "msg_agent",
      role: "assistant",
    },
  ]);
});

test("finds every item of a shown carousel, from an array or a JSON string", () => {
  const found = findSessionAttachments([
    {
      info: { id: "m", role: "assistant" },
      parts: [
        {
          id: "p",
          type: "tool",
          tool: "oc-show",
          state: {
            status: "completed",
            input: {
              items: JSON.stringify([
                { type: "image", path: "/workspace/a.png", attachment: refB },
                { type: "url", url: "https://example.test" },
                { type: "pdf", path: "/workspace/r.pdf", attachment: refC },
              ]),
            },
          },
        },
      ],
    },
  ]);
  expect(found.map((a) => [a.filename, a.url])).toEqual([
    ["a.png", refB],
    ["r.pdf", refC],
  ]);
});

test("anything that is not a stored reference is ignored", () => {
  // Inline bytes, a sandbox path, and a look-alike are not attachments this
  // session holds: a download of them would fail or fetch something else.
  const found = findSessionAttachments([
    {
      info: { id: "m", role: "user" },
      parts: [
        { id: "a", type: "file", filename: "x.png", url: "data:image/png;base64,AAAA" },
        { id: "b", type: "file", filename: "y.png", url: "/workspace/y.png" },
        { id: "c", type: "file", filename: "z.png", url: "kortix-attachment://not/a/ref" },
        { id: "d", type: "text", text: '<file path="/workspace/q.txt" filename="q.txt">x</file>' },
        {
          id: "e",
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { attachment: ref } },
        },
      ],
    },
  ]);
  expect(found).toEqual([]);
});

test("the same stored file referenced twice is listed once", () => {
  const found = findSessionAttachments([
    {
      info: { id: "m1", role: "user" },
      parts: [{ id: "a", type: "file", filename: "photo.png", mime: "image/png", url: ref }],
    },
    {
      info: { id: "m2", role: "user" },
      parts: [{ id: "b", type: "file", filename: "photo.png", mime: "image/png", url: ref }],
    },
  ]);
  expect(found).toHaveLength(1);
  expect(found[0]!.message_id).toBe("m1");
});

test("a malformed transcript yields nothing rather than throwing", () => {
  expect(findSessionAttachments(null as never)).toEqual([]);
  expect(
    findSessionAttachments([
      null,
      "x",
      { info: null, parts: [] },
      { info: { id: "m", role: "user" }, parts: "nope" },
      { info: { id: "m", role: "user" }, parts: [null, 7, { type: "file" }] },
    ] as never),
  ).toEqual([]);
});

test("a pathological message cannot stall the scan", () => {
  // `findSessionAttachments` reads user text, which a user wrote. A regex of
  // the shape `<file\s+([^>]*?)>` is quadratic on `<file` + whitespace with no
  // `>` (CodeQL js/polynomial-redos) — ~10 s on this input.
  const evil = `${"<file\t".repeat(40_000)}<file${"\t".repeat(200_000)}`;
  const started = performance.now();
  const found = findSessionAttachments([
    { info: { id: "m", role: "user" }, parts: [{ id: "p", type: "text", text: evil }] },
  ]);
  expect(performance.now() - started).toBeLessThan(100);
  expect(found).toEqual([]);
});

test("a <file> tag inside another file's body is not a second reference", () => {
  // The body of a tag is file CONTENT. A document that mentions a tag in its
  // text must not have that mention read as an attachment of the session.
  const found = findSessionAttachments([
    {
      info: { id: "m", role: "user" },
      parts: [
        {
          id: "p",
          type: "text",
          text: `<file path="/w/outer.txt" filename="outer.txt" attachment="${ref}">see <file path="/w/x" attachment="${refB}"> here</file> after`,
        },
      ],
    },
  ]);
  expect(found.map((a) => a.url)).toEqual([ref]);
});
