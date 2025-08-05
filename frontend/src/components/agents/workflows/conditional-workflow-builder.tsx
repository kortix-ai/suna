'use client';

import React, { useState, useCallback, useMemo } from 'react';
import {
  Plus,
  Trash2,
  AlertTriangle,
  ChevronsUpDown,
  Check,
  MoreHorizontal
} from 'lucide-react';
import { Button } from '@/components/ui/button';

import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

export interface ConditionalStep {
  id: string;
  name: string;
  description: string;
  type: 'instruction' | 'condition' | 'parallel' | 'sequence';
  config: Record<string, any>;
  conditions?: {
    type: 'if' | 'else' | 'elseif';
    expression?: string;
  };
  children?: ConditionalStep[];
  order: number;
  enabled?: boolean;
  hasIssues?: boolean;
  position?: { x: number; y: number }; // Added for storing node positions
  parentConditionalId?: string; // Added for nested conditional grouping
}

interface ConditionalWorkflowBuilderProps {
  steps: ConditionalStep[];
  onStepsChange: (steps: ConditionalStep[]) => void;
  agentTools?: {
    agentpress_tools: Array<{ name: string; description: string; icon?: string; enabled: boolean }>;
    mcp_tools: Array<{ name: string; description: string; icon?: string; server?: string }>;
  };
  isLoadingTools?: boolean;
}

const normalizeToolName = (toolName: string, toolType: 'agentpress' | 'mcp') => {
  if (toolType === 'agentpress') {
    const agentPressMapping: Record<string, string> = {
      'sb_shell_tool': 'Shell Tool',
      'sb_files_tool': 'Files Tool',
      'stagehand_browser_tool': 'Browser Tool',
      'sb_deploy_tool': 'Deploy Tool',
      'sb_expose_tool': 'Expose Tool',
      'web_search_tool': 'Web Search',
      'sb_vision_tool': 'Vision Tool',
      'data_providers_tool': 'Data Providers',
      'sb_sheets_tool': 'Sheets Tool',
    };
    return agentPressMapping[toolName] || toolName;
  } else {
    return toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }
};

