'use client';

import React, { useState } from 'react';
import { Plus, AlertTriangle, GripVertical, Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { ConditionalStep } from '@/components/agents/workflows/conditional-workflow-builder';
import { StepCard } from './step-card';
import { cn } from '@/lib/utils';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
    DragOverlay,
    DragStartEvent
} from '@dnd-kit/core';

interface ConditionalGroupProps {
    conditionSteps: ConditionalStep[];
    groupKey: string;
    onUpdateStep: (updates: Partial<ConditionalStep>) => void;
    onAddElse: (afterStepId: string) => void;
    onAddElseIf: (afterStepId: string) => void;
    onRemove: (stepId: string) => void;
    onEdit: (step: ConditionalStep) => void;
    onAddStep: (index: number, parentStepId?: string) => void;
    agentTools?: any;
    isLoadingTools?: boolean;
    sortableId?: string; // When provided, this group is sortable within a parent context
}

const MAX_ELSE_IF_CONDITIONS = 5; // Limit the number of else-if conditions

// Sortable wrapper for ConditionalGroup when used as a nested item
function SortableConditionalGroup({
    sortableId,
    ...props
}: ConditionalGroupProps & { sortableId: string }) {
    return <ConditionalGroup {...props} sortableId={sortableId} />;
}

export function ConditionalGroup({
    conditionSteps,
    groupKey,
    onUpdateStep,
    onAddElse,
    onAddElseIf,
    onRemove,
    onEdit,
    onAddStep,
    agentTools,
    isLoadingTools,
    sortableId
}: ConditionalGroupProps) {
    const [activeConditionTab, setActiveConditionTab] = useState<string>(conditionSteps[0]?.id || '');
    const [activeDragId, setActiveDragId] = useState<string | null>(null);
    const [pendingElseStepAdd, setPendingElseStepAdd] = useState<boolean>(false);
    const [deleteConfirmStep, setDeleteConfirmStep] = useState<ConditionalStep | null>(null);

    // Set up sensors for drag and drop within this conditional group
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8, // Require 8px movement to start drag
            },
        }),
        useSensor(KeyboardSensor)
    );

    // Ensure we always have an "else" step at the end
    const hasElse = conditionSteps.some(step => step.conditions?.type === 'else');
    const elseIfCount = conditionSteps.filter(step => step.conditions?.type === 'elseif').length;
    const canAddElseIf = elseIfCount < MAX_ELSE_IF_CONDITIONS; // Can add else-if as long as under limit

    // Create a virtual else step if none exists to show the tab
    const displaySteps = React.useMemo(() => {
        if (!hasElse) {
            const virtualElse: ConditionalStep = {
                id: 'virtual-else',
                name: 'Else',
                description: '',
                type: 'condition',
                config: {},
                conditions: { type: 'else' },
                children: [],
                order: conditionSteps.length
            };
            return [...conditionSteps, virtualElse];
        }
        return conditionSteps;
    }, [conditionSteps, hasElse]);

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({
        id: sortableId || `condition-group-${conditionSteps[0]?.id}`
    });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
    };

    const getConditionLetter = (index: number) => {
        return String.fromCharCode(65 + index);
    };

    // Ensure we have a valid active tab when steps change
    React.useEffect(() => {
        if (!displaySteps.find(s => s.id === activeConditionTab)) {
            // If we were on virtual-else and it's now gone, switch to the real else step
            if (activeConditionTab === 'virtual-else' && hasElse) {
                const elseStep = conditionSteps.find(step => step.conditions?.type === 'else');
                if (elseStep) {
                    setActiveConditionTab(elseStep.id);
                    return;
                }
            }
            // Otherwise default to first step
            setActiveConditionTab(displaySteps[0]?.id || '');
        }
    }, [displaySteps, activeConditionTab, hasElse, conditionSteps]);

    // Handle pending step addition after else step creation
    React.useEffect(() => {
        if (pendingElseStepAdd && hasElse) {
            const elseStep = conditionSteps.find(step => step.conditions?.type === 'else');
            if (elseStep) {
                onAddStep(-1, elseStep.id);
                setPendingElseStepAdd(false);
            }
        }
    }, [pendingElseStepAdd, hasElse, conditionSteps, onAddStep]);

    const activeStep = displaySteps.find(s => s.id === activeConditionTab) || displaySteps[0];

    // Handle drag start to track active item for preview
    const handleDragStart = React.useCallback((event: DragStartEvent) => {
        setActiveDragId(event.active.id.toString());
    }, []);

    // Handle reordering children within this conditional group
    const handleDragEnd = React.useCallback((event: DragEndEvent) => {
        const { active, over } = event;

        if (over && active.id !== over.id && activeStep?.children) {
            // Remove the prefix to get the actual child ID
            const activeId = active.id.toString().replace(`${groupKey}-`, '');
            const overId = over.id.toString().replace(`${groupKey}-`, '');

            const oldIndex = activeStep.children.findIndex(child => child.id === activeId);
            const newIndex = activeStep.children.findIndex(child => child.id === overId);

            if (oldIndex !== -1 && newIndex !== -1) {
                const newChildren = arrayMove(activeStep.children, oldIndex, newIndex);

                // Find the real step to update (not virtual else)
                const realStep = activeStep.id === 'virtual-else' ? null :
                    conditionSteps.find(step => step.id === activeStep.id);

                if (realStep) {
                    // Update the specific conditional step with new children order
                    onUpdateStep({
                        id: realStep.id,
                        children: newChildren
                    });
                }
            }
        }

        // Clear active drag state
        setActiveDragId(null);
    }, [activeStep, onUpdateStep, groupKey, conditionSteps]);

    // Handle clicking add step button
    const handleAddStepClick = React.useCallback(() => {
        if (activeStep?.id === 'virtual-else') {
            // If clicking on virtual else, create a real else step first, then add a step to it
            setPendingElseStepAdd(true);
            onAddElse(conditionSteps[conditionSteps.length - 1].id);
            // The useEffect above will handle switching to the real else tab and adding the step
        } else {
            // Call onAddStep with index and parent step ID
            onAddStep(-1, activeStep?.id);
        }
    }, [activeStep, onAddElse, conditionSteps, onAddStep]);

    // Handle delete confirmation
    const handleDeleteConfirm = React.useCallback(() => {
        if (deleteConfirmStep) {
            // Switch to another tab before deleting if we're on the tab being deleted
            if (activeConditionTab === deleteConfirmStep.id) {
                const remainingSteps = conditionSteps.filter(s => s.id !== deleteConfirmStep.id);
                if (remainingSteps.length > 0) {
                    setActiveConditionTab(remainingSteps[0].id);
                }
            }
            onRemove(deleteConfirmStep.id);
            setDeleteConfirmStep(null);
        }
    }, [deleteConfirmStep, activeConditionTab, conditionSteps, onRemove]);

    const handleDeleteCancel = React.useCallback(() => {
        setDeleteConfirmStep(null);
    }, []);

    return (
        <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-50")}>
            <div className="space-y-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-2xl p-4 border border-zinc-200 dark:border-zinc-800 relative group">
                <div className="absolute top-6.5 left-4 z-10">
                    <div
                        {...attributes}
                        {...listeners}
                        className="cursor-grab active:cursor-grabbing"
                    >
                        <GripVertical className="h-4 w-4 text-zinc-400" />
                    </div>
                </div>

                {/* Gear icon for editing - appears on hover */}
                <div className="absolute top-4 right-4 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                            // For conditional groups, we want to edit the first step (the "if" step)
                            // which represents the entire conditional group
                            const firstStep = conditionSteps[0];
                            if (firstStep) {
                                onEdit(firstStep);
                            }
                        }}
                        className="h-8 w-8 p-0"
                    >
                        <Settings className="h-4 w-4" />
                    </Button>
                </div>

                {/* Condition Tabs */}
                <div className="flex items-center gap-2 flex-wrap pl-5 pr-12">
                    {displaySteps.map((step, index) => {
                        const letter = getConditionLetter(index);
                        const isActive = step.id === activeConditionTab;
                        const conditionType = step.conditions?.type === 'if' ? 'If' :
                            step.conditions?.type === 'elseif' ? 'Else If' :
                                step.conditions?.type === 'else' ? 'Else' : 'If';

                        return (
                            <div key={step.id} className="relative group/tab">
                                <Button
                                    onClick={() => setActiveConditionTab(step.id)}
                                    className={cn(
                                        "h-9 px-3 border border-dashed text-xs",
                                        isActive
                                            ? "bg-blue-500 hover:bg-blue-600 "
                                            : "bg-white dark:bg-zinc-800 border-dashed border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-700"
                                    )}
                                >
                                    <span className="font-mono text-xs font-bold">{letter}</span>
                                    <span>•</span>
                                    <span>{conditionType}</span>
                                    {step.hasIssues && (
                                        <AlertTriangle className="h-3 w-3 text-red-500" />
                                    )}
                                </Button>

                                {/* Delete button - only for else-if tabs */}
                                {step.conditions?.type === 'elseif' && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setDeleteConfirmStep(step);
                                        }}
                                        className="absolute -top-1 -right-1 h-4.5 w-4.5 !p-0  bg-primary hover:bg-primary hover:text-white hover:dark:text-black text-white dark:text-black rounded-full opacity-0 group-hover/tab:opacity-100 transition-opacity z-10 cursor-pointer"
                                    >
                                        <X className="!h-3 !w-3" />
                                    </Button>
                                )}
                            </div>
                        );
                    })}

                    {/* Plus button to add Else If - always show if we can add more */}
                    {canAddElseIf && (
                        <Button
                            onClick={() => {
                                // Insert else-if before the else step if it exists, otherwise at the end
                                if (hasElse) {
                                    const elseStepIndex = conditionSteps.findIndex(step => step.conditions?.type === 'else');
                                    const beforeElseStep = elseStepIndex > 0 ? conditionSteps[elseStepIndex - 1] : conditionSteps[0];
                                    onAddElseIf(beforeElseStep.id);
                                } else {
                                    onAddElseIf(conditionSteps[conditionSteps.length - 1].id);
                                }
                            }}
                            className="h-6 w-6 !p-0 border border-dashed rounded-md border-zinc-300 dark:border-zinc-600 hover:border-zinc-400 dark:hover:border-zinc-500 bg-white dark:bg-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
                        >
                            <Plus className="h-3 w-3 text-zinc-600 dark:text-zinc-400" />
                        </Button>
                    )}
                </div>

                {/* Active condition content */}
                {activeStep && (
                    <div className="bg-white dark:bg-zinc-800 rounded-2xl p-4 border border-zinc-200 dark:border-zinc-700">
                        {/* Steps within this condition */}
                        <div className="space-y-3">
                            {activeStep.children && activeStep.children.length > 0 ? (
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    onDragStart={handleDragStart}
                                    onDragEnd={handleDragEnd}
                                >
                                    <SortableContext items={activeStep.children.map(child => `${groupKey}-${child.id}`)} strategy={verticalListSortingStrategy}>
                                        <div className="space-y-2">
                                            {activeStep.children.map((child, index) => {
                                                // Skip if this step is already rendered as part of another conditional group
                                                if (child.type === 'condition' && child.parentConditionalId) {
                                                    return null;
                                                }

                                                // If this child is a conditional step, render as ConditionalGroup for infinite nesting
                                                if (child.type === 'condition') {
                                                    // Find existing else-if and else siblings for this conditional
                                                    const conditionalGroup = activeStep.children?.filter(sibling =>
                                                        sibling.parentConditionalId === child.id || sibling.id === child.id
                                                    ) || [child];

                                                    // Sort by order or type to ensure proper if/else-if/else sequence
                                                    const sortedGroup = conditionalGroup.sort((a, b) => {
                                                        const getTypeOrder = (type: string) => {
                                                            if (type === 'if') return 0;
                                                            if (type === 'elseif') return 1;
                                                            if (type === 'else') return 2;
                                                            return 0;
                                                        };
                                                        return getTypeOrder(a.conditions?.type || 'if') - getTypeOrder(b.conditions?.type || 'if');
                                                    });

                                                    // Convert to proper conditional steps format
                                                    const conditionalSteps = sortedGroup.map(step => ({
                                                        ...step,
                                                        conditions: step.conditions || { type: 'if' as const }
                                                    }));

                                                    // Create wrapped callbacks for nested conditional operations
                                                    const handleNestedAddElse = (afterStepId: string) => {
                                                        if (!activeStep?.id) return;

                                                        // Create new else step as sibling of the conditional
                                                        const newElseStep = {
                                                            id: `${child.id}-else-${Date.now()}`,
                                                            name: 'Else',
                                                            description: '',
                                                            type: 'condition' as const,
                                                            config: {},
                                                            conditions: { type: 'else' as const },
                                                            children: [],
                                                            order: activeStep.children?.length || 0,
                                                            parentConditionalId: child.id
                                                        };

                                                        // Add to parent's children
                                                        const updatedChildren = [...(activeStep.children || []), newElseStep];
                                                        onUpdateStep({
                                                            id: activeStep.id,
                                                            children: updatedChildren
                                                        });
                                                    };

                                                    const handleNestedAddElseIf = (afterStepId: string) => {
                                                        if (!activeStep?.id) return;

                                                        // Create new else-if step as sibling of the conditional
                                                        const newElseIfStep = {
                                                            id: `${child.id}-elseif-${Date.now()}`,
                                                            name: 'Else If',
                                                            description: '',
                                                            type: 'condition' as const,
                                                            config: {},
                                                            conditions: { type: 'elseif' as const },
                                                            children: [],
                                                            order: activeStep.children?.length || 0,
                                                            parentConditionalId: child.id
                                                        };

                                                        // Insert before any existing else step
                                                        const elseIndex = activeStep.children?.findIndex(c =>
                                                            c.parentConditionalId === child.id && c.conditions?.type === 'else'
                                                        );

                                                        let updatedChildren;
                                                        if (elseIndex !== undefined && elseIndex !== -1) {
                                                            // Insert before else
                                                            updatedChildren = [...(activeStep.children || [])];
                                                            updatedChildren.splice(elseIndex, 0, newElseIfStep);
                                                        } else {
                                                            // Add at end
                                                            updatedChildren = [...(activeStep.children || []), newElseIfStep];
                                                        }

                                                        onUpdateStep({
                                                            id: activeStep.id,
                                                            children: updatedChildren
                                                        });
                                                    };

                                                    const handleNestedAddStep = (index: number, parentStepId?: string) => {
                                                        // Call the parent's onAddStep which will open the side panel
                                                        // Pass the parentStepId correctly for nested context
                                                        onAddStep(index, parentStepId);
                                                    };

                                                    return (
                                                        <SortableConditionalGroup
                                                            key={child.id}
                                                            sortableId={`${groupKey}-${child.id}`}
                                                            conditionSteps={conditionalSteps}
                                                            groupKey={`${groupKey}-${child.id}`}
                                                            onUpdateStep={onUpdateStep}
                                                            onAddElse={handleNestedAddElse}
                                                            onAddElseIf={handleNestedAddElseIf}
                                                            onRemove={onRemove}
                                                            onEdit={onEdit}
                                                            onAddStep={handleNestedAddStep}
                                                            agentTools={agentTools}
                                                            isLoadingTools={isLoadingTools}
                                                        />
                                                    );
                                                }

                                                // Otherwise render as regular step card
                                                return (
                                                    <StepCard
                                                        key={child.id}
                                                        step={child}
                                                        stepNumber={index + 1}
                                                        isNested={true}
                                                        onEdit={onEdit}
                                                        onUpdateStep={onUpdateStep}
                                                        agentTools={agentTools}
                                                        isLoadingTools={isLoadingTools}
                                                        sortableId={`${groupKey}-${child.id}`}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </SortableContext>

                                    <DragOverlay>
                                        {activeDragId ? (
                                            <div className="opacity-75">
                                                {(() => {
                                                    // Remove prefix to get actual child ID
                                                    const childId = activeDragId.replace(`${groupKey}-`, '');
                                                    const draggedChild = activeStep.children?.find(child => child.id === childId);

                                                    if (!draggedChild) return null;

                                                    // Render appropriate preview based on child type
                                                    if (draggedChild.type === 'condition') {
                                                        // Find all related conditional steps for preview
                                                        const conditionalGroup = activeStep.children?.filter(sibling =>
                                                            sibling.parentConditionalId === draggedChild.id || sibling.id === draggedChild.id
                                                        ) || [draggedChild];

                                                        // Sort by type to ensure proper if/else-if/else sequence
                                                        const sortedGroup = conditionalGroup.sort((a, b) => {
                                                            const getTypeOrder = (type: string) => {
                                                                if (type === 'if') return 0;
                                                                if (type === 'elseif') return 1;
                                                                if (type === 'else') return 2;
                                                                return 0;
                                                            };
                                                            return getTypeOrder(a.conditions?.type || 'if') - getTypeOrder(b.conditions?.type || 'if');
                                                        });

                                                        const conditionalSteps = sortedGroup.map(step => ({
                                                            ...step,
                                                            conditions: step.conditions || { type: 'if' as const }
                                                        }));

                                                        return (
                                                            <ConditionalGroup
                                                                conditionSteps={conditionalSteps}
                                                                groupKey={`preview-${draggedChild.id}`}
                                                                onUpdateStep={() => { }}
                                                                onAddElse={() => { }}
                                                                onAddElseIf={() => { }}
                                                                onRemove={() => { }}
                                                                onEdit={() => { }}
                                                                onAddStep={() => { }}
                                                                agentTools={agentTools}
                                                                isLoadingTools={isLoadingTools}
                                                            />
                                                        );
                                                    } else {
                                                        return (
                                                            <StepCard
                                                                step={draggedChild}
                                                                stepNumber={1}
                                                                onEdit={() => { }}
                                                                onUpdateStep={() => { }}
                                                                agentTools={agentTools}
                                                                isLoadingTools={isLoadingTools}
                                                            />
                                                        );
                                                    }
                                                })()}
                                            </div>
                                        ) : null}
                                    </DragOverlay>
                                </DndContext>
                            ) : (
                                <div className="text-center py-8 text-zinc-400 dark:text-zinc-500 text-sm">
                                    No steps in this condition
                                </div>
                            )}

                            {/* Add step button - triggers special edit mode for adding child steps */}
                            <div className="flex justify-center pt-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleAddStepClick}
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

            {/* Delete Confirmation Dialog */}
            <Dialog open={!!deleteConfirmStep} onOpenChange={(open) => !open && handleDeleteCancel()}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Delete Condition</DialogTitle>
                        <DialogDescription>
                            Are you sure you want to delete this "Else If" condition? This action cannot be undone and will remove all steps within this condition.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={handleDeleteCancel}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDeleteConfirm}>
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
} 