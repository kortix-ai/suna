"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGatewayRoutingPolicy,
  previewGatewayRoute,
  resetGatewayRoutingPolicy,
  setGatewayRoutingPolicy,
  type GatewayProjectRoutingPolicy,
  type GatewayRoutePreviewInput,
} from "../core/rest/projects-client";
import { useProjectLlmGatewayEnabled } from "./use-project-llm-gateway";

export const gatewayRoutingPolicyKey = (projectId: string | null | undefined) =>
  ["gateway-routing-policy", projectId] as const;

export function useGatewayRoutingPolicy(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  // Routing policy (incl. per-model generation config like reasoning effort)
  // is consulted only by the gateway pipeline. With the project's llm_gateway
  // flag off, reads are dead weight and writes would be silent no-ops the
  // native path never reads — don't fetch.
  const gateway = useProjectLlmGatewayEnabled(projectId);
  const query = useQuery({
    queryKey: gatewayRoutingPolicyKey(projectId),
    queryFn: () => getGatewayRoutingPolicy(projectId as string),
    enabled: !!projectId && gateway.enabled,
    retry: false,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: gatewayRoutingPolicyKey(projectId),
    });

  return Object.assign(query, {
    // Stated beside `data` on purpose: a disabled query still serves cache
    // residue from before the flag flipped, and a consumer that only checks
    // `data?.capabilities.write` would keep rendering a gateway-only control
    // (the composer's reasoning-effort chip) for a native project.
    llmGatewayEnabled: !!projectId && gateway.enabled,
    set: useMutation({
      mutationKey: gatewayRoutingPolicyKey(projectId),
      mutationFn: (policy: GatewayProjectRoutingPolicy) =>
        setGatewayRoutingPolicy(projectId as string, policy),
      onSuccess: invalidate,
    }),
    reset: useMutation({
      mutationKey: gatewayRoutingPolicyKey(projectId),
      mutationFn: () => resetGatewayRoutingPolicy(projectId as string),
      onSuccess: invalidate,
    }),
    preview: useMutation({
      mutationFn: (input: GatewayRoutePreviewInput) =>
        previewGatewayRoute(projectId as string, input),
    }),
  });
}
