'use client';

import React, { useState, useCallback, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConditionalStep } from '@/components/agents/workflows/conditional-workflow-builder';
import { WorkflowSteps } from './steps/workflow-steps';
import { WorkflowLayout } from './workflow-layout';
import { useWorkflowSteps } from './hooks/use-workflow-steps';

interface WorkflowBuilderProps {
    steps: ConditionalStep[];
    onStepsChange: (steps: ConditionalStep[]) => void;
    agentTools?: {
        agentpress_tools: Array<{ name: string; description: string; icon?: string; enabled: boolean }>;
        mcp_tools: Array<{ name: string; description: string; icon?: string; server?: string }>;
    };
    isLoadingTools?: boolean;
    agentId?: string;
    workflowId?: string;
    versionData?: {
        version_id: string;
        configured_mcps: any[];
        custom_mcps: any[];
        system_prompt: string;
        agentpress_tools: any;
    };
    onToolsUpdate?: () => void;
    workflowName?: string;
    workflowDescription?: string;
    onSave?: () => void;
    isSaving?: boolean;
    onExecute?: () => void;
    isExecuting?: boolean;
    onNameChange?: (name: string) => void;
    onDescriptionChange?: (description: string) => void;
}

// Root node structure that parser expects
const createRootNode = (children: ConditionalStep[] = []): ConditionalStep => ({
    id: 'start-node',
    name: 'Start',
    description: 'Click to add steps or use the Add Node button',
    type: 'instruction',
    config: {},
    order: 0,
    children: children
});

export function WorkflowBuilder({
    steps,
    onStepsChange,
    agentTools,
    isLoadingTools,
    agentId,
    versionData,
    onToolsUpdate,
    workflowName = 'Untitled Workflow',
    workflowDescription = '',
    onSave,
    isSaving = false,
    onExecute,
    isExecuting,
    onNameChange,
    onDescriptionChange
}: WorkflowBuilderProps) {
    // Ensure we always have the proper root structure
    const workflowSteps = useMemo(() => {
        // If we don't have steps or it's not the right structure, create proper root
        if (!steps || steps.length === 0) {
            return [createRootNode()];
        }

        // Check if we already have proper root structure
        const firstStep = steps[0];
        if (firstStep &&
            firstStep.name === 'Start' &&
            firstStep.description === 'Click to add steps or use the Add Node button' &&
            firstStep.type === 'instruction' &&
            Array.isArray(firstStep.children)) {
            return steps;
        }

        // If we have flat structure, wrap it in root node
        return [createRootNode(steps)];
    }, [steps]);

    // Get the actual workflow children (the steps we edit)
    const editableSteps = useMemo(() => {
        return workflowSteps[0]?.children || [];
    }, [workflowSteps]);

    // Handle changes to the editable steps
    const handleStepsChange = useCallback((newSteps: ConditionalStep[]) => {
        const updatedWorkflow = [createRootNode(newSteps)];
        onStepsChange(updatedWorkflow);
    }, [onStepsChange]);

    const [isPanelOpen, setIsPanelOpen] = useState(false);
    const [panelMode, setPanelMode] = useState<'add' | 'edit'>('add');
    const [selectedStep, setSelectedStep] = useState<ConditionalStep | null>(null);
    const [insertIndex, setInsertIndex] = useState<number>(-1);
    const [searchQuery, setSearchQuery] = useState('');
    const [parentStepId, setParentStepId] = useState<string | null>(null);

    const {
        handleAddStep,
        handleEditStep,
        handleCreateStep,
        handleUpdateStep,
        handleDeleteStep,
        handleAddElseIf,
        handleAddElse,
        getAvailableStepTypes,
        STEP_CATEGORIES
    } = useWorkflowSteps({
        steps: editableSteps, // Work with the children array
        onStepsChange: handleStepsChange, // Update the root structure
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
    });

    const handleToggleSidePanel = () => {
        setIsPanelOpen(!isPanelOpen);
    };

    return (
        <WorkflowLayout
            workflowName={workflowName}
            workflowDescription={workflowDescription}
            isSidePanelOpen={isPanelOpen}
            onToggleSidePanel={handleToggleSidePanel}
            onSave={onSave || (() => { })}
            isSaving={isSaving}
            onExecute={onExecute}
            isExecuting={isExecuting}
            onNameChange={onNameChange}
            onDescriptionChange={onDescriptionChange}
            selectedStep={selectedStep}
            panelMode={panelMode}
            availableStepTypes={getAvailableStepTypes()}
            categories={STEP_CATEGORIES}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onCreateStep={handleCreateStep}
            onUpdateStep={handleUpdateStep}
            onDeleteStep={handleDeleteStep}
            isLoadingTools={isLoadingTools}
            agentId={agentId}
            versionData={versionData}
            onToolsUpdate={onToolsUpdate}
        >
            <div className="min-h-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                <div className="mx-auto max-w-3xl md:px-8 min-w-0 py-8">
                    {editableSteps.length === 0 ? (
                        <div className="flex-1 min-h-[60vh] flex items-center justify-center">
                            <div className="text-center">
                                <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
                                    <Plus className="h-8 w-8 text-zinc-400" />
                                </div>
                                <h3 className="text-lg font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
                                    Start building your workflow
                                </h3>
                                <p className="text-zinc-500 dark:text-zinc-400 mb-6 max-w-md mx-auto">
                                    Add steps to create a workflow that guides your agent through tasks.
                                </p>
                                <Button onClick={() => handleAddStep(-1)}>
                                    <Plus className="h-4 w-4" />
                                    Add first step
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-8 min-w-0">
                            <WorkflowSteps
                                steps={editableSteps}
                                onAddStep={handleAddStep}
                                onEditStep={handleEditStep}
                                onUpdateStep={handleUpdateStep}
                                onDeleteStep={handleDeleteStep}
                                onAddElseIf={handleAddElseIf}
                                onAddElse={handleAddElse}
                                onStepsChange={handleStepsChange}
                                agentTools={agentTools}
                                isLoadingTools={isLoadingTools}
                            />
                        </div>
                    )}
                </div>
            </div>
        </WorkflowLayout>
    );
} 