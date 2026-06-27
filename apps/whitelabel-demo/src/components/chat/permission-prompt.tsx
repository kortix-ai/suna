'use client';

/**
 * Renders a pending PERMISSION request (e.g. "run this command?") and sends the
 * decision. `replyToPermission(requestId, 'once'|'always'|'reject')` unblocks the
 * run; without it the agent waits forever.
 */

import { Button } from '@/components/ui/button';
import { replyToPermission } from '@kortix/sdk/react';
import { ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export function PermissionPrompt({ request }: { request: Record<string, any> }) {
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const label = String(request.permission ?? 'this action').replace(/[._-]/g, ' ');

  async function reply(decision: 'once' | 'always' | 'reject') {
    if (sending || done) return;
    setSending(true);
    setDone(true);
    try {
      await replyToPermission(request.id, decision);
    } catch {
      toast.error('Could not send your decision');
      setDone(false);
    } finally {
      setSending(false);
    }
  }

  if (done) return null;

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
