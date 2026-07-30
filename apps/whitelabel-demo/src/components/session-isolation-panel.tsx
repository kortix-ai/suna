'use client';

/**
 * Who this browser is acting as, and what that actually buys.
 *
 * In wrapper mode every upstream call carries ONE credential — the operator's
 * `KORTIX_API_KEY` — so nothing the browser sends identifies a Lumen user.
 * Two separate things keep two signed-in people apart, and conflating them is
 * how a wrapper ends up billing or leaking across its own customers:
 *
 *  1. PROJECTS are wrapper-local. `server/users.ts` records who provisioned
 *     what; `GET /projects` is filtered to that list and any `projects/{id}/…`
 *     for an id you don't own is refused 403 by policy BEFORE upstream sees it.
 *  2. SESSIONS are scoped upstream by `end_user_ref`, which `server/end-user.ts`
 *     stamps from the signed-in identity on create and again on every list read.
 *     A browser that names somebody else is refused, not quietly corrected.
 *
 * The panel states both, shows the count the second one produces, and lets you
 * fire the forged read yourself rather than asking you to trust the paragraph.
 */

import Loading from '@/components/ui/loading';

import { CallSnippet } from '@/components/dev/call-snippet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { serverErrorBody } from '@/lib/api-error-body';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ShieldCheck, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/** The signed-in end-user, straight from the session cookie/token the server
 *  already verified. The browser has no other source for this — and no way to
 *  change it. */
function useEndUser() {
  return useQuery({
    queryKey: ['end-user'],
    queryFn: async () => {
      const res = await fetch('/api/auth/me');
      if (!res.ok) throw new Error('Not authenticated');
      return (await res.json()) as { userId: string };
    },
    staleTime: 60_000,
  });
}

/** Compact "you are acting as …" line for the session workbench. */
export function EndUserBadge({ projectId }: { projectId: string }) {
  const endUser = useEndUser();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-1.5 text-xs text-muted-foreground">
      <UserCheck className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Acting as <span className="font-mono">{endUser.data?.userId ?? '…'}</span> — attached
        server-side to every session this browser starts.
      </span>
      <Button asChild size="xs" variant="ghost">
        <Link href={`/projects/${projectId}/sessions`}>Isolation</Link>
      </Button>
    </div>
  );
}

export function SessionIsolationPanel({ projectId }: { projectId: string }) {
  const endUser = useEndUser();
  // Same key the shell's session list uses, so the count on this page and the
  // rail can never disagree about what "your sessions" means.
  const sessions = useQuery({
    queryKey: qk.sessions(projectId),
    queryFn: () => kortix.project(projectId).sessions.list(),
    retry: false,
  });

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <UserCheck className="size-4 shrink-0 text-brand" />
          <span className="text-sm font-medium">You are acting as</span>
        </div>
        <div className="mt-1 break-all font-mono text-xs">
          {endUser.isLoading ? 'resolving…' : (endUser.data?.userId ?? 'not signed in')}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Lumen runs its own login. This identity is attached to every session it starts as
          <span className="font-mono"> end_user_ref</span>, server-side, from the signed session —
          the page you are reading cannot set or change it. Upstream sees only the operator&apos;s
          one API key, so this value is the only thing that tells your sessions apart from another
          signed-in person&apos;s.
        </p>
      </div>

      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-brand" />
          <span className="text-sm font-medium">Sessions attributed to you here</span>
          <span className="ml-auto font-mono text-sm">
            {sessions.isLoading ? <Loading className="size-3.5" /> : (sessions.data?.length ?? '—')}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          The list is narrowed before it reaches this browser: the server rewrites the session-list
          read to your own <span className="font-mono">end_user_ref</span>. Sign in as a second
          email in another browser and the two counts stay disjoint — and this project is not even
          reachable from that second account, because a wrapper user only ever sees the projects
          they provisioned themselves.
        </p>
        {/* The rewrite described above, as the request it produces — the query
            param is on the wire, but the browser is not what puts it there. */}
        <div className="mt-1.5">
          <CallSnippet
            id="sessions.list"
            context={{ projectId, endUserRef: endUser.data?.userId }}
          />
        </div>
      </div>

      <ForgedReadProbe projectId={projectId} signedInAs={endUser.data?.userId ?? null} />
    </div>
  );
}

/**
 * Ask upstream for somebody else's sessions, on purpose.
 *
 * The claim above is only worth as much as its enforcement, and this is the
 * exact request a malicious client would make. A REFUSAL is the pass condition
 * — so a 200 is rendered as a failure, loudly, rather than as a successful call.
 */
function ForgedReadProbe({
  projectId,
  signedInAs,
}: {
  projectId: string;
  signedInAs: string | null;
}) {
  const [target, setTarget] = useState('');
  const [outcome, setOutcome] = useState<{ refused: boolean; text: string } | null>(null);

  const probe = useMutation({
    mutationFn: (endUserRef: string) =>
      kortix.project(projectId).sessions.list({ end_user_ref: endUserRef }),
    onMutate: () => setOutcome(null),
    onSuccess: (rows) =>
      setOutcome({
        refused: false,
        text: `The read was NOT refused — it returned ${rows.length} session(s). The end-user filter is not being enforced.`,
      }),
    onError: (err) => {
      const body = serverErrorBody(err);
      const status = (err as { status?: number }).status;
      setOutcome({
        refused: status === 403,
        text:
          typeof body?.error === 'string' && body.error
            ? `${status ?? 'Error'}: ${body.error}`
            : `${status ?? 'Error'}: refused.`,
      });
    },
  });

  const other = target.trim();
  const sameAsMe = signedInAs !== null && other.toLowerCase() === signedInAs.toLowerCase();

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="text-sm font-medium">Try to read another end-user&apos;s sessions</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Sends the session list read with somebody else&apos;s{' '}
        <span className="font-mono">end_user_ref</span>. Being refused is the point.
      </p>
      <div className="mt-2 flex gap-2">
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="someone-else@example.com"
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!other || sameAsMe || probe.isPending}
          onClick={() => probe.mutate(other)}
        >
          {probe.isPending ? <Loading className="size-3.5" /> : null}
          Try it
        </Button>
      </div>
      {sameAsMe && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          That is your own identity — the server accepts it because it agrees. Use a different
          address.
        </p>
      )}
      {outcome && (
        <div
          className={`mt-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
            outcome.refused
              ? 'border-emerald-500/40 bg-emerald-500/5'
              : 'border-destructive/40 bg-destructive/5'
          }`}
        >
          {outcome.refused ? (
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          )}
          <span className="min-w-0 break-words">{outcome.text}</span>
        </div>
      )}
    </div>
  );
}
