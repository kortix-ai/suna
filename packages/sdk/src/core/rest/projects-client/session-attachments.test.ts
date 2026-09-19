import { afterEach, beforeEach, expect, test } from "bun:test";
import { configureKortix } from "../../http/config";
import {
  fetchSessionAttachment,
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
