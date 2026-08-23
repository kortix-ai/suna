'use client';

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Disclosure,
  DisclosureBody,
  DisclosureContent,
  DisclosureTrigger,
} from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { DiffStat, STATUS_TEXT } from '@/components/ui/status';
import { errorToast, successToast } from '@/components/ui/toast';
import { useProjectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { cn } from '@/lib/utils';
import {
  WarningIcon as AlertTriangle,
  CheckIcon as Check,
  CheckCircleIcon as CheckCircle2,
  CaretDownIcon as ChevronDown,
  ColumnsIcon as Columns2,
  NotePencilIcon as FileEdit,
  GitDiffIcon as FileDiff,
  FilePlusIcon as FilePlus2,
  FileXIcon as FileX2,
  ArrowClockwiseIcon as RefreshCcw,
  ArrowCounterClockwiseIcon as RotateCcw,
  RowsIcon as Rows3,
  SparkleIcon as SparklesSolid,
  XCircleIcon as XCircle,
} from '@phosphor-icons/react';
import { formatDistanceToNowStrict } from 'date-fns';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { ChangeRequestStatus } from '../api/change-requests';
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
import { EmptyState } from '@/features/layout/section/empty-state';
import { DiffRenderer } from './diff-renderer';

function StatusBadge({ status }: { status: ChangeRequestStatus }) {
  const map: Record<
    ChangeRequestStatus,
    { icon: React.ReactNode; label: string; variant: React.ComponentProps<typeof Badge>['variant'] }
  > = {
    open: {
      icon: <FileDiff />,
      label: 'Awaiting review',
      variant: 'badgeSuccess',
    },
    merged: {
      icon: <CheckCircle2 />,
      label: 'Applied',
      variant: 'info',
    },
    closed: {
      icon: <XCircle />,
      label: 'Dismissed',
      variant: 'secondary',
    },
  };
  const m = map[status];
  return (
    <Badge variant={m.variant} size="sm">
      {m.icon}
      {m.label}
    </Badge>
  );
}

function splitUnifiedPatch(patch: string): Array<{ path: string; body: string }> {
  if (!patch.trim()) return [];
  return patch
    .split(/^(?=diff --git )/m)
    .filter((c) => c.trim().length > 0)
    .map((body) => {
      const match = body.match(/^diff --git a\/(?:.*?) b\/(.+?)$/m);
      return { path: match?.[1] ?? '', body };
    });
}

function fileChangeIcon(status: string) {
  if (status === 'added') return <FilePlus2 className={cn('size-3.5', STATUS_TEXT.success)} />;
  if (status === 'deleted') return <FileX2 className={cn('size-3.5', STATUS_TEXT.destructive)} />;
  return <FileEdit className={cn('size-3.5', STATUS_TEXT.info)} />;
}

function fileChangeLabel(status: string) {
  if (status === 'added') return 'Added';
  if (status === 'deleted') return 'Deleted';
  if (status === 'renamed') return 'Renamed';
  if (status === 'copied') return 'Copied';
  if (status === 'typechange') return 'Type changed';
  return 'Modified';
}

function diffSectionId(index: number) {
  return `cr-diff-file-${index}`;
}

export function diffRendererViewportClass(layout: 'unified' | 'split') {
  return layout === 'split' ? 'min-w-[860px] lg:min-w-0' : 'min-w-[680px] sm:min-w-0';
}

function scrollToDiffSection(sectionId: string) {
  requestAnimationFrame(() => {
    const target = document.getElementById(sectionId);
    if (!target) return;

    let scrollParent: HTMLElement | null = target.parentElement;
    while (scrollParent) {
      const { overflowY } = getComputedStyle(scrollParent);
      if (overflowY === 'auto' || overflowY === 'scroll') break;
      scrollParent = scrollParent.parentElement;
    }

    if (scrollParent) {
      const offset =
        target.getBoundingClientRect().top -
        scrollParent.getBoundingClientRect().top +
        scrollParent.scrollTop;
      scrollParent.scrollTo({ top: offset - 12, behavior: 'smooth' });
      return;
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

interface ChangeRequestDetailDialogProps {
  crId: string | null;
  onClose: () => void;
}

export function ChangeRequestDetailDialog({ crId, onClose }: ChangeRequestDetailDialogProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const open = crId !== null;
  const detailQuery = useChangeRequest(crId);
  const diffQuery = useChangeRequestDiff(crId);
  const previewQuery = useChangeRequestMergePreview(
    crId,
    detailQuery.data?.change_request.status === 'open',
  );

  const projectId = useProjectContext()?.projectId ?? '';
  const { version: manifestVersion } = useProjectManifestVersion(projectId);
  const manifestFilename = manifestVersion === 2 ? 'kortix.yaml' : 'kortix.toml';

  const mergeMutation = useMergeChangeRequest();
  const closeMutation = useCloseChangeRequest();
  const reopenMutation = useReopenChangeRequest();
  const { startRecovery, startingCrId } = useChangeRequestRecovery();
  const [diffLayout, setDiffLayout] = useState<'unified' | 'split'>('unified');

  const cr = detailQuery.data?.change_request;
  const diff = diffQuery.data;
  const preview = previewQuery.data;
  const patchChunks = useMemo(
    () => (diff?.patch ? splitUnifiedPatch(diff.patch) : []),
    [diff?.patch],
  );
  const patchChunkByPath = useMemo(
    () => new Map(patchChunks.map((chunk) => [chunk.path, chunk.body])),
    [patchChunks],
  );
  const hasReviewContext = Boolean(
    cr?.description || (cr?.status === 'open' && preview) || cr?.status === 'merged',
  );

  // A manifest-blocked merge comes back as 422 / code MANIFEST_INVALID with the
  // failing issues in the body. Detect it so the dialog can offer "Fix with
  // agent" instead of a dead-end toast.
  // Gate on `variables === crId` so a stale failure from a previously-viewed CR
  // (the dialog is reused, not remounted) never bleeds onto the current one.
  const mergeError = mergeMutation.error as
    (Error & {
        code?: string;
        data?: { issues?: ManifestIssue[]; conflicts?: string[] };
      }) | null;
  const manifestIssues =
    mergeError?.code === 'MANIFEST_INVALID' && mergeMutation.variables === crId
      ? (mergeError.data?.issues ?? [])
      : null;
  const mergeErrorConflicts =
    mergeError?.code === 'MERGE_CONFLICT' && mergeMutation.variables === crId
      ? (mergeError.data?.conflicts ?? [])
      : null;
  const previewHasConflicts = Boolean(
    cr?.status === 'open' && preview && !preview.is_up_to_date && !preview.can_merge,
  );
  const conflictPaths = previewHasConflicts ? (preview?.conflicts ?? []) : mergeErrorConflicts;
  const recoveryBlocker: ChangeRequestRecoveryBlocker | null =
    manifestIssues !== null
      ? {
          kind: 'manifest_invalid',
          issues: manifestIssues,
          manifestFilename,
        }
      : conflictPaths !== null
        ? {
            kind: 'merge_conflict',
            conflicts: conflictPaths,
            baseSha: preview?.base_sha,
            headSha: preview?.head_sha,
          }
        : null;
  const isStartingRecovery = startingCrId === crId;

  const handleMerge = () => {
    if (!crId) return;
    mergeMutation.mutate(crId, {
      onSuccess: () => {
        successToast('Changes applied');
      },
      // Recoverable merge blocks render in the dialog. Everything else stays a toast.
      onError: (err) => {
        const code = (err as { code?: string })?.code;
        if (code !== 'MANIFEST_INVALID' && code !== 'MERGE_CONFLICT') errorToast(err.message);
      },
    });
  };

  const handleSolveWithAgent = () => {
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

  const handleClose = () => {
    if (!crId) return;
    closeMutation.mutate(crId, {
      onSuccess: () => successToast('Proposed change dismissed'),
      onError: (err) => errorToast(err.message),
    });
  };

  const handleReopen = () => {
    if (!crId) return;
    reopenMutation.mutate(crId, {
      onSuccess: () => successToast('Proposed change reopened'),
      onError: (err) => errorToast(err.message),
    });
  };

  const handleFileSelect = (sectionId: string) => {
    scrollToDiffSection(sectionId);
  };

  const renderActions = (placement: 'header' | 'footer') => {
    const isFooter = placement === 'footer';
    const buttonSize = isFooter ? 'default' : 'sm';

    if (cr?.status === 'open') {
      return (
        <div className={cn(isFooter ? 'flex w-full gap-2' : 'flex shrink-0 items-center gap-1.5')}>
          <Button
            variant={isFooter ? 'outline' : 'ghost'}
            size={buttonSize}
            onClick={handleClose}
            disabled={closeMutation.isPending}
            className={cn(isFooter && 'h-10 flex-1')}
          >
            {tI18nHardcoded.raw(
              'autoFeaturesProjectFilesComponentsChangeRequestDetailDialogJsxTexta48f1c83',
            )}
          </Button>
          {recoveryBlocker?.kind === 'merge_conflict' ? (
            <Button
              size={buttonSize}
              variant="blue"
              disabled={isStartingRecovery}
              onClick={handleSolveWithAgent}
              className={cn(isFooter ? 'h-10 flex-[1.15]' : 'min-w-32')}
            >
              {isStartingRecovery ? <Loading /> : <SparklesSolid />}
              {isStartingRecovery ? 'Starting...' : 'Solve with agent'}
            </Button>
          ) : (
            <Button
              size={buttonSize}
              variant="blue"
              disabled={mergeMutation.isPending}
              onClick={handleMerge}
              className={cn(isFooter ? 'h-10 flex-[1.15]' : 'min-w-24')}
            >
              {mergeMutation.isPending ? <Loading /> : <Check />}
              {mergeMutation.isPending ? 'Applying...' : 'Apply'}
            </Button>
          )}
        </div>
      );
    }

    if (cr?.status === 'closed') {
      return (
        <div className={cn(isFooter ? 'flex w-full' : 'flex shrink-0 items-center gap-1.5')}>
          <Button
            variant="outline"
            size={buttonSize}
            onClick={handleReopen}
            disabled={reopenMutation.isPending}
            className={cn(isFooter && 'h-10 w-full')}
          >
            <RotateCcw />
            Reopen
          </Button>
        </div>
      );
    }

    return null;
  };

  const hasFooterActions = cr?.status === 'open' || cr?.status === 'closed';
  const mergeReadiness =
    cr?.status === 'open' && preview
      ? preview.is_up_to_date
        ? {
            icon: RefreshCcw,
            label: 'Up to date',
            variant: 'info' as const,
          }
        : preview.can_merge
          ? {
              icon: Check,
              label: 'Ready to apply',
              variant: 'badgeSuccess' as const,
            }
          : null
      : null;
  const MergeReadinessIcon = mergeReadiness?.icon;

  return (
    <Modal open={open} onOpenChange={(v) => !v && onClose()}>
      <ModalContent
        className="flex h-[94dvh] max-h-[94dvh] min-h-0 w-full flex-col gap-0 space-y-0 overflow-hidden p-0 lg:h-[88vh] lg:max-h-[88vh] lg:min-h-[88vh] lg:max-w-6xl"
        showCloseButton={false}
      >
        <ModalHeader className="flex shrink-0 flex-row items-start space-y-0 border-b px-4 py-3 sm:px-5 sm:py-4">
          <div className="min-w-0 flex-1">
            {!cr ? (
              <div className="space-y-1.5">
                <ModalTitle className="sr-only">
                  {tI18nHardcoded.raw(
                    'autoFeaturesProjectFilesComponentsChangeRequestDetailDialogJsxText9f1f82e8',
                  )}
                </ModalTitle>
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ) : (
              <>
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                  <ModalTitle className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-tight font-medium sm:flex-none">
                    <span className="text-muted-foreground shrink-0 font-mono text-sm tabular-nums">
                      #{cr.number}
                    </span>
                    <span className="line-clamp-2 min-w-0 wrap-break-word">{cr.title}</span>
                  </ModalTitle>
                  <StatusBadge status={cr.status} />
                </div>
                <div className="text-muted-foreground mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                  <span>
                    proposed{' '}
                    {formatDistanceToNowStrict(new Date(cr.created_at), { addSuffix: true })}
                  </span>
                  <span className="text-muted-foreground/40" aria-hidden>
                    {'·'}
                  </span>
                  <span className="shrink-0">into</span>
                  <Badge variant="kortix" size="xs" className="max-w-[10rem] truncate">
                    {cr.base_ref}
                  </Badge>
                </div>
              </>
            )}
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            {renderActions('header')}
          </div>
        </ModalHeader>

        {manifestIssues !== null && (
          <div className="border-border shrink-0 border-b px-4 py-3 sm:px-5">
            <InfoBanner
              tone="destructive"
              icon={AlertTriangle}
              title="Project config check failed, so this change can't be applied yet"
              action={
                <Button
                  size="sm"
                  variant="blue"
                  disabled={isStartingRecovery}
                  onClick={handleSolveWithAgent}
                >
                  {isStartingRecovery ? <Loading /> : <SparklesSolid />}
                  Fix with agent
                </Button>
              }
            >
              {manifestIssues.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs [&_li]:break-all">
                  {(() => {
                    const seen = new Map<string, number>();
                    return manifestIssues.map((issue) => {
                      const base = `${issue.path}:${issue.line ?? ''}:${issue.message}`;
                      const n = seen.get(base) ?? 0;
                      seen.set(base, n + 1);
                      return (
                        <li key={n ? `${base}#${n}` : base}>
                          {issue.path}: {issue.message}
                          {issue.line ? ` (line ${issue.line})` : ''}
                        </li>
                      );
                    });
                  })()}
                </ul>
              ) : (
                <span>
                  {manifestFilename} in this change doesn't pass validation. Start a session to fix
                  it.
                </span>
              )}
            </InfoBanner>
          </div>
        )}

        <ModalBody className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-0 lg:flex lg:flex-col lg:overflow-hidden">
          {diffQuery.isLoading ? (
            <div className="grid min-h-full lg:min-h-0 lg:flex-1 lg:grid-cols-[270px_minmax(0,1fr)]">
              <div className="border-border/60 space-y-2 border-b p-3 sm:p-4 lg:border-r lg:border-b-0">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
                <div className="space-y-1.5 pt-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full rounded-md" />
                  ))}
                </div>
              </div>
              <div className="space-y-3 p-3 sm:p-4 lg:p-5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-64 w-full rounded-md" />
              </div>
            </div>
          ) : diff && diff.files.length > 0 ? (
            <div className="grid min-h-full grid-rows-[auto_minmax(0,1fr)] lg:min-h-0 lg:flex-1 lg:grid-cols-[270px_minmax(0,1fr)]">
              <aside className="border-border/60 bg-background flex flex-col gap-3 border-b p-3 sm:p-4 lg:h-full lg:min-h-0 lg:border-r lg:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-foreground text-sm font-medium">
                      {tI18nHardcoded.raw(
                        'autoFeaturesProjectFilesComponentsChangeRequestDetailDialogJsxText7ba43c2e',
                      )}
                    </h3>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">
                      into {diff.base_ref}
                    </p>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {diff.files.length}
                  </span>
                </div>

                <div className="border-border/60 border-t pt-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {tI18nHardcoded.raw(
                        'autoFeaturesProjectFilesComponentsChangeRequestDetailDialogJsxText561449ba',
                      )}
                    </span>
                    <DiffStat
                      additions={diff.additions}
                      deletions={diff.deletions}
                      className="text-xs"
                    />
                  </div>
                </div>

                <div className="bg-muted/40 flex items-center gap-0.5 rounded-md p-0.5">
                  <Hint label="Inline (unified) diff">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDiffLayout('unified')}
                      aria-pressed={diffLayout === 'unified'}
                      className={cn(
                        'h-7 flex-1 gap-1.5 rounded-sm',
                        diffLayout === 'unified' && 'bg-background text-foreground shadow-2xs',
                      )}
                    >
                      <Rows3 className="size-3.5" />
                      Unified
                    </Button>
                  </Hint>
                  <Hint label="Side-by-side (split) diff">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDiffLayout('split')}
                      aria-pressed={diffLayout === 'split'}
                      className={cn(
                        'h-7 flex-1 gap-1.5 rounded-sm',
                        diffLayout === 'split' && 'bg-background text-foreground shadow-2xs',
                      )}
                    >
                      <Columns2 className="size-3.5" />
                      Split
                    </Button>
                  </Hint>
                </div>

                <div className="lg:hidden">
                  <Select onValueChange={handleFileSelect}>
                    <SelectTrigger className="h-10 w-full justify-between">
                      <SelectValue
                        placeholder={tI18nHardcoded.raw(
                          'autoFeaturesProjectFilesComponentsChangeRequestDetailDialogJsxAttr29624185',
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent className="z-[10001] max-w-[calc(100vw-2rem)]">
                      {diff.files.map((file, index) => {
                        const sectionId = diffSectionId(index);

                        return (
                          <SelectItem key={file.path} value={sectionId}>
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="min-w-0">
                                <span className="block truncate font-mono text-xs">
                                  {file.path}
                                </span>
                                <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[11px]">
                                  {fileChangeLabel(file.status)}
                                  <DiffStat additions={file.additions} deletions={file.deletions} />
                                </span>
                              </span>
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>

                <nav className="hidden lg:mx-0 lg:block lg:min-h-0 lg:flex-1 lg:space-y-1 lg:overflow-x-visible lg:overflow-y-auto lg:px-0 lg:pb-0">
                  {diff.files.map((file, index) => (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => scrollToDiffSection(diffSectionId(index))}
                      className="hover:bg-secondary focus-visible:bg-muted/70 grid max-w-[16rem] min-w-[13rem] shrink-0 grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-md px-2 py-2 text-left transition-colors duration-150 ease-out focus-visible:outline-none lg:max-w-none lg:min-w-0 lg:shrink"
                    >
                      <span className="mt-0.5">{fileChangeIcon(file.status)}</span>
                      <span className="min-w-0">
                        <span className="text-foreground block truncate font-mono text-xs">
                          {file.path}
                        </span>
                        <span className="text-muted-foreground mt-0.5 flex items-center justify-between gap-2 text-[11px]">
                          <span>{fileChangeLabel(file.status)}</span>
                          <DiffStat
                            additions={file.additions}
                            deletions={file.deletions}
                            className="shrink-0"
                          />
                        </span>
                      </span>
                    </button>
                  ))}
                </nav>
              </aside>

              <section className="min-w-0 space-y-3 p-3 pb-5 sm:space-y-4 sm:p-4 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:p-5">
                {hasReviewContext && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-foreground text-sm font-medium">
                          {tI18nHardcoded.raw(
                            'autoFeaturesProjectFilesComponentsChangeRequestDetailDialogJsxTexte014913b',
                          )}
                        </div>
                      </div>
                      {mergeReadiness && (
                        <Badge
                          variant={mergeReadiness.variant}
                          size="sm"
                          className="ml-auto shrink-0"
                        >
                          {MergeReadinessIcon && <MergeReadinessIcon />}
                          {mergeReadiness.label}
                        </Badge>
                      )}
                    </div>
                    <div className="space-y-2.5">
                      {cr?.description && (
                        <div className="text-muted-foreground text-sm wrap-break-word [&_pre]:overflow-x-auto">
                          <UnifiedMarkdown content={cr.description} />
                        </div>
                      )}

                      {cr?.status === 'open' &&
                        preview &&
                        !preview.is_up_to_date &&
                        !preview.can_merge && (
                          <InfoBanner
                            tone="warning"
                            icon={AlertTriangle}
                            className="px-3 py-2 [&_li]:break-all"
                            action={
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={isStartingRecovery}
                                onClick={handleSolveWithAgent}
                              >
                                {isStartingRecovery ? <Loading /> : <SparklesSolid />}
                                Solve with agent
                              </Button>
                            }
                            title={
                              <>
                                {tHardcodedUi.raw(
                                  'featuresProjectFilesComponentsChangeRequestDetailDialog.line283JsxTextConflictsIn',
                                )}{' '}
                                {preview.conflicts.length} file
                                {preview.conflicts.length === 1 ? '' : 's'}
                              </>
                            }
                          >
                            <ul className="mt-1 list-disc pl-5 font-mono">
                              {preview.conflicts.map((path) => (
                                <li key={path}>{path}</li>
                              ))}
                            </ul>
                          </InfoBanner>
                        )}

                      {cr?.status === 'merged' && (
                        <InfoBanner
                          tone="neutral"
                          icon={CheckCircle2}
                          className="items-center px-3 py-2"
                        >
                          Applied
                          {cr.merged_at && (
                            <>
                              {' '}
                              {formatDistanceToNowStrict(new Date(cr.merged_at), {
                                addSuffix: true,
                              })}
                            </>
                          )}
                        </InfoBanner>
                      )}
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  {diff.files.map((file, index) => {
                    const patch = patchChunkByPath.get(file.path);

                    return (
                      <div
                        id={diffSectionId(index)}
                        key={file.path}
                        className="scroll-mt-3 lg:scroll-mt-5"
                      >
                        <Disclosure
                          open
                          className="group/file overflow-hidden rounded-md border"
                          transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                        >
                          <DisclosureTrigger>
                            <Button
                              variant="secondary"
                              className="h-auto min-h-10 w-full items-start justify-between px-3 py-2 text-left sm:items-center"
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                {fileChangeIcon(file.status)}
                                <div className="min-w-0">
                                  <h4 className="text-foreground truncate font-mono text-xs font-medium">
                                    {file.path}
                                  </h4>
                                  {file.old_path && file.old_path !== file.path && (
                                    <p className="text-muted-foreground mt-0.5 truncate font-mono text-[11px]">
                                      from {file.old_path}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                                <span className="text-muted-foreground hidden text-xs sm:inline">
                                  {fileChangeLabel(file.status)}
                                </span>
                                <DiffStat
                                  additions={file.additions}
                                  deletions={file.deletions}
                                  className="text-xs"
                                />
                                <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/file:rotate-180" />
                              </div>
                            </Button>
                          </DisclosureTrigger>
                          <DisclosureContent className="max-w-full overflow-hidden">
                            <DisclosureBody className="border-t">
                              {patch ? (
                                <div className="max-w-full overflow-x-auto">
                                  <DiffRenderer
                                    patch={patch}
                                    layout={diffLayout}
                                    className={diffRendererViewportClass(diffLayout)}
                                  />
                                </div>
                              ) : (
                                <div className="text-muted-foreground px-3 py-6 text-center text-xs">
                                  {tI18nHardcoded.raw(
                                    'autoFeaturesProjectFilesComponentsChangeRequestDetailDialogJsxTextec240dc2',
                                  )}
                                </div>
                              )}
                            </DisclosureBody>
                          </DisclosureContent>
                        </Disclosure>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : (
            <EmptyState
              size="sm"
              className="py-16"
              icon={FileDiff}
              title="No changes detected"
              description={
                cr ? `Nothing differs between ${cr.head_ref} and ${cr.base_ref}.` : undefined
              }
            />
          )}
        </ModalBody>

        {hasFooterActions && (
          <div className="border-border bg-sidebar/95 shrink-0 border-t p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-sm sm:hidden">
            {renderActions('footer')}
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}
