'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { usePublicShareLink } from '@/hooks/use-public-share-link';
import {
  publicShareUrl,
  useRevokePublicShare,
  useSessionPublicShares,
} from '@/hooks/use-session-public-shares';
import { useTranslations } from '@/i18n/use-translations';
import { findActiveTranscriptShare, type CreateSessionPublicShareInput } from '@kortix/sdk';
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CopyIcon,
  DotsThreeIcon,
  GlobeIcon,
  PlusIcon,
  ProhibitIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

// Module-level so `usePublicShareLink` sees one stable input object.
const TRANSCRIPT_SHARE_INPUT: CreateSessionPublicShareInput = { transcript: true };

/**
 * "Public link" in the Share panel: a read-only, sign-in-free link to this
 * session's conversation. One live link per session (the API returns the
 * existing one on a second create), so the row shows either that link with
 * Copy and a ⋯ menu, or the one button that creates it.
 *
 * Both decisions confirm in place — the row swaps to the question and its two
 * buttons — instead of stacking a dialog on the popover that hosts it: minting
 * hands out an anonymous credential, revoking breaks every copy of the URL.
 */
export function SessionPublicLinkRow({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const t = useTranslations('hardcodedUi.publicTranscriptShare');
  const tConfirm = useTranslations('hardcodedUi.publicShareConfirm');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { shares, isLoading, isError } = useSessionPublicShares(projectId, sessionId);
  const link = usePublicShareLink({ projectId, sessionId, input: TRANSCRIPT_SHARE_INPUT });
  const { revoke, revokingId } = useRevokePublicShare(projectId, sessionId);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const active = findActiveTranscriptShare(shares);
  const url = active ? publicShareUrl(active.public_path) : null;
  const isRevoking = !!active && revokingId === active.share_id;

  // The check on the button is the feedback; a toast on top of it would say
  // the same thing twice.
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      errorToast(tI18nComplete.raw('text167c96824acb'));
    }
  };

  if (link.confirmation.open) {
    return (
      <ConfirmRow
        title={tConfirm.raw('title')}
        description={tConfirm.raw('description')}
        onCancel={() => link.confirmation.onOpenChange(false)}
        onConfirm={link.confirmation.onConfirm}
        confirmLabel={tConfirm.raw('confirm')}
        pending={link.confirmation.isPending}
      />
    );
  }

  if (confirmRevoke && active) {
    return (
      <ConfirmRow
        title={tI18nComplete.raw('text3d3b295854fe')}
        description={t('revokeDescription')}
        onCancel={() => setConfirmRevoke(false)}
        onConfirm={() => {
          revoke(active.share_id);
          setConfirmRevoke(false);
        }}
        confirmLabel={tI18nComplete.raw('text87e6d00bbf53')}
        destructive
      />
    );
  }

  return (
    <Row
      live={!!active}
      title={
        <>
          {t('sectionTitle')}
          {active ? (
            <Badge variant="solid" size="xs" className="bg-kortix-green/15 text-kortix-green">
              Live
            </Badge>
          ) : null}
        </>
      }
      description={
        isError
          ? // The list 403s for a member who is neither the session's creator
            // nor a project manager. "Create" would show a state we cannot read.
            tI18nComplete.raw('text93bce1d8f18d')
          : (url ?? t('sectionDescription'))
      }
    >
      {isLoading ? (
        <Loading className="size-4 shrink-0" />
      ) : isError ? null : active ? (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={!url}
            aria-label={tI18nComplete.raw('textdbf362d4f210')}
            onClick={() => void copy()}
            className="active:scale-[0.96]"
          >
            {copied ? (
              <CheckIcon className="text-kortix-green size-4 shrink-0" />
            ) : (
              <CopyIcon className="size-4 shrink-0" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Public link options">
                {isRevoking ? (
                  <Loading className="size-4 shrink-0" />
                ) : (
                  <DotsThreeIcon className="size-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild disabled={!url}>
                <a href={url ?? undefined} target="_blank" rel="noreferrer">
                  <ArrowSquareOutIcon />
                  Open public page
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={isRevoking}
                onSelect={() => setConfirmRevoke(true)}
              >
                <ProhibitIcon />
                {tI18nComplete.raw('text87e6d00bbf53')}…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={link.copyLink}
          disabled={!link.canShare}
          className="active:scale-[0.96]"
        >
          <PlusIcon className="size-3.5 shrink-0" />
          {t('create')}
        </Button>
      )}
    </Row>
  );
}

function Row({
  live = false,
  title,
  description,
  children,
}: {
  live?: boolean;
  title: ReactNode;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-3 border-t py-3 pr-3 pl-4"
      data-testid="session-public-link"
    >
      <GlobeIcon
        className={
          live ? 'text-foreground size-4 shrink-0' : 'text-muted-foreground size-4 shrink-0'
        }
      />
      <div className="min-w-0 flex-1">
        <div className="text-foreground flex items-center gap-1.5 text-sm font-medium">{title}</div>
        <p className="text-muted-foreground truncate text-xs">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

/** The inline two-step confirm (the `channels-view.tsx` disconnect pattern). */
function ConfirmRow({
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
  pending = false,
  destructive = false,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending?: boolean;
  destructive?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={title}
      className="space-y-2.5 border-t py-3 pr-3 pl-4"
      data-testid="session-public-link"
    >
      <div className="flex gap-3">
        <GlobeIcon className="text-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'default'}
          size="sm"
          onClick={onConfirm}
          disabled={pending}
          autoFocus
        >
          {pending ? <Loading className="size-4 shrink-0" /> : null}
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
