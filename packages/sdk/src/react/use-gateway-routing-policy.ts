"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getGatewayRoutingPolicy,
  previewGatewayRoute,
  resetGatewayRoutingPolicy,
  setGatewayRoutingPolicy,
  type GatewayWorkspaceRoutingPolicy,
  type GatewayRoutePreviewInput,
} from "../core/rest/workspaces-client";

export const gatewayRoutingPolicyKey = (workspaceId: string | null | undefined) =>
  ["gateway-routing-policy", workspaceId] as const;

export function useGatewayRoutingPolicy(workspaceId: string | null | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: gatewayRoutingPolicyKey(workspaceId),
    queryFn: () => getGatewayRoutingPolicy(workspaceId as string),
    enabled: !!workspaceId,
    retry: false,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: gatewayRoutingPolicyKey(workspaceId),
    });

  return Object.assign(query, {
    set: useMutation({
      mutationKey: gatewayRoutingPolicyKey(workspaceId),
      mutationFn: (policy: GatewayWorkspaceRoutingPolicy) =>
        setGatewayRoutingPolicy(workspaceId as string, policy),
      onSuccess: invalidate,
    }),
    reset: useMutation({
      mutationKey: gatewayRoutingPolicyKey(workspaceId),
      mutationFn: () => resetGatewayRoutingPolicy(workspaceId as string),
      onSuccess: invalidate,
    }),
    preview: useMutation({
      mutationFn: (input: GatewayRoutePreviewInput) =>
        previewGatewayRoute(workspaceId as string, input),
    }),
  });
}
