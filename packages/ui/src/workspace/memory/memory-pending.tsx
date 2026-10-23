'use client';

import { ApiError, type ProjectMemoryPage, type ProjectMemoryPageSummary } from '@kortix/sdk';
import { useConfirmProjectMemoryPage, useDeleteProjectMemoryPage, useProjectMemoryPage } from '@kortix/sdk/react';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { InfoBanner } from '../../primitives/info-banner';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { errorToast, successToast, undoToast } from '../../primitives/toast';
import { linkHost } from '../spaces/space-link-label';
import { useUndoMemoryChange } from './memory-recent-change';

const URL_RE = /https?:\/\/[^\s<>()"'⟦⟧]+/;

/**
 * Where an unconfirmed page's outside content came from: the host of its
 * `outside` source, else of the first web address in its text. Null when
 * neither names one.
 */
export function pendingHost(page: Pick<ProjectMemoryPage, 'sources' | 'body'>): string | null {
  const url = page.sources.find((source) => source.kind === 'outside' && source.url)?.url ?? page.body.match(URL_RE)?.[0];
  return url ? linkHost(url) : null;
}

/**
 * Confirm and Discard for an unconfirmed page, with their toasts. `mutateAsync`,
 * not call-time `mutate` callbacks: the row that called may unmount when the
 * list refetches, and TanStack drops an unmounted caller's callbacks.
 */
function usePendingActions(projectId: string) {
  const t = useTranslations('spaces.memory');
  const confirm = useConfirmProjectMemoryPage(projectId);
  const discard = useDeleteProjectMemoryPage(projectId);
  const undo = useUndoMemoryChange(projectId);
  return {
    busy: confirm.isPending || discard.isPending,
    /** `onDone` gets the page that holds the content now (a "(to confirm)" page merges into its page). */
    confirm: (pageId: string, onDone?: (pageId: string) => void) =>
      confirm.mutateAsync(pageId).then(
        (page) => {
          successToast(t('pending.confirmed'));
          onDone?.(page.page_id);
        },
        (err: unknown) =>
          errorToast(err instanceof ApiError && err.code === 'not_unconfirmed' ? t('pending.alreadyConfirmed') : t('pending.confirmFailed')),
      ),
    discard: (pageId: string, onDone?: () => void) =>
      discard.mutateAsync(pageId).then(
        ({ version_id }) => {
          onDone?.();
          undoToast(t('pending.discarded'), { undoLabel: t('undo'), onUndo: () => undo.run(version_id) });
        },
        () => errorToast(t('pending.discardFailed')),
      ),
  };
}

/** Discard asks first, in place: the button turns into Cancel · Discard. */
function DiscardButton({ disabled, onDiscard, title }: { disabled: boolean; onDiscard: () => void; title: string }) {
  const t = useTranslations('spaces.memory');
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button
        variant="ghost"
        size="toolbar"
        className="text-muted-foreground"
        disabled={disabled}
        aria-label={t('pending.discardPage', { title })}
        onClick={() => setAsking(true)}
      >
        {t('pending.discard')}
      </Button>
    );
  }
  return (
    <>
      <Button variant="ghost" size="toolbar" className="text-muted-foreground" onClick={() => setAsking(false)}>
        {t('pending.cancel')}
      </Button>
      <Button
        variant="destructive"
        size="toolbar"
        disabled={disabled}
        aria-label={t('pending.discardPage', { title })}
        onClick={() => {
          setAsking(false);
          onDiscard();
        }}
      >
        {t('pending.discard')}
      </Button>
    </>
  );
}

/**
 * "Needs confirming" at the bottom of the page list: the layer's pages with
 * outside content (a web page, an email, a file). The list opens above it:
 * each page with the host it came from, Confirm and Discard.
 */
