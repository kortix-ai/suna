'use client';

/**
 * Inline "agent needs your permission" prompt, pinned above the composer — the
 * opencode tool-permission twin of `SessionApprovalPrompt` (connector
 * approvals). Answering resumes the agent's already-blocked turn in place
 * (opencode holds the tool call open until `/permission/{id}/reply`), so no
 * follow-up "continue" message is ever needed.
 *
 * Three decision scopes, visually separated by how long they last:
 *  - per request: Deny / Allow once / Allow for session (opencode's native
 *    `always` reply — this action pattern, rest of this session)
 *  - per session: "Allow everything" writes a blanket allow ruleset onto the
 *    opencode session (survives tab close) + auto-approves anything already
 *    pending; a client-side auto-approver backstops any ask that still arrives.
 *  - persistent (footer, gated on `project.customize.write`): writes the
 *    project's opencode permission config — future sessions stop asking.
 */

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { useRuntimeConfig, useUpdateRuntimeConfig } from '@kortix/sdk/react';
import {
  allowAllPermissionsForSession,
  resetSessionPermissions,
} from '@kortix/sdk/react';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { useRuntimePendingStore } from '@kortix/sdk/react';
import { PERMISSION_LABELS, type PermissionRequest } from '@/ui/types';
import {
  CaretDownIcon,
  ShieldCheckIcon as ShieldCheck,
  ShieldWarningIcon as ShieldAlert,
} from '@phosphor-icons/react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Full-text review is only worth an extra click for a detail that won't fit
 * on one line — short commands stay flat, no chevron. */
const EXPANDABLE_DETAIL_LENGTH = 64;

