'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useExecuteWorkflow, useUpdateAgentWorkflow } from '@/hooks/react-query/agents/use-agent-workflows';
import type { AgentWorkflow } from '@/hooks/react-query/agents/workflow-utils';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { getThread } from '@/hooks/react-query/threads/utils';
import { Loader2 } from 'lucide-react';

type VariableType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect';

interface VariableSpec {
    key: string;
    label: string;
    type: VariableType;
    required?: boolean;
    options?: string[];
    default?: string | number | boolean | string[];
    helperText?: string;
}

export interface PlaybookExecuteDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    agentId: string;
    playbook: AgentWorkflow | null;
    onStarted?: (threadId?: string, agentRunId?: string) => void;
}

export const PlaybookExecuteDialog: React.FC<PlaybookExecuteDialogProps> = ({
    open,
    onOpenChange,
    agentId,
    playbook,
    onStarted,
}) => {
    const executeMutation = useExecuteWorkflow();
    const updateWorkflowMutation = useUpdateAgentWorkflow();
    const [values, setValues] = useState<Record<string, any>>({});
    const [startedInfo, setStartedInfo] = useState<{ threadId: string; agentRunId?: string; startedAt: number; message?: string } | null>(null);
    const [locallyActivated, setLocallyActivated] = useState<boolean>(false);
    const router = useRouter();

    const { variableSpecs, templateText } = useMemo(() => {
        if (!playbook) return { variableSpecs: [] as VariableSpec[], templateText: '' };
        const stepsAny = ((playbook as any)?.steps as any[]) || [];
        const start = stepsAny.find(
            (s) => s?.name === 'Start' && s?.description === 'Click to add steps or use the Add Node button',
        );
        const child = start?.children?.[0] ?? stepsAny[0];
        const vars = (child?.config?.playbook?.variables as VariableSpec[]) || [];
        const tpl = (child?.config?.playbook?.template as string) || '';
        return { variableSpecs: vars, templateText: tpl };
    }, [playbook]);

    useEffect(() => {
        if (open) {
            const defaults: Record<string, any> = {};
            variableSpecs.forEach((v) => {
                if (v.default !== undefined) defaults[v.key] = v.default;
            });
            setValues(defaults);
            setStartedInfo(null);
            setLocallyActivated(false);
        }
    }, [open, variableSpecs]);

    const isValid = useMemo(() => {
        return variableSpecs.every((v) => !v.required || (values[v.key] !== undefined && values[v.key] !== ''));
    }, [variableSpecs, values]);

    const handleChange = useCallback((key: string, val: any) => {
        setValues((prev) => ({ ...prev, [key]: val }));
    }, []);

    const isActive = (playbook?.status === 'active') || locallyActivated;

    const handleRun = useCallback(async () => {
        if (!isValid || !playbook) {
            toast.error('Please fill all required fields');
            return;
        }
        if (!isActive) {
            toast.error('Activate this playbook before running');
            return;
        }
        try {
            const result = await executeMutation.mutateAsync({
                agentId,
                workflowId: playbook.id,
                execution: { input_data: values },
            });
            const threadId = result.thread_id;
            const agentRunId = result.agent_run_id;
            setStartedInfo({ threadId: threadId || '', agentRunId, startedAt: Date.now(), message: result.message });

            const openThread = async () => {
                try {
                    if (!threadId) return;
                    const thread = await getThread(threadId);
                    const projectId = thread.project_id || 'default';
                    router.push(`/projects/${projectId}/thread/${threadId}`);
                } catch (err) {
                    toast.error('Failed to open thread');
                }
            };

            onStarted?.(threadId, agentRunId);
        } catch (e) {
            toast.error('Failed to start playbook');
        }
    }, [agentId, isActive, isValid, onStarted, playbook?.id, playbook?.name, values, executeMutation, router]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Start {playbook?.name ?? 'Playbook'}</DialogTitle>
                    <DialogDescription>Your playbook will run in a separate thread so you can keep working here.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    {playbook && !isActive ? (
                        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900">
                            <div className="flex items-center justify-between gap-3">
                                <div className="text-sm">
                                    <div className="font-medium">Playbook is not active</div>
                                    <div className="text-amber-800/90">This playbook is currently "{playbook.status}" and can’t be run. Activate it to enable execution.</div>
                                </div>
                                <Button
                                    size="sm"
                                    variant="default"
                                    onClick={async () => {
                                        if (!playbook) return;
                                        try {
                                            await updateWorkflowMutation.mutateAsync({
                                                agentId,
                                                workflowId: playbook.id,
                                                workflow: { status: 'active' },
                                            });
                                            setLocallyActivated(true);
                                            toast.success('Playbook activated');
                                        } catch (e) {
                                            toast.error('Failed to activate playbook');
                                        }
                                    }}
                                    disabled={updateWorkflowMutation.isPending}
                                >
                                    {updateWorkflowMutation.isPending ? 'Activating…' : 'Activate'}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                    {startedInfo ? (
                        <div className="rounded-2xl border p-4 bg-muted/30">
                            <div className="space-y-2">
                                <div className="text-sm font-medium">Playbook is running</div>
                                <div className="text-sm text-muted-foreground">
                                    {playbook?.name} is processing in the background. You can close this and keep working.
                                </div>
                                <div className="flex items-center justify-end gap-2 pt-2">
                                    <Button
                                        type="button"
                                        onClick={async () => {
                                            if (!startedInfo.threadId) return;
                                            try {
                                                const thread = await getThread(startedInfo.threadId);
                                                const projectId = thread.project_id || 'default';
                                                router.push(`/projects/${projectId}/thread/${startedInfo.threadId}`);
                                            } catch {
                                                toast.error('Failed to open thread');
                                            }
                                        }}
                                    >
                                        Open thread
                                    </Button>

                                </div>
                            </div>
                        </div>
                    ) : (
                        <>
                            {(templateText || playbook?.description) ? (
                                <div className="rounded-xl border p-3 bg-muted/30 max-h-[160px] overflow-y-auto">
                                    <p className="text-xs text-muted-foreground whitespace-pre-wrap">{templateText || playbook?.description}</p>
                                </div>
                            ) : null}
                            <p className="text-sm text-muted-foreground">Fill in the details below:</p>

                            {variableSpecs.length === 0 ? (
                                <div className="text-sm text-muted-foreground">This playbook has no variables.</div>
                            ) : (
                                <div className="space-y-3">
                                    {variableSpecs.map((v) => (
                                        <div key={v.key} className="space-y-1">
                                            <Label htmlFor={`v-${v.key}`}>{v.label}</Label>
                                            <Input
                                                id={`v-${v.key}`}
                                                type={v.type === 'number' ? 'number' : 'text'}
                                                value={values[v.key] ?? ''}
                                                onChange={(e) => handleChange(v.key, v.type === 'number' ? Number(e.target.value) : e.target.value)}
                                                placeholder={v.helperText || ''}
                                            />
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="flex items-center justify-end gap-2 pt-2">
                                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                                    Cancel
                                </Button>
                                <Button type="button" onClick={handleRun} disabled={executeMutation.isPending || !isValid || !isActive}>
                                    {executeMutation.isPending ? (
                                        <span className="inline-flex items-center"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Running…</span>
                                    ) : (
                                        'Run'
                                    )}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
};


