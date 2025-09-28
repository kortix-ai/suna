// Workflow Builder
// Creates clean JSON representations of workflows with step connections

import {
  ConditionalWorkflow,
  WorkflowStep,
  WorkflowJSON,
  StepType,
  Condition,
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  workflowToJSON,
  validateWorkflow
} from './conditional-workflow-types';

export class WorkflowBuilder {
  public workflow: Partial<ConditionalWorkflow>;
  public steps: Map<string, WorkflowStep>;
  public stepOrder: number = 1;

  constructor(agentId: string, name: string) {
    this.workflow = {
      agent_id: agentId,
      name,
      status: 'draft',
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.steps = new Map();
  }

  // Set workflow metadata
  setDescription(description: string): this {
    this.workflow.description = description;
    return this;
  }

  setTriggerPhrase(phrase: string): this {
    this.workflow.trigger_phrase = phrase;
    return this;
  }

  setAsDefault(isDefault: boolean = true): this {
    this.workflow.is_default = isDefault;
    return this;
  }

  setStatus(status: 'draft' | 'active' | 'paused' | 'archived'): this {
    this.workflow.status = status;
    return this;
  }

  setRootStep(stepId: string): this {
    this.workflow.root_step_id = stepId;
    return this;
  }

  setVariables(variables: Record<string, any>): this {
    this.workflow.variables = variables;
    return this;
  }

  // Add steps
  addInstructionStep(
    id: string,
    name: string,
    instruction: string,
    options: {
      description?: string;
      nextStepId?: string;
      order?: number;
    } = {}
  ): this {
    const step: WorkflowStep = {
      id,
      name,
      description: options.description,
      type: 'instruction',
      order: options.order || this.stepOrder++,
      instruction,
      next_step_id: options.nextStepId
    };
    
    this.steps.set(id, step);
    return this;
  }

  addToolStep(
    id: string,
    name: string,
    toolName: string,
    options: {
      description?: string;
      nextStepId?: string;
      order?: number;
    } = {}
  ): this {
    const step: WorkflowStep = {
      id,
      name,
      description: options.description,
      type: 'instruction',
      order: options.order || this.stepOrder++,
      tool_name: toolName,
      next_step_id: options.nextStepId
    };
    
    this.steps.set(id, step);
    return this;
  }

  addIfStep(
    id: string,
    name: string,
    condition: Condition,
    options: {
      description?: string;
      ifTrueStepId?: string;
      ifFalseStepId?: string;
      order?: number;
    } = {}
  ): this {
    const step: WorkflowStep = {
      id,
      name,
      description: options.description,
      type: 'if',
      order: options.order || this.stepOrder++,
      condition,
      if_true_step_id: options.ifTrueStepId,
      if_false_step_id: options.ifFalseStepId
    };
    
    this.steps.set(id, step);
    return this;
  }

  addSequenceStep(
    id: string,
    name: string,
    childStepIds: string[],
    options: {
      description?: string;
      nextStepId?: string;
      order?: number;
    } = {}
  ): this {
    const step: WorkflowStep = {
      id,
      name,
      description: options.description,
      type: 'sequence',
      order: options.order || this.stepOrder++,
      child_step_ids: childStepIds,
      next_step_id: options.nextStepId
    };
    
    this.steps.set(id, step);
    return this;
  }

  addTriggerStep(
    id: string,
    name: string,
    options: {
      description?: string;
      nextStepId?: string;
      order?: number;
    } = {}
  ): this {
    const step: WorkflowStep = {
      id,
      name,
      description: options.description,
      type: 'trigger',
      order: options.order || this.stepOrder++,
      next_step_id: options.nextStepId
    };
    
    this.steps.set(id, step);
    return this;
  }

  // Update existing steps
  updateStep(
    id: string,
    updates: Partial<Omit<WorkflowStep, 'id'>>
  ): this {
    const existingStep = this.steps.get(id);
    if (existingStep) {
      this.steps.set(id, { ...existingStep, ...updates });
    }
    return this;
  }

  // Connect steps
  connectSteps(fromStepId: string, toStepId: string): this {
    const fromStep = this.steps.get(fromStepId);
    if (fromStep) {
      fromStep.next_step_id = toStepId;
      this.steps.set(fromStepId, fromStep);
    }
    return this;
  }

  connectIfBranch(
    ifStepId: string,
    trueStepId?: string,
    falseStepId?: string
  ): this {
    const ifStep = this.steps.get(ifStepId);
    if (ifStep && ifStep.type === 'if') {
      if (trueStepId) ifStep.if_true_step_id = trueStepId;
      if (falseStepId) ifStep.if_false_step_id = falseStepId;
      this.steps.set(ifStepId, ifStep);
    }
    return this;
  }

  // Remove steps
  removeStep(id: string): this {
    this.steps.delete(id);
    
    // Clean up references to this step
    for (const [stepId, step] of this.steps) {
      if (step.next_step_id === id) {
        step.next_step_id = undefined;
      }
      if (step.if_true_step_id === id) {
        step.if_true_step_id = undefined;
      }
      if (step.if_false_step_id === id) {
        step.if_false_step_id = undefined;
      }
      if (step.child_step_ids?.includes(id)) {
        step.child_step_ids = step.child_step_ids.filter(childId => childId !== id);
      }
    }
    
    // Update root step if needed
    if (this.workflow.root_step_id === id) {
      this.workflow.root_step_id = undefined;
    }
    
    return this;
  }

  // Build workflow
  build(): ConditionalWorkflow {
    if (!this.workflow.id) {
      this.workflow.id = `workflow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    const workflow = {
      ...this.workflow,
      steps: Array.from(this.steps.values()).sort((a, b) => a.order - b.order)
    } as ConditionalWorkflow;
    
    // Auto-set root step if not set
    if (!workflow.root_step_id && workflow.steps.length > 0) {
      workflow.root_step_id = workflow.steps[0].id;
    }
    
    return workflow;
  }

  // Build JSON
  buildJSON(): WorkflowJSON {
    const workflow = this.build();
    return workflowToJSON(workflow);
  }

  // Build API request
  buildCreateRequest(): CreateWorkflowRequest {
    const workflow = this.build();
    
    return {
      name: workflow.name,
      description: workflow.description,
      trigger_phrase: workflow.trigger_phrase,
      is_default: workflow.is_default,
      steps: workflow.steps.map(step => ({
        name: step.name,
        description: step.description,
        type: step.type,
        instruction: step.instruction,
        tool_name: step.tool_name,
        condition: step.condition,
        if_true_step_id: step.if_true_step_id,
        if_false_step_id: step.if_false_step_id,
        child_step_ids: step.child_step_ids,
        next_step_id: step.next_step_id,
        order: step.order
      })),
      root_step_id: workflow.root_step_id,
      variables: workflow.variables
    };
  }

  // Validation
  validate(): { isValid: boolean; errors: string[] } {
    const workflow = this.build();
    return validateWorkflow(workflow);
  }

  // Clone builder
  clone(): WorkflowBuilder {
    const newBuilder = new WorkflowBuilder(
      this.workflow.agent_id!,
      this.workflow.name!
    );
    
    newBuilder.workflow = { ...this.workflow };
    newBuilder.steps = new Map(this.steps);
    newBuilder.stepOrder = this.stepOrder;
    
    return newBuilder;
  }
}

// Helper functions for common workflow patterns

// Linear workflow: Step 1 → Step 2 → Step 3
export function createLinearWorkflow(
  agentId: string,
  name: string,
  steps: Array<{
    id: string;
    name: string;
    instruction: string;
    description?: string;
  }>
): ConditionalWorkflow {
  const builder = new WorkflowBuilder(agentId, name);
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const nextStepId = i < steps.length - 1 ? steps[i + 1].id : undefined;
    
    builder.addInstructionStep(step.id, step.name, step.instruction, {
      description: step.description,
      nextStepId
    });
  }
  
  return builder.build();
}

// Conditional workflow: Step 1 → Condition → Branch A or Branch B
export function createConditionalWorkflow(
  agentId: string,
  name: string,
  initialStep: { id: string; name: string; instruction: string },
  condition: { id: string; name: string; condition: Condition },
  trueBranch: { id: string; name: string; instruction: string },
  falseBranch: { id: string; name: string; instruction: string }
): ConditionalWorkflow {
  const builder = new WorkflowBuilder(agentId, name);
  
  // Add initial step
  builder.addInstructionStep(
    initialStep.id,
    initialStep.name,
    initialStep.instruction,
    { nextStepId: condition.id }
  );
  
  // Add condition step
  builder.addIfStep(
    condition.id,
    condition.name,
    condition.condition,
    {
      ifTrueStepId: trueBranch.id,
      ifFalseStepId: falseBranch.id
    }
  );
  
  // Add branches
  builder.addInstructionStep(
    trueBranch.id,
    trueBranch.name,
    trueBranch.instruction
  );
  
  builder.addInstructionStep(
    falseBranch.id,
    falseBranch.name,
    falseBranch.instruction
  );
  
  return builder.build();
}

// Create workflow from existing data
export function createWorkflowFromJSON(json: WorkflowJSON): WorkflowBuilder {
  const builder = new WorkflowBuilder(
    json.workflow.agent_id,
    json.workflow.name
  );
  
  builder.workflow.id = json.workflow.id;
  builder.workflow.description = json.workflow.description;
  builder.workflow.status = json.workflow.status;
  builder.workflow.trigger_phrase = json.workflow.trigger_phrase;
  builder.workflow.is_default = json.workflow.is_default;
  builder.workflow.created_at = json.workflow.created_at;
  builder.workflow.updated_at = json.workflow.updated_at;
  builder.workflow.root_step_id = json.flow.root_step_id;
  builder.workflow.variables = json.flow.variables;
  
  // Add all steps
  for (const step of json.flow.steps) {
    builder.steps.set(step.id, step);
  }
  
  return builder;
}

// Utility to generate step IDs
export function generateStepId(prefix: string = 'step'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

// Utility to generate workflow ID
export function generateWorkflowId(): string {
  return `workflow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Export all step types for easy reference
export const STEP_TYPES: Record<string, StepType> = {
  INSTRUCTION: 'instruction',
  IF: 'if',
  SEQUENCE: 'sequence',
  TRIGGER: 'trigger'
};

// Export condition operations
export const CONDITION_OPERATIONS = {
  CONTAINS: 'contains',
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  IS_EMPTY: 'is_empty',
  IS_NOT_EMPTY: 'is_not_empty'
} as const; 