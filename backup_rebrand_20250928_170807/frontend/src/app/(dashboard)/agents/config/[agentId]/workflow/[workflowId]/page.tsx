'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCreateAgentWorkflow, useUpdateAgentWorkflow, useAgentWorkflows } from '@/hooks/react-query/agents/use-agent-workflows';
import { CreateWorkflowRequest, UpdateWorkflowRequest } from '@/hooks/react-query/agents/workflow-utils';
import { useAgentTools } from '@/hooks/react-query/agents/use-agent-tools';
import { useAgent } from '@/hooks/react-query/agents/use-agents';
import { ConditionalStep } from '@/components/agents/workflows/conditional-workflow-builder';
import { WorkflowBuilder } from '@/components/workflows/workflow-builder';
import { WorkflowExecutionDialog } from '@/components/workflows/workflow-execution-dialog';

const convertToNestedJSON = (steps: ConditionalStep[]): any[] => {
  let globalOrder = 1;

  const convertStepsWithNesting = (stepList: ConditionalStep[]): any[] => {
    return stepList.map((step) => {
      const jsonStep: any = {
        id: step.id,
        name: step.name,
        description: step.description,
        type: step.type,
        config: step.config || {},
        order: globalOrder++
      };

      if (step.type === 'condition' && step.conditions) {
        jsonStep.conditions = step.conditions;
      }

      if (step.parentConditionalId) {
        jsonStep.parentConditionalId = step.parentConditionalId;
      }

      if (step.children && step.children.length > 0) {
        jsonStep.children = convertStepsWithNesting(step.children);
      }

      return jsonStep;
    });
  };

  return convertStepsWithNesting(steps);
};

const reconstructFromNestedJSON = (nestedSteps: any[]): ConditionalStep[] => {
  if (!nestedSteps || nestedSteps.length === 0) {
    // Return default root structure if no steps
    return [{
      id: 'start-node',
      name: 'Start',
      description: 'Click to add steps or use the Add Node button',
      type: 'instruction',
      config: {},
      order: 0,
      children: []
    }];
  }

  const convertStepsFromNested = (stepList: any[]): ConditionalStep[] => {
    return stepList.map((step) => {
      const conditionalStep: ConditionalStep = {
        id: step.id, // Always use the existing ID - never regenerate
        name: step.name,
        description: step.description || '',
        type: step.type || 'instruction',
        config: step.config || {},
        order: step.order || 0, // Preserve order from backend
        enabled: step.enabled !== false,
        hasIssues: step.hasIssues || false,
        children: [] // Initialize children array
      };

      // Handle condition metadata
      if (step.type === 'condition' && step.conditions) {
        conditionalStep.conditions = step.conditions;
      }

      // Handle parentConditionalId for conditional grouping
      if (step.parentConditionalId) {
        conditionalStep.parentConditionalId = step.parentConditionalId;
      }

      // Handle children - this is crucial for nested conditions
      if (step.children && Array.isArray(step.children) && step.children.length > 0) {
        conditionalStep.children = convertStepsFromNested(step.children);
      }

      return conditionalStep;
    });
  };

  const reconstructedSteps = convertStepsFromNested(nestedSteps);

  // Make sure we have proper root structure
  if (reconstructedSteps.length > 0 &&
    reconstructedSteps[0].name === 'Start' &&
    reconstructedSteps[0].description === 'Click to add steps or use the Add Node button') {
    return reconstructedSteps;
  }

  // If not proper structure, wrap in root node
  return [{
    id: 'start-node',
    name: 'Start',
    description: 'Click to add steps or use the Add Node button',
    type: 'instruction',
    config: {},
    order: 0,
    children: reconstructedSteps
  }];
};

