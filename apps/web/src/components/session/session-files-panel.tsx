'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMerge, GitPullRequestArrow, Loader2 } from 'lucide-react';

import {
  getProjectSession,
  openChangeRequest,
  getChangeRequestMergePreview,
  mergeChangeRequest,
} from '@/lib/projects-client';
import { useGitStatus } from '@/features/files/hooks/use-git-status';
import { FileExplorerPage } from '@/features/files/components';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

/**
 * Files CRUD'd in this session's sandbox.
 *
 * The session's sandbox `/workspace` IS the git working tree of this session's
 * branch (branch name == the route session id, forked from `base_ref`). So the
 * file browser below — the app's standard FileExplorer, pointed at this
 * session's active sandbox — shows exactly those files, with the agent's
 * changes badged via git status. They live ONLY in this session until merged
 * into the base branch, which the header actions do via a change request.
 */
export function SessionFilesPanel() {
  // The git branch == the ROUTE session id (== sandbox id), which differs from
  // SessionLayout's `sessionId` prop (that's the OpenCode chat session id).
  const { id: projectId, sessionId: gitSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();

  const queryClient = useQueryClient();

  // Drives the "N changed" copy + enables the merge/CR actions.
  const statusQuery = useGitStatus();
  const changedCount = statusQuery.data?.length ?? 0;

  const sessionQuery = useQuery({
    queryKey: ['project', 'session', projectId, gitSessionId],
    queryFn: () => getProjectSession(projectId!, gitSessionId!),
    enabled: !!projectId && !!gitSessionId,
    staleTime: 60_000,
  });
  const baseRef = sessionQuery.data?.base_ref ?? 'main';
  const defaultTitle = sessionQuery.data?.name || 'Session changes';

  const [crOpen, setCrOpen] = useState(false);
  const [crTitle, setCrTitle] = useState('');
  const [crDescription, setCrDescription] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);

  const canAct = !!projectId && !!gitSessionId && changedCount > 0;

  const openCrMutation = useMutation({
    mutationFn: () =>
      openChangeRequest(projectId!, {
        title: crTitle.trim() || defaultTitle,
        description: crDescription.trim() || undefined,
        head_ref: gitSessionId!,
        base_ref: baseRef,
        session_id: gitSessionId!,
      }),
    onSuccess: (cr) => {
      toast.success(`Change request #${cr.number} opened`);
      setCrOpen(false);
      setCrTitle('');
      setCrDescription('');
      queryClient.invalidateQueries({
        queryKey: ['project', 'change-requests', projectId],
      });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : 'Failed to open change request',
      ),
  });

  const mergeMutation = useMutation({
    mutationFn: async () => {
      // Merge runs through a change request: create one for this branch,
      // verify it merges cleanly, then merge it into the base branch.
      const cr = await openChangeRequest(projectId!, {
        title: defaultTitle,
        head_ref: gitSessionId!,
        base_ref: baseRef,
        session_id: gitSessionId!,
      });
      const preview = await getChangeRequestMergePreview(projectId!, cr.cr_id);
      if (!preview.can_merge) {
        throw new Error(
          preview.conflicts.length
            ? `Merge conflicts in ${preview.conflicts.length} file(s). Open a change request to resolve.`
            : 'These changes can’t be merged automatically.',
        );
      }
      return mergeChangeRequest(projectId!, cr.cr_id);
    },
    onSuccess: () => {
      toast.success(`Merged into ${baseRef}`);
      setMergeOpen(false);
      queryClient.invalidateQueries({
        queryKey: ['project', 'change-requests', projectId],
      });
      statusQuery.refetch();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to merge');
      setMergeOpen(false);
    },
  });

  return (
    <div className="flex h-full flex-col">
      {/* Session-only indicator + actions */}
      <div className="flex-shrink-0 space-y-2.5 border-b border-border/40 p-3">
        <InfoBanner
          tone="info"
          icon={GitPullRequestArrow}
          className="px-3 py-2 text-xs"
        >
          {changedCount > 0 ? (
            <>
              <span className="font-medium">
                {changedCount} file{changedCount === 1 ? '' : 's'} changed
              </span>{' '}
              in this session — these live only here until merged into{' '}
              <span className="font-mono text-foreground/80">{baseRef}</span>.
            </>
          ) : (
            <>
              Files the agent changes here live only in this session until merged
              into <span className="font-mono text-foreground/80">{baseRef}</span>
              .
            </>
          )}
        </InfoBanner>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={!canAct}
            onClick={() => {
              setCrTitle(defaultTitle);
              setCrOpen(true);
            }}
          >
            <GitPullRequestArrow className="size-3.5" />
            Open change request
          </Button>
          <Button
            size="sm"
            className="flex-1"
            disabled={!canAct || mergeMutation.isPending}
            onClick={() => setMergeOpen(true)}
          >
            {mergeMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <GitMerge className="size-3.5" />
            )}
            Merge to {baseRef}
          </Button>
        </div>
      </div>

      {/* The app's standard file explorer, pointed at this session's sandbox. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileExplorerPage />
      </div>

      {/* Open change request dialog */}
      <Dialog open={crOpen} onOpenChange={setCrOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
          <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
            <DialogTitle>Open change request</DialogTitle>
            <DialogDescription>
              Propose merging this session&apos;s {changedCount} changed file
              {changedCount === 1 ? '' : 's'} into{' '}
              <span className="font-mono">{baseRef}</span>.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              openCrMutation.mutate();
            }}
          >
            <div className="space-y-4 px-6 py-5">
              <div className="space-y-1.5">
                <Label htmlFor="cr-title">Title</Label>
                <Input
                  id="cr-title"
                  value={crTitle}
                  onChange={(e) => setCrTitle(e.target.value)}
                  placeholder={defaultTitle}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cr-description">Description</Label>
                <Textarea
                  id="cr-description"
                  value={crDescription}
                  onChange={(e) => setCrDescription(e.target.value)}
                  placeholder="What changed and why (optional)"
                  rows={4}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCrOpen(false)}
                disabled={openCrMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={openCrMutation.isPending}>
                {openCrMutation.isPending && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                Open change request
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Merge confirm */}
      <ConfirmDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        title={`Merge into ${baseRef}?`}
        description={
          <>
            This brings this session&apos;s {changedCount} changed file
            {changedCount === 1 ? '' : 's'} into the{' '}
            <span className="font-mono">{baseRef}</span> branch. A change request
            is created and merged for the record.
          </>
        }
        confirmLabel={`Merge to ${baseRef}`}
        onConfirm={() => mergeMutation.mutate()}
        isPending={mergeMutation.isPending}
      />
    </div>
  );
}
