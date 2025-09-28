// Workflow Prompt Builder
// Takes workflow JSON and builds clear prompts for agent execution

import {
  ConditionalWorkflow,
  WorkflowStep,
  WorkflowJSON,
  Condition,
  ExecutionContext,
  buildExecutionPath,
  evaluateCondition
} from './conditional-workflow-types';

export interface PromptOptions {
  includeStepNumbers: boolean;
  includeDescriptions: boolean;
  includeConditionalDetails: boolean;
  format: 'detailed' | 'concise' | 'minimal';
}

export interface WorkflowPrompt {
  fullPrompt: string;
  sections: {
    header: string;
    steps: string;
    conditionals: string;
    guidelines: string;
  };
  executionPath?: string[];
}

export class WorkflowPromptBuilder {
  private workflow: ConditionalWorkflow;
  private options: PromptOptions;

  constructor(workflow: ConditionalWorkflow, options: Partial<PromptOptions> = {}) {
    this.workflow = workflow;
    this.options = {
      includeStepNumbers: options.includeStepNumbers ?? true,
      includeDescriptions: options.includeDescriptions ?? true,
      includeConditionalDetails: options.includeConditionalDetails ?? true,
      format: options.format ?? 'detailed'
    };
  }

  // Build complete workflow prompt
  buildPrompt(context?: ExecutionContext): WorkflowPrompt {
    const sections = {
      header: this.buildHeader(),
      steps: this.buildStepsSection(context),
      conditionals: this.buildConditionalsSection(),
      guidelines: this.buildGuidelines()
    };

    const fullPrompt = this.assemblePrompt(sections);
    
    let executionPath: string[] | undefined;
    if (context) {
      executionPath = buildExecutionPath(this.workflow, context);
    }

    return {
      fullPrompt,
      sections,
      executionPath
    };
  }

  // Build execution-specific prompt (when we know the path)
  buildExecutionPrompt(context: ExecutionContext): WorkflowPrompt {
    const executionPath = buildExecutionPath(this.workflow, context);
    const sections = {
      header: this.buildHeader(),
      steps: this.buildExecutionStepsSection(executionPath, context),
      conditionals: '', // Not needed for execution
      guidelines: this.buildExecutionGuidelines()
    };

    const fullPrompt = this.assemblePrompt(sections);

    return {
      fullPrompt,
      sections,
      executionPath
    };
  }

  private buildHeader(): string {
    const { name, description } = this.workflow;
    
    let header = `You are executing workflow: "${name}"`;
    
    if (description && this.options.includeDescriptions) {
      header += `\n\nWorkflow Description: ${description}`;
    }

    return header;
  }

  private buildStepsSection(context?: ExecutionContext): string {
    if (this.options.format === 'minimal') {
      return this.buildMinimalSteps();
    }

    let stepsText = '\n\nWorkflow Steps:\n';
    const steps = this.workflow.steps.sort((a, b) => a.order - b.order);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNumber = this.options.includeStepNumbers ? `${i + 1}. ` : '• ';
      
      stepsText += this.formatStep(step, stepNumber);
    }

