'use client';

/**
 * A proposed change, and the two things you can do about it.
 *
 * This screen used to be a pull request: a `#number` in mono next to the title,
 * a branch badge reading `into main`, a "Files changed" sidebar with a
 * jump-to-file picker and scroll-spy, a "Total changes" row restating the
 * counts already in the sidebar header, an "Up to date" / "Ready to apply"
 * readiness chip next to an enabled Apply button, and every file's diff
 * expanded on mount. Nine pieces of chrome around one decision.
 *
 * The decision is: someone proposed a change; do you want it? So the screen is
 * the title, one quiet line of context, what they wrote, the files, and two
 * buttons. Branch names, SHAs and merge mechanics only appear when something
 * has actually gone wrong and the reader has to act on them.
 */

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { InfoBanner } from '@/components/ui/info-banner';
import { EmptyState } from '@/features/layout/section/empty-state';
import { Modal, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  ChangeList,
  ChangeSummary,
  diffViewportClass,
  DiffLayoutToggle,
  ExpandAllButton,
  entryFromCommitFile,
  fileCount,
  proposedChangeTimeline,
  splitUnifiedPatch,
  useChangeExpansion,
  type ChangeEntry,
  type DiffLayout,
} from '@/features/changes';
import { useProjectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import {
  ArrowCounterClockwiseIcon,
  CheckIcon,
  FileDashedIcon,
  SparkleIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { formatDistanceToNowStrict } from 'date-fns';
import { useMemo, useState } from 'react';
import type { ChangeRequestRecoveryBlocker, ManifestIssue } from '../change-request-recovery';
import { useProjectContext } from '../context';
import { useChangeRequestRecovery } from '../hooks/use-change-request-recovery';
import {
  useChangeRequest,
  useChangeRequestDiff,
  useChangeRequestMergePreview,
  useCloseChangeRequest,
  useMergeChangeRequest,
  useReopenChangeRequest,
} from '../hooks/use-change-requests';

/**
 * Kept exported under its old name because `change-request-detail-dialog.test.tsx`
 * pins it. The rule itself now lives with the rest of the change vocabulary, so
 * the list component and this test cannot end up asserting different widths.
 */
export const diffRendererViewportClass = diffViewportClass;

const relative = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true });

interface ChangeRequestDetailDialogProps {
  crId: string | null;
  onClose: () => void;
}

