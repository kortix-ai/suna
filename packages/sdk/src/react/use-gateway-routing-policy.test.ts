import { beforeEach, describe, expect, mock, test } from "bun:test";

let invalidated: unknown[][] = [];
// The project-detail read (useProjectLlmGatewayEnabled) resolves the
// llm_gateway flag ON for these cases — routing policy is a gateway-only
// surface and its query must stay disabled for a native project.
let projectGatewayFlag = true;
mock.module("@tanstack/react-query", () => ({
  useQuery: (config: Record<string, unknown>) => {
    const key = config.queryKey as unknown[] | undefined;
    if (Array.isArray(key) && key.includes("detail")) {
      return {
        ...config,
        data: { project: { experimental: { llm_gateway: projectGatewayFlag } } },
        isSuccess: true,
      };
    }
    return config;
  },
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
  projectGatewayFlag = true;
});

describe("useGatewayRoutingPolicy", () => {
  test("uses a stable project-scoped query key and disables without a project", () => {
    expect((useGatewayRoutingPolicy("P1") as any).queryKey).toEqual(
      gatewayRoutingPolicyKey("P1"),
    );
    expect((useGatewayRoutingPolicy("P1") as any).enabled).toBe(true);
    expect((useGatewayRoutingPolicy(null) as any).enabled).toBe(false);
  });

  test("stays disabled for a native project (llm_gateway off) — the route 404s and writes are no-ops", () => {
    projectGatewayFlag = false;
    expect((useGatewayRoutingPolicy("P1") as any).enabled).toBe(false);
  });

  // A disabled query still serves whatever the cache holds from before the
  // flag flipped. Consumers (the composer's reasoning-effort chip) must be
  // able to ask "does this policy apply at all?" without reasoning about
  // cache residue — so the hook states the flag alongside `data`.
  test("exposes llmGatewayEnabled so consumers hide gateway-only controls off-gateway", () => {
    expect((useGatewayRoutingPolicy("P1") as any).llmGatewayEnabled).toBe(true);
    projectGatewayFlag = false;
    expect((useGatewayRoutingPolicy("P1") as any).llmGatewayEnabled).toBe(false);
    expect((useGatewayRoutingPolicy(null) as any).llmGatewayEnabled).toBe(false);
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
