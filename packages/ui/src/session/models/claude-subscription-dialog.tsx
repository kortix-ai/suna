'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  completeClaudeSubscriptionLogin,
  disconnectClaudeSubscription,
  getClaudeSubscription,
  setClaudeSubscriptionToken,
  startClaudeSubscriptionLogin,
  type ClaudeSubscriptionLoginStart,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useTranslations } from '../../i18n';
import { useSessionIds } from '../../providers/session-ids';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { Field, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';
import { errorToast, successToast } from '../../primitives/toast';

/** The caller's Claude subscription status in a project's account. */
export const claudeSubscriptionKey = (projectId: string) => ['claude-subscription', projectId] as const;

export function useClaudeSubscription(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: claudeSubscriptionKey(projectId ?? ''),
    queryFn: () => getClaudeSubscription(projectId!),
    enabled: enabled && !!projectId,
    staleTime: 30_000,
  });
}

const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/**
 * Connect, check and disconnect the caller's own Claude subscription. Claude
 * models (`claude-agent/<id>`) run through Claude Code in the caller's
 * sessions, on the caller's Claude plan. The sign-in is Anthropic's own: the
 * caller approves on claude.com and pastes the code it shows. A token made with
 * `claude setup-token` on the caller's computer works too. No screen shows a
 * stored login again.
 */
