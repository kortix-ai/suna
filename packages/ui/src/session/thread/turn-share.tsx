'use client';

/**
 * Share ONE assistant response through a public, read-only link.
 *
 * Private by default: the dialog reads the turn's live share
 * (`getTurnShare`) and shows "Session members" until a share exists. The
 * server snapshots the response text when it shares (`shareTurn`), so the
 * link keeps what the reader saw here even if the turn is edited later —
 * `share.stale` says when it was, and "Update link" re-snapshots under the
 * same URL. The preview renders the text the way the public page does
 * (`trust="untrusted"`, no generative UI), so it never promises more than the
 * link shows.
 */

import {
  type TurnShare,
  getTurnShare,
  shareTurn,
  unshareTurn,
} from '@kortix/sdk';
import { useProjectSession } from '@kortix/sdk/react';
import {
  CheckIcon,
  GlobeIcon,
  LockIcon,
  ShareNetworkIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Copy } from '../../icons/copy';
import { useLocale, useTranslations } from '../../i18n';
import { UnifiedMarkdown } from '../../markdown/unified-markdown';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { Input } from '../../primitives/input';
import { Label } from '../../primitives/label';
import Loading from '../../primitives/loading';
import { Modal, ModalContent, ModalTitle } from '../../primitives/modal';
import { RadioGroup, RadioGroupItem } from '../../primitives/radio-group';
import { successToast } from '../../primitives/toast';
import { useUiHostConfig } from '../../providers/ui-provider';

export interface TurnShareTarget {
  projectId: string;
  /** The Kortix project session id (`projectSessionId`), not the runtime id. */
  sessionId: string;
  /** The user message id that opens the turn (`SessionLogTurn.id`). */
  turnId: string;
}

type Audience = 'members' | 'public';

/** How long an armed "Stop sharing" waits for its second click. */
const STOP_CONFIRM_MS = 4_000;

export function turnShareQueryKey({ projectId, sessionId, turnId }: TurnShareTarget) {
  return ['turn-share', projectId, sessionId, turnId] as const;
}

/** The status an SDK error carries (`ApiError.status`), when it carries one. */
function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

