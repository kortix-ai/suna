'use client';

import { PublicShareLinkConfirm } from '@/components/projects/public-share-link-confirm';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { usePublicShareLink } from '@/hooks/use-public-share-link';
import {
  embedChatUrl,
  publicShareUrl,
  useRevokePublicShare,
  useSessionPublicShares,
} from '@/hooks/use-session-public-shares';
import { useTranslations } from '@/i18n/use-translations';
import { findActiveTranscriptShare, type CreateSessionPublicShareInput } from '@kortix/sdk';
import { CheckIcon, CodeIcon, CopyIcon, LinkSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

// Module-level so `usePublicShareLink` sees one stable input object.
const TRANSCRIPT_SHARE_INPUT: CreateSessionPublicShareInput = { transcript: true };

/**
 * "Public link" in the Share dialog: a read-only, sign-in-free link to this
 * session's conversation. One live link per session (the API returns the
 * existing one on a second create), so the section shows either that link with
 * Copy and Revoke, or the one button that creates it.
 *
 * Mounted inside `ModalContent`, so the share list is read only while the
 * dialog is open.
 */
export function SessionPublicLinkSection({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const t = useTranslations('hardcodedUi.publicTranscriptShare');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { shares, isLoading, isError } = useSessionPublicShares(projectId, sessionId);
  const link = usePublicShareLink({ projectId, sessionId, input: TRANSCRIPT_SHARE_INPUT });
  const { revoke, revokingId } = useRevokePublicShare(projectId, sessionId);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [copied, setCopied] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  // One timer per flag: each copied check resets on its own clock, so copying
  // the other button never cancels its reset.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const embedCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (embedCopiedTimer.current) clearTimeout(embedCopiedTimer.current);
    },
    [],
  );

  const active = findActiveTranscriptShare(shares);
  const url = active ? publicShareUrl(active.public_path) : null;
  // The embed snippet a host page pastes. Same token, widget route, card
  // layout: the token is the capability on both routes, so nothing new is
  // minted or authorized here.
  const embedUrl = active ? embedChatUrl(active.public_path) : null;
  const embedSnippet = embedUrl
    ? `<iframe src="${embedUrl}" style="height:640px;width:100%;border:0;border-radius:12px" title="Kortix" loading="lazy"></iframe>`
    : null;
  const isRevoking = !!active && revokingId === active.share_id;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      successToast(tI18nComplete.raw('textd0f24de8dbc6'));
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      errorToast(tI18nComplete.raw('text167c96824acb'));
    }
  };

  const copyEmbed = async () => {
    if (!embedSnippet) return;
    try {
      await navigator.clipboard.writeText(embedSnippet);
      setEmbedCopied(true);
      successToast(t('embedCopied'));
      if (embedCopiedTimer.current) clearTimeout(embedCopiedTimer.current);
      embedCopiedTimer.current = setTimeout(() => setEmbedCopied(false), 2000);
    } catch {
      errorToast(tI18nComplete.raw('text167c96824acb'));
    }
  };

  return (
    <section className="space-y-2" data-testid="session-public-link">
      <div className="space-y-1">
        <Label>{t('sectionTitle')}</Label>
        <p className="text-muted-foreground text-xs">{t('sectionDescription')}</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-2">
          <Loading className="size-4 shrink-0" />
        </div>
      ) : isError ? (
        // The list 403s for a member who is neither the session's creator nor
        // a project manager. "Create" would show a link state we cannot read.
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text93bce1d8f18d')}</p>
      ) : active ? (
        <div className="bg-popover flex items-center gap-2 rounded-md border py-1 pr-1 pl-3">
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {url}
          </span>
          <Hint
            label={
              copied ? tI18nComplete.raw('textd12860c21e78') : tI18nComplete.raw('textdbf362d4f210')
            }
            side="bottom"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tI18nComplete.raw('textdbf362d4f210')}
              disabled={!url}
              onClick={() => void copy()}
            >
              {copied ? (
                <CheckIcon className="text-kortix-green size-4" />
              ) : (
                <CopyIcon className="size-4" />
              )}
            </Button>
          </Hint>
          {embedSnippet ? (
            <Hint label={embedCopied ? t('embedCopied') : t('embed')} side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('embed')}
                onClick={() => void copyEmbed()}
              >
                {embedCopied ? (
                  <CheckIcon className="text-kortix-green size-4" />
                ) : (
                  <CodeIcon className="size-4" />
                )}
              </Button>
            </Hint>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={isRevoking}
            onClick={() => setConfirmRevoke(true)}
          >
            {isRevoking ? <Loading className="size-4 shrink-0" /> : null}
            {tI18nComplete.raw('text87e6d00bbf53')}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={link.copyLink}
          disabled={!link.canShare || link.isPending}
        >
          {link.isPending ? (
            <Loading className="size-4 shrink-0" />
          ) : (
            <LinkSimpleIcon className="size-4 shrink-0" />
          )}
          {t('create')}
        </Button>
      )}

      <PublicShareLinkConfirm confirmation={link.confirmation} />
      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title={tI18nComplete.raw('text3d3b295854fe')}
        description={t('revokeDescription')}
        confirmLabel={tI18nComplete.raw('text87e6d00bbf53')}
        confirmVariant="destructive"
        onConfirm={() => {
          if (active) revoke(active.share_id);
          setConfirmRevoke(false);
        }}
      />
    </section>
  );
}
