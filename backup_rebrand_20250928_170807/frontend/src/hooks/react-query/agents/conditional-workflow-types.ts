// Conditional Workflow Types
// Clean conditional workflow system - conditionals are just decision points between steps

export type StepType = 
  | 'instruction'    // Basic instruction step
  | 'if'            // If condition branch
  | 'sequence'      // Group of steps in sequence
  | 'trigger';      // Trigger/schedule step

export interface Condition {
  variable: string;           // What to check (e.g., "user_input", "previous_output")
  operation: 'contains' | 'equals' | 'not_equals' | 'is_empty' | 'is_not_empty';
  value?: string;            // Value to compare against
  description?: string;      // Human readable description
}

export interface WorkflowStep {
  id: string;
  name: string;
  description?: string;
  type: StepType;
  order: number;
  
  // For instruction steps
  instruction?: string;
  tool_name?: string;
  
  // For conditional steps - just if/else
  condition?: Condition;
  if_true_step_id?: string;    // Step ID to go to if condition is true
  if_false_step_id?: string;   // Step ID to go to if condition is false
  
  // For sequence steps
  child_step_ids?: string[];   // Array of step IDs in this sequence
  
  // Connection to next step
  next_step_id?: string;       // Next step after this one completes
  
  // UI positioning
  position?: { x: number; y: number };
}

export interface ConditionalWorkflow {
  id: string;
  agent_id: string;
  name: string;
  description?: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  trigger_phrase?: string;
  is_default: boolean;
  
  // Just a flat array of steps with connections
  steps: WorkflowStep[];
  root_step_id?: string;       // Starting step
  
  // Global variables
  variables?: Record<string, any>;
  
  created_at: string;
  updated_at: string;
}

// Execution context
export interface ExecutionContext {
  variables: Record<string, any>;
  previous_outputs: Record<string, any>;  // Step ID -> output
  user_input?: string;
  current_step_id?: string;
}

// Workflow JSON for storage
export interface WorkflowJSON {
  workflow: {
    id: string;
    name: string;
    description?: string;
    agent_id: string;
    status: 'draft' | 'active' | 'paused' | 'archived';
    trigger_phrase?: string;
    is_default: boolean;
    created_at: string;
    updated_at: string;
  };
  flow: {
    root_step_id?: string;
    steps: WorkflowStep[];
    variables?: Record<string, any>;
  };
}

// For API requests
export interface CreateWorkflowRequest {
  name: string;
  description?: string;
  trigger_phrase?: string;
  is_default?: boolean;
  steps: Array<{
    name: string;
    description?: string;
    type?: StepType;
    instruction?: string;
    tool_name?: string;
    condition?: Condition;
    if_true_step_id?: string;
    if_false_step_id?: string;
    child_step_ids?: string[];
    next_step_id?: string;
    order: number;
  }>;
  root_step_id?: string;
  variables?: Record<string, any>;
}

export interface UpdateWorkflowRequest {
  name?: string;
  description?: string;
  trigger_phrase?: string;
  is_default?: boolean;
  status?: 'draft' | 'active' | 'paused' | 'archived';
  steps?: Array<{
    id?: string;
    name: string;
    description?: string;
    type?: StepType;
    instruction?: string;
    tool_name?: string;
    condition?: Condition;
    if_true_step_id?: string;
    if_false_step_id?: string;
    child_step_ids?: string[];
    next_step_id?: string;
    order: number;
  }>;
  root_step_id?: string;
  variables?: Record<string, any>;
}

// Condition evaluation
export function evaluateCondition(
  condition: Condition, 
  context: ExecutionContext
): boolean {
  let variableValue: any;
  
  // Get variable value from context
  if (condition.variable === 'user_input') {
    variableValue = context.user_input;
  } else if (condition.variable.startsWith('step_')) {
    // Reference to previous step output: step_<step_id>
    const stepId = condition.variable.replace('step_', '');
    variableValue = context.previous_outputs[stepId];
  } else {
    variableValue = context.variables[condition.variable];
  }
  
  // Evaluate condition
  switch (condition.operation) {
    case 'equals':
      return String(variableValue) === String(condition.value);
    case 'not_equals':
      return String(variableValue) !== String(condition.value);
    case 'contains':
      return String(variableValue).toLowerCase().includes(String(condition.value).toLowerCase());
    case 'is_empty':
      return !variableValue || String(variableValue).trim() === '';
    case 'is_not_empty':
      return variableValue && String(variableValue).trim() !== '';
    default:
      return false;
  }
}

