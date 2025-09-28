'use client';

import React, { useState } from 'react';
import { X, Plus, Trash2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { motion, AnimatePresence } from 'framer-motion';
import { ConditionalStep } from '@/components/agents/workflows/conditional-workflow-builder';
import { getStepIconAndColor } from './workflow-definitions';

import { ComposioRegistry } from '@/components/agents/composio/composio-registry';
import { CustomMCPDialog } from '@/components/agents/mcp/custom-mcp-dialog';
import { useAgent, useUpdateAgent } from '@/hooks/react-query/agents/use-agents';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { composioApi } from '@/hooks/react-query/composio/utils';
import { backendApi } from '@/lib/api-client';

interface StepType {
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    config?: Record<string, any>;
}

interface WorkflowSidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    mode: 'add' | 'edit';
    selectedStep?: ConditionalStep | null;
    availableStepTypes: StepType[];
    categories: Array<{
        id: string;
        name: string;
        description: string
    }>;
    searchQuery: string;
    onSearchChange: (query: string) => void;
    onCreateStep: (stepType: StepType) => void;
    onUpdateStep: (updates: Partial<ConditionalStep>) => void;
    onDeleteStep: (stepId: string) => void;
    isLoadingTools?: boolean;
    agentId?: string;
    versionData?: any;
    onToolsUpdate?: () => void;
}

const FLOATING_LAYOUT_ID = 'workflow-panel-float';
const CONTENT_LAYOUT_ID = 'workflow-panel-content';

