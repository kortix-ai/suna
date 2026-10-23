'use client';

/**
 * Share ONE assistant response through a public, read-only link.
 *
 * Private by default: the dialog reads the turn's live share
 * (`getTurnShare`) and the "Public link" switch stays off until one exists.
 * The server snapshots the text when it shares (`shareTurn`), with the prompt
 * only when the person picks "Prompt and response". A re-share keeps the token
 * and URL, so changing the scope or "Update link" (after `share.stale`) never
 * breaks a link someone already holds. Turning the link off is destructive and
 * takes a second, explicit click.
 */

import { type TurnShare, getTurnShare, shareTurn, unshareTurn } from '@kortix/sdk';
import { useProjectSession } from '@kortix/sdk/react';
import { CheckIcon, ShareNetworkIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';

import { Copy } from '../../icons/copy';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { Input } from '../../primitives/input';
import { Label } from '../../primitives/label';
import Loading from '../../primitives/loading';
import { Modal, ModalContent, ModalTitle } from '../../primitives/modal';
import { RadioGroup } from '../../primitives/radio-group';
import { Separator } from '../../primitives/separator';
import { Switch } from '../../primitives/switch';
import { successToast } from '../../primitives/toast';
import { useUiHostConfig } from '../../providers/ui-provider';

export interface TurnShareTarget {
  projectId: string;
  /** The Kortix project session id (`projectSessionId`), not the runtime id. */
  sessionId: string;
  /** The user message id that opens the turn (`SessionLogTurn.id`). */
  turnId: string;
}

export function turnShareQueryKey({ projectId, sessionId, turnId }: TurnShareTarget) {
  return ['turn-share', projectId, sessionId, turnId] as const;
}

/**
 * The server's own message for a failed call, or null. Only an error that
 * carries an HTTP status (`ApiError.status`) came from the server; a network
 * failure's message ("Failed to fetch") is not worth showing.
 */
function serverMessage(error: unknown): string | null {
  const { status, message } = (error ?? {}) as { status?: unknown; message?: unknown };
  return typeof status === 'number' && typeof message === 'string' && message.trim()
    ? message.trim()
    : null;
}

/**
 * The Share icon button of a settled turn's action bar, and the dialog it
 * opens. Renders nothing where a share cannot exist: a host without public
 * share pages, a turn outside a Kortix session, or a viewer the API would
 * refuse (`can_manage_sharing === false`, the same verdict `guardSessionSharing`
 * computes).
 */
export function TurnShareButton({ projectId, sessionId, turnId }: Partial<TurnShareTarget>) {
  const t = useTranslations('turnShare');
  const { publicSharesEnabled } = useUiHostConfig();
  const { data: session } = useProjectSession(projectId, sessionId);
  const [open, setOpen] = useState(false);

  if (!publicSharesEnabled || !projectId || !sessionId || !turnId) return null;
  if (session?.can_manage_sharing === false) return null;

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
        {open ? <TurnShareDialogContent target={{ projectId, sessionId, turnId }} /> : null}
      </Modal>
    </>
  );
}

type PublishInput = { includePrompt: boolean; reason: 'share' | 'scope' | 'update' };

