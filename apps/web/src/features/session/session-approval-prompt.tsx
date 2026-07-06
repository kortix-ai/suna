'use client';

/**
 * Inline "agent needs your approval" prompt, pinned above the composer — the
 * in-session face of a connector action a policy gated as `require_approval`.
 * Mirrors opencode's native tool-permission prompt (SessionPermissionPrompt)
 * so it feels native: approve lets the paused run proceed, deny refuses it and
 * the agent continues.
 *
 * Decision scopes, visually separated by how long they last:
 *  - per request: Deny / Allow once / Allow for session (this exact action,
 *    rest of this session)
 *  - per session: "Allow everything" — a `*` wildcard session grant, so no
 *    gated action asks again this session
 *  - persistent (footer, gated on `project.connector.write`): prepend an
 *    `always_run` project policy for this tool — future sessions stop asking.
 *
 * Self-contained: reads projectId + the (Kortix) session id from the route and
 * shares the session-audit query with the header nudge + Audit panel, so all
 * three stay in lockstep.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  isPendingAction,
  relativeTime,
  riskTone,
  useResolveApproval,
  useSessionAudit,
} from '@/features/session/session-audit-shared';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type SessionAuditAction,
  listProjectPolicies,
  setProjectPolicies,
} from '@kortix/sdk/projects-client';
import { ShieldAlert } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';

/** The fully-qualified tool path project policies match (`slug.path`). The
 *  audit trail already stores the qualified form in `action`; the slug is only
 *  prepended defensively if a row ever carries the relative form. */
function qualifiedAction(a: SessionAuditAction): string | null {
  if (!a.connector) return null;
  return a.action.startsWith(`${a.connector}.`) ? a.action : `${a.connector}.${a.action}`;
}