const SOCIAL_INTENTS: ReadonlyArray<{ network: string; href: (url: string, title: string) => string }> = [
  { network: 'X', href: (url) => `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}` },
  {
    network: 'LinkedIn',
    href: (url) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
  {
    network: 'Reddit',
    href: (url, title) =>
      `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`,
  },
];

/**
 * The Share icon button of a settled turn's action bar, and the dialog it
 * opens. Renders nothing where a share cannot exist: a host without public
 * share pages, a turn outside a Kortix session, or a viewer the API would
 * refuse (`can_manage_sharing === false`, the same verdict `guardSessionSharing`
 * computes).
 */
export function TurnShareButton({
  projectId,
  sessionId,
  turnId,
  text,
  agentName,
  respondedAt,
}: Partial<TurnShareTarget> & {
  /** The response text as the transcript copies it. */
  text: string;
  agentName?: string | null;
  respondedAt?: number | null;
}) {
  const t = useTranslations('turnShare');
  const { publicSharesEnabled } = useUiHostConfig();
  const { data: session } = useProjectSession(projectId, sessionId);
  const [open, setOpen] = useState(false);

  if (!publicSharesEnabled || !projectId || !sessionId || !turnId || !text) return null;
  if (session?.can_manage_sharing === false) return null;

  const title =
    session?.custom_name?.trim() ||
    session?.name?.trim() ||
    (text.split('\n').find((line) => line.trim()) ?? '').replace(/^[#>*\-\s]+/, '').slice(0, 80);

  return (
    <>
      <Hint label={t('shareResponse')} side="top">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen(true)}
          aria-label={t('shareResponse')}
          className="hit-area-3"
        >
          <ShareNetworkIcon className="text-muted-foreground size-4" />
        </Button>
      </Hint>
      <Modal open={open} onOpenChange={setOpen}>
        {/* Mounted only while open: the share read runs when someone asks. */}
        {open ? (
          <TurnShareDialogContent
            target={{ projectId, sessionId, turnId }}
            text={text}
            title={title}
            agentName={agentName ?? session?.agent_name ?? null}
            respondedAt={respondedAt ?? null}
          />
        ) : null}
      </Modal>
    </>
  );
}

function TurnShareDialogContent({
  target,
  text,
  title,
  agentName,
  respondedAt,
}: {
  target: TurnShareTarget;
  text: string;
  title: string;
  agentName: string | null;
  respondedAt: number | null;
}) {
  const t = useTranslations('turnShare');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const key = turnShareQueryKey(target);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Revoking kills a link people may already hold, so it takes two clicks:
  // the first arms "Stop sharing", a second within STOP_CONFIRM_MS revokes.
  const [confirmingStop, setConfirmingStop] = useState(false);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (stopTimer.current) clearTimeout(stopTimer.current);
    },
    [],
  );
  const resetStop = () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    setConfirmingStop(false);
  };
  const armStop = () => {
    setConfirmingStop(true);
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => setConfirmingStop(false), STOP_CONFIRM_MS);
    // From the "Session members" row: the second click belongs on the button,
    // and its blur is what disarms it.
    stopButton.current?.focus();
  };

  const query = useQuery({
    queryKey: key,
    queryFn: () => getTurnShare(target.projectId, target.sessionId, target.turnId),
    // A 403 or 404 is a settled answer; retrying it only delays the error line.
    retry: false,
    staleTime: 30_000,
  });
  const share: TurnShare | null = query.data?.share ?? null;

  const copyUrl = async (url: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      return false;
    }
  };

  const publish = useMutation({
    mutationFn: (_reason: 'share' | 'update') =>
      shareTurn(target.projectId, target.sessionId, target.turnId),
    onMutate: () => setError(null),
    onSuccess: async (data, reason) => {
      queryClient.setQueryData(key, data);
      if (reason === 'update') {
        successToast(t('linkUpdated'));
        return;
      }
      // Sharing is the moment the person wants the link: put it on the clipboard.
      successToast((await copyUrl(data.share.url)) ? t('linkCopied') : t('responseShared'));
    },
    onError: (err) => setError(errorStatus(err) === 409 ? t('noText') : t('shareError')),
  });

  const unpublish = useMutation({
    mutationFn: () => unshareTurn(target.projectId, target.sessionId, target.turnId),
    onMutate: () => {
      setError(null);
      resetStop();
    },
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onError: () => setError(t('unshareError')),
  });

  const pending = query.isLoading || publish.isPending || unpublish.isPending;
  const audience: Audience = share ? 'public' : 'members';
  const shownError = error ?? (query.isError ? t('loadError') : null);

  const meta = [
    agentName,
    respondedAt
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(respondedAt)
      : null,
  ].filter(Boolean);

  return (
    <ModalContent className="space-y-0 lg:max-w-4xl">
      <div className="flex min-h-0 flex-col md:h-140 md:flex-row">
        {/* The response, as the link shows it. */}
        <div className="bg-background relative flex max-h-64 min-h-0 flex-col border-b md:max-h-none md:flex-1 md:border-b-0">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-6 pb-12 md:px-8">
            {meta.length > 0 ? (
              <p className="text-muted-foreground text-xs">{meta.join(' · ')}</p>
            ) : null}
            {title ? (
              <p className="text-foreground text-xl font-medium text-balance">{title}</p>
            ) : null}
            <UnifiedMarkdown content={text} trust="untrusted" />
          </div>
          <div
            aria-hidden="true"
            className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t to-transparent"
          />
        </div>

        {/* The controls. */}
        <div className="flex min-h-0 shrink-0 flex-col gap-5 p-6 md:w-76 md:border-l">
          <ModalTitle className="pr-10 text-lg font-medium">{t('title')}</ModalTitle>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label id="turn-share-audience">{t('whoCanRead')}</Label>
              {pending ? <Loading className="text-muted-foreground size-4 shrink-0" /> : null}
            </div>
            <RadioGroup
              aria-labelledby="turn-share-audience"
              aria-busy={pending || undefined}
              value={audience}
              disabled={pending}
              onValueChange={(next) => {
                if (next === audience) return;
                if (next === 'public') publish.mutate('share');
                else armStop();
              }}
              className="gap-2"
            >
              <RadioGroupItem
                value="members"
                variant="outline"
                size="lg"
                className="has-data-[state=checked]:border-ring"
                label={
                  <span className="flex items-center gap-2">
                    <LockIcon className="text-muted-foreground size-4 shrink-0" />
                    {t('sessionMembers')}
                  </span>
                }
              />
              <RadioGroupItem
                value="public"
                variant="outline"
                size="lg"
                className="has-data-[state=checked]:border-ring"
                label={
                  <span className="flex items-center gap-2">
                    <GlobeIcon className="text-muted-foreground size-4 shrink-0" />
                    {t('anyoneWithLink')}
                  </span>
                }
              />
            </RadioGroup>
          </div>

          {share ? (
            <div className="space-y-2">
              <Label htmlFor="turn-share-url">{t('link')}</Label>
              <Input
                id="turn-share-url"
                readOnly
                value={share.url}
                onFocus={(event) => event.currentTarget.select()}
              />
              {share.stale ? (
                <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
                  {t('stale')} ·
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto px-0 text-xs"
                    disabled={pending}
                    onClick={() => publish.mutate('update')}
                  >
                    {t('updateLink')}
                  </Button>
                </p>
              ) : null}
            </div>
          ) : null}

          {confirmingStop ? (
            <p role="status" className="text-muted-foreground text-xs">
              {t('stopNote')}
            </p>
          ) : null}

          {shownError ? (
            <p role="alert" className="text-foreground flex items-start gap-2 text-xs text-pretty">
              <WarningCircleIcon weight="fill" className="text-kortix-red mt-0.5 size-4 shrink-0" />
              {shownError}
            </p>
          ) : null}

          <div className="mt-auto space-y-2">
            {share ? (
              <>
                <Button
                  size="lg"
                  className="w-full"
                  disabled={pending}
                  onClick={() => void copyUrl(share.url).then((ok) => !ok && setError(t('copyError')))}
                >
                  {copied ? <CheckIcon className="size-4 shrink-0" /> : <Copy className="size-4 shrink-0" />}
                  {copied ? t('copied') : t('copyLink')}
                </Button>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    {SOCIAL_INTENTS.map(({ network, href }, index) => (
                      <span key={network} className="flex items-center gap-1.5">
                        {index > 0 ? <span aria-hidden="true">·</span> : null}
                        <a
                          href={href(share.url, title)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('shareOn', { network })}
                          className="hover:text-foreground transition-colors"
                        >
                          {network}
                        </a>
                      </span>
                    ))}
                  </p>
                  <Button
                    ref={stopButton}
                    variant="destructive"
                    size="xs"
                    disabled={pending}
                    onClick={() => (confirmingStop ? unpublish.mutate() : armStop())}
                    onBlur={resetStop}
                  >
                    {confirmingStop ? t('confirmStop') : t('stopSharing')}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </ModalContent>
  );
}
