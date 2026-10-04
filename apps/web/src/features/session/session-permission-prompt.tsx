'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * Inline "agent needs your permission" prompt, pinned above the composer — the
 * runtime tool-permission twin of `SessionApprovalPrompt` (connector
 * approvals). Answering resumes the agent's already-blocked turn in place (the
 * runtime holds the tool call open until `/permission/{id}/reply`), so no
 * follow-up "continue" message is ever needed. A request names a capability
 * (`bash`, `edit`, …), not a harness's tool.
 *
 * Three decision scopes, visually separated by how long they last:
 *  - per request: Deny / Allow once / Allow for session (the `always` reply —
 *    this capability or pattern, rest of this session)
 *  - per session: "Allow everything" writes a blanket allow ruleset onto the
 *    runtime session (survives tab close) + auto-approves anything already
 *    pending; a client-side auto-approver backstops any ask that still arrives.
 *  - persistent (footer, gated on `project.agent.write` and an editable v2
 *    agent): writes `allow` into the session agent's permission rules (its
 *    `.md`, through the agent-config route) — sessions started after the
 *    commit stop asking; this one allows the capability for the rest of its run.
 */

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAgentConfig, useUpdateAgentConfig } from '@/hooks/projects/use-agent-config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { PERMISSION_LABELS, type PermissionRequest } from '@/ui/types';
import type { PermissionConfig, PermissionRule } from '@kortix/sdk';
import {
  allowAllPermissionsForSession,
  resetSessionPermissions,
  useRuntimePendingStore,
} from '@kortix/sdk/react';
import {
  CaretDownIcon,
  ShieldWarningIcon as ShieldAlert,
  ShieldCheckIcon as ShieldCheck,
} from '@phosphor-icons/react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * An agent's permission rules with `type` allowed: a bare action becomes the
 * `*` fallback of the object form, and `*` ("always allow everything") also
 * flattens every existing rule, so no leftover `ask`/`deny` outranks it.
 */
export function permissionRulesAllowing(
  current: PermissionConfig | undefined,
  type: string,
): Record<string, PermissionRule> {
  const base: Record<string, PermissionRule> =
    typeof current === 'string' ? { '*': current } : current ? { ...current } : {};
  if (type !== '*') return { ...base, [type]: 'allow' };
  return Object.fromEntries([...Object.keys(base), '*'].map((key) => [key, 'allow']));
}

/** Full-text review is only worth an extra click for a detail that won't fit
 * on one line — short commands stay flat, no chevron. */
const EXPANDABLE_DETAIL_LENGTH = 64;

interface SessionPermissionPromptProps {
  /** The runtime session id (what `PermissionRequest.sessionID` carries). */
  sessionId: string;
  /** The agent the session runs: "Allow in config" writes its rules. Absent, the footer hides. */
  agentName?: string;
  permissions: PermissionRequest[];
  /** Must reject on failure so busy states reset and the card stays actionable. */
  onReply: (requestId: string, reply: 'once' | 'always' | 'reject') => Promise<void>;
}

function permissionLabel(p: PermissionRequest): string {
  return PERMISSION_LABELS[p.permission] || p.permission;
}

/** The concrete thing being gated — the request's match patterns (e.g. the
 * bash command), falling back to a metadata title if the runtime sent none. */
function permissionDetail(p: PermissionRequest): string | null {
  if (p.patterns?.length) return p.patterns.join('  ');
  const title = (p.metadata as Record<string, unknown> | undefined)?.title;
  return typeof title === 'string' ? title : null;
}

/** Wraps a permission detail: a real toggle when there is more to reveal,
 *  inert markup when the detail already fits on one line. */
function DetailShell({
  expandable,
  expanded,
  onToggle,
  children,
}: {
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (!expandable) {
    return <div className="mt-0.5 flex w-full items-start gap-1 text-left">{children}</div>;
  }
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="mt-0.5 flex w-full cursor-pointer items-start gap-1 text-left"
    >
      {children}
    </button>
  );
}

/**
 * A button label that swaps to a spinner IN PLACE.
 *
 * Inserting a spinner alongside the label widens the button mid-press. On this
 * card the three decision buttons sit shoulder to shoulder, so a widening
 * "Deny" slides "Allow once" under a cursor that is still on its way down — a
 * mis-click here grants access. Keeping the label in flow (`invisible`, not
 * unmounted) holds the button at exactly its resting width while the reply is
 * in flight.
 */
function PendingLabel({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className={cn('inline-flex items-center', pending && 'invisible')}>{children}</span>
      {pending ? (
        <span className="absolute inset-0 inline-flex items-center justify-center">
          <Loading className="size-3 shrink-0" />
        </span>
      ) : null}
    </span>
  );
}

