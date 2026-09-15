import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  SessionAttachmentStore,
  attachmentUserContent,
  toolImageParts,
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

test("tool image parts use durable session paths and retain legacy lookup compatibility", () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const scopedStore = new SessionAttachmentStore('https://store.test', sessionId, {}, projectId);
  const identity = { sessionID: 'native', messageID: 'message', partID: 'tool' };
  const content = [{ type: 'image', mimeType: file.mime, data: '', kortixAttachment: file }];
  const parts = toolImageParts(content, identity, scopedStore.registerPart);
  expect(parts[0].url).toBe(`/projects/${projectId}/sessions/${sessionId}/attachments/${file.url.split(':').at(-1)}`);
  expect(scopedStore.referenceForPart('/kortix/part/native/message/tool-image-0')).toEqual(file);
  expect(toolImageParts(content, identity)[0].url).toBe('/kortix/part/native/message/tool-image-0');
});

test("hydrates distinct images concurrently, deduplicates repeated references, and preserves message order", async () => {
  const buffers = [1, 2, 3].map(value => Buffer.from([value]));
  const files = buffers.map(bytes => fileFor(bytes));
  const pending: Array<() => void> = [];
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    await new Promise<void>(resolve => pending.push(resolve));
    const index = files.findIndex(item => url.endsWith(item.url.split(':').at(-1)!));
    return new Response(buffers[index], { headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;
  const messages: Array<{ role: string; content: unknown[] }> = files.map((item, index) => ({
    role: 'user', content: attachmentUserContent(String(index), [item, files[0]]),
  }));
  const original = structuredClone(messages);
  const result = store().hydrate(messages);
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    pending.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(3);
    pending.splice(0).forEach(resolve => resolve());
    const hydrated = await result;
    expect(hydrated.map(message => message.content)).toEqual(buffers.map((bytes, index) => [
      { type: 'text', text: String(index) },
      { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
      { type: 'image', mimeType: 'image/png', data: buffers[0]!.toString('base64') },
    ]));
    expect(messages).toEqual(original);
  } finally {
    globalThis.fetch = (async () => new Response(buffers[0], { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    pending.splice(0).forEach(resolve => resolve());
    await result.catch(() => {});
  }
});

test("a failed image read cancels its parallel sibling before hydration rejects", async () => {
  const first = fileFor(Buffer.from([31]));
  const second = fileFor(Buffer.from([32]));
  let siblingAborted = false;
  let release!: () => void;
  const siblingStarted = new Promise<void>(resolve => { release = resolve; });
  const deadline = AbortSignal.timeout(1000);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith(first.url.split(':').at(-1)!)) {
      await Promise.race([siblingStarted, new Promise<void>((_resolve, reject) => {
        deadline.addEventListener('abort', () => reject(new Error('parallel sibling did not start')), { once: true });
      })]);
      return new Response('corrupt', { headers: { 'content-type': 'image/png' } });
    }
    release();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        siblingAborted = true;
        reject(init.signal!.reason);
      }, { once: true });
    });
  }) as unknown as typeof fetch;
  await expect(store().hydrate([{ content: attachmentUserContent('images', [first, second]) }]))
    .rejects.toThrow('integrity');
  expect(siblingAborted).toBe(true);
});

test('replays repeated images through authenticated HTTP with at most two active downloads', async () => {
  const buffers = Array.from({ length: 16 }, (_, index) => Buffer.alloc(256, index));
  const files = buffers.map(bytes => fileFor(bytes));
  const requests: string[] = [];
  let active = 0;
  let maximum = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer fixture');
      const path = new URL(request.url).pathname;
      expect(path).toStartWith('/projects/p/sessions/own%2Fsession/attachments/');
      requests.push(path);
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      const index = files.findIndex(item => path.endsWith(item.url.split(':').at(-1)!));
      return new Response(buffers[index], { headers: { 'content-type': 'image/png' } });
    },
  });
  try {
    const assets = new SessionAttachmentStore(`${server.url}projects/p`, 'own/session', { authorization: 'Bearer fixture' });
    const hydrated = await assets.hydrate([{ content: attachmentUserContent('images', [...files, ...files]) }]);
    expect(maximum).toBe(2);
    expect(requests).toHaveLength(16);
    expect(hydrated[0]!.content.slice(1).map((image: any) => image.data)).toEqual([...buffers, ...buffers].map(bytes => bytes.toString('base64')));
    const controller = new AbortController();
    const stopped = assets.hydrate([{ content: attachmentUserContent('cached', [files[0]]) }], controller.signal);
    controller.abort(new Error('stopped'));
    await expect(stopped).rejects.toThrow('stopped');
    expect(requests).toHaveLength(16);
  } finally { server.stop(true); }
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