export function ChangeRequestDetailDialog({ crId, onClose }: ChangeRequestDetailDialogProps) {
  const open = crId !== null;
  const detailQuery = useChangeRequest(crId);
  const diffQuery = useChangeRequestDiff(crId);
  const previewQuery = useChangeRequestMergePreview(
    crId,
    detailQuery.data?.change_request.status === 'open',
  );

  const projectContext = useProjectContext();
  const projectId = projectContext?.projectId ?? '';
  const defaultBranch = projectContext?.defaultBranch ?? 'main';
  const { version: manifestVersion } = useProjectManifestVersion(projectId);
  const manifestFilename = manifestVersion === 2 ? 'kortix.yaml' : 'kortix.toml';

  const mergeMutation = useMergeChangeRequest();
  const closeMutation = useCloseChangeRequest();
  const reopenMutation = useReopenChangeRequest();
  const { startRecovery, startingCrId } = useChangeRequestRecovery();
  const [layout, setLayout] = useState<DiffLayout>('unified');

  const cr = detailQuery.data?.change_request;
  const diff = diffQuery.data;
  const preview = previewQuery.data;

  // The API hands back one patch for the whole change plus a separate file
  // list; the rows need them zipped. Keyed by the `b/` path, which is what the
  // file list reports — see `splitUnifiedPatch`.
  const entries = useMemo<ChangeEntry[]>(() => {
    if (!diff) return [];
    const patches = splitUnifiedPatch(diff.patch ?? '');
    return diff.files.map((file) => entryFromCommitFile(file, patches.get(file.path)));
  }, [diff]);

  // The dialog is reused between change requests, so expansion must re-seed
  // when the subject changes — see `shouldReseedExpansion`.
  const { expanded, setRow, allExpanded, toggleAll } = useChangeExpansion(entries, crId ?? '');

  // A manifest-blocked apply comes back as 422 / MANIFEST_INVALID with the
  // failing issues in the body. Gate on `variables === crId` so a stale failure
  // from a previously-viewed change (the dialog is reused, not remounted) never
  // bleeds onto the current one.
  const mergeError = mergeMutation.error as
    (Error & { code?: string; data?: { issues?: ManifestIssue[]; conflicts?: string[] } }) | null;
  const isCurrentError = mergeMutation.variables === crId;
  const manifestIssues =
    mergeError?.code === 'MANIFEST_INVALID' && isCurrentError ? (mergeError.data?.issues ?? []) : null;
  const mergeErrorConflicts =
    mergeError?.code === 'MERGE_CONFLICT' && isCurrentError ? (mergeError.data?.conflicts ?? []) : null;

  const previewHasConflicts = Boolean(
    cr?.status === 'open' && preview && !preview.is_up_to_date && !preview.can_merge,
  );
  const conflictPaths = previewHasConflicts ? (preview?.conflicts ?? []) : mergeErrorConflicts;
  const alreadyApplied = Boolean(cr?.status === 'open' && preview?.is_up_to_date);

  const recoveryBlocker: ChangeRequestRecoveryBlocker | null =
    manifestIssues !== null
      ? { kind: 'manifest_invalid', issues: manifestIssues, manifestFilename }
      : conflictPaths !== null
        ? {
            kind: 'merge_conflict',
            conflicts: conflictPaths,
            baseSha: preview?.base_sha,
            headSha: preview?.head_sha,
          }
        : null;
  const isStartingRecovery = startingCrId === crId;

  const handleApply = () => {
    if (!crId) return;
    mergeMutation.mutate(crId, {
      onSuccess: () => successToast('Changes applied'),
      // Recoverable blocks render in the dialog. Everything else stays a toast.
      onError: (err) => {
        const code = (err as { code?: string })?.code;
        if (code !== 'MANIFEST_INVALID' && code !== 'MERGE_CONFLICT') errorToast(err.message);
      },
    });
  };

  const handleFixWithAgent = () => {
    if (!cr || !projectId || !recoveryBlocker || isStartingRecovery) return;
    void startRecovery(
      {
        crId: cr.cr_id,
        number: cr.number,
        title: cr.title,
        headRef: cr.head_ref,
        baseRef: cr.base_ref,
      },
      recoveryBlocker,
      onClose,
    );
  };

  const handleDismiss = () => {
    if (!crId) return;
    closeMutation.mutate(crId, {
      onSuccess: () => successToast('Change dismissed'),
      onError: (err) => errorToast(err.message),
    });
  };

  const handleReopen = () => {
    if (!crId) return;
    reopenMutation.mutate(crId, {
      onSuccess: () => successToast('Change reopened'),
      onError: (err) => errorToast(err.message),
    });
  };

  const blocked = recoveryBlocker !== null;

  return (
    <Modal open={open} onOpenChange={(v) => !v && onClose()}>
      <ModalContent className="flex h-[94dvh] max-h-[94dvh] min-h-0 w-full flex-col gap-0 space-y-0 overflow-hidden p-0 lg:h-[86vh] lg:max-h-[86vh] lg:min-h-[86vh] lg:max-w-3xl">
        {/* ---------------------------------------------------------------
            Header: the title, then one line of context. The proposal number
            and the version it lands in live in that line as plain text —
            they were a mono chip and a branch badge, which gave two facts
            nobody acts on the visual weight of the title itself.
        --------------------------------------------------------------- */}
        <ModalHeader className="flex shrink-0 flex-col space-y-0 border-b px-5 py-4 pr-14">
          {!cr ? (
            <div className="space-y-2">
              <ModalTitle className="sr-only">Proposed change</ModalTitle>
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ) : (
            <>
              <div className="flex min-w-0 items-start gap-2.5">
                <ModalTitle className="text-foreground min-w-0 flex-1 text-base leading-snug font-medium text-balance">
                  {cr.title || 'Untitled change'}
                </ModalTitle>
                {/* An open proposal's state is the two buttons at the bottom.
                    Only a finished one needs a word for what happened to it. */}
                {cr.status !== 'open' && (
                  <Badge
                    variant={cr.status === 'merged' ? 'badgeSuccess' : 'secondary'}
                    size="sm"
                    className="mt-0.5 shrink-0"
                  >
                    {cr.status === 'merged' ? 'Applied' : 'Dismissed'}
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
                <span className="tabular-nums">#{cr.number}</span>
                <span className="text-muted-foreground/40" aria-hidden>
                  &bull;
                </span>
                <span>{proposedChangeTimeline(cr, relative)}</span>
                {/* The destination is worth a line only when it is not the
                    one everything lands in — otherwise it is the same three
                    words on every change, telling the reader nothing. */}
                {cr.base_ref !== defaultBranch && (
                  <>
                    <span className="text-muted-foreground/40" aria-hidden>
                      &bull;
                    </span>
                    <span className="truncate">into {cr.base_ref}</span>
                  </>
                )}
              </p>
            </>
          )}
        </ModalHeader>

        {/* ---------------------------------------------------------------
            Body
        --------------------------------------------------------------- */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="space-y-4 px-5 py-4">
            {/* Problems only. A proposal that can be applied says so by having
                an enabled Apply button — it does not also need a chip. */}
            {manifestIssues !== null && (
              <InfoBanner
                tone="destructive"
                icon={WarningIcon}
                title={`This change breaks ${manifestFilename}, so it can't be applied yet`}
              >
                {manifestIssues.length > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {dedupeIssues(manifestIssues).map(({ key, issue }) => (
                      <li key={key}>
                        {/* The coordinate is mono because it is a literal to
                            find in the file; the message is prose and was set
                            in mono alongside it, which read as machine output
                            rather than a sentence. */}
                        <code className="text-foreground/80 font-mono text-xs break-all">
                          {issue.path}
                        </code>{' '}
                        {issue.message}
                        {issue.line ? ` (line ${issue.line})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span>Ask your agent to fix it.</span>
                )}
              </InfoBanner>
            )}

            {manifestIssues === null && conflictPaths !== null && conflictPaths.length > 0 && (
              <InfoBanner
                tone="warning"
                icon={WarningIcon}
                title={`${fileCount(conflictPaths.length)} changed in both places`}
              >
                <ul className="mt-1 space-y-0.5">
                  {conflictPaths.map((path) => (
                    <li key={path} className="font-mono text-xs break-all">
                      {path}
                    </li>
                  ))}
                </ul>
              </InfoBanner>
            )}

            {alreadyApplied && (
              <InfoBanner tone="neutral" icon={CheckIcon} className="items-center">
                These changes are already in {cr?.base_ref}.
              </InfoBanner>
            )}

            {/* What the person who proposed it wrote. First, unwrapped, at
                reading size — it used to sit inside a card headed "Review
                changes", a label for the screen the reader was already on. */}
            {cr?.description && (
              <div className="text-foreground/90 text-sm wrap-break-word [&_pre]:overflow-x-auto">
                <UnifiedMarkdown content={cr.description} />
              </div>
            )}

            {/* Files */}
            {diffQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-64 w-full rounded-md" />
              </div>
            ) : entries.length > 0 ? (
              <section className="space-y-2">
                <div className="flex items-center gap-2">
                  <ChangeSummary entries={entries} />
                  <div className="ml-auto flex items-center gap-1.5">
                    <ExpandAllButton allExpanded={allExpanded} onToggle={toggleAll} />
                    <DiffLayoutToggle layout={layout} onChange={setLayout} />
                  </div>
                </div>
                <ChangeList
                  entries={entries}
                  layout={layout}
                  expanded={expanded}
                  onRowOpenChange={setRow}
                />
              </section>
            ) : (
              // Upstream's wording for this state, kept: it names the two
              // versions being compared, which a dashed box saying "nothing
              // changed" did not.
              <EmptyState
                size="sm"
                className="py-16"
                icon={FileDashedIcon}
                title="No changes detected"
                description={
                  cr ? `Nothing differs between ${cr.head_ref} and ${cr.base_ref}.` : undefined
                }
              />
            )}
          </div>
        </div>

        {/* ---------------------------------------------------------------
            Footer: the decision. One placement at every width — the old
            dialog put these in the header on desktop and in a sticky bar on
            mobile, so the same two buttons lived in two different places.
        --------------------------------------------------------------- */}
        {cr && cr.status !== 'merged' && (
          <div className="border-border bg-sidebar/95 flex shrink-0 items-center gap-2 border-t px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-sm sm:pb-3">
            {cr.status === 'open' ? (
              <>
                <Button
                  variant="outline-ghost"
                  onClick={handleDismiss}
                  disabled={closeMutation.isPending}
                  className="active:scale-[0.96]"
                >
                  {closeMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
                  Dismiss
                </Button>
                {/* When something blocks the apply, the primary button IS the
                    way out of it. A disabled "Apply changes" beside a banner
                    carrying its own button gave the reader a dead control and a
                    live one for the same problem. */}
                {blocked ? (
                  <Button
                    variant="blue"
                    onClick={handleFixWithAgent}
                    disabled={isStartingRecovery}
                    className="ml-auto min-w-36 active:scale-[0.96]"
                  >
                    {isStartingRecovery ? (
                      <Loading className="size-4 shrink-0" />
                    ) : (
                      <SparkleIcon className="size-4" />
                    )}
                    {isStartingRecovery ? 'Starting…' : 'Fix with agent'}
                  </Button>
                ) : (
                  <Button
                    onClick={handleApply}
                    disabled={mergeMutation.isPending || alreadyApplied}
                    className="ml-auto min-w-36 active:scale-[0.96]"
                  >
                    {mergeMutation.isPending ? (
                      <Loading className="size-4 shrink-0" />
                    ) : (
                      <CheckIcon className="size-4" />
                    )}
                    {mergeMutation.isPending ? 'Applying…' : 'Apply changes'}
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="outline"
                onClick={handleReopen}
                disabled={reopenMutation.isPending}
                className="ml-auto active:scale-[0.96]"
              >
                {reopenMutation.isPending ? (
                  <Loading className="size-4 shrink-0" />
                ) : (
                  <ArrowCounterClockwiseIcon className="size-4" />
                )}
                Reopen
              </Button>
            )}
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}

/**
 * The validator repeats an issue per offending occurrence, so the same
 * `path:line:message` can arrive several times. React needs distinct keys and
 * the reader needs to see the repeat, so suffix duplicates rather than drop them.
 */
function dedupeIssues(issues: ManifestIssue[]): Array<{ key: string; issue: ManifestIssue }> {
  const seen = new Map<string, number>();
  return issues.map((issue) => {
    const base = `${issue.path}:${issue.line ?? ''}:${issue.message}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n ? `${base}#${n}` : base, issue };
  });
}
