export const workflowKeys = {
  all: ['agent-workflows'] as const,
  agent: (agentId: string) => [...workflowKeys.all, agentId] as const,
  workflow: (agentId: string, workflowId: string) => [...workflowKeys.agent(agentId), workflowId] as const,
  executions: (agentId: string, workflowId: string) => [...workflowKeys.workflow(agentId, workflowId), 'executions'] as const,
}; 