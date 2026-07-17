'use client';

/**
 * ONE on-system permission surface (Task WS5-P1-c) — collapses the two
 * "amber twin" prompts that used to stack above the composer:
 *
 *  - `AcpSessionPermissionPrompt` (deleted as a standalone implementation,
 *    now a re-export of this component): the ACP wire-level tool permission
 *    card (`session/request_permission`), answered through `onReply`.
 *  - `SessionApprovalPrompt` (same): the project connector "requires
 *    approval" card, answered through `useResolveApproval`.
 *
 * Both domains render as rows in the SAME design-system container
 * (`bg-popover rounded-md border` — no `amber-*`, ever). They stay two
 * genuinely different backends under the hood (an ACP permission is
 * answered by resuming a blocked JSON-RPC call; a connector action is
 * answered by a REST mutation against the session audit trail) — this
 * component is the seam that makes them look and behave like one surface,
 * not a rewrite of either backend.
 *
 * Persistent policy (Task WS5-P1-a/b, `usePermissionPolicy`) layers ONLY on
 * top of the ACP side, through the exact same `onReply` respond path the
 * manual buttons use (mirroring the session-scoped auto-approve backstop
 * already in `useAcpSession` — see that file's `autoApprovePermissions`
 * effect): `autoApprove: 'reads'` auto-answers read-only ACP kinds,
 * `autoApprove: 'all'` auto-answers everything, and a remembered
 * `toolDecisions[tool]` auto-answers (allow OR deny) that exact tool on
 * every future request. `usePermissionPolicy` defaults to
 * `{autoApprove:'none', toolDecisions:{}}` while its query is loading, so
 * nothing is ever auto-answered before the real policy is known
 * (deny-by-default, per that hook's own contract). The connector side keeps
 * its own separate, pre-existing persistent mechanism (the project-policy
 * "Always allow" footer, `listProjectPolicies`/`setProjectPolicies`) —
 * untouched, just re-skinned onto the same tokens.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { PERMISSION_LABELS } from '@/ui/types';
import {
  resolvePermissionActionOptions,
  type AcpJsonRpcId,
  type AcpPendingOption,
  type AcpPendingPermission,
} from '@kortix/sdk';
import {
  listProjectPolicies,
  setProjectPolicies,
  type SessionAuditAction,
} from '@kortix/sdk/projects-client';
import { usePermissionPolicy } from '@kortix/sdk/react';
import { Check, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isPendingAction,
  relativeTime,
  riskTone,
  useResolveApproval,
  useSessionAudit,
} from '../session-audit-shared';

/** ACP permission `kind`s that never mutate the sandbox — the only kinds a
 *  project policy's `autoApprove: 'reads'` is allowed to wave through.
 *  Deliberately excludes `mcp` (arbitrary third-party tool, no way to know
 *  its side effects) and `doom_loop` (a repeat-detection warning, never a
 *  routine read).
 *
 *  Deliberately excludes `webfetch` too (WS5-P1-c review, Important #2):
 *  network egress is an SSRF/exfiltration axis, not a local read — a
 *  "reads-only" auto-approve should not silently let a session make
 *  outbound requests on the user's behalf. The repo's own tool taxonomy
 *  (`apps/web/src/ui/types.ts`'s `PERMISSION_LABELS`, `packages/sdk`'s
 *  `turns/tool-registry.ts`) already keeps `webfetch` as its own category,
 *  separate from `read`/`list`/`glob`/`grep`. Widening this set back to
 *  include `webfetch` is a deliberate PRODUCT decision, not a bug fix — see
 *  "Open decisions" #-1 in `docs/superpowers/plans/2026-07-15-cortex-cycle-progress.md`
 *  (Jay: keep narrow vs. widen with UI copy disclosure). Do not re-add it
 *  here without that decision being made explicitly. */
const READ_ONLY_PERMISSION_KINDS = new Set(['read']);

/** How long an answered row stays visible as a compact record before the
 *  container quietly drops it — long enough to register as feedback, short
 *  enough not to accumulate clutter across a long session. */
const RECORD_ROW_VISIBLE_MS = 2_200;

/** Effective hit-area expansion for the compact `size="sm"` action buttons
 *  this surface uses everywhere ("Deny" / "Allow once" / "Allow for
 *  session" / extra ACP options) — an invisible `after:` pseudo-element
 *  widens the clickable region without changing the visible button size. */
