import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createKortix } from "./kortix";

const originalFetch = globalThis.fetch;
const data = new Uint8Array([0, 255, 10, 128]);
const digest = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");
const calls: Request[] = [];
let reply: (request: Request) => Response;
const kortix = createKortix({
  backendUrl: "https://attachment.test/v1",
  getToken: async () => "attachment-token",
});
beforeEach(() => {
  calls.length = 0;
  reply = (request) =>
    request.method === "PUT"
      ? new Response(null, { status: 204 })
      : new Response(data, {
          headers: { "content-type": "image/png", etag: `"${digest}"` },
        });
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      return reply(request);
    },
  ) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("stores binary attachments with one authenticated request without starting a runtime", async () => {
  const result = await kortix
    .session("project/a", "session/b")
    .attachments.put(data, { contentType: "image/png" });
  expect(result).toEqual({
    sha256: digest,
    contentType: "image/png",
    size: data.byteLength,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(
    `https://attachment.test/v1/projects/project%2Fa/sessions/session%2Fb/attachments/${digest}`,
  );
  expect(calls[0]!.method).toBe("PUT");
  expect(calls[0]!.headers.get("authorization")).toBe(
    "Bearer attachment-token",
  );
  expect(new Uint8Array(await calls[0]!.arrayBuffer())).toEqual(data);
});
test("read verifies digest and returns exact bytes while the session is stopped", async () => {
  const result = await kortix
    .session("project", "session")
    .attachments.get(digest);
  expect(result.bytes).toEqual(data);
  expect(result.contentType).toBe("image/png");
  expect(result.sha256).toBe(digest);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.method).toBe("GET");
});
test("rejects corrupt read bytes and never trusts an etag alone", async () => {
  reply = () =>
    new Response("corrupted", {
      headers: { etag: `"${digest}"`, "content-type": "image/png" },
    });
  await expect(
    kortix.session("project", "session").attachments.get(digest),
  ).rejects.toThrow("digest");
});
test("rejects invalid digest, empty content and oversized bytes before any network request", async () => {
  const attachments = kortix.session("project", "session").attachments;
  await expect(attachments.get("../secret")).rejects.toThrow("sha256");
  await expect(attachments.put(new Uint8Array())).rejects.toThrow("empty");
  await expect(attachments.put(new Uint8Array(8388609))).rejects.toThrow(
    "8 MiB",
  );
  expect(calls).toHaveLength(0);
});
test("surfaces access and conflict failures without converting them to content", async () => {
  reply = () =>
    Response.json({ error: true, message: "Forbidden" }, { status: 403 });
  await expect(
    kortix.session("project", "session").attachments.get(digest),
  ).rejects.toThrow("Forbidden");
  reply = () =>
    Response.json({ error: "attachment MIME is immutable" }, { status: 409 });
  await expect(
    kortix.session("project", "session").attachments.put(data),
  ).rejects.toThrow("immutable");
});