export function SessionPermissionPrompt({
  sessionId,
  agentName,
  permissions,
  onReply,
}: SessionPermissionPromptProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Only the /projects/[id]/sessions/[sessionId] route has a project in scope —
  // on plain /sessions/[id], `id` IS the session, so no config surface.
  const params = useParams<{ id?: string; sessionId?: string }>();
  const projectId = params?.sessionId ? params.id : undefined;
  const canWriteConfig = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_AGENT_WRITE];

  const autoApprove = useRuntimePendingStore((s) => !!s.autoApproveAllSessions[sessionId]);
  const setAutoApproveAll = useRuntimePendingStore((s) => s.setAutoApproveAll);

  const { data: agentConfig } = useAgentConfig(canWriteConfig.allowed ? projectId : undefined, agentName);
  const updateAgentConfig = useUpdateAgentConfig(projectId ?? '', agentName ?? '');
  const agentBlock = agentConfig?.editable ? agentConfig.block : null;

  // Which button is loading: `${requestId}:once|always|reject`, 'session-all',
  // or `config:${type}` / 'config:*'.
  const [busy, setBusy] = useState<string | null>(null);
  // Request ids currently showing their full (untruncated) detail text.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((requestId: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });
  }, []);

  const reply = useCallback(
    async (requestId: string, kind: 'once' | 'always' | 'reject') => {
      setBusy(`${requestId}:${kind}`);
      try {
        await onReply(requestId, kind);
      } catch (e) {
        errorToast(e instanceof Error ? e.message : tI18nComplete.raw('text088abd95f7eb'));
      } finally {
        setBusy(null);
      }
    },
    [onReply, tI18nComplete],
  );

  const allowAllForSession = useCallback(async () => {
    setBusy('session-all');
    try {
      // Server-side grant first (survives the tab closing). Best-effort: if the
      // runtime rejects the session ruleset, the client-side auto-approver
      // below still delivers the behavior while this tab is open.
      try {
        await allowAllPermissionsForSession(sessionId);
      } catch {
        // fall through to the client-side backstop
      }
      setAutoApproveAll(sessionId, true);
      // The ruleset only stops FUTURE asks — approve what's already pending.
      await Promise.all(permissions.map((p) => onReply(p.id, 'once')));
      successToast(tI18nComplete.raw('text672a76cd238a'));
    } catch (e) {
      errorToast(e instanceof Error ? e.message : tI18nComplete.raw('text292fd30cb1b5'));
    } finally {
      setBusy(null);
    }
  }, [setAutoApproveAll, sessionId, permissions, tI18nComplete, onReply]);

  const turnOffAutoApprove = useCallback(async () => {
    setAutoApproveAll(sessionId, false);
    try {
      await resetSessionPermissions(sessionId);
    } catch {
      // The flag is already off; a stale session ruleset just means fewer asks.
    }
  }, [sessionId, setAutoApproveAll]);

  /** Persist an allow into the session agent's permission rules (the agent
   * editor's surface), then release the pending asks it covers with `always`:
   * the running session keeps the config it started with. `type === '*'` =
   * always allow everything. */
  const allowInConfig = useCallback(
    async (type: string) => {
      if (!agentBlock) return;
      setBusy(`config:${type}`);
      try {
        const { opencode: _legacyBehavior, ...block } = agentBlock;
        const behavior = block.behavior ?? {};
        const next = permissionRulesAllowing(behavior.permission, type);
        await updateAgentConfig.mutateAsync({
          ...block,
          behavior: { ...behavior, permission: next },
        });
        const covered = permissions.filter((p) => type === '*' || p.permission === type);
        await Promise.all(covered.map((p) => onReply(p.id, 'always')));
        successToast(
          type === '*'
            ? tI18nComplete.raw('texte5776302ca62')
            : tI18nComplete('text51a4eefaba47', { value0: PERMISSION_LABELS[type] || type }),
        );
      } catch (e) {
        errorToast(e instanceof Error ? e.message : tI18nComplete.raw('text14085878939d'));
      } finally {
        setBusy(null);
      }
    },
    [agentBlock, updateAgentConfig, permissions, tI18nComplete, onReply],
  );

  // Client-side backstop for "allow everything this session": auto-approve any
  // ask that still arrives (e.g. the runtime ignored the session ruleset).
  const autoRepliedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoApprove) return;
    for (const p of permissions) {
      if (autoRepliedRef.current.has(p.id)) continue;
      autoRepliedRef.current.add(p.id);
      void onReply(p.id, 'once').catch(() => {
        // Let a later effect run retry it (e.g. a transient network blip).
        autoRepliedRef.current.delete(p.id);
      });
    }
  }, [autoApprove, permissions, onReply]);

  // A manifest `skills:` grant outranks the `skill` rule, so writing one would change nothing.
  const uniqueTypes = useMemo(
    () =>
      [...new Set(permissions.map((p) => p.permission))].filter(
        (type) => !(type === 'skill' && agentBlock?.skills !== undefined),
      ),
    [permissions, agentBlock],
  );

  if (autoApprove) {
    return (
      <div className="border-border bg-popover flex w-full items-center gap-2 rounded-md border px-3 py-2">
        <ShieldCheck className="text-kortix-green size-4" />
        <span className="text-muted-foreground flex-1 text-xs">
          {tI18nComplete.raw('text60d3eb13fad7')}
        </span>
        <Button size="xs" variant="ghost" onClick={() => void turnOffAutoApprove()}>
          {tI18nComplete.raw('text06f0e210b27d')}
        </Button>
      </div>
    );
  }

  if (permissions.length === 0) return null;

  return (
    // `w-full`: the composer strip is an `items-center` flex column, which
    // sizes a child to its content unless it says otherwise (composer.tsx).
    <div className="bg-popover border-kortix-orange/25 w-full overflow-hidden rounded-md border">
      <div className="border-kortix-orange/20 flex items-center gap-2 border-b px-3 py-2">
        <ShieldAlert className="text-kortix-orange size-4" />
        <span className="text-foreground text-xs font-medium">
          {permissions.length === 1
            ? tI18nComplete.raw('text9ef61f308b40')
            : tI18nComplete('textc49ce59d0871', { value0: permissions.length })}
        </span>
        <span className="text-muted-foreground text-xs">
          {tI18nComplete.raw('text9532a08e3f63')}
        </span>
      </div>
      <ul className="divide-border divide-y">
        {permissions.map((p) => {
          const detail = permissionDetail(p);
          const expandable = !!detail && detail.length > EXPANDABLE_DETAIL_LENGTH;
          const expanded = expandedRows.has(p.id);
          return (
            <li key={p.id} className="flex items-start gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-foreground text-xs font-medium">{permissionLabel(p)}</span>
                </div>
                {detail ? (
                  // Only a detail that actually expands is a control. Rendering
                  // the flat case as a `<button>` too put a dead stop in the tab
                  // order of every permission row.
                  <DetailShell
                    expandable={expandable}
                    expanded={expanded}
                    onToggle={() => toggleExpanded(p.id)}
                  >
                    <code
                      title={expandable ? undefined : detail}
                      className={cn(
                        'text-muted-foreground font-mono text-xs',
                        expanded ? 'wrap-break-word whitespace-pre-wrap' : 'truncate',
                      )}
                    >
                      {detail}
                    </code>
                    {expandable ? (
                      <CaretDownIcon
                        className={cn(
                          'text-muted-foreground mt-0.5 size-3 shrink-0 transition-transform duration-150',
                          expanded && 'rotate-180',
                        )}
                      />
                    ) : null}
                  </DetailShell>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void reply(p.id, 'reject')}
                >
                  <PendingLabel pending={busy === `${p.id}:reject`}>
                    {tI18nComplete.raw('text05a2d7332eb9')}
                  </PendingLabel>
                </Button>
                <Button
                  size="xs"
                  variant="muted"
                  title={tI18nComplete.raw('text403595dd63ea')}
                  disabled={!!busy}
                  onClick={() => void reply(p.id, 'always')}
                >
                  <PendingLabel pending={busy === `${p.id}:always`}>
                    {tI18nComplete.raw('textec9f8a9109ec')}
                  </PendingLabel>
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={!!busy}
                  onClick={() => void reply(p.id, 'once')}
                >
                  <PendingLabel pending={busy === `${p.id}:once`}>
                    {tI18nComplete.raw('text168511d24d9e')}
                  </PendingLabel>
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-border flex items-center gap-2 border-t px-3 py-2">
        <span className="text-muted-foreground text-xs">
          {tI18nComplete.raw('text16324ed5894b')}
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          title={tI18nComplete.raw('text2c1a881dfca8')}
          disabled={!!busy}
          onClick={() => void allowAllForSession()}
        >
          <PendingLabel pending={busy === 'session-all'}>
            {tI18nComplete.raw('text1f05c7f5b64d')}
          </PendingLabel>
        </Button>
      </div>
      {canWriteConfig.allowed && agentBlock ? (
        // Deliberately set apart from the one-off buttons above: these WRITE the
        // project's permission config — every future session stops asking.
        <div className="bg-muted/40 border-border flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <span className="text-muted-foreground text-xs">
            {tI18nComplete.raw('text689997c79ba6')}{' '}
            <span className="opacity-70">{tI18nComplete.raw('textea73705db65f')}</span>:
          </span>
          {uniqueTypes.map((type) => (
            <Button
              key={type}
              size="xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              disabled={!!busy}
              onClick={() => void allowInConfig(type)}
            >
              <PendingLabel pending={busy === `config:${type}`}>
                {tI18nComplete.raw('text78facd7b499c')}
                {PERMISSION_LABELS[type] || type}"
              </PendingLabel>
            </Button>
          ))}
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            disabled={!!busy}
            onClick={() => void allowInConfig('*')}
          >
            <PendingLabel pending={busy === 'config:*'}>
              {tI18nComplete.raw('text84f8c40b31a7')}
            </PendingLabel>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
