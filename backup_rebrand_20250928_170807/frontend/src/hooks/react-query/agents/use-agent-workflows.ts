import { createMutationHook, createQueryHook } from '@/hooks/use-query';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { workflowKeys } from './workflow-keys';
import { 
  CreateWorkflowRequest, 
  UpdateWorkflowRequest, 
  ExecuteWorkflowRequest,
  getAgentWorkflows,
  createAgentWorkflow,
  updateAgentWorkflow,
  deleteAgentWorkflow,
  executeWorkflow,
  getWorkflowExecutions
} from './workflow-utils';


export const useAgentWorkflows = (agentId: string) => {
  return createQueryHook(
    workflowKeys.agent(agentId),
    () => getAgentWorkflows(agentId),
    {
      enabled: !!agentId,
      staleTime: 30000,
    }
  )();
};

export const useCreateAgentWorkflow = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    ({ agentId, workflow }: { agentId: string; workflow: CreateWorkflowRequest }) => 
      createAgentWorkflow(agentId, workflow),
    {
      onSuccess: (data, variables) => {
        queryClient.invalidateQueries({ queryKey: workflowKeys.agent(variables.agentId) });
        toast.success('Workflow created successfully');
      },
    }
  )();
};

export const useUpdateAgentWorkflow = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    ({ agentId, workflowId, workflow }: { agentId: string; workflowId: string; workflow: UpdateWorkflowRequest }) => 
      updateAgentWorkflow(agentId, workflowId, workflow),
    {
      onSuccess: (data, variables) => {
        queryClient.invalidateQueries({ queryKey: workflowKeys.agent(variables.agentId) });
        toast.success('Workflow updated successfully');
      },
    }
  )();
};

export const useDeleteAgentWorkflow = () => {
  const queryClient = useQueryClient();
  
  return createMutationHook(
    ({ agentId, workflowId }: { agentId: string; workflowId: string }) => 
      deleteAgentWorkflow(agentId, workflowId),
    {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: workflowKeys.agent(variables.agentId) });
        toast.success('Workflow deleted successfully');
      },
    }
  )();
};

export const useExecuteWorkflow = () => {
  const queryClient = useQueryClient();
  return createMutationHook(
    ({ agentId, workflowId, execution }: { agentId: string; workflowId: string; execution: ExecuteWorkflowRequest }) => 
      executeWorkflow(agentId, workflowId, execution),
    {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: workflowKeys.executions(variables.agentId, variables.workflowId) });
        toast.success('Workflow execution started');
      },
    }
  )();
};

export const useWorkflowExecutions = (agentId: string, workflowId: string, limit: number = 20) => {
  return createQueryHook(
    workflowKeys.executions(agentId, workflowId),
    () => getWorkflowExecutions(agentId, workflowId, limit),
    {
      enabled: !!agentId && !!workflowId,
      staleTime: 10000, // 10 seconds
    }
  )();
}; 