export function SessionApprovalPrompt() {
  const { id: projectId, sessionId: projectSessionId } = useParams<{
    id: string;
    sessionId: string;
  }>();
  // Poll a touch faster than the panel/nudge — this is the blocking gate the
  // user is actively waiting on.
  const { data } = useSessionAudit(projectId, projectSessionId, { refetchInterval: 5_000 });
  const resolve = useResolveApproval(projectId, projectSessionId);
  const canWritePolicies = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  // Which button is loading: `${executionId}:deny|once|session`, 'session-all',
  // or `policy:${qualifiedAction}`.
  const [busy, setBusy] = useState<string | null>(null);

  const pending = (data?.actions ?? []).filter(isPendingAction);
  if (pending.length === 0) return null;

  const decide = (
    executionId: string,
    decision: 'approve' | 'deny',
    scope: 'once' | 'session' = 'once',
  ) => {
    setBusy(`${executionId}:${decision === 'deny' ? 'deny' : scope}`);
    resolve.mutate(
      { executionId, decision, scope },
      {
        onSuccess: () =>
          successToast(
            decision === 'deny'
              ? 'Denied'
              : scope === 'session'
                ? "Allowed — won't ask again for this action this session"
                : 'Approved — the agent will continue',
          ),
        onError: (e: unknown) =>
          errorToast(e instanceof Error ? e.message : 'Failed to resolve approval'),
        onSettled: () => setBusy(null),
      },
    );
  };

  // "Allow everything for this session": resolve the first pending row with the
  // wildcard scope (the server records a `*` grant per connector), then release
  // any other rows already pending — the wildcard only stops FUTURE asks.
  const allowAllForSession = async () => {
    setBusy('session-all');
    try {
      const [first, ...rest] = pending;
      await resolve.mutateAsync({
        executionId: first.execution_id,
        decision: 'approve',
        scope: 'session_all',
      });
      await Promise.all(
        rest.map((a) =>
          resolve.mutateAsync({ executionId: a.execution_id, decision: 'approve', scope: 'once' }),
        ),
      );
      successToast("Allowed — won't ask again for anything this session");
    } catch (e) {
      errorToast(e instanceof Error ? e.message : 'Failed to resolve approvals');
    } finally {
      setBusy(null);
    }
  };

  // Persist "always run this tool" into the project's policies (kortix.toml
  // [[policies]] — the same list the Policies panel edits), then release the
  // pending rows it covers. PREPENDED: policy resolution is first-match-wins,
  // so the new allow must outrank an existing require_approval pattern.
  const alwaysRunInPolicy = async (qualified: string) => {
    if (!projectId) return;
    setBusy(`policy:${qualified}`);
    try {
      const current = await listProjectPolicies(projectId);
      const withoutDup = (current.policies ?? []).filter((p) => p.match !== qualified);
      await setProjectPolicies(
        projectId,
        [{ match: qualified, action: 'always_run' }, ...withoutDup],
        current.defaultMode ?? 'risk',
      );
      const covered = pending.filter((a) => qualifiedAction(a) === qualified);
      await Promise.all(
        covered.map((a) =>
          resolve.mutateAsync({ executionId: a.execution_id, decision: 'approve', scope: 'once' }),
        ),
      );
      successToast(`Saved — "${qualified}" always runs in this project now`);
    } catch (e) {
      errorToast(e instanceof Error ? e.message : 'Failed to update project policies');
    } finally {
      setBusy(null);
    }
  };

  const qualifiedActions = [
    ...new Set(pending.map(qualifiedAction).filter((q): q is string => !!q)),
  ];

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20">
      <div className="flex items-center gap-2 border-amber-500/20 border-b px-3 py-1.5">
        <ShieldAlert className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-foreground text-xs font-semibold tracking-tight">
          {pending.length === 1
            ? 'The agent needs your approval'
            : `${pending.length} actions need your approval`}
        </span>
        <span className="text-muted-foreground text-[11px]">— it's paused until you decide</span>
      </div>
      <ul className="divide-amber-500/15 divide-y">
        {pending.map((a) => {
          const rowBusy = busy?.startsWith(`${a.execution_id}:`) ? busy.split(':')[1] : null;
          return (
            <li key={a.execution_id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">Run</span>
                  <code
                    title={qualifiedAction(a) ?? a.action}
                    className="text-foreground truncate font-mono text-xs font-medium"
                  >
                    {a.action}
                  </code>
                  {a.risk ? (
                    <Badge variant={riskTone(a.risk)} size="xs" className="shrink-0 capitalize">
                      {a.risk}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-0.5 text-[11px]">
                  Requested {relativeTime(a.at)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="xs"
                  variant="muted"
                  className={cn('hover:bg-destructive/10 hover:text-destructive')}
                  disabled={!!busy}
                  onClick={() => decide(a.execution_id, 'deny')}
                >
                  {rowBusy === 'deny' ? <Loading className="size-3 animate-spin" /> : null}
                  Deny
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  title="Allow this action for the rest of this session — the agent won't ask again for it"
                  disabled={!!busy}
                  onClick={() => decide(a.execution_id, 'approve', 'session')}
                >
                  {rowBusy === 'session' ? <Loading className="size-3 animate-spin" /> : null}
                  Allow for session
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={!!busy}
                  onClick={() => decide(a.execution_id, 'approve', 'once')}
                >
                  {rowBusy === 'once' ? <Loading className="size-3 animate-spin" /> : null}
                  Allow once
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2 border-amber-500/15 border-t px-3 py-1.5">
        <span className="text-muted-foreground text-[11px]">This session:</span>
        <Button
          size="xs"
          variant="ghost"
          title="Allow every gated action for the rest of this session"
          disabled={!!busy}
          onClick={() => void allowAllForSession()}
        >
          {busy === 'session-all' ? <Loading className="size-3 animate-spin" /> : null}
          Allow everything
        </Button>
      </div>
      {canWritePolicies.allowed && qualifiedActions.length > 0 ? (
        // Deliberately set apart from the one-off buttons above: these WRITE the
        // project's policy config — every future session stops asking.
        <div className="bg-muted/40 border-border/40 flex flex-wrap items-center gap-2 border-t px-3 py-1.5">
          <span className="text-muted-foreground text-[11px]">
            Project policy <span className="opacity-70">(applies to future sessions)</span>:
          </span>
          {qualifiedActions.map((qualified) => (
            <Button
              key={qualified}
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              disabled={!!busy}
              onClick={() => void alwaysRunInPolicy(qualified)}
            >
              {busy === `policy:${qualified}` ? <Loading className="size-3 animate-spin" /> : null}
              Always allow "{qualified}"
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
