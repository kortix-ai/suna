import { beforeEach, describe, expect, mock, test } from "bun:test";

let invalidated: Array<readonly unknown[]> = [];
mock.module("@tanstack/react-query", () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: readonly unknown[] }) =>
      invalidated.push(opts.queryKey),
  }),
}));

const { agentProfileKey, useAgentProfile, useAgentProfileMutations } =
  await import("./use-agent-profile");

beforeEach(() => {
  invalidated = [];
});

describe("useAgentProfile", () => {
  test("uses one project and agent scoped shared-draft key", () => {
    const result = useAgentProfile("p1", "support") as any;
    expect(result.queryKey).toEqual(["agent-profile", "p1", "support"]);
    expect(result.enabled).toBe(true);
    expect((useAgentProfile(null, "support") as any).enabled).toBe(false);
  });
});

describe("useAgentProfileMutations", () => {
  test("invalidates the profile and change request after draft publication", () => {
    const result = useAgentProfileMutations("p1", "support") as any;
    result.publish.onSuccess();
    expect(invalidated).toEqual([
      agentProfileKey("p1", "support"),
      ["project-change-requests", "p1"],
      ["project-config", "p1"],
      ["project-detail", "p1", "agents"],
    ]);
  });

  test("invalidates the profile after immediate revoke and source sync", () => {
    const result = useAgentProfileMutations("p1", "support") as any;
    result.revokeKnowledge.onSuccess();
    result.syncKnowledge.onSuccess();
    expect(invalidated).toEqual([
      agentProfileKey("p1", "support"),
      agentProfileKey("p1", "support"),
    ]);
  });
});
