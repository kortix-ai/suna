import { beforeEach, describe, expect, mock, test } from "bun:test";
import { qk } from "./query-keys";

let invalidated: (readonly unknown[])[] = [];
// Every query key the hook asks for: the gateway is the only model path, so
// the policy read waits on no project-detail flag read.
let queried: unknown[] = [];
mock.module("@tanstack/react-query", () => ({
  useQuery: (config: Record<string, unknown>) => {
    queried.push(config.queryKey);
    return config;
  },
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: readonly unknown[] }) =>
      invalidated.push(opts.queryKey),
  }),
}));

const { gatewayRoutingPolicyKey, useGatewayRoutingPolicy } =
  await import("./use-gateway-routing-policy");

beforeEach(() => {
  invalidated = [];
  queried = [];
});

describe("useGatewayRoutingPolicy", () => {
  test("uses a stable project-scoped query key and disables without a project", () => {
    expect((useGatewayRoutingPolicy("P1") as any).queryKey).toEqual(
      gatewayRoutingPolicyKey("P1"),
    );
    expect((useGatewayRoutingPolicy("P1") as any).enabled).toBe(true);
    expect((useGatewayRoutingPolicy(null) as any).enabled).toBe(false);
  });

  test("reads the policy without a project-detail read", () => {
    expect((useGatewayRoutingPolicy("P1") as any).enabled).toBe(true);
    expect(queried).toEqual([gatewayRoutingPolicyKey("P1")]);
  });

  test("llmGatewayEnabled (deprecated) is true for every project", () => {
    expect((useGatewayRoutingPolicy("P1") as any).llmGatewayEnabled).toBe(true);
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
      qk.project.modelAccess("P1"),
      ["gateway-routing-policy", "P1"],
      qk.project.modelAccess("P1"),
    ]);
    expect(result.preview.mutationFn).toBeFunction();
  });
});


test('routing changes refresh the default protection in model access controls', () => {
  const result = useGatewayRoutingPolicy('P1') as any;
  result.set.onSuccess();
  expect(invalidated).toContainEqual(qk.project.modelAccess("P1"));
});
