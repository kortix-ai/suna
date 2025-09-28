'use client';

import React from 'react';
import { WorkflowHeader } from './workflow-header';
import { WorkflowSidePanel } from './workflow-side-panel';
import { ConditionalStep } from '@/components/agents/workflows/conditional-workflow-builder';

interface WorkflowLayoutProps {
    children: React.ReactNode;
    workflowName: string;
    workflowDescription?: string;
    isSidePanelOpen: boolean;
    onToggleSidePanel: () => void;
    onSave: () => void;
    isSaving?: boolean;
    onExecute?: () => void;
    isExecuting?: boolean;
    onNameChange?: (name: string) => void;
    onDescriptionChange?: (description: string) => void;
    selectedStep?: ConditionalStep | null;
    panelMode?: 'add' | 'edit';
    availableStepTypes?: any[];
    onCreateStep?: (stepType: any) => void;
    onUpdateStep?: (updates: Partial<ConditionalStep>) => void;
    onDeleteStep?: (stepId: string) => void;
    isLoadingTools?: boolean;
    searchQuery?: string;
    onSearchChange?: (query: string) => void;
    categories?: any[];
    agentId?: string;
    versionData?: any;
    onToolsUpdate?: () => void;
}

export function WorkflowLayout({
    children,
    workflowName,
    workflowDescription,
    isSidePanelOpen,
    onToggleSidePanel,
    onSave,
    isSaving = false,
    onExecute,
    isExecuting = false,
    onNameChange,
    onDescriptionChange,
    selectedStep,
    panelMode = 'add',
    availableStepTypes = [],
    onCreateStep,
    onUpdateStep,
    onDeleteStep,
    isLoadingTools = false,
    searchQuery = '',
    onSearchChange,
    categories = [],
    agentId,
    versionData,
    onToolsUpdate
}: WorkflowLayoutProps) {
    return (
        <div className="flex h-screen">
            <div
                className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${isSidePanelOpen
                    ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]'
                    : ''
                    }`}
            >
                <WorkflowHeader
                    workflowName={workflowName}
                    workflowDescription={workflowDescription}
                    onToggleSidePanel={onToggleSidePanel}
                    onSave={onSave}
                    isSaving={isSaving}
                    onExecute={onExecute}
                    isExecuting={isExecuting}
                    onNameChange={onNameChange}
                    onDescriptionChange={onDescriptionChange}
                />

                <div className="flex-1 overflow-y-auto overflow-x-hidden">
                    {children}
                </div>
            </div>

            {/* Side Panel */}
            <WorkflowSidePanel
                isOpen={isSidePanelOpen}
                onClose={onToggleSidePanel}
                mode={panelMode}
                selectedStep={selectedStep}
                availableStepTypes={availableStepTypes}
                categories={categories}
                searchQuery={searchQuery}
                onSearchChange={onSearchChange}
                onCreateStep={onCreateStep}
                onUpdateStep={onUpdateStep}
                onDeleteStep={onDeleteStep}
                isLoadingTools={isLoadingTools}
                agentId={agentId}
                versionData={versionData}
                onToolsUpdate={onToolsUpdate}
            />
        </div>
    );
} 