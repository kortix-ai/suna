'use client';

import React, { useState, useEffect } from 'react';
import { useAgent } from '@/hooks/agents/use-agents';
import { useUpdateAgentMCPs } from '@/hooks/agents/use-update-agent-mcps';
import { AgentMCPConfiguration } from '@/components/agents/agent-mcp-configuration';
import { toast } from '@/lib/toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Server } from 'lucide-react';

const MCPS_TRIG_ENABLED = process.env.NEXT_PUBLIC_ACTIVATE_MCPS_TRIG === 'true';

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

    if (!MCPS_TRIG_ENABLED) {
        return (
            <div className="flex-1 flex items-center justify-center pb-6">
                <div className="flex flex-col items-center gap-4 max-w-sm text-center px-4">
                    <div className="w-12 h-12 rounded-2xl bg-muted/50 border border-border flex items-center justify-center">
                        <Server className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div>
                        <h3 className="text-base font-semibold text-foreground mb-1">Integrations Under Maintenance</h3>
                        <p className="text-sm text-muted-foreground">
                            Integrations are temporarily unavailable while we make improvements. This feature will be back soon.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

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