const ACTION_BUTTON_CLASS = 'h-9 px-3 relative after:absolute after:-inset-1 active:scale-[0.96]';

function optionValue(option: AcpPendingOption): string {
  return String(option.optionId ?? option.id ?? option.value ?? '');
}

function permissionLabel(permission: AcpPendingPermission): string {
  return PERMISSION_LABELS[permission.permission] || permission.permission;
}

function permissionDetail(permission: AcpPendingPermission): string | null {
  return permission.patterns.length ? permission.patterns.join('  ') : null;
}

/** The fully-qualified tool path project policies match (`slug.path`). The
 *  audit trail already stores the qualified form in `action`; the slug is
 *  only prepended defensively if a row ever carries the relative form. */
function qualifiedConnectorAction(a: SessionAuditAction): string | null {
  if (!a.connector) return null;
  return a.action.startsWith(`${a.connector}.`) ? a.action : `${a.connector}.${a.action}`;
}

/** Row swap animation: pending prompt -> compact answered record. Same
 *  `{duration:0.3, bounce:0}` spring family as `acp-request-cards.tsx`'s
 *  `cardSwapVariants`, but deliberately asymmetric (design law: "exit
 *  subtler than enter") — kept local rather than imported since the two
 *  components' swap semantics genuinely differ (that one swaps a whole
 *  card; this one swaps individual rows inside a shared container). */
export function rowSwapVariants(reduced: boolean) {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { type: 'spring' as const, duration: 0.3, bounce: 0 },
    };
  }
  return {
    initial: { opacity: 0, scale: 0.98, filter: 'blur(4px)' },
    animate: { opacity: 1, scale: 1, filter: 'blur(0px)' },
    exit: { opacity: 0, scale: 0.995, filter: 'blur(1.5px)' },
    transition: { type: 'spring' as const, duration: 0.3, bounce: 0 },
  };
}

function RecordRow({ label, tone, motionProps }: {
  label: string;
  tone: 'positive' | 'negative';
  motionProps: ReturnType<typeof rowSwapVariants>;
}) {
  return (
    <motion.div
      {...motionProps}
      data-testid="permission-record-row"
      className="flex items-center gap-3 py-1.5"
    >
      <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-sm', tone === 'negative' ? 'bg-kortix-red/15' : 'bg-kortix-green/15')}>
        {tone === 'negative' ? <X className="text-kortix-red size-3.5" /> : <Check className="text-kortix-green size-3.5" />}
      </span>
      <span className="text-muted-foreground min-w-0 truncate text-xs">{label}</span>
    </motion.div>
  );
}

export interface PermissionPromptProps {
  /** Owns both request domains: the ACP permission-policy backstop
   *  (`usePermissionPolicy`) and the connector-approval audit query
   *  (`useSessionAudit`) are both keyed by project. */
  projectId: string;
  /** The Kortix (route) session id — NOT the runtime/ACP session id — the
   *  same id `useSessionAudit`/`useResolveApproval` key their query on. */
  sessionId: string;
  permissions: AcpPendingPermission[];
  /** Session-scoped client-side "allow everything" backstop, owned by
   *  `useAcpSession` (survives this component remounting). */
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;
  /** The ACP respond path — every ACP answer in this component (manual
   *  click, "allow everything", or a policy auto-answer) goes through this
   *  SAME function. Never invent a parallel respond. */
  onReply: (id: AcpJsonRpcId, optionId?: string) => Promise<void> | void;
}

