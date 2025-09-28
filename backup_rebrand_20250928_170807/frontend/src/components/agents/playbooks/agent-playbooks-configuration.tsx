'use client';

import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Plus, Play, Pencil, Trash2, BookOpen } from 'lucide-react';
import { useAgentWorkflows, useDeleteAgentWorkflow } from '@/hooks/react-query/agents/use-agent-workflows';
import type { AgentWorkflow } from '@/hooks/react-query/agents/workflow-utils';
import { PlaybookCreateModal } from '@/components/playbooks/playbook-create-modal';
import { PlaybookExecuteDialog } from '@/components/playbooks/playbook-execute-dialog';
import { DeleteConfirmationDialog } from '@/components/thread/DeleteConfirmationDialog';

interface AgentPlaybooksConfigurationProps {
    agentId: string;
    agentName: string;
}

function isPlaybook(workflow: AgentWorkflow): boolean {
    try {
        const stepsAny = (workflow.steps as unknown as any[]) || [];
        const start = stepsAny.find(
            (s) => s?.name === 'Start' && s?.description === 'Click to add steps or use the Add Node button',
        );
        const child = start?.children?.[0] ?? stepsAny[0];
        return Boolean(child?.config?.playbook);
    } catch {
        return false;
    }
}

export function AgentPlaybooksConfiguration({ agentId, agentName }: AgentPlaybooksConfigurationProps) {
    const { data: workflows = [], isLoading } = useAgentWorkflows(agentId);
    const deleteWorkflowMutation = useDeleteAgentWorkflow();

    const playbooks = useMemo(() => workflows.filter(isPlaybook), [workflows]);

    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [editing, setEditing] = useState<AgentWorkflow | null>(null);
    const [executing, setExecuting] = useState<AgentWorkflow | null>(null);
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const [toDelete, setToDelete] = useState<AgentWorkflow | null>(null);

    const handleDelete = (w: AgentWorkflow) => {
        setToDelete(w);
        setIsDeleteOpen(true);
    };

    const confirmDelete = async () => {
        if (!toDelete) return;
        try {
            await deleteWorkflowMutation.mutateAsync({ agentId, workflowId: toDelete.id });
        } finally {
            setIsDeleteOpen(false);
            setToDelete(null);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-start">
                <Button onClick={() => { setEditing(null); setIsCreateOpen(true); }} size="sm" className="gap-2">
                    <Plus className="h-4 w-4" />
                    New Playbook
                </Button>
            </div>

            {isLoading ? (
                <div className="text-sm text-muted-foreground">Loading...</div>
            ) : playbooks.length === 0 ? (
                <div className="text-center py-12 px-6 bg-muted/30 rounded-xl border-2 border-dashed border-border">
                    <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4 border">
                        <BookOpen className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <h4 className="text-sm font-semibold text-foreground mb-2">
                        No playbooks yet
                    </h4>
                    <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                        Create your first playbook to automate common workflows with variable-driven runs
                    </p>
                </div>
            ) : (
                <div className="space-y-2">
                    {playbooks.map((pb) => (
                        <div key={pb.id} className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors group">
                            <div className="flex items-center space-x-4 flex-1 min-w-0">
                                <div className="p-2 rounded-lg bg-muted border">
                                    <BookOpen className="h-4 w-4" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center space-x-2 mb-1 min-w-0">
                                        <h4 className="text-sm font-medium truncate w-full">{pb.name}</h4>
                                    </div>
                                    {pb.description && (
                                        <p className="text-xs text-muted-foreground truncate w-full">{pb.description}</p>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center space-x-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => setExecuting(pb)} aria-label="Run playbook">
                                    <Play className="h-4 w-4" />
                                </Button>
                                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => { setEditing(pb); setIsCreateOpen(true); }} aria-label="Edit playbook">
                                    <Pencil className="h-4 w-4" />
                                </Button>
                                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={() => handleDelete(pb)} aria-label="Delete playbook">
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <PlaybookCreateModal
                open={isCreateOpen}
                onOpenChange={setIsCreateOpen}
                agentId={agentId}
                initialPlaybook={editing}
                onCreated={() => { }}
            />

            {executing && (
                <PlaybookExecuteDialog
                    open={!!executing}
                    onOpenChange={(o) => { if (!o) setExecuting(null); }}
                    agentId={agentId}
                    playbook={executing}
                />
            )}

            <DeleteConfirmationDialog
                isOpen={isDeleteOpen}
                onClose={() => { if (!deleteWorkflowMutation.isPending) { setIsDeleteOpen(false); setToDelete(null); } }}
                onConfirm={confirmDelete}
                threadName={toDelete?.name ?? ''}
                isDeleting={deleteWorkflowMutation.isPending}
            />
        </div>
    );
}


