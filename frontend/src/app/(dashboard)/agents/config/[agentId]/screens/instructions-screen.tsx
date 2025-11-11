'use client';

import React, { useState, useEffect } from 'react';
import { useAgent, useUpdateAgent } from '@/hooks/agents/use-agents';
import { ExpandableMarkdownEditor } from '@/components/ui/expandable-markdown-editor';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';

interface InstructionsScreenProps {
    agentId: string;
}

export function InstructionsScreen({ agentId }: InstructionsScreenProps) {
    const { data: agent, isLoading } = useAgent(agentId);
    const updateAgentMutation = useUpdateAgent();
    const [systemPrompt, setSystemPrompt] = useState('');

    useEffect(() => {
        if (agent?.system_prompt) {
            setSystemPrompt(agent.system_prompt);
        }
    }, [agent?.system_prompt]);

    const isSunaAgent = agent?.metadata?.is_suna_default || false;
    const restrictions = agent?.metadata?.restrictions || {};
    const isEditable = (restrictions.system_prompt_editable !== false) && !isSunaAgent;

    const handleSave = async (value: string) => {
        if (!isEditable) {
            if (isSunaAgent) {
                toast.error("System prompt cannot be edited", {
                    description: "Suna's system prompt is managed centrally.",
                });
            }
            return;
        }

        try {
            await updateAgentMutation.mutateAsync({
                agentId,
                system_prompt: value,
            });
            setSystemPrompt(value);
            toast.success('System prompt updated successfully');
        } catch (error) {
            console.error('Failed to update system prompt:', error);
            toast.error('Failed to update system prompt');
        }
    };

    if (isLoading) {
        return (
            <div className="flex-1 overflow-auto pb-6">
                <div className="px-1 pt-1 space-y-3">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-[500px] w-full rounded-xl" />
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto pb-6">
            <div className="px-1 pt-1 flex flex-col h-full">
                <Label className="text-base font-semibold mb-3 block flex-shrink-0">
                    System Prompt
                </Label>
                <div className="flex-1 min-h-[500px]">
                    <ExpandableMarkdownEditor
                        value={systemPrompt}
                        onSave={handleSave}
                        disabled={!isEditable}
                        placeholder="Define how your agent should behave..."
                        className="h-full"
                    />
                </div>
            </div>
        </div>
    );
}
