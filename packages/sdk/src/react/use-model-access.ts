"use client";

import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getProjectModelAccess,
  setProjectModelAccess,
  type ProjectModelAccessChange,
} from "../core/rest/projects-client/model-access";
import { contract } from "./query-contracts";
import { qk } from "./query-keys";

/** Server-confirmed inference controls. Failed writes never change the displayed policy. */
export function useModelAccess(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = qk.project.modelAccess(projectId ?? "");
  const query = useQuery({
    queryKey,
    queryFn: () => getProjectModelAccess(projectId as string),
    enabled: !!projectId,
    ...contract("config"),
  });
  const pending = useIsMutating({ mutationKey: queryKey });
  const mutation = useMutation({
    mutationKey: queryKey,
    scope: { id: `project-model-access:${projectId}` },
    mutationFn: (change: ProjectModelAccessChange) =>
      setProjectModelAccess(projectId as string, change),
    onSuccess: async (policy) => {
      queryClient.setQueryData(queryKey, policy);
      await queryClient.invalidateQueries({
        queryKey: qk.project.modelPicker(projectId as string),
        refetchType: "all",
      });
      await queryClient.invalidateQueries({
        queryKey: ["project-providers", projectId],
        refetchType: "all",
      });
    },
  });
  const defaultModel = query.data?.defaultModel?.replace(/^kortix\//, "");
  const defaultProvider = defaultModel
    ? defaultModel.includes("/")
      ? defaultModel.split("/")[0]
      : "kortix"
    : undefined;
  return {
    defaultProvider,
    data: query.data,
    isLoading: query.isPending,
    error: query.error,
    isUpdating: pending > 0,
    setEnabled: mutation.mutateAsync,
  };
}
