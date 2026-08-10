import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

let invalidated: unknown[][] = [];
mock.module("@tanstack/react-query", () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) =>
      invalidated.push(opts.queryKey),
  }),
}));

const { gatewayRoutingPolicyKey, useGatewayRoutingPolicy } =
  await import("./use-gateway-routing-policy");

beforeEach(() => {
  invalidated = [];
});

describe("useGatewayRoutingPolicy", () => {
  test("binds to the canonical Workspace REST client", () => {
    const source = readFileSync(
      new URL("./use-gateway-routing-policy.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("../core/rest/workspaces-client");
    expect(source).not.toContain("../core/rest/projects-client");
  });

  test("uses a stable workspace-scoped query key and disables without a workspace", () => {
    expect((useGatewayRoutingPolicy("P1") as any).queryKey).toEqual(
      gatewayRoutingPolicyKey("P1"),
    );
    expect((useGatewayRoutingPolicy("P1") as any).enabled).toBe(true);
    expect((useGatewayRoutingPolicy(null) as any).enabled).toBe(false);
  });

  test("set and reset invalidate the policy while preview remains a one-shot mutation", () => {
    const result = useGatewayRoutingPolicy("P1") as any;
    expect(result.set.mutationKey).toEqual(gatewayRoutingPolicyKey("P1"));
    expect(result.reset.mutationKey).toEqual(gatewayRoutingPolicyKey("P1"));
    result.set.onSuccess();
    result.reset.onSuccess();
    expect(invalidated).toEqual([
      ["gateway-routing-policy", "P1"],
      ["gateway-routing-policy", "P1"],
    ]);
    expect(result.preview.mutationFn).toBeFunction();
  });
});
