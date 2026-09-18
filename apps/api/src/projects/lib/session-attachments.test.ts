import { beforeEach, expect, mock, test } from "bun:test";
import { createSessionAttachmentStore } from "./session-attachments";
const scope = {
  projectId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  attachmentId: "33333333-3333-4333-8333-333333333333",
};
const objects = new Map<string, Blob>();
const storage = {
  getBucket: async () => ({ data: { public: false }, error: null }),
  createBucket: mock(async () => ({ error: null })),
  from: (bucket: string) => {
    expect(bucket).toBe("session-attachments");
    return {
      upload: async (
        key: string,
        bytes: Uint8Array,
        options: { upsert: boolean; contentType: string },
      ) => {
        expect(options.upsert).toBe(false);
        if (objects.has(key))
          return { error: { statusCode: "409", message: "already exists" } };
        objects.set(
          key,
          new Blob([Uint8Array.from(bytes)], { type: options.contentType }),
        );
        return { error: null };
      },
      download: async (key: string) => ({
        data: objects.get(key) ?? null,
        error: objects.has(key)
          ? null
          : { statusCode: "404", message: "not found" },
      }),
      list: async (prefix: string) => ({
        data: [...objects.keys()]
          .filter((k) => k.startsWith(prefix + "/"))
          .map((k) => ({ name: k.slice(prefix.length + 1) })),
        error: null,
      }),
      remove: async (keys: string[]) => {
        keys.forEach((key) => objects.delete(key));
        return { error: null };
      },
    };
  },
};
beforeEach(() => objects.clear());
const input = () => ({
  ...scope,
  filename: "notes.txt",
  mime: "text/plain",
  bytes: new TextEncoder().encode("saved before wake"),
});

test("private bytes survive without a sandbox and repeat uploads are idempotent", async () => {
  const store = createSessionAttachmentStore(storage as never);
  const saved = await store.put(input());
  expect(saved.url).toBe(
    `kortix-attachment://${scope.projectId}/${scope.sessionId}/${scope.attachmentId}`,
  );
  await store.put(input());
  expect(objects.size).toBe(1);
  expect(await (await store.read(scope))?.text()).toBe("saved before wake");
});
test("an existing attachment cannot be replaced by another body", async () => {
  const store = createSessionAttachmentStore(storage as never);
  await store.put(input());
  await expect(
    store.put({ ...input(), bytes: new TextEncoder().encode("replacement") }),
  ).rejects.toThrow("different file");
  expect(await (await store.read(scope))?.text()).toBe("saved before wake");
});
test("references cannot cross projects or sessions", async () => {
  const store = createSessionAttachmentStore(storage as never);
  await store.put(input());
  expect(await store.read({ ...scope, sessionId: scope.projectId })).toBeNull();
  expect(await store.read({ ...scope, projectId: scope.sessionId })).toBeNull();
});
test("cleanup removes only this session objects", async () => {
  const store = createSessionAttachmentStore(storage as never);
  await store.put(input());
  await store.put({ ...input(), sessionId: scope.projectId });
  await store.removeSession(scope.projectId, scope.sessionId);
  expect(await store.read(scope)).toBeNull();
  expect(objects.size).toBe(1);
});
test("refuses a public bucket", async () => {
  const store = createSessionAttachmentStore({
    ...storage,
    getBucket: async () => ({ data: { public: true }, error: null }),
  } as never);
  await expect(store.put(input())).rejects.toThrow("private");
  expect(objects.size).toBe(0);
});

test('raises an older private bucket limit to the current composer limit', async () => {
  const updateBucket = mock(async () => ({ error: null }));
  const store = createSessionAttachmentStore({
    ...storage,
    getBucket: async () => ({ data: { public: false, file_size_limit: 25 * 1024 * 1024 }, error: null }),
    updateBucket,
  } as never);
  await store.put(input());
  expect(updateBucket).toHaveBeenCalledWith('session-attachments', { public: false, fileSizeLimit: 50 * 1024 * 1024 });
});
