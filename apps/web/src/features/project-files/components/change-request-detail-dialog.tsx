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
import { cn } from '@/lib/utils';
import { formatDistanceToNowStrict } from 'date-fns';
import { DangerTriangle as AlertTriangle, Check, ChevronDown, Columns as Columns2, File as FileEdit, FilePlus as FilePlus2, FileX as FileX2, GitBranch, GitMerge, GitPullRequest, GitPullRequest as GitPullRequestClosed, Refresh as RefreshCcw, Refresh as RotateCcw, Rows as Rows3 } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { ChangeRequestStatus } from '../api/change-requests';
import {
  useChangeRequest,
  useChangeRequestDiff,
  useChangeRequestMergePreview,
  useCloseChangeRequest,
  useMergeChangeRequest,
  useReopenChangeRequest,
} from '../hooks/use-change-requests';
import { DiffRenderer } from './diff-renderer';

function StatusBadge({ status }: { status: ChangeRequestStatus }) {
  const map: Record<
    ChangeRequestStatus,
    { icon: React.ReactNode; label: string; variant: React.ComponentProps<typeof Badge>['variant'] }
  > = {
    open: {
      icon: <GitPullRequest />,
      label: 'Open',
      variant: 'badgeSuccess',
    },
    merged: {
      icon: <GitMerge />,
      label: 'Merged',
      variant: 'info',
    },
    closed: {
      icon: <GitPullRequestClosed />,
      label: 'Closed',
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

  const mergeMutation = useMergeChangeRequest();
  const closeMutation = useCloseChangeRequest();
  const reopenMutation = useReopenChangeRequest();
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

  const handleMerge = () => {
    if (!crId) return;
    mergeMutation.mutate(crId, {
      onSuccess: (res) => {
        successToast(
          res.merge.fast_forward
            ? 'Merged (fast-forward)'
            : `Merged ${res.merge.merge_commit_sha.slice(0, 7)}`,
        );
      },
      onError: (err) => errorToast(err.message),
    });
  };

  const handleClose = () => {
    if (!crId) return;
    closeMutation.mutate(crId, {
      onSuccess: () => successToast('Change request closed'),
      onError: (err) => errorToast(err.message),
    });
  };

  const handleReopen = () => {
    if (!crId) return;
    reopenMutation.mutate(crId, {
      onSuccess: () => successToast('Change request reopened'),
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
          <Button
            size={buttonSize}
            variant="blue"
            disabled={mergeMutation.isPending || preview?.can_merge === false}
            onClick={handleMerge}
            className={cn(isFooter ? 'h-10 flex-[1.15]' : 'min-w-24')}
          >
            {mergeMutation.isPending ? <Loading /> : <GitMerge />}
            {mergeMutation.isPending ? 'Merging...' : 'Merge'}
          </Button>
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
              label: preview.can_fast_forward ? 'Fast-forward' : 'Mergeable',
              variant: 'badgeSuccess' as const,
            }
          : null
      : null;
  const MergeReadinessIcon = mergeReadiness?.icon;

  return (
    <Modal open={open} onOpenChange={(v) => !v && onClose()}>
      <ModalContent
        className="flex h-[94dvh] max-h-[94dvh] min-h-0 w-full max-w-4xl flex-col gap-0 space-y-0 overflow-hidden p-0 lg:h-[88vh] lg:max-h-[88vh] lg:min-h-[88vh] lg:max-w-6xl"
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
                    <span className="line-clamp-2 min-w-0 break-words">{cr.title}</span>
                  </ModalTitle>
                  <StatusBadge status={cr.status} />
                </div>
                <div className="text-muted-foreground mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="max-w-[10rem] truncate font-mono sm:max-w-none">
                    {cr.head_ref}
                  </span>
                  <span className="text-muted-foreground/60">→</span>
                  {cr.base_ref === 'main' ? (
                    <Badge variant="kortix" size="xs">
                      {cr.base_ref.slice(0, 7)}
                    </Badge>
                  ) : (
                    <span className="font-mono">{cr.base_ref}</span>
                  )}
                  <span className="text-muted-foreground/40" aria-hidden>
                    {'·'}
                  </span>
                  <span>
                    opened {formatDistanceToNowStrict(new Date(cr.created_at), { addSuffix: true })}
                  </span>
                  {cr.head_commit_sha && (
                    <>
                      <span className="text-muted-foreground/40" aria-hidden>
                        {'·'}
                      </span>
                      <span className="font-mono">{cr.head_commit_sha.slice(0, 7)}</span>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            {renderActions('header')}
          </div>
        </ModalHeader>

        <ModalBody className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-0 lg:flex lg:flex-col lg:overflow-hidden">
          {diffQuery.isLoading ? (
            <div className="grid gap-3 p-3 sm:gap-4 sm:p-5 lg:grid-cols-[270px_minmax(0,1fr)]">
              <Skeleton className="h-40 w-full rounded-lg lg:h-72" />
              <div className="space-y-3">
                <Skeleton className="h-24 w-full rounded-lg" />
                <Skeleton className="h-96 w-full rounded-lg" />
              </div>
            </div>
          ) : diff && diff.files.length > 0 ? (
            <div className="grid min-h-full grid-rows-[auto_minmax(0,1fr)] lg:min-h-0 lg:flex-1 lg:grid-cols-[270px_minmax(0,1fr)]">
              <aside className="border-border bg-background flex flex-col gap-3 border-b p-3 sm:p-4 lg:h-full lg:min-h-0 lg:border-r lg:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-foreground text-sm font-medium">
                      {tI18nHardcoded.raw(
                        'autoFeaturesProjectFilesComponentsChangeRequestDetailDialogJsxText7ba43c2e',
                      )}
                    </h3>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">
                      {diff.head_ref.slice(0, 7)} into {diff.base_ref}
                    </p>
                  </div>
                  <span className="bg-muted text-muted-foreground shrink-0 rounded-md px-2 py-1 text-xs font-medium tabular-nums">
                    {diff.files.length}
                  </span>
                </div>

                <div className="border-border bg-card rounded-md border px-3 py-2">
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

                <div className="bg-card flex items-center gap-1 rounded-full border p-0.5">
                  <Hint label="Inline (unified) diff">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDiffLayout('unified')}
                      aria-pressed={diffLayout === 'unified'}
                      className={cn(
                        'h-7 flex-1 gap-1.5 rounded-full',
                        diffLayout === 'unified' && 'bg-primary/10 text-primary',
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
                        'h-7 flex-1 gap-1.5 rounded-full',
                        diffLayout === 'split' && 'bg-primary/10 text-primary',
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
                  <div className="border-border bg-background overflow-hidden rounded-lg border">
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
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
                    <div className="border-border space-y-2.5 border-t p-3">
                      {cr?.description && (
                        <div className="text-muted-foreground text-sm break-words [&_pre]:overflow-x-auto">
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
                          icon={GitMerge}
                          className="items-center px-3 py-2"
                        >
                          Merged
                          {cr.merge_commit_sha && (
                            <>
                              {' as '}
                              <span className="font-mono">{cr.merge_commit_sha.slice(0, 7)}</span>
                            </>
                          )}
                          {cr.merged_at && (
                            <>
                              {' · '}
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
            <div className="p-5">
              <p className="border-border text-muted-foreground bg-background rounded-lg border border-dashed p-5 text-center text-xs">
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsChangeRequestDetailDialog.line356JsxTextNoChangesDetected',
                )}
              </p>
            </div>
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
