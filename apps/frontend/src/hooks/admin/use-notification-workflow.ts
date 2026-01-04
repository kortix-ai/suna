import { useMutation, useQuery } from "@tanstack/react-query";
import { backendApi } from "@/lib/api-client";

interface TriggerWorkflowRequest {
  workflow_id: string;
  payload: Record<string, any>;
  subscriber_id?: string;
  subscriber_email?: string;
  broadcast: boolean;
}

interface TriggerWorkflowResult {
  success: boolean;
  message?: string;
  broadcast?: boolean;
  response?: any;
  subscriber_id?: string;
  result?: any;
}

export interface Workflow {
  workflow_id: string;
  name: string;
  description?: string;
  active: boolean;
  tags: string[];
}

interface WorkflowsResponse {
  success: boolean;
  workflows: Workflow[];
  total: number;
}

export function useWorkflows() {
  return useQuery({
    queryKey: ["admin", "workflows"],
    queryFn: async () => {
      const response = await backendApi.get<WorkflowsResponse>(
        "/admin/notifications/workflows"
      );

      if (!response.success) {
        throw new Error(response.error?.message || "Failed to fetch workflows");
      }

      return response.data;
    },
    staleTime: 5 * 60 * 1000,
  });
}

interface UseTriggerWorkflowOptions {
  onSuccess?: (data: TriggerWorkflowResult | undefined) => void;
  onError?: (error: Error) => void;
}

export function useTriggerWorkflow(options?: UseTriggerWorkflowOptions) {
  return useMutation({
    mutationFn: async (data: TriggerWorkflowRequest) => {
      const response = await backendApi.post<TriggerWorkflowResult>(
        "/admin/notifications/trigger-workflow",
        data
      );
      if (!response.success) {
        throw new Error(response.error?.message || "Failed to trigger workflow");
      }

      return response.data;
    },
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
}

