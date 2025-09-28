'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TokenEditor, tokenEditorStyles } from '@/components/playbooks/token-editor';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { } from 'lucide-react';
import { useCreateAgentWorkflow, useUpdateAgentWorkflow } from '@/hooks/react-query/agents/use-agent-workflows';
import type { CreateWorkflowRequest, UpdateWorkflowRequest, AgentWorkflow } from '@/hooks/react-query/agents/workflow-utils';
import { toast } from 'sonner';

// All variables are treated as strings for now

export interface PlaybookCreateModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agentId: string;
    initialPlaybook?: AgentWorkflow | null;
    onCreated?: (workflowId: string) => void;
}

function extractTokensFromTemplate(template: string): string[] {
    const regex = /\{\{\s*([a-zA-Z0-9_\.\-]+)\s*\}\}/g;
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(template)) !== null) {
        if (match[1]) found.add(match[1]);
    }
    return Array.from(found);
}

function toLabel(key: string): string {
    return key
        .replace(/[_\.-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
}

export const PlaybookCreateModal: React.FC<PlaybookCreateModalProps> = ({
    open,
    onOpenChange,
    agentId,
    initialPlaybook,
    onCreated,
}) => {
    const isEditing = !!initialPlaybook?.id;
    const [name, setName] = useState(initialPlaybook?.name ?? '');
    const [template, setTemplate] = useState('');

    const createWorkflowMutation = useCreateAgentWorkflow();
    const updateWorkflowMutation = useUpdateAgentWorkflow();

    useEffect(() => {
        if (open) {
            setName(initialPlaybook?.name ?? '');
            if (initialPlaybook) {
                const stepsAny = (initialPlaybook.steps as unknown as any[]) || [];
                const start = stepsAny.find(
                    (s) => s?.name === 'Start' && s?.description === 'Click to add steps or use the Add Node button',
                );
                const child = start?.children?.[0] ?? stepsAny[0];
                const storedTemplate: string | undefined = child?.config?.playbook?.template;
                if (typeof storedTemplate === 'string' && storedTemplate.trim().length > 0) {
                    setTemplate(storedTemplate);
                } else {
                    setTemplate(initialPlaybook.description ?? '');
                }
            } else {
                setTemplate('');
            }
        }
    }, [open, initialPlaybook]);

    // Variables inferred on save; all types are 'string' for now

    // Removed manual variable editing UI per simplified UX

    const payloadSteps = useMemo(() => {
        // Wrap in Start node for maximum compatibility
        const tokens = extractTokensFromTemplate(template);
        const inferredVariables = tokens.map((key) => ({ key, label: toLabel(key), required: true }));

        const playbookStep = {
            id: 'playbook-exec',
            name: 'Execute Playbook',
            description:
                'Execute the playbook described in the workflow description. Replace all {{tokens}} using WORKFLOW INPUT DATA. Perform the tasks precisely and update any referenced artifacts.',
            type: 'instruction',
            config: {
                playbook: {
                    template,
                    variables: inferredVariables,
                },
            },
            order: 1,
            children: [],
        } as const;

        const startNode = {
            id: 'start-node',
            name: 'Start',
            description: 'Click to add steps or use the Add Node button',
            type: 'instruction',
            config: {},
            order: 0,
            children: [playbookStep],
        } as const;

        return [startNode] as unknown as CreateWorkflowRequest['steps'];
    }, [template]);

    const summarize = (text: string): string => {
        const s = (text || '').trim().replace(/\s+/g, ' ');
        return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    };

    const isValid = name.trim().length > 0 && template.trim().length > 0;

    const handleSave = useCallback(async () => {
        if (!isValid) {
            toast.error('Name and template are required');
            return;
        }
        try {
            if (isEditing && initialPlaybook) {
                const updateRequest: UpdateWorkflowRequest = {
                    name,
                    description: summarize(template),
                    steps: payloadSteps,
                };
                await updateWorkflowMutation.mutateAsync({
                    agentId,
                    workflowId: initialPlaybook.id,
                    workflow: updateRequest,
                });
                toast.success('Playbook updated');
                onOpenChange(false);
                onCreated?.(initialPlaybook.id);
            } else {
                const createRequest: CreateWorkflowRequest = {
                    name,
                    description: summarize(template),
                    steps: payloadSteps,
                };
                const created = await createWorkflowMutation.mutateAsync({ agentId, workflow: createRequest });
                try {
                    await updateWorkflowMutation.mutateAsync({
                        agentId,
                        workflowId: created.id,
                        workflow: { status: 'active' },
                    });
                } catch (e) {
                    // Non-blocking
                }
                toast.success('Playbook created');
                onOpenChange(false);
                onCreated?.(created.id);
            }
        } catch (e) {
            toast.error('Failed to save playbook');
        }
    }, [agentId, initialPlaybook, isEditing, isValid, name, payloadSteps, template, createWorkflowMutation, updateWorkflowMutation, onOpenChange, onCreated]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{isEditing ? 'Edit Playbook' : 'Create Playbook'}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="pb-name">Name</Label>
                        <Input id="pb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Company Research and Sheet Update" />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="pb-template">Playbook Template</Label>
                        {/* Component-scoped style injection */}
                        <style dangerouslySetInnerHTML={{ __html: tokenEditorStyles }} />
                        <TokenEditor
                            value={template}
                            onChange={setTemplate}
                            placeholder="Write the playbook instructions here. Use {{google_sheet_id}}, {{sheet_name}}, {{start_row}}, {{limit_rows}} as needed."
                            className="min-h-[220px] max-h-[220px] overflow-y-auto"
                        />
                        <p className="text-xs text-muted-foreground">Use double braces like {'{{token}}'} for variables.</p>
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2" />
                        <div className="flex items-center gap-2">
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                            <Button type="button" onClick={handleSave} disabled={!isValid || createWorkflowMutation.isPending || updateWorkflowMutation.isPending}>
                                {isEditing ? 'Save' : 'Create'}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};


