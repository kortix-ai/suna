import { beforeEach, describe, expect, mock, test } from "bun:test";

type Call = { method: string; path: string };
let calls: Call[] = [];
let nextError: { message: string } | null = null;
let nextData: unknown = { workspaces: [], total: 0, page: 1, limit: 50 };

mock.module("@tanstack/react-query", () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

mock.module("../core/http/api-client", () => ({
  backendApi: {
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      return { data: nextData, error: nextError };
    },
  },
}));

const { useAdminWorkspaces } = await import("./use-admin-workspaces");

beforeEach(() => {
  calls = [];
  nextError = null;
  nextData = { workspaces: [], total: 0, page: 1, limit: 50 };
});

describe("useAdminWorkspaces", () => {
  test("uses the canonical Workspace route and query-key namespace", async () => {
    const hook = useAdminWorkspaces() as any;
    await hook.queryFn();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path.startsWith("/admin/api/workspaces?")).toBe(true);
    expect(hook.queryKey.slice(0, 2)).toEqual(["admin", "workspaces"]);
  });

  test("sends every filter and pagination input", async () => {
    const hook = useAdminWorkspaces({
      search: "acme",
      accountId: "acct-1",
      status: ["active", "archived"],
      sortBy: "sessions",
      sortDir: "asc",
      page: 3,
      limit: 25,
    }) as any;
    await hook.queryFn();

    const query = new URLSearchParams(calls[0]!.path.split("?")[1] ?? "");
    expect(Object.fromEntries(query)).toEqual({
      search: "acme",
      accountId: "acct-1",
      status: "active,archived",
      sortBy: "sessions",
      sortDir: "asc",
      page: "3",
      limit: "25",
    });
  });

  test("returns the canonical Workspace response", async () => {
    nextData = {
      workspaces: [{ workspaceId: "w1" }],
      total: 1,
      page: 1,
      limit: 50,
    };
    const hook = useAdminWorkspaces() as any;
    await expect(hook.queryFn()).resolves.toEqual(nextData);
  });

  test("throws the API error message", async () => {
    nextError = { message: "admin_required" };
    const hook = useAdminWorkspaces() as any;
    await expect(hook.queryFn()).rejects.toThrow("admin_required");
  });
});
