'use client';

import React, { useState, useEffect } from 'react';
import { useAgent } from '@/hooks/agents/use-agents';
import { useUpdateAgentMCPs } from '@/hooks/agents/use-update-agent-mcps';
import { AgentMCPConfiguration } from '@/components/agents/agent-mcp-configuration';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';

interface IntegrationsScreenProps {
    agentId: string;
}

export function IntegrationsScreen({ agentId }: IntegrationsScreenProps) {
    const { data: agent, isLoading } = useAgent(agentId);
    const updateAgentMCPsMutation = useUpdateAgentMCPs();

    const [configuredMCPs, setConfiguredMCPs] = useState<any[]>([]);
    const [customMCPs, setCustomMCPs] = useState<any[]>([]);

    useEffect(() => {
        if (agent) {
            setConfiguredMCPs(agent.configured_mcps || []);
            setCustomMCPs(agent.custom_mcps || []);
        }
    }, [agent]);

    const handleMCPChange = async (updates: { configured_mcps: any[]; custom_mcps: any[] }) => {
        // Update local state immediately
        setConfiguredMCPs(updates.configured_mcps || []);
        setCustomMCPs(updates.custom_mcps || []);

        // Save MCP changes immediately to backend
        try {
            await updateAgentMCPsMutation.mutateAsync({
                agentId,
                configured_mcps: updates.configured_mcps || [],
                custom_mcps: updates.custom_mcps || [],
                replace_mcps: true
            });

            toast.success('Integration settings updated');
        } catch (error) {
            console.error('Failed to save MCP changes:', error);
            toast.error('Failed to save integration changes');

            // Revert on error
            if (agent) {
                setConfiguredMCPs(agent.configured_mcps || []);
                setCustomMCPs(agent.custom_mcps || []);
            }
        }
    };

    if (isLoading) {
        return (
            <div className="flex-1 overflow-auto pb-6">
                <div className="px-1 pt-1 space-y-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-40 w-full" />
                    <Skeleton className="h-40 w-full" />
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto pb-6">
            <div className="px-1 pt-1">
                <AgentMCPConfiguration
                    configuredMCPs={configuredMCPs}
                    customMCPs={customMCPs}
                    onMCPChange={handleMCPChange}
                    agentId={agentId}
                    versionData={{
                        configured_mcps: configuredMCPs,
                        custom_mcps: customMCPs,
                        system_prompt: agent?.system_prompt || '',
                        agentpress_tools: agent?.agentpress_tools || {}
                    }}
                    saveMode="callback"
                    isLoading={updateAgentMCPsMutation.isPending}
                />
            </div>
        </div>
    );
}
