import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const sessionId = "55555555-5555-4555-8555-555555555555";
let callerSession: string | null = null;
let metadata: Record<string, unknown> = {};
let found = true;
let reads = 0;
const capabilities: string[] = [];
mock.module("../../shared/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            reads++;
            return found ? [{ metadata }] : [];
          },
        }),
      }),
    }),
  },
}));
mock.module("./access", () => ({
  loadProjectForUser: async () => ({
    userId: "user",
    row: { accountId: "account", projectId: "project" },
  }),
  assertProjectCapability: async (
    _c: unknown,
    _user: string,
    _account: string,
    _project: string,
    action: string,
  ) => {
    capabilities.push(action);
  },
}));
mock.module("./caller-session", () => ({
  callerKortixSessionId: () => callerSession,
}));
const { authorizeSessionStorageCall } =
  await import("./session-storage-access");
const { PROJECT_ACTIONS } = await import("../../iam");
const app = new Hono();
app.get("/:projectId/:sessionId", async (c) => {
  const result = await authorizeSessionStorageCall(
    c as any,
    PROJECT_ACTIONS.PROJECT_SESSION_READ,
  );
  return result.kind === "error" ? result.response : c.json(result);
});
beforeEach(() => {
  callerSession = null;
  metadata = {};
  found = true;
  reads = 0;
  capabilities.length = 0;
});

test("worker credentials cannot read a sibling session even when they can read the project", async () => {
  callerSession = "66666666-6666-4666-8666-666666666666";
  expect((await app.request(`/project/${sessionId}`)).status).toBe(403);
  expect(reads).toBe(0);
  expect(capabilities).toEqual([]);
});
test("own-session credentials read storage without requesting human capabilities", async () => {
  callerSession = sessionId;
  const response = await app.request(`/project/${sessionId}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind: "ok", sessionId });
  expect(reads).toBe(1);
  expect(capabilities).toEqual([]);
});
test("human callers must pass the requested project capability", async () => {
  expect((await app.request(`/project/${sessionId}`)).status).toBe(200);
  expect(capabilities).toEqual([PROJECT_ACTIONS.PROJECT_SESSION_READ]);
});
test("deleted and unknown sessions remain inaccessible to their own worker credentials", async () => {
  callerSession = sessionId;
  metadata = { deletedAt: new Date().toISOString() };
  expect((await app.request(`/project/${sessionId}`)).status).toBe(404);
  found = false;
  expect((await app.request(`/project/${sessionId}`)).status).toBe(404);
});