export function NeedsConfirming({
  projectId,
  pages,
  canWrite,
  selectedId,
  onSelect,
  onRemoved,
}: {
  projectId: string;
  /** The layer's unconfirmed pages, newest first. */
  pages: readonly ProjectMemoryPageSummary[];
  canWrite: boolean;
  selectedId: string | null;
  onSelect: (pageId: string) => void;
  /** A page was discarded. */
  onRemoved: (pageId: string) => void;
}) {
  const t = useTranslations('spaces.memory');
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="focus-visible:ring-ring bg-kortix-orange/15 text-foreground flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-xs outline-none focus-visible:ring-2"
        >
          <span className="flex w-4 shrink-0 justify-center">
            <WarningCircleIcon aria-hidden className="text-kortix-orange size-3.5" />
          </span>
          <span className="flex-1 truncate">{t('needsConfirming')}</span>
          <CountBadge count={pages.length} tone="conflict" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex max-h-120 w-96 flex-col gap-1 p-1.5">
        <div className="flex flex-col gap-0.5 px-2 pt-1 pb-1">
          <p className="text-xs font-medium">{t('needsConfirming')}</p>
          <p className="text-muted-foreground text-xs">{t('pending.note')}</p>
        </div>
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {pages.map((page) => (
            <PendingRow
              key={page.page_id}
              projectId={projectId}
              page={page}
              canWrite={canWrite}
              selected={page.page_id === selectedId}
              onOpen={() => {
                setOpen(false);
                onSelect(page.page_id);
              }}
              onConfirmed={(pageId) => {
                if (pages.length === 1) setOpen(false);
                if (page.page_id === selectedId) onSelect(pageId);
              }}
              onRemoved={() => {
                if (pages.length === 1) setOpen(false);
                onRemoved(page.page_id);
              }}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function PendingRow({
  projectId,
  page,
  canWrite,
  selected,
  onOpen,
  onConfirmed,
  onRemoved,
}: {
  projectId: string;
  page: ProjectMemoryPageSummary;
  canWrite: boolean;
  selected: boolean;
  onOpen: () => void;
  onConfirmed: (pageId: string) => void;
  onRemoved: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const locale = useLocale();
  // The host lives in the page's sources: one read per row, only while the list is open.
  const full = useProjectMemoryPage(projectId, page.page_id);
  const host = full.data ? pendingHost(full.data) : null;
  const actions = usePendingActions(projectId);
  return (
    <li className={cn('flex items-start gap-2.5 rounded-md px-2 py-2', selected && 'bg-active')}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          className="focus-visible:ring-ring truncate rounded-sm text-left text-xs font-medium outline-none hover:underline focus-visible:ring-2"
        >
          {page.title}
        </button>
        <p className="text-muted-foreground truncate text-xs">
          {[host ? t('pending.from', { host }) : null, relativeTime(page.updated_at, locale)].filter(Boolean).join(' · ')}
        </p>
      </div>
      {canWrite ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="toolbar"
            disabled={actions.busy}
            aria-busy={actions.busy || undefined}
            aria-label={t('pending.confirmPage', { title: page.title })}
            onClick={() => void actions.confirm(page.page_id, onConfirmed)}
          >
            {t('pending.confirm')}
          </Button>
          <DiscardButton disabled={actions.busy} title={page.title} onDiscard={() => void actions.discard(page.page_id, onRemoved)} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The reader's banner on an unconfirmed page: "From <host>. Agents do not use
 * this until someone confirms it." with Confirm and Discard for a writer.
 */
export function PendingBanner({
  projectId,
  page,
  onConfirmed,
  onRemoved,
}: {
  projectId: string;
  page: ProjectMemoryPage;
  onConfirmed: (pageId: string) => void;
  onRemoved: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const actions = usePendingActions(projectId);
  const host = pendingHost(page);
  return (
    <InfoBanner
      tone="warning"
      icon={WarningCircleIcon}
      className="max-w-3xl"
      action={
        page.can_edit || page.can_delete ? (
          <div className="flex items-center gap-0.5">
            {page.can_edit ? (
              <Button
                variant="ghost"
                size="toolbar"
                disabled={actions.busy}
                aria-busy={actions.busy || undefined}
                onClick={() => void actions.confirm(page.page_id, onConfirmed)}
              >
                {t('pending.confirm')}
              </Button>
            ) : null}
            {page.can_delete ? (
              <DiscardButton disabled={actions.busy} title={page.title} onDiscard={() => void actions.discard(page.page_id, onRemoved)} />
            ) : null}
          </div>
        ) : null
      }
    >
      {host ? t('pending.banner', { host }) : t('pending.bannerNoHost')}
    </InfoBanner>
  );
}
