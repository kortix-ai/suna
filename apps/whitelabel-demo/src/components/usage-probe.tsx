'use client';

/**
 * Shared machinery for the two guardrail probes on the Usage page.
 *
 * Both probes are "do the real thing once and show me exactly what upstream
 * said". So both render the SAME two blocks: a verdict derived from the
 * upstream `code` (never a generic "something went wrong"), and the attempts
 * verbatim — status, code, session id, the key that was sent, and the body it
 * was sent with. If the demo paraphrased any of that, the founder would have to
 * go back to curl to check it, which is the gap these controls exist to close.
 */

import { Badge } from '@/components/ui/badge';
import Loading from '@/components/ui/loading';
import type { ProbeAttempt, ProbeResponse, ProbeVerdict, ProbeVerdictKind } from '@/app/usage/contract';
import { getSessionToken } from '@/lib/session';
import { useMutation } from '@tanstack/react-query';

/** Tone per verdict — "a new session was created under a replayed key" is a
 *  failure even though every HTTP status involved was a 2xx. */
const TONE: Record<ProbeVerdictKind, string> = {
  created: 'border-border bg-muted/40',
  replayed: 'border-brand/40 bg-brand/5',
  'not-idempotent': 'border-destructive/40 bg-destructive/5',
  conflict: 'border-brand/40 bg-brand/5',
  cap: 'border-amber-500/40 bg-amber-500/5',
  refused: 'border-destructive/40 bg-destructive/5',
};

export interface ProbeRequest {
  probe: 'caps' | 'idempotency';
  projectId: string;
  variant?: 'replay' | 'conflict';
}

export function useProbe() {
  return useMutation<ProbeResponse, Error, ProbeRequest>({
    mutationFn: async (input) => {
      const token = getSessionToken();
      const res = await fetch('/api/usage', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(input),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : `probe failed (${res.status})`;
        throw new Error(message);
      }
      return payload as ProbeResponse;
    },
  });
}

export function ProbeBusy({ label }: { label: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
      <Loading className="size-3.5" /> {label}
    </div>
  );
}

export function ProbeVerdictBanner({ verdict }: { verdict: ProbeVerdict }) {
  return (
    <div className={`mt-3 rounded-md border px-3 py-2.5 ${TONE[verdict.kind]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{verdict.title}</span>
        {/* The code IS the finding — a wrapper author is about to switch on it. */}
        {verdict.code && (
          <Badge variant="outline" className="font-mono text-[11px]">
            {verdict.code}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{verdict.detail}</p>
    </div>
  );
}

export function ProbeAttempts({ attempts }: { attempts: ProbeAttempt[] }) {
  return (
    <ul className="mt-3 space-y-2">
      {attempts.map((attempt, index) => (
        <li key={`${attempt.label}-${index}`} className="rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">{attempt.label}</span>
            <Badge variant="secondary" className="font-mono text-[11px]">
              HTTP {attempt.status}
            </Badge>
            {attempt.code && (
              <Badge variant="outline" className="font-mono text-[11px]">
                {attempt.code}
              </Badge>
            )}
          </div>
          <dl className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
            {attempt.idempotencyKey && (
              <div className="flex gap-2">
                <dt className="shrink-0">Idempotency-Key</dt>
                <dd className="break-all font-mono">{attempt.idempotencyKey}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="shrink-0">session_id</dt>
              <dd className="break-all font-mono">{attempt.sessionId ?? '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0">body</dt>
              <dd className="break-all font-mono">{JSON.stringify(attempt.sentBody)}</dd>
            </div>
            {attempt.message && (
              <div className="flex gap-2">
                <dt className="shrink-0">error</dt>
                <dd className="break-words">{attempt.message}</dd>
              </div>
            )}
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function ProbeError({ message }: { message: string }) {
  return (
    <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      {message}
    </div>
  );
}
