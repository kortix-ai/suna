'use client';

import React, { useState, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConditionalStep } from '@/components/agents/workflows/conditional-workflow-builder';
import { StepCard } from './step-card';
import { ConditionalGroup } from './conditional-group';
import { AnimatedFlowLine } from '../animated-flow-line';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
    DragOverlay,
    DragStartEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';

interface WorkflowStepsProps {
    steps: ConditionalStep[];
    onAddStep: (index: number, parentStepId?: string) => void;
    onEditStep: (step: ConditionalStep) => void;
    onUpdateStep: (updates: Partial<ConditionalStep>) => void;
    onDeleteStep: (stepId: string) => void;
    onAddElseIf: (afterStepId: string) => void;
    onAddElse: (afterStepId: string) => void;
    onStepsChange: (steps: ConditionalStep[]) => void;
    agentTools?: any;
    isLoadingTools?: boolean;
}

export function WorkflowSteps({
    steps,
    onAddStep,
    onEditStep,
    onUpdateStep,
    onDeleteStep,
    onAddElseIf,
    onAddElse,
    onStepsChange,
    agentTools,
    isLoadingTools
}: WorkflowStepsProps) {
    const [activeId, setActiveId] = useState<string | null>(null);

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // Group conditional steps and generate sortable IDs
    const { groupedSteps, sortableIds } = useMemo(() => {
        const result: Array<ConditionalStep | ConditionalStep[]> = [];
        const ids: string[] = [];
        let currentConditionGroup: ConditionalStep[] = [];

        steps.forEach(step => {
            if (step.type === 'condition') {
                currentConditionGroup.push(step);
            } else {
                if (currentConditionGroup.length > 0) {
                    const group = [...currentConditionGroup];
                    result.push(group);
                    ids.push(`condition-group-${group[0]?.id}`);
                    currentConditionGroup = [];
                }
                result.push(step);
                ids.push(step.id);
            }
        });

        if (currentConditionGroup.length > 0) {
            const group = [...currentConditionGroup];
            result.push(group);
            ids.push(`condition-group-${group[0]?.id}`);
        }

        return { groupedSteps: result, sortableIds: ids };
    }, [steps]);

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(event.active.id as string);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveId(null);

        if (active.id !== over?.id) {
            const activeId = active.id as string;
            const overId = over?.id as string;

            // Find indices in the sortableIds array
            const oldIndex = sortableIds.findIndex(id => id === activeId);
            const newIndex = sortableIds.findIndex(id => id === overId);

            if (oldIndex !== -1 && newIndex !== -1) {
                // Reorder the groupedSteps array
                const newGroupedSteps = arrayMove(groupedSteps, oldIndex, newIndex);

                // Flatten back to steps array
                const newSteps: ConditionalStep[] = [];
                newGroupedSteps.forEach(item => {
                    if (Array.isArray(item)) {
                        newSteps.push(...item);
                    } else {
                        newSteps.push(item);
                    }
                });

                // Update order values
                newSteps.forEach((step, idx) => {
                    step.order = idx;
                });

                // Call the parent's onStepsChange
                onStepsChange(newSteps);
            }
        }
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
        >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                    {groupedSteps.map((item, index) => (
                        <React.Fragment key={Array.isArray(item) ? `condition-${item[0]?.id}` : item.id}>
                            {Array.isArray(item) ? (
                                // Conditional flow
                                <ConditionalGroup
                                    conditionSteps={item}
                                    groupKey={`condition-group-${index}`}
                                    onUpdateStep={onUpdateStep}
                                    onAddElse={onAddElse}
                                    onAddElseIf={onAddElseIf}
                                    onRemove={onDeleteStep}
                                    onEdit={onEditStep}
                                    onAddStep={onAddStep}
                                    agentTools={agentTools}
                                    isLoadingTools={isLoadingTools}
                                />
                            ) : (
                                // Regular step
                                <StepCard
                                    step={item}
                                    stepNumber={index + 1}
                                    onEdit={onEditStep}
                                    onUpdateStep={onUpdateStep}
                                    agentTools={agentTools}
                                    isLoadingTools={isLoadingTools}
                                />
                            )}

                            {/* Flow line between steps with hover add button */}
                            {index < groupedSteps.length - 1 && (
                                <div className="relative flex items-center justify-center py-1 group/flow">
                                    <AnimatedFlowLine />

                                    {/* Ghost add button that appears on hover */}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => onAddStep(index + 1)}
                                        className="absolute right-4 h-6 px-2 text-xs opacity-0 group-hover/flow:opacity-100 transition-opacity bg-background/80 backdrop-blur-sm hover:bg-background cursor-pointer"
                                    >
                                        <Plus className="h-3 w-3 mr-1" />
                                        Add
                                    </Button>
                                </div>
                            )}
                        </React.Fragment>
                    ))}
                </div>
            </SortableContext>

            {/* Add step button at the bottom */}
            <div className="flex justify-center pt-4">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onAddStep(steps.length)}
                    className="h-8 px-4 border border-dashed border-zinc-300 dark:border-zinc-600 hover:border-zinc-400 dark:hover:border-zinc-500 bg-background hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                >
                    <Plus className="h-4 w-4" />
                    Add step
                </Button>
            </div>

            <DragOverlay>
                {activeId ? (
                    <div className="opacity-75">
                        {(() => {
                            const activeStep = steps.find(s => s.id === activeId);
                            if (!activeStep) return null;
                            return (
                                <StepCard
                                    step={activeStep}
                                    stepNumber={1}
                                    onEdit={() => { }}
                                    onUpdateStep={() => { }}
                                />
                            );
                        })()}
                    </div>
                ) : null}
            </DragOverlay>
        </DndContext>
    );
} 