interface SessionPermissionPromptProps {
  /** The OPENCODE session id (what `PermissionRequest.sessionID` carries). */
  sessionId: string;
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

export function SessionPermissionPrompt({
  sessionId,
  permissions,
  onReply,
}: SessionPermissionPromptProps) {
  // Only the /projects/[id]/sessions/[sessionId] route has a project in scope —
  // on plain /sessions/[id], `id` IS the session, so no config surface.
  const params = useParams<{ id?: string; sessionId?: string }>();
  const projectId = params?.sessionId ? params.id : undefined;
  const canWriteConfig = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

  const autoApprove = useRuntimePendingStore((s) => !!s.autoApproveAllSessions[sessionId]);
  const setAutoApproveAll = useRuntimePendingStore((s) => s.setAutoApproveAll);

  const { data: config } = useRuntimeConfig();
  const updateConfig = useUpdateRuntimeConfig();

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
        errorToast(e instanceof Error ? e.message : 'Failed to answer the permission request');
      } finally {
        setBusy(null);
      }
    },
    [onReply],
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
      successToast("Allowed — won't ask again for anything this session");
    } catch (e) {
      errorToast(e instanceof Error ? e.message : 'Failed to allow permissions');
    } finally {
      setBusy(null);
    }
  }, [sessionId, permissions, onReply, setAutoApproveAll]);

  const turnOffAutoApprove = useCallback(async () => {
    setAutoApproveAll(sessionId, false);
    try {
      await resetSessionPermissions(sessionId);
    } catch {
      // The flag is already off; a stale session ruleset just means fewer asks.
    }
  }, [sessionId, setAutoApproveAll]);

  /** Persist an allow into the project's opencode permission config (the same
   * surface Settings → Permissions edits), then release the pending asks it
   * covers. `type === '*'` = always allow everything. */
  const allowInConfig = useCallback(
    async (type: string) => {
      setBusy(`config:${type}`);
      try {
        const current = config?.permission as string | Record<string, unknown> | undefined;
        // Preserve the existing shape: a global string mode becomes the `*`
        // fallback of the object form.
        const base: Record<string, unknown> =
          typeof current === 'string'
            ? { '*': current }
            : current && typeof current === 'object'
              ? { ...current }
              : {};
        const next =
          type === '*'
            ? // "Always allow everything": flatten every existing override too,
              // so no leftover per-tool `ask`/`deny` outranks the wildcard.
              Object.fromEntries([...Object.keys(base), '*'].map((k) => [k, 'allow']))
            : { ...base, [type]: 'allow' };
        await updateConfig.mutateAsync({ permission: next } as never);
        const covered = permissions.filter((p) => type === '*' || p.permission === type);
        await Promise.all(covered.map((p) => onReply(p.id, 'once')));
        successToast(
          type === '*'
            ? 'Saved — permissions are always allowed in this project now'
            : `Saved — "${PERMISSION_LABELS[type] || type}" is always allowed in this project now`,
        );
      } catch (e) {
        errorToast(e instanceof Error ? e.message : 'Failed to update the project config');
      } finally {
        setBusy(null);
      }
    },
    [config, updateConfig, permissions, onReply],
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

  const uniqueTypes = useMemo(
    () => [...new Set(permissions.map((p) => p.permission))],
    [permissions],
  );

  if (autoApprove) {
    return (
      <div className="border-border bg-popover mb-2 flex items-center gap-2 rounded-md border px-3 py-2">
        <ShieldCheck className="text-kortix-green size-4" />
        <span className="text-muted-foreground flex-1 text-xs">
          Auto-allowing all permission requests for this session
        </span>
        <Button size="xs" variant="ghost" onClick={() => void turnOffAutoApprove()}>
          Turn off
        </Button>
      </div>
    );
  }

  if (permissions.length === 0) return null;

  return (
    <div className="bg-popover border-kortix-orange/25 mb-2 overflow-hidden rounded-md border">
      <div className="border-kortix-orange/20 flex items-center gap-2 border-b px-3 py-2">
        <ShieldAlert className="text-kortix-orange size-4" />
        <span className="text-foreground text-xs font-medium">
          {permissions.length === 1
            ? 'The agent needs your permission'
            : `${permissions.length} actions need your permission`}
        </span>
        <span className="text-muted-foreground text-xs">— it's paused until you decide</span>
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
                  <button
                    type="button"
                    onClick={expandable ? () => toggleExpanded(p.id) : undefined}
                    className={cn(
                      'mt-0.5 flex w-full items-start gap-1 text-left',
                      expandable ? 'cursor-pointer' : 'cursor-default',
                    )}
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
                  </button>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!!busy}
                  onClick={() => void reply(p.id, 'reject')}
                >
                  {busy === `${p.id}:reject` ? <Loading className="size-3 animate-spin" /> : null}
                  Deny
                </Button>
                <Button
                  size="xs"
                  variant="muted"
                  title="Allow this action for the rest of this session — the agent won't ask again for it"
                  disabled={!!busy}
                  onClick={() => void reply(p.id, 'always')}
                >
                  {busy === `${p.id}:always` ? <Loading className="size-3 animate-spin" /> : null}
                  Allow for session
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  disabled={!!busy}
                  onClick={() => void reply(p.id, 'once')}
                >
                  {busy === `${p.id}:once` ? <Loading className="size-3 animate-spin" /> : null}
                  Allow once
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-border flex items-center gap-2 border-t px-3 py-2">
        <span className="text-muted-foreground text-xs">This session:</span>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          title="Allow every permission request for the rest of this session"
          disabled={!!busy}
          onClick={() => void allowAllForSession()}
        >
          {busy === 'session-all' ? <Loading className="size-3 animate-spin" /> : null}
          Allow everything
        </Button>
      </div>
      {canWriteConfig.allowed ? (
        // Deliberately set apart from the one-off buttons above: these WRITE the
        // project's permission config — every future session stops asking.
        <div className="bg-muted/40 border-border flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <span className="text-muted-foreground text-xs">
            Project config <span className="opacity-70">(applies to future sessions)</span>:
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
              {busy === `config:${type}` ? <Loading className="size-3 animate-spin" /> : null}
              Always allow "{PERMISSION_LABELS[type] || type}"
            </Button>
          ))}
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            disabled={!!busy}
            onClick={() => void allowInConfig('*')}
          >
            {busy === 'config:*' ? <Loading className="size-3 animate-spin" /> : null}
            Always allow everything
          </Button>
        </div>
      ) : null}
    </div>
  );
}
