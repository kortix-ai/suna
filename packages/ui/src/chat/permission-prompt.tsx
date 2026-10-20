'use client';

/**
 * A pending PERMISSION request ("run this command?") and its decision.
 * `onAnswer` is `session.answerPermission`: it drops the request only once the
 * server accepted the decision, and throws a typed `KortixSendError`
 * otherwise, so a failed reply stays visible for a retry.
 */

import { ShieldWarningIcon } from '@phosphor-icons/react';
import type { PermissionRequest } from '@kortix/sdk';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { useUiStrings } from '../providers/ui-provider';

export type PermissionDecision = 'once' | 'always' | 'reject';

/** Reports a failed reply. Without it the prompt shows the message inline. */
export type ChatErrorHandler = (message: string, error: unknown) => void;

export function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : fallback;
}

export function PermissionPrompt({
  request,
  onAnswer,
  onError,
}: {
  request: PermissionRequest;
  onAnswer: (requestId: string, decision: PermissionDecision) => Promise<void>;
  onError?: ChatErrorHandler;
}) {
  const t = useUiStrings().chat;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = String(request.permission ?? t.thisAction).replace(/[._-]/g, ' ');

  async function reply(decision: PermissionDecision) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await onAnswer(request.id, decision);
    } catch (err) {
      const message = errorMessage(err, t.decisionFailed);
      if (onError) onError(message, err);
      else setError(message);
      setSending(false);
    }
  }

  return (
    <div data-slot="permission-prompt" className="bg-kortix-orange/15 overflow-hidden rounded-md">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <ShieldWarningIcon weight="fill" className="text-kortix-orange size-4 shrink-0" />
        <span className="text-foreground flex-1 text-sm">
          {t.allowPrefix} <span className="font-medium">{label}</span>
          {t.allowSuffix}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-foreground px-3 pb-2 text-xs">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 px-3 pb-2.5">
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => reply('reject')}>
          {t.deny}
        </Button>
        <Button size="sm" variant="outline" disabled={sending} onClick={() => reply('always')}>
          {t.always}
        </Button>
        <Button size="sm" disabled={sending} onClick={() => reply('once')}>
          {t.allowOnce}
        </Button>
      </div>
    </div>
  );
}
