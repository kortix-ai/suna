import { beforeEach, expect, test } from "bun:test";
import { createSessionAttachmentStore } from "./session-attachments";
const scope = {
  projectId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  attachmentId: "33333333-3333-4333-8333-333333333333",
};
const objects = new Map<string, Blob>();
// No getBucket/createBucket/updateBucket: a migration owns the bucket, and a call to one fails the test.
const storage = {
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
test("removeProject deletes the files of every session under the project, and only that project", async () => {
  // Real Storage lists ONE level: a project prefix names its session folders.
  const bucket = new Set([
    "p1/s1/a1",
    "p1/s1/a2",
    "p1/s2/a3",
    "p2/s3/a4",
  ]);
  const oneLevel = {
    from: () => ({
      list: async (prefix: string) => ({
        data: [...new Set([...bucket]
          .filter((k) => k.startsWith(prefix + "/"))
          .map((k) => k.slice(prefix.length + 1).split("/")[0]!))].map((name) => ({ name })),
        error: null,
      }),
      remove: async (keys: string[]) => {
        keys.forEach((k) => bucket.delete(k));
        return { error: null };
      },
    }),
  };
  const store = createSessionAttachmentStore(oneLevel as never);
  await store.removeProject("p1");
  expect([...bucket]).toEqual(["p2/s3/a4"]);
});

test("removeProject stops with an error when a folder does not empty", async () => {
  const stuck = {
    from: () => ({
      list: async (prefix: string) => ({ data: [{ name: prefix === "p1" ? "s1" : "a1" }], error: null }),
      remove: async () => ({ error: null }),
    }),
  };
  const store = createSessionAttachmentStore(stuck as never);
  await expect(store.removeProject("p1")).rejects.toThrow("Could not delete the files under p1/s1");
});

test("removeSession stops with an error when its folder does not empty", async () => {
  const stuck = {
    from: () => ({
      list: async () => ({ data: [{ name: "a1" }], error: null }),
      remove: async () => ({ error: null }),
    }),
  };
  const store = createSessionAttachmentStore(stuck as never);
  await expect(store.removeSession(scope.projectId, scope.sessionId)).rejects.toThrow(
    `Could not delete the files under ${scope.projectId}/${scope.sessionId}`,
  );
});

test("removeProject stops with an error when the project keeps listing the same session folder", async () => {
  const stuck = {
    from: () => ({
      list: async (prefix: string) => ({ data: prefix === "p1" ? [{ name: "s1" }] : [], error: null }),
      remove: async () => ({ error: null }),
    }),
  };
  const store = createSessionAttachmentStore(stuck as never);
  await expect(store.removeProject("p1")).rejects.toThrow("Could not delete the session files of project p1");
});

test("a missing listing is already deleted, any other listing error is thrown", async () => {
  const failing = (error: { statusCode?: string; message: string }) => ({
    from: () => ({ list: async () => ({ data: null, error }), remove: async () => ({ error: null }) }),
  });
  const gone = createSessionAttachmentStore(failing({ statusCode: "404", message: "not found" }) as never);
  await gone.removeProject("p1");
  await gone.removeSession(scope.projectId, scope.sessionId);
  const broken = createSessionAttachmentStore(failing({ statusCode: "500", message: "boom" }) as never);
  await expect(broken.removeProject("p1")).rejects.toMatchObject({ message: "boom" });
  await expect(broken.removeSession(scope.projectId, scope.sessionId)).rejects.toMatchObject({ message: "boom" });
});

test("a remove error on a page is thrown", async () => {
  const failing = {
    from: () => ({
      list: async () => ({ data: [{ name: "a1" }], error: null }),
      remove: async () => ({ error: { message: "denied" } }),
    }),
  };
  const store = createSessionAttachmentStore(failing as never);
  await expect(store.removeSession(scope.projectId, scope.sessionId)).rejects.toMatchObject({ message: "denied" });
});
