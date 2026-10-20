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
import { qk } from "./query-keys";

export const gatewayRoutingPolicyKey = (projectId: string | null | undefined) =>
  ["gateway-routing-policy", projectId] as const;

export function useGatewayRoutingPolicy(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: gatewayRoutingPolicyKey(projectId),
    queryFn: () => getGatewayRoutingPolicy(projectId as string),
    enabled: !!projectId,
    retry: false,
  });
  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: gatewayRoutingPolicyKey(projectId) }),
    queryClient.invalidateQueries({ queryKey: qk.project.modelAccess(projectId ?? '') }),
  ]);

  return Object.assign(query, {
    /** @deprecated True for every project: the LLM gateway is the only model path. Removed in the next major. */
    llmGatewayEnabled: !!projectId,
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
