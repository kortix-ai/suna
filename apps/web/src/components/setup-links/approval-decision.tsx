'use client';

/**
 * The human-in-the-loop decision surface for one gated executor call.
 *
 * THE POINT OF THIS COMPONENT is the arguments table. The prompt this replaces
 * showed only `Run gmail.send_email` — a question nobody could answer, because
 * "is this allowed?" depends entirely on WHO it emails, and that was never
 * displayed. So the recipient/target renders first and unconditionally; if the
 * backend has no preview for a call, that absence is stated outright rather than
 * left to look like "no arguments".
 *
 * There is no "allow for session" and no "always allow" here, by design — see
 * the resolve endpoint in apps/api/src/projects/routes/r7.ts. Every gated call
 * gets its own decision.
 *
 * Used by the standalone /approve/[token] page. Reaching it requires a signed-in
 * account with authority on the project; the token alone grants nothing.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { type ApprovalLinkDetails, getApprovalLink, resolveApproval } from '@kortix/sdk';
import {
  WarningIcon as AlertTriangle,
  CheckIcon as Check,
  ShieldWarningIcon as ShieldAlert,
  ShieldCheckIcon as ShieldCheck,
  XIcon as X,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import Loading from '@/components/ui/loading';

type Phase = 'loading' | 'error' | 'ready' | 'deciding' | 'decided';

function riskTone(risk: string | null): 'destructive' | 'warning' | 'secondary' {
  if (risk === 'destructive') return 'destructive';
  if (risk === 'write') return 'warning';
  return 'secondary';
}

/** Fields that answer "what does this touch?" — shown first, in this order. */
const PRIORITY_ARGS = ['to', 'cc', 'bcc', 'recipient', 'recipients', 'channel', 'url', 'subject'];

function orderedArgEntries(preview: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(preview);
  const rank = (key: string) => {
    const i = PRIORITY_ARGS.indexOf(key.toLowerCase());
    return i === -1 ? PRIORITY_ARGS.length : i;
  };
  return entries.sort((a, b) => rank(a[0]) - rank(b[0]));
}

function renderArgValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map((v) => renderArgValue(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function ApprovalDecision({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [details, setDetails] = useState<ApprovalLinkDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'approve' | 'deny' | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await getApprovalLink(token);
        if (cancelled) return;
        setDetails(body);
        setPhase('ready');
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not load this approval. Check your connection and try again.',
        );
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function decide(decision: 'approve' | 'deny') {
    if (!details) return;
    setPhase('deciding');
    setOutcome(decision);
    try {
      await resolveApproval(details.project_id, details.execution_id, decision);
      setPhase('decided');
      successToast(decision === 'approve' ? 'Approved — the agent will continue' : 'Denied');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record your decision.');
      setPhase('ready');
      setOutcome(null);
      errorToast(cause instanceof Error ? cause.message : 'Could not record your decision.');
    }
  }

  if (phase === 'loading') {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm">
        <Loading className="h-4 w-4" /> Loading…
      </div>
    );
  }

  if (phase === 'error' && !details) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <div className="bg-muted text-muted-foreground flex h-10 w-10 items-center justify-center rounded-full">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <p className="text-foreground text-sm font-medium">This approval can’t be opened</p>
        <p className="text-muted-foreground text-xs">
          {error || 'The link is invalid or has expired.'}
        </p>
      </div>
    );
  }

  if (!details) return null;

  if (phase === 'decided') {
    const approved = outcome === 'approve';
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-full',
            approved ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-muted-foreground',
          )}
        >
          {approved ? <Check className="h-5 w-5" /> : <X className="h-5 w-5" />}
        </div>
        <p className="text-foreground text-sm font-medium">{approved ? 'Approved' : 'Denied'}</p>
        <p className="text-muted-foreground text-xs">
          {approved
            ? 'The agent has been told to continue.'
            : 'The agent has been told to continue without it.'}
        </p>
      </div>
    );
  }

  const deciding = phase === 'deciding';
  const argsPreview = details.args_preview;
  const argEntries = argsPreview ? orderedArgEntries(argsPreview) : [];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">Run</span>
          <code className="text-foreground font-mono text-sm font-medium">{details.action}</code>
          {details.risk ? (
            <Badge variant={riskTone(details.risk)} size="xs" className="capitalize">
              {details.risk}
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">
          in {details.project_name} · requested {new Date(details.requested_at).toLocaleString()}
        </p>
      </div>

      {/* The arguments. This is the part that makes the decision answerable. */}
      <div className="border-border/60 overflow-hidden rounded-lg border">
        <div className="bg-muted/40 border-border/60 border-b px-3 py-1.5">
          <span className="text-muted-foreground text-[11px] font-medium">What this will do</span>
        </div>
        {argEntries.length > 0 ? (
          <dl className="divide-border/40 divide-y">
            {argEntries.map(([key, value]) => (
              <div key={key} className="flex gap-3 px-3 py-2">
                <dt className="text-muted-foreground w-28 shrink-0 font-mono text-[11px]">{key}</dt>
                <dd className="text-foreground min-w-0 flex-1 break-words text-xs">
                  {value === '[redacted]' ? (
                    <span className="text-muted-foreground italic">hidden (credential)</span>
                  ) : (
                    renderArgValue(value)
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          // Never render an empty box that reads as "nothing to see": an absent
          // preview is a real caveat, and the human should know they are being
          // asked to approve something they cannot inspect here.
          <p className="text-muted-foreground px-3 py-3 text-xs">
            No argument details were recorded for this call — open the session to see what the agent
            was doing before approving.
          </p>
        )}
      </div>

      {!details.pending ? (
        <div className="border-border/60 bg-muted/30 rounded-lg border px-3 py-2">
          <p className="text-muted-foreground text-xs">
            This was already resolved
            {details.resolved_at ? ` on ${new Date(details.resolved_at).toLocaleString()}` : ''}.
            Nothing further to do.
          </p>
        </div>
      ) : (
        <>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
          <div className="flex gap-2">
            <Button
              variant="muted"
              className="hover:bg-destructive/10 hover:text-destructive flex-1"
              disabled={deciding}
              onClick={() => decide('deny')}
            >
              {deciding && outcome === 'deny' ? (
                <Loading className="mr-2 h-4 w-4" />
              ) : (
                <X className="mr-2 h-4 w-4" />
              )}
              Deny
            </Button>
            <Button className="flex-1" disabled={deciding} onClick={() => decide('approve')}>
              {deciding && outcome === 'approve' ? (
                <Loading className="mr-2 h-4 w-4" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              Approve this call
            </Button>
          </div>
          <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-[11px]">
            <ShieldAlert className="h-3 w-3" />
            Applies to this call only — the agent asks again next time.
          </p>
        </>
      )}
    </div>
  );
}