const reconstructFromFlatJSON = (flatSteps: any[]): ConditionalStep[] => {
  if (!flatSteps || flatSteps.length === 0) return [];
  const result: ConditionalStep[] = [];
  const conditionSteps = new Map<string, ConditionalStep>();
  for (const flatStep of flatSteps) {
    if (flatStep.type === 'condition') {
      const conditionStep: ConditionalStep = {
        id: flatStep.id, // Always preserve existing ID
        name: flatStep.name,
        description: flatStep.description || '',
        type: 'condition',
        config: flatStep.config || {},
        conditions: flatStep.conditions,
        order: flatStep.order || flatStep.step_order,
        children: []
      };
      conditionSteps.set(conditionStep.id, conditionStep);
    }
  }
  for (const flatStep of flatSteps) {
    if (flatStep.type !== 'condition' && flatStep.conditions) {
      for (const [conditionId, conditionStep] of conditionSteps) {
        if (JSON.stringify(conditionStep.conditions) === JSON.stringify(flatStep.conditions)) {
          const childStep: ConditionalStep = {
            id: flatStep.id, // Always preserve existing ID
            name: flatStep.name,
            description: flatStep.description || '',
            type: flatStep.type || 'instruction',
            config: flatStep.config || {},
            order: flatStep.order || flatStep.step_order,
            children: []
          };
          conditionStep.children!.push(childStep);
          break;
        }
      }
    }
  }

  const sortedSteps = [...flatSteps].sort((a, b) => (a.order || a.step_order || 0) - (b.order || b.step_order || 0));
  let i = 0;

  while (i < sortedSteps.length) {
    const flatStep = sortedSteps[i];
    if (flatStep.type === 'condition') {
      const conditionGroup: ConditionalStep[] = [];
      while (i < sortedSteps.length && sortedSteps[i].type === 'condition') {
        const conditionStep = conditionSteps.get(sortedSteps[i].id);
        if (conditionStep) {
          conditionGroup.push(conditionStep);
        }
        i++;
      }
      conditionGroup.sort((a, b) => {
        const typeOrder = { 'if': 0, 'elseif': 1, 'else': 2 };
        return (typeOrder[a.conditions?.type as keyof typeof typeOrder] || 0) -
          (typeOrder[b.conditions?.type as keyof typeof typeOrder] || 0);
      });

      result.push(...conditionGroup);
    } else if (!flatStep.conditions) {
      const step: ConditionalStep = {
        id: flatStep.id, // Always preserve existing ID
        name: flatStep.name,
        description: flatStep.description || '',
        type: flatStep.type || 'instruction',
        config: flatStep.config || {},
        order: flatStep.order || flatStep.step_order,
        children: []
      };
      result.push(step);
      i++;
    } else {
      i++;
    }
  }

  return result;
};

const convertToLLMFormat = (steps: ConditionalStep[]): any[] => {
  return steps.map(step => {
    const llmStep: any = {
      step: step.name,
      description: step.description || undefined,
    };
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
    if (step.children && step.children.length > 0) {
      llmStep.then = convertToLLMFormat(step.children);
    }
    Object.keys(llmStep).forEach(key =>
      llmStep[key] === undefined && delete llmStep[key]
    );
    return llmStep;
  });
};

