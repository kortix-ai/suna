'use client';

import React, { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { useExecuteWorkflow } from '@/hooks/react-query/agents/use-agent-workflows';
import { AgentWorkflow } from '@/hooks/react-query/agents/workflow-utils';
import { Play } from 'lucide-react';

interface WorkflowExecutionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: AgentWorkflow | null;
  agentId: string;
  onSuccess?: (result: any) => void;
  onError?: (error: any) => void;
}

export function WorkflowExecutionDialog({
  open,
  onOpenChange,
  workflow,
  agentId,
  onSuccess,
  onError
}: WorkflowExecutionDialogProps) {
  const executeWorkflowMutation = useExecuteWorkflow();
  const [executionInput, setExecutionInput] = useState<string>('');

  const handleClose = useCallback(() => {
    onOpenChange(false);
    setExecutionInput('');
  }, [onOpenChange]);

  const handleConfirmExecution = useCallback(async () => {
    if (!workflow) return;
    
    try {
      const result = await executeWorkflowMutation.mutateAsync({ 
        agentId, 
        workflowId: workflow.id, 
        execution: {
          input_data: executionInput.trim() ? { prompt: executionInput } : undefined
        } 
      });
      
      handleClose();
      toast.success(`${result.message}`);
      onSuccess?.(result);
    } catch (error) {
      toast.error('Failed to execute workflow');
      onError?.(error);
    }
  }, [agentId, workflow, executionInput, executeWorkflowMutation, handleClose, onSuccess, onError]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Execute Workflow</DialogTitle>
          <DialogDescription>
            Provide input data for "{workflow?.name}" workflow
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>What would you like the workflow to work on?</Label>
            <Textarea
              value={executionInput}
              onChange={(e) => setExecutionInput(e.target.value)}
              placeholder="Enter your request..."
              rows={4}
              className="resize-none"
              required={true}
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-4">
            <Button 
              variant="outline" 
              onClick={handleClose}
            >
              Cancel
            </Button>
            <Button 
              onClick={handleConfirmExecution}
              disabled={executeWorkflowMutation.isPending}
            >
              <Play className="h-3.5 w-3.5" />
              {executeWorkflowMutation.isPending ? 'Executing...' : 'Execute Workflow'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
} 