'use client';

import React, { useState, useEffect } from 'react';
import { useAgent, useUpdateAgent } from '@/hooks/agents/use-agents';
import { GranularToolConfiguration } from '@/components/agents/tools/granular-tool-configuration';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';

interface WorkflowsScreenProps {
    agentId: string;
}

export function WorkflowsScreen({ agentId }: WorkflowsScreenProps) {
    const { data: agent, isLoading } = useAgent(agentId);
    const updateAgentMutation = useUpdateAgent();
    const [tools, setTools] = useState<Record<string, any>>({});

    useEffect(() => {
        if (agent?.agentpress_tools) {
            setTools(agent.agentpress_tools);
        }
    }, [agent?.agentpress_tools]);

    const isSunaAgent = agent?.metadata?.is_suna_default || false;
    const restrictions = agent?.metadata?.restrictions || {};
    const areToolsEditable = (restrictions.tools_editable !== false) && !isSunaAgent;

    const handleToolsChange = async (newTools: Record<string, boolean | { enabled: boolean; description: string }>) => {
        if (!areToolsEditable) {
            if (isSunaAgent) {
                toast.error("Tools cannot be edited", {
                    description: "Suna's tools are managed centrally.",
                });
            }
            return;
        }

        try {
            await updateAgentMutation.mutateAsync({
                agentId,
                agentpress_tools: newTools,
            });
            setTools(newTools);
            toast.success('Tools updated successfully');
        } catch (error) {
            console.error('Failed to update tools:', error);
            toast.error('Failed to update tools');
        }
    };

    if (isLoading) {
        return (
            <div className="flex-1 overflow-auto pb-6">
                <div className="px-1 pt-1 space-y-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-32 w-full" />
                    <Skeleton className="h-32 w-full" />
                    <Skeleton className="h-32 w-full" />
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col overflow-hidden pb-6">
            <div className="px-1 pt-1 flex flex-col flex-1 min-h-0 h-full">
                <GranularToolConfiguration
                    tools={tools}
                    onToolsChange={handleToolsChange}
                    disabled={!areToolsEditable}
                    isSunaAgent={isSunaAgent}
                    isLoading={updateAgentMutation.isPending}
                />
            </div>
        </div>
    );
}
