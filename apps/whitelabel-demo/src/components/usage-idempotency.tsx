'use client';

/**
 * Replay an `Idempotency-Key` and see what actually comes back.
 *
 * Session create provisions real compute, so a blind retry after a timeout can
 * double-create and double-charge. The header is the fix — and it is invisible:
 * nothing in a wrapper's UI normally shows whether a replay returned the SAME
 * session or quietly built a second one. This control sends two creates under
 * one key and prints both session ids.
 *
 * The second button is the half wrapper authors get wrong. A replay whose body
 * CHANGED is refused 409 rather than handed the first session — because the
 * first session was built from different inputs. Seeing the 409 once is what
 * stops someone reusing one key per user, or per channel, forever.
 */

import { CallSnippet } from '@/components/dev/call-snippet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ProbeAttempts, ProbeBusy, ProbeError, ProbeVerdictBanner, useProbe } from '@/components/usage-probe';
import { Repeat2 } from 'lucide-react';

export function UsageIdempotency({ projectId }: { projectId: string | null }) {
  const probe = useProbe();

  return (
    <Card className="mt-6 p-4">
      <div className="flex items-center gap-2">
        <Repeat2 className="size-4 text-muted-foreground" />
        <div className="text-sm font-medium">Idempotency-Key replay</div>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        A fresh high-entropy key is generated per run and sent on <em>both</em> creates. Same key +
        same body should return the <strong>same session id</strong> — one sandbox, one charge. Same
        key + a different body is refused with a <code>409 IDEMPOTENCY_*_CONFLICT</code> instead of
        returning a session that was built from other inputs.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        The key is minted server-side. A browser that could choose it could aim a replay at another
        end-user&apos;s session, which is also why the same server stamps{' '}
        <code>end_user_ref</code> — a replay under a different one is refused{' '}
        <code>IDEMPOTENCY_ORIGIN_CONFLICT</code>.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!projectId || probe.isPending}
          onClick={() =>
            projectId && probe.mutate({ probe: 'idempotency', projectId, variant: 'replay' })
          }
        >
          Replay the same body
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!projectId || probe.isPending}
          onClick={() =>
            projectId && probe.mutate({ probe: 'idempotency', projectId, variant: 'conflict' })
          }
        >
          Replay a different body
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Each run creates one real session (the replay should not create a second — that is the
        thing being checked).
      </p>

      {/* The header this whole control is about is invisible in the request
          body, so the snippet is the only place it can be read. After a run it
          carries the key that was actually sent, not an example one. */}
      <div className="mt-2">
        <CallSnippet
          id="session.idempotentCreate"
          context={{
            projectId: projectId ?? undefined,
            endUserRef: probe.data?.endUserRef,
            idempotencyKey: probe.data?.attempts[0]?.idempotencyKey,
          }}
        />
      </div>

      {probe.isPending && <ProbeBusy label="Sending two creates under one key…" />}
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
