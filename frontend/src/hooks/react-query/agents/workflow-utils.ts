import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

export interface WorkflowStep {
  id: string;
  name: string;
  description?: string;
  type: string;
  config: Record<string, any>;
  conditions?: Record<string, any>;
  order: number;
  created_at: string;
  updated_at: string;
}

export interface AgentWorkflow {
  id: string;
  agent_id: string;
  name: string;
  description?: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  trigger_phrase?: string;
  is_default: boolean;
  steps: WorkflowStep[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowExecution {
  id: string;
  workflow_id: string;
  agent_id: string;
  thread_id?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  started_at: string;
  completed_at?: string;
  duration_seconds?: number;
  triggered_by: string;
  input_data?: Record<string, any>;
  output_data?: Record<string, any>;
  error_message?: string;
  created_at: string;
}

export interface CreateWorkflowRequest {
  name: string;
  description?: string;
  trigger_phrase?: string;
  is_default?: boolean;
  steps: Array<{
    name: string;
    description?: string;
    type?: string;
    config?: Record<string, any>;
    conditions?: Record<string, any>;
    order: number;
  }>;
}

export interface UpdateWorkflowRequest {
  name?: string;
  description?: string;
  trigger_phrase?: string;
  is_default?: boolean;
  status?: 'draft' | 'active' | 'paused' | 'archived';
  steps?: Array<{
    name: string;
    description?: string;
    type?: string;
    config?: Record<string, any>;
    conditions?: Record<string, any>;
    order: number;
  }>;
}

export interface ExecuteWorkflowRequest {
  input_data?: Record<string, any>;
  thread_id?: string;
}

export interface LLMWorkflowStep {
  step: string;
  description?: string;
  tool?: string;
  condition?: string;
  then?: LLMWorkflowStep[];
}

export interface LLMWorkflowFormat {
  workflow: string;
  description?: string;
  steps: LLMWorkflowStep[];
}

export const convertWorkflowToLLMFormat = (workflow: AgentWorkflow): LLMWorkflowFormat => {
  const convertSteps = (steps: any[]): LLMWorkflowStep[] => {
    return steps.map(step => {
      const llmStep: LLMWorkflowStep = {
        step: step.name,
      };

      if (step.description) {
        llmStep.description = step.description;
      }

      if (step.config?.tool_name) {
        llmStep.tool = step.config.tool_name;
      }

      if (step.type === 'condition' && step.conditions) {
        if (step.conditions.type === 'if' && step.conditions.expression) {
          llmStep.condition = step.conditions.expression;
        } else if (step.conditions.type === 'else') {
          llmStep.condition = 'else';
        }
      }

      if (step.steps && step.steps.length > 0) {
        llmStep.then = convertSteps(step.steps);
      }

      return llmStep;
    });
  };

  const llmFormat: LLMWorkflowFormat = {
    workflow: workflow.name,
    steps: convertSteps(workflow.steps)
  };

  if (workflow.description) {
    llmFormat.description = workflow.description;
  }

  return llmFormat;
};

export const generateLLMWorkflowPrompt = (workflow: AgentWorkflow): string => {
  const llmFormat = convertWorkflowToLLMFormat(workflow);
  return JSON.stringify(llmFormat, null, 2);
};

export const getAgentWorkflows = async (agentId: string): Promise<AgentWorkflow[]> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      throw new Error('You must be logged in to get workflows');
    }

    const response = await fetch(`${API_URL}/triggers/workflows/agents/${agentId}/workflows`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    const workflows = await response.json();
    return workflows;
  } catch (err) {
    console.error('Error fetching workflows:', err);
    throw err;
  }
};

export const createAgentWorkflow = async (agentId: string, workflow: CreateWorkflowRequest): Promise<AgentWorkflow> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      throw new Error('You must be logged in to create a workflow');
    }

    const response = await fetch(`${API_URL}/triggers/workflows/agents/${agentId}/workflows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(workflow),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return result;
  } catch (err) {
    console.error('Error creating workflow:', err);
    throw err;
  }
};

export const updateAgentWorkflow = async (
  agentId: string, 
  workflowId: string, 
  workflow: UpdateWorkflowRequest
): Promise<AgentWorkflow> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      throw new Error('You must be logged in to update a workflow');
    }

    const response = await fetch(`${API_URL}/triggers/workflows/agents/${agentId}/workflows/${workflowId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(workflow),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return result;
  } catch (err) {
    console.error('Error updating workflow:', err);
    throw err;
  }
};

export const deleteAgentWorkflow = async (agentId: string, workflowId: string): Promise<void> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      throw new Error('You must be logged in to delete a workflow');
    }

    const response = await fetch(`${API_URL}/triggers/workflows/agents/${agentId}/workflows/${workflowId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }
  } catch (err) {
    console.error('Error deleting workflow:', err);
    throw err;
  }
};

export const executeWorkflow = async (
  agentId: string, 
  workflowId: string, 
  execution: ExecuteWorkflowRequest
): Promise<{ 
  execution_id: string; 
  thread_id?: string; 
  agent_run_id?: string; 
  status: string; 
  message?: string; 
}> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      throw new Error('You must be logged in to execute a workflow');
    }

    const response = await fetch(`${API_URL}/triggers/workflows/agents/${agentId}/workflows/${workflowId}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(execution),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    return result;
  } catch (err) {
    console.error('Error executing workflow:', err);
    throw err;
  }
};

export const getWorkflowExecutions = async (
  agentId: string, 
  workflowId: string, 
  limit: number = 20
): Promise<WorkflowExecution[]> => {
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      throw new Error('You must be logged in to get workflow executions');
    }

    const response = await fetch(`${API_URL}/triggers/workflows/agents/${agentId}/workflows/${workflowId}/executions?limit=${limit}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(errorData.detail || `HTTP ${response.status}: ${response.statusText}`);
    }

    const executions = await response.json();
    return executions;
  } catch (err) {
    console.error('Error fetching workflow executions:', err);
    throw err;
  }
}; 