export function PermissionPrompt({
  projectId,
  sessionId,
  permissions,
  autoApprove,
  onAutoApproveChange,
  onReply,
}: PermissionPromptProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const rowMotion = rowSwapVariants(reduceMotion);

  const { policy, rememberToolDecision } = usePermissionPolicy(projectId);

  const { data: audit } = useSessionAudit(projectId, sessionId, { refetchInterval: 5_000 });
  const resolveConnector = useResolveApproval(projectId, sessionId);
  const canWritePolicies = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
  const pendingConnectorActions = (audit?.actions ?? []).filter(isPendingAction);

  // Which control is loading: `${idKey}:once|session|deny`, `all`, or
  // `policy:${qualifiedAction}`.
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);

  // Transient answered-record rows — keyed by a stable id per resolved
  // request, auto-cleared after `RECORD_ROW_VISIBLE_MS`.
  const [records, setRecords] = useState<Record<string, { label: string; tone: 'positive' | 'negative' }>>({});
  const recordTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const addRecord = useCallback((key: string, label: string, tone: 'positive' | 'negative') => {
    setRecords((current) => ({ ...current, [key]: { label, tone } }));
    const existing = recordTimeouts.current[key];
    if (existing) clearTimeout(existing);
    recordTimeouts.current[key] = setTimeout(() => {
      setRecords((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      delete recordTimeouts.current[key];
    }, RECORD_ROW_VISIBLE_MS);
  }, []);

  useEffect(() => {
    const timeouts = recordTimeouts.current;
    return () => {
      for (const t of Object.values(timeouts)) clearTimeout(t);
    };
  }, []);

  const replyAcp = useCallback(
    async (permission: AcpPendingPermission, kind: 'once' | 'session' | 'deny', option: AcpPendingOption | null) => {
      const idKey = JSON.stringify(permission.id);
      setBusy(`${idKey}:${kind}`);
      try {
        await onReply(permission.id, option ? optionValue(option) : undefined);
        addRecord(idKey, `${kind === 'deny' ? 'Denied' : 'Allowed'} — ${permissionLabel(permission)}`, kind === 'deny' ? 'negative' : 'positive');
      } catch (e) {
        errorToast(e instanceof Error ? e.message : 'Failed to answer the permission request');
      } finally {
        setBusy((current) => (current === `${idKey}:${kind}` ? null : current));
      }
    },
    [onReply, addRecord],
  );

  const remember = useCallback(
    (tool: string, decision: 'allow' | 'deny') => {
      void rememberToolDecision(tool, decision).catch((e) => {
        errorToast(e instanceof Error ? e.message : 'Failed to remember this decision for the project');
      });
    },
    [rememberToolDecision],
  );

  // Persistent-policy auto-answer backstop — mirrors `useAcpSession`'s own
  // session-autoApprove effect (same dedupe-by-id-ref shape), but driven by
  // the PROJECT policy instead of the session toggle, and going through the
  // exact same `onReply` prop. A remembered `toolDecisions[tool]` wins over
  // `autoApprove`; `autoApprove: 'all'` waves through everything;
  // `autoApprove: 'reads'` only waves through read-only kinds.
  const autoAnsweredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const permission of permissions) {
      const idKey = JSON.stringify(permission.id);
      if (autoAnsweredRef.current.has(idKey)) continue;
      // `permission.permission` is itself a fallback chain (`projectPermission`
      // in `@kortix/sdk`'s `acp/reduce.ts`: `params.permission ?? params.title
      // ?? params.name ?? toolCall.title ?? toolCall.kind ?? params.kind ??
      // method`) — this component assumes whichever field wins is a STABLE
      // tool identifier worth persisting a `toolDecisions[tool]` policy
      // against, not a one-off human-readable title. Holds for every harness
      // observed so far; if a future harness's wire shape ever makes a
      // free-text `title` win over a stable `kind`/`name`, remembered
      // decisions would key on that text instead.
      const tool = permission.permission;
      const remembered = policy.toolDecisions[tool];
      const shouldAllow =
        remembered === 'allow' ||
        policy.autoApprove === 'all' ||
        (policy.autoApprove === 'reads' && READ_ONLY_PERMISSION_KINDS.has(tool));
      const shouldDeny = remembered === 'deny';
      if (!shouldAllow && !shouldDeny) continue;
      autoAnsweredRef.current.add(idKey);
      const { allowOnce, deny } = resolvePermissionActionOptions(permission.options);
      const option = shouldDeny ? deny : allowOnce;
      // Record only AFTER `onReply` actually resolves — matching the manual
      // path (`replyAcp`, below). Recording before the round-trip completes
      // would show "Allowed"/"Denied" for a request that never actually got
      // answered on a transient `onReply` failure (WS5-P1-c review,
      // Important #3): the row would look resolved while the real request
      // was still sitting open server-side. On failure, `addRecord` is
      // skipped entirely, `autoAnsweredRef` is un-marked so a later render
      // can retry, and the row stays visible in the pending list —
      // `visiblePermissions` only filters out ids already IN `records`, so
      // never adding the record here is exactly what keeps it visible.
      void Promise.resolve(onReply(permission.id, option ? optionValue(option) : undefined))
        .then(() => {
          addRecord(
            idKey,
            `${shouldDeny ? 'Denied' : 'Allowed'} — ${permissionLabel(permission)} (project policy)`,
            shouldDeny ? 'negative' : 'positive',
          );
        })
        .catch((e) => {
          autoAnsweredRef.current.delete(idKey);
          errorToast(e instanceof Error ? e.message : 'Failed to auto-answer the permission request');
        });
    }
  }, [permissions, policy, onReply, addRecord]);

  const decideConnector = (
    executionId: string,
    decision: 'approve' | 'deny',
    scope: 'once' | 'session' = 'once',
  ) => {
    const busyKey = `${executionId}:${decision === 'deny' ? 'deny' : scope}`;
    setBusy(busyKey);
    resolveConnector.mutate(
      { executionId, decision, scope },
      {
        onSuccess: () =>
          addRecord(
            executionId,
            decision === 'deny' ? 'Denied' : scope === 'session' ? 'Allowed — this session' : 'Allowed',
            decision === 'deny' ? 'negative' : 'positive',
          ),
        onError: (e: unknown) => errorToast(e instanceof Error ? e.message : 'Failed to resolve approval'),
        onSettled: () => setBusy((current) => (current === busyKey ? null : current)),
      },
    );
  };

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
      const covered = pendingConnectorActions.filter((a) => qualifiedConnectorAction(a) === qualified);
      await Promise.all(
        covered.map(
          (a) =>
            new Promise<void>((resolve, reject) => {
              resolveConnector.mutate(
                { executionId: a.execution_id, decision: 'approve', scope: 'once' },
                { onSuccess: () => resolve(), onError: reject },
              );
            }),
        ),
      );
      addRecord(`policy:${qualified}`, `"${qualified}" always runs in this project now`, 'positive');
    } catch (e) {
      errorToast(e instanceof Error ? e.message : 'Failed to update project policies');
    } finally {
      setBusy(null);
    }
  };

  // "Allow everything for this session" — a single consequential action
  // gated behind `ConfirmDialog`. Covers both domains: flips the ACP
  // session-autoApprove backstop on and answers every currently-pending ACP
  // permission through the SAME `onReply`; resolves every pending connector
  // action (the first with the wildcard `session_all` scope, matching the
  // server's per-connector grant semantics, the rest `once`). Each bulk-
  // replied row gets its own `addRecord` after ITS OWN reply resolves
  // (consistency with every other answer path — manual clicks, the policy
  // auto-answer effect — none of which show a bare vanish; a bulk action
  // shouldn't either).
  const confirmAllowEverything = useCallback(async () => {
    setBusy('all');
    try {
      onAutoApproveChange(true);
      await Promise.all(
        permissions.map(async (permission) => {
          const { allowOnce } = resolvePermissionActionOptions(permission.options);
          await onReply(permission.id, allowOnce ? optionValue(allowOnce) : undefined);
          addRecord(JSON.stringify(permission.id), `Allowed — ${permissionLabel(permission)}`, 'positive');
        }),
      );
      if (pendingConnectorActions.length) {
        const [first, ...rest] = pendingConnectorActions;
        await new Promise<void>((resolve, reject) => {
          resolveConnector.mutate(
            { executionId: first!.execution_id, decision: 'approve', scope: 'session_all' },
            {
              onSuccess: () => {
                addRecord(first!.execution_id, 'Allowed — this session', 'positive');
                resolve();
              },
              onError: reject,
            },
          );
        });
        await Promise.all(
          rest.map(
            (a) =>
              new Promise<void>((resolve, reject) => {
                resolveConnector.mutate(
                  { executionId: a.execution_id, decision: 'approve', scope: 'once' },
                  {
                    onSuccess: () => {
                      addRecord(a.execution_id, 'Allowed', 'positive');
                      resolve();
                    },
                    onError: reject,
                  },
                );
              }),
          ),
        );
      }
    } catch (e) {
      errorToast(e instanceof Error ? e.message : 'Failed to allow everything for this session');
    } finally {
      setBusy(null);
      setConfirmAllOpen(false);
    }
  }, [permissions, pendingConnectorActions, onReply, onAutoApproveChange, resolveConnector, addRecord]);

  const qualifiedConnectorActions = [
    ...new Set(pendingConnectorActions.map(qualifiedConnectorAction).filter((q): q is string => !!q)),
  ];

  const hasRecords = Object.keys(records).length > 0;
  const hasPending = permissions.length > 0 || pendingConnectorActions.length > 0;

  if (!autoApprove && !hasPending && !hasRecords) return null;

  // A row that already has an answered record (manual click or policy
  // auto-answer, both of which call `addRecord` synchronously) stops
  // rendering as a pending prompt immediately — it does not wait for the
  // parent's `permissions`/audit props to catch up and drop it. Without
  // this, the SAME id can briefly appear as both a pending row and a
  // record row (a real possibility: the record is added synchronously,
  // the prop update that removes the id from `permissions` lands on the
  // next render), which is both a confusing double-render and a duplicate
  // React key.
  const visiblePermissions = permissions.filter((permission) => !(JSON.stringify(permission.id) in records));
  const visibleConnectorActions = pendingConnectorActions.filter((a) => !(a.execution_id in records));

  return (
    <div data-testid="acp-session-permission-prompt" className="bg-popover mb-2 rounded-md border px-4 py-3">
      {hasPending || hasRecords ? (
        <div className="mb-3 flex items-center gap-3">
          <span className="bg-kortix-yellow/15 flex size-9 shrink-0 items-center justify-center rounded-sm">
            <ShieldAlert className="text-kortix-yellow size-5" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium">Needs your permission</div>
            <div className="text-muted-foreground text-xs">Paused until you decide</div>
          </div>
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {visiblePermissions.map((permission) => {
          const idKey = JSON.stringify(permission.id);
          const { allowOnce, allowSession, deny, extra } = resolvePermissionActionOptions(permission.options);
          const detail = permissionDetail(permission);
          const tool = permission.permission;
          const remembered = policy.toolDecisions[tool] === 'allow';
          const rowBusy = busy?.startsWith(`${idKey}:`) ? busy.split(':')[1] : null;
          return (
            <motion.div key={idKey} {...rowMotion} className="border-border/60 space-y-2 border-b py-2 last:border-b-0 last:pb-0">
              <div>
                <div className="text-xs font-medium">{permissionLabel(permission)}</div>
                {detail ? (
                  <code title={detail} className="text-muted-foreground mt-0.5 block truncate font-mono text-[11px]">
                    {detail}
                  </code>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline-ghost"
                  className={cn(ACTION_BUTTON_CLASS, 'hover:bg-destructive/10 hover:text-destructive')}
                  disabled={!!busy}
                  onClick={() => void replyAcp(permission, 'deny', deny)}
                >
                  {rowBusy === 'deny' ? <Loading className="size-3 animate-spin" /> : null}
                  Deny
                </Button>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className={ACTION_BUTTON_CLASS}
                    data-testid="acp-permission-allow-once"
                    disabled={!!busy}
                    onClick={() => void replyAcp(permission, 'once', allowOnce)}
                  >
                    {rowBusy === 'once' ? <Loading className="size-3 animate-spin" /> : null}
                    Allow once
                  </Button>
                  {extra.map((option) => (
                    <Button
                      key={optionValue(option)}
                      size="sm"
                      variant="outline"
                      className={ACTION_BUTTON_CLASS}
                      disabled={!!busy}
                      onClick={() => void replyAcp(permission, 'once', option)}
                    >
                      {option.label}
                    </Button>
                  ))}
                  {allowSession ? (
                    <Button
                      size="sm"
                      variant="default"
                      className={ACTION_BUTTON_CLASS}
                      title="Allow this action for the rest of this session — the agent won't ask again for it"
                      disabled={!!busy}
                      onClick={() => void replyAcp(permission, 'session', allowSession)}
                    >
                      {rowBusy === 'session' ? <Loading className="size-3 animate-spin" /> : null}
                      Allow for session
                    </Button>
                  ) : null}
                </div>
              </div>
              {/* `Switch`'s own `label` prop renders the text as an inert
                  sibling `<span>` — clicking it does nothing, since a
                  non-form-control `<button role="switch">` gets no native
                  label-click delegation. Wrapping it here (instead of using
                  that prop) gives the whole row a real ≥40px-tall click
                  target, not just the 20px track. */}
              <div
                className="-mx-3 -my-1 flex cursor-pointer items-center gap-2.5 px-3 py-2 select-none"
                onClick={() => {
                  if (!remembered) remember(tool, 'allow');
                }}
              >
                <Switch
                  aria-label="Remember for this project"
                  checked={remembered}
                  disabled={!!busy}
                  onCheckedChange={(checked) => {
                    if (checked) remember(tool, 'allow');
                  }}
                />
                <span className={cn('text-sm transition-colors duration-80', remembered ? 'text-foreground' : 'text-muted-foreground')}>
                  Remember for this project
                </span>
              </div>
            </motion.div>
          );
        })}

        {visibleConnectorActions.map((a) => {
          const rowBusy = busy?.startsWith(`${a.execution_id}:`) ? busy.split(':')[1] : null;
          const qualified = qualifiedConnectorAction(a);
          return (
            <motion.div key={a.execution_id} {...rowMotion} className="border-border/60 space-y-2 border-b py-2 last:border-b-0 last:pb-0">
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">Run</span>
                  <code title={qualified ?? a.action} className="text-foreground truncate font-mono text-xs font-medium">
                    {a.action}
                  </code>
                  {a.risk ? (
                    <Badge variant={riskTone(a.risk)} size="xs" className="shrink-0 capitalize">
                      {a.risk}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground mt-0.5 text-[11px]">Requested {relativeTime(a.at)}</p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline-ghost"
                  className={cn(ACTION_BUTTON_CLASS, 'hover:bg-destructive/10 hover:text-destructive')}
                  disabled={!!busy}
                  onClick={() => decideConnector(a.execution_id, 'deny')}
                >
                  {rowBusy === 'deny' ? <Loading className="size-3 animate-spin" /> : null}
                  Deny
                </Button>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className={ACTION_BUTTON_CLASS}
                    disabled={!!busy}
                    onClick={() => decideConnector(a.execution_id, 'approve', 'once')}
                  >
                    {rowBusy === 'once' ? <Loading className="size-3 animate-spin" /> : null}
                    Allow once
                  </Button>
                  <Button
                    size="sm"
                    variant="default"
                    className={ACTION_BUTTON_CLASS}
                    title="Allow this action for the rest of this session — the agent won't ask again for it"
                    disabled={!!busy}
                    onClick={() => decideConnector(a.execution_id, 'approve', 'session')}
                  >
                    {rowBusy === 'session' ? <Loading className="size-3 animate-spin" /> : null}
                    Allow for session
                  </Button>
                </div>
              </div>
            </motion.div>
          );
        })}

        {Object.entries(records).map(([key, record]) => (
          <RecordRow key={key} label={record.label} tone={record.tone} motionProps={rowMotion} />
        ))}
      </AnimatePresence>

      {autoApprove ? (
        <div data-testid="acp-session-permission-autoapprove" className="bg-muted/40 mt-3 flex items-center gap-2 rounded-md border px-3 py-1.5">
          <ShieldCheck className="text-muted-foreground size-3.5" />
          <span className="text-muted-foreground flex-1 text-[11px]">
            Auto-allowing all permission requests for this session
          </span>
          <Button size="xs" variant="ghost" className="active:scale-[0.96]" onClick={() => onAutoApproveChange(false)}>
            Turn off
          </Button>
        </div>
      ) : null}

      {hasPending ? (
        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-muted-foreground text-[11px]">This session</span>
          <Button
            size="sm"
            variant="ghost"
            className={cn(ACTION_BUTTON_CLASS, 'text-muted-foreground hover:text-foreground')}
            title="Allow every pending permission and gated action for the rest of this session"
            disabled={!!busy}
            onClick={() => setConfirmAllOpen(true)}
          >
            Allow everything
          </Button>
        </div>
      ) : null}

      {canWritePolicies.allowed && qualifiedConnectorActions.length > 0 ? (
        // Deliberately set apart from the one-off buttons above: these WRITE
        // the project's connector policy config — every future session
        // stops asking. Unchanged behavior from `SessionApprovalPrompt`.
        <div className="bg-muted/40 border-border/40 mt-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5">
          <span className="text-muted-foreground text-[11px]">
            Project policy <span className="opacity-70">(applies to future sessions)</span>:
          </span>
          {qualifiedConnectorActions.map((qualified) => (
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

      <ConfirmDialog
        open={confirmAllOpen}
        onOpenChange={setConfirmAllOpen}
        title="Allow everything for this session?"
        description="The agent won't ask for permission again this session — every pending and future tool call and gated action is auto-approved until you turn it off."
        confirmLabel="Yes, allow everything"
        onConfirm={() => void confirmAllowEverything()}
        isPending={busy === 'all'}
      />
    </div>
  );
}