export function WorkflowSidePanel({
    isOpen,
    onClose,
    mode,
    selectedStep,
    availableStepTypes,
    categories,
    searchQuery,
    onSearchChange,
    onCreateStep,
    onUpdateStep,
    onDeleteStep,
    isLoadingTools = false,
    agentId,
    versionData,
    onToolsUpdate
}: WorkflowSidePanelProps) {

    const [showComposioRegistry, setShowComposioRegistry] = useState(false);
    const [showCustomMCPDialog, setShowCustomMCPDialog] = useState(false);
    const queryClient = useQueryClient();
    const { data: agent } = useAgent(agentId || '');
    const updateAgentMutation = useUpdateAgent();

    const isMobile = useIsMobile();

    const handleClose = React.useCallback(() => {
        onClose();
    }, [onClose]);

    // Filter step types based on search
    const filteredStepTypes = availableStepTypes.filter(type =>
        type.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        type.description.toLowerCase().includes(searchQuery.toLowerCase())
    );

    React.useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                handleClose();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, handleClose]);

    const handleStepTypeClick = (stepType: StepType) => {
        if (stepType.id === 'credentials_profile') {
            setShowComposioRegistry(true);
        } else if (stepType.id === 'mcp_configuration') {
            setShowCustomMCPDialog(true);
        } else {
            onCreateStep(stepType);
        }
    };

    const handleComposioToolsSelected = (profileId: string, selectedTools: string[], appName: string, appSlug: string) => {
        setShowComposioRegistry(false);
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
        queryClient.invalidateQueries({ queryKey: ['composio', 'profiles'] });
        
        if (onToolsUpdate) {
            onToolsUpdate();
        }
        
        toast.success(`Connected ${appName} integration!`);
    };

    const handleCustomMCPSave = async (customConfig: any) => {
        try {
            const existingCustomMCPs = agent?.custom_mcps || [];
            await updateAgentMutation.mutateAsync({
                agentId: agentId!,
                custom_mcps: [
                    ...existingCustomMCPs,
                    {
                        name: customConfig.name,
                        type: customConfig.type,
                        config: customConfig.config,
                        enabledTools: customConfig.enabledTools
                    }
                ]
            });

            const mcpStep: ConditionalStep = {
                id: `mcp-${Date.now()}`,
                name: `${customConfig.name} MCP`,
                description: `MCP server configuration for ${customConfig.name}`,
                type: 'instruction',
                config: {
                    step_type: 'mcp_configuration',
                    tool_name: customConfig.enabledTools[0] || `${customConfig.name} MCP`,
                    mcp_name: customConfig.name,
                    mcp_type: customConfig.type,
                    enabled_tools: customConfig.enabledTools
                },
                order: 0,
                enabled: true,
                children: []
            };

            onCreateStep({
                id: 'mcp_configuration',
                name: mcpStep.name,
                description: mcpStep.description,
                icon: 'Cog',
                category: 'configuration',
                config: mcpStep.config
            });

            // Invalidate queries to refresh tools
            queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
            queryClient.invalidateQueries({ queryKey: ['agent-tools', agentId] });

            // Trigger parent tools update
            if (onToolsUpdate) {
                onToolsUpdate();
            }

            setShowCustomMCPDialog(false);
            toast.success('Custom MCP server added successfully');
        } catch (error) {
            toast.error('Failed to add custom MCP server');
        }
    };

    const renderAddStepContent = () => (
        <div className="flex flex-col h-full">
            <div className="pt-4 pl-4 pr-4">
                <div className="flex items-center justify-between">
                    <div className="ml-2 flex items-center gap-2">
                        <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">Add Step</h2>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleClose}
                        className="h-8 w-8"
                    >
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            </div>
            <div className="flex-1 p-4 overflow-auto">
                <div className="space-y-6">
                    <div>
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">Choose a step type to add to your workflow</p>
                        <Input
                            placeholder="Search steps..."
                            value={searchQuery}
                            onChange={(e) => onSearchChange(e.target.value)}
                            className="w-full"
                            autoFocus
                        />
                    </div>

                    {/* Categories */}
                    {categories.map(category => {
                        const categorySteps = filteredStepTypes.filter(step => step.category === category.id);
                        if (categorySteps.length === 0) return null;

                        return (
                            <div key={category.id} className="space-y-3">
                                <div>
                                    <h3 className="font-medium text-sm text-zinc-900 dark:text-zinc-100">{category.name}</h3>
                                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{category.description}</p>
                                </div>
                                <div className="space-y-2">
                                    {categorySteps.map(stepType => {
                                        const { icon: IconComponent, color } = getStepIconAndColor(stepType);

                                        return (
                                            <button
                                                key={stepType.id}
                                                onClick={() => handleStepTypeClick(stepType)}
                                                className="w-full p-3 text-left border border-border rounded-2xl hover:bg-muted/50 transition-colors"
                                            >
                                                <div className="flex items-center gap-3">
                                                    <div className={`relative p-2 rounded-lg bg-gradient-to-br ${color} border`}>
                                                        <IconComponent className="w-5 h-5" />
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100">{stepType.name}</div>
                                                        <div className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-2 mt-0.5">
                                                            {stepType.description}
                                                        </div>
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}

                    {filteredStepTypes.length === 0 && (
                        <div className="text-center py-8">
                            <div className="text-zinc-400 dark:text-zinc-500 mb-2">No steps found</div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400">Try adjusting your search</div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );

    const renderEditStepContent = () => {
        if (!selectedStep) return null;

        return (
            <div className="flex flex-col h-full">
                <div className="pt-4 pl-4 pr-4">
                    <div className="flex items-center justify-between">
                        <div className="ml-2 flex items-center gap-2">
                            <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">Edit Step</h2>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleClose}
                            className="h-8 w-8"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                    <div className="space-y-6">
                        {/* Basic info */}
                        <div className="space-y-4">
                            <div>
                                <Label htmlFor="step-name" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Name</Label>
                                <Input
                                    id="step-name"
                                    value={selectedStep.name}
                                    onChange={(e) => onUpdateStep({ id: selectedStep.id, name: e.target.value })}
                                    placeholder="Step name"
                                    className="mt-1"
                                />
                            </div>

                            <div>
                                <Label htmlFor="step-description" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Description</Label>
                                <Textarea
                                    id="step-description"
                                    value={selectedStep.description}
                                    onChange={(e) => onUpdateStep({ id: selectedStep.id, description: e.target.value })}
                                    placeholder="What should this step do?"
                                    rows={3}
                                    className="mt-1 resize-none"
                                />
                            </div>
                        </div>

                        {/* Tool configuration */}
                        {selectedStep.config?.tool_name && (
                            <div className="p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-xl border border-zinc-200 dark:border-zinc-800">
                                <div className="font-medium text-sm mb-2 text-zinc-900 dark:text-zinc-100">Tool Configuration</div>
                                <div className="text-sm text-zinc-600 dark:text-zinc-400">
                                    Using: <Badge variant="default" className="ml-1">{selectedStep.config.tool_name}</Badge>
                                </div>
                            </div>
                        )}

                        {/* Condition configuration */}
                        {selectedStep.type === 'condition' && (
                            <div className="space-y-4">
                                <div>
                                    <Label htmlFor="condition-expression" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Condition</Label>
                                    <Input
                                        id="condition-expression"
                                        value={selectedStep.conditions?.expression || ''}
                                        onChange={(e) => onUpdateStep({
                                            id: selectedStep.id,
                                            conditions: { ...selectedStep.conditions, expression: e.target.value }
                                        })}
                                        placeholder="Enter condition expression"
                                        className="mt-1"
                                    />
                                </div>
                            </div>
                        )}

                        {/* Delete button */}
                        <div className="pt-4 border-t border-zinc-200 dark:border-zinc-700">
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => {
                                    // If this is the "if" step of a conditional group, we need to delete the entire group
                                    // The parent component should handle this logic
                                    onDeleteStep(selectedStep.id);
                                }}
                                className="w-full"
                            >
                                <Trash2 className="h-4 w-4" />
                                {selectedStep.conditions?.type === 'if' ? 'Delete Conditional Group' : 'Delete Step'}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const renderContent = () => (
        <div className="flex flex-col h-full">
            <ScrollArea className="h-full">
                {mode === 'add' ? renderAddStepContent() : renderEditStepContent()}
            </ScrollArea>
        </div>
    );

    if (!isOpen) return null;

    return (
        <>
            <AnimatePresence mode="wait">
                <motion.div
                    key="workflow-sidepanel"
                    layoutId={FLOATING_LAYOUT_ID}
                    initial={{ opacity: 0, x: 100 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 100 }}
                    transition={{
                        opacity: { duration: 0.15 },
                        x: { type: "spring", stiffness: 400, damping: 35 },
                        layout: {
                            type: "spring",
                            stiffness: 400,
                            damping: 35
                        }
                    }}
                    className={cn(
                        'fixed top-2 right-2 bottom-4 border border-zinc-200 dark:border-zinc-800 rounded-3xl flex flex-col z-30 bg-card',
                        isMobile
                            ? 'left-2'
                            : 'w-[40vw] sm:w-[450px] md:w-[500px] lg:w-[550px] xl:w-[645px]',
                    )}
                    style={{
                        overflow: 'hidden',
                    }}
                >
                    {renderContent()}
                </motion.div>
            </AnimatePresence>
            <Dialog open={showComposioRegistry} onOpenChange={setShowComposioRegistry}>
                <DialogContent className="p-0 max-w-6xl h-[90vh] overflow-hidden">
                    <DialogHeader className="sr-only">
                        <DialogTitle>App Integrations</DialogTitle>
                    </DialogHeader>
                    <ComposioRegistry
                        selectedAgentId={agentId}
                        onClose={() => setShowComposioRegistry(false)}
                        onToolsSelected={handleComposioToolsSelected}
                    />
                </DialogContent>
            </Dialog>
            <CustomMCPDialog
                open={showCustomMCPDialog}
                onOpenChange={setShowCustomMCPDialog}
                onSave={handleCustomMCPSave}
            />
        </>
    );
} 