export default function WorkflowPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;
  const workflowId = params.workflowId as string;

  const { data: workflows = [], isLoading: isLoadingWorkflows } = useAgentWorkflows(agentId);
  const createWorkflowMutation = useCreateAgentWorkflow();
  const updateWorkflowMutation = useUpdateAgentWorkflow();
  const { data: agentTools, isLoading: isLoadingTools } = useAgentTools(agentId);
  const { data: agent, refetch: refetchAgent } = useAgent(agentId);

  const isEditing = !!workflowId;

  const [workflowName, setWorkflowName] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [triggerPhrase, setTriggerPhrase] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [steps, setSteps] = useState<ConditionalStep[]>([]);
  
  // Execution state
  const [isExecuteDialogOpen, setIsExecuteDialogOpen] = useState(false);
  const [currentWorkflow, setCurrentWorkflow] = useState<any>(null);

  // Wrapper for setSteps  
  const setStepsWithDebug = useCallback((newSteps: ConditionalStep[]) => {
    setSteps(newSteps);
  }, []);

  const [isLoading, setIsLoading] = useState(isEditing);

  // Create version data for tools manager
  const versionData = agent ? {
    version_id: (agent as any).version_id || 'current',
    configured_mcps: agent.configured_mcps || [],
    custom_mcps: agent.custom_mcps || [],
    system_prompt: agent.system_prompt || '',
    agentpress_tools: agent.agentpress_tools || {}
  } : undefined;

  const handleToolsUpdate = useCallback(async () => {
    await refetchAgent();
  }, [refetchAgent]);

  useEffect(() => {
    if (isEditing && workflows.length > 0) {
      const workflow = workflows.find(w => w.id === workflowId);
      if (workflow) {
        setWorkflowName(workflow.name);
        setWorkflowDescription(workflow.description || '');
        setTriggerPhrase(workflow.trigger_phrase || '');
        setIsDefault(workflow.is_default);

        let treeSteps: ConditionalStep[];
        try {
          // Check if workflow has proper nested structure
          const hasNestedStructure = workflow.steps.some((step: any) => step.children && Array.isArray(step.children) && step.children.length > 0);

          if (hasNestedStructure) {
            treeSteps = reconstructFromNestedJSON(workflow.steps);
          } else {
            treeSteps = reconstructFromFlatJSON(workflow.steps);
          }
        } catch (error) {
          console.warn('Error reconstructing workflow steps, using fallback:', error);
          treeSteps = reconstructFromFlatJSON(workflow.steps);
        }

        setSteps(treeSteps);
        setIsLoading(false);
      } else if (!isLoadingWorkflows) {
        toast.error('Workflow not found');
      }
    } else if (!isEditing) {
      setIsLoading(false);
    }
  }, [isEditing, workflows, workflowId, isLoadingWorkflows, router, agentId]);

  const handleSave = useCallback(async () => {
    if (!workflowName.trim()) {
      toast.error('Please enter a workflow name');
      return;
    }

    const nestedSteps = convertToNestedJSON(steps);

    try {
      if (isEditing) {
        const updateRequest: UpdateWorkflowRequest = {
          name: workflowName,
          description: workflowDescription,
          trigger_phrase: triggerPhrase || undefined,
          is_default: isDefault,
          steps: nestedSteps
        };
        await updateWorkflowMutation.mutateAsync({ agentId, workflowId, workflow: updateRequest });
        toast.success('Workflow updated successfully');
      } else {
        const createRequest: CreateWorkflowRequest = {
          name: workflowName,
          description: workflowDescription,
          trigger_phrase: triggerPhrase || undefined,
          is_default: isDefault,
          steps: nestedSteps
        };
        const newWorkflow = await createWorkflowMutation.mutateAsync({ agentId, workflow: createRequest });
        try {
          await updateWorkflowMutation.mutateAsync({
            agentId,
            workflowId: newWorkflow.id,
            workflow: { status: 'active' }
          });
        } catch (activationError) {
          console.warn('Failed to auto-activate workflow:', activationError);
        }

        toast.success('Workflow created and activated successfully');
      }
    } catch (error) {
      toast.error(`Failed to ${isEditing ? 'update' : 'create'} workflow`);
    }
  }, [workflowName, workflowDescription, triggerPhrase, isDefault, steps, agentId, workflowId, isEditing, createWorkflowMutation, updateWorkflowMutation, router]);

  const handleExecute = useCallback(() => {
    const workflow = workflows.find(w => w.id === workflowId);
    if (workflow) {
      setCurrentWorkflow(workflow);
      setIsExecuteDialogOpen(true);
    } else {
      toast.error('Workflow not found or not saved yet');
    }
  }, [workflows, workflowId]);

  const handleExecutionSuccess = useCallback(() => {
    setIsExecuteDialogOpen(false);
    setCurrentWorkflow(null);
  }, []);

  if (isLoading || isLoadingWorkflows) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p>Loading workflow...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <WorkflowBuilder
        steps={steps}
        onStepsChange={setStepsWithDebug}
        agentTools={agentTools}
        isLoadingTools={isLoadingTools}
        agentId={agentId}
        workflowId={workflowId}
        versionData={versionData}
        onToolsUpdate={handleToolsUpdate}
        workflowName={workflowName}
        workflowDescription={workflowDescription}
        onSave={handleSave}
        isSaving={createWorkflowMutation.isPending || updateWorkflowMutation.isPending}
        onExecute={isEditing ? handleExecute : undefined}
        isExecuting={false}
        onNameChange={setWorkflowName}
        onDescriptionChange={setWorkflowDescription}
      />
      
      <WorkflowExecutionDialog
        open={isExecuteDialogOpen}
        onOpenChange={setIsExecuteDialogOpen}
        workflow={currentWorkflow}
        agentId={agentId}
        onSuccess={handleExecutionSuccess}
      />
    </>
  );
} 