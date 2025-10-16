'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Loader2, Plus, FileJson, Code } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useCreateNewAgent } from '@/hooks/react-query/agents/use-agents';
import { JsonImportDialog } from './json-import-dialog';
import { AgentCountLimitDialog } from './agent-count-limit-dialog';
import { AgentCountLimitError } from '@/lib/api';
import { toast } from 'sonner';
import { AgentCreationModal } from './agent-creation-modal';
import { isLocalMode, isStagingMode } from '@/lib/config';

interface NewAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (agentId: string) => void;
}

export function NewAgentDialog({ open, onOpenChange, onSuccess }: NewAgentDialogProps) {
  if (isLocalMode() || isStagingMode()) {
    return (
      <AgentCreationModal
        open={open}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
      />
    );
  }

  return (
    <NewAgentDialogLegacy
      open={open}
      onOpenChange={onOpenChange}
      onSuccess={onSuccess}
    />
  );
}

export function NewAgentDialogLegacy({ open, onOpenChange, onSuccess }: NewAgentDialogProps) {
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [jsonImportText, setJsonImportText] = useState('');
  const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
  const [agentLimitError, setAgentLimitError] = useState<AgentCountLimitError | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createNewAgentMutation = useCreateNewAgent();

  const handleCreateNewAgent = () => {
    createNewAgentMutation.mutate(undefined, {
      onSuccess: (newAgent) => {
        onOpenChange(false);
        onSuccess?.(newAgent.agent_id);
      },
      onError: (error) => {
        if (error instanceof AgentCountLimitError) {
          setAgentLimitError(error);
          setShowAgentLimitDialog(true);
          onOpenChange(false);
        } else {
          toast.error(error instanceof Error ? error.message : 'Failed to create agent');
        }
      }
    });
  };

  const handleFileImport = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.json')) {
      toast.error('Please select a JSON file');
      return;
    }

    try {
      const fileContent = await file.text();
      setJsonImportText(fileContent);
      setShowJsonImport(true);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (error) {
      toast.error('Failed to read file');
    }
  };

  const handleDialogClose = (open: boolean) => {
    if (!open) {
      setShowJsonImport(false);
      setJsonImportText('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
    onOpenChange(open);
  };

  const isLoading = createNewAgentMutation.isPending;

  return (
    <AlertDialog open={open} onOpenChange={handleDialogClose}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader className="space-y-3">
          <AlertDialogTitle className="text-xl">Create New Agent</AlertDialogTitle>
          <AlertDialogDescription className="text-base leading-relaxed">
            Create a new agent with default settings that you can customize later, or{' '}
            <button
              onClick={handleFileImport}
              className="text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isLoading}
            >
              import from file
            </button>
            {' '}or{' '}
            <button
              onClick={() => !isLoading && setShowJsonImport(true)}
              className="text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isLoading}
            >
              import from JSON
            </button>
            .
          </AlertDialogDescription>
        </AlertDialogHeader>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileChange}
          className="hidden"
        />
        <AlertDialogFooter className="flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 space-y-2 space-y-reverse sm:space-y-0 pt-6">
          <AlertDialogCancel disabled={isLoading} className="mt-2 sm:mt-0">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleCreateNewAgent}
            disabled={isLoading}
            className="min-w-[120px]"
          >
            {createNewAgentMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" />
                Create Agent
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
      <JsonImportDialog
        open={showJsonImport}
        onOpenChange={setShowJsonImport}
        initialJsonText={jsonImportText}
        onSuccess={(agentId) => {
          setShowJsonImport(false);
          onOpenChange(false);
          onSuccess?.(agentId);
        }}
      />

      {agentLimitError && (
        <AgentCountLimitDialog
          open={showAgentLimitDialog}
          onOpenChange={setShowAgentLimitDialog}
          currentCount={agentLimitError.detail.current_count}
          limit={agentLimitError.detail.limit}
          tierName={agentLimitError.detail.tier_name}
        />
      )}
    </AlertDialog>
  );
}