export function ClaudeSubscriptionDialog({
  projectId,
  open,
  onOpenChange,
  onConnected,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs once a login is stored: a picker selects the Claude model the person chose. */
  onConnected?: () => void;
}) {
  const t = useTranslations('claudeSubscription');
  const queryClient = useQueryClient();
  const status = useClaudeSubscription(projectId, open);
  const [flow, setFlow] = useState<ClaudeSubscriptionLoginStart | null>(null);
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [tokenMode, setTokenMode] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const reset = () => {
    setFlow(null);
    setCode('');
    setToken('');
    setTokenMode(false);
  };
  const close = () => {
    reset();
    onOpenChange(false);
  };
  const stored = async () => {
    await queryClient.invalidateQueries({ queryKey: claudeSubscriptionKey(projectId) });
    // The picker reads whether Claude is connected from its model list: refetch it.
    void queryClient.invalidateQueries({ queryKey: qk.project.modelPicker(projectId) });
    successToast(t('connected'));
    onConnected?.();
    close();
  };

  const start = useMutation<ClaudeSubscriptionLoginStart, Error, Window | null>({
    mutationFn: () => startClaudeSubscriptionLogin(projectId),
    onSuccess: (started, popup) => {
      setFlow(started);
      if (popup && !popup.closed) popup.location.href = started.authorize_url;
    },
    onError: (_error, popup) => popup?.close(),
  });
  const complete = useMutation({
    mutationFn: () => completeClaudeSubscriptionLogin(projectId, { flowId: flow!.flow_id, code: code.trim() }),
    onSuccess: stored,
  });
  const save = useMutation({
    mutationFn: () => setClaudeSubscriptionToken(projectId, token.trim()),
    onSuccess: stored,
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectClaudeSubscription(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: claudeSubscriptionKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.project.modelPicker(projectId) });
      setConfirmDisconnect(false);
      successToast(t('disconnected'));
    },
    onError: (error) => errorToast(message(error, t('disconnectError'))),
  });

  // The claude.com tab opens inside the click, so a popup blocker lets it through; the address follows once the sign-in started.
  const signIn = () => {
    start.reset();
    complete.reset();
    const popup = typeof window === 'undefined' ? null : window.open('about:blank', '_blank');
    start.mutate(popup);
  };

  const connected = status.data?.connected === true && status.data.usable;
  const busy = start.isPending || complete.isPending || save.isPending;
  const failure = start.isError ? message(start.error, t('startError')) : complete.isError ? message(complete.error, t('codeError')) : save.isError ? message(save.error, t('tokenError')) : null;

  return (
    <>
      <Modal open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>{t('title')}</ModalTitle>
            <ModalDescription>{t('description')}</ModalDescription>
          </ModalHeader>
          <ModalBody className="space-y-3">
            {status.isPending ? (
              <div role="status" aria-label={t('loading')}><Loading /></div>
            ) : connected ? (
              <div className="space-y-1">
                <p className="text-foreground text-sm font-medium">{t('connectedTitle')}</p>
                <p className="text-muted-foreground text-xs leading-5 text-pretty">{t('connectedDescription')}</p>
              </div>
            ) : tokenMode ? (
              <Field>
                <FieldLabel htmlFor="claude-subscription-token">{t('tokenLabel')}</FieldLabel>
                <p className="text-muted-foreground text-xs leading-5 text-pretty">
                  {t.rich('tokenHint', { code: (chunks) => <code className="text-foreground font-mono">{chunks}</code> })}
                </p>
                <Input id="claude-subscription-token" type="password" autoComplete="off" value={token} disabled={save.isPending}
                  placeholder="sk-ant-oat01-…" onChange={(event) => setToken(event.target.value)} />
              </Field>
            ) : flow ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-foreground text-xs font-medium">{t('approveTitle')}</p>
                  <p className="text-muted-foreground text-xs leading-5 text-pretty">{t('approveDescription')}</p>
                </div>
                <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 px-3" asChild>
                  <a href={flow.authorize_url} target="_blank" rel="noopener noreferrer">
                    <ArrowSquareOutIcon className="size-3.5 shrink-0" />
                    {t('openClaude')}
                  </a>
                </Button>
                <Field>
                  <FieldLabel htmlFor="claude-subscription-code">{t('codeLabel')}</FieldLabel>
                  <Input id="claude-subscription-code" autoComplete="off" autoFocus value={code} disabled={complete.isPending}
                    onChange={(event) => setCode(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter' && code.trim() && !complete.isPending) complete.mutate(); }} />
                </Field>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-foreground text-xs font-medium">{t('signInTitle')}</p>
                <p className="text-muted-foreground text-xs leading-5 text-pretty">{t('signInDescription')}</p>
              </div>
            )}
            {failure && <p role="alert" className="text-destructive text-sm">{failure}</p>}
            {!connected && !status.isPending && (
              <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs" disabled={busy}
                onClick={() => { start.reset(); complete.reset(); save.reset(); setTokenMode((current) => !current); }}>
                {tokenMode ? t('useSignIn') : t('useToken')}
              </Button>
            )}
          </ModalBody>
          <ModalFooter>
            {connected ? (
              <>
                <Button variant="secondary" onClick={() => setConfirmDisconnect(true)}>{t('disconnect')}</Button>
                <Button onClick={close}>{t('done')}</Button>
              </>
            ) : (
              <>
                <Button variant="secondary" disabled={busy} onClick={close}>{t('cancel')}</Button>
                {tokenMode ? (
                  <Button disabled={save.isPending || !token.trim()} onClick={() => save.mutate()}>{save.isPending ? t('saving') : t('saveToken')}</Button>
                ) : flow ? (
                  <Button disabled={complete.isPending || !code.trim()} onClick={() => complete.mutate()}>{complete.isPending ? t('connecting') : t('connect')}</Button>
                ) : (
                  <Button disabled={start.isPending || status.isPending} onClick={signIn}>{start.isPending ? t('starting') : t('signIn')}</Button>
                )}
              </>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={(next) => { if (!disconnect.isPending) setConfirmDisconnect(next); }}
        title={t('disconnectTitle')}
        description={t('disconnectDescription')}
        confirmLabel={t('disconnect')}
        cancelLabel={t('cancel')}
        isPending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
        confirmVariant="destructive"
      />
    </>
  );
}

/** The turn error kortixd writes when the session user has no Claude login (`CLAUDE_CONNECT_MESSAGE`). */
const CLAUDE_CONNECT_MESSAGE = 'Connect your Claude subscription to use Claude models.';
/** The turn error kortixd writes when Anthropic refused the stored login (`CLAUDE_RECONNECT_MESSAGE`). */
const CLAUDE_RECONNECT_MESSAGE = 'Your Claude subscription login stopped working. Reconnect Claude to continue.';

/** Which Claude fix a failed turn needs, from the error text kortixd wrote, if any. */
export function claudeConnectionAction(text: string | null | undefined): 'connect' | 'reconnect' | null {
  const value = (text ?? '').trim();
  if (value.includes(CLAUDE_CONNECT_MESSAGE)) return 'connect';
  if (value.includes(CLAUDE_RECONNECT_MESSAGE)) return 'reconnect';
  return null;
}

/** The fix for a turn that failed on the viewer's Claude login: opens the Claude dialog. Renders on a project route only. */
export function ClaudeConnectionSlot({ action, className = 'mt-2 pl-7' }: { action: 'connect' | 'reconnect'; className?: string }) {
  const t = useTranslations('claudeSubscription');
  const projectId = useSessionIds().projectId ?? null;
  const [open, setOpen] = useState(false);
  if (!projectId) return null;
  return (
    <div className={className}>
      <Button size="sm" className="active:scale-[0.96]" onClick={() => setOpen(true)}>
        {t(action === 'reconnect' ? 'reconnectClaude' : 'connectClaude')}
      </Button>
      <ClaudeSubscriptionDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </div>
  );
}
