import { beforeEach, describe, expect, mock, test } from "bun:test";

// Same harness as `./use-admin-activity-analytics.test.ts`: react-query is
// mocked so the hook can be exercised as a plain function — no React render
// tree — while still asserting the exact `queryKey`, the `enabled` guard, the
// freshness contract, and the fail-closed read.

let lastConfig: Record<string, any> | null = null;
let nextResult: Record<string, unknown> = { data: undefined, isLoading: false };

mock.module("@tanstack/react-query", () => ({
  useQuery: (config: Record<string, any>) => {
    lastConfig = config;
    return nextResult;
  },
}));

let detailCalls: string[] = [];
mock.module("../core/rest/workspaces-client", () => ({
  getWorkspaceDetail: async (workspaceId: string) => {
    detailCalls.push(workspaceId);
    return { workspace: { workspace_id: workspaceId } };
  },
}));

const { useFeatureFlag } = await import("./use-feature-flag");
const { qk } = await import("./query-keys");

beforeEach(() => {
  lastConfig = null;
  detailCalls = [];
  nextResult = { data: undefined, isLoading: false };
});

function withDetail(experimental: Record<string, unknown> | undefined) {
  nextResult = { data: { workspace: { experimental } }, isLoading: false };
}

describe("useFeatureFlag", () => {
  test("reads the shared workspace-detail cache entry, not a private key", () => {
    useFeatureFlag("workspace-1", "review_center");

    // Built through the factory on purpose: the guard in
    // `query-key-literals.test.ts` forbids hand-typed key literals here, and
    // the point of the assertion is that the hook shares the SAME cache entry
    // every other workspace-detail reader uses.
    expect(lastConfig?.queryKey).toEqual(qk.workspace.detail("workspace-1"));
    expect(lastConfig?.enabled).toBe(true);
  });

  test("is disabled and fail-closed with no workspace id", () => {
    const flag = useFeatureFlag(null, "apps");

    expect(lastConfig?.enabled).toBe(false);
    expect(flag.enabled).toBe(false);
  });

  test("queryFn fetches the workspace detail for the given id", async () => {
    useFeatureFlag("workspace-9", "apps");
    await lastConfig?.queryFn();

    expect(detailCalls).toEqual(["workspace-9"]);
  });

  test("enabled only when the server says exactly true", () => {
    withDetail({ apps: true });
    expect(useFeatureFlag("p", "apps").enabled).toBe(true);

    withDetail({ apps: false });
    expect(useFeatureFlag("p", "apps").enabled).toBe(false);

    // Fail-closed on every non-`true` shape the wire could produce.
    withDetail({ apps: "true" as unknown as boolean });
    expect(useFeatureFlag("p", "apps").enabled).toBe(false);

    withDetail({});
    expect(useFeatureFlag("p", "apps").enabled).toBe(false);

    withDetail(undefined);
    expect(useFeatureFlag("p", "apps").enabled).toBe(false);
  });

  test("reports the loading state so callers can gate on it", () => {
    nextResult = { data: undefined, isLoading: true };
    const flag = useFeatureFlag("p", "voice");

    expect(flag.isLoading).toBe(true);
    // Loading is NOT enabled — the surface stays dark until the server answers.
    expect(flag.enabled).toBe(false);
  });

  test("one flag never reads another flag`s slot", () => {
    withDetail({ apps: true, voice: false });

    expect(useFeatureFlag("p", "apps").enabled).toBe(true);
    expect(useFeatureFlag("p", "voice").enabled).toBe(false);
  });
});
