import { useCallback, useMemo } from 'react';
import { ConditionalStep } from '@/components/agents/workflows/conditional-workflow-builder';
import { BASE_STEP_DEFINITIONS, CATEGORY_DEFINITIONS, generateAvailableStepTypes } from '../workflow-definitions';

interface StepType {
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    config?: Record<string, any>;
}

interface UseWorkflowStepsProps {
    steps: ConditionalStep[];
    onStepsChange: (steps: ConditionalStep[]) => void;
    agentTools?: {
        agentpress_tools: Array<{ name: string; description: string; icon?: string; enabled: boolean }>;
        mcp_tools: Array<{ name: string; description: string; icon?: string; server?: string }>;
    };
    setIsPanelOpen: (open: boolean) => void;
    setPanelMode: (mode: 'add' | 'edit') => void;
    setSelectedStep: (step: ConditionalStep | null) => void;
    setInsertIndex: (index: number) => void;
    setSearchQuery: (query: string) => void;
    selectedStep: ConditionalStep | null;
    insertIndex: number;
    parentStepId: string | null;
    setParentStepId: (id: string | null) => void;
}

const STEP_CATEGORIES = CATEGORY_DEFINITIONS;


export function useWorkflowSteps({
    steps,
    onStepsChange,
    agentTools,
    setIsPanelOpen,
    setPanelMode,
    setSelectedStep,
    setInsertIndex,
    setSearchQuery,
    selectedStep,
    insertIndex,
    parentStepId,
    setParentStepId
}: UseWorkflowStepsProps) {
    const generateId = () => Math.random().toString(36).substr(2, 9);

    // Generate available step types including tools
    const getAvailableStepTypes = useCallback((): StepType[] => {
        return generateAvailableStepTypes(agentTools).map(step => ({
            id: step.id,
            name: step.name,
            description: step.description,
            icon: step.icon.name,
            category: step.category,
            config: step.config
        }));
    }, [agentTools]);

    const handleAddStep = useCallback((index: number, parentId?: string) => {
        setInsertIndex(index);
        setPanelMode('add');
        setSelectedStep(null);
        setParentStepId(parentId || null);
        setIsPanelOpen(true);
    }, [setInsertIndex, setPanelMode, setSelectedStep, setParentStepId, setIsPanelOpen]);

    const handleEditStep = useCallback((step: ConditionalStep) => {
        setSelectedStep(step);
        setPanelMode('edit');
        setParentStepId(null);
        setIsPanelOpen(true);
    }, [setSelectedStep, setPanelMode, setParentStepId, setIsPanelOpen]);

    const handleCreateStep = useCallback((stepType: StepType) => {
        const newStep: ConditionalStep = {
            id: generateId(),
            name: stepType.name,
            description: stepType.description,
            type: stepType.category === 'conditions' ? 'condition' : 'instruction',
            config: stepType.config || {},
            order: 0,
            enabled: true,
            children: []
        };

        if (stepType.id === 'condition') {
            newStep.conditions = {
                type: 'if',
                expression: ''
            };
        }

        // Check if we're adding a child step to a condition
        if (parentStepId) {
            // Find the parent step and add the new step as its child
            const findAndUpdateStep = (stepsArray: ConditionalStep[]): ConditionalStep[] => {
                return stepsArray.map(step => {
                    if (step.id === parentStepId) {
                        return {
                            ...step,
                            children: [...(step.children || []), { ...newStep, order: step.children?.length || 0 }]
                        };
                    }
                    // Also check nested children for conditional steps
                    if (step.children && step.children.length > 0) {
                        return {
                            ...step,
                            children: findAndUpdateStep(step.children)
                        };
                    }
                    return step;
                });
            };

            const newSteps = findAndUpdateStep(steps);
            onStepsChange(newSteps);
        } else {
            // Regular step addition to main workflow
            const newSteps = [...steps];
            if (insertIndex >= 0 && insertIndex < steps.length) {
                newSteps.splice(insertIndex, 0, newStep);
            } else {
                newSteps.push(newStep);
            }

            // Update order values
            newSteps.forEach((step, idx) => {
                step.order = idx;
            });

            onStepsChange(newSteps);
        }
        
        // Switch to edit mode for the newly created step
        setSelectedStep(newStep);
        setPanelMode('edit');
        setParentStepId(null);
        setSearchQuery('');
    }, [steps, onStepsChange, parentStepId, insertIndex, setSelectedStep, setPanelMode, setParentStepId, setSearchQuery]);

    const handleUpdateStep = useCallback((updates: Partial<ConditionalStep>) => {
        // Recursive function to update steps at any level
        const updateStepRecursive = (stepsArray: ConditionalStep[]): ConditionalStep[] => {
            return stepsArray.map(step => {
                if (step.id === updates.id) {
                    return { ...step, ...updates };
                }
                // Check nested children for conditional steps
                if (step.children && step.children.length > 0) {
                    return {
                        ...step,
                        children: updateStepRecursive(step.children)
                    };
                }
                return step;
            });
        };

        const newSteps = updateStepRecursive(steps);
        onStepsChange(newSteps);
        
        // Update the selected step if it's the one being updated
        if (updates.id === selectedStep?.id) {
            setSelectedStep({ ...selectedStep, ...updates });
        }
    }, [steps, onStepsChange, selectedStep, setSelectedStep]);

    const handleDeleteStep = useCallback((stepId: string) => {
        // Find the step to delete
        const stepToDelete = steps.find(step => step.id === stepId);
        
        // If this is a conditional step (if/else-if/else), we need to delete the entire group
        if (stepToDelete?.type === 'condition') {
            // Find all related conditional steps (if, else-if, else) that should be deleted together
            const stepIndex = steps.findIndex(step => step.id === stepId);
            if (stepIndex === -1) return;
            
            // Find the start and end of the conditional group
            let startIndex = stepIndex;
            let endIndex = stepIndex;
            
            // Look backwards to find the start of the group (the "if" step)
            while (startIndex > 0 && steps[startIndex - 1].type === 'condition') {
                startIndex--;
            }
            
            // Look forwards to find the end of the group (all consecutive conditional steps)
            while (endIndex < steps.length - 1 && steps[endIndex + 1].type === 'condition') {
                endIndex++;
            }
            
            // Delete the entire group
            const newSteps = steps.filter((_, index) => index < startIndex || index > endIndex);
            
            // Update order values
            newSteps.forEach((step, idx) => {
                step.order = idx;
            });
            
            onStepsChange(newSteps);
            setIsPanelOpen(false);
            return;
        }
        
        // For non-conditional steps, use the original recursive deletion
        const deleteStepRecursive = (stepsArray: ConditionalStep[]): ConditionalStep[] => {
            const filtered = stepsArray.filter(step => step.id !== stepId);
            return filtered.map(step => {
                if (step.children && step.children.length > 0) {
                    return {
                        ...step,
                        children: deleteStepRecursive(step.children)
                    };
                }
                return step;
            });
        };

        const newSteps = deleteStepRecursive(steps);
        
        // Update order values for top-level steps
        newSteps.forEach((step, idx) => {
            step.order = idx;
        });
        
        onStepsChange(newSteps);
        setIsPanelOpen(false);
    }, [steps, onStepsChange, setIsPanelOpen]);

    const handleAddElseIf = useCallback((afterStepId: string) => {
        const newElseIfStep: ConditionalStep = {
            id: generateId(),
            name: 'Else If Condition',
            description: 'Additional condition',
            type: 'condition',
            config: {},
            conditions: {
                type: 'elseif',
                expression: ''
            },
            order: 0,
            enabled: true,
            children: []
        };

        const afterStep = steps.find(step => step.id === afterStepId);
        if (!afterStep) return;

        const newSteps = [...steps];
        const afterIndex = newSteps.findIndex(step => step.id === afterStepId);
        newSteps.splice(afterIndex + 1, 0, newElseIfStep);

        // Update order values
        newSteps.forEach((step, idx) => {
            step.order = idx;
        });

        onStepsChange(newSteps);
    }, [steps, onStepsChange]);

    const handleAddElse = useCallback((afterStepId: string) => {
        const newElseStep: ConditionalStep = {
            id: generateId(),
            name: 'Else Condition',
            description: 'Fallback condition',
            type: 'condition',
            config: {},
            conditions: {
                type: 'else'
            },
            order: 0,
            enabled: true,
            children: []
        };

        const afterStep = steps.find(step => step.id === afterStepId);
        if (!afterStep) return;

        const newSteps = [...steps];
        const afterIndex = newSteps.findIndex(step => step.id === afterStepId);
        newSteps.splice(afterIndex + 1, 0, newElseStep);

        // Update order values
        newSteps.forEach((step, idx) => {
            step.order = idx;
        });

        onStepsChange(newSteps);
    }, [steps, onStepsChange]);

    return {
        handleAddStep,
        handleEditStep,
        handleCreateStep,
        handleUpdateStep,
        handleDeleteStep,
        handleAddElseIf,
        handleAddElse,
        getAvailableStepTypes,
        STEP_CATEGORIES
    };
} 