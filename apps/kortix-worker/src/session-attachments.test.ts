import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  SessionAttachmentStore,
  attachmentUserContent,
  type PromptAttachment,
} from "./session-attachments.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const fileFor = (bytes: Uint8Array, mime = "image/png"): PromptAttachment => ({
  type: "file",
  mime,
  url: `kortix-attachment:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
});
const data = new Uint8Array([1, 2, 3]);
const file = fileFor(data);
const store = () =>
  new SessionAttachmentStore("https://store.test/projects/p", "own/session", {
    authorization: "Bearer worker",
  });

test("uses only the bound session and returns cached verified bytes without retaining base64", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push(new Request(input, init));
    return new Response(data, { headers: { "content-type": file.mime } });
  }) as unknown as typeof fetch;
  const assets = store();
  const messages: Array<{ role: string; content: unknown[] }> = [
    { role: "user", content: attachmentUserContent("image", [file]) },
  ];
  const snapshot = structuredClone(messages);
  expect(await assets.read(file)).toEqual(Buffer.from(data));
  const hydrated = await assets.hydrate(messages);
  expect(hydrated[0]!.content[1]).toEqual({
    type: "image",
    mimeType: "image/png",
    data: "AQID",
  });
  expect(messages).toEqual(snapshot);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toContain(
    "/projects/p/sessions/own%2Fsession/attachments/",
  );
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer worker");
  expect(requests[0]!.redirect).toBe("error");
  await expect(assets.read({ ...file, mime: "image/jpeg" })).rejects.toThrow(
    "MIME",
  );
});

test.each([
  ["missing", () => new Response(null, { status: 404 }), "not found"],
  ["unavailable", () => new Response(null, { status: 503 }), "503"],
  [
    "wrong MIME",
    () => new Response(data, { headers: { "content-type": "text/plain" } }),
    "MIME",
  ],
  [
    "corrupt",
    () => new Response("different", { headers: { "content-type": file.mime } }),
    "integrity",
  ],
  [
    "empty",
    () =>
      new Response(new Uint8Array(), {
        headers: { "content-type": file.mime },
      }),
    "integrity",
  ],
  [
    "declared oversize",
    () =>
      new Response(data, {
        headers: {
          "content-type": file.mime,
          "content-length": String(8 * 1024 * 1024 + 1),
        },
      }),
    "8 MiB",
  ],
] as const)(
  "rejects %s storage responses without caching a failure",
  async (_, response, message) => {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
    const assets = store();
    await expect(assets.read(file)).rejects.toThrow(message);
    globalThis.fetch = (async () =>
      new Response(data, {
        headers: { "content-type": file.mime },
      })) as unknown as typeof fetch;
    expect(await assets.read(file)).toEqual(Buffer.from(data));
  },
);

test("cancels a chunked body as soon as it crosses 8 MiB", async () => {
  let cancelled = false;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": file.mime } },
    )) as unknown as typeof fetch;
  await expect(store().read(file)).rejects.toThrow("8 MiB");
  expect(cancelled).toBe(true);
});

test("bounds cached bytes with LRU eviction and enforces total prompt bytes", async () => {
  const buffers = [1, 2, 3].map((value) =>
    Buffer.alloc(8 * 1024 * 1024, value),
  );
  const files = buffers.map((bytes) => fileFor(bytes));
  const reads: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    reads.push(url);
    const index = files.findIndex((item) =>
      url.endsWith(item.url.split(":").at(-1)!),
    );
    return new Response(buffers[index], {
      headers: { "content-type": file.mime },
    });
  }) as unknown as typeof fetch;
  const assets = store();
  await assets.read(files[0]!);
  await assets.read(files[1]!);
  await assets.read(files[0]!);
  await assets.read(files[2]!);
  await assets.read(files[0]!);
  expect(reads).toHaveLength(3);
  await assets.read(files[1]!);
  expect(reads).toHaveLength(4);
  await expect(assets.validate(files)).rejects.toThrow("16 MiB");
});

test("respects cancellation before a cache hit and during an upstream read", async () => {
  const controller = new AbortController();
  const assets = store();
  globalThis.fetch = (async () =>
    new Response(data, {
      headers: { "content-type": file.mime },
    })) as unknown as typeof fetch;
  await assets.read(file);
  controller.abort(new Error("stopped"));
  await expect(assets.read(file, controller.signal)).rejects.toThrow("stopped");
  const pendingController = new AbortController();
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => reject(init!.signal!.reason),
        { once: true },
      );
    })) as unknown as typeof fetch;
  const pending = store().read(file, pendingController.signal);
  pendingController.abort(new Error("stopped upstream"));
  await expect(pending).rejects.toThrow("stopped upstream");
});

test("stores native tool images before replacing bytes with immutable references", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push(new Request(input, init));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const assets = store();
  const content = [
    { type: "text", text: "Tool image" },
    { type: "image", mimeType: "image/png", data: "AQID" },
  ];
  const snapshot = structuredClone(content);
  const persisted = await assets.persistImages(content);
  expect(persisted).toEqual([
    content[0],
    { type: "image", mimeType: "image/png", data: "", kortixAttachment: file },
  ]);
  expect(content).toEqual(snapshot);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe("PUT");
  expect(requests[0]!.url).toContain(
    "/projects/p/sessions/own%2Fsession/attachments/",
  );
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer worker");
  expect(requests[0]!.headers.get("content-type")).toBe("image/png");
  expect(requests[0]!.redirect).toBe("error");
  expect(new Uint8Array(await requests[0]!.arrayBuffer())).toEqual(data);
  expect(await assets.persistImages(persisted)).toEqual(persisted);
  expect(
    await assets.hydrate([{ role: "toolResult", content: persisted }]),
  ).toEqual([{ role: "toolResult", content }]);
  expect(requests).toHaveLength(1);
});

test("text-only tools do not require an attachment service", async () => {
  const content = [{ type: "text", text: "No image" }];
  expect(await new SessionAttachmentStore().persistImages(content)).toEqual(
    content,
  );
});

test.each([
  [
    "malformed base64",
    [{ type: "image", mimeType: "image/png", data: "AQID?" }],
    "base64",
  ],
  [
    "noncanonical base64",
    [{ type: "image", mimeType: "image/png", data: "AR==" }],
    "base64",
  ],
  [
    "empty bytes",
    [{ type: "image", mimeType: "image/png", data: "" }],
    "empty",
  ],
  [
    "unsupported MIME",
    [{ type: "image", mimeType: "image/svg+xml", data: "AQID" }],
    "PNG",
  ],
  [
    "too many images",
    Array.from({ length: 17 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: "AQID",
    })),
    "16 images",
  ],
  [
    "single oversized image",
    [
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
      },
    ],
    "8 MiB",
  ],
  [
    "oversized image batch",
    Array.from({ length: 3 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: Buffer.alloc(6 * 1024 * 1024).toString("base64"),
    })),
    "16 MiB",
  ],
] as const)(
  "rejects %s before storing any image",
  async (_, content, message) => {
    let writes = 0;
    globalThis.fetch = (async () => {
      writes++;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await expect(store().persistImages([...content])).rejects.toThrow(message);
    expect(writes).toBe(0);
  },
);

test("does not retain an unacknowledged upload or return a reference after cancellation", async () => {
  const assets = store();
  const content = [{ type: "image", mimeType: "image/png", data: "AQID" }];
  globalThis.fetch = (async () =>
    new Response(null, { status: 503 })) as unknown as typeof fetch;
  await expect(assets.persistImages(content)).rejects.toThrow("503");
  let writes = 0;
  const controller = new AbortController();
  globalThis.fetch = (async () => {
    writes++;
    controller.abort(new Error("stopped upload"));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  await expect(
    assets.persistImages(content, controller.signal),
  ).rejects.toThrow("stopped upload");
  globalThis.fetch = (async () => {
    writes++;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  expect(await assets.persistImages(content)).toHaveLength(1);
  expect(writes).toBe(2);
});
