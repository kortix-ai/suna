'use client';

/**
 * Renders a pending PERMISSION request (e.g. "run this command?") and sends the
 * decision. `answerPermission(requestId, 'once'|'always'|'reject')` replies
 * through the session's runtime and only drops it from the pending store once
 * the server has actually accepted the decision — a failed reply leaves the
 * request visible for a retry instead of vanishing while the agent never got
 * an answer.
 */

import { Button } from '@/components/ui/button';
import { answerPermission, type KortixSendError } from '@kortix/sdk/react';
import { ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export function PermissionPrompt({
  request,
  onResolved,
}: {
  request: Record<string, any>;
  onResolved: () => void;
}) {
  const [sending, setSending] = useState(false);
  const label = String(request.permission ?? 'this action').replace(/[._-]/g, ' ');

  async function reply(decision: 'once' | 'always' | 'reject') {
    if (sending) return;
    setSending(true);
    try {
      await answerPermission(request.id, decision);
      onResolved();
    } catch (err) {
      // `answerPermission` already classifies its own failure via
      // `classifySendError` and throws the typed `KortixSendError`.
      toast.error((err as KortixSendError)?.message || 'Could not send your decision');
      setSending(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/[0.06]">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <ShieldQuestion className="size-4 shrink-0 text-amber-500" />
        <span className="flex-1 text-sm text-foreground">
          Allow <span className="font-medium">{label}</span>?
        </span>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-amber-500/15 px-3 py-2">
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => reply('reject')}>
          Deny
        </Button>
        <Button size="sm" variant="outline" disabled={sending} onClick={() => reply('always')}>
          Always
        </Button>
        <Button size="sm" disabled={sending} onClick={() => reply('once')}>
          Allow once
        </Button>
      </div>
    </div>
  );
}
