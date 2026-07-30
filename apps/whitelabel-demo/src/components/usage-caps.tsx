'use client';

/**
 * The two per-end-user 429 caps, stated honestly and testable in one click.
 *
 * Both are OFF unless the operator turns them on, and both are check-then-act
 * guardrails measured at session CREATE — not quotas. That distinction is the
 * whole point of this panel: a wrapper that treats either as a hard billing
 * boundary will ship a hole. So the copy says what they are, and the probe shows
 * the real reply — including which of the two codes came back, because
 * "spend ceiling reached" and "too many live sessions" need different handling
 * and only one of them is worth retrying.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ProbeAttempts, ProbeBusy, ProbeError, ProbeVerdictBanner, useProbe } from '@/components/usage-probe';
import { Gauge } from 'lucide-react';

const CAPS = [
  {
    code: 'per_origin_session_limit',
    title: 'Concurrency',
    env: 'KORTIX_BACKEND_PER_ORIGIN_SESSION_LIMIT',
    body: 'Most live sessions one end_user_ref may hold at once. Self-clearing: finish or stop a session and the next create passes, so this one is worth retrying.',
  },
  {
    code: 'per_end_user_spend_limit',
    title: 'Spend',
    env: 'KORTIX_BACKEND_PER_END_USER_SPEND_LIMIT_USD',
    body: 'Spend ceiling per end_user_ref over a rolling window (KORTIX_BACKEND_PER_END_USER_SPEND_WINDOW_DAYS, default 30). The 429 body carries spent_usd, limit_usd and window_days. Not retryable until the window rolls or the operator raises the limit.',
  },
];

export function UsageCaps({ projectId }: { projectId: string | null }) {
  const probe = useProbe();

  return (
    <Card className="mt-6 p-4">
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-muted-foreground" />
        <div className="text-sm font-medium">Per-end-user caps</div>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Two optional guardrails keyed on <code>end_user_ref</code>, so one of your users cannot
        exhaust the account on everyone else&apos;s behalf. Both are <strong>off by default</strong>.
      </p>

      <ul className="mt-3 space-y-2">
        {CAPS.map((cap) => (
          <li key={cap.code} className="rounded-md border border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">{cap.title}</span>
              <Badge variant="outline" className="font-mono text-[11px]">
                429 {cap.code}
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{cap.body}</p>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{cap.env}</p>
          </li>
        ))}
      </ul>

      {/* Said plainly because the alternative is a wrapper author assuming a
          quota. Both checks read state, then create — two parallel creates can
          both observe the same under-limit state and both pass. */}
      <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Guardrails, not quotas.</strong> Both are checked at
        session <em>create</em>, and the check and the create are not atomic — parallel creates for
        one end-user can each see the same under-limit state and all pass. A session already running
        is never killed mid-turn for crossing the line; the <em>next</em> create is what gets
        refused. Treat them as runaway protection, not as a billing boundary.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!projectId || probe.isPending}
          onClick={() => projectId && probe.mutate({ probe: 'caps', projectId })}
        >
          Try a session create
        </Button>
        <span className="text-xs text-muted-foreground">
          Creates one real session and reports whichever 429 code came back, if any.
        </span>
      </div>

      {probe.isPending && <ProbeBusy label="Creating a session upstream…" />}
      {probe.error && <ProbeError message={probe.error.message} />}
      {probe.data && !probe.isPending && (
        <>
          <ProbeVerdictBanner verdict={probe.data.verdict} />
          <ProbeAttempts attempts={probe.data.attempts} />
        </>
      )}
    </Card>
  );
}