function TurnShareDialogContent({ target }: { target: TurnShareTarget }) {
  const t = useTranslations('turnShare');
  const queryClient = useQueryClient();
  const key = turnShareQueryKey(target);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The scope the person picked; null = whatever the live share says.
  const [pickedIncludePrompt, setPickedIncludePrompt] = useState<boolean | null>(null);
  // "Turn off link" waits for this second, explicit click.
  const [confirmingOff, setConfirmingOff] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const query = useQuery({
    queryKey: key,
    queryFn: () => getTurnShare(target.projectId, target.sessionId, target.turnId),
    // A 403 or 404 is a settled answer; retrying it only delays the error line.
    retry: false,
    staleTime: 30_000,
  });
  const share: TurnShare | null = query.data?.share ?? null;
  const includePrompt = pickedIncludePrompt ?? share?.include_prompt ?? false;

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
    mutationFn: ({ includePrompt: include_prompt }: PublishInput) =>
      shareTurn(target.projectId, target.sessionId, target.turnId, { include_prompt }),
    onMutate: () => setError(null),
    onSuccess: async (data, { reason }) => {
      queryClient.setQueryData(key, data);
      setPickedIncludePrompt(null);
      if (reason !== 'share') {
        successToast(t('linkUpdated'));
        return;
      }
      // Sharing is the moment the person wants the link: put it on the clipboard.
      successToast((await copyUrl(data.share.url)) ? t('linkCopied') : t('responseShared'));
    },
    onError: (err, { reason }) => {
      // A failed scope change leaves the live share as it was: show its scope.
      if (reason === 'scope') setPickedIncludePrompt(null);
      setError(serverMessage(err) ?? t('shareError'));
    },
  });

  const unpublish = useMutation({
    mutationFn: () => unshareTurn(target.projectId, target.sessionId, target.turnId),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data);
      setConfirmingOff(false);
    },
    onError: (err) => setError(serverMessage(err) ?? t('unshareError')),
  });

  const pending = query.isLoading || publish.isPending || unpublish.isPending;
  const shownError = error ?? (query.isError ? (serverMessage(query.error) ?? t('loadError')) : null);

  const pickScope = (value: string) => {
    const next = value === 'prompt';
    if (next === includePrompt) return;
    setPickedIncludePrompt(next);
    // Private: the pick waits for the switch. Public: re-share under the same URL.
    if (share) publish.mutate({ includePrompt: next, reason: 'scope' });
  };

  return (
    <ModalContent className="space-y-0 lg:max-w-lg">
      <div className="flex flex-col gap-5 p-5">
        <ModalTitle className="pr-10 text-lg font-medium">{t('shareResponse')}</ModalTitle>

        <div className="space-y-2.5">
          <Label id="turn-share-scope">{t('whatToInclude')}</Label>
          <RadioGroup
            aria-labelledby="turn-share-scope"
            value={includePrompt ? 'prompt' : 'response'}
            onValueChange={pickScope}
            disabled={pending}
            className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
          >
            <ScopeTile
              value="response"
              title={t('responseOnly')}
              hint={t('responseOnlyHint')}
              withPrompt={false}
            />
            <ScopeTile
              value="prompt"
              title={t('promptAndResponse')}
              hint={t('promptAndResponseHint')}
              withPrompt
            />
          </RadioGroup>
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <Label htmlFor="turn-share-public">{t('publicLink')}</Label>
              <p className="text-muted-foreground text-xs">{t('publicLinkHint')}</p>
            </div>
            {pending ? <Loading className="text-muted-foreground size-4 shrink-0" /> : null}
            <Switch
              id="turn-share-public"
              checked={!!share && !confirmingOff}
              disabled={pending}
              aria-busy={pending || undefined}
              onCheckedChange={(on) => {
                if (on && confirmingOff) setConfirmingOff(false);
                else if (on) publish.mutate({ includePrompt, reason: 'share' });
                else if (share) setConfirmingOff(true);
              }}
            />
          </div>

          {share && confirmingOff ? (
            <div
              role="group"
              aria-label={t('turnOffLink')}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <p className="text-muted-foreground text-xs">{t('stopNote')}</p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline-ghost"
                  size="xs"
                  disabled={pending}
                  onClick={() => setConfirmingOff(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  disabled={pending}
                  onClick={() => unpublish.mutate()}
                >
                  {t('turnOffLink')}
                </Button>
              </div>
            </div>
          ) : null}

          {share && !confirmingOff ? (
            <>
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label={t('publicLink')}
                  value={share.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  className="shrink-0"
                  disabled={pending}
                  onClick={() =>
                    void copyUrl(share.url).then((ok) => !ok && setError(t('copyError')))
                  }
                >
                  {copied ? (
                    <CheckIcon className="size-4 shrink-0" />
                  ) : (
                    <Copy className="size-4 shrink-0" />
                  )}
                  {copied ? t('copied') : t('copyLink')}
                </Button>
              </div>
              {share.stale ? (
                <p className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
                  {t('stale')} ·
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto px-0 text-xs"
                    disabled={pending}
                    onClick={() => publish.mutate({ includePrompt, reason: 'update' })}
                  >
                    {t('updateLink')}
                  </Button>
                </p>
              ) : null}
            </>
          ) : null}

          {shownError ? (
            <p role="alert" className="text-foreground flex items-start gap-2 text-xs text-pretty">
              <WarningCircleIcon weight="fill" className="text-kortix-red mt-0.5 size-4 shrink-0" />
              {shownError}
            </p>
          ) : null}
        </div>
      </div>
    </ModalContent>
  );
}

/** Widths of the skeleton text lines, longest first. */
const RESPONSE_LINES = ['w-full', 'w-11/12', 'w-2/3', 'w-5/6', 'w-1/2'];
const RESPONSE_LINES_UNDER_PROMPT = ['w-full', 'w-5/6', 'w-2/3'];

/**
 * One scope choice: a skeleton of what the reader sees, a title and a hint.
 * The prompt variant draws the prompt bubble top-right, where the transcript
 * puts it. Outer `rounded-xl` minus the `p-2` inset gives the preview's
 * `rounded-sm` (14 - 7.4 ≈ 6.6px), so the corners stay concentric.
 */
function ScopeTile({
  value,
  title,
  hint,
  withPrompt,
}: {
  value: string;
  title: string;
  hint: string;
  withPrompt: boolean;
}) {
  return (
    <RadioGroupPrimitive.Item
      value={value}
      className={cn(
        'border-border flex flex-col gap-2.5 rounded-xl border p-2 text-left',
        'hover:bg-hover transition-colors',
        'data-[state=checked]:border-foreground',
        'focus-visible:ring-ring outline-none focus-visible:ring-2',
        'disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      <span aria-hidden="true" className="bg-background flex h-24 flex-col gap-1.5 rounded-sm p-3">
        {withPrompt ? <span className="bg-muted ml-auto h-4 w-3/5 rounded-sm" /> : null}
        {(withPrompt ? RESPONSE_LINES_UNDER_PROMPT : RESPONSE_LINES).map((width, index) => (
          <span key={index} className={cn('bg-border h-1.5 rounded-full', width)} />
        ))}
      </span>
      <span className="flex flex-col gap-0.5 px-1 pb-1">
        <span className="text-foreground text-sm font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </span>
    </RadioGroupPrimitive.Item>
  );
}
