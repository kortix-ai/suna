'use client';

/**
 * The workbench changes panel, read only: what this thread changed
 * (`git.versionDiff` of its branch against the default branch), the thread's
 * own commits (`git.commits({ ref })`) and a detail dialog (`git.commit`,
 * `git.commitDiff`). Everything routes through the `@kortix/sdk` facade — no
 * raw HTTP. Committing and change requests are the Lumen operator's: the proxy
 * refuses them, so the panel offers none.
 */

import { Button } from '@kortix/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { ScrollArea } from '@kortix/ui/scroll-area';
import { Skeleton } from '@kortix/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { useSessionRef } from '@/lib/session-ref';
import { relativeTime } from '@/lib/utils';
import type { ProjectCommit } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DiffStat, DiffView } from './diff-view';
import { GitCommitIcon, GitDiffIcon } from '@phosphor-icons/react';

/**
 * What this thread changed on top of the workspace: the session branch
 * against the default branch (`git.versionDiff`). Before the agent pushes,
 * the thread has no branch of its own and nothing to compare.
 */
function ThreadSummary({
  projectId,
  sessionId,
  baseRef,
  hasBranch,
}: {
  projectId: string;
  sessionId: string;
  baseRef: string | undefined;
  hasBranch: boolean;
}) {
  const diff = useQuery({
    queryKey: ['project-version-diff', projectId, baseRef, sessionId],
    enabled: hasBranch && !!baseRef,
    // What merging the thread's branch into the workspace would bring.
    queryFn: () => kortix.project(projectId).git.versionDiff({ from: sessionId, into: baseRef as string }),
  });
  const d = diff.data;
  return (
    <div className="flex shrink-0 items-center gap-3 rounded-lg border border-border bg-background/40 px-3.5 py-3">
      <div className="grid size-8 shrink-0 place-items-center rounded-md bg-brand/10">
        <GitDiffIcon className="size-4 text-brand" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">This thread&apos;s changes</div>
        <div className="text-xs text-muted-foreground">
          {!hasBranch || (d && (d.is_same_ref || d.files_changed === 0))
            ? 'Nothing committed yet. Files the agent commits in this thread appear here.'
            : diff.isLoading
              ? 'Comparing with the workspace…'
              : d
                ? `${d.files_changed} ${d.files_changed === 1 ? 'file' : 'files'} changed on top of the workspace`
                : 'Could not compare with the workspace.'}
        </div>
      </div>
      {d && !d.is_same_ref && d.files_changed > 0 && <DiffStat additions={d.additions} deletions={d.deletions} />}
    </div>
  );
}

function CommitList({
  items,
  isLoading,
  onOpen,
}: {
  items: ProjectCommit[];
  isLoading: boolean;
  onOpen: (sha: string) => void;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-1 pr-2">
        {isLoading ? (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        ) : items.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">No commits in this thread yet.</div>
        ) : (
          items.map((c) => (
            <Button
              key={c.hash}
              type="button"
              variant="outline"
              onClick={() => onOpen(c.hash)}
              className="h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-lg bg-card/50 px-2.5 py-2 text-left hover:bg-card"
            >
              <GitCommitIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {c.subject || '(no message)'}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[0.7rem] text-muted-foreground">
                  <span className="font-mono">{c.short_hash}</span>
                  <span>{c.author_name}</span>
                  <span>{relativeTime(c.committed_at ?? c.authored_at)}</span>
                </div>
              </div>
            </Button>
          ))
        )}
      </div>
    </ScrollArea>
  );
}

export function CommitsView({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const [openSha, setOpenSha] = useState<string | null>(null);
  const ref = useSessionRef(projectId, sessionId);
  const hasBranch = ref === sessionId;

  const branches = useQuery({
    queryKey: ['project-branches', projectId],
    queryFn: () => kortix.project(projectId).git.branches(),
  });
  const baseRef = branches.data?.default_branch;

  // The thread's own commits: its branch minus the workspace's history (the
  // operator's setup commits stay out of a customer's view).
  const commits = useQuery({
    queryKey: ['project-commits', projectId, sessionId, baseRef],
    enabled: hasBranch && !!baseRef,
    queryFn: async () => {
      const [thread, base] = await Promise.all([
        kortix.project(projectId).git.commits({ ref: sessionId, limit: 50 }),
        kortix.project(projectId).git.commits({ ref: baseRef, limit: 200 }),
      ]);
      const inBase = new Set(base.commits.map((c) => c.hash));
      return thread.commits.filter((c) => !inBase.has(c.hash));
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ThreadSummary projectId={projectId} sessionId={sessionId} baseRef={baseRef} hasBranch={hasBranch} />

      <div className="flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
        <GitCommitIcon className="size-3.5" />
        Commits
      </div>
      <CommitList
        items={commits.data ?? []}
        isLoading={ref === undefined || (hasBranch && commits.isLoading)}
        onOpen={setOpenSha}
      />

      <CommitDetailDialog projectId={projectId} sha={openSha} onClose={() => setOpenSha(null)} />
    </div>
  );
}

/** A commit's metadata (`git.commit`) + patch (`git.commitDiff`) in a dialog. */
function CommitDetailDialog({
  projectId,
  sha,
  onClose,
}: {
  projectId: string;
  sha: string | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['project-commit', projectId, sha],
    enabled: !!sha,
    queryFn: () => kortix.project(projectId).git.commit(sha as string),
  });

  const diff = useQuery({
    queryKey: ['project-commit-diff', projectId, sha],
    enabled: !!sha,
    queryFn: () => kortix.project(projectId).git.commitDiff(sha as string),
  });

  const d = detail.data;
  const files = d?.files ?? [];

  return (
    <Modal open={!!sha} onOpenChange={(o) => !o && onClose()}>
      <ModalContent className="flex max-h-[85vh] lg:max-w-3xl flex-col">
        <ModalHeader>
          <ModalTitle className="truncate">{d?.subject ?? 'Commit'}</ModalTitle>
          <ModalDescription className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span>{d?.short_hash ?? sha?.slice(0, 7)}</span>
            {d?.author_name && <span>· {d.author_name}</span>}
            {d?.committed_at && <span>· {relativeTime(d.committed_at)}</span>}
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="flex min-h-0 flex-col">
          {d?.body && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{d.body}</p>}

          {files.length > 0 && (
            <div className="space-y-0.5 rounded-md border border-border p-2">
              {files.map((f, i) => (
                <div
                  key={`${f.path}-${i}`}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="truncate font-mono text-foreground/80">
                    <span className="mr-1.5 text-muted-foreground">[{f.status}]</span>
                    {f.path}
                  </span>
                  <DiffStat additions={f.additions} deletions={f.deletions} />
                </div>
              ))}
            </div>
          )}

          <ScrollArea className="min-h-0 flex-1">
            {diff.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <DiffView patch={diff.data?.patch} />
            )}
          </ScrollArea>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