export function ConditionalWorkflowBuilder({
  steps,
  onStepsChange,
  agentTools,
  isLoadingTools
}: ConditionalWorkflowBuilderProps) {
  const [toolSearchOpen, setToolSearchOpen] = useState<{ [key: string]: boolean }>({});
  const [activeConditionTab, setActiveConditionTab] = useState<{ [key: string]: string }>({});

  steps.forEach((step, index) => {
    console.log(`Step ${index}:`, {
      name: step.name,
      type: step.type,
      hasChildren: !!step.children,
      childrenCount: step.children?.length || 0,
      children: step.children?.map(child => ({ name: child.name, type: child.type }))
    });
  });

  const generateId = () => Math.random().toString(36).substr(2, 9);

  const addStep = useCallback((parentId?: string, afterStepId?: string) => {
    const newStep: ConditionalStep = {
      id: generateId(),
      name: 'Step',
      description: '',
      type: 'instruction',
      config: {},
      order: 0,
      enabled: true,
    };

    const updateSteps = (items: ConditionalStep[]): { updatedItems: ConditionalStep[], found: boolean } => {
      if (!parentId) {
        if (afterStepId) {
          const index = items.findIndex(s => s.id === afterStepId);
          return {
            updatedItems: [...items.slice(0, index + 1), newStep, ...items.slice(index + 1)],
            found: true
          };
        }
        return { updatedItems: [...items, newStep], found: true };
      }

      let found = false;
      const updatedItems = items.map(step => {
        if (step.id === parentId) {
          found = true;
          return {
            ...step,
            children: [...(step.children || []), newStep]
          };
        }
        if (step.children && !found) {
          const result = updateSteps(step.children);
          if (result.found) {
            found = true;
            return {
              ...step,
              children: result.updatedItems
            };
          }
        }
        return step;
      });

      return { updatedItems, found };
    };

    const result = updateSteps(steps);
    onStepsChange(result.updatedItems);
  }, [steps, onStepsChange]);

  const addCondition = useCallback((afterStepId: string) => {
    const ifStep: ConditionalStep = {
      id: generateId(),
      name: 'If',
      description: '',
      type: 'condition',
      config: {},
      conditions: { type: 'if', expression: '' },
      children: [],
      order: 0,
      enabled: true,
      hasIssues: true
    };

    const updateSteps = (items: ConditionalStep[]): ConditionalStep[] => {
      const index = items.findIndex(s => s.id === afterStepId);
      if (index !== -1) {
        return [
          ...items.slice(0, index + 1),
          ifStep,
          ...items.slice(index + 1)
        ];
      }

      return items.map(step => {
        if (step.children) {
          return {
            ...step,
            children: updateSteps(step.children)
          };
        }
        return step;
      });
    };

    onStepsChange(updateSteps(steps));
  }, [steps, onStepsChange]);

  const addElseCondition = useCallback((siblingId: string) => {
    const elseIfStep: ConditionalStep = {
      id: generateId(),
      name: 'Else If',
      description: '',
      type: 'condition',
      config: {},
      conditions: { type: 'elseif', expression: '' },
      children: [],
      order: 0,
      enabled: true,
      hasIssues: true
    };

    const updateSteps = (items: ConditionalStep[]): ConditionalStep[] => {
      const index = items.findIndex(s => s.id === siblingId);
      if (index !== -1) {
        return [
          ...items.slice(0, index + 1),
          elseIfStep,
          ...items.slice(index + 1)
        ];
      }

      return items.map(step => {
        if (step.children) {
          return {
            ...step,
            children: updateSteps(step.children)
          };
        }
        return step;
      });
    };

    onStepsChange(updateSteps(steps));
  }, [steps, onStepsChange]);

  const addFinalElse = useCallback((siblingId: string) => {
    const elseStep: ConditionalStep = {
      id: generateId(),
      name: 'Else',
      description: '',
      type: 'condition',
      config: {},
      conditions: { type: 'else' },
      children: [],
      order: 0,
      enabled: true,
      hasIssues: false
    };

    const updateSteps = (items: ConditionalStep[]): ConditionalStep[] => {
      const index = items.findIndex(s => s.id === siblingId);
      if (index !== -1) {
        return [
          ...items.slice(0, index + 1),
          elseStep,
          ...items.slice(index + 1)
        ];
      }

      return items.map(step => {
        if (step.children) {
          return {
            ...step,
            children: updateSteps(step.children)
          };
        }
        return step;
      });
    };

    onStepsChange(updateSteps(steps));
  }, [steps, onStepsChange]);

  const updateStep = useCallback((stepId: string, updates: Partial<ConditionalStep>) => {
    const updateSteps = (items: ConditionalStep[]): ConditionalStep[] => {
      return items.map(step => {
        if (step.id === stepId) {
          const updatedStep = { ...step, ...updates };
          if (updatedStep.type === 'instruction' && updatedStep.name && updatedStep.name !== 'New Step') {
            updatedStep.hasIssues = false;
          } else if (updatedStep.type === 'condition' &&
            (updatedStep.conditions?.type === 'if' || updatedStep.conditions?.type === 'elseif') &&
            updatedStep.conditions?.expression) {
            updatedStep.hasIssues = false;
          } else if (updatedStep.type === 'condition' && updatedStep.conditions?.type === 'else') {
            updatedStep.hasIssues = false;
          }
          return updatedStep;
        }
        if (step.children) {
          return {
            ...step,
            children: updateSteps(step.children)
          };
        }
        return step;
      });
    };
    onStepsChange(updateSteps(steps));
  }, [steps, onStepsChange]);

  const removeStep = useCallback((stepId: string) => {
    const removeFromSteps = (items: ConditionalStep[]): ConditionalStep[] => {
      return items
        .filter(step => step.id !== stepId)
        .map(step => {
          if (step.children) {
            return {
              ...step,
              children: removeFromSteps(step.children)
            };
          }
          return step;
        });
    };

    onStepsChange(removeFromSteps(steps));
  }, [steps, onStepsChange]);

  const getStepNumber = useCallback((stepId: string, items: ConditionalStep[] = steps, counter = { value: 0 }): number => {
    for (const step of items) {
      counter.value++;
      if (step.id === stepId) {
        return counter.value;
      }
      if (step.children && step.children.length > 0) {
        const found = getStepNumber(stepId, step.children, counter);
        if (found > 0) return found;
      }
    }
    return 0;
  }, [steps]);

  const getConditionLetter = (index: number) => {
    return String.fromCharCode(65 + index);
  };

  const renderConditionTabs = (conditionSteps: ConditionalStep[], groupKey: string) => {
    const activeTabId = activeConditionTab[groupKey] || conditionSteps[0]?.id;
    const activeStep = conditionSteps.find(s => s.id === activeTabId) || conditionSteps[0];
    const hasElse = conditionSteps.some(step => step.conditions?.type === 'else');

    const handleKeyDown = (e: React.KeyboardEvent, step: ConditionalStep) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        if (conditionSteps.length > 1 && !(conditionSteps.length === 1 && step.conditions?.type === 'if')) {
          removeStep(step.id);
          const remainingConditions = conditionSteps.filter(s => s.id !== step.id);
          if (remainingConditions.length > 0) {
            setActiveConditionTab(prev => ({ ...prev, [groupKey]: remainingConditions[0].id }));
          }
        }
      }
    };

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          {conditionSteps.map((step, index) => {
            const letter = getConditionLetter(index);
            const isActive = step.id === activeTabId;
            const conditionType = step.conditions?.type === 'if' ? 'If' :
              step.conditions?.type === 'elseif' ? 'Else If' :
                step.conditions?.type === 'else' ? 'Else' : 'If';
            return (
              <button
                key={step.id}
                onClick={() => setActiveConditionTab(prev => ({ ...prev, [groupKey]: step.id }))}
                onKeyDown={(e) => handleKeyDown(e, step)}
                tabIndex={0}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-md border text-sm font-medium transition-all",
                  isActive
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-background border-border text-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <span className="font-mono text-xs">{letter}</span>
                <span>•</span>
                <span>{conditionType}</span>
                {step.hasIssues && (
                  <AlertTriangle className="h-3 w-3 text-destructive" />
                )}
              </button>
            );
          })}
          {!hasElse && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => addElseCondition(conditionSteps[conditionSteps.length - 1].id)}
              className="h-9 px-3 border-dashed text-xs"
            >
              <Plus className="h-3 w-3 mr-1" />
              Else If
            </Button>
          )}
          {!hasElse && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => addFinalElse(conditionSteps[conditionSteps.length - 1].id)}
              className="h-9 px-3 border-dashed text-xs"
            >
              <Plus className="h-3 w-3 mr-1" />
              Else
            </Button>
          )}
        </div>
        {activeStep && (
          <div className="bg-muted/50 rounded-lg p-4 border">
            {(activeStep.conditions?.type === 'if' || activeStep.conditions?.type === 'elseif') ? (
              <div className="space-y-3">
                <Label className="text-sm font-medium">
                  {activeStep.conditions?.type === 'if' ? 'Condition' : 'Else If Condition'}
                </Label>
                <Input
                  type="text"
                  value={activeStep.conditions.expression || ''}
                  onChange={(e) => updateStep(activeStep.id, {
                    conditions: { ...activeStep.conditions, expression: e.target.value }
                  })}
                  placeholder="e.g., user asks about pricing"
                  className="w-full bg-transparent text-sm px-3 py-2 rounded-md"
                />
              </div>
            ) : (
              <div className="text-sm text-muted-foreground font-medium">
                Otherwise (fallback condition)
              </div>
            )}
            <div className="mt-4 space-y-3">
              {activeStep.children && activeStep.children.length > 0 && (
                <>
                  {activeStep.children.map((child, index) => renderStep(child, index + 1, true, activeStep.id))}
                </>
              )}
              <div className="flex justify-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => addStep(activeStep.id)}
                  className="border-dashed text-xs"
                >
                  <Plus className="h-3 w-3" />
                  Add step
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderStep = (step: ConditionalStep, stepNumber: number, isNested: boolean = false, parentId?: string) => {
    const isCondition = step.type === 'condition';
    const isSequence = step.type === 'sequence';

    if (isCondition) {
      return null;
    }

    return (
      <div key={step.id} className="group">
        <div className="bg-card rounded-lg border shadow-sm p-4 transition-shadow">
          <div className="flex items-start gap-4">
            <div className="flex items-center gap-2 shrink-0">
              {step.hasIssues && (
                <AlertTriangle className="h-4 w-4 text-destructive" />
              )}
              <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-muted-foreground">
                {stepNumber}
              </div>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-3">
                {isSequence ? (
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded bg-primary/10 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-primary" />
                    </div>
                    <span className="text-base font-medium">{step.description}</span>
                  </div>
                ) : (
                  <input
                    type="text"
                    value={step.name + ' ' + stepNumber}
                    onChange={(e) => updateStep(step.id, { name: e.target.value })}
                    placeholder="Step name"
                    className="w-full bg-transparent border-0 outline-none text-base font-medium placeholder:text-muted-foreground"
                  />
                )}
              </div>
              {!isSequence && step.description !== undefined && (
                <input
                  type="text"
                  value={step.description}
                  onChange={(e) => updateStep(step.id, { description: e.target.value })}
                  placeholder="Add a description"
                  className="-mt-2 w-full bg-transparent border-0 outline-none text-sm text-muted-foreground placeholder:text-muted-foreground mb-3"
                />
              )}
              {!isSequence && (
                <Popover
                  open={toolSearchOpen[step.id] || false}
                  onOpenChange={(open) => setToolSearchOpen(prev => ({ ...prev, [step.id]: open }))}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={toolSearchOpen[step.id] || false}
                      className="h-9 w-full justify-between text-sm"
                    >
                      {step.config.tool_name ? (
                        <span className="flex items-center gap-2 text-sm">
                          {(() => {
                            const agentpressTool = agentTools?.agentpress_tools.find(t => t.name === step.config.tool_name);
                            if (agentpressTool) {
                              return (
                                <>
                                  <span>{agentpressTool.icon || '🔧'}</span>
                                  <span>{normalizeToolName(agentpressTool.name, 'agentpress')}</span>
                                </>
                              );
                            }
                            const mcpTool = agentTools?.mcp_tools.find(t => `${t.server}:${t.name}` === step.config.tool_name);
                            if (mcpTool) {
                              return (
                                <>
                                  <span>{mcpTool.icon || '🔧'}</span>
                                  <span>{normalizeToolName(mcpTool.name, 'mcp')}</span>
                                </>
                              );
                            }
                            return step.config.tool_name;
                          })()}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Select tool (optional)</span>
                      )}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[320px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search tools..." className="h-9" />
                      <CommandEmpty>No tools found.</CommandEmpty>
                      <CommandList>
                        {isLoadingTools ? (
                          <CommandItem disabled>Loading tools...</CommandItem>
                        ) : agentTools ? (
                          <>
                            {agentTools.agentpress_tools.filter(tool => tool.enabled).length > 0 && (
                              <CommandGroup heading="Default Tools">
                                {agentTools.agentpress_tools.filter(tool => tool.enabled).map((tool) => (
                                  <CommandItem
                                    key={tool.name}
                                    value={`${normalizeToolName(tool.name, 'agentpress')} ${tool.name}`}
                                    onSelect={() => {
                                      updateStep(step.id, { config: { ...step.config, tool_name: tool.name } });
                                      setToolSearchOpen(prev => ({ ...prev, [step.id]: false }));
                                    }}
                                  >
                                    <div className="flex items-center gap-2">
                                      <span>{tool.icon || '🔧'}</span>
                                      <span>{normalizeToolName(tool.name, 'agentpress')}</span>
                                    </div>
                                    <Check
                                      className={cn(
                                        "ml-auto h-4 w-4",
                                        step.config.tool_name === tool.name ? "opacity-100" : "opacity-0"
                                      )}
                                    />
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            )}
                            {agentTools.mcp_tools.length > 0 && (
                              <CommandGroup heading="External Tools">
                                {agentTools.mcp_tools.map((tool) => (
                                  <CommandItem
                                    key={`${tool.server || 'default'}-${tool.name}`}
                                    value={`${normalizeToolName(tool.name, 'mcp')} ${tool.name} ${tool.server || ''}`}
                                    onSelect={() => {
                                      updateStep(step.id, { config: { ...step.config, tool_name: tool.server ? `${tool.server}:${tool.name}` : tool.name } });
                                      setToolSearchOpen(prev => ({ ...prev, [step.id]: false }));
                                    }}
                                  >
                                    <div className="flex items-center gap-2">
                                      <span>{tool.icon || '🔧'}</span>
                                      <span>{normalizeToolName(tool.name, 'mcp')}</span>
                                    </div>
                                    <Check
                                      className={cn(
                                        "ml-auto h-4 w-4",
                                        step.config.tool_name === (tool.server ? `${tool.server}:${tool.name}` : tool.name) ? "opacity-100" : "opacity-0"
                                      )}
                                    />
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            )}
                          </>
                        ) : (
                          <CommandItem disabled>Failed to load tools</CommandItem>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
              {step.children && step.children.length > 0 && (
                <div className="mt-4 space-y-4">
                  {step.children.map((child, index) => renderStep(child, index + 1, true, step.id))}
                </div>
              )}
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeStep(step.id)}
                  className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete step
                </Button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    );
  };

  const renderSteps = () => {
    const result: React.ReactNode[] = [];
    let stepCounter = 0;
    let i = 0;

    while (i < steps.length) {
      const step = steps[i];
      if (step.type === 'condition') {
        const conditionGroup: ConditionalStep[] = [];
        while (i < steps.length && steps[i].type === 'condition') {
          conditionGroup.push(steps[i]);
          i++;
        }
        stepCounter++;
        result.push(
          <div key={conditionGroup[0].id} className="bg-card rounded-lg border shadow-sm p-4 transition-shadow">
            <div className="flex items-start gap-4">
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-muted-foreground">
                  {stepCounter}
                </div>
              </div>
              <div className="flex-1">
                <div className="text-base font-medium mb-4">Add rule</div>
                {renderConditionTabs(conditionGroup, conditionGroup[0].id)}
              </div>
            </div>
          </div>
        );
      } else {
        stepCounter++;
        result.push(renderStep(step, stepCounter, false));
        i++;
      }
    }

    return result;
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {steps.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-16 h-16 bg-muted rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Plus className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Start building your workflow</h3>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            Add steps and conditions to create a smart workflow that adapts to different scenarios.
          </p>
          <Button
            onClick={() => addStep()}
          >
            <Plus className="h-4 w-4" />
            Add step
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {renderSteps()}
          <div className="flex justify-center pt-4">
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => addStep()}
                className="border-dashed"
              >
                <Plus className="h-4 w-4" />
                Add step
              </Button>

              <Button
                variant="outline"
                onClick={() => addCondition(steps[steps.length - 1]?.id || '')}
                className="border-dashed"
              >
                <Plus className="h-4 w-4" />
                Add rule
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