// Workflow execution path builder
export function buildExecutionPath(
  workflow: ConditionalWorkflow,
  context: ExecutionContext
): string[] {
  const path: string[] = [];
  const visited = new Set<string>();
  
  let currentStepId = workflow.root_step_id;
  if (!currentStepId && workflow.steps.length > 0) {
    // Find first step by order
    currentStepId = workflow.steps.sort((a, b) => a.order - b.order)[0].id;
  }
  
  while (currentStepId && !visited.has(currentStepId)) {
    visited.add(currentStepId);
    path.push(currentStepId);
    
    const step = workflow.steps.find(s => s.id === currentStepId);
    if (!step) break;
    
    // Determine next step based on step type
    if (step.type === 'if' && step.condition) {
      const conditionResult = evaluateCondition(step.condition, context);
      currentStepId = conditionResult ? step.if_true_step_id : step.if_false_step_id;
    } else if (step.type === 'sequence' && step.child_step_ids) {
      currentStepId = step.child_step_ids[0] || step.next_step_id;
    } else {
      currentStepId = step.next_step_id;
    }
  }
  
  return path;
}

// Convert workflow to JSON
export function workflowToJSON(workflow: ConditionalWorkflow): WorkflowJSON {
  return {
    workflow: {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      agent_id: workflow.agent_id,
      status: workflow.status,
      trigger_phrase: workflow.trigger_phrase,
      is_default: workflow.is_default,
      created_at: workflow.created_at,
      updated_at: workflow.updated_at
    },
    flow: {
      root_step_id: workflow.root_step_id,
      steps: workflow.steps,
      variables: workflow.variables
    }
  };
}

// Create a workflow step
export function createStep(
  name: string,
  type: StepType,
  order: number,
  options: {
    description?: string;
    instruction?: string;
    tool_name?: string;
    condition?: Condition;
    if_true_step_id?: string;
    if_false_step_id?: string;
    next_step_id?: string;
  } = {}
): Omit<WorkflowStep, 'id'> {
  return {
    name,
    type,
    order,
    description: options.description,
    instruction: options.instruction,
    tool_name: options.tool_name,
    condition: options.condition,
    if_true_step_id: options.if_true_step_id,
    if_false_step_id: options.if_false_step_id,
    next_step_id: options.next_step_id
  };
}

// Create a condition
export function createCondition(
  variable: string,
  operation: 'contains' | 'equals' | 'not_equals' | 'is_empty' | 'is_not_empty',
  value?: string,
  description?: string
): Condition {
  return {
    variable,
    operation,
    value,
    description
  };
}

// Validation
export function validateWorkflow(workflow: ConditionalWorkflow): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check for steps
  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push('Workflow must have at least one step');
    return { isValid: false, errors };
  }
  
  // Check for valid step connections
  for (const step of workflow.steps) {
    if (step.type === 'if') {
      if (!step.condition) {
        errors.push(`If step "${step.name}" must have a condition`);
      }
      if (!step.if_true_step_id && !step.if_false_step_id) {
        errors.push(`If step "${step.name}" must have at least one branch`);
      }
    } else if (step.type === 'instruction') {
      if (!step.instruction && !step.tool_name) {
        errors.push(`Instruction step "${step.name}" must have either instruction text or tool name`);
      }
    }
  }
  
  // Check for circular references (basic check)
  const stepIds = new Set(workflow.steps.map(s => s.id));
  for (const step of workflow.steps) {
    if (step.next_step_id && !stepIds.has(step.next_step_id)) {
      errors.push(`Step "${step.name}" references non-existent next step`);
    }
    if (step.if_true_step_id && !stepIds.has(step.if_true_step_id)) {
      errors.push(`Step "${step.name}" references non-existent true branch step`);
    }
    if (step.if_false_step_id && !stepIds.has(step.if_false_step_id)) {
      errors.push(`Step "${step.name}" references non-existent false branch step`);
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
} 