    return stepsText;
  }

  private buildExecutionStepsSection(executionPath: string[], context: ExecutionContext): string {
    let stepsText = '\n\nExecution Steps (in order):\n';
    
    for (let i = 0; i < executionPath.length; i++) {
      const stepId = executionPath[i];
      const step = this.workflow.steps.find(s => s.id === stepId);
      if (!step) continue;

      const stepNumber = `${i + 1}. `;
      stepsText += this.formatExecutionStep(step, stepNumber, context);
    }

    return stepsText;
  }

  private buildMinimalSteps(): string {
    const steps = this.workflow.steps
      .filter(s => s.type === 'instruction')
      .sort((a, b) => a.order - b.order);

    return '\n\nSteps:\n' + steps.map((step, i) => 
      `${i + 1}. ${step.name}${step.instruction ? `: ${step.instruction}` : ''}`
    ).join('\n');
  }

  private formatStep(step: WorkflowStep, prefix: string): string {
    let stepText = `${prefix}${step.name}`;

    // Add type indicator
    if (step.type === 'if') {
      stepText += ' [CONDITION]';
    } else if (step.type === 'sequence') {
      stepText += ' [SEQUENCE]';
    } else if (step.type === 'trigger') {
      stepText += ' [TRIGGER]';
    }

    // Add description
    if (step.description && this.options.includeDescriptions) {
      stepText += `\n   Description: ${step.description}`;
    }

    // Add instruction or tool
    if (step.instruction) {
      stepText += `\n   Action: ${step.instruction}`;
    } else if (step.tool_name) {
      stepText += `\n   Tool: ${step.tool_name}`;
    }

    // Add condition details
    if (step.condition && this.options.includeConditionalDetails) {
      stepText += `\n   Condition: ${this.formatCondition(step.condition)}`;
      
      if (step.if_true_step_id || step.if_false_step_id) {
        const trueStep = this.workflow.steps.find(s => s.id === step.if_true_step_id);
        const falseStep = this.workflow.steps.find(s => s.id === step.if_false_step_id);
        
        stepText += '\n   Branches:';
        if (trueStep) stepText += `\n     • If TRUE → ${trueStep.name}`;
        if (falseStep) stepText += `\n     • If FALSE → ${falseStep.name}`;
      }
    }

    // Add connections
    if (step.next_step_id && this.options.format === 'detailed') {
      const nextStep = this.workflow.steps.find(s => s.id === step.next_step_id);
      if (nextStep) {
        stepText += `\n   Next: ${nextStep.name}`;
      }
    }

    return stepText + '\n\n';
  }

  private formatExecutionStep(step: WorkflowStep, prefix: string, context: ExecutionContext): string {
    let stepText = `${prefix}${step.name}`;

    if (step.instruction) {
      stepText += `\n   Execute: ${step.instruction}`;
    } else if (step.tool_name) {
      stepText += `\n   Use tool: ${step.tool_name}`;
    } else if (step.condition) {
      const result = evaluateCondition(step.condition, context);
      stepText += `\n   Condition: ${this.formatCondition(step.condition)}`;
      stepText += `\n   Result: ${result ? 'TRUE' : 'FALSE'}`;
    }

    return stepText + '\n\n';
  }

  private formatCondition(condition: Condition): string {
    const { variable, operation, value } = condition;
    
    switch (operation) {
      case 'equals':
        return `${variable} equals "${value}"`;
      case 'not_equals':
        return `${variable} does not equal "${value}"`;
      case 'contains':
        return `${variable} contains "${value}"`;
      case 'is_empty':
        return `${variable} is empty`;
      case 'is_not_empty':
        return `${variable} is not empty`;
      default:
        return `${variable} ${operation} ${value || ''}`;
    }
  }

  private buildConditionalsSection(): string {
    if (!this.options.includeConditionalDetails) return '';
    
    const conditionalSteps = this.workflow.steps.filter(s => s.type === 'if');
    if (conditionalSteps.length === 0) return '';

    let conditionalsText = '\n\nConditional Logic:\n';
    
    for (const step of conditionalSteps) {
      if (!step.condition) continue;
      
      conditionalsText += `• ${step.name}: ${this.formatCondition(step.condition)}\n`;
      
      const trueStep = this.workflow.steps.find(s => s.id === step.if_true_step_id);
      const falseStep = this.workflow.steps.find(s => s.id === step.if_false_step_id);
      
      if (trueStep) conditionalsText += `  → If TRUE: ${trueStep.name}\n`;
      if (falseStep) conditionalsText += `  → If FALSE: ${falseStep.name}\n`;
      conditionalsText += '\n';
    }

    return conditionalsText;
  }

  private buildGuidelines(): string {
    return '\n\nExecution Guidelines:\n' +
           '• Follow steps in the specified order\n' +
           '• Evaluate conditions carefully before branching\n' +
           '• Provide clear updates on your progress\n' +
           '• Use available tools as needed\n' +
           '• Complete each step thoroughly before proceeding\n';
  }

  private buildExecutionGuidelines(): string {
    return '\n\nExecution Guidelines:\n' +
           '• Execute steps in the exact order shown above\n' +
           '• The conditional logic has already been evaluated\n' +
           '• Focus on completing each step thoroughly\n' +
           '• Provide clear updates on your progress\n';
  }

  private assemblePrompt(sections: { header: string; steps: string; conditionals: string; guidelines: string }): string {
    return sections.header + 
           sections.steps + 
           sections.conditionals + 
           sections.guidelines;
  }
}

// Utility functions for common use cases

export function buildWorkflowPrompt(
  workflow: ConditionalWorkflow,
  options?: Partial<PromptOptions>
): string {
  const builder = new WorkflowPromptBuilder(workflow, options);
  return builder.buildPrompt().fullPrompt;
}

export function buildExecutionPrompt(
  workflow: ConditionalWorkflow,
  context: ExecutionContext,
  options?: Partial<PromptOptions>
): string {
  const builder = new WorkflowPromptBuilder(workflow, options);
  return builder.buildExecutionPrompt(context).fullPrompt;
}

export function buildWorkflowPromptFromJSON(
  workflowJSON: WorkflowJSON,
  options?: Partial<PromptOptions>
): string {
  // Convert JSON back to workflow object
  const workflow: ConditionalWorkflow = {
    id: workflowJSON.workflow.id,
    agent_id: workflowJSON.workflow.agent_id,
    name: workflowJSON.workflow.name,
    description: workflowJSON.workflow.description,
    status: workflowJSON.workflow.status,
    trigger_phrase: workflowJSON.workflow.trigger_phrase,
    is_default: workflowJSON.workflow.is_default,
    steps: workflowJSON.flow.steps,
    root_step_id: workflowJSON.flow.root_step_id,
    variables: workflowJSON.flow.variables,
    created_at: workflowJSON.workflow.created_at,
    updated_at: workflowJSON.workflow.updated_at
  };

  return buildWorkflowPrompt(workflow, options);
}

// Enhanced prompt builder for the existing backend system
export function enhanceAgentSystemPrompt(
  baseSystemPrompt: string,
  workflow: ConditionalWorkflow,
  inputData?: Record<string, any>,
  options?: Partial<PromptOptions>
): string {
  const workflowPrompt = buildWorkflowPrompt(workflow, options);
  
  let inputSection = '';
  if (inputData && Object.keys(inputData).length > 0) {
    inputSection = `\n\nWorkflow Input Data:\n${JSON.stringify(inputData, null, 2)}`;
  }

  return `${baseSystemPrompt}

--- WORKFLOW EXECUTION MODE ---
${workflowPrompt}${inputSection}

You are now in workflow execution mode. Follow the workflow steps above while maintaining your core personality and capabilities.`;
} 